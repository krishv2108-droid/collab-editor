import { describe, expect, it } from "vitest";
import {
  applyOperation,
  ClientSync,
  createRng,
  del,
  insert,
  normalize,
  randomInt,
  randomOperation,
  retain,
  type Operation,
  type Outgoing,
  type Rng,
} from "@collab/shared";
import { DocumentRegistry } from "./DocumentRegistry";
import { InMemoryStore } from "./InMemoryStore";
import { ServerDocument } from "./ServerDocument";

/**
 * simulation.test.ts checks that clients converge while messages arrive in random order.
 * This one adds the thing that test leaves out: connections that die.
 *
 * It runs the real DocumentRegistry (and a real store) against real ClientSync objects,
 * with a simulated network in between. At random moments:
 *   - a connection drops, losing every message still in transit, including acks for edits
 *     the server had already saved;
 *   - or it becomes a "zombie": the client gives up on it, but the server hasn't noticed,
 *     and messages the client sent on it can still arrive later;
 *   - a client reconnects, asking the server what it missed;
 *   - the whole server restarts, so documents are reloaded from the store.
 *
 * In "insert-only" runs every typed character is unique and nothing is ever deleted, so at
 * the end the document must contain every character exactly once: that catches an edit
 * that was lost AND an edit that was applied twice, which "everyone has the same text"
 * alone would not (a duplicate is applied everywhere alike).
 */

const DOC = "doc";

type Inbound = { type: "ack" } | { type: "edit"; op: Operation };

/** One connection. Also the identity the registry knows the client by. */
interface Conn {
  outbox: Outgoing[]; // client -> server, in order
  inbox: Inbound[]; // server -> client, in order
  /** The client gave up on it. Whatever the server sends it is going nowhere. */
  abandoned: boolean;
}

class SimClient {
  text = "";
  sync: ClientSync | null = null;
  conn: Conn | null = null;
  constructor(readonly clientId: string) {}
}

interface Counters {
  reconnects: number;
  /** Our own edit turned up in the catch-up: saved, but the ack was lost. */
  ownFound: number;
  /** Our in-flight edit had not been saved, so it was sent again. */
  resends: number;
  /** A zombie's edit reached the server before its client rejoined, and was saved. */
  zombieAccepted: number;
  /** A zombie's edit reached the server after its client rejoined, and was refused. */
  zombieRefused: number;
  restarts: number;
  replaced: number;
}

class ReconnectSimulation {
  registry!: DocumentRegistry<Conn>;
  readonly store = new InMemoryStore();
  readonly clients: SimClient[] = [];
  readonly zombies: Conn[] = [];
  readonly inserted = new Set<string>();
  readonly counters: Counters = {
    reconnects: 0,
    ownFound: 0,
    resends: 0,
    zombieAccepted: 0,
    zombieRefused: 0,
    restarts: 0,
    replaced: 0,
  };
  private nextChar = 0;

  constructor(
    private readonly rng: Rng,
    private readonly insertOnly: boolean,
    private readonly maxClients: number,
  ) {
    this.startServer();
  }

  private startServer(): void {
    this.registry = new DocumentRegistry<Conn>(this.store, {
      snapshotEvery: 5, // small, so catch-ups cross snapshots
      onClientReplaced: () => this.counters.replaced++,
    });
  }

  private pick<T>(items: T[]): T {
    return items[Math.floor(this.rng() * items.length)]!;
  }

  private newConn(): Conn {
    return { outbox: [], inbox: [], abandoned: false };
  }

  // ---- what clients do ----

  async joinNewClient(): Promise<void> {
    const client = new SimClient(`tab-${this.clients.length}`);
    this.clients.push(client);
    await this.connect(client);
  }

  /** Opens a connection and joins; a returning client also asks what it missed. */
  async connect(client: SimClient): Promise<void> {
    const conn = this.newConn();
    client.conn = conn;
    const joined = await this.registry.join(DOC, conn, {
      clientId: client.clientId,
      lastRevision: client.sync?.processedRevision,
    });
    if (!joined) throw new Error("join was cancelled");

    if (!client.sync) {
      client.sync = new ClientSync(joined.revision);
      client.text = joined.text;
      return;
    }
    // A returning client must always be caught up, never sent a snapshot that would discard its typing.
    if (!joined.missed) throw new Error(`${client.clientId} got a snapshot instead of a catch-up`);
    this.counters.reconnects++;
    this.counters.ownFound += joined.missed.filter((m) => m.own).length;

    const { toApply, resend } = client.sync.reconnect(joined.missed);
    for (const op of toApply) client.text = applyOperation(client.text, op);
    if (client.sync.processedRevision !== joined.revision) {
      throw new Error(`${client.clientId} caught up to the wrong revision`);
    }
    if (resend) {
      this.counters.resends++;
      conn.outbox.push(resend);
    }
  }

  private makeEdit(client: SimClient): void {
    const { rng } = this;
    const length = client.text.length;
    let op: Operation;

    if (this.insertOnly) {
      const at = randomInt(rng, 0, length);
      const char = String.fromCharCode(0x4e00 + this.nextChar++);
      this.inserted.add(char);
      op = normalize([retain(at), insert(char), retain(length - at)]);
    } else if (length > 40) {
      const start = randomInt(rng, 0, length - 1);
      const count = randomInt(rng, 1, Math.min(10, length - start));
      op = normalize([retain(start), del(count), retain(length - start - count)]);
    } else if (rng() < 0.5) {
      op = randomOperation(rng, client.text);
    } else {
      const at = randomInt(rng, 0, length);
      op = normalize([retain(at), insert("xyz"[randomInt(rng, 0, 2)]!), retain(length - at)]);
    }
    if (op.every((piece) => piece.type === "retain")) return;

    client.text = applyOperation(client.text, op);
    const outgoing = client.sync!.applyLocal(op);
    // Offline there is nowhere to send it; reconnecting sends whatever is still in flight.
    if (outgoing && client.conn) client.conn.outbox.push(outgoing);
  }

  // ---- the network ----

  /** The server processes the next message waiting on `conn`. */
  private async deliverToServer(conn: Conn): Promise<void> {
    const message = conn.outbox.shift()!;
    try {
      const { op, recipients } = await this.registry.applyEdit(conn, message.baseRevision, message.op);
      if (conn.abandoned) this.counters.zombieAccepted++;
      else conn.inbox.push({ type: "ack" });
      for (const other of recipients) {
        if (!other.abandoned) other.inbox.push({ type: "edit", op });
      }
    } catch (error) {
      // The only legitimate refusals are for connections the client has already left behind.
      if (!conn.abandoned) throw error;
      this.counters.zombieRefused++;
    }
  }

  private deliverToClient(client: SimClient): void {
    const conn = client.conn!;
    const message = conn.inbox.shift()!;
    const sync = client.sync!;
    if (message.type === "ack") {
      const next = sync.serverAck();
      if (next) conn.outbox.push(next);
    } else {
      client.text = applyOperation(client.text, sync.applyRemote(message.op));
    }
  }

  // ---- failures ----

  /** The connection dies. Everything in transit is lost; the server may or may not notice. */
  private drop(client: SimClient): void {
    const conn = client.conn!;
    client.conn = null;
    if (this.rng() < 0.6) {
      // Zombie: the client moves on but the server still has it registered, and messages
      // the client already sent can still arrive.
      conn.abandoned = true;
      conn.inbox.length = 0;
      this.zombies.push(conn);
    } else {
      this.registry.leave(conn);
    }
  }

  private restartServer(): void {
    this.counters.restarts++;
    for (const client of this.clients) {
      if (client.conn) client.conn.abandoned = true;
      client.conn = null;
    }
    this.zombies.length = 0; // their messages die with the old process
    this.startServer();
  }

  // ---- driving it ----

  async step(): Promise<void> {
    const roll = this.rng();
    const client = this.pick(this.clients);
    const connected = this.clients.filter((c) => c.conn);
    const disconnected = this.clients.filter((c) => !c.conn);

    if (roll < 0.3) {
      this.makeEdit(client);
    } else if (roll < 0.5) {
      const senders = [...connected.map((c) => c.conn!), ...this.zombies].filter((c) => c.outbox.length > 0);
      if (senders.length > 0) await this.deliverToServer(this.pick(senders));
    } else if (roll < 0.72) {
      const readers = connected.filter((c) => c.conn!.inbox.length > 0);
      if (readers.length > 0) this.deliverToClient(this.pick(readers));
    } else if (roll < 0.79) {
      if (connected.length > 0) this.drop(this.pick(connected));
    } else if (roll < 0.89) {
      if (disconnected.length > 0) await this.connect(this.pick(disconnected));
    } else if (roll < 0.92) {
      if (this.zombies.length > 0) this.registry.leave(this.pick(this.zombies)); // the server finally notices
    } else if (roll < 0.93) {
      this.restartServer();
    } else if (roll < 0.95 && this.clients.length < this.maxClients) {
      await this.joinNewClient();
    }
  }

  /** Stop typing and failing; reconnect everyone and let every message land, in random order. */
  async settle(): Promise<void> {
    for (const client of this.clients) if (!client.conn) await this.connect(client);

    for (let guard = 0; guard < 1_000_000; guard++) {
      const work: Array<() => Promise<void> | void> = [];
      for (const client of this.clients) {
        if (client.conn!.outbox.length > 0) work.push(() => this.deliverToServer(client.conn!));
        if (client.conn!.inbox.length > 0) work.push(() => this.deliverToClient(client));
      }
      for (const zombie of this.zombies) {
        if (zombie.outbox.length > 0) work.push(() => this.deliverToServer(zombie));
      }
      if (work.length === 0) return;
      await this.pick(work)();
    }
    throw new Error("Simulation did not settle");
  }

  async serverText(): Promise<string> {
    await this.registry.flushSnapshots();
    return ServerDocument.restore((await this.store.load(DOC))!).text;
  }
}

async function run(seed: number, options: { insertOnly: boolean; clients: number; steps: number }) {
  const simulation = new ReconnectSimulation(createRng(seed), options.insertOnly, options.clients + 2);
  for (let i = 0; i < options.clients; i++) await simulation.joinNewClient();
  for (let i = 0; i < options.steps; i++) await simulation.step();
  await simulation.settle();

  const serverText = await simulation.serverText();
  for (const client of simulation.clients) {
    const label = `seed=${seed} ${client.clientId}`;
    expect(client.text, label).toBe(serverText);
    expect(client.sync!.state, label).toBe("synchronized");
  }
  if (options.insertOnly) {
    const label = `seed=${seed}`;
    expect([...serverText].sort(), label).toEqual([...simulation.inserted].sort()); // each exactly once
  }
  return simulation;
}

function total(simulations: ReconnectSimulation[]): Counters {
  const sum: Counters = { reconnects: 0, ownFound: 0, resends: 0, zombieAccepted: 0, zombieRefused: 0, restarts: 0, replaced: 0 };
  for (const { counters } of simulations) {
    for (const key of Object.keys(sum) as Array<keyof Counters>) sum[key] += counters[key];
  }
  return sum;
}

describe("OT end-to-end simulation with dying connections", () => {
  it("never loses or duplicates an edit", async () => {
    const simulations: ReconnectSimulation[] = [];
    for (let seed = 1; seed <= 150; seed++) {
      simulations.push(await run(seed, { insertOnly: true, clients: 3, steps: 300 }));
    }

    // Make sure the test really hits the situations it claims to.
    const counts = total(simulations);
    expect(counts.reconnects).toBeGreaterThan(1500);
    expect(counts.ownFound).toBeGreaterThan(100); // saved, ack lost: must not be sent twice
    expect(counts.resends).toBeGreaterThan(100); // never saved: must be sent again
    expect(counts.zombieAccepted).toBeGreaterThan(20); // a half-dead connection still got an edit in
    expect(counts.zombieRefused).toBeGreaterThan(20); // ...and one that arrived too late was refused
    expect(counts.replaced).toBeGreaterThan(50);
    expect(counts.restarts).toBeGreaterThan(100);
  });

  it("converges with inserts, deletes and conflicts as well", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      await run(seed, { insertOnly: false, clients: 3, steps: 300 });
    }
  });

  it("converges with five clients", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      await run(seed, { insertOnly: true, clients: 5, steps: 400 });
    }
  });
});

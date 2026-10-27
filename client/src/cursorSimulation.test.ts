import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRng,
  parseClientMessage,
  transformSelection,
  type PeerCursor,
  type Rng,
  type Selection,
} from "@collab/shared";
import { Hub, type Connection } from "../../server/src/hub";
import { InMemoryStore } from "../../server/src/InMemoryStore";
import { ServerDocument } from "../../server/src/ServerDocument";
import { DocumentSession, type SocketLike } from "./DocumentSession";

/**
 * Other users' cursors, under the same abuse as the other simulations: delayed and
 * reordered messages, connections that die (some of which the server never notices), and
 * server restarts, while users keep typing and moving their cursors.
 *
 * It runs the real server logic (Hub, registry, store) and the real browser logic
 * (DocumentSession, ClientSync) with only the network made up. When everything has settled,
 * each user must see each other user's cursor on exactly the spot that user's own cursor is
 * on, and the text must be the same everywhere.
 */

const DOC = "doc";
/** Longer than any run, and small enough for a timer: setTimeout treats anything over about 24 days as 1 ms. */
const NEVER = 2_000_000_000;

type ToClient = { data: string } | { close: number };

class SimSocket implements SocketLike {
  readyState = 0; // 0 connecting, 1 open, 3 closed
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  toServer: string[] = [];
  toClient: ToClient[] = [];
  /** The client has given up on this connection. */
  abandoned = false;
  /** The server has forgotten this connection (or never will hear from it again). */
  serverGone = false;
  readonly connection: Connection;

  constructor(private readonly sim: CursorSimulation) {
    this.connection = {
      send: (message) => {
        if (!this.serverGone && !this.abandoned) this.toClient.push({ data: JSON.stringify(message) });
      },
      close: (code) => {
        if (this.serverGone) return;
        this.serverGone = true;
        this.sim.hub.leave(this.connection);
        if (!this.abandoned) this.toClient.push({ close: code });
      },
    };
  }

  send(data: string): void {
    if (this.readyState === 1 && !this.abandoned) this.toServer.push(data);
  }

  /** The client closes it on purpose (see DocumentSession). */
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.abandoned = true;
    this.onclose?.({ code: 1000 });
  }
}

interface SimClient {
  name: string;
  session: DocumentSession;
  sockets: SimSocket[];
  /** Where this user's cursor really is (what their textarea would say). Null until they first use it. */
  own: Selection | null;
  view: PeerCursor[];
}

class CursorSimulation {
  hub: Hub;
  readonly store = new InMemoryStore();
  readonly clients: SimClient[] = [];
  readonly allSockets: SimSocket[] = [];
  readonly problems: string[] = [];
  private nextChar = 0;
  readonly stats = { cursorsDelivered: 0, peerViewsWithCursors: 0, drops: 0, zombies: 0, restarts: 0 };

  constructor(
    private readonly rng: Rng,
    private readonly withDeletes: boolean,
    clientCount: number,
  ) {
    this.hub = new Hub(this.store, { snapshotEvery: 7 });
    for (let i = 0; i < clientCount; i++) this.addClient(`user-${i}`);
  }

  private addClient(name: string): void {
    const client: SimClient = { name, session: undefined as never, sockets: [], own: null, view: [] };
    client.session = new DocumentSession({
      url: "sim://server",
      docId: DOC,
      clientId: name,
      random: this.rng,
      heartbeatMs: NEVER, // connections only die when this simulation kills them
      timeoutMs: NEVER,
      createSocket: () => {
        const socket = new SimSocket(this);
        client.sockets.push(socket);
        this.allSockets.push(socket);
        return socket;
      },
      listener: {
        onStatus: () => {},
        onRemoteChange: (_text, operations) => {
          // What the textarea does: its cursor rides along with other people's edits...
          for (const op of operations) if (client.own) client.own = transformSelection(client.own, op);
          // ...and then reports its (unchanged) position, which the session must recognise as nothing new.
          if (client.own) client.session.setSelection(client.own);
        },
        onPeersChange: (peers) => {
          client.view = peers;
          if (peers.length > 0) this.stats.peerViewsWithCursors++;
          const length = client.session.text.length;
          for (const p of peers) {
            if (!(0 <= p.start && p.start <= p.end && p.end <= length)) {
              this.problems.push(`${name} was shown ${p.start}-${p.end} in a text of ${length}`);
            }
          }
        },
      },
    });
    this.clients.push(client);
    client.session.start();
  }

  private pick<T>(items: T[]): T {
    return items[Math.floor(this.rng() * items.length)]!;
  }
  private between(min: number, max: number): number {
    return min + Math.floor(this.rng() * (max - min + 1));
  }

  // ---- what users do ----

  private editable(client: SimClient): boolean {
    return client.session.status === "ready" || client.session.status === "reconnecting";
  }

  private type(client: SimClient): void {
    const text = client.session.text;
    // Real users mostly type at their cursor, often right beside it, not at random places.
    const roll = this.rng();
    const at =
      client.own && roll < 0.3
        ? Math.min(text.length, client.own.start) // at the cursor
        : client.own && roll < 0.6
          ? Math.max(0, client.own.start - 1) // just before it (the cursor ends up where it was)
          : this.between(0, text.length);
    if (this.withDeletes && text.length > 0 && this.rng() < 0.3) {
      const from = this.between(0, text.length - 1);
      const count = this.between(1, Math.min(3, text.length - from));
      client.session.edit(text.slice(0, from) + text.slice(from + count));
      client.own = { start: from, end: from };
    } else {
      const char = String.fromCharCode(0x4e00 + this.nextChar++);
      client.session.edit(text.slice(0, at) + char + text.slice(at));
      client.own = { start: at + 1, end: at + 1 };
    }
    client.session.setSelection(client.own);
  }

  private moveCursor(client: SimClient): void {
    const length = client.session.text.length;
    const a = this.between(0, length);
    const b = this.rng() < 0.5 ? a : this.between(0, length);
    client.own = { start: Math.min(a, b), end: Math.max(a, b) };
    client.session.setSelection(client.own);
  }

  // ---- the network ----

  private live(): SimSocket[] {
    return this.allSockets.filter((s) => s.readyState !== 3 || s.toClient.length > 0 || s.toServer.length > 0);
  }

  private async deliverToServer(socket: SimSocket): Promise<void> {
    const raw = socket.toServer.shift()!;
    const message = parseClientMessage(raw);
    if (!message) throw new Error(`the client sent something unparseable: ${raw}`);
    if (message.type === "cursor") this.stats.cursorsDelivered++;
    if (message.type === "ping") this.hub.ping(socket.connection);
    else await this.hub.handle(socket.connection, message);
  }

  private deliverToClient(socket: SimSocket): void {
    const next = socket.toClient.shift()!;
    if ("data" in next) {
      socket.onmessage?.({ data: next.data });
    } else if (socket.readyState !== 3) {
      socket.readyState = 3;
      socket.onclose?.({ code: next.close });
    }
  }

  /** The connection dies for the client. The server either notices at once or doesn't. */
  private drop(socket: SimSocket): void {
    this.stats.drops++;
    socket.abandoned = true;
    socket.toClient.length = 0;
    socket.readyState = 3;
    if (this.rng() < 0.6) {
      socket.serverGone = true;
      this.hub.leave(socket.connection);
    } else {
      this.stats.zombies++; // the server still thinks it is there, and what the client sent can still arrive
    }
    socket.onclose?.({ code: 1006 });
  }

  private restartServer(): void {
    this.stats.restarts++;
    for (const socket of this.allSockets) {
      if (socket.serverGone) continue;
      socket.serverGone = true;
      socket.toServer.length = 0;
      if (!socket.abandoned && socket.readyState !== 3) this.drop(socket);
    }
    this.hub = new Hub(this.store, { snapshotEvery: 7 });
  }

  // ---- driving it ----

  async step(): Promise<void> {
    const roll = this.rng();
    const client = this.pick(this.clients);
    const sockets = this.live();

    if (roll < 0.2) {
      if (this.editable(client)) this.type(client);
    } else if (roll < 0.34) {
      if (this.editable(client)) this.moveCursor(client);
    } else if (roll < 0.56) {
      const senders = sockets.filter((s) => s.toServer.length > 0 && !s.serverGone);
      if (senders.length > 0) await this.deliverToServer(this.pick(senders));
    } else if (roll < 0.78) {
      const receivers = sockets.filter((s) => s.toClient.length > 0 && !s.abandoned);
      if (receivers.length > 0) this.deliverToClient(this.pick(receivers));
    } else if (roll < 0.86) {
      const connecting = sockets.filter((s) => s.readyState === 0 && !s.abandoned);
      if (connecting.length > 0) {
        const socket = this.pick(connecting);
        socket.readyState = 1;
        socket.onopen?.();
      }
    } else if (roll < 0.88) {
      const open = sockets.filter((s) => (s.readyState === 1 || s.readyState === 0) && !s.abandoned);
      if (open.length > 0) this.drop(this.pick(open));
    } else if (roll < 0.94) {
      vi.advanceTimersByTime(this.between(10, 700)); // time passes: retries and cursor timers fire
    } else if (roll < 0.96) {
      const zombies = sockets.filter((s) => s.abandoned && !s.serverGone);
      if (zombies.length > 0) {
        const zombie = this.pick(zombies);
        zombie.serverGone = true;
        this.hub.leave(zombie.connection); // the server finally notices
      }
    } else if (roll < 0.962) {
      this.restartServer();
    }
  }

  /** Stop typing and failing; let everything reconnect, land and be reported. */
  async settle(): Promise<void> {
    let quiet = 0;
    for (let guard = 0; guard < 100_000 && quiet < 25; guard++) {
      const sockets = this.live();
      const work: Array<() => Promise<void> | void> = [];
      for (const s of sockets) {
        if (s.readyState === 0 && !s.abandoned) {
          work.push(() => {
            s.readyState = 1;
            s.onopen?.();
          });
        }
        if (s.toServer.length > 0 && !s.serverGone) work.push(() => this.deliverToServer(s));
        if (s.toClient.length > 0 && !s.abandoned) work.push(() => this.deliverToClient(s));
      }
      if (work.length > 0) {
        quiet = 0;
        await this.pick(work)();
      } else {
        quiet++;
        vi.advanceTimersByTime(1000); // 25 quiet seconds in a row outlast the longest retry wait (15 s)
      }
    }
  }

  async serverText(): Promise<string> {
    await this.hub.flushSnapshots();
    const stored = await this.store.load(DOC);
    return stored ? ServerDocument.restore(stored).text : ""; // nothing is saved until the first edit
  }
}

async function run(seed: number, options: { withDeletes: boolean; clients: number; steps: number }) {
  const sim = new CursorSimulation(createRng(seed), options.withDeletes, options.clients);
  for (let i = 0; i < options.steps; i++) await sim.step();
  await sim.settle();
  const serverText = await sim.serverText();
  for (const client of sim.clients) {
    const label = `seed=${seed} ${client.name}`;
    expect(client.session.status, label).toBe("ready");
    expect(client.session.text, label).toBe(serverText);
  }
  expect(sim.problems, `seed=${seed}`).toEqual([]);

  // The point of it all: what each user sees of everybody else is what everybody else really has.
  for (const viewer of sim.clients) {
    const label = `seed=${seed} ${viewer.name}`;
    const expected = sim.clients
      .filter((other) => other !== viewer && other.own)
      .map((other) => `${other.own!.start}-${other.own!.end}`)
      .sort();
    const seen = viewer.view.map((p) => `${p.start}-${p.end}`).sort();
    expect(seen, `${label} (texts: ${JSON.stringify(serverText)})`).toEqual(expected);
  }
  return sim;
}

describe("other users' cursors under dying connections", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("everyone ends up seeing everyone's cursor where it really is (insert-only)", async () => {
    let cursors = 0;
    let views = 0;
    let drops = 0;
    let zombies = 0;
    let restarts = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const sim = await run(seed, { withDeletes: false, clients: 3, steps: 800 });
      cursors += sim.stats.cursorsDelivered;
      views += sim.stats.peerViewsWithCursors;
      drops += sim.stats.drops;
      zombies += sim.stats.zombies;
      restarts += sim.stats.restarts;
    }
    // Make sure the test really exercised what it claims to.
    expect(cursors).toBeGreaterThan(1000);
    expect(views).toBeGreaterThan(5000);
    expect(drops).toBeGreaterThan(500);
    expect(zombies).toBeGreaterThan(100);
    expect(restarts).toBeGreaterThan(50);
  });

  it("...also with deletes, where cursors collapse and positions tie", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      await run(seed, { withDeletes: true, clients: 3, steps: 300 });
    }
  });

  it("...with five users", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      await run(seed, { withDeletes: true, clients: 5, steps: 400 });
    }
  });
});

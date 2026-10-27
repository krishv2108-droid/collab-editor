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
import { ServerDocument } from "./ServerDocument";

/**
 * A randomized end-to-end test of the whole OT system, with no real network.
 *
 * Several clients type at random. Messages between each client and the server travel
 * through queues that are delivered in a random order, so edits routinely cross paths
 * and clients type while their earlier edits are still in flight. (Each client's own
 * queue stays in order, like a real WebSocket connection.) When we stop typing and let
 * every message land, the server and all clients must hold exactly the same text.
 * Seeds make every run reproducible: a failure message names the seed to replay.
 */

type Inbound = { type: "ack" } | { type: "edit"; op: Operation };

class SimClient {
  text: string;
  readonly sync: ClientSync;
  readonly outbox: Outgoing[] = []; // client -> server, in order
  readonly inbox: Inbound[] = []; // server -> client, in order

  constructor(snapshot: { text: string; revision: number }) {
    this.text = snapshot.text;
    this.sync = new ClientSync(snapshot.revision);
  }
}

class Simulation {
  readonly server = new ServerDocument();
  readonly clients: SimClient[] = [];
  /** How many remote edits arrived while the client had edits of its own pending. */
  conflicts = 0;
  /** ...and how many of those arrived while it also had a buffer of typed-ahead edits. */
  bufferedConflicts = 0;

  constructor(
    private readonly rng: Rng,
    private readonly maxClients: number,
  ) {}

  private pick<T>(items: T[]): T {
    return items[Math.floor(this.rng() * items.length)]!;
  }

  join(): void {
    this.clients.push(new SimClient({ text: this.server.text, revision: this.server.revision }));
  }

  /** The user of `client` types something: sometimes a keystroke, sometimes a bigger edit. */
  private edit(client: SimClient): void {
    const { rng } = this;
    const length = client.text.length;
    let op: Operation;

    if (length > 40) {
      const start = randomInt(rng, 0, length - 1);
      const count = randomInt(rng, 1, Math.min(10, length - start));
      op = normalize([retain(start), del(count), retain(length - start - count)]);
    } else if (rng() < 0.5) {
      op = randomOperation(rng, client.text);
    } else if (length === 0 || rng() < 0.6) {
      const at = randomInt(rng, 0, length);
      op = normalize([retain(at), insert("xyz"[randomInt(rng, 0, 2)]!), retain(length - at)]);
    } else {
      const at = randomInt(rng, 0, length - 1);
      op = normalize([retain(at), del(1), retain(length - at - 1)]);
    }

    if (op.every((piece) => piece.type === "retain")) return; // changed nothing

    client.text = applyOperation(client.text, op);
    const outgoing = client.sync.applyLocal(op);
    if (outgoing) client.outbox.push(outgoing);
  }

  /** The server processes the next message from `client` and fans the result out. */
  private deliverToServer(client: SimClient): void {
    const message = client.outbox.shift()!;
    const accepted = this.server.receive(message.baseRevision, message.op);
    client.inbox.push({ type: "ack" });
    for (const other of this.clients) {
      if (other !== client) other.inbox.push({ type: "edit", op: accepted });
    }
  }

  /** `client` processes the next message from the server. */
  private deliverToClient(client: SimClient): void {
    const message = client.inbox.shift()!;
    if (message.type === "ack") {
      const next = client.sync.serverAck();
      if (next) client.outbox.push(next);
      return;
    }
    if (client.sync.state !== "synchronized") this.conflicts++;
    if (client.sync.state === "awaitingWithBuffer") this.bufferedConflicts++;
    client.text = applyOperation(client.text, client.sync.applyRemote(message.op));
  }

  /** One random event: someone types, or a message is delivered, or someone joins. */
  step(): void {
    const roll = this.rng();
    const client = this.pick(this.clients);
    if (roll < 0.4) {
      this.edit(client);
    } else if (roll < 0.7) {
      if (client.outbox.length > 0) this.deliverToServer(client);
    } else if (roll < 0.97) {
      if (client.inbox.length > 0) this.deliverToClient(client);
    } else if (this.clients.length < this.maxClients) {
      this.join();
    }
  }

  /** Stop typing and let every message land, in random order. */
  drain(): void {
    for (let guard = 0; guard < 1_000_000; guard++) {
      const work: Array<() => void> = [];
      for (const client of this.clients) {
        if (client.outbox.length > 0) work.push(() => this.deliverToServer(client));
        if (client.inbox.length > 0) work.push(() => this.deliverToClient(client));
      }
      if (work.length === 0) return;
      this.pick(work)();
    }
    throw new Error("Simulation did not settle");
  }
}

function runSimulation(seed: number, startClients: number, maxClients: number, steps: number) {
  const simulation = new Simulation(createRng(seed), maxClients);
  for (let i = 0; i < startClients; i++) simulation.join();
  for (let i = 0; i < steps; i++) simulation.step();
  simulation.drain();

  for (const [index, client] of simulation.clients.entries()) {
    const label = `seed=${seed} client=${index}`;
    expect(client.text, label).toBe(simulation.server.text);
    expect(client.sync.state, label).toBe("synchronized");
  }
  return simulation;
}

describe("OT end-to-end simulation", () => {
  it("two clients converge under heavy conflict", () => {
    let conflicts = 0;
    let bufferedConflicts = 0;
    let revisions = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const simulation = runSimulation(seed, 2, 2, 300);
      conflicts += simulation.conflicts;
      bufferedConflicts += simulation.bufferedConflicts;
      revisions += simulation.server.revision;
    }
    // Make sure the test is really exercising what it claims to.
    expect(revisions).toBeGreaterThan(5000);
    expect(conflicts).toBeGreaterThan(1000);
    expect(bufferedConflicts).toBeGreaterThan(100);
  });

  it("five clients converge", () => {
    for (let seed = 1; seed <= 60; seed++) runSimulation(seed, 5, 5, 400);
  });

  it("clients that join mid-session converge too", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const simulation = runSimulation(seed, 1, 5, 500);
      expect(simulation.clients.length).toBeGreaterThan(1);
    }
  });
});

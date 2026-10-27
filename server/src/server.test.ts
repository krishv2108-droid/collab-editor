import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  applyOperation,
  ClientSync,
  diffToOperation,
  insert,
  parseServerMessage,
  retain,
  type ClientMessage,
  type ServerMessage,
} from "@collab/shared";
import { createCollabServer, type CollabServer } from "./server";

/** A test WebSocket that queues incoming messages so we can await them in order. */
class TestClient {
  private socket: WebSocket;
  private queue: ServerMessage[] = [];
  private waiting: Array<(message: ServerMessage) => void> = [];
  readonly closed: Promise<number>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    socket.on("message", (data) => {
      const message = parseServerMessage(data.toString());
      if (!message) return;
      const waiter = this.waiting.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${port}`);
      const client = new TestClient(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
    });
  }

  send(message: ClientMessage | string): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  next(): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  close(): void {
    this.socket.terminate();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("collab server", () => {
  let server: CollabServer;
  const clients: TestClient[] = [];

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(server.port);
    clients.push(client);
    return client;
  }

  async function join(docId: string): Promise<TestClient> {
    const client = await connect();
    client.send({ type: "join", docId });
    await client.next(); // the snapshot
    return client;
  }

  beforeEach(async () => {
    server = await createCollabServer(0);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
  });

  it("sends an empty snapshot at revision 0 when joining a new document", async () => {
    const alice = await connect();
    alice.send({ type: "join", docId: "doc1" });
    expect(await alice.next()).toEqual({ type: "snapshot", text: "", revision: 0 });
  });

  it("acks the sender and forwards the edit to the other client", async () => {
    const alice = await join("doc1");
    const bob = await join("doc1");

    const op = [insert("hello")];
    alice.send({ type: "edit", baseRevision: 0, op });

    expect(await alice.next()).toEqual({ type: "ack" });
    expect(await bob.next()).toEqual({ type: "edit", op });
    await sleep(50);
    expect(alice.pendingCount).toBe(0); // no echo of her own edit
  });

  it("gives a late joiner the current text and revision", async () => {
    const alice = await join("doc1");
    alice.send({ type: "edit", baseRevision: 0, op: [insert("hello")] });
    await alice.next(); // ack

    const bob = await connect();
    bob.send({ type: "join", docId: "doc1" });
    expect(await bob.next()).toEqual({ type: "snapshot", text: "hello", revision: 1 });
  });

  it("keeps different documents separate", async () => {
    const alice = await join("doc1");
    const carol = await join("doc2");

    alice.send({ type: "edit", baseRevision: 0, op: [insert("hi")] });
    await sleep(50);
    expect(carol.pendingCount).toBe(0);
  });

  it("ignores unparseable messages", async () => {
    const alice = await join("doc1");
    const bob = await join("doc1");

    alice.send("this is not json");
    alice.send({ type: "edit", baseRevision: 0, op: [insert("ok")] });

    expect(await alice.next()).toEqual({ type: "ack" });
    expect(await bob.next()).toEqual({ type: "edit", op: [insert("ok")] });
  });

  it("disconnects a client whose edit doesn't fit, and leaves everyone else working", async () => {
    const alice = await join("doc1");
    const bob = await join("doc1");

    alice.send({ type: "edit", baseRevision: 0, op: [retain(99)] }); // document is empty
    expect(await alice.closed).toBe(1008);

    bob.send({ type: "edit", baseRevision: 0, op: [insert("still works")] });
    expect(await bob.next()).toEqual({ type: "ack" });
  });

  it("stops sending edits to a client that disconnected", async () => {
    const alice = await join("doc1");
    const bob = await join("doc1");
    bob.close();
    await sleep(50);

    alice.send({ type: "edit", baseRevision: 0, op: [insert("x")] });
    await alice.next(); // ack
    await sleep(50);
    expect(bob.pendingCount).toBe(0);
  });

  it("keeps two real clients converged through a conflict (the Phase 1 failure, over sockets)", async () => {
    /** A browser stand-in: local text + ClientSync, driven by what the server sends. */
    async function joinWithSync(docId: string) {
      const socket = await connect();
      socket.send({ type: "join", docId });
      const snapshot = await socket.next();
      if (snapshot.type !== "snapshot") throw new Error("expected a snapshot");
      const user = { text: snapshot.text, sync: new ClientSync(snapshot.revision), socket };
      return user;
    }
    type User = Awaited<ReturnType<typeof joinWithSync>>;

    const type = (user: User, newText: string) => {
      const op = diffToOperation(user.text, newText)!;
      user.text = newText;
      const outgoing = user.sync.applyLocal(op);
      if (outgoing) user.socket.send({ type: "edit", ...outgoing });
    };
    const handleNext = async (user: User) => {
      const message = await user.socket.next();
      if (message.type === "ack") {
        const outgoing = user.sync.serverAck();
        if (outgoing) user.socket.send({ type: "edit", ...outgoing });
      } else if (message.type === "edit") {
        user.text = applyOperation(user.text, user.sync.applyRemote(message.op));
      }
    };

    const seed = await join("doc1");
    seed.send({ type: "edit", baseRevision: 0, op: [insert("abc")] });
    await seed.next();

    const alice = await joinWithSync("doc1");
    const bob = await joinWithSync("doc1");

    // Both type before either hears about the other's edit.
    type(alice, "XXabc");
    type(bob, "abcY");

    // Each should receive exactly two messages: its own ack and the other's edit.
    await Promise.all([
      handleNext(alice).then(() => handleNext(alice)),
      handleNext(bob).then(() => handleNext(bob)),
    ]);

    expect(alice.text).toBe("XXabcY");
    expect(bob.text).toBe("XXabcY");
  });
});

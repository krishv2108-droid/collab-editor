import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyOperation,
  ClientSync,
  diffToOperation,
  insert,
  retain,
} from "@collab/shared";
import { FlakyStore } from "./FlakyStore";
import { InMemoryStore } from "./InMemoryStore";
import { createCollabServer, type CollabServer } from "./server";
import { TestClient } from "./TestClient";

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

  const extraServers: CollabServer[] = [];

  /** An additional server, for tests that need their own store or a restart. */
  async function startServer(store: InMemoryStore | FlakyStore): Promise<CollabServer> {
    const extra = await createCollabServer(0, store);
    extraServers.push(extra);
    return extra;
  }

  beforeEach(async () => {
    server = await createCollabServer(0, new InMemoryStore());
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await server.close();
    for (const extra of extraServers.splice(0)) await extra.close();
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

  it("keeps a document across a server restart", async () => {
    const store = new InMemoryStore();
    const first = await startServer(store);

    const writer = await TestClient.connect(first.port);
    clients.push(writer);
    writer.send({ type: "join", docId: "doc1" });
    await writer.next(); // snapshot
    writer.send({ type: "edit", baseRevision: 0, op: [insert("hello")] });
    expect(await writer.next()).toEqual({ type: "ack" }); // an ack means it has been saved
    await first.close();

    // A brand new server with an empty memory, sharing only the store.
    const second = await startServer(store);
    const reader = await TestClient.connect(second.port);
    clients.push(reader);
    reader.send({ type: "join", docId: "doc1" });
    expect(await reader.next()).toEqual({ type: "snapshot", text: "hello", revision: 1 });

    // ...and editing carries on from where it left off.
    reader.send({ type: "edit", baseRevision: 1, op: [retain(5), insert("!")] });
    expect(await reader.next()).toEqual({ type: "ack" });
  });

  it("disconnects everyone in a document when saving an edit fails, and never acks it", async () => {
    const store = new FlakyStore();
    const flaky = await startServer(store);
    const alice = await TestClient.connect(flaky.port);
    const bob = await TestClient.connect(flaky.port);
    clients.push(alice, bob);
    for (const client of [alice, bob]) {
      client.send({ type: "join", docId: "doc1" });
      await client.next();
    }

    store.failNextAppend = true;
    alice.send({ type: "edit", baseRevision: 0, op: [insert("lost")] });

    expect(await alice.closed).toBe(1011);
    expect(await bob.closed).toBe(1011);
    expect(alice.pendingCount).toBe(0); // no ack arrived before the disconnect
    expect(await store.inner.load("doc1")).toBeNull(); // and nothing was stored
  });

  it("disconnects a client whose document can't be loaded", async () => {
    const store = new FlakyStore();
    const flaky = await startServer(store);
    const alice = await TestClient.connect(flaky.port);
    clients.push(alice);

    store.failNextLoad = true;
    alice.send({ type: "join", docId: "doc1" });
    expect(await alice.closed).toBe(1011);
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

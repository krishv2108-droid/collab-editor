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
  describe("reconnecting", () => {
    const hello = [insert("hello")];

    it("catches a returning tab up, and says its own saved edit was its own", async () => {
      const alice = await connect();
      alice.send({ type: "join", docId: "doc1", clientId: "alice" });
      await alice.next(); // snapshot
      const bob = await join("doc1");

      alice.send({ type: "edit", baseRevision: 0, op: hello });
      await bob.next(); // bob got it, so it is saved
      alice.close(); // her ack is lost with the connection
      bob.send({ type: "edit", baseRevision: 1, op: [retain(5), insert("!")] });
      await bob.next(); // ack

      const again = await connect();
      again.send({ type: "join", docId: "doc1", clientId: "alice", lastRevision: 0 });
      expect(await again.next()).toEqual({
        type: "catchup",
        operations: [
          { op: hello, own: true },
          { op: [retain(5), insert("!")], own: false },
        ],
        revision: 2,
      });

      // And she is in the room again: bob's next edit reaches her.
      bob.send({ type: "edit", baseRevision: 2, op: [retain(6), insert("?")] });
      expect(await again.next()).toEqual({ type: "edit", op: [retain(6), insert("?")] });
    });

    it("sends a snapshot to a tab that didn't say what it has seen", async () => {
      const bob = await join("doc1");
      bob.send({ type: "edit", baseRevision: 0, op: hello });
      await bob.next();

      const carol = await connect();
      carol.send({ type: "join", docId: "doc1", clientId: "carol" });
      expect(await carol.next()).toEqual({ type: "snapshot", text: "hello", revision: 1 });
    });

    it("closes the older connection of a tab that connects again, with a code that means 'don't retry'", async () => {
      const first = await connect();
      first.send({ type: "join", docId: "doc1", clientId: "tab" });
      await first.next();

      const second = await connect();
      second.send({ type: "join", docId: "doc1", clientId: "tab", lastRevision: 0 });
      await second.next();
      expect(await first.closed).toBe(4001);
    });

    it("converges end to end: a tab that lost the connection mid-edit, in both ways it can go wrong", async () => {
      for (const reachedServer of [true, false]) {
        const docId = `doc-${reachedServer}`;
        const bob = await join(docId);
        const aliceSocket = await connect();
        aliceSocket.send({ type: "join", docId, clientId: "alice" });
        const first = await aliceSocket.next();
        if (first.type !== "snapshot") throw new Error("expected a snapshot");
        const alice = { text: first.text, sync: new ClientSync(first.revision) };

        // Alice types "Y"; depending on the loop, the edit does or doesn't reach the server.
        const op = diffToOperation(alice.text, "Y")!;
        alice.text = "Y";
        const outgoing = alice.sync.applyLocal(op)!;
        if (reachedServer) {
          aliceSocket.send({ type: "edit", ...outgoing });
          await bob.next(); // saved and forwarded
        }
        aliceSocket.close();
        // Meanwhile bob types too.
        const bobOp = reachedServer ? [insert("B"), retain(1)] : [insert("B")];
        bob.send({ type: "edit", baseRevision: reachedServer ? 1 : 0, op: bobOp });
        await bob.next(); // ack

        const back = await connect();
        back.send({ type: "join", docId, clientId: "alice", lastRevision: first.revision });
        const catchup = await back.next();
        if (catchup.type !== "catchup") throw new Error("expected a catchup");
        const result = alice.sync.reconnect(catchup.operations);
        for (const remote of result.toApply) alice.text = applyOperation(alice.text, remote);
        if (result.resend) {
          back.send({ type: "edit", ...result.resend });
          expect(await back.next()).toEqual({ type: "ack" });
        }
        // Bob hears about the resend (if any) and everyone ends with one copy of every edit.
        if (result.resend) await bob.next();
        // If Alice's edit was saved first, Bob's "B" lands before it. If not, both insert at
        // the very start, and the later-arriving edit (hers) goes on the left.
        expect(alice.text).toBe(reachedServer ? "BY" : "YB");
        expect(result.resend !== null).toBe(!reachedServer);

        const check = await connect();
        check.send({ type: "join", docId });
        expect(await check.next()).toMatchObject({ type: "snapshot", text: alice.text });
      }
    });
  });
});

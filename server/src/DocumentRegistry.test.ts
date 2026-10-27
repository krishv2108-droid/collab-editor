import { beforeEach, describe, expect, it } from "vitest";
import { insert, retain } from "@collab/shared";
import { DocumentRegistry, RoomFailedError } from "./DocumentRegistry";
import { FlakyStore } from "./FlakyStore";

describe("DocumentRegistry", () => {
  let store: FlakyStore;
  let failures: Array<{ clients: string[]; error: RoomFailedError }>;
  let registry: DocumentRegistry<string>;

  const newRegistry = () =>
    new DocumentRegistry<string>(store, {
      onRoomFailed: (clients, error) => failures.push({ clients, error }),
    });

  beforeEach(() => {
    store = new FlakyStore();
    failures = [];
    registry = newRegistry();
  });

  describe("joining", () => {
    it("starts a new document empty at revision 0", async () => {
      expect(await registry.join("doc1", "alice")).toEqual({ text: "", revision: 0 });
      expect(registry.documentCount).toBe(1);
      expect(registry.clientCount("doc1")).toBe(1);
    });

    it("loads an existing document from the store", async () => {
      await store.inner.append("doc1", 1, [insert("abc")]);
      await store.inner.append("doc1", 2, [insert("X"), retain(3)]);
      expect(await registry.join("doc1", "alice")).toEqual({ text: "Xabc", revision: 2 });
    });

    it("loads from a snapshot plus the edits after it", async () => {
      await store.inner.append("doc1", 1, [insert("abc")]);
      await store.inner.append("doc1", 2, [insert("X"), retain(3)]);
      await store.inner.append("doc1", 3, [retain(4), insert("Y")]);
      await store.inner.saveSnapshot("doc1", 2, "Xabc");
      expect(await registry.join("doc1", "alice")).toEqual({ text: "XabcY", revision: 3 });
    });

    it("tracks clients per document separately", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      await registry.join("doc2", "carol");
      expect(registry.clientCount("doc1")).toBe(2);
      expect(registry.clientCount("doc2")).toBe(1);
      expect(registry.documentCount).toBe(2);
    });

    it("loads a document once even when several clients join at the same moment", async () => {
      store.delayMs = 10;
      await Promise.all([
        registry.join("doc1", "alice"),
        registry.join("doc1", "bob"),
        registry.join("doc1", "carol"),
      ]);
      expect(store.loadCalls).toBe(1);
      expect(registry.clientCount("doc1")).toBe(3);
    });

    it("moves a client when it joins a second document", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc2", "alice");
      expect(registry.clientCount("doc1")).toBe(0);
      expect(registry.clientCount("doc2")).toBe(1);
    });

    it("reports a load failure, then tries again on the next join", async () => {
      store.failNextLoad = true;
      await expect(registry.join("doc1", "alice")).rejects.toThrow(/simulated load failure/);
      expect(registry.documentCount).toBe(0);
      expect(await registry.join("doc1", "alice")).toEqual({ text: "", revision: 0 });
    });

    it("resolves with null if the client leaves before loading finishes", async () => {
      store.delayMs = 10;
      const joining = registry.join("doc1", "alice");
      registry.leave("alice");
      expect(await joining).toBeNull();
      expect(registry.clientCount("doc1")).toBe(0);
    });
  });

  describe("leaving", () => {
    it("keeps the document in memory while anyone is still connected", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      registry.leave("alice");
      expect(registry.documentCount).toBe(1);
      expect(registry.clientCount("doc1")).toBe(1);
    });

    it("drops the document from memory once the last client leaves, and reloads it later", async () => {
      await registry.join("doc1", "alice");
      await registry.applyEdit("alice", 0, [insert("hello")]);
      registry.leave("alice");
      await registry.join("doc1", "bob"); // waits its turn behind the eviction

      expect(store.loadCalls).toBe(2); // loaded again from the store
      expect(await registry.join("doc1", "carol")).toEqual({ text: "hello", revision: 1 });
    });

    it("ignores leave for a client that never joined", () => {
      expect(() => registry.leave("ghost")).not.toThrow();
    });
  });

  describe("editing", () => {
    it("applies an edit, saves it, and returns the other clients but not the sender", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      await registry.join("doc2", "carol");

      const result = await registry.applyEdit("alice", 0, [insert("hi")]);
      expect(result.recipients).toEqual(["bob"]);
      expect(result.op).toEqual([insert("hi")]);
      expect(await store.inner.load("doc1")).toMatchObject({ operations: [[insert("hi")]] });
      expect(await store.inner.load("doc2")).toBeNull();
    });

    it("rewrites an edit made against an older revision", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      await registry.applyEdit("alice", 0, [insert("abc")]);
      await registry.applyEdit("alice", 1, [insert("XX"), retain(3)]);

      // Bob made this when the document was "abc" (revision 1).
      const result = await registry.applyEdit("bob", 1, [retain(3), insert("Y")]);
      expect(result.op).toEqual([retain(5), insert("Y")]);
      expect((await store.inner.load("doc1"))!.operations).toHaveLength(3);
    });

    it("does not send an edit to a client that has left", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      registry.leave("bob");
      const result = await registry.applyEdit("alice", 0, [insert("x")]);
      expect(result.recipients).toEqual([]);
    });

    it("rejects an edit from a client that has not joined", async () => {
      await expect(registry.applyEdit("ghost", 0, [insert("x")])).rejects.toThrow(/not joined/);
    });

    it("rejects a bad edit without saving it, and keeps working afterwards", async () => {
      await registry.join("doc1", "alice");
      await registry.applyEdit("alice", 0, [insert("hi")]);
      await expect(registry.applyEdit("alice", 1, [retain(9)])).rejects.toThrow(RangeError);
      await expect(registry.applyEdit("alice", 7, [retain(2)])).rejects.toThrow(RangeError);

      expect(store.appendCalls).toBe(1);
      const result = await registry.applyEdit("alice", 1, [retain(2), insert("!")]);
      expect(result.op).toEqual([retain(2), insert("!")]);
    });

    it("saves simultaneous edits one at a time, in the order they were accepted", async () => {
      store.delayMs = 10; // without queueing, the second save could overtake the first
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");

      const [fromAlice, fromBob] = await Promise.all([
        registry.applyEdit("alice", 0, [insert("A")]),
        registry.applyEdit("bob", 0, [insert("B")]),
      ]);

      expect(fromAlice.op).toEqual([insert("A")]);
      expect(fromBob.op).toEqual([insert("B"), retain(1)]); // Bob's insert lands to the left
      expect((await store.inner.load("doc1"))!.operations).toEqual([
        [insert("A")],
        [insert("B"), retain(1)],
      ]);
    });
  });

  describe("persistence", () => {
    it("a brand new registry on the same store sees everything the old one saved", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      await registry.applyEdit("alice", 0, [insert("A")]);
      await registry.applyEdit("bob", 0, [insert("B")]);

      const afterRestart = newRegistry();
      expect(await afterRestart.join("doc1", "carol")).toEqual({ text: "BA", revision: 2 });
    });
  });

  describe("when saving fails", () => {
    it("rejects the edit, drops the document and reports every client in it", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      store.failNextAppend = true;

      const error = await registry.applyEdit("alice", 0, [insert("lost")]).catch((e) => e);
      expect(error).toBeInstanceOf(RoomFailedError);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.clients.sort()).toEqual(["alice", "bob"]);
      expect(registry.documentCount).toBe(0);
      expect(registry.clientCount("doc1")).toBe(0);
    });

    it("never made the unsaved edit part of the document", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob"); // someone else keeps the room busy, so it can't be reset by alice leaving
      store.failNextAppend = true;
      await registry.applyEdit("alice", 0, [insert("lost")]).catch(() => {});

      expect(await registry.join("doc1", "alice")).toEqual({ text: "", revision: 0 });
      const result = await registry.applyEdit("alice", 0, [insert("kept")]);
      expect(result.op).toEqual([insert("kept")]);
    });

    it("stops accepting edits from clients of the dropped document", async () => {
      await registry.join("doc1", "alice");
      await registry.join("doc1", "bob");
      store.failNextAppend = true;
      await registry.applyEdit("alice", 0, [insert("lost")]).catch(() => {});
      await expect(registry.applyEdit("bob", 0, [insert("x")])).rejects.toThrow(/not joined/);
    });
  });
});

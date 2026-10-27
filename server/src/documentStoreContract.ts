import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insert, retain } from "@collab/shared";
import { RevisionConflictError, type DocumentStore } from "./DocumentStore";

export interface StoreHarness {
  /** A store with no documents in it. Called before every test. */
  fresh(): Promise<DocumentStore>;
  close(): Promise<void>;
}

/**
 * The behaviour every DocumentStore must have. Each implementation's test file calls this
 * with a way to make an empty store, so all implementations are held to the same rules.
 * (Not named *.test.ts on purpose: it contains no tests until someone calls it.)
 */
export function describeDocumentStoreContract(
  name: string,
  startHarness: () => Promise<StoreHarness>,
  options: { skip?: boolean } = {},
): void {
  const suite = options.skip ? describe.skip : describe;

  suite(`${name} (DocumentStore contract)`, () => {
    let harness: StoreHarness;
    let store: DocumentStore;

    beforeAll(async () => {
      harness = await startHarness();
    });
    afterAll(async () => {
      await harness.close();
    });
    beforeEach(async () => {
      store = await harness.fresh();
    });

    describe("load", () => {
      it("returns null for a document that was never saved", async () => {
        expect(await store.load("nope")).toBeNull();
      });

      it("returns the edits in order, with an empty snapshot", async () => {
        await store.append("doc", 1, [insert("abc")]);
        await store.append("doc", 2, [insert("X"), retain(3)]);
        await store.append("doc", 3, [retain(4)]);

        expect(await store.load("doc")).toEqual({
          snapshotText: "",
          snapshotRevision: 0,
          operations: [[insert("abc")], [insert("X"), retain(3)], [retain(4)]],
        });
      });

      it("keeps documents separate", async () => {
        await store.append("a", 1, [insert("one")]);
        await store.append("b", 1, [insert("two")]);
        expect((await store.load("a"))!.operations).toEqual([[insert("one")]]);
        expect((await store.load("b"))!.operations).toEqual([[insert("two")]]);
      });

      it("round-trips unusual text", async () => {
        const op = [insert("héllo 😀 \"quotes\" \\ and \n newline")];
        await store.append("doc", 1, op);
        expect((await store.load("doc"))!.operations).toEqual([op]);
      });

      it("returns copies: changing what you got back doesn't change what is stored", async () => {
        await store.append("doc", 1, [insert("abc")]);
        const loaded = (await store.load("doc"))!;
        loaded.operations.push([insert("tampered")]);
        loaded.snapshotText = "tampered";
        expect(await store.load("doc")).toEqual({
          snapshotText: "",
          snapshotRevision: 0,
          operations: [[insert("abc")]],
        });
      });

      it("keeps its own copy of an edit you appended", async () => {
        const op = [insert("abc")];
        await store.append("doc", 1, op);
        op.push(insert("tampered"));
        expect((await store.load("doc"))!.operations).toEqual([[insert("abc")]]);
      });
    });

    describe("append", () => {
      it("rejects a duplicate revision and keeps the original", async () => {
        await store.append("doc", 1, [insert("first")]);
        await expect(store.append("doc", 1, [insert("second")])).rejects.toBeInstanceOf(
          RevisionConflictError,
        );
        expect((await store.load("doc"))!.operations).toEqual([[insert("first")]]);
      });

      it("rejects a gap in revisions", async () => {
        await store.append("doc", 1, [insert("abc")]);
        await expect(store.append("doc", 3, [retain(3)])).rejects.toBeInstanceOf(
          RevisionConflictError,
        );
      });

      it("rejects a first edit that isn't revision 1, leaving no trace of the document", async () => {
        await expect(store.append("doc", 2, [insert("x")])).rejects.toBeInstanceOf(
          RevisionConflictError,
        );
        expect(await store.load("doc")).toBeNull();
      });

      it("lets exactly one of two simultaneous writers claim a revision", async () => {
        await store.append("doc", 1, [insert("abc")]);
        const results = await Promise.allSettled([
          store.append("doc", 2, [insert("A"), retain(3)]),
          store.append("doc", 2, [insert("B"), retain(3)]),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        expect((await store.load("doc"))!.operations).toHaveLength(2);
      });
    });

    describe("operationsSince", () => {
      beforeEach(async () => {
        await store.append("doc", 1, [insert("abc")], "alice");
        await store.append("doc", 2, [insert("X"), retain(3)], "bob");
        await store.append("doc", 3, [retain(4), insert("Y")]); // no author
      });

      it("returns the edits after a revision, in order, with their authors", async () => {
        expect(await store.operationsSince("doc", 1)).toEqual([
          { revision: 2, op: [insert("X"), retain(3)], author: "bob" },
          { revision: 3, op: [retain(4), insert("Y")], author: null },
        ]);
      });

      it("returns everything from revision 0 and nothing from the latest revision", async () => {
        expect(await store.operationsSince("doc", 0)).toHaveLength(3);
        expect(await store.operationsSince("doc", 3)).toEqual([]);
      });

      it("still returns edits a snapshot has made unnecessary for loading", async () => {
        await store.saveSnapshot("doc", 3, "XabcY");
        expect((await store.operationsSince("doc", 0)).map((saved) => saved.author)).toEqual([
          "alice",
          "bob",
          null,
        ]);
      });

      it("is empty for a document that was never saved, as long as you haven't seen any of it", async () => {
        expect(await store.operationsSince("missing", 0)).toEqual([]);
        await expect(store.operationsSince("missing", 1)).rejects.toThrow(RangeError);
      });

      it("rejects a revision the document hasn't reached", async () => {
        await expect(store.operationsSince("doc", 4)).rejects.toThrow(RangeError);
      });

      it("returns copies", async () => {
        const [first] = await store.operationsSince("doc", 0);
        first!.op.push(insert("tampered"));
        first!.author = "mallory";
        expect((await store.operationsSince("doc", 0))[0]).toEqual({
          revision: 1,
          op: [insert("abc")],
          author: "alice",
        });
      });

      it("does not let an author change what load returns", async () => {
        expect((await store.load("doc"))!.operations).toEqual([
          [insert("abc")],
          [insert("X"), retain(3)],
          [retain(4), insert("Y")],
        ]);
      });
    });

    describe("saveSnapshot", () => {
      beforeEach(async () => {
        await store.append("doc", 1, [insert("abc")]);
        await store.append("doc", 2, [insert("X"), retain(3)]);
        await store.append("doc", 3, [retain(4), insert("Y")]);
      });

      it("lets load skip the edits the snapshot already covers", async () => {
        await store.saveSnapshot("doc", 2, "Xabc");
        expect(await store.load("doc")).toEqual({
          snapshotText: "Xabc",
          snapshotRevision: 2,
          operations: [[retain(4), insert("Y")]],
        });
      });

      it("can snapshot the latest revision, leaving no edits to replay", async () => {
        await store.saveSnapshot("doc", 3, "XabcY");
        expect(await store.load("doc")).toEqual({
          snapshotText: "XabcY",
          snapshotRevision: 3,
          operations: [],
        });
      });

      it("ignores a snapshot older than the one already stored", async () => {
        await store.saveSnapshot("doc", 3, "XabcY");
        await store.saveSnapshot("doc", 1, "abc");
        expect((await store.load("doc"))!.snapshotRevision).toBe(3);
      });

      it("rejects a snapshot of a revision that doesn't exist yet", async () => {
        await expect(store.saveSnapshot("doc", 9, "?")).rejects.toThrow(RangeError);
        await expect(store.saveSnapshot("missing", 1, "?")).rejects.toThrow(RangeError);
      });

      it("still accepts new edits after a snapshot", async () => {
        await store.saveSnapshot("doc", 3, "XabcY");
        await store.append("doc", 4, [retain(5), insert("Z")]);
        expect((await store.load("doc"))!.operations).toEqual([[retain(5), insert("Z")]]);
      });
    });
  });
}

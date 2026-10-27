import { describe, expect, it } from "vitest";
import {
  applyOperation,
  baseLength,
  createRng,
  insert,
  randomOperation,
  retain,
  targetLength,
  type Operation,
} from "@collab/shared";
import { ServerDocument } from "./ServerDocument";

describe("ServerDocument", () => {
  it("starts empty at revision 0", () => {
    const doc = new ServerDocument();
    expect(doc.text).toBe("");
    expect(doc.revision).toBe(0);
  });

  it("applies an operation made against the current revision unchanged", () => {
    const doc = new ServerDocument();
    const op = [insert("hello")];
    expect(doc.receive(0, op)).toEqual(op);
    expect(doc.text).toBe("hello");
    expect(doc.revision).toBe(1);
  });

  it("rewrites a stale operation: the Phase 1 divergence example now converges", () => {
    const doc = new ServerDocument();
    doc.receive(0, [insert("abc")]); // revision 1: "abc"

    // Alice and Bob both looked at revision 1 and edited at the same time.
    const aliceResult = doc.receive(1, [insert("XX"), retain(3)]);
    const bobResult = doc.receive(1, [retain(3), insert("Y")]);

    expect(aliceResult).toEqual([insert("XX"), retain(3)]);
    expect(bobResult).toEqual([retain(5), insert("Y")]); // 3 became 5
    expect(doc.text).toBe("XXabcY");
    expect(doc.revision).toBe(3);
  });

  it("puts the later-arriving client's text on the left when both insert at the same spot", () => {
    const doc = new ServerDocument("xy");
    doc.receive(0, [retain(1), insert("A"), retain(1)]);
    doc.receive(0, [retain(1), insert("B"), retain(1)]);
    expect(doc.text).toBe("xBAy");
  });

  it("rewrites against several missed operations in order", () => {
    const doc = new ServerDocument();
    doc.receive(0, [insert("abc")]); // rev 1
    doc.receive(1, [insert("1"), retain(3)]); // rev 2: "1abc"
    doc.receive(2, [insert("2"), retain(4)]); // rev 3: "21abc"

    // Made when the doc was just "abc": append "Z".
    doc.receive(1, [retain(3), insert("Z")]);
    expect(doc.text).toBe("21abcZ");
  });

  it("rejects an unknown base revision and changes nothing", () => {
    const doc = new ServerDocument();
    doc.receive(0, [insert("hi")]);
    expect(() => doc.receive(5, [retain(2)])).toThrow(RangeError);
    expect(() => doc.receive(-1, [retain(2)])).toThrow(RangeError);
    expect(() => doc.receive(0.5, [retain(2)])).toThrow(RangeError);
    expect(doc.text).toBe("hi");
    expect(doc.revision).toBe(1);
  });

  it("rejects an operation of the wrong length and changes nothing", () => {
    const doc = new ServerDocument();
    doc.receive(0, [insert("hi")]);
    expect(() => doc.receive(1, [retain(9)])).toThrow(RangeError); // current revision
    expect(() => doc.receive(0, [retain(1)])).toThrow(RangeError); // stale revision
    expect(doc.text).toBe("hi");
    expect(doc.revision).toBe(1);
  });

  it("holds up under random operations made against stale revisions", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rng = createRng(seed);
      const doc = new ServerDocument();
      const textAtRevision: string[] = [""];
      const accepted: Operation[] = [];

      for (let i = 0; i < 150; i++) {
        const base = Math.floor(rng() * (doc.revision + 1));
        const op = randomOperation(rng, textAtRevision[base]!);
        const rewritten = doc.receive(base, op);

        expect(baseLength(rewritten)).toBe(textAtRevision[doc.revision - 1]!.length);
        expect(doc.text.length).toBe(targetLength(rewritten));
        textAtRevision.push(doc.text);
        accepted.push(rewritten);
      }

      // The accepted log, replayed from scratch, must reproduce the document.
      let replayed = "";
      for (const op of accepted) replayed = applyOperation(replayed, op);
      expect(replayed, `seed=${seed}`).toBe(doc.text);
    }
  });
});

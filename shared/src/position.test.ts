import { describe, expect, it } from "vitest";
import { applyOperation as applyOperationText, del, insert, retain, targetLength } from "./operation";
import { transformPosition, transformSelection } from "./position";
import { transform } from "./transform";
import { createRng, randomOperation, randomText } from "./testing";

describe("transformPosition", () => {
  it("shifts positions after an insert and leaves earlier ones alone", () => {
    const op = [retain(2), insert("abc"), retain(3)];
    expect(transformPosition(0, op)).toBe(0);
    expect(transformPosition(2, op)).toBe(2); // exactly at the insert: stays put
    expect(transformPosition(3, op)).toBe(6);
    expect(transformPosition(5, op)).toBe(8);
  });

  it("keeps a position at 0 before an insert at the very start", () => {
    const op = [insert("ab"), retain(3)];
    expect(transformPosition(0, op)).toBe(0);
    expect(transformPosition(1, op)).toBe(3);
  });

  it("pulls positions back after a delete and collapses ones inside it", () => {
    const op = [retain(2), del(3)];
    expect(transformPosition(1, op)).toBe(1);
    expect(transformPosition(2, op)).toBe(2);
    expect(transformPosition(3, op)).toBe(2);
    expect(transformPosition(5, op)).toBe(2);
  });

  it("puts a position inside replaced text after the replacement", () => {
    const op = [retain(1), insert("x"), del(2), retain(1)]; // "abcd" -> "axd"
    expect(transformPosition(1, op)).toBe(1);
    expect(transformPosition(2, op)).toBe(2);
    expect(transformPosition(3, op)).toBe(2);
    expect(transformPosition(4, op)).toBe(3);
  });

  it("always lands inside the new text and never moves backwards, for random inputs", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const doc = randomText(rng, 12);
      const op = randomOperation(rng, doc);
      let previous = 0;
      for (let position = 0; position <= doc.length; position++) {
        const moved = transformPosition(position, op);
        expect(moved).toBeGreaterThanOrEqual(previous);
        expect(moved).toBeLessThanOrEqual(targetLength(op));
        previous = moved;
      }
    }
  });
});

describe("transformSelection", () => {
  it("moves both ends", () => {
    const op = [retain(2), insert("abc"), retain(3)];
    expect(transformSelection({ start: 1, end: 4 }, op)).toEqual({ start: 1, end: 7 });
  });
});

describe("positions and concurrent edits", () => {
  // Text is order-independent: apply two concurrent edits in either order (after transform())
  // and you get the same text. Positions are not. This is the smallest case: a cursor at the
  // end of "c", while one user inserts "y" before it and another deletes the "c".
  it("is not order-independent, which is why cursors must be moved in a fixed order", () => {
    const insertY = [insert("y"), retain(1)];
    const deleteC = [del(1)];
    const [insertYAfterDelete, deleteCAfterInsert] = transform(insertY, deleteC);

    const insertFirst = transformPosition(transformPosition(1, insertY), deleteCAfterInsert);
    const deleteFirst = transformPosition(transformPosition(1, deleteC), insertYAfterDelete);
    expect(insertFirst).toBe(1); // "y|"
    expect(deleteFirst).toBe(0); // "|y"
  });

  it("does agree when every party applies the same edits in the same order", () => {
    const rng = createRng(11);
    for (let i = 0; i < 1000; i++) {
      let doc = randomText(rng, 10);
      const position = Math.floor(rng() * (doc.length + 1));
      const ops = [];
      for (let k = 0; k < 4; k++) {
        const op = randomOperation(rng, doc);
        doc = applyOperationText(doc, op);
        ops.push(op);
      }
      const once = ops.reduce((p, op) => transformPosition(p, op), position);
      const again = ops.reduce((p, op) => transformPosition(p, op), position);
      expect(again).toBe(once);
    }
  });
});

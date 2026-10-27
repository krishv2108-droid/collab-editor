import { describe, expect, it } from "vitest";
import { del, insert, retain, targetLength } from "./operation";
import { transformPosition } from "./position";
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

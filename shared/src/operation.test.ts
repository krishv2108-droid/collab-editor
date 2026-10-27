import { describe, expect, it } from "vitest";
import {
  applyOperation,
  baseLength,
  del,
  diffToOperation,
  insert,
  normalize,
  retain,
  targetLength,
} from "./operation";

describe("normalize", () => {
  it("drops empty pieces", () => {
    expect(normalize([retain(0), insert(""), del(0), retain(2)])).toEqual([retain(2)]);
  });

  it("merges neighbouring pieces of the same kind", () => {
    expect(normalize([retain(1), retain(2), insert("a"), insert("b")])).toEqual([
      retain(3),
      insert("ab"),
    ]);
  });

  it("puts an insert before an adjacent delete", () => {
    expect(normalize([del(2), insert("x")])).toEqual([insert("x"), del(2)]);
    expect(normalize([retain(1), del(2), insert("x"), del(1), retain(1)])).toEqual([
      retain(1),
      insert("x"),
      del(3),
      retain(1),
    ]);
  });

  it("does not move an insert across a retain", () => {
    expect(normalize([del(1), retain(2), insert("x")])).toEqual([del(1), retain(2), insert("x")]);
  });

  it("rejects invalid pieces", () => {
    expect(() => normalize([retain(-1)])).toThrow(RangeError);
    expect(() => normalize([del(1.5)])).toThrow(RangeError);
  });
});

describe("lengths", () => {
  const op = [retain(1), insert("X"), del(3), retain(2)]; // "abcdef" -> "aXef"

  it("baseLength counts retained + deleted", () => {
    expect(baseLength(op)).toBe(6);
  });

  it("targetLength counts retained + inserted", () => {
    expect(targetLength(op)).toBe(4);
  });
});

describe("applyOperation", () => {
  it("applies a mix of retain, insert and delete", () => {
    expect(applyOperation("abcdef", [retain(1), insert("X"), del(3), retain(2)])).toBe("aXef");
  });

  it("inserts at the start and end", () => {
    expect(applyOperation("abc", [insert("XX"), retain(3)])).toBe("XXabc");
    expect(applyOperation("abc", [retain(3), insert("Y")])).toBe("abcY");
  });

  it("works on an empty document", () => {
    expect(applyOperation("", [insert("hi")])).toBe("hi");
  });

  it("does nothing for a retain-only operation", () => {
    expect(applyOperation("abc", [retain(3)])).toBe("abc");
  });

  it("throws when the operation was made for a different-length document", () => {
    expect(() => applyOperation("abc", [retain(5)])).toThrow(RangeError);
    expect(() => applyOperation("abc", [retain(2)])).toThrow(RangeError);
  });
});

describe("diffToOperation", () => {
  it("returns null when nothing changed", () => {
    expect(diffToOperation("hello", "hello")).toBeNull();
  });

  it("describes an insert", () => {
    expect(diffToOperation("helo", "hello")).toEqual([retain(3), insert("l"), retain(1)]);
  });

  it("describes a delete", () => {
    expect(diffToOperation("hello", "hllo")).toEqual([retain(1), del(1), retain(3)]);
  });

  it("describes a replacement, insert first", () => {
    expect(diffToOperation("cat", "cut")).toEqual([retain(1), insert("u"), del(1), retain(1)]);
  });

  it("describes typing into an empty document", () => {
    expect(diffToOperation("", "hi")).toEqual([insert("hi")]);
  });

  it("describes clearing the document", () => {
    expect(diffToOperation("hi", "")).toEqual([del(2)]);
  });

  it("round-trips: lengths match and applying gives the new text", () => {
    const samples = ["", "a", "aa", "hello world", "hello, world", "abcabc", "xyz😀", "a😀b", "😀"];
    for (const a of samples) {
      for (const b of samples) {
        const op = diffToOperation(a, b);
        if (op === null) {
          expect(a).toBe(b);
          continue;
        }
        expect(baseLength(op)).toBe(a.length);
        expect(targetLength(op)).toBe(b.length);
        expect(applyOperation(a, op)).toBe(b);
      }
    }
  });
});

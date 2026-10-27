import { describe, expect, it } from "vitest";
import { compose } from "./compose";
import { applyOperation, baseLength, del, insert, retain, targetLength } from "./operation";
import { createRng, randomOperation, randomText } from "./testing";

describe("compose: hand-picked cases", () => {
  it("combines two inserts", () => {
    // "abc" -> "abcd" -> "Xabcd"
    const result = compose([retain(3), insert("d")], [insert("X"), retain(4)]);
    expect(result).toEqual([insert("X"), retain(3), insert("d")]);
  });

  it("lets a later delete cancel an earlier insert", () => {
    // "abc" -> "axybc" -> "abc"
    const result = compose([retain(1), insert("xy"), retain(2)], [retain(1), del(2), retain(2)]);
    expect(result).toEqual([retain(3)]);
  });

  it("combines two deletes at different places", () => {
    // "abc" -> "bc" -> "b"
    const result = compose([del(1), retain(2)], [retain(1), del(1)]);
    expect(result).toEqual([del(1), retain(1), del(1)]);
  });

  it("lets a later delete remove part of an earlier insert", () => {
    // "" -> "hello" -> "helo"
    const result = compose([insert("hello")], [retain(2), del(1), retain(2)]);
    expect(result).toEqual([insert("helo")]);
  });

  it("composing with a no-op changes nothing", () => {
    const op = [retain(1), insert("x"), del(1)];
    expect(compose(op, [retain(targetLength(op))])).toEqual(op);
    expect(compose([retain(baseLength(op))], op)).toEqual(op);
  });

  it("throws when the lengths don't line up", () => {
    expect(() => compose([retain(3)], [retain(4)])).toThrow(RangeError);
  });
});

describe("compose: randomized", () => {
  it("applying the composed op equals applying the two ops in turn", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = createRng(seed);
      for (let i = 0; i < 250; i++) {
        const doc = randomText(rng, 12);
        const a = randomOperation(rng, doc);
        const mid = applyOperation(doc, a);
        const b = randomOperation(rng, mid);
        const composed = compose(a, b);

        expect(baseLength(composed)).toBe(doc.length);
        expect(targetLength(composed)).toBe(targetLength(b));
        expect(applyOperation(doc, composed), `seed=${seed} i=${i}`).toBe(
          applyOperation(mid, b),
        );
      }
    }
  });

  it("is associative: (a then b) then c equals a then (b then c)", () => {
    const rng = createRng(99);
    for (let i = 0; i < 500; i++) {
      const doc = randomText(rng, 10);
      const a = randomOperation(rng, doc);
      const afterA = applyOperation(doc, a);
      const b = randomOperation(rng, afterA);
      const c = randomOperation(rng, applyOperation(afterA, b));
      expect(compose(compose(a, b), c)).toEqual(compose(a, compose(b, c)));
    }
  });
});

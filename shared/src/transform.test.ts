import { describe, expect, it } from "vitest";
import { applyOperation, baseLength, del, insert, retain, targetLength } from "./operation";
import { createRng, randomOperation, randomText } from "./testing";
import { transform } from "./transform";

describe("transform: hand-picked cases", () => {
  it("fixes the Phase 1 divergence example", () => {
    const alice = [insert("XX"), retain(3)];
    const bob = [retain(3), insert("Y")];
    const [alicePrime, bobPrime] = transform(alice, bob);

    expect(alicePrime).toEqual([insert("XX"), retain(4)]);
    expect(bobPrime).toEqual([retain(5), insert("Y")]);
    expect(applyOperation(applyOperation("abc", alice), bobPrime)).toBe("XXabcY");
    expect(applyOperation(applyOperation("abc", bob), alicePrime)).toBe("XXabcY");
  });

  it("puts the first operation's insert on the left when both insert at the same spot", () => {
    const a = [retain(1), insert("A"), retain(1)];
    const b = [retain(1), insert("B"), retain(1)];
    const [aPrime, bPrime] = transform(a, b);
    expect(applyOperation(applyOperation("xy", a), bPrime)).toBe("xABy");
    expect(applyOperation(applyOperation("xy", b), aPrime)).toBe("xABy");
  });

  it("splits a delete around an insert that landed inside it", () => {
    const alice = [retain(1), del(4), retain(1)]; // abcdef -> af
    const bob = [retain(3), insert("Z"), retain(3)]; // abcdef -> abcZdef
    const [alicePrime, bobPrime] = transform(alice, bob);

    expect(alicePrime).toEqual([retain(1), del(2), retain(1), del(2), retain(1)]);
    expect(applyOperation("abcZdef", alicePrime)).toBe("aZf");
    expect(applyOperation("af", bobPrime)).toBe("aZf");
  });

  it("does not double-delete text that both sides deleted", () => {
    const a = [retain(1), del(2), retain(1)]; // abcd -> ad
    const b = [retain(2), del(2)]; // abcd -> ab
    const [aPrime, bPrime] = transform(a, b);
    expect(applyOperation("ab", aPrime)).toBe("a");
    expect(applyOperation("ad", bPrime)).toBe("a");
  });

  it("handles an empty document", () => {
    const [aPrime, bPrime] = transform([insert("a")], [insert("b")]);
    expect(applyOperation("b", aPrime)).toBe("ab");
    expect(applyOperation("a", bPrime)).toBe("ab");
  });

  it("throws when the operations were made for different documents", () => {
    expect(() => transform([retain(3)], [retain(4)])).toThrow(RangeError);
  });
});

describe("transform: randomized convergence", () => {
  it("both orders of applying give the same text, over thousands of random pairs", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rng = createRng(seed);
      for (let i = 0; i < 250; i++) {
        const doc = randomText(rng, 12);
        const a = randomOperation(rng, doc);
        const b = randomOperation(rng, doc);
        const [aPrime, bPrime] = transform(a, b);

        // The rewritten ops must fit the documents they will be applied to.
        expect(baseLength(aPrime)).toBe(targetLength(b));
        expect(baseLength(bPrime)).toBe(targetLength(a));

        const viaA = applyOperation(applyOperation(doc, a), bPrime);
        const viaB = applyOperation(applyOperation(doc, b), aPrime);
        expect(viaA, `seed=${seed} i=${i} doc=${JSON.stringify(doc)}`).toBe(viaB);
      }
    }
  });
});

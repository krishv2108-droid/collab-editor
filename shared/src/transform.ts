import {
  baseLength,
  del,
  normalize,
  retain,
  type OpComponent,
  type Operation,
} from "./operation";
import { Walker } from "./walker";

/**
 * Given two operations `a` and `b` made on the SAME document at the same time,
 * returns [a', b'] such that:
 *
 *     apply(apply(doc, a), b')  ===  apply(apply(doc, b), a')
 *
 * a' is "a, rewritten to apply after b"; b' is "b, rewritten to apply after a".
 *
 * Tie-break: if both insert at the same spot, `a`'s text goes first (to the left).
 * Callers must use a consistent rule for which operation is `a`.
 */
export function transform(a: Operation, b: Operation): [Operation, Operation] {
  if (baseLength(a) !== baseLength(b)) {
    throw new RangeError(
      `Operations were made for different documents (lengths ${baseLength(a)} and ${baseLength(b)})`,
    );
  }

  const aPrime: OpComponent[] = [];
  const bPrime: OpComponent[] = [];
  const aWalk = new Walker(a);
  const bWalk = new Walker(b);

  while (true) {
    const x = aWalk.head;
    const y = bWalk.head;
    if (!x && !y) break;

    // An insert exists in only one document so far. The other side must skip
    // over it (retain) to stay lined up.
    if (x?.type === "insert") {
      aPrime.push(x);
      bPrime.push(retain(x.text.length));
      aWalk.advance();
      continue;
    }
    if (y?.type === "insert") {
      aPrime.push(retain(y.text.length));
      bPrime.push(y);
      bWalk.advance();
      continue;
    }

    // Both are now retain or delete, so both are walking the original document.
    if (!x || !y) throw new Error("Unreachable: base lengths were checked");
    const count = Math.min(x.count, y.count);

    if (x.type === "retain" && y.type === "retain") {
      aPrime.push(retain(count));
      bPrime.push(retain(count));
    } else if (x.type === "delete" && y.type === "retain") {
      aPrime.push(del(count)); // only a deletes these; b' still has to skip them
    } else if (x.type === "retain" && y.type === "delete") {
      bPrime.push(del(count));
    }
    // both delete: the text is already gone on both sides, so neither prime mentions it

    aWalk.consume(count);
    bWalk.consume(count);
  }

  return [normalize(aPrime), normalize(bPrime)];
}

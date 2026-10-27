import {
  baseLength,
  del,
  insert,
  normalize,
  retain,
  targetLength,
  type OpComponent,
  type Operation,
} from "./operation";
import { pieceLength, Walker } from "./walker";

/**
 * Merges two operations that happen one after the other into a single one:
 *
 *     apply(doc, compose(a, b))  ===  apply(apply(doc, a), b)
 *
 * `a` is applied first, so `b` must have been made for the text `a` produces.
 */
export function compose(a: Operation, b: Operation): Operation {
  if (targetLength(a) !== baseLength(b)) {
    throw new RangeError(
      `Cannot compose: first operation produces length ${targetLength(a)}, ` +
        `second expects ${baseLength(b)}`,
    );
  }

  const result: OpComponent[] = [];
  const aWalk = new Walker(a);
  const bWalk = new Walker(b);

  while (true) {
    const x = aWalk.head;
    const y = bWalk.head;
    if (!x && !y) break;

    // `a` deleted text from the original document; `b` never sees it, so the delete passes through.
    if (x?.type === "delete") {
      result.push(x);
      aWalk.advance();
      continue;
    }
    // `b` inserted brand-new text; `a` never saw it, so the insert passes through.
    if (y?.type === "insert") {
      result.push(y);
      bWalk.advance();
      continue;
    }

    // Now `x` (retain or insert) produces text and `y` (retain or delete) consumes it.
    if (!x || !y) throw new Error("Unreachable: lengths were checked");
    const count = Math.min(pieceLength(x), pieceLength(y));

    if (x.type === "retain" && y.type === "retain") {
      result.push(retain(count));
    } else if (x.type === "insert" && y.type === "retain") {
      result.push(insert(x.text.slice(0, count))); // `b` keeps what `a` inserted
    } else if (x.type === "retain" && y.type === "delete") {
      result.push(del(count)); // `b` deletes original text `a` left alone
    }
    // insert then delete: `b` removes what `a` just inserted, so the two cancel out

    aWalk.consume(count);
    bWalk.consume(count);
  }

  return normalize(result);
}

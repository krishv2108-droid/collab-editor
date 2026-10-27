import type { Operation } from "./operation";

/**
 * Where a position in the old text (e.g. the cursor) ends up once `op` is applied.
 *  - Before the edit: unchanged.   - After it: shifted by how much the text grew or shrank.
 *  - Inside deleted text: collapses to where the deletion was (after any replacement text).
 * A position exactly where text is inserted stays put, so the new text lands after it.
 *
 * Careful: unlike text, positions are NOT order-independent. Moving a position past two
 * concurrent edits in the opposite orders can give different answers, because a deletion
 * throws away which side of a concurrent insert the position was on (see the test
 * "is not order-independent"). Anything that must agree on where a cursor is, such as the
 * server and every client, has to move it past the same edits in the same order.
 */
export function transformPosition(position: number, op: Operation): number {
  let oldPosition = 0; // where we are in the old text
  let newPosition = 0; // where that same spot is in the new text

  for (const piece of op) {
    if (piece.type === "retain") {
      if (position <= oldPosition + piece.count) return newPosition + (position - oldPosition);
      oldPosition += piece.count;
      newPosition += piece.count;
    } else if (piece.type === "insert") {
      if (position <= oldPosition) return newPosition;
      newPosition += piece.text.length;
    } else {
      if (position <= oldPosition + piece.count) return newPosition;
      oldPosition += piece.count;
    }
  }
  return newPosition;
}

/** A cursor, or a highlighted range, as positions in the text. `start === end` is a plain cursor. */
export interface Selection {
  start: number;
  end: number;
}

/** transformPosition for both ends of a selection. */
export function transformSelection(selection: Selection, op: Operation): Selection {
  return {
    start: transformPosition(selection.start, op),
    end: transformPosition(selection.end, op),
  };
}

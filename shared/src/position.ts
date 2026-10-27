import type { Operation } from "./operation";

/**
 * Where a position in the old text (e.g. the cursor) ends up once `op` is applied.
 *  - Before the edit: unchanged.   - After it: shifted by how much the text grew or shrank.
 *  - Inside deleted text: collapses to where the deletion was (after any replacement text).
 * A position exactly where text is inserted stays put, so the new text lands after it.
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

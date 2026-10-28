import { diffToOp } from "./textOps";

/**
 * An operation describes a whole document as a left-to-right walk:
 *   retain: keep the next `count` characters unchanged
 *   insert: put `text` here
 *   delete: remove the next `count` characters
 *
 * Example: turning "abcdef" into "aXef" is
 *   [retain 1, insert "X", delete 3, retain 2]
 */
export type OpComponent =
  | { type: "retain"; count: number }
  | { type: "insert"; text: string }
  | { type: "delete"; count: number };

export type Operation = OpComponent[];

export const retain = (count: number): OpComponent => ({ type: "retain", count });
export const insert = (text: string): OpComponent => ({ type: "insert", text });
export const del = (count: number): OpComponent => ({ type: "delete", count });

/**
 * True if `text` is something we can store and send: no NUL character and no lone half of a
 * surrogate pair (such as half an emoji). Neither can be written to a Postgres jsonb column,
 * so one edit carrying either would make the save fail, which takes the whole document down.
 */
export function isStorableText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit === 0) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1); // NaN at the end of the text, which fails the check
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++; // a well-formed pair: skip its second half
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Checks, at runtime, that something received from the network really is an
 * operation: only known piece types, whole-number counts of at least 1, and
 * non-empty insert text that can be stored. (Whether it fits a particular document is
 * checked later.)
 */
export function isOperation(value: unknown): value is Operation {
  if (!Array.isArray(value)) return false;
  return value.every((piece: unknown) => {
    if (typeof piece !== "object" || piece === null) return false;
    const { type, text, count } = piece as Record<string, unknown>;
    if (type === "insert") return typeof text === "string" && text.length > 0 && isStorableText(text);
    if (type === "retain" || type === "delete") {
      return typeof count === "number" && Number.isInteger(count) && count > 0;
    }
    return false;
  });
}

function assertValid(component: OpComponent): void {
  if (component.type === "insert") {
    if (typeof component.text !== "string") throw new TypeError("insert needs a string");
    return;
  }
  if (!Number.isInteger(component.count) || component.count < 0) {
    throw new RangeError(`${component.type} needs a non-negative integer count`);
  }
}

/**
 * Puts an operation in canonical form so that equal operations look equal:
 *  - empty pieces (retain 0, delete 0, insert "") are dropped
 *  - neighbouring pieces of the same kind are merged
 *  - between two retains, an insert always comes before a delete
 * Throws if any piece is invalid.
 */
export function normalize(components: OpComponent[]): Operation {
  const result: Operation = [];
  let pendingInsert = "";
  let pendingDelete = 0;
  let pendingRetain = 0;

  const flushEdits = () => {
    if (pendingInsert) result.push(insert(pendingInsert));
    if (pendingDelete) result.push(del(pendingDelete));
    pendingInsert = "";
    pendingDelete = 0;
  };
  const flushRetain = () => {
    if (pendingRetain) result.push(retain(pendingRetain));
    pendingRetain = 0;
  };

  for (const component of components) {
    assertValid(component);
    if (component.type === "retain") {
      flushEdits();
      pendingRetain += component.count;
    } else if (component.type === "insert") {
      flushRetain();
      pendingInsert += component.text;
    } else {
      flushRetain();
      pendingDelete += component.count;
    }
  }
  flushEdits();
  flushRetain();
  return result;
}

/** How long the document must be for this operation to apply: retained + deleted. */
export function baseLength(op: Operation): number {
  let length = 0;
  for (const c of op) {
    if (c.type !== "insert") length += c.count;
  }
  return length;
}

/** How long the document is after this operation: retained + inserted. */
export function targetLength(op: Operation): number {
  let length = 0;
  for (const c of op) {
    length += c.type === "retain" ? c.count : c.type === "insert" ? c.text.length : 0;
  }
  return length;
}

/** Applies `op` to `text`. Throws if the operation was made for a different-length document. */
export function applyOperation(text: string, op: Operation): string {
  if (baseLength(op) !== text.length) {
    throw new RangeError(
      `Operation expects a document of length ${baseLength(op)}, got ${text.length}`,
    );
  }
  let position = 0;
  let result = "";
  for (const c of op) {
    if (c.type === "retain") {
      result += text.slice(position, position + c.count);
      position += c.count;
    } else if (c.type === "insert") {
      result += c.text;
    } else {
      position += c.count;
    }
  }
  return result;
}

/**
 * The operation that turns `oldText` into `newText`, or null if they're equal.
 * Reuses the prefix/suffix diff from Phase 1 and re-expresses it as pieces.
 */
export function diffToOperation(oldText: string, newText: string): Operation | null {
  const flat = diffToOp(oldText, newText);
  if (!flat) return null;
  return normalize([
    retain(flat.index),
    del(flat.deleteCount),
    insert(flat.insert),
    retain(oldText.length - flat.index - flat.deleteCount),
  ]);
}

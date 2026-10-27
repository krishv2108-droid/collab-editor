import type { MissedOperation } from "./clientSync";
import { isOperation, type Operation } from "./operation";

/** Longest clientId the server accepts. Real ones are random; this only stops abuse. */
export const MAX_CLIENT_ID_LENGTH = 64;

/** Messages the browser sends to the server. */
export type ClientMessage =
  /**
   * `clientId` is a random id the tab picked for itself and keeps across reconnects, so the
   * server can recognise its edits. `lastRevision` is the last revision the tab processed;
   * with it, the server answers with just the edits it missed instead of the whole text.
   * A tab that sends neither always gets a snapshot. `lastRevision` needs a `clientId`.
   */
  | { type: "join"; docId: string; clientId?: string; lastRevision?: number }
  /** `baseRevision` is the server revision the client had processed when it made `op`. */
  | { type: "edit"; baseRevision: number; op: Operation };

/** Messages the server sends to browsers. */
export type ServerMessage =
  /** The document as of `revision`. Sent once, right after joining. */
  | { type: "snapshot"; text: string; revision: number }
  /**
   * Instead of a snapshot, for a tab that rejoined with a `lastRevision`: everything saved
   * after it, in order, ending at `revision`. `own` marks edits this tab made itself.
   */
  | { type: "catchup"; operations: MissedOperation[]; revision: number }
  /** Your in-flight edit was accepted. */
  | { type: "ack" }
  /** Someone else's edit, already rewritten to apply on top of everything you've processed. */
  | { type: "edit"; op: Operation };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Network input is untrusted: anyone can send anything. TypeScript types
 * vanish at runtime, so we check the shape by hand. Returns null if invalid.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  const data = parseJson(raw);
  if (!isObject(data)) return null;
  if (data.type === "join" && typeof data.docId === "string" && data.docId.length > 0) {
    const join: ClientMessage = { type: "join", docId: data.docId };
    if (data.clientId !== undefined) {
      if (
        typeof data.clientId !== "string" ||
        data.clientId.length === 0 ||
        data.clientId.length > MAX_CLIENT_ID_LENGTH
      ) {
        return null;
      }
      join.clientId = data.clientId;
    }
    if (data.lastRevision !== undefined) {
      if (
        join.clientId === undefined ||
        typeof data.lastRevision !== "number" ||
        !Number.isInteger(data.lastRevision) ||
        data.lastRevision < 0
      ) {
        return null;
      }
      join.lastRevision = data.lastRevision;
    }
    return join;
  }
  if (
    data.type === "edit" &&
    typeof data.baseRevision === "number" &&
    Number.isInteger(data.baseRevision) &&
    data.baseRevision >= 0 &&
    isOperation(data.op)
  ) {
    return { type: "edit", baseRevision: data.baseRevision, op: data.op };
  }
  return null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const data = parseJson(raw);
  if (!isObject(data)) return null;
  if (
    data.type === "snapshot" &&
    typeof data.text === "string" &&
    typeof data.revision === "number" &&
    Number.isInteger(data.revision) &&
    data.revision >= 0
  ) {
    return { type: "snapshot", text: data.text, revision: data.revision };
  }
  if (
    data.type === "catchup" &&
    Array.isArray(data.operations) &&
    typeof data.revision === "number" &&
    Number.isInteger(data.revision) &&
    data.revision >= 0
  ) {
    const operations: MissedOperation[] = [];
    for (const entry of data.operations) {
      if (!isObject(entry) || typeof entry.own !== "boolean" || !isOperation(entry.op)) return null;
      operations.push({ op: entry.op, own: entry.own });
    }
    return { type: "catchup", operations, revision: data.revision };
  }
  if (data.type === "ack") return { type: "ack" };
  if (data.type === "edit" && isOperation(data.op)) {
    return { type: "edit", op: data.op };
  }
  return null;
}

import { isOperation, type Operation } from "./operation";

/** Messages the browser sends to the server. */
export type ClientMessage =
  | { type: "join"; docId: string }
  /** `baseRevision` is the server revision the client had processed when it made `op`. */
  | { type: "edit"; baseRevision: number; op: Operation };

/** Messages the server sends to browsers. */
export type ServerMessage =
  /** The document as of `revision`. Sent once, right after joining. */
  | { type: "snapshot"; text: string; revision: number }
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
    return { type: "join", docId: data.docId };
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
  if (data.type === "ack") return { type: "ack" };
  if (data.type === "edit" && isOperation(data.op)) {
    return { type: "edit", op: data.op };
  }
  return null;
}

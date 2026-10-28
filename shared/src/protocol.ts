import type { MissedOperation } from "./clientSync";
import { isOperation, isStorableText, type Operation } from "./operation";
import type { Selection } from "./position";

/** Another user's cursor. `peer` is an anonymous id the server made up for their connection. */
export interface PeerCursor extends Selection {
  peer: string;
}

/** Longest clientId the server accepts. Real ones are random; this only stops abuse. */
export const MAX_CLIENT_ID_LENGTH = 64;

/** Longest document id the server accepts. */
export const MAX_DOC_ID_LENGTH = 200;

/**
 * Document ids and client ids end up in database columns and in logs, so they are checked
 * strictly. A client id is random (a UUID, or letters and digits); a document id may be any
 * text that can be stored, without control characters.
 */
export function isDocId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DOC_ID_LENGTH &&
    isStorableText(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isClientId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value) && value.length <= MAX_CLIENT_ID_LENGTH;
}

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
  | { type: "edit"; baseRevision: number; op: Operation }
  /** "Are you there?" The server answers with a pong. A browser can't send WebSocket-level pings itself. */
  | { type: "ping" }
  /**
   * Where this user's cursor (or highlighted range) is, in the text of server revision
   * `baseRevision`. Only sent while the client has no unacknowledged edits, so that there is
   * a server revision its text matches exactly.
   */
  | ({ type: "cursor"; baseRevision: number } & Selection);

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
  /** The answer to a ping. */
  | { type: "pong" }
  /** Right after a snapshot or catchup, if anyone else has a cursor: where they all are (in the server's text, as of that revision). */
  | { type: "peers"; peers: PeerCursor[] }
  /** Someone else's cursor moved. In the server's text as of the revision you've processed. */
  | ({ type: "cursor"; peer: string } & Selection)
  /** Someone else left the document. */
  | { type: "peerLeft"; peer: string }
  /** Someone else's edit, already rewritten to apply on top of everything you've processed. */
  | { type: "edit"; op: Operation };

const isPosition = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isSelection = (data: Record<string, unknown>): boolean =>
  isPosition(data.start) && isPosition(data.end) && data.start <= data.end;

/** Longest peer id we accept from the server. */
const MAX_PEER_LENGTH = 32;
const isPeerId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PEER_LENGTH;

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
  if (data.type === "join" && isDocId(data.docId)) {
    const join: ClientMessage = { type: "join", docId: data.docId };
    if (data.clientId !== undefined) {
      if (!isClientId(data.clientId)) return null;
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
  if (data.type === "ping") return { type: "ping" };
  if (data.type === "cursor" && isPosition(data.baseRevision) && isSelection(data)) {
    return {
      type: "cursor",
      baseRevision: data.baseRevision,
      start: data.start as number,
      end: data.end as number,
    };
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

/**
 * True for a message that claims to be a join or an edit but isn't valid. parseClientMessage
 * returns null for these (and for plain garbage). The difference matters: garbage can be
 * ignored, but ignoring a broken edit leaves its sender waiting for an acknowledgement that
 * will never come, so the server should cut that connection instead.
 */
export function isMalformedRequest(raw: string): boolean {
  const data = parseJson(raw);
  return (
    isObject(data) && (data.type === "join" || data.type === "edit") && parseClientMessage(raw) === null
  );
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
  if (data.type === "pong") return { type: "pong" };
  if (data.type === "peers" && Array.isArray(data.peers)) {
    const peers: PeerCursor[] = [];
    for (const entry of data.peers) {
      if (!isObject(entry) || !isPeerId(entry.peer) || !isSelection(entry)) return null;
      peers.push({ peer: entry.peer, start: entry.start as number, end: entry.end as number });
    }
    return { type: "peers", peers };
  }
  if (data.type === "cursor" && isPeerId(data.peer) && isSelection(data)) {
    return { type: "cursor", peer: data.peer, start: data.start as number, end: data.end as number };
  }
  if (data.type === "peerLeft" && isPeerId(data.peer)) return { type: "peerLeft", peer: data.peer };
  if (data.type === "edit" && isOperation(data.op)) {
    return { type: "edit", op: data.op };
  }
  return null;
}

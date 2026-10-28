import { describe, expect, it } from "vitest";
import { insert, retain } from "./operation";
import {
  isDocId,
  isMalformedRequest,
  MAX_CLIENT_ID_LENGTH,
  MAX_DOC_ID_LENGTH,
  parseClientMessage,
  parseServerMessage,
} from "./protocol";

const edit = (baseRevision: unknown, op: unknown) =>
  JSON.stringify({ type: "edit", baseRevision, op });

describe("parseClientMessage", () => {
  it("accepts a valid join", () => {
    expect(parseClientMessage('{"type":"join","docId":"abc"}')).toEqual({
      type: "join",
      docId: "abc",
    });
  });

  it("accepts a join that identifies the tab and what it has seen", () => {
    const message = { type: "join", docId: "abc", clientId: "tab-1", lastRevision: 7 };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    expect(parseClientMessage('{"type":"join","docId":"abc","clientId":"tab-1"}')).toEqual({
      type: "join",
      docId: "abc",
      clientId: "tab-1",
    });
  });

  it("rejects a join with a bad clientId or lastRevision", () => {
    const join = (extra: object) => JSON.stringify({ type: "join", docId: "abc", ...extra });
    expect(parseClientMessage(join({ clientId: "" }))).toBeNull();
    expect(parseClientMessage(join({ clientId: 5 }))).toBeNull();
    expect(parseClientMessage(join({ clientId: "x".repeat(MAX_CLIENT_ID_LENGTH + 1) }))).toBeNull();
    expect(parseClientMessage(join({ clientId: "x".repeat(MAX_CLIENT_ID_LENGTH) }))).not.toBeNull();
    expect(parseClientMessage(join({ clientId: "a", lastRevision: -1 }))).toBeNull();
    expect(parseClientMessage(join({ clientId: "a", lastRevision: 1.5 }))).toBeNull();
    expect(parseClientMessage(join({ clientId: "a", lastRevision: "3" }))).toBeNull();
    // A revision without a clientId can't be answered with "which of these are yours".
    expect(parseClientMessage(join({ lastRevision: 3 }))).toBeNull();
  });

  it("accepts a valid edit", () => {
    const op = [retain(1), insert("x")];
    expect(parseClientMessage(edit(3, op))).toEqual({ type: "edit", baseRevision: 3, op });
  });

  it("accepts a ping", () => {
    expect(parseClientMessage('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  it("accepts a cursor", () => {
    const message = { type: "cursor", baseRevision: 4, start: 2, end: 5 };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    expect(parseClientMessage('{"type":"cursor","baseRevision":0,"start":0,"end":0}')).not.toBeNull();
  });

  it("rejects a cursor with a bad revision or positions", () => {
    const cursor = (extra: object) =>
      JSON.stringify({ type: "cursor", baseRevision: 1, start: 1, end: 2, ...extra });
    expect(parseClientMessage(cursor({ baseRevision: -1 }))).toBeNull();
    expect(parseClientMessage(cursor({ baseRevision: 1.5 }))).toBeNull();
    expect(parseClientMessage(cursor({ start: -1 }))).toBeNull();
    expect(parseClientMessage(cursor({ end: "2" }))).toBeNull();
    expect(parseClientMessage(cursor({ end: 0.5 }))).toBeNull();
    expect(parseClientMessage(cursor({ start: 3, end: 2 }))).toBeNull(); // start must not pass end
    expect(parseClientMessage('{"type":"cursor","baseRevision":1,"start":1}')).toBeNull();
  });

  it("rejects garbage", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage("42")).toBeNull();
    expect(parseClientMessage("null")).toBeNull();
    expect(parseClientMessage('{"type":"nope"}')).toBeNull();
  });

  it("rejects a join with a missing or empty docId", () => {
    expect(parseClientMessage('{"type":"join"}')).toBeNull();
    expect(parseClientMessage('{"type":"join","docId":""}')).toBeNull();
  });

  it("rejects an edit with a bad revision", () => {
    const op = [retain(1)];
    expect(parseClientMessage(edit(-1, op))).toBeNull();
    expect(parseClientMessage(edit(1.5, op))).toBeNull();
    expect(parseClientMessage(edit("1", op))).toBeNull();
    expect(parseClientMessage('{"type":"edit","op":[{"type":"retain","count":1}]}')).toBeNull();
  });

  it("rejects an edit with a malformed operation", () => {
    expect(parseClientMessage(edit(0, "nope"))).toBeNull();
    expect(parseClientMessage(edit(0, [{ type: "retain", count: 0 }]))).toBeNull();
    expect(parseClientMessage(edit(0, [{ type: "retain", count: 1.5 }]))).toBeNull();
    expect(parseClientMessage(edit(0, [{ type: "delete", count: -2 }]))).toBeNull();
    expect(parseClientMessage(edit(0, [{ type: "insert", text: "" }]))).toBeNull();
    expect(parseClientMessage(edit(0, [{ type: "insert", text: 5 }]))).toBeNull();
    expect(parseClientMessage(edit(0, [{ type: "explode" }]))).toBeNull();
    expect(parseClientMessage(edit(0, [null]))).toBeNull();
  });
});

describe("parseServerMessage", () => {
  it("accepts a snapshot", () => {
    expect(parseServerMessage('{"type":"snapshot","text":"hi","revision":4}')).toEqual({
      type: "snapshot",
      text: "hi",
      revision: 4,
    });
  });

  it("rejects a snapshot without text or with a bad revision", () => {
    expect(parseServerMessage('{"type":"snapshot","revision":1}')).toBeNull();
    expect(parseServerMessage('{"type":"snapshot","text":"hi"}')).toBeNull();
    expect(parseServerMessage('{"type":"snapshot","text":"hi","revision":-1}')).toBeNull();
  });

  it("accepts a catchup", () => {
    const message = {
      type: "catchup",
      operations: [
        { op: [insert("x")], own: false },
        { op: [retain(1), insert("y")], own: true },
      ],
      revision: 9,
    };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
    expect(parseServerMessage('{"type":"catchup","operations":[],"revision":0}')).toEqual({
      type: "catchup",
      operations: [],
      revision: 0,
    });
  });

  it("rejects a malformed catchup", () => {
    const catchup = (operations: unknown, revision: unknown = 1) =>
      JSON.stringify({ type: "catchup", operations, revision });
    expect(parseServerMessage(catchup("nope"))).toBeNull();
    expect(parseServerMessage(catchup([null]))).toBeNull();
    expect(parseServerMessage(catchup([{ op: [insert("x")] }]))).toBeNull(); // no `own`
    expect(parseServerMessage(catchup([{ op: [insert("x")], own: "yes" }]))).toBeNull();
    expect(parseServerMessage(catchup([{ op: "bad", own: true }]))).toBeNull();
    expect(parseServerMessage(catchup([], -1))).toBeNull();
    expect(parseServerMessage(catchup([], 1.5))).toBeNull();
  });

  it("accepts peers, a peer's cursor, and a peer leaving", () => {
    const peers = { type: "peers", peers: [{ peer: "1", start: 0, end: 3 }, { peer: "2", start: 5, end: 5 }] };
    expect(parseServerMessage(JSON.stringify(peers))).toEqual(peers);
    expect(parseServerMessage('{"type":"peers","peers":[]}')).toEqual({ type: "peers", peers: [] });
    const cursor = { type: "cursor", peer: "7", start: 1, end: 1 };
    expect(parseServerMessage(JSON.stringify(cursor))).toEqual(cursor);
    expect(parseServerMessage('{"type":"peerLeft","peer":"7"}')).toEqual({ type: "peerLeft", peer: "7" });
  });

  it("rejects malformed peer messages", () => {
    const peers = (list: unknown) => JSON.stringify({ type: "peers", peers: list });
    expect(parseServerMessage(peers("nope"))).toBeNull();
    expect(parseServerMessage(peers([null]))).toBeNull();
    expect(parseServerMessage(peers([{ peer: "", start: 0, end: 0 }]))).toBeNull();
    expect(parseServerMessage(peers([{ peer: "x".repeat(33), start: 0, end: 0 }]))).toBeNull();
    expect(parseServerMessage(peers([{ peer: "1", start: 2, end: 1 }]))).toBeNull();
    expect(parseServerMessage('{"type":"cursor","start":0,"end":0}')).toBeNull(); // no peer
    expect(parseServerMessage('{"type":"cursor","peer":"1","start":-1,"end":0}')).toBeNull();
    expect(parseServerMessage('{"type":"peerLeft"}')).toBeNull();
  });

  it("accepts a pong", () => {
    expect(parseServerMessage('{"type":"pong"}')).toEqual({ type: "pong" });
  });

  it("accepts an ack", () => {
    expect(parseServerMessage('{"type":"ack"}')).toEqual({ type: "ack" });
  });

  it("accepts a remote edit and rejects a malformed one", () => {
    const op = [insert("x")];
    expect(parseServerMessage(JSON.stringify({ type: "edit", op }))).toEqual({ type: "edit", op });
    expect(parseServerMessage('{"type":"edit","op":3}')).toBeNull();
  });
});

describe("document ids", () => {
  it("accepts ordinary ids, including spaces and non-English text", () => {
    for (const id of ["doc1", "my notes", "reconnect-demo", "日本語", "a".repeat(MAX_DOC_ID_LENGTH)]) {
      expect(isDocId(id), id).toBe(true);
    }
  });

  it("rejects empty, over-long, control-character and unstorable ids", () => {
    expect(isDocId("")).toBe(false);
    expect(isDocId("a".repeat(MAX_DOC_ID_LENGTH + 1))).toBe(false);
    expect(isDocId("a\u0000b")).toBe(false); // Postgres can't store NUL
    expect(isDocId("a\nb")).toBe(false);
    expect(isDocId("\ud83d")).toBe(false);
    expect(isDocId(42)).toBe(false);
    expect(isDocId(null)).toBe(false);
  });

  it("is enforced on join", () => {
    const join = (docId: unknown) => JSON.stringify({ type: "join", docId });
    expect(parseClientMessage(join("fine"))).not.toBeNull();
    expect(parseClientMessage(join("x".repeat(MAX_DOC_ID_LENGTH + 1)))).toBeNull();
    expect(parseClientMessage(join("a\u0000b"))).toBeNull();
  });
});

describe("client ids", () => {
  it("accepts UUIDs and short random ids, and rejects anything else", () => {
    const join = (clientId: unknown) => JSON.stringify({ type: "join", docId: "d", clientId });
    expect(parseClientMessage(join("3f2b8c1e-9d4a-4c1b-8e2f-0a1b2c3d4e5f"))).not.toBeNull();
    expect(parseClientMessage(join("k3j2h1g0.abc_DEF:9"))).not.toBeNull();
    expect(parseClientMessage(join("a b"))).toBeNull();
    expect(parseClientMessage(join("a\u0000b"))).toBeNull(); // would make every save of that document fail
    expect(parseClientMessage(join("<script>"))).toBeNull();
    expect(parseClientMessage(join("é"))).toBeNull();
  });
});

describe("edits with text that can't be stored", () => {
  it("are rejected, so they never reach the database", () => {
    const edit = (text: string) =>
      JSON.stringify({ type: "edit", baseRevision: 0, op: [{ type: "insert", text }] });
    expect(parseClientMessage(edit("ok"))).not.toBeNull();
    expect(parseClientMessage(edit("a\u0000b"))).toBeNull();
    expect(parseClientMessage(edit("\ud83d"))).toBeNull();
  });
});

describe("isMalformedRequest", () => {
  it("is true for a join or edit that is broken, because ignoring it would leave the sender waiting", () => {
    expect(isMalformedRequest('{"type":"join"}')).toBe(true);
    expect(isMalformedRequest('{"type":"join","docId":""}')).toBe(true);
    expect(isMalformedRequest('{"type":"edit","baseRevision":-1,"op":[]}')).toBe(true);
    expect(isMalformedRequest(JSON.stringify({ type: "edit", baseRevision: 0, op: [{ type: "insert", text: "\u0000" }] }))).toBe(true);
  });

  it("is false for valid messages, plain garbage and unknown types", () => {
    expect(isMalformedRequest('{"type":"join","docId":"d"}')).toBe(false);
    expect(isMalformedRequest('{"type":"ping"}')).toBe(false);
    expect(isMalformedRequest("not json")).toBe(false);
    expect(isMalformedRequest("42")).toBe(false);
    expect(isMalformedRequest('{"type":"nope"}')).toBe(false);
    expect(isMalformedRequest('{"type":"cursor","baseRevision":-1,"start":0,"end":0}')).toBe(false); // a cursor is never worth disconnecting over
  });
});

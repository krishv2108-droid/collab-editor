import { describe, expect, it } from "vitest";
import { insert, retain } from "./operation";
import { MAX_CLIENT_ID_LENGTH, parseClientMessage, parseServerMessage } from "./protocol";

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

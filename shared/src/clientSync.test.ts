import { describe, expect, it } from "vitest";
import { ClientSync } from "./clientSync";
import { applyOperation, del, insert, retain } from "./operation";

describe("ClientSync: state transitions", () => {
  it("starts synchronized", () => {
    expect(new ClientSync(4).state).toBe("synchronized");
  });

  it("sends the first local edit immediately, tagged with the current revision", () => {
    const sync = new ClientSync(4);
    const op = [insert("a")];
    expect(sync.applyLocal(op)).toEqual({ baseRevision: 4, op });
    expect(sync.state).toBe("awaiting");
  });

  it("holds later edits back in a buffer while one is in flight", () => {
    const sync = new ClientSync(0);
    sync.applyLocal([insert("a")]);
    expect(sync.applyLocal([retain(1), insert("b")])).toBeNull();
    expect(sync.state).toBe("awaitingWithBuffer");
  });

  it("composes several buffered edits into one", () => {
    const sync = new ClientSync(0);
    sync.applyLocal([insert("a")]); // doc "a"
    sync.applyLocal([retain(1), insert("b")]); // doc "ab"
    sync.applyLocal([retain(2), insert("c")]); // doc "abc"
    const next = sync.serverAck();
    expect(next).toEqual({ baseRevision: 1, op: [retain(1), insert("bc")] });
  });

  it("returns to synchronized on an ack with an empty buffer", () => {
    const sync = new ClientSync(0);
    sync.applyLocal([insert("a")]);
    expect(sync.serverAck()).toBeNull();
    expect(sync.state).toBe("synchronized");
  });

  it("sends the buffer after an ack, at the new revision, and stays awaiting", () => {
    const sync = new ClientSync(0);
    sync.applyLocal([insert("a")]);
    sync.applyLocal([retain(1), insert("b")]);
    const next = sync.serverAck();
    expect(next).toEqual({ baseRevision: 1, op: [retain(1), insert("b")] });
    expect(sync.state).toBe("awaiting");
  });

  it("throws on an ack with nothing in flight", () => {
    expect(() => new ClientSync(0).serverAck()).toThrow();
  });
});

describe("ClientSync: remote operations", () => {
  it("passes a remote op through unchanged when synchronized", () => {
    const sync = new ClientSync(0);
    const remote = [insert("hi")];
    expect(sync.applyRemote(remote)).toEqual(remote);
    // The revision moved on, so the next local edit is tagged 1.
    expect(sync.applyLocal([retain(2), insert("!")])?.baseRevision).toBe(1);
  });

  it("rewrites a remote op around our in-flight op (Phase 1 example)", () => {
    // Local doc "abc", we typed Y at the end and it is in flight.
    const sync = new ClientSync(1);
    sync.applyLocal([retain(3), insert("Y")]);
    // Meanwhile the server accepted Alice's "XX" at the front.
    const toApply = sync.applyRemote([insert("XX"), retain(3)]);

    expect(toApply).toEqual([insert("XX"), retain(4)]);
    expect(applyOperation("abcY", toApply)).toBe("XXabcY");
  });

  it("rewrites around both the in-flight op and the buffer", () => {
    const sync = new ClientSync(1);
    sync.applyLocal([retain(3), insert("Y")]); // "abcY"
    sync.applyLocal([retain(4), insert("Z")]); // "abcYZ"
    const toApply = sync.applyRemote([insert("XX"), retain(3)]);

    expect(applyOperation("abcYZ", toApply)).toBe("XXabcYZ");
    // After the ack, the buffer we send must fit the server's document ("XXabcY").
    const next = sync.serverAck();
    expect(next?.baseRevision).toBe(3);
    expect(applyOperation("XXabcY", next!.op)).toBe("XXabcYZ");
  });

  it("keeps our pending ops valid when the remote op deletes around them", () => {
    const sync = new ClientSync(1);
    sync.applyLocal([retain(1), insert("Q"), retain(2)]); // "abc" -> "aQbc"
    const toApply = sync.applyRemote([del(3)]); // remote deletes everything it knew about
    expect(applyOperation("aQbc", toApply)).toBe("Q");
  });
});

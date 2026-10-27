import { describe, expect, it } from "vitest";
import { ClientSync, type MissedOperation, type Outgoing } from "./clientSync";
import { applyOperation, del, insert, retain, type Operation } from "./operation";
import { createRng, randomInt, randomOperation } from "./testing";
import { transform } from "./transform";

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

describe("ClientSync: reconnecting", () => {
  it("has nothing to do when synchronized and nothing was missed", () => {
    const sync = new ClientSync(3);
    expect(sync.reconnect([])).toEqual({ toApply: [], resend: null });
    expect(sync.state).toBe("synchronized");
  });

  it("sends the in-flight op again when the server never saw it", () => {
    const sync = new ClientSync(2);
    const op = [retain(2), insert("a")];
    sync.applyLocal(op);
    expect(sync.reconnect([])).toEqual({ toApply: [], resend: { baseRevision: 2, op } });
    expect(sync.state).toBe("awaiting");
  });

  it("keeps the buffer back while the in-flight op is sent again", () => {
    const sync = new ClientSync(0);
    sync.applyLocal([insert("a")]);
    sync.applyLocal([retain(1), insert("b")]);
    expect(sync.reconnect([]).resend).toEqual({ baseRevision: 0, op: [insert("a")] });
    expect(sync.state).toBe("awaitingWithBuffer");
    // Once that one is acknowledged, the buffer goes out as usual.
    expect(sync.serverAck()).toEqual({ baseRevision: 1, op: [retain(1), insert("b")] });
  });

  it("treats a saved in-flight op as acknowledged instead of sending it twice", () => {
    const sync = new ClientSync(0);
    sync.applyLocal([insert("a")]);
    const result = sync.reconnect([{ op: [insert("a")], own: true }]);
    expect(result).toEqual({ toApply: [], resend: null });
    expect(sync.state).toBe("synchronized");
    expect(sync.applyLocal([retain(1), insert("b")])?.baseRevision).toBe(1);
  });

  it("sends the buffer when the in-flight op turns out to be saved", () => {
    const sync = new ClientSync(0);
    sync.applyLocal([insert("a")]);
    sync.applyLocal([retain(1), insert("b")]);
    const result = sync.reconnect([{ op: [insert("a")], own: true }]);
    expect(result.resend).toEqual({ baseRevision: 1, op: [retain(1), insert("b")] });
    expect(sync.state).toBe("awaiting");
  });

  it("applies edits missed from others and sends ours again on top of them", () => {
    // Local doc "abc" at revision 1; we typed Y at the end, then the connection died.
    const sync = new ClientSync(1);
    sync.applyLocal([retain(3), insert("Y")]); // "abcY"
    const result = sync.reconnect([{ op: [insert("XX"), retain(3)], own: false }]);

    expect(result.toApply).toHaveLength(1);
    expect(applyOperation("abcY", result.toApply[0]!)).toBe("XXabcY");
    expect(result.resend?.baseRevision).toBe(2);
    expect(applyOperation("XXabc", result.resend!.op)).toBe("XXabcY"); // fits the server's text
  });

  it("copes with our own op sitting between other people's edits", () => {
    // Server text "abc". We insert Y at the end; Alice inserted X before it was saved, Bob after.
    const sync = new ClientSync(0);
    sync.applyLocal([insert("abc")]);
    sync.serverAck();
    sync.applyLocal([retain(3), insert("Y")]); // local "abcY"

    const missed: MissedOperation[] = [
      { op: [insert("X"), retain(3)], own: false }, // "Xabc"
      { op: [retain(4), insert("Y")], own: true }, // "XabcY"
      { op: [retain(5), insert("Z")], own: false }, // "XabcYZ"
    ];
    const result = sync.reconnect(missed);

    let local = "abcY";
    for (const op of result.toApply) local = applyOperation(local, op);
    expect(local).toBe("XabcYZ");
    expect(result.resend).toBeNull();
  });

  it("refuses an own operation when nothing of ours is in flight", () => {
    expect(() => new ClientSync(0).reconnect([{ op: [insert("a")], own: true }])).toThrow();
  });
});

describe("ClientSync: reconnecting, randomized", () => {
  /**
   * One client that keeps losing its connection, against a minimal fake server. Each time
   * the connection drops, the in-flight op may or may not have been saved, and the ack is
   * always lost. After reconnecting, client and server must hold the same text, with
   * nothing lost and nothing applied twice.
   */
  function run(seed: number): void {
    const rng = createRng(seed);
    const server = { text: "", log: [] as { op: Operation; own: boolean }[] };
    const client = new ClientSync(0);
    let text = "";
    let pending: Outgoing | null = null;
    let delivered: Outgoing | null = null;

    const deliver = (out: Outgoing): void => {
      let op = out.op;
      for (const saved of server.log.slice(out.baseRevision)) op = transform(op, saved.op)[0];
      server.text = applyOperation(server.text, op);
      server.log.push({ op, own: true });
      delivered = out;
    };
    // How much of the server's log the client has processed (its revision).
    let seen = 0;
    const reconnect = (): void => {
      const result = client.reconnect(server.log.slice(seen));
      seen = server.log.length;
      for (const op of result.toApply) text = applyOperation(text, op);
      pending = result.resend;
      delivered = null;
    };
    for (let round = 0; round < 6; round++) {
      for (let i = randomInt(rng, 0, 2); i > 0; i--) {
        const op = randomOperation(rng, server.text);
        server.text = applyOperation(server.text, op);
        server.log.push({ op, own: false });
      }
      for (let i = randomInt(rng, 0, 3); i > 0; i--) {
        const op = randomOperation(rng, text);
        text = applyOperation(text, op);
        const out = client.applyLocal(op);
        if (out) pending = out;
      }
      if (pending && pending !== delivered && rng() < 0.5) deliver(pending); // saved, but the ack is lost

      reconnect();
      if (rng() < 0.5) {
        // The connection stays up this time: send, get the ack, repeat until quiet.
        while (pending) {
          deliver(pending);
          const next = client.serverAck();
          seen = server.log.length;
          pending = next;
          delivered = null;
        }
      }
    }
    reconnect();
    while (pending) {
      deliver(pending);
      pending = client.serverAck();
      seen = server.log.length;
    }

    expect(client.state).toBe("synchronized");
    expect(text).toBe(server.text);
  }

  it("converges with the server across random disconnects", () => {
    for (let seed = 1; seed <= 500; seed++) {
      try {
        run(seed);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}`);
      }
    }
  });
});

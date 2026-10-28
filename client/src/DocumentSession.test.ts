import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  insert,
  retain,
  type ClientMessage,
  type Operation,
  type PeerCursor,
  type ServerMessage,
} from "@collab/shared";
import { DocumentSession, type ConnectionStatus, type SocketLike } from "./DocumentSession";

/** A WebSocket we control by hand: the test decides when it opens, what arrives, and when it drops. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close(): void {
    this.closeCalls++;
    this.drop(1000);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get edits(): Extract<ClientMessage, { type: "edit" }>[] {
    return this.sent.filter((m): m is Extract<ClientMessage, { type: "edit" }> => m.type === "edit");
  }
}

describe("DocumentSession", () => {
  let sockets: FakeSocket[];
  let statuses: ConnectionStatus[];
  let changes: Array<{ text: string; operations: Operation[] }>;
  let peerViews: PeerCursor[][];
  let session: DocumentSession;

  const latest = () => sockets[sockets.length - 1]!;

  /** randomness fixed at "all of the jitter", so waits are exactly 499, 999, 1999, ... ms */
  const full = () => 0.999999;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    statuses = [];
    changes = [];
    peerViews = [];
    session = new DocumentSession({
      url: "ws://test",
      docId: "doc",
      clientId: "tab-1",
      random: full,
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      listener: {
        onStatus: (status) => statuses.push(status),
        onRemoteChange: (text, operations) => changes.push({ text, operations }),
        onPeersChange: (peers) => peerViews.push(peers),
      },
    });
  });
  afterEach(() => {
    session.stop();
    vi.useRealTimers();
  });

  /** Connect and receive the first snapshot. */
  function joinFresh(text = "", revision = 0): FakeSocket {
    session.start();
    latest().open();
    latest().receive({ type: "snapshot", text, revision });
    return latest();
  }

  describe("joining", () => {
    it("introduces itself, then becomes ready when the snapshot arrives", () => {
      session.start();
      expect(session.status).toBe("connecting");
      latest().open();
      expect(latest().sent).toEqual([{ type: "join", docId: "doc", clientId: "tab-1" }]);

      latest().receive({ type: "snapshot", text: "hello", revision: 3 });
      expect(session.status).toBe("ready");
      expect(session.text).toBe("hello");
      expect(changes).toEqual([{ text: "hello", operations: [] }]);
    });

    it("ignores typing until there is a document", () => {
      session.start();
      latest().open();
      session.edit("x");
      expect(session.text).toBe("");
      expect(latest().edits).toEqual([]);
    });
  });

  describe("editing while connected", () => {
    it("sends an edit, holds the next back until the ack, then sends it", () => {
      const socket = joinFresh();
      session.edit("a");
      session.edit("ab");
      expect(socket.edits).toEqual([{ type: "edit", baseRevision: 0, op: [insert("a")] }]);

      socket.receive({ type: "ack" });
      expect(socket.edits[1]).toEqual({ type: "edit", baseRevision: 1, op: [retain(1), insert("b")] });
    });

    it("applies another user's edit to the text and reports the change that was applied", () => {
      const socket = joinFresh("abc", 1);
      socket.receive({ type: "edit", op: [insert("X"), retain(3)] });
      expect(session.text).toBe("Xabc");
      expect(changes.at(-1)).toEqual({ text: "Xabc", operations: [[insert("X"), retain(3)]] });
    });
  });

  describe("when the connection drops", () => {
    it("keeps the document, reports 'reconnecting', and retries after a pause", () => {
      joinFresh("abc", 1);
      latest().drop();
      expect(session.status).toBe("reconnecting");
      expect(session.text).toBe("abc");
      expect(sockets).toHaveLength(1);

      vi.advanceTimersByTime(498);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(2);
    });

    it("rejoins saying which tab it is and the last revision it processed", () => {
      const socket = joinFresh("abc", 4);
      socket.receive({ type: "edit", op: [retain(3), insert("!")] }); // revision 5
      socket.drop();
      vi.advanceTimersByTime(500);
      latest().open();
      expect(latest().sent).toEqual([{ type: "join", docId: "doc", clientId: "tab-1", lastRevision: 5 }]);
    });

    it("waits longer after each failed attempt, and starts over after a successful join", () => {
      joinFresh("", 0);
      latest().drop();
      for (const wait of [499, 999, 1999]) {
        const before = sockets.length;
        vi.advanceTimersByTime(wait - 1);
        expect(sockets).toHaveLength(before);
        vi.advanceTimersByTime(1);
        expect(sockets).toHaveLength(before + 1);
        latest().drop(); // the server is still down
      }

      vi.advanceTimersByTime(3999);
      latest().open();
      latest().receive({ type: "catchup", operations: [], revision: 0 });
      latest().drop();
      const count = sockets.length;
      vi.advanceTimersByTime(499); // back to the shortest wait
      expect(sockets).toHaveLength(count + 1);
    });

    it("does not count a connection that opens but is never answered as a success", () => {
      joinFresh("", 0);
      latest().drop();
      vi.advanceTimersByTime(499);
      latest().open(); // connected, but the join is never answered
      latest().drop();
      vi.advanceTimersByTime(998);
      expect(sockets).toHaveLength(2); // the wait has grown to 999 ms, not back to 499
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(3);
    });

    it("retries straight away when told the network is back", () => {
      joinFresh();
      latest().drop();
      session.retryNow();
      expect(sockets).toHaveLength(2);
      vi.advanceTimersByTime(4_000); // and the old timer doesn't make a third attempt
      expect(sockets).toHaveLength(2);
    });

    it("keeps retrying if the very first connection fails", () => {
      session.start();
      latest().drop();
      expect(session.status).toBe("connecting");
      vi.advanceTimersByTime(499);
      expect(sockets).toHaveLength(2);
      latest().open();
      expect(latest().sent).toEqual([{ type: "join", docId: "doc", clientId: "tab-1" }]); // nothing to catch up on
    });
  });

  describe("typing while offline", () => {
    it("keeps the text, sends nothing, and sends it after reconnecting", () => {
      const socket = joinFresh("abc", 1);
      socket.drop();
      session.edit("abcd");
      session.edit("abcde");
      expect(session.text).toBe("abcde");
      expect(socket.edits).toEqual([]);

      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({ type: "catchup", operations: [], revision: 1 });
      expect(session.status).toBe("ready");
      // One edit goes out; the other waits for its ack, as always.
      expect(latest().edits).toEqual([{ type: "edit", baseRevision: 1, op: [retain(3), insert("d")] }]);
      latest().receive({ type: "ack" });
      expect(latest().edits[1]).toEqual({ type: "edit", baseRevision: 2, op: [retain(4), insert("e")] });
    });

    it("holds edits back while the server hasn't answered the join yet", () => {
      const socket = joinFresh("abc", 1);
      socket.drop();
      vi.advanceTimersByTime(500);
      latest().open(); // connected, join sent, no answer yet
      session.edit("abcd");
      expect(latest().edits).toEqual([]);

      latest().receive({ type: "catchup", operations: [], revision: 1 });
      expect(latest().edits).toEqual([{ type: "edit", baseRevision: 1, op: [retain(3), insert("d")] }]);
    });

    it("sends an in-flight edit again if the server never saw it", () => {
      const socket = joinFresh("abc", 1);
      session.edit("abcd"); // sent, but the ack never comes
      socket.drop();
      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({ type: "catchup", operations: [], revision: 1 });
      expect(latest().edits).toEqual([{ type: "edit", baseRevision: 1, op: [retain(3), insert("d")] }]);
    });

    it("does not send it again if the server had saved it", () => {
      const socket = joinFresh("abc", 1);
      session.edit("abcd");
      socket.drop();
      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({
        type: "catchup",
        operations: [{ op: [retain(3), insert("d")], own: true }],
        revision: 2,
      });
      expect(latest().edits).toEqual([]);
      expect(session.text).toBe("abcd");
    });

    it("merges edits made by others in the meantime and reports what changed", () => {
      const socket = joinFresh("abc", 1);
      session.edit("abcY"); // in flight, then the connection dies
      socket.drop();
      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({
        type: "catchup",
        operations: [{ op: [insert("XX"), retain(3)], own: false }],
        revision: 2,
      });

      expect(session.text).toBe("XXabcY");
      expect(changes.at(-1)?.text).toBe("XXabcY");
      expect(changes.at(-1)?.operations).toHaveLength(1);
      expect(latest().edits).toEqual([{ type: "edit", baseRevision: 2, op: [retain(5), insert("Y")] }]);
    });
  });

  describe("when reconnecting can't work", () => {
    it("takes a snapshot if the server sends one instead of a catchup", () => {
      const socket = joinFresh("abc", 1);
      socket.drop();
      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({ type: "snapshot", text: "server text", revision: 9 });
      expect(session.text).toBe("server text");
      expect(session.status).toBe("ready");
    });

    it("starts over from a snapshot if the catchup doesn't add up", () => {
      const socket = joinFresh("abc", 1);
      socket.drop();
      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({ type: "catchup", operations: [], revision: 7 }); // we were at 1, nothing missed
      expect(latest().closeCalls).toBe(1);

      vi.advanceTimersByTime(1_000);
      expect(sockets).toHaveLength(3);
      latest().open();
      expect(latest().sent).toEqual([{ type: "join", docId: "doc", clientId: "tab-1" }]); // no revision: asks for a snapshot
    });

    it("starts over if the server acks an edit we never sent", () => {
      const socket = joinFresh("abc", 1);
      socket.receive({ type: "ack" });
      expect(socket.closeCalls).toBe(1);
    });

    it("reconnects when the server says a newer connection replaced this one: it can only have been ours", () => {
      // An old connection's join reached the server after the new one's, so the server kept the old.
      joinFresh("abc", 1);
      latest().drop(4001);
      expect(session.status).toBe("reconnecting");
      vi.advanceTimersByTime(500);
      expect(sockets).toHaveLength(2);
    });

    it("gives up for good when the server rejects an edit", () => {
      joinFresh();
      latest().drop(1008);
      expect(session.status).toBe("outOfSync");
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
    });

    it("gives up for good when the server says a message was too big, instead of resending it forever", () => {
      // The ws library closes a connection with 1009 when an edit passes its 1 MiB limit.
      // The edit is still in flight, so reconnecting would send it again and be cut off again.
      const socket = joinFresh("abc", 1);
      session.edit("abc" + "x".repeat(2_000_000));
      socket.drop(1009);
      expect(session.status).toBe("outOfSync");
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
    });

    it("retries after a server-side problem (1011)", () => {
      joinFresh();
      latest().drop(1011);
      vi.advanceTimersByTime(500);
      expect(sockets).toHaveLength(2);
    });
  });

  describe("noticing a dead connection", () => {
    const pings = (socket: FakeSocket) => socket.sent.filter((m) => m.type === "ping").length;

    it("pings a quiet connection, and carries on if the server answers", () => {
      const socket = joinFresh("abc", 1);
      vi.advanceTimersByTime(9_999);
      expect(pings(socket)).toBe(0);
      vi.advanceTimersByTime(1);
      expect(pings(socket)).toBe(1);

      socket.receive({ type: "pong" });
      for (let round = 2; round <= 6; round++) {
        vi.advanceTimersByTime(10_000); // quiet again, so it asks again
        expect(pings(socket)).toBe(round);
        socket.receive({ type: "pong" });
      }
      expect(sockets).toHaveLength(1);
      expect(session.status).toBe("ready");
    });

    it("gives up on a connection that doesn't answer, and reconnects without waiting for the browser", () => {
      const socket = joinFresh("abc", 1);
      vi.advanceTimersByTime(10_000); // ping sent
      vi.advanceTimersByTime(4_999);
      expect(session.status).toBe("ready");
      vi.advanceTimersByTime(1); // 5 s of silence
      expect(session.status).toBe("reconnecting");
      expect(socket.closeCalls).toBe(1);

      vi.advanceTimersByTime(499);
      expect(sockets).toHaveLength(2);
      latest().open();
      expect(latest().sent).toEqual([{ type: "join", docId: "doc", clientId: "tab-1", lastRevision: 1 }]);
    });

    it("treats any message as proof of life, not only a pong", () => {
      const socket = joinFresh("abc", 1);
      vi.advanceTimersByTime(10_000); // ping sent
      vi.advanceTimersByTime(4_000);
      socket.receive({ type: "edit", op: [insert("X"), retain(3)] });
      vi.advanceTimersByTime(4_000); // would have been past the deadline
      expect(session.status).toBe("ready");
      expect(sockets).toHaveLength(1);
    });

    it("doesn't ping a connection that is busy anyway", () => {
      const socket = joinFresh("abc", 1);
      for (let i = 0; i < 12; i++) {
        vi.advanceTimersByTime(5_000);
        socket.receive({ type: "edit", op: [retain(3 + i), insert("x")] });
      }
      expect(pings(socket)).toBe(0);
    });

    it("gives up on a connection attempt that never opens", () => {
      session.start();
      vi.advanceTimersByTime(5_000);
      expect(sockets[0]!.closeCalls).toBe(1);
      expect(session.status).toBe("connecting");
      vi.advanceTimersByTime(499);
      expect(sockets).toHaveLength(2);
    });

    it("stops waiting for an attempt that did open in time", () => {
      session.start();
      vi.advanceTimersByTime(4_000);
      latest().open();
      latest().receive({ type: "snapshot", text: "", revision: 0 });
      vi.advanceTimersByTime(5_000); // past the connect deadline, before the first ping
      expect(sockets).toHaveLength(1);
      expect(latest().closeCalls).toBe(0);
    });

    it("is quiet after stop()", () => {
      const socket = joinFresh();
      session.stop();
      vi.advanceTimersByTime(60_000);
      expect(pings(socket)).toBe(0);
      expect(sockets).toHaveLength(1);
    });

    it("loses nothing: an edit in flight on a connection that died is dealt with on rejoin", () => {
      const socket = joinFresh("abc", 1);
      session.edit("abcd"); // the server saves it, but the connection is dead before we hear back
      vi.advanceTimersByTime(10_000 + 5_000);
      expect(session.status).toBe("reconnecting");
      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({
        type: "catchup",
        operations: [{ op: [retain(3), insert("d")], own: true }],
        revision: 2,
      });
      expect(latest().edits).toEqual([]); // not sent twice
      expect(socket.edits).toHaveLength(1);
      expect(session.text).toBe("abcd");
    });
  });

  describe("cursors", () => {
    const cursors = (socket: FakeSocket) =>
      socket.sent.filter((m): m is Extract<ClientMessage, { type: "cursor" }> => m.type === "cursor");
    const peersNow = () => peerViews.at(-1);

    describe("sending ours", () => {
      it("reports the cursor with the revision it was made at", () => {
        const socket = joinFresh("hello", 4);
        session.setSelection({ start: 1, end: 3 });
        expect(cursors(socket)).toEqual([{ type: "cursor", baseRevision: 4, start: 1, end: 3 }]);
      });

      it("says nothing for a cursor that hasn't moved", () => {
        const socket = joinFresh("hello", 4);
        session.setSelection({ start: 1, end: 3 });
        session.setSelection({ start: 1, end: 3 });
        expect(cursors(socket)).toHaveLength(1);
      });

      it("waits while an edit is unacknowledged, then reports where the cursor is by then", () => {
        const socket = joinFresh("hello", 4);
        session.edit("hello!"); // in flight
        session.setSelection({ start: 6, end: 6 });
        expect(cursors(socket)).toEqual([]); // our text isn't any revision the server has

        socket.receive({ type: "ack" });
        expect(cursors(socket)).toEqual([{ type: "cursor", baseRevision: 5, start: 6, end: 6 }]);
      });

      it("waits through a whole chain of edits and reports once, at the end", () => {
        const socket = joinFresh("", 0);
        session.edit("a");
        session.edit("ab"); // buffered
        session.setSelection({ start: 2, end: 2 });
        socket.receive({ type: "ack" }); // sends the buffer: still not synchronized
        expect(cursors(socket)).toEqual([]);
        socket.receive({ type: "ack" });
        expect(cursors(socket)).toEqual([{ type: "cursor", baseRevision: 2, start: 2, end: 2 }]);
      });

      it("doesn't send before the server has answered the join", () => {
        session.start();
        latest().open();
        session.setSelection({ start: 0, end: 0 });
        expect(cursors(latest())).toEqual([]);
      });

      it("spaces cursor messages out, sending only the latest position", () => {
        const socket = joinFresh("hello", 1);
        session.setSelection({ start: 1, end: 1 });
        session.setSelection({ start: 2, end: 2 });
        session.setSelection({ start: 3, end: 3 });
        expect(cursors(socket)).toHaveLength(1); // the first goes at once

        vi.advanceTimersByTime(49);
        expect(cursors(socket)).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(cursors(socket).map((m) => m.start)).toEqual([1, 3]); // 2 was skipped
      });

      it("reports the cursor again after our own edit, even when it ends up at the same number", () => {
        const socket = joinFresh("abcd", 1);
        session.setSelection({ start: 2, end: 2 }); // sent: between b and c
        session.edit("aXbcd"); // typed before the cursor...
        session.setSelection({ start: 2, end: 2 }); // ...so the cursor sits after the X: still "2", but not the same place
        expect(cursors(socket)).toHaveLength(1);

        socket.receive({ type: "ack" });
        vi.advanceTimersByTime(50); // cursor messages are spaced out
        // The server moved its copy past the X (to 3), so it has to be told.
        expect(cursors(socket)).toHaveLength(2);
        expect(cursors(socket)[1]).toEqual({ type: "cursor", baseRevision: 2, start: 2, end: 2 });
      });

      it("follows its own cursor through other people's edits instead of reporting it again", () => {
        const socket = joinFresh("hello", 1);
        session.setSelection({ start: 2, end: 2 });
        socket.receive({ type: "edit", op: [insert("XX"), retain(5)] }); // pushes the cursor to 4
        session.setSelection({ start: 4, end: 4 }); // the textarea reports the moved cursor
        vi.advanceTimersByTime(1000);
        expect(cursors(socket)).toHaveLength(1);
      });

      it("doesn't stall when the computer's clock is set back", () => {
        const socket = joinFresh("hello", 1);
        session.setSelection({ start: 1, end: 1 }); // sent at the current time
        vi.setSystemTime(Date.now() - 60 * 60 * 1000); // the clock jumps back an hour
        session.setSelection({ start: 2, end: 2 });
        vi.advanceTimersByTime(60); // not an hour
        expect(cursors(socket).map((m) => m.start)).toEqual([1, 2]);
      });

      it("reports it again after reconnecting, because the server forgot it", () => {
        const socket = joinFresh("hello", 1);
        session.setSelection({ start: 2, end: 2 });
        socket.drop();
        vi.advanceTimersByTime(500);
        latest().open();
        latest().receive({ type: "catchup", operations: [{ op: [insert("XX"), retain(5)], own: false }], revision: 2 });
        expect(cursors(latest())).toEqual([{ type: "cursor", baseRevision: 2, start: 4, end: 4 }]);
      });

      it("holds it back after reconnecting while an edit still has to be sent again", () => {
        const socket = joinFresh("hello", 1);
        session.setSelection({ start: 2, end: 2 });
        session.edit("hello!");
        socket.drop();
        vi.advanceTimersByTime(500);
        latest().open();
        latest().receive({ type: "catchup", operations: [], revision: 1 });
        expect(cursors(latest())).toEqual([]);
        latest().receive({ type: "ack" });
        expect(cursors(latest())).toHaveLength(1);
      });
    });

    describe("showing theirs", () => {
      it("reports a peer's cursor as it arrives", () => {
        const socket = joinFresh("hello", 1);
        socket.receive({ type: "cursor", peer: "7", start: 1, end: 3 });
        expect(peersNow()).toEqual([{ peer: "7", start: 1, end: 3 }]);
      });

      it("learns the cursors already there when joining", () => {
        session.start();
        latest().open();
        latest().receive({ type: "snapshot", text: "hello", revision: 1 });
        latest().receive({ type: "peers", peers: [{ peer: "1", start: 0, end: 0 }, { peer: "2", start: 4, end: 5 }] });
        expect(peersNow()).toEqual([
          { peer: "1", start: 0, end: 0 },
          { peer: "2", start: 4, end: 5 },
        ]);
      });

      it("forgets a peer who left", () => {
        const socket = joinFresh("hello", 1);
        socket.receive({ type: "cursor", peer: "7", start: 1, end: 1 });
        socket.receive({ type: "peerLeft", peer: "7" });
        expect(peersNow()).toEqual([]);
      });

      it("moves a cursor along with other people's edits", () => {
        const socket = joinFresh("hello", 1);
        socket.receive({ type: "cursor", peer: "7", start: 2, end: 4 });
        socket.receive({ type: "edit", op: [insert("XX"), retain(5)] });
        expect(peersNow()).toEqual([{ peer: "7", start: 4, end: 6 }]);
      });

      it("moves a cursor along with our own edits once the server has accepted them", () => {
        const socket = joinFresh("hello", 1);
        socket.receive({ type: "cursor", peer: "7", start: 2, end: 2 });
        session.edit("XXhello"); // on screen at once, though the server doesn't have it yet
        expect(peersNow()).toEqual([{ peer: "7", start: 4, end: 4 }]);
        socket.receive({ type: "ack" }); // now it does; the cursor must not move twice
        expect(peersNow()).toEqual([{ peer: "7", start: 4, end: 4 }]);
        socket.receive({ type: "edit", op: [retain(7), insert("!")] });
        expect(peersNow()).toEqual([{ peer: "7", start: 4, end: 4 }]);
      });

      it("draws a cursor past edits that are still buffered", () => {
        const socket = joinFresh("hello", 1);
        socket.receive({ type: "cursor", peer: "7", start: 5, end: 5 });
        session.edit("Xhello"); // in flight
        session.edit("XYhello"); // buffered
        expect(peersNow()).toEqual([{ peer: "7", start: 7, end: 7 }]);
      });

      it("hides everyone's cursor while disconnected, and takes the server's word again on return", () => {
        const socket = joinFresh("hello", 1);
        socket.receive({ type: "cursor", peer: "7", start: 2, end: 2 });
        socket.drop();
        expect(peersNow()).toEqual([]);

        vi.advanceTimersByTime(500);
        latest().open();
        latest().receive({ type: "catchup", operations: [], revision: 1 });
        expect(peersNow()).toEqual([]);
        latest().receive({ type: "peers", peers: [{ peer: "9", start: 3, end: 3 }] });
        expect(peersNow()).toEqual([{ peer: "9", start: 3, end: 3 }]);
      });

      it("drops the old cursors when a snapshot replaces the whole text", () => {
        const socket = joinFresh("hello", 1);
        socket.receive({ type: "cursor", peer: "7", start: 2, end: 2 });
        socket.drop();
        vi.advanceTimersByTime(500);
        latest().open();
        latest().receive({ type: "snapshot", text: "other", revision: 9 });
        expect(peersNow()).toEqual([]);
      });
    });
  });

  describe("stopping", () => {
    it("cancels a pending retry", () => {
      joinFresh().drop();
      session.stop();
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1);
    });

    it("closes the socket and reports nothing more", () => {
      const socket = joinFresh();
      const reported = statuses.length;
      session.stop();
      expect(socket.closeCalls).toBe(1);
      expect(statuses).toHaveLength(reported);
    });

    it("ignores whatever an old socket says after a newer one has taken over", () => {
      const first = joinFresh("abc", 1);
      first.drop();
      vi.advanceTimersByTime(500);
      latest().open();
      latest().receive({ type: "catchup", operations: [], revision: 1 });

      first.receive({ type: "edit", op: [insert("ghost"), retain(3)] }); // the old, half-dead connection still talking
      expect(session.text).toBe("abc");
    });
  });
});

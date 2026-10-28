import {
  applyOperation,
  ClientSync,
  diffToOperation,
  parseServerMessage,
  transformSelection,
  type ClientMessage,
  type Operation,
  type Outgoing,
  type PeerCursor,
  type Selection,
} from "@collab/shared";
import { backoffDelay } from "./backoff";

/**
 * - connecting:   no document yet (first visit, or the server made us start over)
 * - ready:        connected and in step with the server
 * - reconnecting: the connection dropped; we keep the document, accept typing, and retry
 * - outOfSync:    the server refused something we sent (an invalid edit, or one over its size
 *                 limit); retrying would only repeat it, so the page needs a reload (final)
 */
export type ConnectionStatus = "connecting" | "ready" | "reconnecting" | "outOfSync";

/** The little bit of WebSocket we use, so tests can stand in a fake one. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
}

export interface SessionListener {
  onStatus(status: ConnectionStatus): void;
  /**
   * The text changed because of the server. `operations` are the changes that were applied
   * to the previous text, in order (empty when the whole text was replaced by a snapshot),
   * so the caller can move the cursor along with them.
   */
  onRemoteChange(text: string, operations: Operation[]): void;
  /**
   * Where the other users' cursors are, in the text the user is looking at (their own
   * unacknowledged edits included). Called whenever any of them moves or the text changes.
   * Empty while disconnected: positions we can't keep up to date aren't worth showing.
   */
  onPeersChange?(peers: PeerCursor[]): void;
}

export interface SessionOptions {
  url: string;
  docId: string;
  /** Random and unique to this tab. The server uses it to recognise our edits after a reconnect. */
  clientId: string;
  listener: SessionListener;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  /** How long a connection may be quiet before we ask whether it is still there. */
  heartbeatMs?: number;
  /** How long to wait for any answer (to a ping, or to opening the connection) before giving up on it. */
  timeoutMs?: number;
  /** The shortest time between two cursor messages. A drag-select would otherwise send one per pixel. */
  cursorIntervalMs?: number;
}

export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_CURSOR_INTERVAL_MS = 50;

const SOCKET_OPEN = 1;

// Close codes that mean "reconnecting won't help": the server refused something we sent, and
// our edit is still in flight, so reconnecting would send it again and be refused again.
// 1008 is "policy violation" (see hub.ts), 1009 is "message too big" (sent by the ws library).
// Notably NOT the "replaced by a newer connection" code (4001): each page load has its own
// random clientId, so the only connection that can replace ours is an older one of ours whose
// last message reached the server late. Reconnecting is the right answer to that.
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_MESSAGE_TOO_BIG = 1009;

/**
 * One tab's connection to one document: the socket, the OT state (ClientSync), the text,
 * and what to do when the connection drops. No React in here, so it can be tested alone.
 *
 * When the connection drops we keep everything. The user can keep typing: edits pile up
 * inside ClientSync exactly as they do while waiting for an ack. We retry with growing
 * pauses, and each time we rejoin we say which revision we last saw, so the server can
 * answer with just what we missed (see ClientSync.reconnect for how that is applied).
 */
export class DocumentSession {
  private sync: ClientSync | null = null;
  private current = "";
  private socket: SocketLike | null = null;
  /** True once the server has answered our join on the current socket. */
  private joined = false;
  /** Failed attempts since the last successful join. */
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Fires when it is time to ask the server whether it is still there. */
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires if the server hasn't answered in time: the connection is dead. */
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private currentStatus: ConnectionStatus = "connecting";

  /** The user's own cursor, in the text they are looking at. Null until they first click or type. */
  private selection: Selection | null = null;
  /** True when the server hasn't been told where the cursor is now. */
  private cursorDirty = false;
  private lastCursorSent = -Infinity;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Other users' cursors, kept in the SERVER's text (not the one on screen). Each is moved
   * past every edit the server accepts, ours included, in the order the server accepted them:
   * exactly what the server does with its copy, so the two can't disagree. What is drawn is
   * this, projected through our own pending edits (see notifyPeers).
   */
  private peers = new Map<string, Selection>();

  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly cursorIntervalMs: number;

  constructor(private readonly options: SessionOptions) {
    // A browser WebSocket has the same shape; the cast only smooths over its event types.
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = options.random ?? Math.random;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cursorIntervalMs = options.cursorIntervalMs ?? DEFAULT_CURSOR_INTERVAL_MS;
  }

  get text(): string {
    return this.current;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  start(): void {
    this.connect();
  }

  /** Closes everything for good. Nothing more is reported afterwards. */
  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.clearLiveness();
    this.clearCursorTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
  }

  /** If we're waiting to retry, retry now (for example because the browser says it's back online). */
  retryNow(): void {
    if (this.timer === null) return;
    this.clearTimer();
    this.connect();
  }

  /** The user changed the text to `newText`. Ignored until the first snapshot has arrived. */
  edit(newText: string): void {
    if (!this.sync) return;
    const op = diffToOperation(this.current, newText);
    this.current = newText;
    if (!op) return;
    // Our cursor moves with our own typing, so what we remember of it must too. And the
    // server moved its copy past this edit as IT received it (possibly rewritten against
    // someone else's edit), which can land somewhere else: tell it again once we're in step.
    if (this.selection) {
      this.selection = transformSelection(this.selection, op);
      this.cursorDirty = true;
    }
    const outgoing = this.sync.applyLocal(op);
    if (outgoing) this.sendEdit(outgoing);
    this.notifyPeers(); // what we have pending changed, so did where their cursors are on our screen
  }

  /**
   * The user's cursor (or highlighted range) is now here. Call it for what the user did, not
   * for moves the session reported through onRemoteChange: those are already accounted for,
   * and a call that changes nothing is ignored.
   */
  setSelection(selection: Selection): void {
    if (this.selection?.start === selection.start && this.selection.end === selection.end) return;
    this.selection = selection;
    this.cursorDirty = true;
    this.flushCursor();
  }

  /**
   * Tells the server where our cursor is, if it hasn't been told. Only possible while we have
   * no unacknowledged edits: then our text is exactly the server's text at the revision we
   * have processed, so the position means the same thing to the server. Otherwise this waits
   * and is called again when the last edit is acknowledged.
   */
  private flushCursor(): void {
    const socket = this.socket;
    if (!this.cursorDirty || !this.selection || !this.sync || !socket) return;
    if (!this.joined || socket.readyState !== SOCKET_OPEN || this.sync.state !== "synchronized") return;

    // If the clock was set back since the last message, `sinceLast` is negative: treat that as
    // "long ago" instead of waiting for the clock to catch up.
    const sinceLast = Date.now() - this.lastCursorSent;
    const wait = sinceLast >= 0 ? this.cursorIntervalMs - sinceLast : 0;
    if (wait > 0) {
      this.cursorTimer ??= setTimeout(() => {
        this.cursorTimer = null;
        this.flushCursor();
      }, wait);
      return;
    }
    const message: ClientMessage = {
      type: "cursor",
      baseRevision: this.sync.processedRevision,
      ...this.selection,
    };
    socket.send(JSON.stringify(message));
    this.cursorDirty = false;
    this.lastCursorSent = Date.now();
  }

  /** The other users' cursors have moved or our pending edits changed: report where to draw them. */
  private notifyPeers(): void {
    const sync = this.sync;
    this.options.listener.onPeersChange?.(
      [...this.peers].map(([peer, { start, end }]) => ({
        peer,
        start: sync ? sync.rebasePosition(start) : start,
        end: sync ? sync.rebasePosition(end) : end,
      })),
    );
  }

  /** The server's text changed by `op`: move every cursor we track past it, as the server did. */
  private movePeers(op: Operation): void {
    for (const [peer, selection] of this.peers) this.peers.set(peer, transformSelection(selection, op));
  }

  private clearPeers(): void {
    if (this.peers.size === 0) return;
    this.peers.clear();
    this.notifyPeers();
  }

  private clearCursorTimer(): void {
    if (this.cursorTimer !== null) clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
  }

  private connect(): void {
    this.timer = null;
    this.setStatus(this.sync ? "reconnecting" : "connecting");

    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    this.joined = false;

    // A connection attempt that never finishes (the network is gone but the browser hasn't
    // noticed) must not leave us waiting forever.
    this.deadlineTimer = setTimeout(() => this.connectionDied(socket), this.timeoutMs);

    // Every handler ignores sockets we've already moved on from.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.heardFrom(socket); // it opened, so the connection works
      const join: ClientMessage = {
        type: "join",
        docId: this.options.docId,
        clientId: this.options.clientId,
      };
      if (this.sync) join.lastRevision = this.sync.processedRevision;
      socket.send(JSON.stringify(join));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.heardFrom(socket);
      this.handleMessage(socket, event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.joined = false;
      this.clearLiveness();
      this.handleClose(event.code);
    };
  }

  /**
   * Browsers hide WebSocket-level pings from pages, so we keep our own: whenever the
   * connection has been quiet for `heartbeatMs` we send a ping, and if nothing at all comes
   * back within `timeoutMs` we treat the connection as dead. Any message counts as proof of
   * life, so a busy connection never needs to ping.
   */
  private heardFrom(socket: SocketLike): void {
    this.clearLiveness();
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (this.socket !== socket || socket.readyState !== SOCKET_OPEN) return;
      const ping: ClientMessage = { type: "ping" };
      socket.send(JSON.stringify(ping));
      this.deadlineTimer = setTimeout(() => this.connectionDied(socket), this.timeoutMs);
    }, this.heartbeatMs);
  }

  /** No answer in time. Waiting for the browser to notice could take minutes, so give up on this socket now. */
  private connectionDied(socket: SocketLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.joined = false;
    this.clearLiveness();
    socket.onopen = socket.onmessage = socket.onclose = null; // whatever it says from now on is ignored
    socket.close();
    this.handleClose(1006); // 1006 is what a browser reports for a connection that was lost
  }

  private clearLiveness(): void {
    if (this.heartbeatTimer !== null) clearTimeout(this.heartbeatTimer);
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.heartbeatTimer = this.deadlineTimer = null;
  }

  private handleMessage(socket: SocketLike, raw: unknown): void {
    if (typeof raw !== "string") return;
    const message = parseServerMessage(raw);
    if (!message) return;

    try {
      if (message.type === "snapshot") {
        // The whole text from the server. On a first visit that's what we want. If we
        // were reconnecting, the server couldn't catch us up, so what we typed offline is lost.
        this.sync = new ClientSync(message.revision);
        this.current = message.text;
        this.selection = null; // positions in the old text mean nothing in the new one
        this.cursorDirty = false;
        this.peers.clear(); // the server sends the current ones right after
        this.markJoined();
        this.options.listener.onRemoteChange(message.text, []);
        this.notifyPeers();
      } else if (message.type === "catchup") {
        if (!this.sync) throw new Error("Got a catchup without having a document");
        const { toApply, resend } = this.sync.reconnect(message.operations);
        if (this.sync.processedRevision !== message.revision) {
          throw new Error("The catchup doesn't end at the revision the server says");
        }
        for (const op of toApply) {
          this.current = applyOperation(this.current, op);
          if (this.selection) this.selection = transformSelection(this.selection, op);
        }
        this.cursorDirty = this.selection !== null; // the server forgot our cursor with the old connection
        this.peers.clear(); // the server sends the current ones right after
        this.markJoined();
        if (resend) this.sendEdit(resend);
        this.options.listener.onRemoteChange(this.current, toApply);
        this.notifyPeers();
        this.flushCursor();
      } else if (message.type === "pong") {
        // Nothing to do: heardFrom already counted it as proof of life.
      } else if (message.type === "ack") {
        if (!this.sync) throw new Error("Got an ack without having a document");
        const acknowledged = this.sync.inflightOperation; // as the server applied it
        const next = this.sync.serverAck();
        if (acknowledged) this.movePeers(acknowledged);
        if (next) this.sendEdit(next);
        else this.flushCursor(); // synchronized again: now our cursor can be reported
        this.notifyPeers();
      } else if (message.type === "peers") {
        for (const { peer, start, end } of message.peers) this.peers.set(peer, { start, end });
        this.notifyPeers();
      } else if (message.type === "cursor") {
        this.peers.set(message.peer, { start: message.start, end: message.end });
        this.notifyPeers();
      } else if (message.type === "peerLeft") {
        this.peers.delete(message.peer);
        this.notifyPeers();
      } else {
        if (!this.sync) throw new Error("Got an edit without having a document");
        this.movePeers(message.op);
        const toApply = this.sync.applyRemote(message.op);
        this.current = applyOperation(this.current, toApply);
        if (this.selection) this.selection = transformSelection(this.selection, toApply);
        this.options.listener.onRemoteChange(this.current, [toApply]);
        this.notifyPeers();
      }
    } catch (error) {
      // We and the server disagree about something we can't repair. Throw our copy away and
      // start over from a fresh snapshot: reconnecting without a revision asks for one.
      console.warn("Out of step with the server, starting over:", (error as Error).message);
      this.sync = null;
      socket.close();
    }
  }

  private handleClose(code: number): void {
    if (this.stopped) return;
    this.clearCursorTimer();
    this.clearPeers(); // we can't keep them up to date from here
    if (code === CLOSE_POLICY_VIOLATION || code === CLOSE_MESSAGE_TOO_BIG) {
      // The server refused an edit of ours. Retrying with the same state would repeat it forever.
      this.setStatus("outOfSync");
    } else {
      this.setStatus(this.sync ? "reconnecting" : "connecting");
      this.timer = setTimeout(() => this.connect(), backoffDelay(this.attempt++, this.random));
    }
  }

  private markJoined(): void {
    this.joined = true;
    this.attempt = 0; // only a join the server answered counts as success, not a bare connection
    this.setStatus("ready");
  }

  private sendEdit(outgoing: Outgoing): void {
    const socket = this.socket;
    if (!socket || !this.joined || socket.readyState !== SOCKET_OPEN) return; // it will be resent on reconnect
    const message: ClientMessage = { type: "edit", ...outgoing };
    socket.send(JSON.stringify(message));
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.options.listener.onStatus(status);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

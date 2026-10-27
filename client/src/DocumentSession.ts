import {
  applyOperation,
  ClientSync,
  diffToOperation,
  parseServerMessage,
  type ClientMessage,
  type Operation,
  type Outgoing,
} from "@collab/shared";
import { backoffDelay } from "./backoff";

/**
 * - connecting:   no document yet (first visit, or the server made us start over)
 * - ready:        connected and in step with the server
 * - reconnecting: the connection dropped; we keep the document, accept typing, and retry
 * - replaced:     the server closed this connection because this tab connected again (final)
 * - outOfSync:    the server rejected one of our edits; the page needs a reload (final)
 */
export type ConnectionStatus = "connecting" | "ready" | "reconnecting" | "replaced" | "outOfSync";

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
}

export const DEFAULT_HEARTBEAT_MS = 10_000;
export const DEFAULT_TIMEOUT_MS = 5_000;

const SOCKET_OPEN = 1;

// Close codes the server uses (see server.ts) that mean "reconnecting won't help".
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_REPLACED = 4001;

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

  private readonly createSocket: (url: string) => SocketLike;
  private readonly random: () => number;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: SessionOptions) {
    // A browser WebSocket has the same shape; the cast only smooths over its event types.
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = options.random ?? Math.random;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    const outgoing = this.sync.applyLocal(op);
    if (outgoing) this.sendEdit(outgoing);
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
        this.markJoined();
        this.options.listener.onRemoteChange(message.text, []);
      } else if (message.type === "catchup") {
        if (!this.sync) throw new Error("Got a catchup without having a document");
        const { toApply, resend } = this.sync.reconnect(message.operations);
        if (this.sync.processedRevision !== message.revision) {
          throw new Error("The catchup doesn't end at the revision the server says");
        }
        for (const op of toApply) this.current = applyOperation(this.current, op);
        this.markJoined();
        if (resend) this.sendEdit(resend);
        this.options.listener.onRemoteChange(this.current, toApply);
      } else if (message.type === "pong") {
        // Nothing to do: heardFrom already counted it as proof of life.
      } else if (message.type === "ack") {
        if (!this.sync) throw new Error("Got an ack without having a document");
        const next = this.sync.serverAck();
        if (next) this.sendEdit(next);
      } else {
        if (!this.sync) throw new Error("Got an edit without having a document");
        const toApply = this.sync.applyRemote(message.op);
        this.current = applyOperation(this.current, toApply);
        this.options.listener.onRemoteChange(this.current, [toApply]);
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
    if (code === CLOSE_POLICY_VIOLATION) {
      // The server refused an edit of ours. Retrying with the same state could repeat it forever.
      this.setStatus("outOfSync");
    } else if (code === CLOSE_REPLACED) {
      this.setStatus("replaced");
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

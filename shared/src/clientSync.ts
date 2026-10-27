import { compose } from "./compose";
import type { Operation } from "./operation";
import { transform } from "./transform";

/** An operation the client must send to the server, tagged with the revision it was made at. */
export interface Outgoing {
  baseRevision: number;
  op: Operation;
}

export type SyncState = "synchronized" | "awaiting" | "awaitingWithBuffer";

/** An operation the server saved while we were disconnected. `own` marks the ones that came from us. */
export interface MissedOperation {
  op: Operation;
  own: boolean;
}

export interface Reconnected {
  /** Remote operations to apply to the local text, in this order. */
  toApply: Operation[];
  /** The operation to send again, if the server never saw it. */
  resend: Outgoing | null;
}

/**
 * The client's half of OT. It keeps the server and the local document in step
 * while the user keeps typing and the network takes its time.
 *
 * Only ONE operation is ever in flight at a time. Anything typed meanwhile is
 * composed into a single `buffer` operation and sent when the server acknowledges
 * the in-flight one. That keeps the server's view of this client simple.
 *
 * `revision` counts the server operations (acks and remote edits) we have processed,
 * so it always matches a revision the server really had.
 *
 * This class never touches the network or the DOM: it is told what happened and
 * answers with what to send and what to apply to the local text.
 */
export class ClientSync {
  private revision: number;
  private inflight: Operation | null = null; // sent, not yet acknowledged
  private buffer: Operation | null = null; // typed since `inflight` was sent

  constructor(revision: number) {
    this.revision = revision;
  }

  /** How many server operations we have processed. A reconnecting tab tells the server this. */
  get processedRevision(): number {
    return this.revision;
  }

  get state(): SyncState {
    if (this.inflight === null) return "synchronized";
    return this.buffer === null ? "awaiting" : "awaitingWithBuffer";
  }

  /**
   * The user edited the local document. The operation must be made against the
   * CURRENT local text (including edits still waiting). Returns what to send now,
   * or null if it has to wait behind the one already in flight.
   */
  applyLocal(op: Operation): Outgoing | null {
    if (this.inflight === null) {
      this.inflight = op;
      return { baseRevision: this.revision, op };
    }
    this.buffer = this.buffer === null ? op : compose(this.buffer, op);
    return null;
  }

  /**
   * The server accepted our in-flight operation. Returns the buffered operation
   * to send next, if there is one.
   */
  serverAck(): Outgoing | null {
    if (this.inflight === null) throw new Error("Received an ack with nothing in flight");
    this.revision++;
    if (this.buffer === null) {
      this.inflight = null;
      return null;
    }
    this.inflight = this.buffer;
    this.buffer = null;
    return { baseRevision: this.revision, op: this.inflight };
  }

  /**
   * Another user's operation arrived from the server. It applies to the server's
   * document, which doesn't have our unacknowledged edits, so we:
   *   1. rewrite it so it fits our local text (this is what the caller must apply), and
   *   2. rewrite our own pending operations so they still fit after it.
   * Our operations are passed to transform first, matching the server's tie-break.
   */
  applyRemote(op: Operation): Operation {
    this.revision++;
    let incoming = op;

    if (this.inflight !== null) {
      const [inflightPrime, incomingPrime] = transform(this.inflight, incoming);
      this.inflight = inflightPrime;
      incoming = incomingPrime;
    }
    if (this.buffer !== null) {
      const [bufferPrime, incomingPrime] = transform(this.buffer, incoming);
      this.buffer = bufferPrime;
      incoming = incomingPrime;
    }
    return incoming;
  }

  /**
   * We lost the connection and got it back. `missed` is everything the server saved after
   * the last revision we processed, in order. Nothing needs to happen when the connection
   * drops: our pending operations are still valid, we just don't know whether the server
   * got the in-flight one. The missed list tells us:
   *   - an `own` entry is our in-flight operation after all: treat it as acknowledged;
   *   - the others are other people's edits, handled exactly like live remote edits.
   * Whatever is still in flight afterwards was never saved, so it is sent again, tagged
   * with the revision we have now caught up to. Anything typed while offline stays in the
   * buffer and goes out after that one is acknowledged, as usual.
   */
  reconnect(missed: MissedOperation[]): Reconnected {
    const toApply: Operation[] = [];
    for (const { op, own } of missed) {
      if (own) {
        if (this.inflight === null) throw new Error("The server has an operation of ours that we never sent");
        this.serverAck(); // a buffer promoted to in-flight is sent below, not here
      } else {
        toApply.push(this.applyRemote(op));
      }
    }
    const resend = this.inflight === null ? null : { baseRevision: this.revision, op: this.inflight };
    return { toApply, resend };
  }
}

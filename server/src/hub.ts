import type { ClientMessage, ServerMessage } from "@collab/shared";
import { DocumentRegistry, RoomFailedError } from "./DocumentRegistry";
import type { DocumentStore } from "./DocumentStore";

// WebSocket close codes: 1008 = the client broke the rules, 1011 = the server had a problem.
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_INTERNAL_ERROR = 1011;
// An application-defined code (4000-4999 are ours to use): the same tab connected again, so
// this older connection was dropped. Browsers just reconnect: clientIds are unique per page
// load, so what replaced them can only be an older connection of their own.
export const CLOSE_REPLACED = 4001;

/** What the hub needs from a client's connection. A WebSocket in production, a fake in tests. */
export interface Connection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

/**
 * The server's behaviour, without any networking: what to do with each message a client
 * sends, and what to send back. server.ts connects it to real WebSockets; the simulation
 * tests connect it to a made-up network, so they exercise exactly this code.
 *
 * Messages from one connection must be passed to handle() one at a time, in order.
 */
export class Hub {
  readonly registry: DocumentRegistry<Connection>;

  constructor(store: DocumentStore, options: { snapshotEvery?: number } = {}) {
    this.registry = new DocumentRegistry<Connection>(store, {
      snapshotEvery: options.snapshotEvery,
      onClientReplaced(client) {
        client.close(CLOSE_REPLACED, "Replaced by a newer connection");
      },
      onPeerLeft(recipients, peer) {
        for (const client of recipients) client.send({ type: "peerLeft", peer });
      },
      onRoomFailed(clients, error) {
        console.error(error.message);
        // Their view of the document can no longer be trusted. Disconnect them so they
        // reconnect and start again from what the store really holds.
        for (const client of clients) client.close(CLOSE_INTERNAL_ERROR, "Storage failure");
      },
    });
  }

  /** The answer to a ping. Separate from handle() because it must not wait behind a slow save. */
  ping(connection: Connection): void {
    connection.send({ type: "pong" });
  }

  /** The connection is gone (or about to be closed). */
  leave(connection: Connection): void {
    this.registry.leave(connection);
  }

  async handle(connection: Connection, message: Exclude<ClientMessage, { type: "ping" }>): Promise<void> {
    const { registry } = this;

    if (message.type === "join") {
      try {
        const joined = await registry.join(message.docId, connection, {
          clientId: message.clientId,
          lastRevision: message.lastRevision,
        });
        if (!joined) return;
        if (joined.missed) {
          connection.send({ type: "catchup", operations: joined.missed, revision: joined.revision });
        } else {
          connection.send({ type: "snapshot", text: joined.text, revision: joined.revision });
        }
        if (joined.peers) connection.send({ type: "peers", peers: joined.peers });
      } catch (error) {
        console.error("Could not load document:", (error as Error).message);
        connection.close(CLOSE_INTERNAL_ERROR, "Could not load document");
      }
      return;
    }

    if (message.type === "cursor") {
      try {
        const moved = await registry.applyCursor(connection, message.baseRevision, {
          start: message.start,
          end: message.end,
        });
        if (!moved) return;
        for (const other of moved.recipients) {
          other.send({ type: "cursor", peer: moved.peer, ...moved.selection });
        }
      } catch (error) {
        console.warn("Ignored cursor:", (error as Error).message); // e.g. not joined yet
      }
      return;
    }

    try {
      const { op, recipients } = await registry.applyEdit(connection, message.baseRevision, message.op);
      connection.send({ type: "ack" });
      for (const other of recipients) other.send({ type: "edit", op });
    } catch (error) {
      if (error instanceof RoomFailedError) return; // onRoomFailed already disconnected everyone
      // An edit we can't make sense of means this client is out of step with the
      // server. Dropping it silently would leave the client waiting for an ack forever,
      // so cut the connection; the client can reconnect and get a fresh snapshot.
      console.warn("Rejected edit:", (error as Error).message);
      registry.leave(connection);
      connection.close(CLOSE_POLICY_VIOLATION, "Invalid edit");
    }
  }

  flushSnapshots(): Promise<void> {
    return this.registry.flushSnapshots();
  }
}

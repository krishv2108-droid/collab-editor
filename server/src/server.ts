import { WebSocket, WebSocketServer } from "ws";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@collab/shared";
import { DocumentRegistry, RoomFailedError } from "./DocumentRegistry";
import type { DocumentStore } from "./DocumentStore";

const MAX_MESSAGE_BYTES = 1024 * 1024;

// WebSocket close codes: 1008 = the client broke the rules, 1011 = the server had a problem.
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;
// An application-defined code (4000-4999 are ours to use): the same tab connected again, so
// this older connection was dropped. A client that sees it must not reconnect.
const CLOSE_REPLACED = 4001;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export interface CollabServer {
  port: number;
  close(): Promise<void>;
}

/**
 * Starts the WebSocket server, keeping documents in `store`. Pass port 0 to let the OS
 * pick a free port. The caller owns the store and closes it after the server.
 */
export function createCollabServer(
  port: number,
  store: DocumentStore,
  options: { snapshotEvery?: number } = {},
): Promise<CollabServer> {
  const wss = new WebSocketServer({ port, maxPayload: MAX_MESSAGE_BYTES });
  const registry = new DocumentRegistry<WebSocket>(store, {
    snapshotEvery: options.snapshotEvery,
    onClientReplaced(client) {
      client.close(CLOSE_REPLACED, "Replaced by a newer connection");
    },
    onRoomFailed(clients, error) {
      console.error(error.message);
      // Their view of the document can no longer be trusted. Disconnect them so they
      // reconnect and start again from what the store really holds.
      for (const client of clients) client.close(CLOSE_INTERNAL_ERROR, "Storage failure");
    },
  });

  async function handleMessage(socket: WebSocket, message: ClientMessage): Promise<void> {
    if (message.type === "join") {
      try {
        const joined = await registry.join(message.docId, socket, {
          clientId: message.clientId,
          lastRevision: message.lastRevision,
        });
        if (!joined) return;
        if (joined.missed) {
          send(socket, { type: "catchup", operations: joined.missed, revision: joined.revision });
        } else {
          send(socket, { type: "snapshot", text: joined.text, revision: joined.revision });
        }
      } catch (error) {
        console.error("Could not load document:", (error as Error).message);
        socket.close(CLOSE_INTERNAL_ERROR, "Could not load document");
      }
      return;
    }

    try {
      const { op, recipients } = await registry.applyEdit(socket, message.baseRevision, message.op);
      send(socket, { type: "ack" });
      for (const other of recipients) send(other, { type: "edit", op });
    } catch (error) {
      if (error instanceof RoomFailedError) return; // onRoomFailed already disconnected everyone
      // An edit we can't make sense of means this client is out of step with the
      // server. Dropping it silently would leave the client waiting for an ack forever,
      // so cut the connection; the client can reconnect and get a fresh snapshot.
      console.warn("Rejected edit:", (error as Error).message);
      registry.leave(socket);
      socket.close(CLOSE_POLICY_VIOLATION, "Invalid edit");
    }
  }

  wss.on("connection", (socket) => {
    // Handling a message now takes time (loading, saving), so messages from one client are
    // processed one after another. Edits must be applied in the order the client made them.
    let pending: Promise<void> = Promise.resolve();

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = parseClientMessage(data.toString());
      if (!message) return;
      pending = pending
        .then(() => handleMessage(socket, message))
        .catch((error) => console.error("Unexpected error handling a message:", error));
    });
    socket.on("close", () => registry.leave(socket));
    socket.on("error", (error) => console.warn("Socket error:", error.message));
  });

  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const address = wss.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("Unexpected server address"));
        return;
      }
      resolve({
        port: address.port,
        close: async () => {
          for (const client of wss.clients) client.terminate();
          await new Promise<void>((done) => wss.close(() => done()));
          await registry.flushSnapshots(); // let any snapshot being saved finish before the store closes
        },
      });
    });
  });
}

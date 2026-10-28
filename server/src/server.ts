import { WebSocket, WebSocketServer } from "ws";
import { isMalformedRequest, parseClientMessage, type ServerMessage } from "@collab/shared";
import type { DocumentStore } from "./DocumentStore";
import { CLOSE_POLICY_VIOLATION, Hub, type Connection } from "./hub";

const MAX_MESSAGE_BYTES = 1024 * 1024;

/** How often to check that every connection is still alive. */
export const DEFAULT_HEARTBEAT_MS = 30_000;

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
  options: { snapshotEvery?: number; heartbeatMs?: number } = {},
): Promise<CollabServer> {
  const wss = new WebSocketServer({ port, maxPayload: MAX_MESSAGE_BYTES });
  const hub = new Hub(store, { snapshotEvery: options.snapshotEvery });

  // Connections that went silent (laptop closed, Wi-Fi gone) never tell us they are gone;
  // TCP can take many minutes to notice. So every `heartbeatMs` we ask each connection to
  // answer, and drop the ones that haven't said anything since the previous round. Dropping
  // is what frees the document's memory and ends that tab's place in the room.
  const heardSinceLastRound = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!heardSinceLastRound.has(socket)) {
        socket.terminate();
        continue;
      }
      heardSinceLastRound.delete(socket);
      socket.ping(); // browsers answer automatically
    }
  }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  wss.on("connection", (socket) => {
    const connection: Connection = {
      send: (message) => send(socket, message),
      close: (code, reason) => socket.close(code, reason),
    };
    heardSinceLastRound.add(socket);
    socket.on("pong", () => heardSinceLastRound.add(socket));

    // Handling a message now takes time (loading, saving), so messages from one client are
    // processed one after another. Edits must be applied in the order the client made them.
    let pending: Promise<void> = Promise.resolve();

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      const message = parseClientMessage(raw);
      if (!message) {
        // Garbage is ignored. A join or edit that is broken is not: ignoring it would leave
        // the client waiting for an answer that never comes, with its typing going nowhere.
        if (isMalformedRequest(raw)) socket.close(CLOSE_POLICY_VIOLATION, "Invalid message");
        return;
      }
      heardSinceLastRound.add(socket); // any message proves the connection is alive
      if (message.type === "ping") {
        // Answered at once, not queued behind a slow save: a pong only has to prove
        // that the connection works.
        hub.ping(connection);
        return;
      }
      pending = pending
        .then(() => hub.handle(connection, message))
        .catch((error) => console.error("Unexpected error handling a message:", error));
    });
    socket.on("close", () => hub.leave(connection));
    socket.on("error", (error) => console.warn("Socket error:", error.message));
  });

  return new Promise((resolve, reject) => {
    wss.once("error", (error) => {
      clearInterval(heartbeat); // we never started, so nothing will call close()
      reject(error);
    });
    wss.once("listening", () => {
      const address = wss.address();
      if (typeof address === "string" || address === null) {
        reject(new Error("Unexpected server address"));
        return;
      }
      // From here on an error is no longer "could not start", but it must not crash the process.
      wss.on("error", (error) => console.error("WebSocket server error:", error.message));
      resolve({
        port: address.port,
        close: async () => {
          clearInterval(heartbeat);
          for (const client of wss.clients) client.terminate();
          await new Promise<void>((done) => wss.close(() => done()));
          await hub.flushSnapshots(); // let any snapshot being saved finish before the store closes
        },
      });
    });
  });
}

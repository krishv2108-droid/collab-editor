import { WebSocket, WebSocketServer } from "ws";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@collab/shared";
import { DocumentRegistry } from "./DocumentRegistry";

const MAX_MESSAGE_BYTES = 1024 * 1024;

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

export interface CollabServer {
  port: number;
  close(): Promise<void>;
}

/** Starts the WebSocket server. Pass port 0 to let the OS pick a free port. */
export function createCollabServer(port: number): Promise<CollabServer> {
  const registry = new DocumentRegistry<WebSocket>();
  const wss = new WebSocketServer({ port, maxPayload: MAX_MESSAGE_BYTES });

  function handleMessage(socket: WebSocket, message: ClientMessage): void {
    if (message.type === "join") {
      const { text, revision } = registry.join(message.docId, socket);
      send(socket, { type: "snapshot", text, revision });
      return;
    }

    try {
      const { op, recipients } = registry.applyEdit(socket, message.baseRevision, message.op);
      send(socket, { type: "ack" });
      for (const other of recipients) send(other, { type: "edit", op });
    } catch (error) {
      // An edit we can't make sense of means this client is out of step with the
      // server. Dropping it silently would leave the client waiting for an ack forever,
      // so cut the connection; the client can reconnect and get a fresh snapshot.
      console.warn("Rejected edit:", (error as Error).message);
      registry.leave(socket);
      socket.close(1008, "Invalid edit");
    }
  }

  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = parseClientMessage(data.toString());
      if (message) handleMessage(socket, message);
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
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => done());
          }),
      });
    });
  });
}

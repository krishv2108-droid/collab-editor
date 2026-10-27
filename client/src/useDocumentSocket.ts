import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseServerMessage,
  type ClientMessage,
  type Operation,
  type Outgoing,
} from "@collab/shared";

export type ConnectionStatus = "connecting" | "ready" | "disconnected";

interface Handlers {
  /** The document as the server has it. Arrives once, right after joining. */
  onSnapshot(text: string, revision: number): void;
  /** The server accepted the edit we had in flight. */
  onAck(): void;
  /** Another user's edit. */
  onRemoteEdit(op: Operation): void;
}

const SERVER_URL =
  import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8080`;

/**
 * Opens a WebSocket for `docId`, joins the document, and reports what the
 * server sends. "ready" means the snapshot has arrived and editing is safe.
 * Knows nothing about OT itself: it just carries messages.
 */
export function useDocumentSocket(docId: string, handlers: Handlers) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const socketRef = useRef<WebSocket | null>(null);

  // Always call the newest handlers without reconnecting when they change.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    setStatus("connecting");
    const socket = new WebSocket(SERVER_URL);
    socketRef.current = socket;

    socket.onopen = () => {
      const join: ClientMessage = { type: "join", docId };
      socket.send(JSON.stringify(join));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === "snapshot") {
        handlersRef.current.onSnapshot(message.text, message.revision);
        setStatus("ready");
      } else if (message.type === "ack") {
        handlersRef.current.onAck();
      } else if (message.type === "edit") {
        handlersRef.current.onRemoteEdit(message.op);
      }
      // "catchup" is only sent to tabs that ask for it by rejoining with a lastRevision,
      // which this client doesn't do yet (reconnect step 4).
    };
    socket.onclose = () => setStatus("disconnected");

    return () => {
      socket.onclose = null;
      socket.close();
      socketRef.current = null;
    };
  }, [docId]);

  const sendEdit = useCallback((outgoing: Outgoing) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      const message: ClientMessage = { type: "edit", ...outgoing };
      socket.send(JSON.stringify(message));
    }
  }, []);

  return { status, sendEdit };
}

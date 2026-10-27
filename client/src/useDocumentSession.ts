import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentSession, type ConnectionStatus, type SessionListener } from "./DocumentSession";

const SERVER_URL =
  import.meta.env.VITE_WS_URL ?? `ws://${window.location.hostname}:8080`;

/** A random id for this tab. crypto.randomUUID only exists on secure pages (https or localhost). */
function newClientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Connects this component to a document for as long as it is mounted. All the real work
 * (OT, reconnecting) is in DocumentSession; this only ties it to React.
 */
export function useDocumentSession(docId: string, listener: Pick<SessionListener, "onRemoteChange">) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const sessionRef = useRef<DocumentSession | null>(null);

  // Always call the newest callback without reconnecting when it changes.
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  useEffect(() => {
    setStatus("connecting");
    const session = new DocumentSession({
      url: SERVER_URL,
      docId,
      clientId: newClientId(),
      listener: {
        onStatus: setStatus,
        onRemoteChange: (text, operations) => listenerRef.current.onRemoteChange(text, operations),
      },
    });
    sessionRef.current = session;
    session.start();

    // When the browser says the network is back, don't wait out the rest of the pause.
    const retry = () => session.retryNow();
    window.addEventListener("online", retry);

    return () => {
      window.removeEventListener("online", retry);
      session.stop();
      sessionRef.current = null;
    };
  }, [docId]);

  /** The user changed the text to `text`. */
  const edit = useCallback((text: string) => sessionRef.current?.edit(text), []);

  return { status, edit };
}

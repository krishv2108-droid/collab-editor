import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import { transformPosition } from "@collab/shared";
import type { ConnectionStatus } from "./DocumentSession";
import { useDocumentSession } from "./useDocumentSession";

interface Selection {
  start: number;
  end: number;
}

// What to tell the user about the connection. "ready" says nothing: no news is good news.
const STATUS_MESSAGES: Record<ConnectionStatus, string | null> = {
  connecting: "Connecting…",
  ready: null,
  reconnecting: "Connection lost. Reconnecting… keep typing, your changes are kept and will sync.",
  replaced: "This document was opened again from this tab, so this connection was closed. Reload the page.",
  outOfSync: "This page got out of sync with the server. Reload the page.",
};

export function Editor({ docId }: { docId: string }) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the cursor should go after the next render (set by remote edits).
  const pendingSelection = useRef<Selection | null>(null);

  const { status, edit } = useDocumentSession(docId, {
    onRemoteChange(newText, operations) {
      // The server's changes don't know where the user's cursor is; move it along with them.
      const textarea = textareaRef.current;
      if (textarea && operations.length > 0 && document.activeElement === textarea) {
        let { selectionStart: start, selectionEnd: end } = textarea;
        for (const op of operations) {
          start = transformPosition(start, op);
          end = transformPosition(end, op);
        }
        pendingSelection.current = { start, end };
      }
      setText(newText);
    },
  });

  // Setting a textarea's value from code throws its cursor to the end, so we
  // put it back right after React updates the DOM, before the browser paints.
  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const textarea = textareaRef.current;
    if (selection && textarea) {
      textarea.setSelectionRange(selection.start, selection.end);
    }
    pendingSelection.current = null;
  }, [text]);

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setText(event.target.value);
    edit(event.target.value);
  }

  // Typing is fine whenever we hold a document, including while the connection is down.
  const editable = status === "ready" || status === "reconnecting";
  const message = STATUS_MESSAGES[status];

  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.25rem" }}>
        Document <code>{docId}</code> <small>({status})</small>
      </h1>
      {message && (
        <p
          role="status"
          style={{
            margin: "0 0 0.75rem",
            padding: "0.5rem 0.75rem",
            borderRadius: 4,
            background: status === "reconnecting" || status === "connecting" ? "#fff4d6" : "#fde0e0",
          }}
        >
          {message}
        </p>
      )}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        disabled={!editable}
        rows={16}
        style={{ width: "100%", fontSize: "1rem", padding: "0.75rem", boxSizing: "border-box" }}
        placeholder={editable ? "Start typing…" : "Connecting…"}
      />
    </div>
  );
}

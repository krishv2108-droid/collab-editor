import { useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties, type SyntheticEvent } from "react";
import { transformPosition, type PeerCursor } from "@collab/shared";
import type { ConnectionStatus } from "./DocumentSession";
import { PeerCursors } from "./PeerCursors";
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
  outOfSync: "This page got out of sync with the server. Reload the page.",
};

// The textarea and the copy of its text that carries other users' cursors must look identical.
const FIELD_STYLE: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  margin: 0,
  padding: "0.75rem",
  border: "1px solid #bbb",
  borderRadius: 4,
  font: "16px/1.5 ui-monospace, Menlo, Consolas, monospace",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  overflowY: "scroll",
};

export function Editor({ docId }: { docId: string }) {
  const [text, setText] = useState("");
  const [peers, setPeers] = useState<PeerCursor[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the cursor should go after the next render (set by remote edits).
  const pendingSelection = useRef<Selection | null>(null);

  const { status, edit, setSelection } = useDocumentSession(docId, {
    onPeersChange: setPeers,
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
    const { value, selectionStart, selectionEnd } = event.target;
    setText(value);
    edit(value);
    setSelection({ start: selectionStart, end: selectionEnd });
  }

  // Fires when the user moves the cursor or changes the highlight. (Moves we make ourselves,
  // to follow other people's edits, land on what the session already expects and are ignored.)
  function handleSelect(event: SyntheticEvent<HTMLTextAreaElement>) {
    const { selectionStart, selectionEnd } = event.currentTarget;
    setSelection({ start: selectionStart, end: selectionEnd });
  }

  // Typing is fine whenever we hold a document, including while the connection is down.
  const editable = status === "ready" || status === "reconnecting";
  const message = STATUS_MESSAGES[status];

  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.25rem" }}>Collab Editor</h1>
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
      <div style={{ position: "relative", background: "white" }}>
        <PeerCursors text={text} peers={peers} scrollTop={scrollTop} fieldStyle={FIELD_STYLE} />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onSelect={handleSelect}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          disabled={!editable}
          rows={16}
          style={{ ...FIELD_STYLE, display: "block", position: "relative", background: "transparent", resize: "none" }}
          placeholder={editable ? "Start typing…" : "Connecting…"}
        />
      </div>
    </div>
  );
}

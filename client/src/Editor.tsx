import { useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import {
  applyOperation,
  ClientSync,
  diffToOperation,
  transformPosition,
  type Operation,
} from "@collab/shared";
import { useDocumentSocket } from "./useDocumentSocket";

interface Selection {
  start: number;
  end: number;
}

export function Editor({ docId }: { docId: string }) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The latest text, readable synchronously. Socket callbacks use this instead
  // of `text` so they never see a stale value.
  const textRef = useRef("");
  // The OT state machine; created when the snapshot arrives.
  const syncRef = useRef<ClientSync | null>(null);
  // Where the cursor should go after the next render (set by remote edits).
  const pendingSelection = useRef<Selection | null>(null);

  const { status, sendEdit } = useDocumentSocket(docId, {
    onSnapshot(snapshot, revision) {
      syncRef.current = new ClientSync(revision);
      textRef.current = snapshot;
      setText(snapshot);
    },
    onAck() {
      const next = syncRef.current?.serverAck();
      if (next) sendEdit(next);
    },
    onRemoteEdit(op: Operation) {
      const sync = syncRef.current;
      if (!sync) return;
      // The server's edit doesn't know about our unacknowledged typing; this
      // rewrites it so it fits the text the user is looking at right now.
      const toApply = sync.applyRemote(op);

      const textarea = textareaRef.current;
      if (textarea && document.activeElement === textarea) {
        pendingSelection.current = {
          start: transformPosition(textarea.selectionStart, toApply),
          end: transformPosition(textarea.selectionEnd, toApply),
        };
      }
      textRef.current = applyOperation(textRef.current, toApply);
      setText(textRef.current);
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
    const next = event.target.value;
    const op = diffToOperation(textRef.current, next);
    textRef.current = next;
    setText(next);
    if (!op) return;
    const outgoing = syncRef.current?.applyLocal(op);
    if (outgoing) sendEdit(outgoing);
  }

  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.25rem" }}>
        Document <code>{docId}</code> <small>({status})</small>
      </h1>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        disabled={status !== "ready"}
        rows={16}
        style={{ width: "100%", fontSize: "1rem", padding: "0.75rem", boxSizing: "border-box" }}
        placeholder={status === "ready" ? "Start typing…" : "Connecting…"}
      />
    </div>
  );
}

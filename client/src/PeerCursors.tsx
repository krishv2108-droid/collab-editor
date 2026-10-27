import { useLayoutEffect, useRef, type CSSProperties } from "react";
import type { PeerCursor } from "@collab/shared";
import { buildPieces } from "./peerSegments";

interface Props {
  text: string;
  peers: PeerCursor[];
  /** The textarea's scroll position, so the cursors scroll with the text. */
  scrollTop: number;
  /** Must match the textarea's font, padding, border and wrapping exactly, or the cursors drift. */
  fieldStyle: CSSProperties;
}

/**
 * A textarea can only show its own caret. To show other people's, we draw a copy of the text
 * behind it (the textarea is transparent), laid out identically, with a colored bar and a
 * small name tag at each cursor and a colored background behind each selection. The copy's
 * own text is invisible; only the bars and backgrounds show through.
 */
export function PeerCursors({ text, peers, scrollTop, fieldStyle }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pieces = buildPieces(text, peers);

  // Scroll the copy to follow the textarea. (After rendering, so the copy has its full height.)
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = scrollTop;
  }, [scrollTop, text, peers]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      style={{
        ...fieldStyle,
        position: "absolute",
        inset: 0,
        color: "transparent",
        overflowY: "scroll", // same scrollbar space as the textarea, but not scrollable by hand
        pointerEvents: "none",
        borderColor: "transparent",
      }}
    >
      {pieces.map((piece, index) =>
        piece.kind === "text" ? (
          <span
            key={index}
            style={piece.highlight ? { background: `${piece.highlight}33` } : undefined} // 20% opacity: the text stays readable
            data-highlight={piece.highlight ? "true" : undefined}
          >
            {piece.text}
          </span>
        ) : (
          <span
            key={index}
            data-peer={piece.peer}
            style={{
              position: "relative",
              display: "inline-block",
              width: 0,
              height: "1.2em",
              verticalAlign: "text-bottom",
              borderLeft: `2px solid ${piece.color}`,
              marginLeft: -1,
            }}
          >
            <span
              style={{
                position: "absolute",
                left: -1,
                bottom: "100%",
                padding: "0 4px",
                borderRadius: 3,
                background: piece.color,
                color: "white",
                font: "600 10px/14px system-ui, sans-serif",
                whiteSpace: "nowrap",
              }}
            >
              {piece.label}
            </span>
          </span>
        ),
      )}
      {" " /* a trailing newline in the textarea makes a visible empty line; this does the same here */}
    </div>
  );
}

import type { PeerCursor } from "@collab/shared";

/** One thing to draw, in order: a stretch of text (maybe highlighted) or somebody's caret. */
export type Piece =
  | { kind: "text"; text: string; highlight: string | null }
  | { kind: "caret"; peer: string; color: string; label: string };

/** Colors that stay readable behind and beside black text. */
const COLORS = ["#d9480f", "#1971c2", "#2f9e44", "#9c36b5", "#c2255c", "#0b7285", "#e67700", "#5f3dc4"];

/** The same peer always gets the same color, and neighbours in the list get different ones. */
export function colorFor(peer: string): string {
  let hash = 0;
  for (const char of peer) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

export function labelFor(peer: string): string {
  return `Guest ${peer}`;
}

/**
 * Cuts `text` into the pieces needed to draw other users' cursors on top of it: a caret at
 * each peer's `end` (the whole cursor, if they haven't selected anything), and the stretch
 * each one has selected marked for highlighting. Where selections overlap the first peer in
 * the list wins. Positions outside the text are pulled to its ends, because the text a peer's
 * position was measured in and the text on screen can differ by a keystroke for a moment.
 */
export function buildPieces(text: string, peers: PeerCursor[]): Piece[] {
  const clamp = (position: number) => Math.max(0, Math.min(text.length, position));
  const cursors = peers.map((p) => ({ peer: p.peer, start: clamp(p.start), end: clamp(p.end) }));

  const boundaries = [...new Set([0, text.length, ...cursors.flatMap((c) => [c.start, c.end])])].sort(
    (a, b) => a - b,
  );

  const pieces: Piece[] = [];
  const carets = (at: number) => {
    for (const cursor of cursors) {
      if (cursor.end === at) {
        pieces.push({ kind: "caret", peer: cursor.peer, color: colorFor(cursor.peer), label: labelFor(cursor.peer) });
      }
    }
  };

  for (let i = 0; i < boundaries.length; i++) {
    const from = boundaries[i]!;
    carets(from);
    const to = boundaries[i + 1];
    if (to === undefined) break;
    const covering = cursors.find((c) => c.start < c.end && c.start <= from && to <= c.end);
    pieces.push({
      kind: "text",
      text: text.slice(from, to),
      highlight: covering ? colorFor(covering.peer) : null,
    });
  }
  return pieces;
}

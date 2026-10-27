import type { OpComponent, Operation } from "./operation";

/** How many characters a piece covers: its count, or the length of its inserted text. */
export function pieceLength(piece: OpComponent): number {
  return piece.type === "insert" ? piece.text.length : piece.count;
}

/**
 * Steps through an operation's pieces, letting us use up just part of one.
 * transform and compose both need this: they pair up pieces from two operations
 * and the pieces rarely have the same length.
 */
export class Walker {
  private index = 0;
  private readonly parts: OpComponent[];

  constructor(op: Operation) {
    // Copy the pieces: consume() shrinks them in place and must not touch the caller's op.
    this.parts = op.map((piece) => ({ ...piece }));
  }

  get head(): OpComponent | undefined {
    return this.parts[this.index];
  }

  /** Move past the current piece entirely. */
  advance(): void {
    this.index++;
  }

  /** Use up the first `count` characters of the current piece. */
  consume(count: number): void {
    const head = this.head;
    if (!head) throw new Error("Nothing left to consume");
    if (pieceLength(head) === count) {
      this.index++;
    } else if (head.type === "insert") {
      head.text = head.text.slice(count);
    } else {
      head.count -= count;
    }
  }
}

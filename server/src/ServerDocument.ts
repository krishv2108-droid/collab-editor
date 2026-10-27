import { applyOperation, transform, type Operation } from "@collab/shared";

/**
 * The server's authoritative copy of one document under OT.
 *
 * Every accepted operation gets a revision number. `history[i]` is the operation
 * that turned revision i into revision i + 1, so `revision === history.length`.
 */
export class ServerDocument {
  private currentText: string;
  private readonly history: Operation[] = [];

  constructor(initialText = "") {
    this.currentText = initialText;
  }

  get text(): string {
    return this.currentText;
  }

  get revision(): number {
    return this.history.length;
  }

  /**
   * Accepts an operation a client made while looking at revision `baseRevision`.
   *
   * If other operations were accepted since then, the client didn't know about them,
   * so we rewrite its operation against each of them in order until it fits the
   * current text. Returns the rewritten operation, which is what gets applied here
   * and broadcast to everyone else.
   *
   * Throws (and changes nothing) if the revision or operation doesn't make sense.
   */
  receive(baseRevision: number, op: Operation): Operation {
    if (!Number.isInteger(baseRevision) || baseRevision < 0 || baseRevision > this.revision) {
      throw new RangeError(
        `Unknown base revision ${baseRevision} (document is at revision ${this.revision})`,
      );
    }

    let rewritten = op;
    for (let i = baseRevision; i < this.history.length; i++) {
      // The client's operation goes first, so on a tie its insert lands to the left.
      // Clients must use the same rule (see transform's tie-break).
      [rewritten] = transform(rewritten, this.history[i]!);
    }

    const nextText = applyOperation(this.currentText, rewritten); // throws before we change anything
    this.currentText = nextText;
    this.history.push(rewritten);
    return rewritten;
  }
}

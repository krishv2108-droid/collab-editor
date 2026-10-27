import { applyOperation, transform, type Operation } from "@collab/shared";
import type { StoredDocument } from "./DocumentStore";

/** An edit that has been checked and rewritten but not yet recorded. See prepare/commit. */
export interface PreparedEdit {
  /** The revision this edit will produce once committed. */
  revision: number;
  op: Operation;
  nextText: string;
}

/**
 * The server's authoritative copy of one document under OT.
 *
 * Every accepted operation gets a revision number. `history[i]` is the operation that
 * turned revision `startRevision + i` into the next one. A document restored from a
 * snapshot starts at the snapshot's revision and doesn't remember anything older, which
 * is fine: clients always join at the current revision, so none need older history.
 */
export class ServerDocument {
  private currentText: string;
  private readonly history: Operation[] = [];
  private readonly startRevision: number;

  constructor(initialText = "", startRevision = 0) {
    this.currentText = initialText;
    this.startRevision = startRevision;
  }

  /** Rebuilds a document from what the store holds: the snapshot, then every edit after it. */
  static restore(stored: StoredDocument): ServerDocument {
    const document = new ServerDocument(stored.snapshotText, stored.snapshotRevision);
    // Stored edits were already rewritten when accepted, so each applies to the latest text.
    for (const op of stored.operations) document.receive(document.revision, op);
    return document;
  }

  get text(): string {
    return this.currentText;
  }

  get revision(): number {
    return this.startRevision + this.history.length;
  }

  /**
   * Checks an operation a client made while looking at revision `baseRevision`, and
   * rewrites it against every edit accepted since, without changing the document yet.
   * Throws (changing nothing) if the revision or operation doesn't make sense.
   *
   * Call commit() with the result to make it part of the document. The two steps are
   * separate so the edit can be saved to the database in between: it only becomes
   * real here once it is safely stored.
   */
  prepare(baseRevision: number, op: Operation): PreparedEdit {
    if (
      !Number.isInteger(baseRevision) ||
      baseRevision < this.startRevision ||
      baseRevision > this.revision
    ) {
      throw new RangeError(
        `Unknown base revision ${baseRevision} ` +
          `(document keeps revisions ${this.startRevision} to ${this.revision})`,
      );
    }

    let rewritten = op;
    for (let revision = baseRevision; revision < this.revision; revision++) {
      // The client's operation goes first, so on a tie its insert lands to the left.
      // Clients must use the same rule (see transform's tie-break).
      [rewritten] = transform(rewritten, this.history[revision - this.startRevision]!);
    }

    const nextText = applyOperation(this.currentText, rewritten); // throws if it doesn't fit
    return { revision: this.revision + 1, op: rewritten, nextText };
  }

  /** Makes a prepared edit part of the document. Must follow its prepare() with nothing in between. */
  commit(edit: PreparedEdit): void {
    if (edit.revision !== this.revision + 1) {
      throw new Error(`Stale edit: expected revision ${this.revision + 1}, got ${edit.revision}`);
    }
    this.currentText = edit.nextText;
    this.history.push(edit.op);
  }

  /** prepare() and commit() in one go, for when there is nothing to save in between. Returns the rewritten edit. */
  receive(baseRevision: number, op: Operation): Operation {
    const edit = this.prepare(baseRevision, op);
    this.commit(edit);
    return edit.op;
  }
}

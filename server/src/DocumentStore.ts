import type { Operation } from "@collab/shared";

/** Thrown when an edit isn't the next revision of its document: a duplicate, a gap, or a race. */
export class RevisionConflictError extends Error {
  constructor(
    readonly docId: string,
    readonly revision: number,
  ) {
    super(`Revision ${revision} is not the next revision of document "${docId}"`);
    this.name = "RevisionConflictError";
  }
}

/** What's stored for a document: a snapshot, plus every edit made after it. */
export interface StoredDocument {
  snapshotText: string;
  snapshotRevision: number;
  /** Edits for revisions snapshotRevision + 1, + 2, ... in order. */
  operations: Operation[];
}

/** One saved edit, with who made it. */
export interface StoredOperation {
  /** The revision this edit produced. */
  revision: number;
  op: Operation;
  /** The clientId of the tab that made it, or null if unknown (old data, or an anonymous client). */
  author: string | null;
}

/**
 * Where documents are kept between server restarts. The rest of the server only knows
 * this interface, so it can run on Postgres in production and on memory in fast tests.
 * Every implementation must pass the shared tests in documentStoreContract.ts.
 */
export interface DocumentStore {
  /** The stored document, or null if no edit to it has ever been saved. */
  load(docId: string): Promise<StoredDocument | null>;

  /**
   * Records the edit that produced `revision`. Throws RevisionConflictError (and saves
   * nothing) unless `revision` is exactly one more than the document's latest revision.
   * The first edit of a document is revision 1, and that creates the document.
   * `author` is remembered with the edit; see operationsSince.
   */
  append(docId: string, revision: number, op: Operation, author?: string): Promise<void>;

  /**
   * Every edit after `afterRevision`, in order, with its author. Empty if there are none
   * (and for a document that was never saved, when `afterRevision` is 0). Throws RangeError
   * if `afterRevision` is ahead of the document, which means the caller is out of step with it.
   */
  operationsSince(docId: string, afterRevision: number): Promise<StoredOperation[]>;

  /**
   * Stores `text` as the document's text at `revision`, so loading can skip the edits up
   * to there. The caller must make sure `text` really is the document at that revision.
   * An equal or older snapshot than the one already stored is ignored. Throws RangeError
   * if the document or that revision doesn't exist.
   */
  saveSnapshot(docId: string, revision: number, text: string): Promise<void>;
}

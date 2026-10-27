import type { Operation } from "@collab/shared";
import { RevisionConflictError, type DocumentStore, type StoredDocument } from "./DocumentStore";

interface Entry {
  snapshotText: string;
  snapshotRevision: number;
  /** Every edit ever appended: operations[i] produced revision i + 1. */
  operations: Operation[];
}

/**
 * A DocumentStore that keeps everything in a Map. Nothing survives a restart, so it's for
 * tests and for running the server without a database. It copies data on the way in and
 * out, as a real database would, so callers can't change stored data by accident.
 */
export class InMemoryStore implements DocumentStore {
  private readonly docs = new Map<string, Entry>();

  async load(docId: string): Promise<StoredDocument | null> {
    const entry = this.docs.get(docId);
    if (!entry) return null;
    return structuredClone({
      snapshotText: entry.snapshotText,
      snapshotRevision: entry.snapshotRevision,
      operations: entry.operations.slice(entry.snapshotRevision),
    });
  }

  async append(docId: string, revision: number, op: Operation): Promise<void> {
    const head = this.docs.get(docId)?.operations.length ?? 0;
    if (revision !== head + 1) throw new RevisionConflictError(docId, revision);

    let entry = this.docs.get(docId);
    if (!entry) {
      entry = { snapshotText: "", snapshotRevision: 0, operations: [] };
      this.docs.set(docId, entry);
    }
    entry.operations.push(structuredClone(op));
  }

  async saveSnapshot(docId: string, revision: number, text: string): Promise<void> {
    const entry = this.docs.get(docId);
    if (!entry || revision > entry.operations.length) {
      throw new RangeError(`Cannot snapshot "${docId}" at revision ${revision}: no such revision`);
    }
    if (revision <= entry.snapshotRevision) return;
    entry.snapshotText = text;
    entry.snapshotRevision = revision;
  }
}

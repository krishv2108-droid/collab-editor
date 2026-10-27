import type pg from "pg";
import { isOperation, type Operation } from "@collab/shared";
import { withTransaction } from "./db";
import { RevisionConflictError, type DocumentStore, type StoredDocument } from "./DocumentStore";

/**
 * Saves documents in Postgres as a snapshot plus an append-only log of operations.
 * Knows nothing about WebSockets or OT; it only stores and returns data.
 */
export class PostgresStore implements DocumentStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Returns the stored document, or null if no edit to it has ever been saved. */
  async load(docId: string): Promise<StoredDocument | null> {
    // REPEATABLE READ: both queries see the same moment in time, even if a write lands between them.
    return withTransaction(
      this.pool,
      async (client) => {
        const doc = await client.query<{ snapshot_text: string; snapshot_revision: number }>(
          "SELECT snapshot_text, snapshot_revision FROM documents WHERE id = $1",
          [docId],
        );
        const row = doc.rows[0];
        if (!row) return null;

        const ops = await client.query<{ op: unknown }>(
          "SELECT op FROM operations WHERE doc_id = $1 AND revision > $2 ORDER BY revision",
          [docId, row.snapshot_revision],
        );
        const operations = ops.rows.map((r, index) => {
          if (!isOperation(r.op)) {
            throw new Error(
              `Corrupt operation stored for "${docId}" at revision ${row.snapshot_revision + index + 1}`,
            );
          }
          return r.op;
        });
        return {
          snapshotText: row.snapshot_text,
          snapshotRevision: row.snapshot_revision,
          operations,
        };
      },
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
  }

  /**
   * Records the edit that produced `revision`. Throws RevisionConflictError (and saves
   * nothing) unless `revision` is exactly one more than the document's latest revision.
   * Creates the document on its first edit (revision 1).
   */
  async append(docId: string, revision: number, op: Operation): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("INSERT INTO documents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [
        docId,
      ]);
      // Compare-and-set: moves head forward only if it is still exactly one behind.
      // If two writers race for the same revision, the second one waits for the first
      // to finish, then finds head already moved and updates nothing.
      const moved = await client.query(
        "UPDATE documents SET head_revision = $2, updated_at = now() WHERE id = $1 AND head_revision = $2 - 1",
        [docId, revision],
      );
      if (moved.rowCount === 0) throw new RevisionConflictError(docId, revision);
      await client.query("INSERT INTO operations (doc_id, revision, op) VALUES ($1, $2, $3)", [
        docId,
        revision,
        JSON.stringify(op),
      ]);
    });
  }

  /**
   * Stores `text` as the document's text at `revision`, so loading can skip the edits up
   * to there. The caller must make sure `text` really is the document at that revision.
   * An equal or older snapshot than the one already stored is ignored.
   */
  async saveSnapshot(docId: string, revision: number, text: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE documents
          SET snapshot_text = $3, snapshot_revision = $2, updated_at = now()
        WHERE id = $1 AND snapshot_revision < $2 AND $2 <= head_revision`,
      [docId, revision, text],
    );
    if (result.rowCount !== 0) return;

    const { rows } = await this.pool.query<{ head_revision: number }>(
      "SELECT head_revision FROM documents WHERE id = $1",
      [docId],
    );
    if (!rows[0] || revision > rows[0].head_revision) {
      throw new RangeError(`Cannot snapshot "${docId}" at revision ${revision}: no such revision`);
    }
  }
}

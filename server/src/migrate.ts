import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

// Any number works as long as every copy of the server uses the same one.
const MIGRATION_LOCK_KEY = 4815162342;

/**
 * Applies every .sql file in the migrations folder that hasn't been applied yet, in
 * filename order, and remembers which ones ran in a `schema_migrations` table. Safe to
 * call on every startup: already-applied files are skipped. Returns the files it ran.
 *
 * Each file runs in its own transaction, so a failing migration leaves nothing half-done.
 * An advisory lock makes two servers starting at once take turns instead of racing.
 */
export async function migrate(pool: pg.Pool, directory = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.name));

    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

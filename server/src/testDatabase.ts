import type pg from "pg";
import { createPool } from "./db";
import { migrate } from "./migrate";

/** The test database URL, or undefined if none is configured (database tests are skipped). */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/**
 * Opens the test database with fresh, empty tables. Refuses to touch any database whose
 * name doesn't contain "test", so a wrong TEST_DATABASE_URL can never wipe real documents.
 */
export async function openCleanTestDatabase(): Promise<pg.Pool> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const pool = createPool(TEST_DATABASE_URL);
  const { rows } = await pool.query<{ name: string }>("SELECT current_database() AS name");
  if (!rows[0]!.name.includes("test")) {
    await pool.end();
    throw new Error(`Refusing to reset "${rows[0]!.name}": its name must contain "test"`);
  }
  await pool.query("DROP TABLE IF EXISTS operations, documents, schema_migrations CASCADE");
  await migrate(pool);
  return pool;
}

/** Empties the document tables between tests (keeps the schema). */
export async function clearDocuments(pool: pg.Pool): Promise<void> {
  await pool.query("TRUNCATE operations, documents CASCADE");
}

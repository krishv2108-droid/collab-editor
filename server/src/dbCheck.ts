import { loadConfig } from "./config";
import { createPool } from "./db";

/** `npm run db:check -w server`: confirms we can reach the database. */
const { databaseUrl } = loadConfig();
const pool = createPool(databaseUrl);
try {
  const { rows } = await pool.query<{ db: string; user: string; version: string }>(
    "select current_database() as db, current_user as user, version() as version",
  );
  console.log(`Connected to "${rows[0]!.db}" as "${rows[0]!.user}"`);
  console.log(rows[0]!.version);
} finally {
  await pool.end();
}

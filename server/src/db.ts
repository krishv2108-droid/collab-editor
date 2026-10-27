import pg from "pg";

/**
 * A pool keeps a handful of database connections open and lends them out, so each
 * query doesn't pay the cost of a fresh connection.
 */
export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle connection can break (e.g. the database restarts). Without a listener,
  // that error would crash the whole process instead of just replacing the connection.
  pool.on("error", (error) => console.warn("Idle database connection error:", error.message));
  return pool;
}

/**
 * Runs `work` inside a transaction: either everything it did is saved (COMMIT), or, if it
 * throws, none of it is (ROLLBACK). All queries in `work` must use the client it's given,
 * because a transaction belongs to a single connection.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
  begin = "BEGIN",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

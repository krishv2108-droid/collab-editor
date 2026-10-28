import { loadConfig } from "./config";
import { createPool } from "./db";
import { migrate } from "./migrate";
import { PostgresStore } from "./PostgresStore";
import { createCollabServer } from "./server";

const config = loadConfig();
const pool = createPool(config.databaseUrl);

const applied = await migrate(pool);
if (applied.length > 0) console.log(`Applied migrations: ${applied.join(", ")}`);

const server = await createCollabServer(config.port, new PostgresStore(pool));
console.log(`Collab server listening on ws://localhost:${server.port}`);

// Stop cleanly when asked to (Ctrl+C, or the dev watcher restarting us after a file change).
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return; // a second Ctrl+C must not close the pool a second time
  shuttingDown = true;
  await server.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

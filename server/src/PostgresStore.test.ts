import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { insert } from "@collab/shared";
import { describeDocumentStoreContract } from "./documentStoreContract";
import { migrate } from "./migrate";
import { PostgresStore } from "./PostgresStore";
import { clearDocuments, openCleanTestDatabase, TEST_DATABASE_URL } from "./testDatabase";

// These talk to a real Postgres. Without TEST_DATABASE_URL (see .env.example) they are skipped.
const skip = !TEST_DATABASE_URL;

// Everything every store must do (load, append, snapshots, ...) is checked by the shared contract.
let contractPool: pg.Pool;
describeDocumentStoreContract(
  "PostgresStore",
  async () => {
    contractPool = await openCleanTestDatabase();
    return {
      fresh: async () => {
        await clearDocuments(contractPool);
        return new PostgresStore(contractPool);
      },
      close: () => contractPool.end(),
    };
  },
  { skip },
);

// What only the Postgres implementation has: migrations and validating stored data.
describe.skipIf(skip)("PostgresStore specifics", () => {
  let pool: pg.Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    pool = await openCleanTestDatabase();
    store = new PostgresStore(pool);
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await clearDocuments(pool);
  });

  it("migrations have created the tables", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(["documents", "operations", "schema_migrations"]);
  });

  it("migrating again applies nothing", async () => {
    expect(await migrate(pool)).toEqual([]);
  });

  it("refuses to load a corrupt stored operation", async () => {
    await store.append("doc", 1, [insert("abc")]);
    await pool.query(`UPDATE operations SET op = '"garbage"'::jsonb WHERE doc_id = 'doc'`);
    await expect(store.load("doc")).rejects.toThrow(/Corrupt operation/);
  });

  it("keeps edits saved before the author column existed, with no author", async () => {
    await pool.query(`INSERT INTO documents (id, head_revision) VALUES ('old', 1)`);
    await pool.query(`INSERT INTO operations (doc_id, revision, op) VALUES ('old', 1, '[{"type":"insert","text":"hi"}]'::jsonb)`);
    expect(await store.operationsSince("old", 0)).toEqual([
      { revision: 1, op: [insert("hi")], author: null },
    ]);
  });

  it("the database itself refuses a duplicate revision, even if the code check were missing", async () => {
    await store.append("doc", 1, [insert("abc")]);
    await expect(
      pool.query(`INSERT INTO operations (doc_id, revision, op) VALUES ('doc', 1, '[]'::jsonb)`),
    ).rejects.toThrow(/duplicate key/);
  });
});

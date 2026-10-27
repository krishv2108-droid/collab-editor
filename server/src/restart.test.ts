import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insert, retain } from "@collab/shared";
import { PostgresStore } from "./PostgresStore";
import { createCollabServer } from "./server";
import { openCleanTestDatabase, TEST_DATABASE_URL } from "./testDatabase";
import { TestClient } from "./TestClient";

// The whole stack against a real Postgres. Without TEST_DATABASE_URL (see .env.example) it is skipped.
describe.skipIf(!TEST_DATABASE_URL)("server with Postgres", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = await openCleanTestDatabase();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("keeps a document, and its revision numbering, across a server restart", async () => {
    // First server: two clients edit, including a conflict that needs rewriting.
    const first = await createCollabServer(0, new PostgresStore(pool));
    const alice = await TestClient.connect(first.port);
    const bob = await TestClient.connect(first.port);
    for (const client of [alice, bob]) {
      client.send({ type: "join", docId: "persisted" });
      await client.next(); // snapshot
    }

    alice.send({ type: "edit", baseRevision: 0, op: [insert("abc")] });
    expect(await alice.next()).toEqual({ type: "ack" });
    await bob.next(); // alice's edit

    // Both edit revision 1 at once; the server decides the order and rewrites the second.
    alice.send({ type: "edit", baseRevision: 1, op: [insert("XX"), retain(3)] });
    bob.send({ type: "edit", baseRevision: 1, op: [retain(3), insert("Y")] });
    await alice.next();
    await alice.next();
    await bob.next();
    await bob.next();

    alice.close();
    bob.close();
    await first.close();

    // Second server: empty memory, new store object, same database.
    const second = await createCollabServer(0, new PostgresStore(pool));
    try {
      const carol = await TestClient.connect(second.port);
      carol.send({ type: "join", docId: "persisted" });
      expect(await carol.next()).toEqual({ type: "snapshot", text: "XXabcY", revision: 3 });

      // Editing carries on at the right revision, and the new edit is saved too.
      carol.send({ type: "edit", baseRevision: 3, op: [retain(6), insert("!")] });
      expect(await carol.next()).toEqual({ type: "ack" });
      carol.close();
    } finally {
      await second.close();
    }

    const { rows } = await pool.query<{ revision: number }>(
      "SELECT revision FROM operations WHERE doc_id = 'persisted' ORDER BY revision",
    );
    expect(rows.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
  });
});

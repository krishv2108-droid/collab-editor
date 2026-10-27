# Collab Editor

A real-time collaborative text editor, built from scratch in TypeScript. The
conflict-resolution layer is **Operational Transformation (OT)**, implemented by
hand: no Yjs, Automerge or ShareDB. Documents are stored in **PostgreSQL**.

**Status: Phase 3 complete.** Any number of browser tabs can edit the same
document at once and always converge to identical text, even when edits cross
paths on a slow network. Documents survive server restarts.

## Structure

| Folder    | What it is                                                                                  |
| --------- | ------------------------------------------------------------------------------------------- |
| `shared/` | The OT core (operations, transform, compose), the client state machine, the wire protocol   |
| `server/` | Node + `ws` WebSocket server, document registry, Postgres storage and migrations            |
| `client/` | React + Vite app with a plain textarea                                                      |

## How it works

### Conflict resolution (OT)

- **Operations.** An edit is a list of pieces that walks the whole document:
  `retain n`, `insert "text"`, `delete n`. Example: `[retain 1, insert "X", delete 3, retain 2]`.
- **Transform.** If Alice and Bob edit at the same time, `transform(a, b)` rewrites each
  edit to apply after the other, so both orders give the same text.
- **Server.** Every accepted edit gets a revision number. A client says which revision it
  was looking at; the server transforms the edit against everything accepted since,
  saves it, acknowledges the sender and forwards it to everyone else.
- **Client.** Only one edit is in flight at a time. Anything typed meanwhile is composed
  into a buffer. Incoming edits from others are transformed against the in-flight edit
  and the buffer before being applied, and the cursor is moved to match.
- **Ties.** If two people insert at exactly the same spot, the later-arriving edit goes
  on the left. Server and clients use the same rule.

### Persistence (Postgres)

- **Event log plus snapshots.** Two tables: `operations` is an append-only log of every
  accepted edit, keyed by `(doc_id, revision)`; `documents` holds a snapshot of the full
  text at some revision. Loading a document reads the snapshot plus only the edits after it.
- **Save, then acknowledge.** An edit is written to Postgres before the sender gets its
  `ack`, so an `ack` means the edit is stored. Appending is a compare-and-set on the
  document's head revision, so duplicates, gaps and racing writers are rejected by the
  database itself.
- **One writer per document.** Each loaded document processes its joins and edits one at a
  time through a queue, so revisions reach the database in order.
- **Fail loudly.** If saving fails, the document is dropped from memory and its clients are
  disconnected, so they reload what the database really holds instead of drifting.
- **Snapshots** are saved in the background every 100 edits and never delay an `ack`.
- **Storage is an interface** (`DocumentStore`) with a Postgres and an in-memory
  implementation, both checked by the same contract tests.

## Requirements

- Node 22.12 or newer (developed on Node 24)
- PostgreSQL (developed on 18). On a Mac, [Postgres.app](https://postgresapp.com) is the
  easiest way to get one.

## Setup

```bash
npm install
cp .env.example .env     # then edit if your database isn't at the default address
createdb collab_editor
createdb collab_editor_test
```

`.env` is gitignored. It sets the server port and two database URLs: one for the app
(`DATABASE_URL`) and one for tests (`TEST_DATABASE_URL`), so running tests can never touch
real documents. The tables are created automatically when the server starts.

To check the app can reach its database:

```bash
npm run db:check -w server
```

## Run it

```bash
npm run dev:server   # terminal 1: WebSocket server on ws://localhost:8080
npm run dev:client   # terminal 2: web app on http://localhost:5173
```

Open `http://localhost:5173/?doc=demo` in two browser tabs and type in both. Any `?doc=`
value works: tabs with the same value share a document. Stop and restart the server, reload,
and the text is still there.

## Test it

```bash
npm test             # run all tests once
npm run test:watch   # re-run on every change
```

Tests that need Postgres use `TEST_DATABASE_URL` and refuse to run against any database
whose name doesn't contain "test". Without that variable they are skipped and everything
else still runs.

The most important test is `server/src/simulation.test.ts`: several simulated clients type
at random while messages are delivered in random order and clients join mid-session. When
everything settles, the server and every client must hold the same text. It uses fixed
seeds, so any failure can be reproduced exactly.

## Known limitations

- A client whose connection drops must reload the page; there is no automatic reconnect.
- The `operations` table is never trimmed, so it grows forever. Snapshots keep loading fast
  but don't reduce storage.
- One server process only. Running several against one database would be detected and
  refused by the revision check, but it isn't supported.
- Other users' cursors aren't shown.

## Roadmap

- [x] Phase 1: monorepo, WebSocket server, React client, naive sync
- [x] Phase 2: conflict resolution with OT
- [x] Phase 3: Postgres persistence with snapshots
- [ ] Next: automatic reconnect, trimming old operations, showing other users' cursors

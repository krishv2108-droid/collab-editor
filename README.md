# Collab Editor

A real-time collaborative text editor, built from scratch in TypeScript. The
conflict-resolution layer is **Operational Transformation (OT)**, implemented by
hand: no Yjs, Automerge or ShareDB. Documents are stored in **PostgreSQL**.

**Status: Phase 3 complete, plus automatic reconnect and other users' cursors.** Any number of browser tabs can
edit the same document at once and always converge to identical text, even when edits
cross paths on a slow network. Documents survive server restarts, and a tab whose
connection drops keeps working offline and catches up by itself when it is back.

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

### Reconnecting

A dropped connection leaves one awkward question: the edit that was in flight when it died
may or may not have been saved. Sending it again could apply it twice; not sending it could
lose it. So the server and client settle it explicitly:

- **Identity.** Each tab picks a random `clientId` and sends it when joining. The server
  stores the author with every saved edit (never shown to other users).
- **Catch-up.** A returning tab says which revision it last processed. The server answers
  with every edit saved since, each marked `own` or not. An `own` edit is the tab's in-flight
  edit after all, so it counts as acknowledged; anything still in flight afterwards was never
  saved and is sent again. Other people's edits are applied exactly like live ones.
- **Offline typing.** The editor stays usable while reconnecting. Edits pile up in the same
  buffer used while waiting for an acknowledgement and go out once the tab has caught up.
- **Half-dead connections.** When a tab rejoins, the server drops any older connection of the
  same tab, so an edit still on its way over the old connection can't be saved a second time.
  If an old connection's `join` arrives late and the server keeps *it* instead, the tab is
  told it was replaced and simply reconnects (ids are unique per page load, so only an old
  connection of the same tab can ever replace it).
- **Retrying.** Waits grow 0.5 s, 1 s, 2 s... up to 15 s, randomised so that tabs don't all
  return at the same instant after a server restart. The wait resets only once the server
  has answered the join.
- **Heartbeat.** Browsers hide WebSocket pings from pages, so the client sends its own ping
  after 10 s of quiet and gives up on the connection if nothing comes back within 5 s. The
  server separately drops connections that stay silent for a full round.

### Other users' cursors

A cursor is a number ("character 17"), and that number only means something relative to one
exact version of the text, so cursors need the same care as edits. They are temporary: never
saved, never part of the operation log.

- **Reporting.** A tab sends `cursor { baseRevision, start, end }` only while it has no
  unacknowledged edits, because only then is its text exactly a revision the server has.
  Anything typed meanwhile is reported once the last edit is acknowledged, and at most once
  every 50 ms.
- **The server moves cursors forward.** It transforms the reported position past every edit
  saved since `baseRevision`, stores it, and moves every stored cursor past each edit it
  accepts, so a late joiner is told where everyone is. It hands out anonymous names
  (`Guest 3`); the real `clientId` is never shown.
- **Clients track cursors in the server's text, not their own.** Each tab moves other
  users' cursors past every edit the server accepts, including the tab's own edits once they
  are acknowledged, in the order the server accepted them: exactly what the server does with
  its copy, so they cannot disagree. What is drawn is that position projected through the
  tab's own unacknowledged edits. This design is forced, not a preference: moving a position
  past two concurrent edits in opposite orders can give different answers, because a
  deletion throws away which side of a concurrent insert the position was on (the smallest
  case is in `shared/src/position.test.ts`).
- **Drawing.** A textarea can only show its own caret, so a transparent copy of the text sits
  behind it, laid out identically, carrying a colored bar and a name tag at each cursor and a
  tinted background behind each selection.
- **While disconnected** other users' cursors are hidden, since they can't be kept up to
  date; they come back with the catch-up.

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

`server/src/reconnectSimulation.test.ts` adds failures to that: the real registry, store and
client state machine run against a simulated network that drops connections (losing
acknowledgements for edits the server had already saved), leaves half-dead connections whose
edits arrive late, and restarts the server. In the insert-only runs every typed character is
unique and nothing is deleted, so a lost edit and a duplicated edit both fail the final check.

`client/src/cursorSimulation.test.ts` does the same for cursors, running the real server
logic (`server/src/hub.ts`) and the real browser logic (`DocumentSession`) over a made-up
network with delayed and reordered messages, dying and half-dead connections and server
restarts. At the end every user must see every other user's cursor on exactly the spot where
that user's own cursor is.

The most important test of the editing logic itself is `server/src/simulation.test.ts`: several simulated clients type
at random while messages are delivered in random order and clients join mid-session. When
everything settles, the server and every client must hold the same text. It uses fixed
seeds, so any failure can be reproduced exactly.

## Known limitations

- Reloading the page starts a new session: typing that hadn't reached the server is lost.
- If the server can't catch a returning tab up (for example, the database was wiped), the tab
  takes a fresh copy of the document and what it typed while offline is discarded.
- The `operations` table is never trimmed, so it grows forever. Snapshots keep loading fast
  but don't reduce storage. (Catch-up after a reconnect reads this log, so trimming it would
  need a limit on how long a tab can be away.)
- One server process only. Running several against one database would be detected and
  refused by the revision check, but it isn't supported.
- Cursors are anonymous ("Guest 3"; there are no accounts), the direction of a selection isn't
  shown, and the drawing assumes the textarea and its copy lay text out identically, which
  holds for plain text in a fixed font but not for, say, a right-to-left language.
- After a reconnect that falls back to a snapshot, your own cursor is not re-reported until
  you move it.

## Roadmap

- [x] Phase 1: monorepo, WebSocket server, React client, naive sync
- [x] Phase 2: conflict resolution with OT
- [x] Phase 3: Postgres persistence with snapshots
- [x] Reconnect: offline editing, catch-up without duplicates, heartbeat
- [x] Other users' cursors: carets, selections, kept correct across edits and reconnects
- [ ] Next: trimming old operations

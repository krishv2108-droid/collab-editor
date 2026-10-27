# Collab Editor

A real-time collaborative text editor, built from scratch in TypeScript. The
conflict-resolution layer is **Operational Transformation (OT)**, implemented by
hand: no Yjs, Automerge or ShareDB.

**Status: Phase 2 complete.** Any number of browser tabs can edit the same
document at once, and they always converge to identical text, even when edits
cross paths on a slow network.

## Structure

| Folder    | What it is                                                                         |
| --------- | ---------------------------------------------------------------------------------- |
| `shared/` | The OT core (operations, transform, compose), the client state machine, the wire protocol |
| `server/` | Node + `ws` WebSocket server; one authoritative document per ID with a revision log |
| `client/` | React + Vite app with a plain textarea                                              |

## How it works

- **Operations.** An edit is a list of pieces that walks the whole document:
  `retain n`, `insert "text"`, `delete n`. Example: `[retain 1, insert "X", delete 3, retain 2]`.
- **Transform.** If Alice and Bob edit at the same time, `transform(a, b)` rewrites each
  edit to apply after the other, so both orders give the same text.
- **Server.** Every accepted edit gets a revision number. A client says which revision it
  was looking at; the server transforms the edit against everything accepted since,
  applies it, acknowledges the sender and forwards it to everyone else.
- **Client.** Only one edit is in flight at a time. Anything typed meanwhile is composed
  into a buffer. Incoming edits from others are transformed against the in-flight edit
  and the buffer before being applied, and the cursor is moved to match.
- **Ties.** If two people insert at exactly the same spot, the later-arriving edit goes
  on the left. Server and clients use the same rule.

## Requirements

- Node 20 or newer

## Run it

```bash
npm install          # once, installs all three packages
npm run dev:server   # terminal 1: WebSocket server on ws://localhost:8080
npm run dev:client   # terminal 2: web app on http://localhost:5173
```

Open `http://localhost:5173/?doc=demo` in two browser tabs and type in both.
Any `?doc=` value works: tabs with the same value share a document.

## Test it

```bash
npm test             # run all tests once
npm run test:watch   # re-run on every change
```

The most important test is `server/src/simulation.test.ts`. It runs several simulated
clients that type at random while messages are delivered in random order and clients
join mid-session. When everything settles, the server and every client must hold the
same text. It uses fixed seeds, so any failure can be reproduced exactly.

## Roadmap

- [x] Phase 1: monorepo, WebSocket server, React client, naive sync
- [x] Phase 2: conflict resolution with OT
- [ ] Phase 3: Postgres persistence (and trimming the revision history)
- [ ] Later: reconnecting after a dropped connection, showing other users' cursors

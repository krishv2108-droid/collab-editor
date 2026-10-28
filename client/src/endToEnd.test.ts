import { afterEach, describe, expect, it } from "vitest";
import type { PeerCursor } from "@collab/shared";
import { createCollabServer, type CollabServer } from "../../server/src/server";
import { InMemoryStore } from "../../server/src/InMemoryStore";
import { DocumentSession, type ConnectionStatus } from "./DocumentSession";

/**
 * The other client tests use a made-up network. This one connects the real DocumentSession to
 * the real server over real WebSockets (Node's built-in WebSocket, the same API a browser has),
 * with real timers, so it also checks the things a fake can't: close codes, reconnect timing,
 * and that the two sides agree on the wire format.
 */

interface Client {
  session: DocumentSession;
  statuses: ConnectionStatus[];
  peers: PeerCursor[];
}

describe("DocumentSession against the real server", () => {
  const servers: CollabServer[] = [];
  const sessions: DocumentSession[] = [];

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.stop();
    for (const server of servers.splice(0)) await server.close();
  });

  async function startServer(store: InMemoryStore, port = 0): Promise<CollabServer> {
    const server = await createCollabServer(port, store);
    servers.push(server);
    return server;
  }

  function connect(port: number, docId = "doc"): Client {
    const client: Client = { statuses: [], peers: [], session: undefined as never };
    client.session = new DocumentSession({
      url: `ws://localhost:${port}`,
      docId,
      clientId: `tab-${sessions.length}`,
      listener: {
        onStatus: (status) => client.statuses.push(status),
        onRemoteChange: () => {},
        onPeersChange: (peers) => (client.peers = peers),
      },
    });
    sessions.push(client.session);
    client.session.start();
    return client;
  }

  /** Polls until `check` passes (real time passes, so this is how we wait for real sockets). */
  async function until(what: string, check: () => boolean, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("two sessions converge, and see each other's cursors", async () => {
    const server = await startServer(new InMemoryStore());
    const a = connect(server.port);
    const b = connect(server.port);
    await until("both ready", () => a.session.status === "ready" && b.session.status === "ready");

    a.session.edit("hello");
    await until("b sees hello", () => b.session.text === "hello");
    b.session.edit("hello world");
    await until("a sees hello world", () => a.session.text === "hello world");

    // Typed at the same moment, at the same place: they must still agree.
    a.session.edit("A" + a.session.text);
    b.session.edit("B" + b.session.text);
    await until("they agree", () => a.session.text === b.session.text && a.session.text.length === 13);

    a.session.setSelection({ start: 1, end: 4 });
    await until("b sees a's selection", () => b.peers.some((p) => p.start === 1 && p.end === 4));
  });

  it("carries on across a server restart, merging what each side typed meanwhile", async () => {
    const store = new InMemoryStore();
    const first = await startServer(store);
    const a = connect(first.port);
    const b = connect(first.port);
    await until("both ready", () => a.session.status === "ready" && b.session.status === "ready");
    a.session.edit("base");
    await until("b has base", () => b.session.text === "base");

    await first.close(); // the server goes away
    await until("both notice", () => a.session.status === "reconnecting" && b.session.status === "reconnecting");
    a.session.edit("base + a"); // typed while offline
    b.session.edit("b + base");

    await startServer(store, first.port); // and comes back on the same address
    await until(
      "they reconnect and agree",
      () =>
        a.session.status === "ready" &&
        b.session.status === "ready" &&
        a.session.text === b.session.text &&
        a.session.text.includes("a") &&
        a.session.text.includes("b +"),
      12_000,
    );
    expect(a.session.text.replace(/[^a-z+ ]/g, "").length).toBeGreaterThan("base".length);
  });

  it("stops, instead of retrying forever, when an edit is too big for the server", async () => {
    const server = await startServer(new InMemoryStore());
    const a = connect(server.port);
    await until("ready", () => a.session.status === "ready");

    a.session.edit("x".repeat(2 * 1024 * 1024)); // over the server's 1 MiB message limit
    await until("gives up", () => a.session.status === "outOfSync");

    await new Promise((resolve) => setTimeout(resolve, 1500)); // longer than a retry would take
    expect(a.session.status).toBe("outOfSync");
    expect(a.statuses).not.toContain("reconnecting");
  });
});

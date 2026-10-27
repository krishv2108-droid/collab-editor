import type { Operation } from "@collab/shared";
import type { DocumentStore } from "./DocumentStore";
import { ServerDocument } from "./ServerDocument";

/**
 * Thrown by applyEdit when saving the edit failed. The document is thrown out of memory
 * and every client in it is reported through `onRoomFailed`, so they reload from the store.
 */
export class RoomFailedError extends Error {
  constructor(
    readonly docId: string,
    readonly cause: unknown,
  ) {
    super(`Document "${docId}" was dropped because the store failed: ${String(cause)}`);
    this.name = "RoomFailedError";
  }
}

export interface EditResult<C> {
  /** The edit as accepted (rewritten if it was stale). Forward this to `recipients`. */
  op: Operation;
  /** Everyone in the document except the sender. The sender gets an ack instead. */
  recipients: C[];
}

export interface RegistryOptions<C> {
  /** Called with every client of a document that had to be dropped. */
  onRoomFailed?(clients: C[], error: RoomFailedError): void;
}

/**
 * One loaded document and the clients connected to it. Everything that touches a room
 * (joining, editing, eviction) goes through its queue, one task at a time, because saving
 * takes time and edits must be recorded in the order they are accepted.
 */
interface Room<C> {
  docId: string;
  document: Promise<ServerDocument>;
  clients: Set<C>;
  tail: Promise<unknown>;
  /** True once the room has been removed from memory; nothing more may happen in it. */
  evicted: boolean;
}

/**
 * The server's memory of documents that are in use: which clients are connected to each,
 * and the live ServerDocument. Documents are loaded from the store when their first client
 * joins, every accepted edit is saved to the store before it is acknowledged, and a
 * document leaves memory when its last client does. It knows nothing about WebSockets;
 * `C` can be any type that identifies a client (a socket in production, a string in tests).
 */
export class DocumentRegistry<C> {
  private readonly rooms = new Map<string, Room<C>>();
  /** Which room each client is in (or is in the middle of joining). */
  private readonly memberships = new Map<C, { room: Room<C> }>();

  constructor(
    private readonly store: DocumentStore,
    private readonly options: RegistryOptions<C> = {},
  ) {}

  /**
   * Puts `client` in document `docId`, loading it from the store if nobody else has it
   * open. Resolves with what to snapshot to the client, or null if the client left or
   * moved to another document before this finished. Rejects if the document can't be loaded.
   */
  async join(docId: string, client: C): Promise<{ text: string; revision: number } | null> {
    this.leave(client); // a client can only be in one document at a time

    for (;;) {
      const room = this.roomFor(docId);
      const membership = { room };
      this.memberships.set(client, membership);

      try {
        const result = await this.enqueue(room, async () => {
          if (room.evicted) return "retry" as const;
          const document = await room.document;
          if (this.memberships.get(client) !== membership) return null; // left in the meantime
          room.clients.add(client);
          return { text: document.text, revision: document.revision };
        });
        if (result !== "retry") return result;
      } catch (error) {
        if (this.memberships.get(client) === membership) this.memberships.delete(client);
        throw error;
      }

      // The room was thrown out before our turn came. Try again with a fresh one,
      // unless the client has gone away.
      if (this.memberships.get(client) !== membership) return null;
    }
  }

  /** Removes `client` from its document. The document leaves memory once it is empty and idle. */
  leave(client: C): void {
    const membership = this.memberships.get(client);
    if (!membership) return;
    this.memberships.delete(client);

    const { room } = membership;
    room.clients.delete(client);
    if (room.clients.size === 0) {
      // Queue the eviction behind any edit still being saved, and skip it if
      // someone joined in the meantime.
      void this.enqueue(room, async () => {
        if (room.clients.size === 0) this.evict(room);
      });
    }
  }

  /**
   * Accepts an edit the client made at `baseRevision`: rewrites it if it is stale, saves
   * it, and only then makes it part of the live document. Rejects (changing nothing) if
   * the client hasn't joined or the revision or operation doesn't fit. Rejects with
   * RoomFailedError if saving failed.
   */
  applyEdit(client: C, baseRevision: number, op: Operation): Promise<EditResult<C>> {
    const membership = this.memberships.get(client);
    if (!membership) return Promise.reject(new Error("Client has not joined a document"));
    const { room } = membership;

    return this.enqueue(room, async () => {
      if (room.evicted || !room.clients.has(client)) {
        throw new Error("Client is no longer in this document");
      }
      const document = await room.document;

      const edit = document.prepare(baseRevision, op); // throws on bad input, changing nothing
      try {
        await this.store.append(room.docId, edit.revision, edit.op);
      } catch (cause) {
        throw this.failRoom(room, cause);
      }
      document.commit(edit); // saved, so now it is real

      return { op: edit.op, recipients: [...room.clients].filter((c) => c !== client) };
    });
  }

  /** How many clients are connected to `docId` (0 if it isn't loaded). */
  clientCount(docId: string): number {
    return this.rooms.get(docId)?.clients.size ?? 0;
  }

  /** How many documents are currently held in memory. */
  get documentCount(): number {
    return this.rooms.size;
  }

  private roomFor(docId: string): Room<C> {
    let room = this.rooms.get(docId);
    if (!room) {
      const created: Room<C> = {
        docId,
        document: this.loadDocument(docId),
        clients: new Set(),
        tail: Promise.resolve(),
        evicted: false,
      };
      // If loading fails, forget the room so the next join tries again.
      created.document.catch(() => this.evict(created));
      this.rooms.set(docId, created);
      room = created;
    }
    return room;
  }

  private async loadDocument(docId: string): Promise<ServerDocument> {
    const stored = await this.store.load(docId);
    return stored ? ServerDocument.restore(stored) : new ServerDocument();
  }

  /** Runs `task` after everything already queued for this room has finished. */
  private enqueue<T>(room: Room<C>, task: () => Promise<T>): Promise<T> {
    const result = room.tail.then(task);
    room.tail = result.catch(() => {}); // a failed task must not block the ones behind it
    return result;
  }

  private evict(room: Room<C>): void {
    room.evicted = true;
    if (this.rooms.get(room.docId) === room) this.rooms.delete(room.docId);
  }

  /** Drops a room whose memory can no longer be trusted to match the store. */
  private failRoom(room: Room<C>, cause: unknown): RoomFailedError {
    const error = new RoomFailedError(room.docId, cause);
    const clients = [...room.clients];
    this.evict(room);
    room.clients.clear();
    for (const client of clients) {
      if (this.memberships.get(client)?.room === room) this.memberships.delete(client);
    }
    this.options.onRoomFailed?.(clients, error);
    return error;
  }
}

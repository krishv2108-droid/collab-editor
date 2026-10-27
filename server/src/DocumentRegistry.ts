import type { Operation } from "@collab/shared";
import { ServerDocument } from "./ServerDocument";

interface Doc<C> {
  document: ServerDocument;
  clients: Set<C>;
}

export interface EditResult<C> {
  /** The edit as accepted (rewritten if it was stale). Forward this to `recipients`. */
  op: Operation;
  /** Everyone in the document except the sender. The sender gets an ack instead. */
  recipients: C[];
}

/**
 * The server's memory: which documents exist, their text and revision history,
 * and which clients are connected to each. It knows nothing about WebSockets;
 * `C` can be any type that identifies a client (a socket in production, a string in tests).
 */
export class DocumentRegistry<C> {
  private docs = new Map<string, Doc<C>>();
  private clientDoc = new Map<C, string>();

  /** Puts `client` in document `docId` (creating it if needed). Returns what to snapshot to it. */
  join(docId: string, client: C): { text: string; revision: number } {
    this.leave(client); // a client can only be in one document at a time
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { document: new ServerDocument(), clients: new Set() };
      this.docs.set(docId, doc);
    }
    doc.clients.add(client);
    this.clientDoc.set(client, docId);
    return { text: doc.document.text, revision: doc.document.revision };
  }

  /** Removes `client` from its document. Deletes the document if it was the last one there. */
  leave(client: C): void {
    const docId = this.clientDoc.get(client);
    if (docId === undefined) return;
    this.clientDoc.delete(client);
    const doc = this.docs.get(docId);
    if (!doc) return;
    doc.clients.delete(client);
    if (doc.clients.size === 0) this.docs.delete(docId);
  }

  /**
   * Accepts an edit the client made at `baseRevision`. Throws (changing nothing)
   * if the client hasn't joined, or the revision or operation doesn't fit.
   */
  applyEdit(client: C, baseRevision: number, op: Operation): EditResult<C> {
    const doc = this.docOf(client);
    if (!doc) throw new Error("Client has not joined a document");
    const accepted = doc.document.receive(baseRevision, op);
    return { op: accepted, recipients: [...doc.clients].filter((c) => c !== client) };
  }

  getText(docId: string): string | undefined {
    return this.docs.get(docId)?.document.text;
  }

  getRevision(docId: string): number | undefined {
    return this.docs.get(docId)?.document.revision;
  }

  clientCount(docId: string): number {
    return this.docs.get(docId)?.clients.size ?? 0;
  }

  get documentCount(): number {
    return this.docs.size;
  }

  private docOf(client: C): Doc<C> | undefined {
    const docId = this.clientDoc.get(client);
    return docId === undefined ? undefined : this.docs.get(docId);
  }
}

import type { Operation } from "@collab/shared";
import type { DocumentStore, StoredDocument, StoredOperation } from "./DocumentStore";
import { InMemoryStore } from "./InMemoryStore";

/**
 * A test double: an in-memory store that can be made slow or broken on demand, so tests
 * can check what the server does when the database is slow or fails.
 */
export class FlakyStore implements DocumentStore {
  readonly inner = new InMemoryStore();
  loadCalls = 0;
  appendCalls = 0;
  /** Every load and append waits this long, letting tests make operations overlap. */
  delayMs = 0;
  failNextLoad = false;
  failNextAppend = false;
  failNextOperationsSince = false;
  snapshotCalls = 0;
  /** Snapshots are slow independently of the other operations, so tests can catch them mid-save. */
  snapshotDelayMs = 0;
  failNextSnapshot = false;

  private pause(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async load(docId: string): Promise<StoredDocument | null> {
    this.loadCalls++;
    await this.pause();
    if (this.failNextLoad) {
      this.failNextLoad = false;
      throw new Error("simulated load failure");
    }
    return this.inner.load(docId);
  }

  async append(docId: string, revision: number, op: Operation, author?: string): Promise<void> {
    this.appendCalls++;
    await this.pause();
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("simulated append failure");
    }
    return this.inner.append(docId, revision, op, author);
  }

  async operationsSince(docId: string, afterRevision: number): Promise<StoredOperation[]> {
    await this.pause();
    if (this.failNextOperationsSince) {
      this.failNextOperationsSince = false;
      throw new Error("simulated operationsSince failure");
    }
    return this.inner.operationsSince(docId, afterRevision);
  }

  async saveSnapshot(docId: string, revision: number, text: string): Promise<void> {
    this.snapshotCalls++;
    await new Promise((resolve) => setTimeout(resolve, this.snapshotDelayMs));
    if (this.failNextSnapshot) {
      this.failNextSnapshot = false;
      throw new Error("simulated snapshot failure");
    }
    return this.inner.saveSnapshot(docId, revision, text);
  }
}

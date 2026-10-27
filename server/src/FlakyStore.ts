import type { Operation } from "@collab/shared";
import type { DocumentStore, StoredDocument } from "./DocumentStore";
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

  async append(docId: string, revision: number, op: Operation): Promise<void> {
    this.appendCalls++;
    await this.pause();
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("simulated append failure");
    }
    return this.inner.append(docId, revision, op);
  }

  saveSnapshot(docId: string, revision: number, text: string): Promise<void> {
    return this.inner.saveSnapshot(docId, revision, text);
  }
}

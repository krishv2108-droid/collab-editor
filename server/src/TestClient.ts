import { WebSocket } from "ws";
import { parseServerMessage, type ClientMessage, type ServerMessage } from "@collab/shared";

/** A test WebSocket that queues incoming messages so we can await them in order. */
export class TestClient {
  private socket: WebSocket;
  private queue: ServerMessage[] = [];
  private waiting: Array<(message: ServerMessage) => void> = [];
  readonly closed: Promise<number>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => socket.once("close", (code) => resolve(code)));
    socket.on("message", (data) => {
      const message = parseServerMessage(data.toString());
      if (!message) return;
      const waiter = this.waiting.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${port}`);
      const client = new TestClient(socket);
      socket.once("open", () => resolve(client));
      socket.once("error", reject);
    });
  }

  send(message: ClientMessage | string): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  next(): Promise<ServerMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  close(): void {
    this.socket.terminate();
  }
}

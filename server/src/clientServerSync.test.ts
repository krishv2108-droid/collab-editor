import { describe, expect, it } from "vitest";
import {
  applyOperation,
  ClientSync,
  diffToOperation,
  insert,
  type Operation,
  type Outgoing,
} from "@collab/shared";
import { ServerDocument } from "./ServerDocument";

/** A client's local text plus its sync state machine (no network, no React). */
class SimClient {
  text: string;
  private sync: ClientSync;

  constructor(revision: number, text: string) {
    this.text = text;
    this.sync = new ClientSync(revision);
  }

  /** The user changes the text. Returns what must be sent to the server, if anything. */
  type(newText: string): Outgoing | null {
    const op = diffToOperation(this.text, newText);
    this.text = newText;
    return op ? this.sync.applyLocal(op) : null;
  }

  receiveRemote(op: Operation): void {
    this.text = applyOperation(this.text, this.sync.applyRemote(op));
  }

  receiveAck(): Outgoing | null {
    return this.sync.serverAck();
  }

  get state() {
    return this.sync.state;
  }
}

/** Starts a server at "abc", revision 1, and two clients that have both loaded it. */
function setup() {
  const server = new ServerDocument();
  server.receive(0, [insert("abc")]);
  return { server, alice: new SimClient(1, "abc"), bob: new SimClient(1, "abc") };
}

describe("client + server together (scripted)", () => {
  it("converges when two clients edit at the same moment", () => {
    const { server, alice, bob } = setup();

    // Both type before hearing from the server.
    const fromAlice = alice.type("XXabc")!;
    const fromBob = bob.type("abcY")!;

    // The server receives Alice's edit first, then Bob's.
    const aliceAccepted = server.receive(fromAlice.baseRevision, fromAlice.op);
    const bobAccepted = server.receive(fromBob.baseRevision, fromBob.op);

    // Alice hears: ack for hers, then Bob's edit. Bob hears: Alice's edit, then his ack.
    alice.receiveAck();
    alice.receiveRemote(bobAccepted);
    bob.receiveRemote(aliceAccepted);
    bob.receiveAck();

    expect(server.text).toBe("XXabcY");
    expect(alice.text).toBe("XXabcY");
    expect(bob.text).toBe("XXabcY");
    expect(alice.state).toBe("synchronized");
    expect(bob.state).toBe("synchronized");
  });

  it("converges when one client types more while its edit is in flight", () => {
    const { server, alice, bob } = setup();

    const fromAlice = alice.type("XXabc")!;
    const fromBob = bob.type("abcY")!; // in flight
    expect(bob.type("abcYZ")).toBeNull(); // buffered, not sent

    const aliceAccepted = server.receive(fromAlice.baseRevision, fromAlice.op);
    const bobAccepted = server.receive(fromBob.baseRevision, fromBob.op);

    // Bob hears Alice's edit (while holding two pending edits), then his ack,
    // which releases the buffered edit.
    bob.receiveRemote(aliceAccepted);
    const bobSecond = bob.receiveAck()!;
    expect(bobSecond.baseRevision).toBe(3); // after Alice's (2) and his first (3)

    // Alice hears her ack, Bob's first edit, then (after the server accepts it) his second.
    alice.receiveAck();
    alice.receiveRemote(bobAccepted);
    const bobSecondAccepted = server.receive(bobSecond.baseRevision, bobSecond.op);
    alice.receiveRemote(bobSecondAccepted);
    expect(bob.receiveAck()).toBeNull();

    expect(server.text).toBe("XXabcYZ");
    expect(alice.text).toBe("XXabcYZ");
    expect(bob.text).toBe("XXabcYZ");
  });

  it("converges when both insert at the very same spot", () => {
    const { server, alice, bob } = setup();

    const fromAlice = alice.type("aAbc")!;
    const fromBob = bob.type("aBbc")!;
    const aliceAccepted = server.receive(fromAlice.baseRevision, fromAlice.op);
    const bobAccepted = server.receive(fromBob.baseRevision, fromBob.op);

    alice.receiveAck();
    alice.receiveRemote(bobAccepted);
    bob.receiveRemote(aliceAccepted);
    bob.receiveAck();

    expect(alice.text).toBe(server.text);
    expect(bob.text).toBe(server.text);
    expect(server.text).toBe("aBAbc"); // the later-arriving edit lands on the left
  });
});

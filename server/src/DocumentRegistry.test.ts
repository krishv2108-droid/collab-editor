import { describe, expect, it } from "vitest";
import { insert, retain } from "@collab/shared";
import { DocumentRegistry } from "./DocumentRegistry";

describe("DocumentRegistry", () => {
  it("creates a document on first join, empty at revision 0", () => {
    const registry = new DocumentRegistry<string>();
    expect(registry.join("doc1", "alice")).toEqual({ text: "", revision: 0 });
    expect(registry.documentCount).toBe(1);
    expect(registry.clientCount("doc1")).toBe(1);
  });

  it("tracks clients per document separately", () => {
    const registry = new DocumentRegistry<string>();
    registry.join("doc1", "alice");
    registry.join("doc1", "bob");
    registry.join("doc2", "carol");
    expect(registry.clientCount("doc1")).toBe(2);
    expect(registry.clientCount("doc2")).toBe(1);
    expect(registry.documentCount).toBe(2);
  });

  it("deletes a document when its last client leaves", () => {
    const registry = new DocumentRegistry<string>();
    registry.join("doc1", "alice");
    registry.join("doc1", "bob");
    registry.leave("alice");
    expect(registry.documentCount).toBe(1);
    registry.leave("bob");
    expect(registry.documentCount).toBe(0);
    expect(registry.getText("doc1")).toBeUndefined();
  });

  it("ignores leave for a client that never joined", () => {
    const registry = new DocumentRegistry<string>();
    expect(() => registry.leave("ghost")).not.toThrow();
  });

  it("moves a client when it joins a second document", () => {
    const registry = new DocumentRegistry<string>();
    registry.join("doc1", "alice");
    registry.join("doc2", "alice");
    expect(registry.clientCount("doc1")).toBe(0);
    expect(registry.clientCount("doc2")).toBe(1);
    expect(registry.documentCount).toBe(1);
  });

  it("applies an edit and returns the other clients, not the sender", () => {
    const registry = new DocumentRegistry<string>();
    registry.join("doc1", "alice");
    registry.join("doc1", "bob");
    registry.join("doc2", "carol");

    const result = registry.applyEdit("alice", 0, [insert("hi")]);
    expect(result.recipients).toEqual(["bob"]);
    expect(result.op).toEqual([insert("hi")]);
    expect(registry.getText("doc1")).toBe("hi");
    expect(registry.getRevision("doc1")).toBe(1);
    expect(registry.getText("doc2")).toBe("");
  });

  it("returns the rewritten op when the edit was made against an older revision", () => {
    const registry = new DocumentRegistry<string>();
    registry.join("doc1", "alice");
    registry.join("doc1", "bob");
    registry.applyEdit("alice", 0, [insert("abc")]);
    registry.applyEdit("alice", 1, [insert("XX"), retain(3)]);

    // Bob made this when the document was "abc" (revision 1).
    const result = registry.applyEdit("bob", 1, [retain(3), insert("Y")]);
    expect(result.op).toEqual([retain(5), insert("Y")]);
    expect(registry.getText("doc1")).toBe("XXabcY");
  });

  it("gives late joiners the current text and revision", () => {
    const registry = new DocumentRegistry<string>();
    registry.join("doc1", "alice");
    registry.applyEdit("alice", 0, [insert("hello")]);
    expect(registry.join("doc1", "bob")).toEqual({ text: "hello", revision: 1 });
  });

  it("rejects an edit from a client that has not joined", () => {
    const registry = new DocumentRegistry<string>();
    expect(() => registry.applyEdit("ghost", 0, [insert("x")])).toThrow();
  });

  it("rejects a bad edit and leaves the document unchanged", () => {
    const registry = new DocumentRegistry<string>();
    registry.join("doc1", "alice");
    registry.applyEdit("alice", 0, [insert("hi")]);
    expect(() => registry.applyEdit("alice", 1, [retain(9)])).toThrow(RangeError);
    expect(() => registry.applyEdit("alice", 7, [retain(2)])).toThrow(RangeError);
    expect(registry.getText("doc1")).toBe("hi");
    expect(registry.getRevision("doc1")).toBe(1);
  });
});

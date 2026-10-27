import { describe, expect, it } from "vitest";
import { diffToOp, type TextOp } from "./textOps";

const apply = (text: string, op: TextOp) =>
  text.slice(0, op.index) + op.insert + text.slice(op.index + op.deleteCount);

describe("diffToOp", () => {
  it("returns null when nothing changed", () => {
    expect(diffToOp("hello", "hello")).toBeNull();
  });

  it("detects an insert in the middle", () => {
    expect(diffToOp("helo", "hello")).toEqual({ index: 3, deleteCount: 0, insert: "l" });
  });

  it("detects a delete", () => {
    expect(diffToOp("hello", "hllo")).toEqual({ index: 1, deleteCount: 1, insert: "" });
  });

  it("detects a replacement", () => {
    expect(diffToOp("cat", "cut")).toEqual({ index: 1, deleteCount: 1, insert: "u" });
  });

  it("handles typing into an empty document", () => {
    expect(diffToOp("", "hi")).toEqual({ index: 0, deleteCount: 0, insert: "hi" });
  });

  it("handles clearing the whole document", () => {
    expect(diffToOp("hi", "")).toEqual({ index: 0, deleteCount: 2, insert: "" });
  });

  it("does not double count repeated characters", () => {
    const op = diffToOp("aa", "aaa")!;
    expect(apply("aa", op)).toBe("aaa");
  });

  it("does not split an emoji in half", () => {
    const op = diffToOp("a😀b", "a😁b")!;
    expect(op).toEqual({ index: 1, deleteCount: 2, insert: "😁" });
  });

  it("round-trips: applying diffToOp(a, b) to a always gives b", () => {
    const samples = ["", "a", "hello world", "hello, world", "abcabc", "abc", "xyz😀", "😀"];
    for (const a of samples) {
      for (const b of samples) {
        const op = diffToOp(a, b);
        expect(op === null ? a : apply(a, op)).toBe(b);
      }
    }
  });
});

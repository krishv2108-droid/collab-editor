import { describe, expect, it } from "vitest";
import { buildPieces, colorFor, labelFor, type Piece } from "./peerSegments";

const text = (t: string, highlight: string | null = null): Piece => ({ kind: "text", text: t, highlight });
const caret = (peer: string): Piece => ({ kind: "caret", peer, color: colorFor(peer), label: labelFor(peer) });

describe("buildPieces", () => {
  it("is just the text when nobody has a cursor", () => {
    expect(buildPieces("hello", [])).toEqual([text("hello")]);
  });

  it("is nothing for an empty document without cursors", () => {
    expect(buildPieces("", [])).toEqual([]);
  });

  it("puts a caret between the letters it sits between", () => {
    expect(buildPieces("hello", [{ peer: "1", start: 2, end: 2 }])).toEqual([
      text("he"),
      caret("1"),
      text("llo"),
    ]);
  });

  it("handles a caret at the very start and the very end", () => {
    expect(buildPieces("hi", [{ peer: "1", start: 0, end: 0 }])).toEqual([caret("1"), text("hi")]);
    expect(buildPieces("hi", [{ peer: "1", start: 2, end: 2 }])).toEqual([text("hi"), caret("1")]);
  });

  it("works in an empty document", () => {
    expect(buildPieces("", [{ peer: "1", start: 0, end: 0 }])).toEqual([caret("1")]);
  });

  it("highlights a selection and puts the caret at its end", () => {
    const color = colorFor("1");
    expect(buildPieces("hello", [{ peer: "1", start: 1, end: 4 }])).toEqual([
      text("h"),
      text("ell", color),
      caret("1"),
      text("o"),
    ]);
  });

  it("shows several people at once, in text order", () => {
    const pieces = buildPieces("abcdef", [
      { peer: "1", start: 4, end: 4 },
      { peer: "2", start: 1, end: 1 },
    ]);
    expect(pieces).toEqual([text("a"), caret("2"), text("bcd"), caret("1"), text("ef")]);
  });

  it("shows two people at the same spot, in list order", () => {
    const pieces = buildPieces("ab", [
      { peer: "1", start: 1, end: 1 },
      { peer: "2", start: 1, end: 1 },
    ]);
    expect(pieces).toEqual([text("a"), caret("1"), caret("2"), text("b")]);
  });

  it("lets the first peer in the list win where selections overlap", () => {
    const pieces = buildPieces("abcdef", [
      { peer: "1", start: 0, end: 4 },
      { peer: "2", start: 2, end: 6 },
    ]);
    const highlights = pieces.filter((p) => p.kind === "text").map((p) => p.kind === "text" && p.highlight);
    expect(highlights).toEqual([colorFor("1"), colorFor("1"), colorFor("2")]); // ab, cd, ef
  });

  it("pulls positions beyond the text back inside it", () => {
    expect(buildPieces("hi", [{ peer: "1", start: 50, end: 60 }])).toEqual([text("hi"), caret("1")]);
  });

  it("never loses or repeats any of the text", () => {
    const original = "The quick brown fox";
    const pieces = buildPieces(original, [
      { peer: "1", start: 4, end: 9 },
      { peer: "2", start: 0, end: 0 },
      { peer: "3", start: 7, end: 19 },
    ]);
    expect(pieces.map((p) => (p.kind === "text" ? p.text : "")).join("")).toBe(original);
  });
});

describe("colorFor", () => {
  it("is stable for a peer and varies between peers", () => {
    expect(colorFor("12")).toBe(colorFor("12"));
    const colors = new Set(["1", "2", "3", "4", "5"].map(colorFor));
    expect(colors.size).toBeGreaterThan(2);
  });
});

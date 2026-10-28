import { describe, expect, it } from "vitest";
import { MAX_DOC_ID_LENGTH } from "@collab/shared";
import { pickDocId } from "./docId";

describe("pickDocId", () => {
  it("keeps an id the server will accept", () => {
    expect(pickDocId("meeting notes")).toBe("meeting notes");
    expect(pickDocId("a".repeat(MAX_DOC_ID_LENGTH))).toHaveLength(MAX_DOC_ID_LENGTH);
  });

  it("makes a fresh short one when there is none", () => {
    expect(pickDocId(null)).toMatch(/^[a-z0-9]{1,6}$/);
    expect(pickDocId("")).toMatch(/^[a-z0-9]{1,6}$/);
  });

  it("replaces one the server would silently ignore, which would leave the page stuck on Connecting", () => {
    const tooLong = "a".repeat(MAX_DOC_ID_LENGTH + 1);
    expect(pickDocId(tooLong)).not.toBe(tooLong);
    expect(pickDocId("bad\u0000id")).toMatch(/^[a-z0-9]{1,6}$/);
    expect(pickDocId("two\nlines")).toMatch(/^[a-z0-9]{1,6}$/);
  });

  it("gives different ids on different calls", () => {
    expect(new Set(Array.from({ length: 20 }, () => pickDocId(null))).size).toBeGreaterThan(15);
  });
});

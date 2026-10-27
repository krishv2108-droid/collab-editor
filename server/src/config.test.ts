import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

const DATABASE_URL = "postgres://localhost:5432/collab_editor";

describe("parseConfig", () => {
  it("reads the database URL and defaults the port to 8080", () => {
    expect(parseConfig({ DATABASE_URL })).toEqual({ port: 8080, databaseUrl: DATABASE_URL });
  });

  it("reads PORT", () => {
    expect(parseConfig({ DATABASE_URL, PORT: "9000" }).port).toBe(9000);
  });

  it("accepts the postgresql:// spelling", () => {
    expect(() => parseConfig({ DATABASE_URL: "postgresql://localhost/db" })).not.toThrow();
  });

  it("fails clearly when DATABASE_URL is missing", () => {
    expect(() => parseConfig({})).toThrow(/DATABASE_URL is not set/);
  });

  it("rejects a DATABASE_URL that isn't a Postgres URL", () => {
    expect(() => parseConfig({ DATABASE_URL: "mysql://localhost/db" })).toThrow(/postgres/);
  });

  it("rejects an invalid PORT", () => {
    expect(() => parseConfig({ DATABASE_URL, PORT: "abc" })).toThrow(/PORT/);
    expect(() => parseConfig({ DATABASE_URL, PORT: "70000" })).toThrow(/PORT/);
    expect(() => parseConfig({ DATABASE_URL, PORT: "80.5" })).toThrow(/PORT/);
  });
});

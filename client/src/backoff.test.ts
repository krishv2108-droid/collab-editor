import { describe, expect, it } from "vitest";
import { backoffDelay, BASE_DELAY_MS, MAX_DELAY_MS } from "./backoff";

describe("backoffDelay", () => {
  it("doubles with each attempt when there is no randomness to subtract", () => {
    const full = () => 0.999999; // the longest wait the jitter allows
    expect([0, 1, 2, 3].map((attempt) => backoffDelay(attempt, full))).toEqual([
      BASE_DELAY_MS - 1,
      BASE_DELAY_MS * 2 - 1,
      BASE_DELAY_MS * 4 - 1,
      BASE_DELAY_MS * 8 - 1,
    ]);
  });

  it("never waits less than half of the doubled time, so a retry is never instant", () => {
    expect(backoffDelay(0, () => 0)).toBe(BASE_DELAY_MS / 2);
    expect(backoffDelay(3, () => 0)).toBe((BASE_DELAY_MS * 8) / 2);
  });

  it("stops growing at the cap, however many attempts have failed", () => {
    for (const attempt of [10, 50, 5000]) {
      expect(backoffDelay(attempt, () => 0.999999)).toBeLessThanOrEqual(MAX_DELAY_MS);
      expect(backoffDelay(attempt, () => 0)).toBe(MAX_DELAY_MS / 2);
    }
  });

  it("spreads clients out: different random numbers give different waits", () => {
    const waits = new Set([0, 0.25, 0.5, 0.75].map((r) => backoffDelay(4, () => r)));
    expect(waits.size).toBe(4);
  });
});

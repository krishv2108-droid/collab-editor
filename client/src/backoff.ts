/** The first retry waits about this long; each failed attempt doubles it, up to the cap. */
export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 15_000;

/**
 * How long to wait before reconnect attempt number `attempt` (0 for the first retry).
 * The wait doubles each time so a server that is down isn't hammered, and is randomised
 * between half and all of that wait ("jitter"): if the server restarts, every open tab
 * lost its connection at the same instant, and without jitter they would all come back
 * at the same instant too. `random` returns [0, 1) and exists so tests can fix it.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
}

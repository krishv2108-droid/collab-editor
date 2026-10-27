import { del, insert, normalize, retain, type OpComponent, type Operation } from "./operation";

/** Test helpers: seeded randomness, so a failing fuzz run can be reproduced. */

export type Rng = () => number;

/** mulberry32: a tiny deterministic random number generator returning [0, 1). */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function randomText(rng: Rng, maxLength: number, alphabet = "abc"): string {
  const length = randomInt(rng, 0, maxLength);
  let text = "";
  for (let i = 0; i < length; i++) text += alphabet[randomInt(rng, 0, alphabet.length - 1)];
  return text;
}

/** A random valid operation for `text`: mixes retains, deletes and inserts. */
export function randomOperation(rng: Rng, text: string): Operation {
  const parts: OpComponent[] = [];
  let position = 0;
  while (position < text.length) {
    const roll = rng();
    if (roll < 0.35) {
      const count = randomInt(rng, 1, Math.min(4, text.length - position));
      parts.push(retain(count));
      position += count;
    } else if (roll < 0.65) {
      const count = randomInt(rng, 1, Math.min(4, text.length - position));
      parts.push(del(count));
      position += count;
    } else {
      parts.push(insert(randomText(rng, 3, "xyz") || "x"));
    }
  }
  if (rng() < 0.4) parts.push(insert(randomText(rng, 3, "xyz") || "x"));
  return normalize(parts);
}

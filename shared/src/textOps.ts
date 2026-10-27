/**
 * A single flat edit: "at `index`, remove `deleteCount` characters, then put
 * `insert` there". Only used as the first step of diffToOperation; everything
 * else works with the richer `Operation` type in operation.ts.
 */
export interface TextOp {
  index: number;
  deleteCount: number;
  insert: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Works out the one edit that turns `oldText` into `newText`, or null if
 * they are identical. Trims the shared start and the shared end; whatever is
 * left in the middle is the change.
 */
export function diffToOp(oldText: string, newText: string): TextOp | null {
  if (oldText === newText) return null;

  const maxPrefix = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++;
  // Don't cut an emoji (a two-unit "surrogate pair") in half.
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--;

  // The suffix must not overlap the prefix, or "aa" -> "aaa" would double count.
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--;

  return {
    index: prefix,
    deleteCount: oldText.length - prefix - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}

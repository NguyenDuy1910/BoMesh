/**
 * Deterministic pseudo-random numbers for pending seeds: the same key always
 * gives the same number, so a seeded screen reads the same on every reload.
 * Not for anything secret.
 */

/** FNV-1a over the key: an unsigned 32-bit integer. */
export function seededInteger(key: string): number {
  let result = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    result = Math.imul(result ^ key.charCodeAt(index), 16777619);
  }
  return result >>> 0;
}

/** A number in [0, 1) for the key. */
export function seededUnit(key: string): number {
  return seededInteger(key) / 4294967296;
}

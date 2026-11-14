/**
 * Find in the map (preview `features/home.js`): every typed word must start a word of the name. Words typed with
 * Vietnamese marks match those marks exactly ("đơn" finds "Đơn xin…", not "động"); words typed without marks match any
 * ("don" finds both).
 */
import type { AtlasCollection } from "./layout";

const WORD = /[\p{L}\p{N}]/u;
const hasMarks = (t: string) => /[^\u0000-\u007f]/.test(t);
const lower = (s: string) => s.normalize("NFC").toLowerCase();
/** Lower-case, mark-free; one character per character so match offsets map back to the original. */
export const fold = (s: string) =>
  lower(s).replace(/[^\u0000-\u007f]/g, (ch) =>
    ch === "đ"
      ? "d"
      : ch
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .charAt(0) || ch,
  );

export const queryWords = (q: string) =>
  lower(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** [start, end) of every word-start occurrence of each word, or null when a word is missing. */
export function wordHits(text: string, words: readonly string[]): [number, number][] | null {
  const s = text.normalize("NFC");
  const plain = fold(s);
  const low = lower(s);
  const out: [number, number][] = [];
  for (const w of words) {
    const hay = hasMarks(w) ? low : plain;
    const needle = hasMarks(w) ? w : fold(w);
    let i = 0;
    let found = false;
    while ((i = hay.indexOf(needle, i)) !== -1) {
      if (i === 0 || !WORD.test(hay[i - 1])) {
        out.push([i, i + needle.length]);
        found = true;
      }
      i += needle.length;
    }
    if (!found) return null;
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** The text split into plain and matched runs, for highlighting. */
export function splitMatches(text: string, words: readonly string[]): { text: string; hit: boolean }[] {
  const s = text.normalize("NFC");
  const hits = words.length ? wordHits(s, words) : null;
  if (!hits) return [{ text: s, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of hits) {
    if (a < at) continue;
    if (a > at) out.push({ text: s.slice(at, a), hit: false });
    out.push({ text: s.slice(a, b), hit: true });
    at = b;
  }
  if (at < s.length) out.push({ text: s.slice(at), hit: false });
  return out;
}

/**
 * Search narrows the tree: a collection whose name matches keeps everything under it; otherwise only containers with
 * matching documents (`byContainer`: matched document names per container) and the path to them, `direct` set to the
 * matched documents.
 */
export function narrowTree(
  c: AtlasCollection,
  words: readonly string[],
  byContainer: ReadonlyMap<string, readonly string[]>,
): AtlasCollection | null {
  if (wordHits(c.displayName, words)) return c;
  const kids = c.kids.map((k) => narrowTree(k, words, byContainer)).filter((k): k is AtlasCollection => !!k);
  const docs = byContainer.get(c.name)?.length ?? 0;
  if (!docs && !kids.length) return null;
  return { ...c, kids, direct: docs, count: docs + kids.reduce((a, k) => a + k.count, 0) };
}

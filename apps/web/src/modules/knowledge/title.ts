/**
 * A readable title for a machine-made file name.
 *
 * Crawlers and download tools produce names like
 * `tai-lieu-doi-moi-co-che-quan-ly-d0a8b3fc226bc64` — a slug with a hex id welded on. Shown raw
 * it is unreadable, and it is the single most prominent thing on a document card or preview.
 * So for display we drop a trailing hash and turn separators into spaces.
 *
 * Only names that are *clearly* machine-made are touched: a real title someone typed keeps its
 * spaces, capitals and punctuation exactly. The stored `displayName` never changes — this is a
 * rendering decision, and renaming the document overrides it.
 *
 * Its own module so it stays free of `@/` imports and can be unit-tested directly.
 */
export function readableTitle(raw: string): string {
  const name = raw.trim();
  // A real title: it has spaces, or no separators to speak of. Leave it alone.
  if (/\s/.test(name) || !/[-_]/.test(name)) return name;
  // Hex tail of 7+ chars, as content-addressed downloads append (`…-d0a8b3fc226bc64`).
  const slug = name.replace(/[-_][0-9a-f]{7,}$/i, "");
  const words = slug.split(/[-_]+/).filter(Boolean);
  // Too few parts to be a slug (`v1-final`), or someone's deliberate kebab-case identifier.
  if (words.length < 3) return name;
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

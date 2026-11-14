/**
 * Document types the backend derives from the MIME type rather than from what the document is
 * *for* (`item_store.document_type_for_content_type`). They name a **format**, so `RESOURCE_KINDS`
 * has no entry and `kindMeta` would fall back to title-casing the key — which is how a `.pptx`
 * ends up labelled "Plain text".
 */
const FORMAT_TYPES: ReadonlySet<string> = new Set(["plain_text", "pdf", "markdown", "image", "audio", "video", "archive"]);

/**
 * What to call a document in one phrase: its purpose when that is known ("Policy", "Lecture
 * slides"), else its format ("Slides", "Spreadsheet", "PDF").
 *
 * `documentType` is the stored type; `kindIsSpecific` says whether the kind resolved to a real
 * resource kind rather than the "reference" catch-all. Pure, so it is unit-tested directly.
 */
export function pickTypeLabel(
  documentType: string | undefined,
  { kindLabel, formatLabel, kindIsSpecific }: { kindLabel: string; formatLabel: string; kindIsSpecific: boolean },
): string {
  // A purpose someone (or a connector) actually set outranks the format.
  if (documentType && !FORMAT_TYPES.has(documentType)) return kindLabel;
  // Otherwise the kind was guessed from the title: trust it only when it found something.
  return kindIsSpecific ? kindLabel : formatLabel;
}

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

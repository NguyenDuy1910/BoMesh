/**
 * A content reference: blocks of one Structured Document of one revision of a document (openapi `Citation`,
 * `ContentReference`, stream `bomesh:document_citation`, `tool_completed.sources`). It carries what a reader
 * shows at once (`quote`, `location`, `pageNumber`); opening it is one GetItemContent call (`revision`,
 * `version` = `structureVersion`, `anchor` = `refs[0]`), never the original file.
 *
 * Pure and dependency-free so it runs under `node --test`.
 */

export interface Reference {
  /** `workspaces/{w}/items/{item}`. */
  item: string;
  /** `workspaces/{w}/items/{item}/revisions/{n}`. */
  revision: string;
  /** GetItemContent `version`. */
  structureVersion: string;
  /** Cited blocks (`texts/31`, `tables/0` …), in document order; at least one. */
  refs: readonly string[];
  /** Plain text of the cited blocks (≤ 280 characters). */
  quote: string;
  /** Heading path, sheet, slide or page label; may be empty. */
  location: string;
  /** Page of the first block in the Original preview, when the parsed bytes are the previewed ones. */
  pageNumber?: number;
}

/** What the API calls these fields (Citation, ContentReference): every field optional. */
export interface ReferenceFields {
  item?: string;
  revision?: string;
  structureVersion?: string;
  refs?: readonly string[];
  quote?: string;
  location?: string;
  pageNumber?: number;
}

/** A complete reference from API fields, or `null` when it can't be opened (no item, revision, version or block). */
export function referenceOf(fields: ReferenceFields | null | undefined): Reference | null {
  const refs = (fields?.refs ?? []).filter(Boolean);
  if (!fields?.item || !fields.revision || !fields.structureVersion || !refs.length) return null;
  const pageNumber = typeof fields.pageNumber === "number" && fields.pageNumber > 0 ? fields.pageNumber : undefined;
  return {
    item: fields.item,
    revision: fields.revision,
    structureVersion: fields.structureVersion,
    refs,
    quote: fields.quote ?? "",
    location: fields.location ?? "",
    ...(pageNumber ? { pageNumber } : {}),
  };
}

/** Wire (snake_case) fields of a stream citation or a found-source card. */
export interface WireReferenceFields {
  item?: string;
  revision?: string;
  structure_version?: string;
  refs?: readonly string[];
  quote?: string;
  location?: string;
  page?: number | null;
}

/** A reference from a stream annotation's `citation` or a `tool_completed` source. */
export function referenceOfWire(fields: WireReferenceFields | null | undefined): Reference | null {
  return referenceOf(fields && { item: fields.item, revision: fields.revision, structureVersion: fields.structure_version, refs: fields.refs, quote: fields.quote, location: fields.location, pageNumber: fields.page ?? undefined });
}

/** Whether two references name the same blocks of the same Structured Document. */
export function sameReference(a: Reference, b: Reference): boolean {
  return a.item === b.item && a.structureVersion === b.structureVersion && a.refs.join("\n") === b.refs.join("\n");
}

/** Where the cited blocks are, for people: "13. Ngày phê duyệt · trang 4" (either part may be missing). */
export function locationLabel(reference: Pick<Reference, "location" | "pageNumber"> | null | undefined): string {
  if (!reference) return "";
  return [reference.location.trim(), reference.pageNumber ? `trang ${reference.pageNumber}` : ""].filter(Boolean).join(" · ");
}

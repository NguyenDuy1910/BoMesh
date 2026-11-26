/**
 * A content reference: blocks of one Structured Document of one revision of a document (openapi `Citation`,
 * `ContentReference`, stream `bomesh:document_citation`, `tool_completed.sources`). It carries what a reader
 * shows at once (`quote`, `location`) and where to mark it (`highlights`); opening it is the Original preview of
 * `revision` (GetItemPreview `?revision=`) with `highlights` drawn — boxes on PDF pages, cell ranges of a grid —
 * or, for a text representation (no highlights), `quote` marked in the text (document_viewer.md "Citations open
 * in the Original").
 *
 * Pure and dependency-free so it runs under `node --test`.
 */

import type { components } from "../../../lib/api/schema";

/** openapi `Highlight`: a page of a PDF representation (`pageNumber`, `boxes`) or a cell range of a TABLE sheet (`sheet`, `cellRange`). */
export type Highlight = components["schemas"]["Highlight"];
/** openapi `HighlightBox`: fractions 0..1 of the page from its top-left corner. */
export type HighlightBox = components["schemas"]["HighlightBox"];

export interface Reference {
  /** `workspaces/{w}/items/{item}`. */
  item: string;
  /** `workspaces/{w}/items/{item}/revisions/{n}`. */
  revision: string;
  /** The Structured Document the blocks belong to. */
  structureVersion: string;
  /** Cited blocks (`texts/31`, `tables/0` …), in document order; at least one. */
  refs: readonly string[];
  /** Plain text of the cited blocks (≤ 280 characters). */
  quote: string;
  /** Heading path, sheet, slide or page label; may be empty. */
  location: string;
  /** Where the blocks are in the Original preview of `revision`, in document order; empty when it shows text or none was located. */
  highlights: readonly Highlight[];
}

/** What the API calls these fields (Citation, ContentReference): every field optional. */
export interface ReferenceFields {
  item?: string;
  revision?: string;
  structureVersion?: string;
  refs?: readonly string[];
  quote?: string;
  location?: string;
  highlights?: readonly Highlight[];
}

/** A Highlight in one of its two forms: a page from 1, or a sheet with a range. */
const usable = (h: Highlight | null | undefined): h is Highlight => !!h && ((typeof h.pageNumber === "number" && h.pageNumber >= 1) || (!!h.sheet && !!h.cellRange));

/** A complete reference from API fields, or `null` when it can't be opened (no item, revision, version or block). */
export function referenceOf(fields: ReferenceFields | null | undefined): Reference | null {
  const refs = (fields?.refs ?? []).filter(Boolean);
  if (!fields?.item || !fields.revision || !fields.structureVersion || !refs.length) return null;
  return {
    item: fields.item,
    revision: fields.revision,
    structureVersion: fields.structureVersion,
    refs,
    quote: fields.quote ?? "",
    location: fields.location ?? "",
    highlights: (fields.highlights ?? []).filter(usable),
  };
}

/** Wire (snake_case) fields of a stream citation or a found-source card; `highlights` keep their camelCase keys. */
export interface WireReferenceFields {
  item?: string;
  revision?: string;
  structure_version?: string;
  refs?: readonly string[];
  quote?: string;
  location?: string;
  highlights?: readonly Highlight[] | null;
}

/** A reference from a stream annotation's `citation` or a `tool_completed` source. */
export function referenceOfWire(fields: WireReferenceFields | null | undefined): Reference | null {
  return referenceOf(fields && { item: fields.item, revision: fields.revision, structureVersion: fields.structure_version, refs: fields.refs, quote: fields.quote, location: fields.location, highlights: fields.highlights ?? undefined });
}

/** Whether two references name the same blocks of the same Structured Document. */
export function sameReference(a: Reference, b: Reference): boolean {
  return a.item === b.item && a.structureVersion === b.structureVersion && a.refs.join("\n") === b.refs.join("\n");
}

/** The page of the first Highlight that names one. */
export function highlightPage(highlights: readonly Highlight[] | null | undefined): number | undefined {
  return highlights?.find((h) => typeof h.pageNumber === "number" && h.pageNumber >= 1)?.pageNumber;
}

/** Where the cited blocks are, for people: "13. Ngày phê duyệt · trang 4" (either part may be missing). */
export function locationLabel(reference: { location?: string; highlights?: readonly Highlight[] | null } | null | undefined): string {
  if (!reference) return "";
  const page = highlightPage(reference.highlights);
  return [reference.location?.trim() ?? "", page ? `trang ${page}` : ""].filter(Boolean).join(" · ");
}

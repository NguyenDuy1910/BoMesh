import { isMessageItem, isOutputTextPart, orderedTurnItems } from "./message-stream.ts";
import { documentHref } from "../knowledge/preview.ts";
import { DOCUMENT_CITATION_TYPE } from "./types.ts";
import type { CitationReference, CitationSpan, TurnState } from "./types";

/** One cited passage of a source document. */
export interface AnswerPassage {
  /** The reader-facing number this passage was cited under. */
  number: number;
  chunkId: string;
  internalUrl: string;
  locator?: string;
  page?: number;
  spans: CitationSpan[];
}

/**
 * One document an answer cites. A file cited for several passages is still
 * one source to the reader: it is listed once, and its passages travel with it.
 */
export interface AnswerSource {
  /** Stable per document, so the list and the open panel agree on identity. */
  id: string;
  /** The stable one-based marker the reader clicks, in first-cited order. */
  index: number;
  title: string;
  itemId: string;
  /** The first cited passage; the panel opens here. */
  chunkId: string;
  /** Primary internal viewer target. */
  internalUrl: string;
  /** Native source target, when the provider supplied one. */
  originalUrl?: string;
  locator?: string;
  origin?: string;
  /** The first cited page, when the source recorded one. */
  page?: number;
  /** Citations are annotations on answer content, so every entry is used. */
  used: true;
  spans: CitationSpan[];
  /** Every cited passage of this document, in first-cited order. */
  passages: AnswerPassage[];
}

/** Collect citations from output-text annotations, never from stream events. */
export function answerSources(turn: TurnState | undefined): AnswerSource[] {
  if (!turn) return [];
  const sources = new Map<string, AnswerSource>();

  for (const { item } of orderedTurnItems(turn)) {
    if (!isMessageItem(item)) continue;
    for (const part of item.content) {
      if (!isOutputTextPart(part)) continue;
      for (const annotation of part.annotations) {
        if (annotation.type !== DOCUMENT_CITATION_TYPE || !annotation.citation) continue;
        const cited = toAnswerSource(annotation.citation);
        if (!cited) continue;
        const existing = sources.get(cited.id);
        sources.set(cited.id, existing ? mergeSource(existing, cited) : cited);
      }
    }
  }
  // The backend numbers citations by first use so the inline chip and this
  // list always agree. First-appearance order here is the fallback for
  // conversations saved before citations carried a number.
  return [...sources.values()].map((source, position) => {
    const index = source.index || position + 1;
    return {
      ...source,
      index,
      passages: source.passages.map((passage) => ({ ...passage, number: passage.number || index })),
    };
  });
}

function toAnswerSource(citation: CitationReference): AnswerSource | null {
  const itemId = citation.item_id?.trim();
  const chunkId = citation.chunk_id?.trim();
  if (!itemId || !chunkId) return null;
  const spans = citation.spans ?? [];
  // The reader route, not the API path a stored citation may carry: the
  // document reader resolves the passage through the authorized focus endpoint.
  const internalUrl = documentHref(itemId, [chunkId]);
  const originalUrl = citation.original_url?.trim() || citation.source?.url?.trim() || undefined;
  // Zero means unnumbered; collection order fills it in as the fallback.
  const number = typeof citation.number === "number" && citation.number > 0 ? citation.number : 0;
  const locator = locatorLabel(citation, spans);
  const page = citedPage(citation, spans);
  return {
    id: `document:${itemId}`,
    index: number,
    itemId,
    chunkId,
    title: citation.title?.trim() || citation.source?.provider?.trim() || "Untitled source",
    internalUrl,
    originalUrl,
    locator,
    origin: citation.source?.provider?.trim() || undefined,
    page,
    used: true,
    spans,
    passages: [{ number, chunkId, internalUrl, locator, page, spans }],
  };
}

function mergeSource(existing: AnswerSource, next: AnswerSource): AnswerSource {
  const passages = [...existing.passages];
  for (const passage of next.passages) {
    const known = passages.findIndex((candidate) => candidate.chunkId === passage.chunkId);
    if (known < 0) passages.push(passage);
    else if (passage.spans.length && !passages[known].spans.length) passages[known] = passage;
  }
  return {
    ...existing,
    // Conversations saved before per-document numbering cite one file under
    // several numbers; the document keeps the first.
    index: existing.index || next.index,
    title: existing.title || next.title,
    originalUrl: existing.originalUrl ?? next.originalUrl,
    locator: existing.locator ?? next.locator,
    origin: existing.origin ?? next.origin,
    page: existing.page ?? next.page,
    spans: existing.spans.length ? existing.spans : next.spans,
    passages,
  };
}

/**
 * Pages come from spans when ingestion captured element geometry, and from the
 * chunk's page range otherwise. Retrieval carries the range even where span
 * geometry is not part of the indexed payload, so both are read.
 */
function citedPages(citation: CitationReference, spans: CitationSpan[]): number[] {
  const pages = spans
    .map((span) => span.page)
    .filter((page): page is number => typeof page === "number" && page >= 1);
  if (pages.length) return [...new Set(pages)].sort((left, right) => left - right);
  const start = citation.page_start;
  const end = citation.page_end ?? start;
  if (typeof start !== "number" || typeof end !== "number") return [];
  return start === end ? [start] : [start, end];
}

function citedPage(citation: CitationReference, spans: CitationSpan[]): number | undefined {
  return citedPages(citation, spans)[0];
}

function locatorLabel(
  citation: CitationReference,
  spans: CitationSpan[],
): string | undefined {
  const pages = citedPages(citation, spans);
  const page = pages.length
    ? (pages.length === 1 ? String(pages[0]) : `${pages[0]}–${pages[pages.length - 1]}`)
    : undefined;
  const values = [
    // A spreadsheet's "page" is its sheet.
    page === undefined
      ? undefined
      : /\.(?:xlsx|xlsm|xls|csv|tsv)$/i.test(citation.title ?? "") ? `sheet ${page}` : `p. ${page}`,
    citation.section?.trim() || undefined,
  ].filter((value): value is string => Boolean(value));
  return values.length ? values.join(" · ") : undefined;
}

export function sourcesLabel(sources: readonly AnswerSource[]): string {
  return `${sources.length} ${sources.length === 1 ? "source" : "sources"}`;
}

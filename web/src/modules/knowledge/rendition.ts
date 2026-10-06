/**
 * The whole-document rendition: the parse ingestion already made, stored as
 * typed blocks beside the page previews and read straight from storage.
 *
 * See `backend/docs_design/document_viewer.md`. Block ids are the parts'
 * `element_id`s, the same values citation spans point at, which is what lets a
 * citation highlight exactly what it quotes.
 */
import { resolveHighlightRange, type HighlightRange } from "./highlight.ts";
import type { PreviewRendition, ViewerCitation, ViewerCitationSpan, ViewerElement } from "./types";

interface BlockBase {
  id: string;
  /** Source page; the sheet number for a spreadsheet. */
  page: number | null;
}

export interface HeadingBlock extends BlockBase {
  kind: "heading";
  level: number;
  text: string;
}

export interface ParagraphBlock extends BlockBase {
  kind: "paragraph";
  text: string;
}

export interface TableBlock extends BlockBase {
  kind: "table";
  caption: string | null;
  columns: string[];
  rows: string[][];
  /** Rows in the source; more than `rows.length` when the table was cut. */
  total_rows: number;
}

export interface CodeBlock extends BlockBase {
  kind: "code";
  text: string;
  language: string | null;
}

export interface ImageBlock extends BlockBase {
  kind: "image";
  /** Caption, OCR text and description, joined. */
  text: string;
}

export interface LinkBlock extends BlockBase {
  kind: "link";
  text: string;
  url: string;
}

export type RenditionBlock = HeadingBlock | ParagraphBlock | TableBlock | CodeBlock | ImageBlock | LinkBlock;

export interface DocumentRendition {
  schema: 1;
  /** A storage bound was reached; the rest of the file is only in the original. */
  truncated: boolean;
  blocks: RenditionBlock[];
}

/** The rendition could not be read; a retry may succeed with a fresh URL. */
export class RenditionLoadError extends Error {}

const BLOCK_KINDS: Record<RenditionBlock["kind"], true> = {
  heading: true,
  paragraph: true,
  table: true,
  code: true,
  image: true,
  link: true,
};

/** Recently read documents. Stepping between citations never downloads twice. */
const CACHE_LIMIT = 8;
const cache = new Map<string, Promise<DocumentRendition>>();

/**
 * Read one document version's rendition.
 *
 * Concurrent callers share one download and its parsed result; a failed
 * download is forgotten so the next call retries it. Aborting `signal` only
 * stops this caller waiting — the shared download continues for the others.
 */
export function loadRendition(
  itemId: string,
  ref: Pick<PreviewRendition, "url" | "version">,
  signal?: AbortSignal,
): Promise<DocumentRendition> {
  const key = `${itemId}:${ref.version}`;
  let pending = cache.get(key);
  if (pending) {
    // Most recently used goes last; eviction takes the first.
    cache.delete(key);
    cache.set(key, pending);
  } else {
    const download: Promise<DocumentRendition> = fetchRendition(ref.url).catch((cause: unknown) => {
      if (cache.get(key) === download) cache.delete(key);
      throw cause;
    });
    pending = download;
    cache.set(key, download);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return signal ? abortable(pending, signal) : pending;
}

async function fetchRendition(url: string): Promise<DocumentRendition> {
  // Storage serves it with `Content-Encoding: gzip`, so the body arrives decoded.
  const response = await fetch(url);
  if (!response.ok) throw new RenditionLoadError(`The document text could not be loaded (${response.status}).`);
  return parseRendition(await response.json());
}

function parseRendition(value: unknown): DocumentRendition {
  const body = value as { schema?: unknown; truncated?: unknown; blocks?: unknown } | null;
  if (!body || typeof body !== "object" || body.schema !== 1 || !Array.isArray(body.blocks)) {
    throw new RenditionLoadError("The document text is in a format this viewer does not read.");
  }
  return {
    schema: 1,
    truncated: body.truncated === true,
    blocks: (body.blocks as unknown[]).filter(isBlock),
  };
}

function isBlock(value: unknown): value is RenditionBlock {
  const block = value as Partial<RenditionBlock> | null;
  if (!block || typeof block !== "object" || typeof block.id !== "string" || !Object.hasOwn(BLOCK_KINDS, block.kind ?? "")) return false;
  return block.kind !== "table" || (Array.isArray(block.columns) && Array.isArray(block.rows));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

/** Everything a block says, for matching against a passage or a search. */
export function blockText(block: RenditionBlock): string {
  if (block.kind !== "table") return block.text;
  return [block.caption ?? "", ...block.columns, ...block.rows.map((row) => row.join(" "))].join(" ");
}

export interface CitedTargets {
  blockIds: Set<string>;
  /** Cited row indexes of each cited table, by block id. */
  rows: Map<string, Set<number>>;
}

const FALLBACK_PREFIX = 60;
const MIN_CELL_LENGTH = 2;

/**
 * What a citation points at in the rendition.
 *
 * Span element ids name the cited blocks. A passage indexed before spans
 * carried ids falls back to the first block containing its opening words. In
 * a cited table, a row is cited when its first cell and at least one other
 * cell (or its only cell) appear in the passage as whole values — "53" is not
 * quoted by "537".
 */
export function citedTargets(
  rendition: DocumentRendition,
  citation: Pick<ViewerCitation, "spans"> | null | undefined,
  chunkText: string | null | undefined,
): CitedTargets {
  const spanIds = new Set<string>();
  for (const span of citation?.spans ?? []) if (span.element_id) spanIds.add(span.element_id);

  const passage = normalize(chunkText ?? "");
  const cited = rendition.blocks.filter((block) => spanIds.has(block.id));
  if (!cited.length && passage) {
    const opening = passage.slice(0, FALLBACK_PREFIX);
    const match = rendition.blocks.find((block) => normalize(blockText(block)).includes(opening));
    if (match) cited.push(match);
  }

  const rows = new Map<string, Set<number>>();
  for (const block of cited) {
    if (block.kind !== "table" || !passage) continue;
    const matched = new Set<number>();
    block.rows.forEach((row, index) => {
      if (rowInPassage(row, passage)) matched.add(index);
    });
    if (matched.size) rows.set(block.id, matched);
  }
  return { blockIds: new Set(cited.map((block) => block.id)), rows };
}

function rowInPassage(row: string[], passage: string): boolean {
  const cells = row.map(normalize).filter((cell) => cell.length >= MIN_CELL_LENGTH);
  const [first, ...others] = cells;
  if (first === undefined || !quotes(passage, first)) return false;
  return !others.length || others.some((cell) => quotes(passage, cell));
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** Whether `value` occurs in `passage` not as part of a longer word or number. */
function quotes(passage: string, value: string): boolean {
  for (let at = passage.indexOf(value); at >= 0; at = passage.indexOf(value, at + 1)) {
    const before = passage[at - 1];
    const after = passage[at + value.length];
    if ((!before || !WORD_CHARACTER.test(before) || !WORD_CHARACTER.test(value[0]!))
      && (!after || !WORD_CHARACTER.test(after) || !WORD_CHARACTER.test(value.at(-1)!))) return true;
  }
  return false;
}

function normalize(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim().toLowerCase();
}

const SPREADSHEET_TYPES: Record<string, true> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.ms-excel": true,
  "text/csv": true,
  "text/tab-separated-values": true,
};

/** Whether a MIME type is a sheet, whose "pages" are sheets. */
export function isSpreadsheetType(contentType: string): boolean {
  return SPREADSHEET_TYPES[contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""] === true;
}

/** One cited passage as a reader arrived at it: where it is, and what it says. */
export interface PassageCitation {
  citation?: Pick<ViewerCitation, "spans"> | null;
  chunkText?: string | null;
}

export interface CitedMark {
  /** The passage the reader is on, rather than another cited one. */
  focus: boolean;
  /** The quoted part of a text block; absent marks the whole block. */
  range?: HighlightRange;
  /** Cited row indexes of a table. */
  rows?: Set<number>;
}

export interface CitedMarks {
  /** What to mark in each cited block, by block id. */
  blocks: Map<string, CitedMark>;
  /** The first block of the focused passage, in document order: scroll here. */
  focusBlockId?: string;
}

/**
 * Every cited passage of one document, as evidence marks on its blocks.
 *
 * A span's element-local offsets mark exactly the quoted words when they fit
 * the block's text; a passage that is part of one block is found by its text;
 * anything else marks the whole block rather than guessing a range. When two
 * passages cite the same block, the focused one decides the mark.
 */
export function citedMarks(
  rendition: DocumentRendition,
  passages: readonly PassageCitation[],
  focusIndex: number,
): CitedMarks {
  const blocks = new Map<string, CitedMark>();
  const order = new Map(rendition.blocks.map((block, index) => [block.id, index]));
  let focusBlockId: string | undefined;
  // The focused passage goes first so it claims the blocks it shares.
  const ordered = passages
    .map((passage, index) => ({ passage, focus: index === focusIndex }))
    .sort((left, right) => Number(right.focus) - Number(left.focus));

  for (const { passage, focus } of ordered) {
    const targets = citedTargets(rendition, passage.citation, passage.chunkText);
    for (const block of rendition.blocks) {
      if (!targets.blockIds.has(block.id) || blocks.has(block.id)) continue;
      const spans = (passage.citation?.spans ?? []).filter((span) => span.element_id === block.id);
      const rows = targets.rows.get(block.id);
      blocks.set(block.id, {
        focus,
        ...(block.kind === "table" ? (rows ? { rows } : {}) : textRange(markableText(block), spans, passage.chunkText)),
      });
      if (focus && (focusBlockId === undefined || order.get(block.id)! < order.get(focusBlockId)!)) focusBlockId = block.id;
    }
  }
  return { blocks, focusBlockId };
}

/** The text a block shows, which is what offsets and marks refer to. */
export function markableText(block: Exclude<RenditionBlock, TableBlock>): string {
  return block.kind === "link" ? block.text || block.url : block.text;
}

function textRange(text: string, spans: ViewerCitationSpan[], chunkText: string | null | undefined): { range?: HighlightRange } {
  const focus = { chunk_text: chunkText ?? "" };
  const ranges = spans
    .map((span) => resolveHighlightRange(text, focus, span))
    .filter((range): range is HighlightRange => range !== undefined && range.end > range.start);
  if (ranges.length) {
    return { range: { start: Math.min(...ranges.map((range) => range.start)), end: Math.max(...ranges.map((range) => range.end)) } };
  }
  const quoted = chunkText?.trim() ? resolveHighlightRange(text, { chunk_text: chunkText.trim() }) : undefined;
  return quoted && quoted.end > quoted.start ? { range: quoted } : {};
}

export interface OutlineEntry {
  id: string;
  title: string;
  /** 1 for a top-level heading, 2 for the one under it. */
  level: 1 | 2;
}

/** At most this many outline entries; a longer outline stops being a map. */
const OUTLINE_LIMIT = 80;

/**
 * The document's headings for "On this page": the top two levels present.
 * A document whose headings all sit at level 3 still gets an outline.
 */
export function renditionOutline(rendition: DocumentRendition): OutlineEntry[] {
  const headings = rendition.blocks.filter(
    (block): block is HeadingBlock => block.kind === "heading" && block.text.trim().length > 0,
  );
  if (!headings.length) return [];
  const top = Math.min(...headings.map((heading) => heading.level));
  return headings
    .filter((heading) => heading.level <= top + 1)
    .slice(0, OUTLINE_LIMIT)
    .map((heading) => ({
      id: heading.id,
      title: heading.text.trim().replaceAll(/\s+/g, " "),
      level: heading.level === top ? 1 : 2,
    }));
}

export interface RenditionPage {
  /** Source page (sheet for a spreadsheet); null when the parse had none. */
  page: number | null;
  blocks: RenditionBlock[];
}

/**
 * Blocks grouped into the pages they came from, in reading order. A block
 * without a page stays on the page before it, so a document with no page
 * numbers at all is one page.
 */
export function renditionPages(rendition: DocumentRendition): RenditionPage[] {
  const pages: RenditionPage[] = [];
  for (const block of rendition.blocks) {
    const current = pages.at(-1);
    if (current && (block.page === null || block.page === current.page)) {
      current.blocks.push(block);
    } else if (current && current.page === null) {
      // Blocks before the first numbered one belong to that page.
      current.page = block.page;
      current.blocks.push(block);
    } else {
      pages.push({ page: block.page, blocks: [block] });
    }
  }
  return pages;
}

/**
 * A document indexed before renditions existed, read from the passages the
 * index holds (the viewer's `elements`): each passage a paragraph under its
 * section heading. It is the indexed text, not the file's layout.
 */
export function elementsRendition(elements: readonly ViewerElement[]): DocumentRendition {
  const blocks: RenditionBlock[] = [];
  let section = "";
  for (const element of elements) {
    const heading = element.section?.trim() ?? "";
    if (heading && heading !== section) {
      blocks.push({
        id: `section:${element.element_id}`,
        kind: "heading",
        level: Math.min(4, Math.max(1, element.section_path.length || 1)),
        text: heading,
        page: element.page ?? null,
      });
    }
    section = heading || section;
    if (element.text.trim()) blocks.push({ id: element.element_id, kind: "paragraph", text: element.text, page: element.page ?? null });
  }
  return { schema: 1, truncated: false, blocks };
}

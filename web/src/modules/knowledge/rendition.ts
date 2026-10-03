/**
 * The whole-document rendition: the parse ingestion already made, stored as
 * typed blocks beside the page previews and read straight from storage.
 *
 * See `backend/docs_design/document_viewer.md`. Block ids are the parts'
 * `element_id`s, the same values citation spans point at, which is what lets a
 * citation highlight exactly what it quotes.
 */
import type { PreviewRendition, ViewerCitation } from "./types";

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

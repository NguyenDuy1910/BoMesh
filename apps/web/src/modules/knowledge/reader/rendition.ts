/**
 * The whole-document rendition: the parse ingestion already made, stored as
 * typed blocks beside the page previews and read straight from storage
 * (`backend/docs_design/document_viewer.md`). Block ids are the parse's
 * element ids, the same values `ItemPassage.elementIds` name, which is what
 * lets a citation mark exactly the text it quotes.
 */

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
export type TextBlock = Exclude<RenditionBlock, TableBlock>;

export interface DocumentRendition {
  schema: 1;
  /** A storage bound was reached; the rest of the file is only in the original. */
  truncated: boolean;
  blocks: RenditionBlock[];
}

/** `ItemContent.rendition`: where to read one revision's rendition. */
export interface RenditionRef {
  /** Signed, short-lived URL. */
  uri: string;
  /** Rendition format version. */
  version: number | string;
  /** Revision name the rendition belongs to (part of the cache key). */
  revision?: string;
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
 * Read one document revision's rendition.
 *
 * Concurrent callers share one download and its parsed result; a failed
 * download is forgotten so the next call retries it. Aborting `signal` only
 * stops this caller waiting — the shared download continues for the others.
 */
export function loadRendition(itemId: string, ref: RenditionRef, signal?: AbortSignal): Promise<DocumentRendition> {
  const key = renditionKey(itemId, ref);
  let pending = cache.get(key);
  if (pending) {
    // Most recently used goes last; eviction takes the first.
    cache.delete(key);
    cache.set(key, pending);
  } else {
    const download: Promise<DocumentRendition> = fetchRendition(ref.uri).catch((cause: unknown) => {
      if (cache.get(key) === download) cache.delete(key);
      throw cause;
    });
    pending = download;
    cache.set(key, download);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return signal ? abortable(pending, signal) : pending;
}

/** Cache identity of a rendition: item, revision and format version (URLs are re-signed on every read). */
export function renditionKey(itemId: string, ref: Pick<RenditionRef, "version" | "revision">): string {
  return `${itemId}:${ref.revision ?? ""}:${ref.version}`;
}

async function fetchRendition(url: string): Promise<DocumentRendition> {
  // Storage serves it with `Content-Encoding: gzip`, so the body arrives decoded.
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new RenditionLoadError("The document text couldn’t be reached.");
  }
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

/** `Promise.withResolvers` is not in this project's lib (es2022), hence the executor form. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** The text a block shows, which is what marks refer to. */
export function markableText(block: TextBlock): string {
  return block.kind === "link" ? block.text || block.url : block.text;
}

/** Everything a block says, for matching against a passage or a search. */
export function blockText(block: RenditionBlock): string {
  if (block.kind !== "table") return markableText(block);
  return [block.caption ?? "", ...block.columns, ...block.rows.map((row) => row.join(" "))].join(" ");
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

/** One reader element (`ItemContent.elements`). */
export interface ContentElement {
  elementId?: string;
  kind?: "HEADING" | "PARAGRAPH" | "LIST" | "TABLE" | "IMAGE" | "CODE";
  text?: string;
  level?: number;
  pageNumber?: number;
}

/**
 * A revision without a stored rendition, read from its reader elements: the
 * indexed text under its headings, not the file's layout.
 */
export function elementsRendition(elements: readonly ContentElement[]): DocumentRendition {
  const blocks: RenditionBlock[] = [];
  elements.forEach((element, index) => {
    const text = element.text ?? "";
    if (!text.trim()) return;
    const id = element.elementId || `element-${index}`;
    const page = element.pageNumber ?? null;
    switch (element.kind) {
      case "HEADING":
        blocks.push({ id, kind: "heading", level: Math.min(4, Math.max(1, element.level ?? 1)), text, page });
        break;
      case "CODE":
        blocks.push({ id, kind: "code", text, language: null, page });
        break;
      case "IMAGE":
        blocks.push({ id, kind: "image", text, page });
        break;
      default:
        blocks.push({ id, kind: "paragraph", text, page });
    }
  });
  return { schema: 1, truncated: false, blocks };
}

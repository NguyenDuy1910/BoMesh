/**
 * The whole-document rendition of a conversation artifact's revision (`ItemRendition`,
 * `application/vnd.bomesh.document+json`): typed blocks read straight from storage. Knowledge
 * documents are shown through the preview engine's representations instead (`./preview.ts`).
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

export interface DocumentRendition {
  schema: 1;
  /** A storage bound was reached; the rest of the file is only in the original. */
  truncated: boolean;
  blocks: RenditionBlock[];
}

/** `ItemPreview.rendition`: where to read one revision's rendition. */
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
    throw new RenditionLoadError("Không tải được nội dung tài liệu.");
  }
  if (!response.ok) throw new RenditionLoadError(`Không tải được nội dung tài liệu (${response.status}).`);
  return parseRendition(await response.json());
}

function parseRendition(value: unknown): DocumentRendition {
  const body = value as { schema?: unknown; truncated?: unknown; blocks?: unknown } | null;
  if (!body || typeof body !== "object" || body.schema !== 1 || !Array.isArray(body.blocks)) {
    throw new RenditionLoadError("Trình xem chưa đọc được định dạng nội dung này.");
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

/** Everything a block says, for matching and diffing. */
export function blockText(block: RenditionBlock): string {
  if (block.kind === "link") return block.text || block.url;
  if (block.kind !== "table") return block.text;
  return [block.caption ?? "", ...block.columns, ...block.rows.map((row) => row.join(" "))].join(" ");
}

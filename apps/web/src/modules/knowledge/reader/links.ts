/**
 * Reader addresses (`/doc/<item>?rev=&ver=&ref=&quote=&loc=&hl=&q=&page=&from=&v=&ask=1`, document_viewer.md
 * "Reading (web)"). A citation opens the Reader on the Original of its revision with its passage marked: the
 * address carries the whole reference — `rev` (revision number), `ver` (structure version), one `ref` per cited
 * block, `quote`, `loc` (location) and one `hl` per Highlight (`highlightParam`) — so a shared or reloaded link
 * marks the same regions; `from` names where the reader came from (see `ReaderOrigin`).
 */

import type { Highlight, HighlightBox, Reference } from "../content/reference.ts";

/** Last path segment of a resource name, or the value itself when it is already a bare ID. */
const idOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/**
 * Where the Reader was opened from, so its trail leads back there (preview `backBtn`). Encoded in
 * `from=`: a bare conversation ID (chat citations), `home`, `map`, `search`, `contributions`,
 * `library:<saved|files>` or `space:<spaceId>`.
 */
export type ReaderOrigin =
  | { kind: "conversation"; id: string }
  | { kind: "home" | "map" | "search" | "contributions" }
  | { kind: "library"; tab: string }
  | { kind: "space"; id: string };

const PLACES: Readonly<Record<string, ReaderOrigin>> = {
  home: { kind: "home" },
  map: { kind: "map" },
  search: { kind: "search" },
  contributions: { kind: "contributions" },
};

/** `from=` value for an origin. */
export function originParam(origin: ReaderOrigin): string {
  switch (origin.kind) {
    case "conversation":
      return idOf(origin.id);
    case "library":
      return `library:${origin.tab}`;
    case "space":
      return `space:${idOf(origin.id)}`;
    default:
      return origin.kind;
  }
}

/** The origin a `from=` value names; a bare ID is a conversation. */
export function parseOrigin(from: string | undefined | null): ReaderOrigin | null {
  const value = from?.trim() ?? "";
  if (!value) return null;
  const place = PLACES[value];
  if (place) return place;
  const [kind, ...rest] = value.split(":");
  const arg = rest.join(":");
  if (arg && kind === "library") return { kind: "library", tab: arg };
  if (arg && kind === "space") return { kind, id: arg };
  if (arg && kind === "chat") return { kind: "conversation", id: arg };
  return { kind: "conversation", id: value };
}

/** The citation a Reader address opens on: a `Reference` with its revision as a number and without its item (the page's). */
export interface ReaderTarget {
  /** Revision number the reference was made from. */
  revision: number;
  structureVersion: string;
  refs: readonly string[];
  quote: string;
  location: string;
  highlights: readonly Highlight[];
}

export interface ReaderLink {
  /** Item name or bare ID. */
  item: string;
  /** The citation to open on: its revision's Original with its highlights (or its quote) marked. */
  reference?: Omit<Reference, "item"> | null;
  /** Text to highlight in the Original (a search). */
  q?: string;
  page?: number;
  /** Where the reader came from: a conversation name or ID, or an encoded `ReaderOrigin` (`originParam`). */
  from?: string;
  /** Revision number to view (older version). */
  v?: number;
  /** Open the Ask panel ("Ask about this document"). */
  ask?: boolean;
}

/** Fractions are kept to 1/10,000 of the page: well under a pixel at any zoom. */
const fraction = (value: number) => String(Math.round(value * 10_000) / 10_000);

/**
 * One Highlight as an `hl=` value: a PDF page `3`, with its boxes `3:l,t,r,b;l,t,r,b`, or a sheet range
 * `Sheet name!A24:DH26` (a range never holds `!`, so the last one splits it).
 */
export function highlightParam(highlight: Highlight): string {
  if (highlight.sheet && highlight.cellRange) return `${highlight.sheet}!${highlight.cellRange}`;
  const boxes = (highlight.boxes ?? []).map((b) => [b.left, b.top, b.right, b.bottom].map(fraction).join(",")).join(";");
  return `${highlight.pageNumber ?? 0}${boxes ? `:${boxes}` : ""}`;
}

const RANGE = /^[A-Z]{1,3}[1-9]\d*(?::[A-Z]{1,3}[1-9]\d*)?$/;

/** An `hl=` value back as a Highlight; `null` when it is neither form. */
export function parseHighlightParam(value: string): Highlight | null {
  const bang = value.lastIndexOf("!");
  if (bang >= 0) {
    const sheet = value.slice(0, bang);
    const cellRange = value.slice(bang + 1);
    return sheet && RANGE.test(cellRange) ? { sheet, cellRange } : null;
  }
  const [page, list] = value.split(":", 2);
  const pageNumber = Number(page);
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return null;
  const boxes: HighlightBox[] = [];
  for (const part of list ? list.split(";") : []) {
    const n = part.split(",").map(Number);
    if (n.length !== 4 || n.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) return null;
    boxes.push({ left: n[0]!, top: n[1]!, right: n[2]!, bottom: n[3]! });
  }
  return { pageNumber, boxes };
}

/** The citation's address parameters (`rev`, `ver`, `ref`, `quote`, `loc`, `hl`); all empty when it names no blocks of a numbered revision. */
export function citationParams(reference: Omit<Reference, "item"> | null | undefined): { rev: string; ver: string; ref: string[]; quote: string; loc: string; hl: string[] } {
  const rev = revisionNumber(reference?.revision);
  if (!reference || !rev || !reference.structureVersion || !reference.refs.length) return { rev: "", ver: "", ref: [], quote: "", loc: "", hl: [] };
  return {
    rev: String(rev),
    ver: reference.structureVersion,
    ref: [...reference.refs],
    quote: reference.quote,
    loc: reference.location,
    hl: reference.highlights.map(highlightParam),
  };
}

export function readerHref({ item, reference, q, page, from, v, ask }: ReaderLink): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(citationParams(reference))) {
    for (const one of typeof value === "string" ? [value] : value) if (one) params.append(key, one);
  }
  if (q?.trim()) params.set("q", q.trim());
  if (page) params.set("page", String(page));
  if (from) params.set("from", idOf(from));
  if (v) params.set("v", String(v));
  if (ask) params.set("ask", "1");
  const query = params.toString();
  return `/doc/${encodeURIComponent(idOf(item))}${query ? `?${query}` : ""}`;
}

export interface ReaderQuery {
  q: string;
  page?: number;
  /** The citation (`rev` + `ver` + `ref`, with `quote`, `loc`, `hl`), or `null` when the address names none or only part of one. */
  target: ReaderTarget | null;
  /** Raw `from=` value (see `parseOrigin`). */
  from: string;
  /** Requested revision number. */
  v?: number;
  /** `?ask=1`: open on the Ask panel. */
  ask: boolean;
}

const VERSION = /^[0-9a-f]{16}$/;

export function parseReaderQuery(params: { get(key: string): string | null; getAll(key: string): string[] }): ReaderQuery {
  const num = (value: string | null) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  const revision = num(params.get("rev"));
  const structureVersion = params.get("ver") ?? "";
  const refs = [...new Set(params.getAll("ref").filter(Boolean))];
  const target: ReaderTarget | null =
    revision && VERSION.test(structureVersion) && refs.length
      ? {
          revision,
          structureVersion,
          refs,
          quote: params.get("quote") ?? "",
          location: params.get("loc") ?? "",
          highlights: params.getAll("hl").flatMap((value) => parseHighlightParam(value) ?? []),
        }
      : null;
  return {
    q: params.get("q")?.trim() ?? "",
    page: num(params.get("page")),
    target,
    from: params.get("from") ?? "",
    v: num(params.get("v")),
    ask: params.get("ask") === "1",
  };
}

/** Revision number of a revision name (`…/revisions/3` → 3). */
export function revisionNumber(revision: string | undefined | null): number | undefined {
  const n = Number(/\/revisions\/(\d+)$/.exec(revision ?? "")?.[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A quoted selection longer than this is cut, so the question stays readable. */
const QUOTE_LIMIT = 240;

/** "Ask" on a selection (preview `rdr-sel-ask`): the passage quoted, collapsed and cut at a word. */
export function explainPassagePrompt(selection: string): string {
  const text = selection.replace(/\s+/g, " ").trim();
  const quote = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT).replace(/\s+\S*$/, "")}…` : text;
  return `Giải thích đoạn trích này: “${quote}”`;
}

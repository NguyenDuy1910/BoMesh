/**
 * Reader addresses (`/doc/<item>?rev=&ver=&ref=&q=&page=&from=&v=&ask=1`, document_viewer.md "Reading").
 * A citation opens the Reader on its reference — `rev` (revision number), `ver` (structure version) and one
 * `ref` per cited block — in Content View; `from` names where the reader came from (see `ReaderOrigin`).
 */

import type { Reference } from "../content/reference.ts";

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

/** The cited blocks a Reader address opens on (a `Reference` without its display fields). */
export interface ReaderTarget {
  /** Revision number the reference was made from. */
  revision: number;
  structureVersion: string;
  refs: string[];
}

export interface ReaderLink {
  /** Item name or bare ID. */
  item: string;
  /** The cited blocks to open on and highlight (Content View). */
  reference?: Pick<Reference, "revision" | "structureVersion" | "refs"> | null;
  /** Text to highlight in the Original (a search). */
  q?: string;
  page?: number;
  /** Where the reader came from: a conversation name or ID, or an encoded `ReaderOrigin` (`originParam`). */
  from?: string;
  /** Revision number to view (older version). */
  v?: number;
  /** Open the Ask panel ("Ask about this document"). */
  ask?: boolean;
  /** Open on the Original (`view=original`) or on Content View (`view=content`); the Reader picks when absent. */
  view?: ReaderView;
}

export type ReaderView = "content" | "original";

export function readerHref({ item, reference, q, page, from, v, ask, view }: ReaderLink): string {
  const params = new URLSearchParams();
  const rev = revisionNumber(reference?.revision);
  if (reference && rev && reference.structureVersion && reference.refs.length) {
    params.set("rev", String(rev));
    params.set("ver", reference.structureVersion);
    for (const ref of reference.refs) params.append("ref", ref);
  }
  if (q?.trim()) params.set("q", q.trim());
  if (page) params.set("page", String(page));
  if (from) params.set("from", idOf(from));
  if (v) params.set("v", String(v));
  if (ask) params.set("ask", "1");
  if (view) params.set("view", view);
  const query = params.toString();
  return `/doc/${encodeURIComponent(idOf(item))}${query ? `?${query}` : ""}`;
}

export interface ReaderQuery {
  q: string;
  page?: number;
  /** The cited blocks (`rev` + `ver` + `ref`), or `null` when the address names none or only part of one. */
  target: ReaderTarget | null;
  /** Raw `from=` value (see `parseOrigin`). */
  from: string;
  /** Requested revision number. */
  v?: number;
  /** `?ask=1`: open on the Ask panel. */
  ask: boolean;
  /** `?view=`; `null` when the address doesn't say. */
  view: ReaderView | null;
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
  const view = params.get("view");
  return {
    q: params.get("q")?.trim() ?? "",
    page: num(params.get("page")),
    target: revision && VERSION.test(structureVersion) && refs.length ? { revision, structureVersion, refs } : null,
    from: params.get("from") ?? "",
    v: num(params.get("v")),
    ask: params.get("ask") === "1",
    view: view === "content" || view === "original" ? view : null,
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

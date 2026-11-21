/**
 * Reader addresses (`/doc/<item>?q=&page=&passage=&from=&v=&ask=1`, document_viewer.md "Reading").
 * Citations open the Reader with one `passage` per passage an answer cited in the
 * document, in citation order; `from` names where the reader came from (see `ReaderOrigin`).
 */

/** Last path segment of a resource name, or the value itself when it is already a bare ID. */
const idOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/**
 * Where the Reader was opened from, so its trail leads back there (preview `backBtn`). Encoded in
 * `from=`: a bare conversation ID (chat citations), `home`, `search`, `recent`, `contributions`,
 * `library:<saved|files>` or `space:<spaceId>`.
 */
export type ReaderOrigin =
  | { kind: "conversation"; id: string }
  | { kind: "home" | "search" | "recent" | "contributions" }
  | { kind: "library"; tab: string }
  | { kind: "space"; id: string };

const PLACES: Readonly<Record<string, ReaderOrigin>> = {
  home: { kind: "home" },
  search: { kind: "search" },
  recent: { kind: "recent" },
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

export interface ReaderLink {
  /** Item name or bare ID. */
  item: string;
  /** Passage names or bare passage IDs, in citation order. */
  passages?: readonly string[];
  /** Text to highlight (a search, or a quote). */
  q?: string;
  page?: number;
  /** Where the reader came from: a conversation name or ID, or an encoded `ReaderOrigin` (`originParam`). */
  from?: string;
  /** Revision number to view (older version). */
  v?: number;
  /** Open the Ask panel ("Ask about this document"). */
  ask?: boolean;
}

export function readerHref({ item, passages = [], q, page, from, v, ask }: ReaderLink): string {
  const params = new URLSearchParams();
  for (const passage of passages) if (passage) params.append("passage", idOf(passage));
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
  /** Bare passage IDs. */
  passages: string[];
  /** Raw `from=` value (see `parseOrigin`). */
  from: string;
  /** Requested revision number. */
  v?: number;
  /** `?ask=1`: open on the Ask panel. */
  ask: boolean;
}

export function parseReaderQuery(params: { get(key: string): string | null; getAll(key: string): string[] }): ReaderQuery {
  const num = (value: string | null) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };
  return {
    q: params.get("q")?.trim() ?? "",
    page: num(params.get("page")),
    passages: [...new Set(params.getAll("passage").filter(Boolean))],
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
  return `Explain this passage: “${quote}”`;
}

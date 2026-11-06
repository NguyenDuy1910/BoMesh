/**
 * Reader addresses (`/doc/<item>?q=&page=&passage=&from=&v=`, document_viewer.md "Reading").
 * Citations open the Reader with one `passage` per passage an answer cited in the
 * document, in citation order; `from` names the conversation they came from.
 */

/** Last path segment of a resource name, or the value itself when it is already a bare ID. */
const idOf = (name: string) => name.slice(name.lastIndexOf("/") + 1);

export interface ReaderLink {
  /** Item name or bare ID. */
  item: string;
  /** Passage names or bare passage IDs, in citation order. */
  passages?: readonly string[];
  /** Text to highlight (a search, or a quote). */
  q?: string;
  page?: number;
  /** Conversation name or ID the reader came from ("Back to conversation"). */
  from?: string;
  /** Revision number to view (older version). */
  v?: number;
}

export function readerHref({ item, passages = [], q, page, from, v }: ReaderLink): string {
  const params = new URLSearchParams();
  for (const passage of passages) if (passage) params.append("passage", idOf(passage));
  if (q?.trim()) params.set("q", q.trim());
  if (page) params.set("page", String(page));
  if (from) params.set("from", idOf(from));
  if (v) params.set("v", String(v));
  const query = params.toString();
  return `/doc/${encodeURIComponent(idOf(item))}${query ? `?${query}` : ""}`;
}

export interface ReaderQuery {
  q: string;
  page?: number;
  /** Bare passage IDs. */
  passages: string[];
  /** Bare conversation ID. */
  from: string;
  /** Requested revision number. */
  v?: number;
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
  };
}

/** Revision number of a revision name (`…/revisions/3` → 3). */
export function revisionNumber(revision: string | undefined | null): number | undefined {
  const n = Number(/\/revisions\/(\d+)$/.exec(revision ?? "")?.[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A quoted selection longer than this is cut, so the question stays readable. */
const QUOTE_LIMIT = 240;

/** "Ask about this" on a selection (preview `rdr-sel-ask`): the passage quoted, collapsed and cut at a word. */
export function explainPassagePrompt(selection: string): string {
  const text = selection.replace(/\s+/g, " ").trim();
  const quote = text.length > QUOTE_LIMIT ? `${text.slice(0, QUOTE_LIMIT).replace(/\s+\S*$/, "")}…` : text;
  return `Explain this passage: “${quote}”`;
}

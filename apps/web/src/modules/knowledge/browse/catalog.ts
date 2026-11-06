import { resourceId } from "@/lib/api/client";

import type { Item, SavedSearch, SearchItemsResult, Topic } from "../api";
import {
  catalogFilter,
  catalogSearchRequest,
  FACETS,
  formatOf,
  ORDER_BY,
  parseCatalogQuery,
  UPDATED_WINDOWS,
  type CatalogParams,
  type CatalogSort,
  type FacetId,
  type FormatKey,
} from "../model";

/**
 * Browse (/knowledge) catalog state: the URL is the result set (preview `core/catalog.js`).
 * The model's FACETS are the dimensions SearchItems can filter on; Browse adds two it can only
 * count or not count at all — Space (space materials and space knowledge bases) and Language
 * (`document.languageCode` is a facet, not a filter field). Those, and "Only documents I saved",
 * are answered locally over the readable pool (see `useCatalog`).
 */

export type BrowseFacetId = FacetId | "space" | "lang";

export interface BrowseParams extends Omit<CatalogParams, "filters"> {
  filters: Partial<Record<BrowseFacetId, string[]>>;
}

export interface BrowseFacetDef {
  id: BrowseFacetId;
  label: string;
  single?: boolean;
}

/** Drawer order (preview FACETS). Space only with the Spaces module. */
export const BROWSE_FACETS: readonly BrowseFacetDef[] = [
  { id: "topic", label: "Topic" },
  { id: "space", label: "Space" },
  { id: "kind", label: "Type" },
  { id: "owner", label: "Owner" },
  { id: "src", label: "Source" },
  { id: "kb", label: "Knowledge base" },
  { id: "trust", label: "Trust" },
  { id: "upd", label: "Updated", single: true },
  { id: "fmt", label: "Format" },
  { id: "lang", label: "Language" },
];

export const browseFacets = (spaces: boolean) => BROWSE_FACETS.filter((f) => f.id !== "space" || spaces);

/** Facets SearchItems can't filter on: selecting one (or "saved") switches to the local pool. */
export const LOCAL_FACETS: readonly BrowseFacetId[] = ["space", "lang"];

export const isLocal = (p: BrowseParams) => !!p.saved || LOCAL_FACETS.some((f) => p.filters[f]?.length);

export const PER_PAGE = 24;

type QueryLike = URLSearchParams | Readonly<Record<string, string | undefined>>;
const read = (q: QueryLike, key: string) => (q instanceof URLSearchParams ? q.get(key) : q[key]) ?? "";

export function parseBrowseQuery(query: QueryLike): BrowseParams {
  const p: BrowseParams = parseCatalogQuery(query);
  for (const id of LOCAL_FACETS) {
    const values = read(query, id).split(",").filter(Boolean);
    if (values.length) p.filters[id] = values;
  }
  return p;
}

/** Params → query record in the preview's key order (q, sort, view, saved, facets). */
export function browseQueryOf(p: BrowseParams): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.q) out.q = p.q;
  if (p.sort) out.sort = p.sort;
  if (p.view === "list") out.view = "list";
  if (p.saved) out.saved = "1";
  for (const f of BROWSE_FACETS) {
    const v = p.filters[f.id];
    if (v?.length) out[f.id] = v.join(",");
  }
  return out;
}

export const browseHref = (p: BrowseParams) => {
  const qs = new URLSearchParams(browseQueryOf(p)).toString();
  return "/knowledge" + (qs ? `?${qs}` : "");
};

/** Identity of a result set, ignoring the layout (preview `setKey`). */
export const setKey = (p: BrowseParams) => new URLSearchParams(browseQueryOf({ ...p, view: "grid" })).toString();

export const activeCount = (p: BrowseParams) => Object.values(p.filters).reduce((n, v) => n + (v?.length ?? 0), 0) + (p.saved ? 1 : 0);

/** The one topic the shortcuts represent: a single selected domain or topic. */
export const pillTopic = (p: BrowseParams) => (p.filters.topic?.length === 1 ? p.filters.topic[0] : "");

/** The model's (API) params for SearchItems. */
export const apiParams = (p: BrowseParams): CatalogParams => ({ ...p, filters: Object.fromEntries(FACETS.map((f) => [f.id, p.filters[f.id]])) });

export const defaultSort = (p: BrowseParams): CatalogSort => (p.q ? "relevance" : "updated");

type Label = (facet: BrowseFacetId, value: string) => string;

/** Every selected value's name, facet by facet (preview `filterLabels`). */
export const filterLabels = (p: BrowseParams, label: Label) => BROWSE_FACETS.flatMap((f) => (p.filters[f.id] ?? []).map((v) => label(f.id, v)));

/** One line naming a result set: “q” · values · Saved (preview `describe`, the Save view dialog). */
export const describeParams = (p: BrowseParams, label: Label) => [p.q && `“${p.q}”`, ...filterLabels(p, label), p.saved && "Saved"].filter(Boolean).join(" · ");

/** A saved view's summary: “q” · Topic: A, B · Saved only, else "All resources" (preview library `viewSummary`). */
export function viewSummary(p: BrowseParams, label: Label): string {
  const parts: string[] = [];
  if (p.q) parts.push(`“${p.q}”`);
  for (const f of BROWSE_FACETS) {
    const values = p.filters[f.id];
    if (values?.length) parts.push(`${f.label}: ${values.map((v) => label(f.id, v)).join(", ")}`);
  }
  if (p.saved) parts.push("Saved only");
  return parts.join(" · ") || "All resources";
}

/* ═══════════════ Saved views ↔ SavedSearch ═══════════════ */

const LAYOUT: Readonly<Record<string, "grid" | "list">> = { GRID: "grid", LIST: "list", TABLE: "list" };

/** What a saved view stores: the query, the API filter, the order and the layout. Space, Language and "saved" aren't API filters. */
export function savedSearchOf(p: BrowseParams, ws: string, topics: readonly Topic[], displayName: string): SavedSearch {
  const sort = p.sort || defaultSort(p);
  return {
    displayName,
    query: p.q || undefined,
    filter: catalogFilter(apiParams(p), ws, { topics }) || undefined,
    orderBy: ORDER_BY[sort] || undefined,
    layout: p.view === "list" ? "LIST" : "GRID",
  };
}

/** Browse state a saved view can't keep (named for the Save view dialog). */
export function unsavable(p: BrowseParams): string[] {
  return [p.filters.space?.length && "Space", p.filters.lang?.length && "Language", p.saved && "Only documents I saved"].filter((x): x is string => !!x);
}

const CLAUSE = /(document\.topics|document\.documentType|document\.owner|document\.origin\.source|ancestors|document\.verification\.state|document\.mimeType|updateTime)\s*(:|>=|=)\s*("(?:[^"\\]|\\.)*"|[A-Z_]+)/g;
const TRUST_KEY: Readonly<Record<string, string>> = { VERIFIED: "verified", REVIEW_DUE: "review", UNVERIFIED: "unverified" };
const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

/**
 * A saved view back to Browse params. Parses the AIP-160 filter `catalogFilter` writes: a selected domain
 * expands to its topics, so topics whose domain is also present collapse back into the domain; the Updated
 * window is the one closest to the timestamp's age when the view was saved.
 */
export function savedSearchParams(s: SavedSearch, topics: readonly Topic[] = []): BrowseParams {
  const filters: Partial<Record<BrowseFacetId, string[]>> = {};
  const add = (id: BrowseFacetId, v: string) => {
    const list = (filters[id] ??= []);
    if (!list.includes(v)) list.push(v);
  };
  const savedAt = Date.parse(s.updateTime || s.createTime || "") || Date.now();
  for (const [, field, , raw] of (s.filter ?? "").matchAll(CLAUSE)) {
    const v = unquote(raw);
    switch (field) {
      case "document.topics":
        add("topic", resourceId(v));
        break;
      case "document.documentType":
        add("kind", v);
        break;
      case "document.owner":
        add("owner", resourceId(v));
        break;
      case "document.origin.source":
        add("src", v ? resourceId(v) : "upload");
        break;
      case "ancestors":
        add("kb", resourceId(v));
        break;
      case "document.verification.state":
        if (TRUST_KEY[v]) add("trust", TRUST_KEY[v]);
        break;
      case "document.mimeType":
        add("fmt", formatOf("", v));
        break;
      case "updateTime": {
        const days = (savedAt - Date.parse(v)) / 86_400_000;
        const best = [...UPDATED_WINDOWS].sort((a, b) => Math.abs(a[2] - days) - Math.abs(b[2] - days))[0];
        if (best) filters.upd = [best[0]];
        break;
      }
    }
  }
  if (filters.topic) {
    const byName = new Map(topics.map((t) => [resourceId(t.name), t]));
    const chosen = new Set(filters.topic);
    filters.topic = filters.topic.filter((id) => {
      const parent = resourceId(byName.get(id)?.parentTopic);
      return !parent || !chosen.has(parent);
    });
  }
  const sort = (Object.keys(ORDER_BY) as CatalogSort[]).find((k) => ORDER_BY[k] && ORDER_BY[k] === s.orderBy) ?? "";
  const p: BrowseParams = { q: (s.query ?? "").trim(), sort: "", view: LAYOUT[s.layout ?? ""] ?? "grid", filters };
  if (sort && sort !== defaultSort(p)) p.sort = sort;
  return p;
}

/** `/knowledge?…` for a saved view. */
export const savedSearchHref = (s: SavedSearch, topics?: readonly Topic[]) => browseHref(savedSearchParams(s, topics));

/* ═══════════════ Local answers (saved only, Space, Language) ═══════════════ */

export interface LocalContext {
  ws: string;
  topics: readonly Topic[];
  /** Collection name → parent name ("" for roots). */
  parents: ReadonlyMap<string, string>;
  /** Space ID → collections (linked bases and pinned collections) and pinned documents. */
  spaces: ReadonlyMap<string, { collections: ReadonlySet<string>; documents: ReadonlySet<string> }>;
}

/** The chain of collections above an item, nearest first. */
function ancestorsOf(item: Item, parents: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  let at = item.parentItem ?? "";
  while (at && !out.includes(at)) {
    out.push(at);
    at = parents.get(at) ?? "";
  }
  return out;
}

const UPLOAD = "upload";

/** Facet values of one document (bare IDs or keys, as in the URL). */
export function valuesOf(item: Item, ctx: LocalContext, now: number): Record<BrowseFacetId, string[]> {
  const doc = item.document;
  const ancestors = ancestorsOf(item, ctx.parents);
  const topicIds = new Set<string>();
  for (const t of doc?.topics ?? []) {
    topicIds.add(resourceId(t));
    const parent = ctx.topics.find((x) => x.name === t)?.parentTopic;
    if (parent) topicIds.add(resourceId(parent));
  }
  const id = resourceId(item.name);
  const spaces = [...ctx.spaces].filter(([, s]) => s.documents.has(id) || ancestors.some((a) => s.collections.has(a))).map(([sid]) => sid);
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(doc?.fileName ?? "")?.[1] ?? "").toLowerCase();
  const age = (now - Date.parse(item.updateTime ?? "")) / 86_400_000;
  const trust = TRUST_KEY[doc?.verification?.state ?? ""] ?? "unverified";
  return {
    topic: [...topicIds],
    space: spaces,
    kind: doc?.documentType ? [doc.documentType] : [],
    owner: [doc?.owner ? resourceId(doc.owner) : "—"],
    src: [doc?.origin?.source ? resourceId(doc.origin.source) : UPLOAD],
    kb: ancestors.length ? [resourceId(ancestors[ancestors.length - 1])] : [],
    trust: [trust],
    upd: UPDATED_WINDOWS.filter((w) => age <= w[2]).map((w) => w[0]),
    fmt: [formatOf(ext, doc?.mimeType) as FormatKey],
    lang: doc?.languageCode ? [doc.languageCode] : [],
  };
}

export interface LocalAnswer {
  rows: SearchItemsResult[];
  /** Facet → value → disjunctive count. */
  counts: Partial<Record<BrowseFacetId, Map<string, number>>>;
}

/**
 * Preview `catalogSearch` over a pool: filters AND across facets, OR within one; each facet's counts
 * ignore its own selection (disjunctive); sorted by the chosen order (relevance keeps the API's order).
 */
export function answerLocally(pool: readonly SearchItemsResult[], p: BrowseParams, ctx: LocalContext, facets: readonly BrowseFacetDef[]): LocalAnswer {
  const now = Date.now();
  const keyed = pool.map((r, i) => ({ r, i, v: valuesOf(r.item ?? {}, ctx, now) }));
  const passes = (x: (typeof keyed)[number], skip: BrowseFacetId | null) =>
    facets.every((f) => f.id === skip || !p.filters[f.id]?.length || p.filters[f.id]!.some((v) => x.v[f.id].includes(v)));
  const counts: LocalAnswer["counts"] = {};
  for (const f of facets) {
    const m = new Map<string, number>();
    for (const x of keyed) if (passes(x, f.id)) for (const v of x.v[f.id]) m.set(v, (m.get(v) ?? 0) + 1);
    counts[f.id] = m;
  }
  const sort = p.sort || defaultSort(p);
  const rows = keyed.filter((x) => passes(x, null));
  const time = (x: (typeof keyed)[number]) => Date.parse(x.r.item?.updateTime ?? "") || 0;
  rows.sort(
    sort === "title"
      ? (a, b) => (a.r.item?.displayName ?? "").localeCompare(b.r.item?.displayName ?? "")
      : sort === "updated"
        ? (a, b) => time(b) - time(a)
        : (a, b) => a.i - b.i,
  );
  return { rows: rows.map((x) => x.r), counts };
}

/** Pool request: the query only (facets are answered locally). */
export const poolRequest = (p: BrowseParams, ws: string) => catalogSearchRequest({ ...apiParams(p), filters: {} }, ws, { pageSize: 100, facets: false });

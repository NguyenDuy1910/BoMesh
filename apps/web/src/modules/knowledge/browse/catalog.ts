import { resourceId } from "@/lib/api/client";

import { quote, type SavedSearch, type SearchItemsRequest, type Topic } from "../api";
import {
  catalogFilter,
  catalogSearchRequest,
  docTypeOf,
  FACETS,
  ORDER_BY,
  parseCatalogQuery,
  UPDATED_WINDOWS,
  type CatalogParams,
  type CatalogSort,
  type FacetId,
} from "../model";

/**
 * Browse (/knowledge) catalog state: the URL is the result set (preview `core/catalog.js`).
 * The model's FACETS are the dimensions every catalog search shares; Browse adds two more SearchItems
 * serves too — Space (`spaces`: a space's collections and materials) and Language
 * (`document.languageCode`). Saved documents live in Knowledge → Saved, not here.
 */

export type BrowseFacetId = FacetId | "space" | "lang";

export interface BrowseParams extends Omit<CatalogParams, "filters"> {
  filters: Partial<Record<BrowseFacetId, string[]>>;
}

/** A Browse filter; its name is the catalog's (`m.knowledge.browse.facets[id]`: Topic · … · Verification · Updated). */
export interface BrowseFacetDef {
  id: BrowseFacetId;
  single?: boolean;
}

/** Facet order (preview FACETS). Space only with the Spaces module. */
export const BROWSE_FACETS: readonly BrowseFacetDef[] = [
  { id: "topic" },
  { id: "space" },
  { id: "type" },
  { id: "owner" },
  { id: "src" },
  { id: "kb" },
  { id: "trust" },
  { id: "upd", single: true },
  { id: "lang" },
];

export const browseFacets = (spaces: boolean) => BROWSE_FACETS.filter((f) => f.id !== "space" || spaces);

/** Filters shown as their own buttons (the ones people narrow by most); the others sit under More filters. Topic is the pills. */
export const INLINE_FACETS: readonly BrowseFacetId[] = ["type", "upd", "trust", "owner"];

/** Browse's facets beyond the model's (their URL keys, filter clauses and facet specs are Browse's own). */
const BROWSE_ONLY: readonly BrowseFacetId[] = ["space", "lang"];

/** SearchItems facet field of each Browse-only facet. */
export const BROWSE_ONLY_FIELD = { space: "spaces", lang: "document.languageCode" } as const;

export const PER_PAGE = 24;

/**
 * What Browse lists (api_design "Browse"): the workspace's public knowledge — documents in shared collections,
 * published, and processed. Members' My files, unpublished documents and documents still processing never appear,
 * so a contribution shows up once it is approved and processed. Every Browse request carries it; saved views don't
 * (it is the page's scope, not a choice).
 */
export const BROWSE_SCOPE =
  "document.collectionKind = STANDARD AND document.publicationState = PUBLISHED AND (document.indexingState = SUCCEEDED OR document.indexingState = OUTDATED)";

type QueryLike = URLSearchParams | Readonly<Record<string, string | undefined>>;
const read = (q: QueryLike, key: string) => (q instanceof URLSearchParams ? q.get(key) : q[key]) ?? "";

export function parseBrowseQuery(query: QueryLike): BrowseParams {
  const p: BrowseParams = parseCatalogQuery(query);
  delete p.saved;
  for (const id of BROWSE_ONLY) {
    const values = read(query, id).split(",").filter(Boolean);
    if (values.length) p.filters[id] = values;
  }
  return p;
}

/** Params → query record in the preview's key order (q, sort, view, facets). */
export function browseQueryOf(p: BrowseParams): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.q) out.q = p.q;
  if (p.sort) out.sort = p.sort;
  if (p.view === "list") out.view = "list";
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

export const activeCount = (p: BrowseParams) => Object.values(p.filters).reduce((n, v) => n + (v?.length ?? 0), 0);

/** The one topic the shortcuts represent: a single selected domain or topic. */
export const pillTopic = (p: BrowseParams) => (p.filters.topic?.length === 1 ? p.filters.topic[0] : "");

/** The model's (API) params for SearchItems. */
export const apiParams = (p: BrowseParams): CatalogParams => ({ ...p, filters: Object.fromEntries(FACETS.map((f) => [f.id, p.filters[f.id]])) });

export const defaultSort = (p: BrowseParams): CatalogSort => (p.q ? "relevance" : "updated");

type Label = (facet: BrowseFacetId, value: string) => string;

/** Every selected value's name, facet by facet (preview `filterLabels`). */
export const filterLabels = (p: BrowseParams, label: Label) => BROWSE_FACETS.flatMap((f) => (p.filters[f.id] ?? []).map((v) => label(f.id, v)));

/** One line naming a result set: “q” · values (preview `describe`, the Save view dialog). */
export const describeParams = (p: BrowseParams, label: Label) => [p.q && `“${p.q}”`, ...filterLabels(p, label)].filter(Boolean).join(" · ");

/* ═══════════════ Saved views ↔ SavedSearch ═══════════════ */

const LAYOUT: Readonly<Record<string, "grid" | "list">> = { GRID: "grid", LIST: "list", TABLE: "list" };

/** What a saved view stores: the query, the model's filter, the order and the layout (Space and Language aren't kept). */
export function savedSearchOf(p: BrowseParams, ws: string, displayName: string): SavedSearch {
  const sort = p.sort || defaultSort(p);
  return {
    displayName,
    query: p.q || undefined,
    filter: catalogFilter(apiParams(p), ws) || undefined,
    orderBy: ORDER_BY[sort] || undefined,
    layout: p.view === "list" ? "LIST" : "GRID",
  };
}

/** Browse filters a saved view can't keep (named in the Save view dialog). */
export function unsavable(p: BrowseParams): BrowseFacetId[] {
  return (["space", "lang"] as const).filter((id) => p.filters[id]?.length);
}

const CLAUSE = /(document\.topics|itemType|document\.owner|document\.origin\.source|ancestors|document\.verification\.state|updateTime)\s*(:|>=|=)\s*("(?:[^"\\]|\\.)*"|[A-Z_]+)/g;
const TRUST_KEY: Readonly<Record<string, string>> = { VERIFIED: "verified", REVIEW_DUE: "review", UNVERIFIED: "unverified" };
const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

/**
 * A saved view back to Browse params. Parses the AIP-160 filter `catalogFilter` writes. `document.topics`
 * is hierarchical, but views saved before it was also list a selected domain's topics, so topics whose
 * domain is also present collapse back into the domain; the Updated window is the one closest to the
 * timestamp's age when the view was saved.
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
      case "itemType":
        add("type", docTypeOf(v));
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
      case "updateTime": {
        const days = (savedAt - Date.parse(v)) / 86_400_000;
        const best = [...UPDATED_WINDOWS].sort((a, b) => Math.abs(a[1] - days) - Math.abs(b[1] - days))[0];
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

/* ═══════════════ The Browse request ═══════════════ */

const anyOf = (parts: readonly string[]) => (parts.length > 1 ? `(${parts.join(" OR ")})` : (parts[0] ?? ""));

/**
 * One page of Browse results for params: the model's request (its filters, facets and order) within BROWSE_SCOPE,
 * plus the Space (`spaces`, Spaces module only) and Language selections as clauses and both as disjunctive facets.
 */
export function browseSearchRequest(p: BrowseParams, ws: string, { spaces, pageSize, pageToken }: { spaces: boolean; pageSize: number; pageToken?: string }): SearchItemsRequest {
  const space = spaces ? anyOf((p.filters.space ?? []).map((id) => `spaces:${quote(`workspaces/${ws}/spaces/${id}`)}`)) : "";
  const lang = anyOf((p.filters.lang ?? []).map((code) => `document.languageCode = ${quote(code)}`));
  const req = catalogSearchRequest(apiParams(p), ws, { base: [BROWSE_SCOPE, space, lang].filter(Boolean).join(" AND "), pageSize, pageToken });
  const extra = [
    ...(spaces ? [{ field: BROWSE_ONLY_FIELD.space, limit: 50, excludedFromFilter: true }] : []),
    { field: BROWSE_ONLY_FIELD.lang, limit: 30, excludedFromFilter: true },
  ];
  return { ...req, facetSpecs: [...(req.facetSpecs ?? []), ...extra] };
}

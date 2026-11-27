import { resourceId } from "@/lib/api/client";

import { quote, type SavedSearch, type SearchItemsRequest } from "../api";
import {
  catalogFacets,
  catalogFilter,
  catalogSearchRequest,
  docTypeOf,
  FACETS,
  ORDER_BY,
  parseCatalogQuery,
  UPDATED_WINDOWS,
  type CatalogParams,
  type CatalogSort,
  type FacetDef,
  type FacetId,
} from "../model";
import { firstScheme, resourceKey, schemeLabel, schemeOfConcept, type Taxonomy } from "../taxonomy";

/**
 * Browse (/knowledge) catalog state: the URL is the result set (preview `core/catalog.js`).
 * The model's facets are the dimensions every catalog search shares — one per classification scheme (keyed by the
 * scheme's ID) and the static ones; Browse adds two more SearchItems serves too — Space (`spaces`: a space's
 * collections and materials) and Language (`document.languageCode`). Saved documents live in Knowledge → Saved, not here.
 */

/** A Browse facet: a classification scheme's ID, a model facet or Space/Language. */
export type BrowseFacetId = FacetId;

export type BrowseParams = CatalogParams;

/** A Browse filter. A scheme's is named by the scheme (`label`, content); the others by the catalog (`m.knowledge.browse.facets[id]`). */
export interface BrowseFacetDef {
  id: BrowseFacetId;
  single?: boolean;
  /** A classification scheme's facet: the scheme's full name. */
  scheme?: string;
  /** The scheme's name. */
  label?: string;
}

/** Browse's facets beyond the model's (their URL keys, filter clauses and facet specs are Browse's own). */
const BROWSE_ONLY = ["space", "lang"] as const;

/** Static facet order (preview FACETS): Space first (Spaces module only), then the model's, then Language. */
const STATIC_FACETS: readonly BrowseFacetDef[] = [{ id: "space" }, ...FACETS.map((f) => ({ id: f.id, single: f.single })), { id: "lang" }];

/** Every Browse facet (preview `facetsOn`): one per classification scheme in tab order, then the static ones. */
export function browseFacets(spaces: boolean, taxonomy: Taxonomy): BrowseFacetDef[] {
  const schemes = catalogFacets(taxonomy)
    .filter((f) => f.scheme)
    .map((f) => ({ id: f.id, scheme: f.scheme, label: schemeLabel(taxonomy.schemes.find((s) => s.name === f.scheme)) }));
  return [...schemes, ...STATIC_FACETS.filter((f) => f.id !== "space" || spaces)];
}

/** The model's facets for a Browse facet list (what SearchItems counts besides Space and Language). */
export const modelFacets = (facets: readonly BrowseFacetDef[]): FacetDef[] =>
  facets.flatMap((f) => (f.scheme ? [{ id: f.id, field: "document.concepts", scheme: f.scheme }] : FACETS.filter((m) => m.id === f.id)));

/** Filters shown as their own buttons after the other classification schemes (the ones people narrow by most); the others sit under
 *  More filters. The first scheme is the pills. */
export const INLINE_FACETS: readonly BrowseFacetId[] = ["type", "upd", "trust", "owner"];

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

/** URL query → Browse params for these facets (`browseFacets`). */
export function parseBrowseQuery(query: QueryLike, facets: readonly BrowseFacetDef[]): BrowseParams {
  const p: BrowseParams = parseCatalogQuery(query, modelFacets(facets));
  delete p.saved;
  for (const id of BROWSE_ONLY) {
    const values = read(query, id).split(",").filter(Boolean);
    if (values.length && facets.some((f) => f.id === id)) p.filters[id] = values;
  }
  return p;
}

/** Params → query record in the preview's key order (q, sort, view, scheme facets, then the static ones). */
export function browseQueryOf(p: BrowseParams): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.q) out.q = p.q;
  if (p.sort) out.sort = p.sort;
  if (p.view === "list") out.view = "list";
  const statics = STATIC_FACETS.map((f) => f.id);
  for (const id of [...Object.keys(p.filters).filter((k) => !statics.includes(k)), ...statics]) {
    const v = p.filters[id];
    if (v?.length) out[id] = v.join(",");
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

/** The one concept the pills represent (preview `pillConcept`): a single selected concept of the first scheme. */
export function pillConcept(p: BrowseParams, taxonomy: Taxonomy): string {
  const on = p.filters[resourceKey(firstScheme(taxonomy)?.name)] ?? [];
  return on.length === 1 ? on[0] : "";
}

/** The model's (API) params for SearchItems: everything but Space and Language. */
export const apiParams = (p: BrowseParams): CatalogParams => ({
  ...p,
  filters: Object.fromEntries(Object.entries(p.filters).filter(([id]) => !(BROWSE_ONLY as readonly string[]).includes(id))),
});

export const defaultSort = (p: BrowseParams): CatalogSort => (p.q ? "relevance" : "updated");

type Label = (facet: BrowseFacetId, value: string) => string;

/** Every selected value's name, facet by facet (preview `filterLabels`). */
export const filterLabels = (p: BrowseParams, label: Label, facets: readonly BrowseFacetDef[]) => facets.flatMap((f) => (p.filters[f.id] ?? []).map((v) => label(f.id, v)));

/** One line naming a result set: “q” · values (preview `describe`, the Save view dialog). */
export const describeParams = (p: BrowseParams, label: Label, facets: readonly BrowseFacetDef[]) =>
  [p.q && `“${p.q}”`, ...filterLabels(p, label, facets)].filter(Boolean).join(" · ");

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
export function unsavable(p: BrowseParams): (typeof BROWSE_ONLY)[number][] {
  return BROWSE_ONLY.filter((id) => p.filters[id]?.length);
}

const CLAUSE = /(document\.concepts|itemType|document\.owner|document\.origin\.source|ancestors|document\.verification\.state|updateTime)\s*(:|>=|=)\s*("(?:[^"\\]|\\.)*"|[A-Z_]+)/g;
const TRUST_KEY: Readonly<Record<string, string>> = { VERIFIED: "verified", REVIEW_DUE: "review", UNVERIFIED: "unverified" };
const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v);

/**
 * A saved view back to Browse params. Parses the AIP-160 filter `catalogFilter` writes: a concept clause goes to its
 * scheme's facet (`document.concepts` is hierarchical, so a concept stands for everything under it); the Updated
 * window is the one closest to the timestamp's age when the view was saved.
 */
export function savedSearchParams(s: SavedSearch): BrowseParams {
  const filters: Partial<Record<BrowseFacetId, string[]>> = {};
  const add = (id: BrowseFacetId, v: string) => {
    const list = (filters[id] ??= []);
    if (!list.includes(v)) list.push(v);
  };
  const savedAt = Date.parse(s.updateTime || s.createTime || "") || Date.now();
  for (const [, field, , raw] of (s.filter ?? "").matchAll(CLAUSE)) {
    const v = unquote(raw);
    switch (field) {
      case "document.concepts":
        if (schemeOfConcept(v)) add(resourceKey(schemeOfConcept(v)), resourceKey(v));
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
  const sort = (Object.keys(ORDER_BY) as CatalogSort[]).find((k) => ORDER_BY[k] && ORDER_BY[k] === s.orderBy) ?? "";
  const p: BrowseParams = { q: (s.query ?? "").trim(), sort: "", view: LAYOUT[s.layout ?? ""] ?? "grid", filters };
  if (sort && sort !== defaultSort(p)) p.sort = sort;
  return p;
}

/* ═══════════════ The Browse request ═══════════════ */

const anyOf = (parts: readonly string[]) => (parts.length > 1 ? `(${parts.join(" OR ")})` : (parts[0] ?? ""));

/**
 * One page of Browse results for params: the model's request (its filters, facets — one per classification scheme —
 * and order) within BROWSE_SCOPE, plus the Space (`spaces`, Spaces module only) and Language selections as clauses
 * and both as disjunctive facets.
 */
export function browseSearchRequest(
  p: BrowseParams,
  ws: string,
  { facets, pageSize, pageToken }: { facets: readonly BrowseFacetDef[]; pageSize: number; pageToken?: string },
): SearchItemsRequest {
  const spaces = facets.some((f) => f.id === "space");
  const space = spaces ? anyOf((p.filters.space ?? []).map((id) => `spaces:${quote(`workspaces/${ws}/spaces/${id}`)}`)) : "";
  const lang = anyOf((p.filters.lang ?? []).map((code) => `document.languageCode = ${quote(code)}`));
  const req = catalogSearchRequest(apiParams(p), ws, { base: [BROWSE_SCOPE, space, lang].filter(Boolean).join(" AND "), pageSize, pageToken, facets: modelFacets(facets) });
  const extra = [
    ...(spaces ? [{ field: BROWSE_ONLY_FIELD.space, limit: 50, excludedFromFilter: true }] : []),
    { field: BROWSE_ONLY_FIELD.lang, limit: 30, excludedFromFilter: true },
  ];
  return { ...req, facetSpecs: [...(req.facetSpecs ?? []), ...extra] };
}

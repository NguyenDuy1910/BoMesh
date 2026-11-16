"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { listAll, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces/queries";

import { listAllItems, listMaterials, searchItems, type SearchItemsRequest, type SearchItemsResult } from "../api";
import { catalogSearchRequest, facetOptions, UPDATED_WINDOWS } from "../model";
import { knowledgeKeys, useKnowledgeBases, useTopics } from "../queries";
import { activeCount, answerLocally, apiParams, BROWSE_SCOPE, browseFacets, isLocal, PER_PAGE, poolRequest, setKey, type BrowseFacetId, type BrowseParams, type LocalContext } from "./catalog";
import { useFacetLabel } from "./labels";

export interface BrowseOption {
  value: string;
  label: string;
  /** The label is UI vocabulary ("Past week", "My files"), translated; else a name people gave something. */
  ui: boolean;
  /** `null` when the count can't be computed for this result set (Space without the local pool). */
  count: number | null;
  on: boolean;
}

export interface CatalogView {
  rows: SearchItemsResult[];
  total: number;
  facets: Partial<Record<BrowseFacetId, BrowseOption[]>>;
  /** Documents the caller can browse (search placeholder). */
  poolSize: number | null;
  page: number;
  setPage: (page: number) => void;
  hasNext: boolean;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

const POOL_LIMIT = 1000;
const LANG_FACET = { field: "document.languageCode", limit: 30, excludedFromFilter: true };
/** One long-lived probe: the Browse pool's size, and its owners with their names (local answers label owners from it). */
const POOL_PROBE: SearchItemsRequest = { filter: BROWSE_SCOPE, pageSize: 1, facetSpecs: [{ field: "document.owner", limit: 100, excludedFromFilter: true }] };

/**
 * Browse results for URL params. One SearchItems call per result set answers filters, every facet
 * (disjunctive; Updated as `updateTime` intervals, topics rolled up into their domains), order and
 * paging; when a selection the API can't filter on is set (Space, Language), the readable pool for
 * the query is fetched once and answered locally with the same rules.
 */
export function useCatalog(p: BrowseParams): CatalogView {
  const { id: ws, hasModule, member } = useWorkspace();
  const spacesOn = hasModule("spaces");
  const facets = useMemo(() => browseFacets(spacesOn), [spacesOn]);
  const topics = useTopics();
  const bases = useKnowledgeBases();
  const spaces = useSpaces();
  const local = isLocal(p);
  const key = setKey(p);

  /* Paging: page tokens per page of this result set. */
  const [paging, setPaging] = useState<{ key: string; page: number; tokens: Record<number, string> }>({ key, page: 1, tokens: {} });
  const current = paging.key === key ? paging : { key, page: 1, tokens: {} };
  const page = current.page;
  const setPage = (n: number) => setPaging({ ...current, page: n });

  const serverRequest = useMemo<SearchItemsRequest>(() => {
    const req = catalogSearchRequest(apiParams(p), ws, { base: BROWSE_SCOPE, pageSize: PER_PAGE, pageToken: current.tokens[page] });
    return { ...req, facetSpecs: [...(req.facetSpecs ?? []), LANG_FACET] };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the params
  }, [key, ws, page, current.tokens[page]]);
  const server = useQuery({
    queryKey: knowledgeKeys.search(ws, serverRequest),
    queryFn: () => searchItems(ws, serverRequest),
    enabled: !local,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const nextToken = server.data?.nextPageToken;
  useEffect(() => {
    if (!local && nextToken && current.tokens[page + 1] !== nextToken) setPaging({ ...current, tokens: { ...current.tokens, [page + 1]: nextToken } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new token arrives
  }, [nextToken, local, page, key]);

  /* Local pool (only when needed). */
  const pool = useQuery({
    queryKey: [ws, "items", "browsePool", p.q],
    queryFn: () => listAll((pageToken) => searchItems(ws, { ...poolRequest(p, ws), pageToken }), (r) => r.results, POOL_LIMIT),
    enabled: local,
    staleTime: 30_000,
    retry: false,
  });
  const collections = useQuery({
    queryKey: [ws, "items", "browseCollections"],
    queryFn: () => listAllItems(ws, { filter: "itemType = COLLECTION" }),
    enabled: local,
    staleTime: 5 * 60_000,
  });
  // Space membership of documents is only needed to answer a Space selection locally.
  const spaceList = spaces.data;
  const materials = useQuery({
    queryKey: [ws, "spaces", "browseMaterials", (spaceList ?? []).map((s) => s.name)],
    enabled: local && spacesOn && !!spaceList,
    staleTime: 5 * 60_000,
    queryFn: () => Promise.all((spaceList ?? []).map((space) => listMaterials(ws, space.name ?? "").catch(() => []))),
  });

  /* Placeholder ("Search 230 documents"): the unfiltered result set's total, else one long-lived count probe. */
  const unfiltered = !local && !p.q && activeCount(p) === 0;
  const probe = useQuery({ queryKey: knowledgeKeys.search(ws, POOL_PROBE), queryFn: () => searchItems(ws, POOL_PROBE), enabled: !unfiltered, staleTime: 10 * 60_000, retry: false });
  const poolSize = unfiltered && server.data && !server.isPlaceholderData ? (server.data.totalSize ?? 0) : (probe.data?.totalSize ?? null);

  /* Labels. Owners are named by the searches' `document.owner` facet (`displayName`): no member read per owner. */
  const ownerNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const data of [probe.data, server.data])
      for (const f of data?.facets ?? []) if (f.field === "document.owner") for (const v of f.values ?? []) if (v.value && v.displayName) names.set(v.value, v.displayName);
    return names;
  }, [probe.data, server.data]);
  const sourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of server.data?.facets ?? []) if (f.field === "document.origin.source") for (const v of f.values ?? []) if (v.value) ids.add(resourceId(v.value));
    for (const r of pool.data ?? []) if (r.item?.document?.origin?.source) ids.add(resourceId(r.item.document.origin.source));
    for (const s of p.filters.src ?? []) if (s !== "upload") ids.add(s);
    return [...ids];
  }, [server.data, pool.data, p.filters.src]);
  const label = useFacetLabel({ ownerNames, sources: sourceIds });

  // Cheap to derive; recomputed per render so paging callbacks never go stale.
  const view = (): CatalogView => {
    const topicList = topics.data ?? [];
    const topicOrder = topicList.map((t) => resourceId(t.name));
    const roots = new Set((bases.data ?? []).map((b) => resourceId(b.name)));
    if (member.personalCollection) roots.add(resourceId(member.personalCollection));
    const spaceIds = (spaceList ?? []).map((space) => resourceId(space.name));
    const options = (f: BrowseFacetId, counts: Map<string, { count: number | null; label?: string }>): BrowseOption[] => {
      for (const v of p.filters[f] ?? []) if (!counts.has(v)) counts.set(v, { count: 0 });
      let opts = [...counts].map(([value, x]) => ({ value, label: label(f, value, x.label), ui: label.ui(f, value, x.label), count: x.count, on: !!p.filters[f]?.includes(value) }));
      // Collections are roots; sub-collections in `ancestors` aren't offered.
      if (f === "kb" && bases.isSuccess) opts = opts.filter((o) => o.on || roots.has(o.value));
      if (f === "upd") return UPDATED_WINDOWS.map(([w]) => opts.find((o) => o.value === w)!).filter(Boolean);
      if (f === "topic") return opts.sort((a, b) => topicOrder.indexOf(a.value) - topicOrder.indexOf(b.value));
      return opts.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label));
    };
    const common = { poolSize, page, setPage };

    if (local) {
      const ctx: LocalContext = {
        ws,
        topics: topicList,
        parents: new Map((collections.data ?? []).map((c) => [c.name ?? "", c.parentItem ?? ""])),
        spaces: new Map(
          (spaceList ?? []).map((space, i) => {
            const pinned = materials.data?.[i] ?? [];
            return [
              resourceId(space.name),
              {
                collections: new Set([...(space.collections ?? []), ...pinned.map((m) => m.item ?? "")]),
                documents: new Set(pinned.map((m) => resourceId(m.item))),
              },
            ];
          }),
        ),
      };
      const answer = answerLocally(pool.data ?? [], p, ctx, facets);
      const out: CatalogView["facets"] = {};
      for (const f of facets) {
        const m = new Map<string, { count: number | null }>();
        for (const [v, n] of answer.counts[f.id] ?? []) m.set(v, { count: n });
        if (f.id === "upd") for (const [w] of UPDATED_WINDOWS) if (!m.has(w)) m.set(w, { count: 0 });
        out[f.id] = options(f.id, m);
      }
      const pending = pool.isPending || collections.isPending || (spacesOn && (spaces.isPending || materials.isPending));
      return {
        ...common,
        rows: answer.rows.slice((page - 1) * PER_PAGE, page * PER_PAGE),
        total: answer.rows.length,
        facets: out,
        hasNext: page * PER_PAGE < answer.rows.length,
        isPending: pending,
        isError: pool.isError || collections.isError,
        error: pool.error ?? collections.error,
        refetch: () => Promise.all([pool.refetch(), collections.refetch()]),
      };
    }

    const data = server.data;
    const api = facetOptions(data?.facets, apiParams(p));
    const out: CatalogView["facets"] = {};
    for (const f of facets) {
      const m = new Map<string, { count: number | null; label?: string }>();
      if (f.id === "lang") {
        for (const v of data?.facets?.find((x) => x.field === LANG_FACET.field)?.values ?? []) if (v.value) m.set(v.value, { count: v.documentCount ?? 0 });
      } else if (f.id === "space") {
        for (const sid of spaceIds) m.set(sid, { count: null });
      } else if (f.id === "upd" && !data) {
        for (const [w] of UPDATED_WINDOWS) m.set(w, { count: null });
      } else {
        for (const o of api[f.id] ?? []) m.set(o.value, { count: o.count, label: o.label });
        // Every active domain is offered, with 0 when nothing under it matches.
        if (f.id === "topic" && data)
          for (const t of topicList) if (t.kind === "DOMAIN" && (!t.state || t.state === "ACTIVE") && !m.has(resourceId(t.name))) m.set(resourceId(t.name), { count: 0 });
      }
      out[f.id] = options(f.id, m);
    }
    return {
      ...common,
      rows: data?.results ?? [],
      total: data?.totalSize ?? 0,
      facets: out,
      hasNext: !!data?.nextPageToken,
      isPending: server.isPending,
      isError: server.isError,
      error: server.error,
      refetch: server.refetch,
    };
  };
  return view();
}

"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces/queries";

import { searchItems, type SearchItemsRequest, type SearchItemsResult } from "../api";
import { facetOptions, UPDATED_WINDOWS } from "../model";
import { knowledgeKeys, useKnowledgeBases, useTopics } from "../queries";
import { activeCount, apiParams, BROWSE_ONLY_FIELD, BROWSE_SCOPE, browseFacets, browseSearchRequest, PER_PAGE, setKey, type BrowseFacetId, type BrowseParams } from "./catalog";
import { useFacetLabel } from "./labels";

export interface BrowseOption {
  value: string;
  label: string;
  /** The label is UI vocabulary ("Past week", "My files"), translated; else a name people gave something. */
  ui: boolean;
  /** `null` when the count isn't known yet (Updated before the first answer). */
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
  /** A new result set is loading (first load, or a changed query while the previous results stay on screen). */
  isSearching: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** One long-lived probe: the Browse pool's size, and its owners with their names. */
const POOL_PROBE: SearchItemsRequest = { filter: BROWSE_SCOPE, pageSize: 1, facetSpecs: [{ field: "document.owner", limit: 100, excludedFromFilter: true }] };

/**
 * Browse results for URL params. One SearchItems call per result page answers filters, every facet
 * (disjunctive; Updated as `updateTime` intervals, topics rolled up into their domains, Space and
 * Language included), order and paging.
 */
export function useCatalog(p: BrowseParams): CatalogView {
  const { id: ws, hasModule, member } = useWorkspace();
  const spacesOn = hasModule("spaces");
  const facets = useMemo(() => browseFacets(spacesOn), [spacesOn]);
  const topics = useTopics();
  const bases = useKnowledgeBases();
  const spaces = useSpaces();
  const key = setKey(p);

  /* Paging: page tokens per page of this result set. */
  const [paging, setPaging] = useState<{ key: string; page: number; tokens: Record<number, string> }>({ key, page: 1, tokens: {} });
  const current = paging.key === key ? paging : { key, page: 1, tokens: {} };
  const page = current.page;
  const setPage = (n: number) => setPaging({ ...current, page: n });

  const serverRequest = useMemo<SearchItemsRequest>(
    () => browseSearchRequest(p, ws, { spaces: spacesOn, pageSize: PER_PAGE, pageToken: current.tokens[page] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the params
    [key, ws, spacesOn, page, current.tokens[page]],
  );
  const server = useQuery({
    queryKey: knowledgeKeys.search(ws, serverRequest),
    queryFn: ({ signal }) => searchItems(ws, serverRequest, { signal }),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const nextToken = server.data?.nextPageToken;
  useEffect(() => {
    if (nextToken && current.tokens[page + 1] !== nextToken) setPaging({ ...current, tokens: { ...current.tokens, [page + 1]: nextToken } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new token arrives
  }, [nextToken, page, key]);

  /* Placeholder ("Search 230 documents"): the unfiltered result set's total, else one long-lived count probe. */
  const unfiltered = !p.q && activeCount(p) === 0;
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
    for (const s of p.filters.src ?? []) if (s !== "upload") ids.add(s);
    return [...ids];
  }, [server.data, p.filters.src]);
  const label = useFacetLabel({ ownerNames, sources: sourceIds });

  // Cheap to derive; recomputed per render so paging callbacks never go stale.
  const topicList = topics.data ?? [];
  const topicOrder = topicList.map((t) => resourceId(t.name));
  const roots = new Set((bases.data ?? []).map((b) => resourceId(b.name)));
  if (member.personalCollection) roots.add(resourceId(member.personalCollection));
  const options = (f: BrowseFacetId, counts: Map<string, { count: number | null; label?: string }>): BrowseOption[] => {
    for (const v of p.filters[f] ?? []) if (!counts.has(v)) counts.set(v, { count: 0 });
    let opts = [...counts].map(([value, x]) => ({ value, label: label(f, value, x.label), ui: label.ui(f, value, x.label), count: x.count, on: !!p.filters[f]?.includes(value) }));
    // Collections are roots; sub-collections in `ancestors` aren't offered.
    if (f === "kb" && bases.isSuccess) opts = opts.filter((o) => o.on || roots.has(o.value));
    if (f === "upd") return UPDATED_WINDOWS.map(([w]) => opts.find((o) => o.value === w)!).filter(Boolean);
    if (f === "topic") return opts.sort((a, b) => topicOrder.indexOf(a.value) - topicOrder.indexOf(b.value));
    return opts.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label));
  };

  const data = server.data;
  const api = facetOptions(data?.facets, apiParams(p));
  const values = (field: string) => data?.facets?.find((x) => x.field === field)?.values ?? [];
  const out: CatalogView["facets"] = {};
  for (const f of facets) {
    const m = new Map<string, { count: number | null; label?: string }>();
    if (f.id === "lang") {
      for (const v of values(BROWSE_ONLY_FIELD.lang)) if (v.value) m.set(v.value, { count: v.documentCount ?? 0 });
    } else if (f.id === "space") {
      // Every space the caller sees is offered, with 0 when none of these results is in it; the facet names the rest.
      for (const s of spaces.data ?? []) if (s.state !== "DELETED") m.set(resourceId(s.name), { count: data ? 0 : null });
      for (const v of values(BROWSE_ONLY_FIELD.space)) if (v.value) m.set(resourceId(v.value), { count: v.documentCount ?? 0, label: v.displayName || undefined });
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
    poolSize,
    page,
    setPage,
    rows: data?.results ?? [],
    total: data?.totalSize ?? 0,
    facets: out,
    hasNext: !!data?.nextPageToken,
    isPending: server.isPending,
    isSearching: server.isFetching && (server.isPending || server.isPlaceholderData),
    isError: server.isError,
    error: server.error,
    refetch: server.refetch,
  };
}

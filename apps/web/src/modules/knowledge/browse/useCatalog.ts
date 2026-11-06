"use client";

import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { listAll, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { listAllItems, listMaterials, listSpaces, searchItems, type SearchItemsRequest, type SearchItemsResult } from "../api";
import { catalogFilter, catalogSearchRequest, facetOptions, UPDATED_WINDOWS } from "../model";
import { knowledgeKeys, useKnowledgeBases, useSavedItems, useTopics } from "../queries";
import { answerLocally, apiParams, browseFacets, isLocal, PER_PAGE, poolRequest, setKey, type BrowseFacetId, type BrowseParams, type LocalContext } from "./catalog";
import { useFacetLabel } from "./labels";

export interface BrowseOption {
  value: string;
  label: string;
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
  /** Saved documents (the "Only documents I saved" count). */
  savedCount: number;
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

/**
 * Browse results for URL params. SearchItems answers filters, facets (disjunctive), order and paging;
 * when a selection the API can't filter on is set (Space, Language, saved only), the readable pool
 * for the query is fetched once and answered locally with the same rules.
 */
export function useCatalog(p: BrowseParams): CatalogView {
  const { id: ws, hasModule, member } = useWorkspace();
  const spacesOn = hasModule("spaces");
  const facets = useMemo(() => browseFacets(spacesOn), [spacesOn]);
  const topics = useTopics();
  const bases = useKnowledgeBases();
  const saved = useSavedItems();
  const local = isLocal(p);
  const key = setKey(p);

  /* Paging: page tokens per page of this result set. */
  const [paging, setPaging] = useState<{ key: string; page: number; tokens: Record<number, string> }>({ key, page: 1, tokens: {} });
  const current = paging.key === key ? paging : { key, page: 1, tokens: {} };
  const page = current.page;
  const setPage = (n: number) => setPaging({ ...current, page: n });

  const needTopics = !!p.filters.topic?.length;
  const topicList = useMemo(() => topics.data ?? [], [topics.data]);
  const serverRequest = useMemo<SearchItemsRequest>(() => {
    const req = catalogSearchRequest(apiParams(p), ws, { topics: topicList, pageSize: PER_PAGE, pageToken: current.tokens[page] });
    return { ...req, facetSpecs: [...(req.facetSpecs ?? []), LANG_FACET] };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the params
  }, [key, ws, topicList, page, current.tokens[page]]);
  const server = useQuery({
    queryKey: knowledgeKeys.search(ws, serverRequest),
    queryFn: () => searchItems(ws, serverRequest),
    enabled: !local && (!needTopics || topics.isSuccess),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const nextToken = server.data?.nextPageToken;
  useEffect(() => {
    if (!local && nextToken && current.tokens[page + 1] !== nextToken) setPaging({ ...current, tokens: { ...current.tokens, [page + 1]: nextToken } });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new token arrives
  }, [nextToken, local, page, key]);

  /* Updated counts in server mode: one count per window (disjunctive: without the Updated selection). */
  const baseFilter = useMemo(() => catalogFilter({ ...apiParams(p), filters: { ...apiParams(p).filters, upd: undefined } }, ws, { topics: topicList }), [key, ws, topicList]); // eslint-disable-line react-hooks/exhaustive-deps
  const updCounts = useQueries({
    queries: UPDATED_WINDOWS.map(([wid, , days]) => {
      const since = new Date(Math.floor((Date.now() - days * 86_400_000) / 3_600_000) * 3_600_000).toISOString();
      const req: SearchItemsRequest = { query: p.q || undefined, filter: [baseFilter, `updateTime >= "${since}"`].filter(Boolean).join(" AND "), pageSize: 1 };
      return { queryKey: [...knowledgeKeys.search(ws, req), wid], queryFn: () => searchItems(ws, req), enabled: !local && (!needTopics || topics.isSuccess), retry: false, staleTime: 60_000 };
    }),
  });

  /* Domain counts in server mode: documents are tagged with topics, so a domain counts everything under it (disjunctive: without the Topic selection). */
  const domains = useMemo(() => topicList.filter((t) => t.kind === "DOMAIN" && (!t.state || t.state === "ACTIVE")).map((t) => resourceId(t.name)), [topicList]);
  // Built once per result set: the Updated clause embeds the current time, so per-render requests would never settle.
  const domainRequests = useMemo(
    () =>
      domains.map((d): SearchItemsRequest => ({
        query: p.q || undefined,
        filter: catalogFilter({ ...apiParams(p), filters: { ...apiParams(p).filters, topic: [d] } }, ws, { topics: topicList }),
        pageSize: 1,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the params
    [domains, key, ws, topicList],
  );
  const domainCounts = useQueries({
    queries: domainRequests.map((req) => ({ queryKey: [...knowledgeKeys.search(ws, req), "domain"], queryFn: () => searchItems(ws, req), enabled: !local, retry: false, staleTime: 60_000 })),
  });

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
  const spaces = useQuery({
    queryKey: [ws, "spaces", "browseIndex"],
    enabled: spacesOn,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const list = (await listSpaces(ws)).filter((s) => s.state !== "DELETED");
      return Promise.all(list.map(async (space) => ({ space, materials: await listMaterials(ws, space.name ?? "").catch(() => []) })));
    },
  });

  /* Count probe for the placeholder ("Search 230 documents"). */
  const all = useQuery({ queryKey: knowledgeKeys.search(ws, { pageSize: 1 }), queryFn: () => searchItems(ws, { pageSize: 1 }), staleTime: 60_000, retry: false });

  /* Labels. */
  const owners = useMemo(() => {
    const names = new Set<string>();
    for (const f of server.data?.facets ?? []) if (f.field === "document.owner") for (const v of f.values ?? []) if (v.value) names.add(v.value);
    for (const r of pool.data ?? []) if (r.item?.document?.owner) names.add(r.item.document.owner);
    for (const o of p.filters.owner ?? []) names.add(`workspaces/${ws}/members/${o}`);
    return [...names];
  }, [server.data, pool.data, p.filters.owner, ws]);
  const sourceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of server.data?.facets ?? []) if (f.field === "document.origin.source") for (const v of f.values ?? []) if (v.value) ids.add(resourceId(v.value));
    for (const r of pool.data ?? []) if (r.item?.document?.origin?.source) ids.add(resourceId(r.item.document.origin.source));
    for (const s of p.filters.src ?? []) if (s !== "upload") ids.add(s);
    return [...ids];
  }, [server.data, pool.data, p.filters.src]);
  const label = useFacetLabel({ owners, sources: sourceIds });

  // Cheap to derive; recomputed per render so paging callbacks never go stale.
  const view = (): CatalogView => {
    const topicOrder = topicList.map((t) => resourceId(t.name));
    const roots = new Set((bases.data ?? []).map((b) => resourceId(b.name)));
    if (member.personalCollection) roots.add(resourceId(member.personalCollection));
    const spaceIds = (spaces.data ?? []).map(({ space }) => resourceId(space.name));
    const options = (f: BrowseFacetId, counts: Map<string, { count: number | null; label?: string }>): BrowseOption[] => {
      for (const v of p.filters[f] ?? []) if (!counts.has(v)) counts.set(v, { count: 0 });
      let opts = [...counts].map(([value, x]) => ({ value, label: label(f, value, x.label), count: x.count, on: !!p.filters[f]?.includes(value) }));
      // Knowledge bases are roots; sub-collections in `ancestors` aren't offered.
      if (f === "kb" && bases.isSuccess) opts = opts.filter((o) => o.on || roots.has(o.value));
      if (f === "upd") return UPDATED_WINDOWS.map(([w]) => opts.find((o) => o.value === w)!).filter(Boolean);
      if (f === "topic") return opts.sort((a, b) => topicOrder.indexOf(a.value) - topicOrder.indexOf(b.value));
      return opts.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label));
    };
    const common = {
      poolSize: all.data?.totalSize ?? null,
      savedCount: saved.ids.size,
      page,
      setPage,
    };

    if (local) {
      const ctx: LocalContext = {
        ws,
        topics: topicList,
        parents: new Map((collections.data ?? []).map((c) => [c.name ?? "", c.parentItem ?? ""])),
        spaces: new Map(
          (spaces.data ?? []).map(({ space, materials }) => [
            resourceId(space.name),
            {
              collections: new Set([...(space.collections ?? []), ...materials.map((m) => m.item ?? "")]),
              documents: new Set(materials.map((m) => resourceId(m.item))),
            },
          ]),
        ),
      };
      const base = (pool.data ?? []).filter((r) => !p.saved || saved.ids.has(resourceId(r.item?.name)));
      const answer = answerLocally(base, p, ctx, facets);
      const out: CatalogView["facets"] = {};
      for (const f of facets) {
        const m = new Map<string, { count: number | null }>();
        for (const [v, n] of answer.counts[f.id] ?? []) m.set(v, { count: n });
        if (f.id === "upd") for (const [w] of UPDATED_WINDOWS) if (!m.has(w)) m.set(w, { count: 0 });
        out[f.id] = options(f.id, m);
      }
      const pending = pool.isPending || collections.isPending || (spacesOn && spaces.isPending) || (!!p.saved && saved.isPending);
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
      } else if (f.id === "upd") {
        UPDATED_WINDOWS.forEach(([w], i) => m.set(w, { count: updCounts[i].data?.totalSize ?? null }));
      } else {
        for (const o of api[f.id] ?? []) m.set(o.value, { count: o.count, label: o.label });
        if (f.id === "topic") domains.forEach((d, i) => domainCounts[i].data && m.set(d, { count: domainCounts[i].data.totalSize ?? 0 }));
      }
      out[f.id] = options(f.id, m);
    }
    return {
      ...common,
      rows: data?.results ?? [],
      total: data?.totalSize ?? 0,
      facets: out,
      hasNext: !!data?.nextPageToken,
      isPending: server.isPending || (needTopics && topics.isPending),
      isError: server.isError,
      error: server.error,
      refetch: server.refetch,
    };
  };
  return view();
}

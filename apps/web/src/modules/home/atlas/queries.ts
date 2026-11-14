"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";

import { useWorkspace } from "@/lib/workspace";
import { listAllItems, quote, searchItems, type Item } from "@/modules/knowledge/api";
import { baseColor, isLocked, isPersonal } from "@/modules/knowledge/bases/model";
import type { Resource } from "@/modules/knowledge/model";
import { useFeaturedIds, useKnowledgeModel } from "@/modules/knowledge/queries";

import { buildCollectionTree, type CollectionInput } from "./layout";

/**
 * Data for the Knowledge Atlas. One request draws the whole structure (every collection with its counts); documents load
 * per container only when its boxes come into view, and their boxes are already sized from the counts, so nothing moves.
 */
export const atlasKeys = {
  collections: (ws: string) => [ws, "atlas", "collections"] as const,
  docs: (ws: string, container: string) => [ws, "atlas", "docs", container] as const,
  search: (ws: string, q: string) => [ws, "atlas", "search", q] as const,
};

const PUBLISHED_DOCS = "itemType = DOCUMENT AND document.publicationState = PUBLISHED";
const DAY = 86_400_000;

/** How many readable documents changed in the last 30 days (Home's meta line): one `pageSize: 1` search read for its `totalSize`. */
export function useFreshCount({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  // Rounded to the hour so the query key is stable.
  const since = useMemo(() => new Date(Math.floor((Date.now() - 30 * DAY) / 3_600_000) * 3_600_000).toISOString(), []);
  const query = useQuery({
    queryKey: [id, "atlas", "fresh", since],
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      searchItems(id, {
        filter: `${PUBLISHED_DOCS} AND updateTime >= "${since}"`,
        pageSize: 1,
      }),
  });
  return query.data?.totalSize ?? 0;
}

/** Every collection the caller can see (locked roots included), as roots with their nested collections. */
export function useAtlasTree() {
  const { id } = useWorkspace();
  const query = useQuery({
    queryKey: atlasKeys.collections(id),
    queryFn: () => listAllItems(id, { filter: "itemType = COLLECTION", showLocked: true, view: "BASIC" }, 5000),
    staleTime: 60_000,
  });
  const tree = useMemo(() => {
    const items = query.data ?? [];
    const input: CollectionInput[] = items.map((i) => ({
      name: i.name ?? "",
      parentItem: i.parentItem ?? "",
      displayName: i.displayName ?? "",
      description: i.collection?.description ?? "",
      documentCount: i.collection?.documentCount ?? 0,
      locked: isLocked(i),
      personal: isPersonal(i),
      tone: baseColor(i.name ?? ""),
    }));
    return {
      ...buildCollectionTree(input),
      items: new Map(items.map((i) => [i.name ?? "", i])),
    };
  }, [query.data]);
  return { ...query, ...tree };
}

const TYPE_ORDER = [
  "handbook",
  "guide",
  "policy",
  "procedure",
  "form",
  "template",
  "calendar",
  "syllabus",
  "lecture",
  "lab",
  "assignment",
  "exam",
  "spec",
  "playbook",
  "contract",
  "paper",
  "thesis",
  "dataset",
  "protocol",
  "report",
  "sheet",
  "faq",
  "announcement",
  "reference",
  "notes",
];
const INTRO = /\b(overview|introduction|getting started|start here|read me|readme)\b|giới thiệu|tổng quan|bắt đầu|hướng dẫn chung/i;

/** The standard reading order inside a group: read first, overview-style titles, then by document type, then by name. */
export function orderDocuments(docs: readonly Resource[], featured: ReadonlySet<string>): Resource[] {
  const lead = (r: Resource) => (featured.has(r.id) ? 0 : INTRO.test(r.title) ? 1 : 2);
  const type = (r: Resource) => {
    const i = TYPE_ORDER.indexOf(r.kind);
    return i < 0 ? TYPE_ORDER.length : i;
  };
  return [...docs].sort(
    (a, b) =>
      lead(a) - lead(b) ||
      type(a) - type(b) ||
      a.title.localeCompare(b.title, "vi", {
        numeric: true,
        sensitivity: "base",
      }),
  );
}

/** The document model every container on the canvas shares, provided once by the atlas (not one model per box). */
export interface AtlasDocsModel {
  toResource: (item: Item) => Resource;
  featured: ReadonlySet<string>;
}
export const AtlasDocsContext = createContext<AtlasDocsModel | null>(null);

/** The shared document model for the atlas provider. */
export function useAtlasDocsModel(): AtlasDocsModel {
  const { toResource } = useKnowledgeModel();
  const featured = useFeaturedIds();
  return useMemo(() => ({ toResource, featured: featured.ids }), [toResource, featured.ids]);
}

/** A container's published documents in the standard order; `enabled` once its boxes are near the view. */
export function useContainerDocs(container: string | undefined, enabled: boolean) {
  const { id } = useWorkspace();
  const model = useContext(AtlasDocsContext);
  if (!model) throw new Error("useContainerDocs needs an AtlasDocsContext provider");
  const query = useQuery({
    queryKey: atlasKeys.docs(id, container ?? ""),
    queryFn: () =>
      listAllItems(
        id,
        {
          filter: `parentItem = ${quote(container ?? "")} AND ${PUBLISHED_DOCS}`,
          orderBy: "displayName",
          view: "BASIC",
        },
        2000,
      ),
    enabled: enabled && !!container,
    staleTime: 60_000,
  });
  const docs = useMemo(
    () =>
      orderDocuments(
        (query.data ?? []).map((i) => model.toResource(i)),
        model.featured,
      ),
    [query.data, model],
  );
  return { ...query, docs, featured: model.featured };
}

/**
 * Find in the map: collection names match on the client; documents come from the workspace search (titles and content,
 * permission-filtered), grouped by the collection that holds them.
 */
export function useAtlasSearch(q: string, toResource: AtlasDocsModel["toResource"]) {
  const { id } = useWorkspace();
  const query = useQuery({
    queryKey: atlasKeys.search(id, q),
    queryFn: () => searchItems(id, { query: q, filter: PUBLISHED_DOCS, pageSize: 100 }),
    enabled: q.length >= 2,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });
  // The maps change only with the results, so the layout (which depends on them) is not rebuilt on unrelated renders.
  const found = useMemo(() => {
    const byContainer = new Map<string, string[]>();
    const docs = new Map<string, Resource>();
    for (const r of query.data?.results ?? []) {
      const item: Item | undefined = r.item;
      if (!item?.name || !item.parentItem) continue;
      const res = toResource(item);
      if (res.isPersonal) continue;
      docs.set(item.name, res);
      const list = byContainer.get(item.parentItem);
      if (list) list.push(item.name);
      else byContainer.set(item.parentItem, [item.name]);
    }
    return { byContainer, docs };
  }, [query.data, toResource]);
  return { ...found, isFetching: query.isFetching, isError: query.isError, settled: !query.isPending || q.length < 2 };
}

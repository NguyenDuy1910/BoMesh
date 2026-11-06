"use client";

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { resourceId, type Schema } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import {
  clearRecentItems,
  createReadingList,
  createReadingListEntry,
  createSavedItem,
  createSavedSearch,
  deleteReadingList,
  deleteReadingListEntry,
  deleteRecentItem,
  deleteSavedItem,
  deleteSavedSearch,
  featuredItemIds,
  getContribution,
  getItem,
  getItemContent,
  getMember,
  getReadingList,
  getSource,
  ITEM_PERMISSIONS,
  listContributions,
  listItems,
  listMaterials,
  listMyContributions,
  listSpaces,
  testSpacePermissions,
  listReadingListEntries,
  listReadingLists,
  listRecentItems,
  listRootCollections,
  listSavedItems,
  listSavedSearches,
  listTopics,
  recordRecentItem,
  searchItems,
  testItemPermissions,
  updateReadingList,
  updateReadingListEntry,
  updateSavedSearch,
  type Item,
  type ItemPermission,
  type ListItemsOptions,
  type ReadingList,
  type SavedItem,
  type SavedSearch,
  type SearchItemsRequest,
} from "./api";
import { glanceOf, toResource, topicNames, type Glance, type ModelContext, type Resource } from "./model";
import type { Contribution } from "./api";

/** Query keys. Every key starts with the workspace ID; mutations invalidate by prefix. */
export const knowledgeKeys = {
  items: (ws: string) => [ws, "items"] as const,
  item: (ws: string, id: string) => [ws, "items", "one", id] as const,
  itemPermissions: (ws: string, id: string) => [ws, "items", "permissions", id] as const,
  list: (ws: string, options: ListItemsOptions) => [ws, "items", "list", options] as const,
  search: (ws: string, request: SearchItemsRequest) => [ws, "items", "search", request] as const,
  bases: (ws: string, showLocked: boolean) => [ws, "items", "bases", showLocked] as const,
  library: (ws: string) => [ws, "library"] as const,
  saved: (ws: string) => [ws, "library", "saved"] as const,
  recent: (ws: string) => [ws, "library", "recent"] as const,
  savedSearches: (ws: string) => [ws, "library", "savedSearches"] as const,
  readingLists: (ws: string) => [ws, "readingLists"] as const,
  readingListsFiltered: (ws: string, filter: string) => [ws, "readingLists", "list", filter] as const,
  readingList: (ws: string, id: string) => [ws, "readingLists", "one", id] as const,
  entries: (ws: string, id: string) => [ws, "readingLists", "entries", id] as const,
  featured: (ws: string) => [ws, "readingLists", "featured"] as const,
  contributions: (ws: string) => [ws, "contributions"] as const,
  contributionList: (ws: string, scope: string) => [ws, "contributions", "list", scope] as const,
  contribution: (ws: string, id: string) => [ws, "contributions", "one", id] as const,
  topics: (ws: string) => [ws, "topics"] as const,
  member: (ws: string, id: string) => [ws, "members", id] as const,
  source: (ws: string, id: string) => [ws, "sources", id] as const,
};

/** Refresh everything an item change can affect (lists, search, library, reading lists). */
export function invalidateKnowledge(qc: QueryClient, ws: string) {
  void qc.invalidateQueries({ queryKey: knowledgeKeys.items(ws) });
  void qc.invalidateQueries({ queryKey: knowledgeKeys.library(ws) });
  void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
  void qc.invalidateQueries({ queryKey: knowledgeKeys.contributions(ws) });
}

/* ═══════════════ Taxonomy, bases and the model ═══════════════ */

export function useTopics() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: knowledgeKeys.topics(id), queryFn: () => listTopics(id), staleTime: 5 * 60_000 });
}

/** Root collections ("knowledge bases"); `showLocked` adds discoverable ones the caller can't read (LOCKED). */
export function useKnowledgeBases({ showLocked = false }: { showLocked?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: knowledgeKeys.bases(id, showLocked), queryFn: () => listRootCollections(id, { showLocked }), staleTime: 60_000 });
}

/** Bases a member may contribute to: readable STANDARD roots that accept contributions. */
export function useContributionTargets() {
  const bases = useKnowledgeBases();
  const data = useMemo(
    () => (bases.data ?? []).filter((b) => b.access !== "LOCKED" && b.collection?.kind !== "PERSONAL" && b.collection?.acceptsContributions !== false),
    [bases.data],
  );
  return { ...bases, data };
}

/**
 * The resource model for this workspace: `toResource(item)` with document-type labels,
 * topic and base names and the caller's "My files" resolved.
 */
export function useKnowledgeModel(extraCollections?: ReadonlyMap<string, string>) {
  const { id, member, settings } = useWorkspace();
  const topics = useTopics();
  const bases = useKnowledgeBases();
  const ctx = useMemo<ModelContext>(() => {
    const collectionNames = new Map<string, string>(extraCollections ?? []);
    for (const b of bases.data ?? []) if (b.name) collectionNames.set(b.name, b.displayName ?? "");
    if (member.personalCollection) collectionNames.set(member.personalCollection, "My files");
    return {
      workspaceId: id,
      personalCollection: member.personalCollection,
      documentTypes: new Map((settings?.documentTypes ?? []).map((t) => [t.key ?? "", t.displayName ?? t.key ?? ""])),
      topicNames: topicNames(topics.data ?? []),
      collectionNames,
    };
  }, [id, member.personalCollection, settings?.documentTypes, topics.data, bases.data, extraCollections]);
  const map = useCallback((item: Item, extra?: { contribution?: Contribution | null; verifierName?: string }): Resource => toResource(item, ctx, extra), [ctx]);
  return { ctx, toResource: map, topics: topics.data ?? [], bases: bases.data ?? [] };
}

/* ═══════════════ Items ═══════════════ */

export function useItem(item: string | undefined | null) {
  const { id } = useWorkspace();
  const itemId = resourceId(item);
  return useQuery({ queryKey: knowledgeKeys.item(id, itemId), queryFn: () => getItem(id, itemId), enabled: !!itemId });
}

/** Reader content of a document (elements, page images). Only requested for readable documents. */
export function useItemContent(item: string | undefined | null, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const itemId = resourceId(item);
  return useQuery({
    queryKey: [...knowledgeKeys.item(id, itemId), "content"],
    queryFn: () => getItemContent(id, itemId),
    enabled: enabled && !!itemId,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** What a card preview shows for a resource (sections, first page image, length); `null` while loading or without content. */
export function useGlance(resource: Resource, { enabled = true }: { enabled?: boolean } = {}): Glance | null {
  const content = useItemContent(resource.name, { enabled: enabled && resource.readable });
  return useMemo(() => (content.data ? glanceOf(content.data, resource.format) : null), [content.data, resource.format]);
}

export function useListItems(options: ListItemsOptions, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: knowledgeKeys.list(id, options), queryFn: () => listItems(id, options), enabled, placeholderData: keepPreviousData });
}

/** SearchItems (Browse, ⌘K, /search, Related). Keeps the previous page while a new query loads. */
export function useSearchItems(request: SearchItemsRequest, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: knowledgeKeys.search(id, request), queryFn: () => searchItems(id, request), enabled, placeholderData: keepPreviousData });
}

/** Item-level abilities (`items:testIamPermissions`); `can(p)` is false until loaded. */
export function useItemPermissions(item: string | undefined | null, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const itemId = resourceId(item);
  const query = useQuery({
    queryKey: knowledgeKeys.itemPermissions(id, itemId),
    queryFn: () => testItemPermissions(id, itemId, ITEM_PERMISSIONS),
    enabled: enabled && !!itemId,
    staleTime: 60_000,
  });
  const granted = useMemo(() => new Set(query.data ?? []), [query.data]);
  const can = useCallback((p: ItemPermission) => granted.has(p), [granted]);
  return { ...query, can };
}

/* ═══════════════ People and sources (names shown with resources) ═══════════════ */

export function useMember(member: string | undefined | null) {
  const { id } = useWorkspace();
  const memberId = resourceId(member);
  return useQuery({ queryKey: knowledgeKeys.member(id, memberId), queryFn: () => getMember(id, memberId), enabled: !!memberId, staleTime: 10 * 60_000, retry: false });
}

/** Display names for many members at once (`name → displayName`). */
export function useMemberNames(members: readonly (string | undefined | null)[]) {
  const { id } = useWorkspace();
  const unique = [...new Set(members.map((m) => resourceId(m)).filter(Boolean))];
  const results = useQueries({
    queries: unique.map((memberId) => ({
      queryKey: knowledgeKeys.member(id, memberId),
      queryFn: () => getMember(id, memberId),
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
  const key = results.map((r) => r.data?.name ?? "").join("|");
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const r of results) if (r.data?.name) out.set(r.data.name, r.data.displayName ?? "");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the resolved names
  }, [key]);
}

export function useSource(source: string | undefined | null) {
  const { id } = useWorkspace();
  const sourceId = resourceId(source);
  return useQuery({ queryKey: knowledgeKeys.source(id, sourceId), queryFn: () => getSource(id, sourceId), enabled: !!sourceId, staleTime: 10 * 60_000, retry: false });
}

/* ═══════════════ Library: saved, recent, saved searches ═══════════════ */

export function useSavedItems() {
  const { id } = useWorkspace();
  const query = useQuery({ queryKey: knowledgeKeys.saved(id), queryFn: () => listSavedItems(id), staleTime: 60_000 });
  const ids = useMemo(() => new Set((query.data ?? []).map((s) => resourceId(s.item))), [query.data]);
  return { ...query, ids, isSaved: useCallback((item: string) => ids.has(resourceId(item)), [ids]) };
}

/** Save / unsave with an optimistic update. `mutate({ item, saved })` where `saved` is the new state. */
export function useToggleSaved() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ item, saved }: { item: string; saved: boolean }) => (saved ? createSavedItem(id, item).then(() => undefined) : deleteSavedItem(id, item)),
    onMutate: async ({ item, saved }) => {
      await qc.cancelQueries({ queryKey: knowledgeKeys.saved(id) });
      const prev = qc.getQueryData<SavedItem[]>(knowledgeKeys.saved(id));
      const itemId = resourceId(item);
      qc.setQueryData<SavedItem[]>(knowledgeKeys.saved(id), (list = []) =>
        saved ? [{ item: `workspaces/${id}/items/${itemId}`, createTime: new Date().toISOString() }, ...list] : list.filter((s) => resourceId(s.item) !== itemId),
      );
      return { prev };
    },
    onError: (_e, _v, context) => qc.setQueryData(knowledgeKeys.saved(id), context?.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: knowledgeKeys.saved(id) }),
  });
}

export function useRecentItems(pageSize = 50) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [...knowledgeKeys.recent(id), pageSize], queryFn: () => listRecentItems(id, pageSize) });
}

/** The Reader calls `mutate(itemId)` on open. */
export function useRecordRecent() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (item: string) => recordRecentItem(id, item), onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKeys.recent(id) }) });
}

export function useRemoveRecent() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (item: string) => deleteRecentItem(id, item), onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKeys.recent(id) }) });
}

export function useClearRecent() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => clearRecentItems(id), onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKeys.recent(id) }) });
}

export function useSavedSearches() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: knowledgeKeys.savedSearches(id), queryFn: () => listSavedSearches(id) });
}

export function useSavedSearchMutations() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: knowledgeKeys.savedSearches(id) });
  return {
    create: useMutation({ mutationFn: (s: SavedSearch) => createSavedSearch(id, s), onSuccess: done }),
    update: useMutation({
      mutationFn: ({ name, search, mask }: { name: string; search: SavedSearch; mask: string[] }) => updateSavedSearch(id, name, search, mask),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (name: string) => deleteSavedSearch(id, name), onSuccess: done }),
  };
}

/* ═══════════════ Reading lists ("Collections") ═══════════════ */

/** Visible reading lists (AIP-160 `filter`: `audience`, `space`, `owner`, `type`), newest first. */
export function useReadingLists(filter = "") {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: knowledgeKeys.readingListsFiltered(id, filter),
    queryFn: () => listReadingLists(id, { filter: filter || undefined, orderBy: "updateTime desc" }),
  });
}

/** Reading lists the caller can edit: own lists, plus WORKSPACE lists for `readingLists.publish` holders. Featured excluded. */
export function useEditableReadingLists() {
  const { memberId, member, can } = useWorkspace();
  const lists = useReadingLists();
  const data = useMemo(
    () =>
      (lists.data ?? []).filter(
        (l) => l.type !== "FEATURED" && (resourceId(l.owner) === memberId || l.owner === member.name || (l.audience === "WORKSPACE" && can("readingLists.publish"))),
      ),
    [lists.data, memberId, member.name, can],
  );
  return { ...lists, data };
}

export function useReadingList(list: string | undefined | null) {
  const { id } = useWorkspace();
  const listId = resourceId(list);
  return useQuery({ queryKey: knowledgeKeys.readingList(id, listId), queryFn: () => getReadingList(id, listId), enabled: !!listId });
}

export function useReadingListEntries(list: string | undefined | null) {
  const { id } = useWorkspace();
  const listId = resourceId(list);
  return useQuery({ queryKey: knowledgeKeys.entries(id, listId), queryFn: () => listReadingListEntries(id, listId), enabled: !!listId });
}

export function useReadingListMutations() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(id) });
  return {
    create: useMutation({ mutationFn: (list: ReadingList) => createReadingList(id, list), onSuccess: done }),
    update: useMutation({
      mutationFn: ({ list, patch, mask }: { list: string; patch: ReadingList; mask: string[] }) => updateReadingList(id, list, patch, mask),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (list: string) => deleteReadingList(id, list), onSuccess: done }),
    addEntry: useMutation({ mutationFn: ({ list, item, note }: { list: string; item: string; note?: string }) => createReadingListEntry(id, list, item, note), onSuccess: done }),
    updateEntry: useMutation({
      mutationFn: ({ list, item, note, position }: { list: string; item: string; note?: string; position?: number }) =>
        updateReadingListEntry(id, list, item, { note, position }, [...(note !== undefined ? (["note"] as const) : []), ...(position !== undefined ? (["position"] as const) : [])]),
      onSuccess: done,
    }),
    removeEntry: useMutation({ mutationFn: ({ list, item }: { list: string; item: string }) => deleteReadingListEntry(id, list, item), onSuccess: done }),
  };
}

/** Item IDs featured on Home (`readingLists/featured`). */
export function useFeaturedIds({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const query = useQuery({ queryKey: knowledgeKeys.featured(id), queryFn: () => featuredItemIds(id), enabled, staleTime: 60_000 });
  const ids = useMemo(() => new Set(query.data ?? []), [query.data]);
  return { ...query, ids };
}

/* ═══════════════ Contributions ═══════════════ */

/** The caller's contributions (My library → Contributions), newest activity first. */
export function useMyContributions({ filter, view = "BASIC" }: { filter?: string; view?: "BASIC" | "FULL" } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: knowledgeKeys.contributionList(id, `mine|${filter ?? ""}|${view}`),
    queryFn: () => listMyContributions(id, { filter, view }),
  });
}

/** Contributions visible to the caller (reviewers: their queue). */
export function useContributions({ filter, orderBy, view = "BASIC" }: { filter?: string; orderBy?: string; view?: "BASIC" | "FULL" } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: knowledgeKeys.contributionList(id, `all|${filter ?? ""}|${orderBy ?? ""}|${view}`),
    queryFn: () => listContributions(id, { filter, orderBy, view }),
  });
}

export function useContribution(contribution: string | undefined | null) {
  const { id } = useWorkspace();
  const cId = resourceId(contribution);
  return useQuery({ queryKey: knowledgeKeys.contribution(id, cId), queryFn: () => getContribution(id, cId), enabled: !!cId });
}

/* ═══════════════ Spaces (materials link documents to spaces; Spaces module only) ═══════════════ */

export interface ItemSpace {
  space: Schema<"Space">;
  /** The material pinning this item, when linked. */
  material?: string;
  /** The caller may pin/unpin materials here (`materials.create` + `.delete`). */
  manageable: boolean;
  /** The item's knowledge base belongs to this space (`collection.space`); not removable here. */
  viaBase: boolean;
}

/**
 * Spaces related to an item: where it's pinned as a material, the space of its knowledge base, and
 * every space whose materials the caller manages. Spaces module only (empty otherwise).
 */
export function useItemSpaces(item: string | undefined | null, { baseSpace, enabled = true }: { baseSpace?: string; enabled?: boolean } = {}) {
  const { id, hasModule } = useWorkspace();
  const itemId = resourceId(item);
  return useQuery({
    queryKey: [id, "spaces", "forItem", itemId, baseSpace ?? ""],
    enabled: enabled && !!itemId && hasModule("spaces"),
    queryFn: async (): Promise<ItemSpace[]> => {
      const spaces = (await listSpaces(id)).filter((s) => s.state !== "DELETED");
      return Promise.all(
        spaces.map(async (space) => {
          const [granted, materials] = await Promise.all([
            testSpacePermissions(id, space.name ?? "", ["materials.create", "materials.delete"]),
            space.callerRole ? listMaterials(id, space.name ?? "").catch(() => []) : Promise.resolve([]),
          ]);
          const material = materials.find((m) => resourceId(m.item) === itemId)?.name;
          return { space, material, manageable: granted.length === 2, viaBase: !!baseSpace && space.name === baseSpace };
        }),
      );
    },
  });
}

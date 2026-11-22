"use client";

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { ApiError, resourceId, type Schema } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { spacesListQuery } from "@/modules/spaces/queries";

import {
  batchGetItems,
  createSavedItem,
  createSavedSearch,
  deleteSavedItem,
  deleteSavedSearch,
  getContribution,
  getItem,
  getMember,
  getSource,
  ITEM_PERMISSIONS,
  listContributions,
  listItems,
  listMaterials,
  listMyContributions,
  testSpacePermissions,
  listRecentItems,
  listRootCollections,
  listSavedItems,
  listSavedSearches,
  listTopics,
  recordRecentItem,
  searchItems,
  testItemPermissions,
  updateSavedSearch,
  type Item,
  type ItemView,
  type ItemPermission,
  type ListItemsOptions,
  type SavedItem,
  type SavedSearch,
  type SearchItemsRequest,
} from "./api";
import { toResource, topicNames, type ModelContext, type Resource } from "./model";
import type { Contribution } from "./api";

/** Query keys. Every key starts with the workspace ID; mutations invalidate by prefix. */
export const knowledgeKeys = {
  items: (ws: string) => [ws, "items"] as const,
  item: (ws: string, id: string) => [ws, "items", "one", id] as const,
  byName: (ws: string, view: ItemView, ids: readonly string[]) => [ws, "items", "byName", view, ids] as const,
  itemPermissions: (ws: string, id: string) => [ws, "items", "permissions", id] as const,
  list: (ws: string, options: ListItemsOptions) => [ws, "items", "list", options] as const,
  search: (ws: string, request: SearchItemsRequest) => [ws, "items", "search", request] as const,
  bases: (ws: string) => [ws, "items", "bases"] as const,
  library: (ws: string) => [ws, "library"] as const,
  saved: (ws: string) => [ws, "library", "saved"] as const,
  recent: (ws: string) => [ws, "library", "recent"] as const,
  savedSearches: (ws: string) => [ws, "library", "savedSearches"] as const,
  contributions: (ws: string) => [ws, "contributions"] as const,
  contributionList: (ws: string, scope: string) => [ws, "contributions", "list", scope] as const,
  contribution: (ws: string, id: string) => [ws, "contributions", "one", id] as const,
  topics: (ws: string) => [ws, "topics"] as const,
  member: (ws: string, id: string) => [ws, "members", id] as const,
  source: (ws: string, id: string) => [ws, "sources", id] as const,
};

/** Refresh everything an item change can affect (lists, search, library, contributions). */
export function invalidateKnowledge(qc: QueryClient, ws: string) {
  void qc.invalidateQueries({ queryKey: knowledgeKeys.items(ws) });
  void qc.invalidateQueries({ queryKey: knowledgeKeys.library(ws) });
  void qc.invalidateQueries({ queryKey: knowledgeKeys.contributions(ws) });
}

/* ═══════════════ Topics, bases and the model ═══════════════ */

export function useTopics() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: knowledgeKeys.topics(id), queryFn: () => listTopics(id), staleTime: 5 * 60_000 });
}

/** Readable roots: the shared `showLocked` list without the LOCKED ones (the same set and order ListItems returns without `showLocked`). */
const readableBases = (bases: Item[]) => bases.filter((b) => b.access !== "LOCKED");

/**
 * Root collections (access boundaries); `showLocked` adds discoverable ones the caller can't read (LOCKED).
 * Both variants share one request (`showLocked=true`), so a page never lists the roots twice.
 */
export function useKnowledgeBases({ showLocked = false, enabled = true }: { showLocked?: boolean; enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: knowledgeKeys.bases(id),
    queryFn: () => listRootCollections(id, { showLocked: true }),
    select: showLocked ? undefined : readableBases,
    enabled,
    staleTime: 60_000,
  });
}

/** Bases a member may contribute to: readable STANDARD roots that accept contributions. */
export function useContributionTargets() {
  const bases = useKnowledgeBases();
  const data = useMemo(
    () => (bases.data ?? []).filter((b) => b.access !== "LOCKED" && b.itemType !== "PERSONAL" && b.collection?.acceptsContributions !== false),
    [bases.data],
  );
  return { ...bases, data };
}

/**
 * Display names of personal collections: the caller's is "My files"; other members' (readable by
 * admins) are named after their owner, so two "My files" never look like one collection.
 */
export function usePersonalCollectionNames(): ReadonlyMap<string, string> {
  const { member } = useWorkspace();
  const bases = useKnowledgeBases();
  const others = (bases.data ?? []).filter((b) => b.itemType === "PERSONAL" && b.name !== member.personalCollection);
  const owners = useMemberNames(others.map((b) => b.collection?.owner ?? b.creator));
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const b of others) {
      const owner = owners.get(b.collection?.owner ?? b.creator ?? "");
      if (b.name) out.set(b.name, owner ? `${owner}’s files` : "Personal files");
    }
    if (member.personalCollection) out.set(member.personalCollection, "My files");
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `bases.data` and `owners` capture `others`
  }, [bases.data, owners, member.personalCollection]);
}

/**
 * The resource model for this workspace: `toResource(item)` with
 * topic and base names and personal collections ("My files", others' files) resolved.
 */
export function useKnowledgeModel(extraCollections?: ReadonlyMap<string, string>) {
  const { id, member } = useWorkspace();
  const topics = useTopics();
  const bases = useKnowledgeBases();
  const personal = usePersonalCollectionNames();
  const ctx = useMemo<ModelContext>(() => {
    const collectionNames = new Map<string, string>(extraCollections ?? []);
    for (const b of bases.data ?? []) if (b.name) collectionNames.set(b.name, b.displayName ?? "");
    for (const [name, label] of personal) collectionNames.set(name, label);
    return {
      workspaceId: id,
      personalCollection: member.personalCollection,
      personalCollections: new Set(personal.keys()),
      topicNames: topicNames(topics.data ?? []),
      collectionNames,
    };
  }, [id, member.personalCollection, topics.data, bases.data, extraCollections, personal]);
  const map = useCallback((item: Item, extra?: { contribution?: Contribution | null; verifierName?: string }): Resource => toResource(item, ctx, extra), [ctx]);
  return { ctx, toResource: map, topics: topics.data ?? [], bases: bases.data ?? [] };
}

/* ═══════════════ Items ═══════════════ */

/** GetItem. `placeholder`: the item as a list already has it, shown while the full item loads (not cached). */
export function useItem(item: string | undefined | null, { placeholder }: { placeholder?: Item } = {}) {
  const { id } = useWorkspace();
  const itemId = resourceId(item);
  return useQuery({ queryKey: knowledgeKeys.item(id, itemId), queryFn: () => getItem(id, itemId), enabled: !!itemId, placeholderData: placeholder });
}

export interface ItemsByName {
  /** Item name → item, for the ones that loaded. */
  items: ReadonlyMap<string, Item>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * Items for many names at once (saved, recent, Home cards, contribution candidates) in one
 * ListItems batch read per 35 names, never one GetItem per row. Items the caller can't read are
 * simply missing from the map. FULL reads seed the `useItem` cache so detail views open
 * instantly. `reviewerReads`: the names may be contribution candidates the caller reads only
 * through the reviewer exception, which applies to GetItem alone; those missing from the batch
 * are then read one by one.
 */
export function useItemsByName(
  names: readonly (string | undefined | null)[],
  { view = "FULL", reviewerReads = false, enabled = true }: { view?: ItemView; reviewerReads?: boolean; enabled?: boolean } = {},
): ItemsByName {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const ids = [...new Set(names.map((n) => resourceId(n)).filter(Boolean))].sort();
  const query = useQuery({
    queryKey: knowledgeKeys.byName(id, view, ids),
    enabled: enabled && ids.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const items = await batchGetItems(id, ids, { view });
      if (reviewerReads) {
        const found = new Set(items.map((i) => resourceId(i.name)));
        const read = await Promise.all(
          ids
            .filter((i) => !found.has(i))
            .map((i) => getItem(id, i, view).catch((e: unknown) => (e instanceof ApiError && (e.status === 403 || e.status === 404) ? null : Promise.reject(e)))),
        );
        items.push(...read.filter((i): i is Item => !!i));
      }
      if (view === "FULL") for (const item of items) qc.setQueryData(knowledgeKeys.item(id, resourceId(item.name)), item);
      return items;
    },
  });
  const items = useMemo(() => new Map((query.data ?? []).filter((i) => !!i.name).map((i) => [i.name ?? "", i])), [query.data]);
  return {
    items,
    isPending: query.isPending && query.fetchStatus !== "idle",
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
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

export function useRecentItems(pageSize = 50, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [...knowledgeKeys.recent(id), pageSize], queryFn: () => listRecentItems(id, pageSize), enabled });
}

/** The Reader calls `mutate(itemId)` on open. */
export function useRecordRecent() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (item: string) => recordRecentItem(id, item), onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeKeys.recent(id) }) });
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
}

/**
 * Spaces related to an item: where it's pinned as a material, and every space whose materials the
 * caller manages. Spaces module only (empty otherwise).
 */
export function useItemSpaces(item: string | undefined | null, { enabled = true }: { enabled?: boolean } = {}) {
  const { id, hasModule } = useWorkspace();
  const qc = useQueryClient();
  const itemId = resourceId(item);
  return useQuery({
    queryKey: [id, "spaces", "forItem", itemId],
    enabled: enabled && !!itemId && hasModule("spaces"),
    queryFn: async (): Promise<ItemSpace[]> => {
      const spaces = (await qc.fetchQuery(spacesListQuery(id))).filter((s) => s.state !== "DELETED");
      return Promise.all(
        spaces.map(async (space) => {
          const [granted, materials] = await Promise.all([
            testSpacePermissions(id, space.name ?? "", ["materials.create", "materials.delete"]),
            space.callerRole ? listMaterials(id, space.name ?? "").catch(() => []) : Promise.resolve([]),
          ]);
          const material = materials.find((m) => resourceId(m.item) === itemId)?.name;
          return { space, material, manageable: granted.length === 2 };
        }),
      );
    },
  });
}

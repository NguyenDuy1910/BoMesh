"use client";

import { keepPreviousData, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { countContributions } from "@/modules/curation/api";

import { listAllItems, listItems, quote } from "../api";
import { knowledgeKeys, useKnowledgeBases } from "../queries";
import { getItemIamPolicy, listAccessRequests, listGroups, searchActiveMembers } from "./api";
import {
  EMPTY_FOLDERS,
  folderIndex,
  generalAccessOf,
  isEditor,
  isLocked,
  isOwner,
  isPersonal,
  type AccessRequest,
  type FolderIndex,
  type Item,
  type Policy,
} from "./model";

/** Collections the caller looks after: shared roots they own or edit (never My files or locked ones). */
export function useManagedCollections() {
  const collections = useKnowledgeBases();
  const data = useMemo(() => (collections.data ?? []).filter((b) => b.state !== "DELETED" && !isPersonal(b) && !isLocked(b) && isEditor(b)), [collections.data]);
  return { ...collections, data: collections.data ? data : undefined };
}

/** Managed collections with general access All members (preview `memberKbs`): what every member, and anyone who joins, reads. */
export function useAllMembersCollections(): Item[] {
  const collections = useManagedCollections();
  const policies = useBasePolicies(collections.data ?? []);
  return useMemo(() => (collections.data ?? []).filter((b) => generalAccessOf(b, policies.get(b.name ?? "")) === "workspace"), [collections.data, policies]);
}

/**
 * What waits on a collection's reviewers (preview `reviewAlert`): submissions in review, and documents that
 * were approved but couldn't be published (indexing FAILED). `enabled` = the caller reviews it.
 */
export function useCollectionReviewCounts(collection: Item | null | undefined, enabled: boolean) {
  const { id } = useWorkspace();
  const name = collection?.name ?? "";
  const inReview = `targetCollection = ${quote(name)} AND state = IN_REVIEW`;
  const failed = `itemKind = DOCUMENT AND ancestors:${quote(name)} AND document.indexingState = FAILED`;
  const submissions = useQuery({
    queryKey: knowledgeKeys.contributionList(id, `collectionReview|${inReview}`),
    queryFn: () => countContributions(id, inReview),
    enabled: enabled && !!name,
  });
  const problems = useQuery({
    queryKey: [...knowledgeKeys.items(id), "count", failed],
    queryFn: async () => (await listItems(id, { filter: failed, pageSize: 1, view: "BASIC" })).totalSize ?? 0,
    enabled: enabled && !!name,
  });
  return { submissions: submissions.data ?? 0, problems: problems.data ?? 0 };
}

/** Keys live under `[ws, "items"]` so every knowledge invalidation refreshes them too. */
export const basesKeys = {
  /** Shared with `useWhoCanSee` (ResourceDetails). */
  policy: (ws: string, id: string) => [ws, "items", "policy", id] as const,
  requests: (ws: string) => [ws, "requests", "collectionAccess"] as const,
  people: (ws: string) => [ws, "members", "shareable"] as const,
  groups: (ws: string) => [ws, "groups"] as const,
  folders: (ws: string, root: string) => [ws, "items", "folders", resourceId(root)] as const,
  folderCount: (ws: string, root: string) => [ws, "items", "folders", resourceId(root), "count"] as const,
};

/** The base's own IAM policy; owners only (`items.getIamPolicy`). */
export function useBasePolicy(base: Item | null | undefined) {
  const { id } = useWorkspace();
  const baseId = resourceId(base?.name);
  return useQuery({
    queryKey: basesKeys.policy(id, baseId),
    queryFn: () => getItemIamPolicy(id, baseId),
    enabled: !!baseId && isOwner(base),
    retry: false,
    staleTime: 60_000,
  });
}

/** Policies of every base the caller owns (list cards' access chips), keyed by item name. */
export function useBasePolicies(bases: readonly Item[]) {
  const { id } = useWorkspace();
  const owned = bases.filter((b) => isOwner(b) && b.itemType !== "PERSONAL" && b.name);
  const results = useQueries({
    queries: owned.map((b) => ({
      queryKey: basesKeys.policy(id, resourceId(b.name)),
      queryFn: () => getItemIamPolicy(id, resourceId(b.name)),
      retry: false,
      staleTime: 60_000,
    })),
  });
  // `dataUpdatedAt`, not the etag: an empty policy (a private collection) has none, and the card would miss its chip.
  const key = results.map((r) => r.dataUpdatedAt).join("|");
  return useMemo(() => {
    const out = new Map<string, Policy>();
    results.forEach((r, i) => {
      if (r.data) out.set(owned[i].name ?? "", r.data);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the loaded policies
  }, [key]);
}

/** Pending COLLECTION_ACCESS requests for one collection (the `collection` filter), from others or from one member. */
const pendingFor = (collection: string, requester: { is: string } | { not: string }) =>
  `(state = OPEN OR state = NEEDS_INFO) AND collection = ${quote(collection)} AND ${"is" in requester ? `requester = ${quote(requester.is)}` : `requester != ${quote(requester.not)}`}`;

/** Access requests an owner sees on a collection's Access tab (one page; `total` counts them all). */
const REQUESTS_PAGE = 50;

/** Pending requests other people sent for this base (its owners decide them): one page, and their count. */
export function usePendingRequestsFor(base: Item | null | undefined) {
  const { id, member, hasModule } = useWorkspace();
  const filter = pendingFor(base?.name ?? "", { not: member.name ?? "" });
  const query = useQuery({
    queryKey: [...basesKeys.requests(id), filter],
    queryFn: () => listAccessRequests(id, filter, REQUESTS_PAGE),
    enabled: !!base?.name && isOwner(base) && hasModule("requests"),
    staleTime: 30_000,
  });
  const data: AccessRequest[] = useMemo(() => query.data?.requests ?? [], [query.data]);
  return { ...query, data, total: query.data?.totalSize ?? data.length };
}

/** How many pending requests others sent for each collection the caller owns (one `pageSize=1` count each), keyed by name. */
export function usePendingRequestCounts(collections: readonly Item[]): ReadonlyMap<string, number> {
  const { id, member, hasModule } = useWorkspace();
  const owned = hasModule("requests") ? collections.filter((c) => isOwner(c) && c.name) : [];
  return useQueries({
    queries: owned.map((c) => {
      const filter = pendingFor(c.name ?? "", { not: member.name ?? "" });
      return { queryKey: [...basesKeys.requests(id), "count", filter], queryFn: async () => (await listAccessRequests(id, filter, 1)).totalSize ?? 0, staleTime: 30_000 };
    }),
    combine: (results) => new Map(results.flatMap((r, i) => (r.data === undefined ? [] : [[owned[i]?.name ?? "", r.data] as const]))),
  });
}

/** The caller's pending request for a base (`null` when none): one read of at most one request. */
export function useMyAccessRequest(baseName: string | null | undefined) {
  const { id, member, hasModule } = useWorkspace();
  const filter = pendingFor(baseName ?? "", { is: member.name ?? "" });
  const query = useQuery({
    queryKey: [...basesKeys.requests(id), filter],
    queryFn: () => listAccessRequests(id, filter, 1),
    enabled: !!baseName && hasModule("requests"),
    staleTime: 30_000,
  });
  const data: AccessRequest | null = query.data?.requests?.[0] ?? null;
  return { ...query, data };
}

/** Groups a base can be shared with (bounded workspace configuration). */
export function useShareGroups({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: basesKeys.groups(id), queryFn: () => listGroups(id), enabled, staleTime: 5 * 60_000 });
}

/** One page of active members matching `q` (name or email; the share pickers' search). Seeds the per-member cache, so a picked person is named without another read. */
export function useShareMemberSearch(q: string, pageSize: number, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...basesKeys.people(id), q.trim(), pageSize],
    queryFn: async () => {
      const page = await searchActiveMembers(id, q, pageSize);
      for (const m of page.members ?? []) qc.setQueryData(knowledgeKeys.member(id, resourceId(m.name)), m);
      return page.members ?? [];
    },
    enabled,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
}

const foldersFilter = (root: string) => `itemKind = COLLECTION AND ancestors:${quote(root)}`;

function foldersQuery(id: string, root: string) {
  return {
    queryKey: basesKeys.folders(id, root),
    queryFn: async () => folderIndex(root, await listAllItems(id, { filter: foldersFilter(root), orderBy: "displayName" }, 5000)),
    staleTime: 30_000,
  };
}

/** Every folder of a root collection the caller can read (Contents tree, Move picker). */
export function useFolders(root: string | null | undefined) {
  const { id } = useWorkspace();
  const query = useQuery({ ...foldersQuery(id, root ?? ""), enabled: !!root });
  return { ...query, index: query.data ?? EMPTY_FOLDERS };
}

/** Folders of several root collections, keyed by root name (only the ones loaded so far). */
export function useFolderIndexes(roots: readonly string[]): ReadonlyMap<string, FolderIndex> {
  const { id } = useWorkspace();
  return useQueries({
    queries: roots.map((root) => foldersQuery(id, root)),
    combine: (results) => new Map(results.flatMap((r) => (r.data ? [[r.data.root, r.data] as const] : []))),
  });
}

/** How many folders a collection holds (Collections cards); one page of one item, counted by the server. */
export function useFolderCount(root: string | null | undefined): number {
  const { id } = useWorkspace();
  const query = useQuery({
    queryKey: basesKeys.folderCount(id, root ?? ""),
    queryFn: async () => (await listItems(id, { filter: foldersFilter(root ?? ""), pageSize: 1, view: "BASIC" })).totalSize ?? 0,
    enabled: !!root,
    staleTime: 60_000,
  });
  return query.data ?? 0;
}

"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Globe, Lock, type LucideIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { api, call, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { batchGetItems, getItem } from "@/modules/knowledge/api";
import type { Resource } from "@/modules/knowledge/model";
import { invalidateKnowledge, knowledgeKeys, useItem, useKnowledgeBases, useKnowledgeModel } from "@/modules/knowledge/queries";

import { listAllContributions, listAllTopics, listCuratedItems, listReviewQueue, type Contribution, type Item, type Topic } from "./api";
import { useHeldDecisions } from "./decisions";
import { detailEntries, duplicatePairs, inScope, reviewEntries } from "./governance";
import { itemLifecycle, PROBLEM_KEYS, type QueueCounts } from "./model";

/** Query keys live under the knowledge prefixes so `invalidateKnowledge` refreshes them too. */
export const curationKeys = {
  queue: (ws: string) => [ws, "contributions", "review-queue"] as const,
  contributions: (ws: string) => [ws, "contributions", "curation-all"] as const,
  items: (ws: string) => [ws, "items", "curated"] as const,
  topics: (ws: string) => [ws, "topics", "all"] as const,
  policy: (ws: string, item: string) => [ws, "items", "policy", item] as const,
};

/** Refresh every curation read plus the shell's badges and the Overview. */
export function invalidateCuration(qc: QueryClient, ws: string) {
  invalidateKnowledge(qc, ws);
  void qc.invalidateQueries({ queryKey: knowledgeKeys.topics(ws) });
  void qc.invalidateQueries({ queryKey: [ws, "shell-badge"] });
  void qc.invalidateQueries({ queryKey: [ws, "overview"] });
}

export function useInvalidateCuration() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useCallback(() => invalidateCuration(qc, id), [qc, id]);
}

/** A submission with its candidate document (readable through the reviewer exception while open). */
export interface Submission {
  contribution: Contribution;
  item: Item | null;
}

/**
 * Candidates for contributions: one batch read (ListItems by name), then GetItem only for the
 * ones it leaves out — open candidates a reviewer reads through the reviewer exception, which
 * applies to GetItem alone.
 */
async function withCandidates(ws: string, contributions: Contribution[], known: ReadonlyMap<string, Item> = new Map()): Promise<Submission[]> {
  const found = new Map(known);
  const wanted = [...new Set(contributions.flatMap((c) => (c.item && !known.has(c.item) ? [c.item] : [])))];
  for (const item of await batchGetItems(ws, wanted, { view: "FULL" })) if (item.name) found.set(item.name, item);
  const read = await Promise.all(wanted.filter((n) => !found.has(n)).map((n) => getItem(ws, n, "FULL").catch(() => null)));
  for (const item of read) if (item?.name) found.set(item.name, item);
  return contributions.map((contribution) => ({ contribution, item: (contribution.item && found.get(contribution.item)) || null }));
}

/** The review queue: open submissions (analyzing + in review), oldest first. */
export function useReviewQueue({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: curationKeys.queue(id),
    enabled,
    queryFn: async () => withCandidates(id, await listReviewQueue(id)),
    // Analysis finishes in the background: poll while something is still being read.
    refetchInterval: (q) => (q.state.data?.some((s) => s.contribution.state === "ANALYZING") ? 4000 : false),
  });
}

/** Root collections the caller owns (the ones they review), shared ones only. */
export function useReviewableBases() {
  const bases = useKnowledgeBases();
  const data = useMemo(() => (bases.data ?? []).filter((b) => b.collection?.kind !== "PERSONAL" && b.access === "OWNER"), [bases.data]);
  return { ...bases, data };
}

/** Every root collection name that is someone's "My files". */
export function usePersonalRoots() {
  const bases = useKnowledgeBases();
  return useMemo(() => new Set((bases.data ?? []).filter((b) => b.collection?.kind === "PERSONAL").map((b) => b.name ?? "")), [bases.data]);
}

/** Live documents in shared collections the caller looks after (editor or owner; personal "My files" excluded). */
export function useCuratedItems({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const personal = usePersonalRoots();
  const bases = useKnowledgeBases();
  const query = useQuery({ queryKey: curationKeys.items(id), queryFn: () => listCuratedItems(id), enabled });
  const data = useMemo(() => {
    if (!query.data || !bases.data) return undefined;
    return query.data.filter((it) => {
      const root = it.ancestors?.[0]?.name ?? it.parentItem ?? "";
      return !personal.has(root) && (it.access === "EDITOR" || it.access === "OWNER");
    });
  }, [query.data, bases.data, personal]);
  return { ...query, data, isPending: query.isPending || bases.isPending };
}

/** Curated documents as resources: `pool` = published ones in scope (the To keep right queues), `visible` = every curated one by name. */
export function useCurationPool({ enabled = true }: { enabled?: boolean } = {}) {
  const items = useCuratedItems({ enabled });
  const { toResource } = useKnowledgeModel();
  const data = useMemo(() => {
    if (!items.data) return undefined;
    const all = items.data.map((it) => toResource(it));
    return { all, pool: all.filter(inScope), visible: new Map<string, Resource>(all.map((r) => [r.name, r])) };
  }, [items.data, toResource]);
  return { ...items, data };
}

/** Approved documents that stopped on the way to people, minus the ones still in review. */
export function problemItems(items: readonly Item[], inReview: ReadonlySet<string>): Item[] {
  return items.filter((it) => it.document?.publicationState === "PUBLISHED" && !inReview.has(it.name ?? "") && PROBLEM_KEYS.includes(itemLifecycle(it)));
}

/** Every contribution the caller can see (history for the document drawer, decided submissions). */
export function useAllContributions({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.contributions(id), enabled, queryFn: () => listAllContributions(id) });
}

/** Decided-but-unpublished submissions (changes requested, declined) with their candidates when readable. */
export function useClosedSubmissions(contributions: Contribution[] | undefined, known: ReadonlyMap<string, Item>) {
  const { id } = useWorkspace();
  const pending = (contributions ?? []).filter((c) => c.state === "CHANGES_REQUESTED" || c.state === "REJECTED");
  const key = pending.map((c) => `${c.name}:${c.etag}`).join("|");
  return useQuery({
    queryKey: [...curationKeys.contributions(id), "closed", key],
    enabled: !!contributions,
    queryFn: () => withCandidates(id, pending, known),
  });
}

/** Domains and topics in every state the caller may see (proposals for admins), archived included. */
export function useAllTopics({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.topics(id), enabled, queryFn: () => listAllTopics(id, { deleted: true }) });
}

/** Writes a saved topic into the taxonomy list at once, so the editor doesn't flash the old values until the refetch. */
export function useRememberTopic() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useCallback(
    (topic: Topic) =>
      qc.setQueryData<Topic[]>(curationKeys.topics(id), (list) =>
        list && (list.some((x) => x.name === topic.name) ? list.map((x) => (x.name === topic.name ? topic : x)) : [...list, topic]),
      ),
    [qc, id],
  );
}

/** Who reads a collection's published documents (preview `X.whoCanSee`): from its IAM policy, which its owners may read. */
export function useCollectionAudience(collection: string | undefined | null): { icon: LucideIcon; label: string } | null {
  const { id, workspace } = useWorkspace();
  const baseId = resourceId(collection);
  const base = useItem(baseId || null);
  const policy = useQuery({
    queryKey: curationKeys.policy(id, baseId),
    queryFn: () => call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:getIamPolicy", { params: { path: { workspace: id, item: baseId } }, body: {} })),
    enabled: !!baseId && base.data?.access === "OWNER",
    retry: false,
    staleTime: 60_000,
  });
  if (!baseId) return null;
  if (policy.data?.bindings?.some((b) => b.members.includes("workspaceMembers"))) return { icon: Globe, label: `Everyone in ${workspace.displayName}` };
  const name = base.data?.displayName;
  return { icon: Lock, label: name ? `People with access to ${name}` : "People with access" };
}

export interface ReviewQueueCountsData extends QueueCounts {
  /** Preview queues without an API (first-sync batches, low-confidence topics): never counted. */
  batches?: undefined;
  confirm?: undefined;
  /** Published documents in scope, and how many of them are verified (Knowledge health's share). */
  published: number;
  verified: number;
}

/**
 * Items per Review queue for the collections the caller reviews (preview `X.reviewQueues`): the queue chooser,
 * the Studio landing and Overview → Knowledge health. `data` stays undefined for callers who don't review.
 */
export function useReviewQueueCounts(): { data?: ReviewQueueCountsData; isPending: boolean } {
  const { can } = useWorkspace();
  const enabled = can("contributions.review");
  const queue = useReviewQueue({ enabled });
  const held = useHeldDecisions();
  const curated = useCurationPool({ enabled });
  const data = useMemo<ReviewQueueCountsData | undefined>(() => {
    if (!enabled || !queue.data || !curated.data) return undefined;
    const open = queue.data.filter((s) => !held.has(s.contribution.name ?? ""));
    const inReview = new Set(queue.data.flatMap((s) => (s.contribution.item ? [s.contribution.item] : [])));
    const { pool, visible, all } = curated.data;
    return {
      submissions: open.length,
      problems: problemItems(
        all.map((r) => r.item),
        inReview,
      ).length,
      reverify: reviewEntries(pool).length,
      details: detailEntries(pool).length,
      duplicates: duplicatePairs(pool, visible).length,
      published: pool.length,
      verified: pool.filter((r) => r.item.document?.verification?.state === "VERIFIED").length,
    };
  }, [enabled, queue.data, curated.data, held]);
  return { data, isPending: enabled && (queue.isPending || curated.isPending) };
}

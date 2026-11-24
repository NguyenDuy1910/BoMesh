"use client";

import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Building2, Lock, type LucideIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { api, call, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { batchGetItems, getItem } from "@/modules/knowledge/api";
import type { Resource } from "@/modules/knowledge/model";
import { invalidateKnowledge, knowledgeKeys, useItem, useKnowledgeBases, useKnowledgeModel } from "@/modules/knowledge/queries";

import {
  countAssistantTagged,
  getRunTask,
  lastTopicImport,
  listActiveIngestionRuns,
  listAnalyzingContributions,
  listAllContributions,
  listAllTopics,
  listAssistantTaggedDocuments,
  listCuratedItems,
  listDocumentsWithoutTopic,
  listOpenTopicCorrections,
  listReviewQueue,
  listRunTasks,
  type Contribution,
  type IngestionRun,
  type IngestionTask,
  type Item,
  type Topic,
} from "./api";
import { useHeldDecisions } from "./decisions";
import { detailEntries, duplicatePairs, inScope, reviewEntries } from "./governance";
import { isCandidate, processingOf, readyToReview, toProcess } from "./lifecycle";
import type { DocCounts } from "./model";
import { FINISHED_TASKS, mergeTasks, nextTaskRead, RUNNING_TASKS, taskKey, type RunSync } from "./processingSteps";

/** Query keys live under the knowledge prefixes so `invalidateKnowledge` refreshes them too. */
export const curationKeys = {
  queue: (ws: string) => [ws, "contributions", "review-queue"] as const,
  contributions: (ws: string) => [ws, "contributions", "curation-all"] as const,
  items: (ws: string) => [ws, "items", "curated"] as const,
  topics: (ws: string) => [ws, "topics", "all"] as const,
  policy: (ws: string, item: string) => [ws, "items", "policy", item] as const,
  /** One page of Documents → All (filter, order, page token). */
  documents: (ws: string, filter: string, orderBy: string, pageToken: string) => [ws, "items", "documents-page", filter, orderBy, pageToken] as const,
  /** The workspace's runs in flight (the processing strip). */
  activeRuns: (ws: string) => [ws, "ingestionRuns", "active"] as const,
  /** A run's tasks, kept between polls (under the active runs, so invalidating them reads what changed). */
  runTasks: (ws: string, run: string) => [ws, "ingestionRuns", "active", "tasks", run] as const,
  /** Topics → Suggestions: open topic corrections (under the topics prefix), assistant-tagged and topicless documents. */
  corrections: (ws: string) => [ws, "topics", "corrections-open"] as const,
  assistantTagged: (ws: string) => [ws, "items", "assistant-topics"] as const,
  withoutTopic: (ws: string) => [ws, "items", "without-topic"] as const,
};

/** Refresh every curation read plus the shell's badges and the Overview. */
export function invalidateCuration(qc: QueryClient, ws: string) {
  invalidateKnowledge(qc, ws);
  void qc.invalidateQueries({ queryKey: knowledgeKeys.topics(ws) });
  void qc.invalidateQueries({ queryKey: [ws, "shell-badge"] });
  void qc.invalidateQueries({ queryKey: [ws, "overview"] });
  void qc.invalidateQueries({ queryKey: curationKeys.activeRuns(ws) });
}

export function useInvalidateCuration() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useCallback(() => invalidateCuration(qc, id), [qc, id]);
}

/** Runs in flight in this workspace (QUEUED or RUNNING), newest first: polled every 3 s only while one is active. */
export function useActiveRuns() {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: curationKeys.activeRuns(id),
    queryFn: () => listActiveIngestionRuns(id),
    retry: false,
    refetchInterval: (q) => (q.state.data?.length ? 3000 : false),
  });
}

/** The tasks of each run in flight, as one structurally shared list: unchanged runs keep their objects. */
const taskData = (results: readonly { data?: RunSync }[]) => results.map((r) => r.data?.tasks);

/**
 * Where each document of the runs in flight is: its task by item ID (the newest run's when a document is in two),
 * polled every 3 s while a run is in flight and the page is visible. The first read lists a run's tasks; each poll then
 * reads at most what can have changed (`nextTaskRead`: the running tasks, or the ones that finished since — nothing
 * while every task waits). A poll that changes nothing keeps the same map, so the views don't re-render. Undefined
 * while no run is in flight, so a finished run's tasks never linger on rows.
 */
export function useActiveTasks(): ReadonlyMap<string, IngestionTask> | undefined {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const runs = useActiveRuns();
  const names = (runs.data ?? []).flatMap((r) => (r.name ? [r.name] : []));
  const data = useQueries({
    queries: names.map((name) => ({
      queryKey: curationKeys.runTasks(id, name),
      queryFn: async (): Promise<RunSync> => {
        const known = qc.getQueryData<RunSync>(curationKeys.runTasks(id, name));
        if (!known) return { tasks: Object.fromEntries((await listRunTasks(name)).map((t) => [taskKey(t), t])), last: null };
        // The freshest counts: the runs poll keeps them.
        const run = qc.getQueryData<IngestionRun[]>(curationKeys.activeRuns(id))?.find((r) => r.name === name);
        const read = nextTaskRead(known, run?.counts);
        if (!read) return { ...known, last: null };
        const tasks = await (read.kind === "running"
          ? listRunTasks(name, { filter: RUNNING_TASKS })
          : listRunTasks(name, { filter: FINISHED_TASKS, orderBy: "endTime desc", limit: read.limit }));
        return { tasks: mergeTasks(known.tasks, tasks), last: read.kind };
      },
      refetchInterval: 3000,
    })),
    combine: taskData,
  });
  const active = names.length > 0;
  return useMemo(() => {
    if (!active) return undefined;
    const byItem = new Map<string, IngestionTask>();
    for (const tasks of data) for (const [item, task] of Object.entries(tasks ?? {})) if (!byItem.has(item)) byItem.set(item, task);
    return byItem;
  }, [active, data]);
}

/** A document's task in its latest run (a failure's steps): finished tasks never change. */
export function useRunTask(run: string | undefined, item: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "ingestionRuns", "task", run, item], enabled: enabled && !!run, queryFn: () => getRunTask(run ?? "", item), staleTime: Infinity, retry: false });
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

/** What the review queue's poll compares: its submissions still being analyzed, by name and etag. */
const analyzingKey = (contributions: readonly Contribution[]) =>
  contributions
    .filter((c) => c.state === "ANALYZING")
    .map((c) => `${c.name}:${c.etag ?? c.updateTime ?? ""}`)
    .sort()
    .join("|");

/**
 * The review queue: open submissions (analyzing + in review), oldest first. Analysis finishes in the background, so
 * while a submission is still being analyzed a small poll (every 4 s; BASIC view, analyzing ones only) watches for a
 * change, and only then is the queue with its candidates read again.
 */
export function useReviewQueue({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  const queue = useQuery({
    queryKey: curationKeys.queue(id),
    enabled,
    queryFn: async () => withCandidates(id, await listReviewQueue(id)),
  });
  const analyzing = useMemo(() => analyzingKey((queue.data ?? []).map((s) => s.contribution)), [queue.data]);
  useQuery({
    queryKey: [...curationKeys.queue(id), "analyzing"],
    enabled: enabled && !!analyzing,
    queryFn: async () => {
      const now = analyzingKey(await listAnalyzingContributions(id));
      const known = analyzingKey((qc.getQueryData<Submission[]>(curationKeys.queue(id)) ?? []).map((s) => s.contribution));
      if (now !== known) void qc.invalidateQueries({ queryKey: curationKeys.queue(id), exact: true });
      return now;
    },
    initialData: analyzing,
    initialDataUpdatedAt: queue.dataUpdatedAt,
    staleTime: 3000,
    refetchInterval: 4000,
  });
  return queue;
}

/** Root collections the caller owns (the ones they review), shared ones only. */
export function useReviewableBases() {
  const bases = useKnowledgeBases();
  const data = useMemo(() => (bases.data ?? []).filter((b) => b.itemType !== "PERSONAL" && b.access === "OWNER"), [bases.data]);
  return { ...bases, data };
}

/** Every root collection name that is someone's "My files". */
export function usePersonalRoots() {
  const bases = useKnowledgeBases();
  return useMemo(() => new Set((bases.data ?? []).filter((b) => b.itemType === "PERSONAL").map((b) => b.name ?? "")), [bases.data]);
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

/** Curated documents as resources: `pool` = published ones in scope (All's Quality lists), `visible` = every curated one by name. */
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

/** Review: open submissions ready to decide (a new document once processed, or a format that can't be; every new version). */
export const reviewReady = (queue: readonly Submission[]) => queue.filter((s) => readyToReview(s.contribution, s.item));

/** One row of Documents → Processing: a document, or a new document's submission with its candidate. */
export interface ProcessingEntry {
  item: Item;
  /** The open NEW_DOCUMENT contribution, for a submission. */
  contribution: Contribution | null;
}

/**
 * Documents → Processing (preview `processingQueue`): new documents' submissions not processed yet, first, then curated
 * documents that aren't processed for their current revision (`toProcess`). A document an open submission holds is
 * listed through its submission only (or not at all, for a new version). `decided`: contribution names with a decision
 * in its Undo window (left out). `live` (the tasks of the runs in flight, Processing's rows only): what a run holds
 * stays listed until it ends — waiting, running, failed or processed — so its rows don't jump.
 */
export function processingQueue(
  items: readonly Item[],
  queue: readonly Submission[],
  decided: ReadonlySet<string> = new Set(),
  live?: ReadonlyMap<string, IngestionTask>,
): ProcessingEntry[] {
  const held = new Set(queue.flatMap((s) => (s.contribution.item ? [s.contribution.item] : [])));
  const listed = (s: { item: Item; contribution?: Contribution }) => {
    const task = live?.get(resourceId(s.item.name))?.state;
    return toProcess(s) || (!!task && task !== "CANCELLED");
  };
  const subs = queue.flatMap((s) => (s.item && !decided.has(s.contribution.name ?? "") && isCandidate(s.contribution) && listed({ item: s.item, contribution: s.contribution }) ? [{ item: s.item, contribution: s.contribution }] : []));
  const docs = items.filter((it) => !held.has(it.name ?? "") && listed({ item: it })).map((item) => ({ item, contribution: null }));
  return [...subs, ...docs];
}

/** A Processing entry that waits on the caller: a submission (its contributor waits), a failure or a change at the source. */
export const waitsOnCaller = (e: ProcessingEntry) => !!e.contribution || ["failed", "outdated"].includes(processingOf(e));

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

/** Writes a saved topic into the topics list at once, so the editor doesn't flash the old values until the refetch. */
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

/** Open topic corrections (Topics → Suggestions → Keywords from reviewers’ corrections; `topics.update`). */
export function useOpenTopicCorrections({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.corrections(id), enabled, queryFn: () => listOpenTopicCorrections(id) });
}

/** Documents carrying topics the assistant applied and nobody confirmed (Topics → Suggestions → Topics to confirm). */
export function useAssistantTaggedDocuments({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.assistantTagged(id), enabled, queryFn: () => listAssistantTaggedDocuments(id) });
}

/** Documents carrying `topic` as the assistant applied it, unconfirmed (a topic's Distribution: "n to confirm"). */
export function useAssistantTaggedCount(topic: string) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [...curationKeys.assistantTagged(id), "count", topic], queryFn: () => countAssistantTagged(id, topic), staleTime: 60_000 });
}

/** Who imported the topics last and when (audit log); under the topics prefix, so an import refreshes it. */
export function useLastTopicImport({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "topics", "last-import"], enabled, queryFn: () => lastTopicImport(id), staleTime: 60_000 });
}

/** Processed documents without a topic (Topics → Suggestions → Without a topic). */
export function useDocumentsWithoutTopic({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.withoutTopic(id), enabled, queryFn: () => listDocumentsWithoutTopic(id) });
}

/**
 * Who reads a collection's published documents (preview `X.whoCanSee`): from the IAM policy of the collection that
 * decides its access — a folder's root, or the folder itself when it doesn't inherit access — which its owners may
 * read. Named by its path ("Root › Folder").
 */
export function useCollectionAudience(collection: string | undefined | null): { icon: LucideIcon; label: string } | null {
  const { id, workspace } = useWorkspace();
  const baseId = resourceId(collection);
  const base = useItem(baseId || null);
  const root = base.data?.ancestors?.[0]?.name;
  const boundary = root && base.data?.collection?.inheritAccess !== false ? resourceId(root) : baseId;
  const policy = useQuery({
    queryKey: curationKeys.policy(id, boundary),
    queryFn: () => call(api.POST("/api/v1/workspaces/{workspace}/items/{item}:getIamPolicy", { params: { path: { workspace: id, item: boundary } }, body: {} })),
    enabled: !!boundary && base.data?.access === "OWNER",
    retry: false,
    staleTime: 60_000,
  });
  // Nothing until it's known: a placeholder audience would flash before the real one.
  if (!baseId || base.isPending || (policy.isPending && policy.fetchStatus !== "idle")) return null;
  if (policy.data?.bindings?.some((b) => b.members.includes("workspaceMembers"))) return { icon: Building2, label: `All members of ${workspace.displayName}` };
  const name = [...(base.data?.ancestors ?? []).map((a) => a.displayName), base.data?.displayName].filter(Boolean).join(" › ");
  return { icon: Lock, label: name ? `People with access to ${name}` : "People with access" };
}

export interface DocCountsData extends DocCounts {
  /** Preview views without an API (first-sync batches, low-confidence topics): never counted. */
  batches?: undefined;
  confirm?: undefined;
  /** Published documents in scope, and how many of them are verified (Knowledge health's share). */
  published: number;
  verified: number;
}

/**
 * Items per Documents view for the collections the caller reviews (preview `X.reviewQueues`): the view tabs, the
 * Studio landing and Overview → Knowledge health. `data` stays undefined for callers who don't review.
 */
export function useDocCounts(): { data?: DocCountsData; isPending: boolean } {
  const { can } = useWorkspace();
  const enabled = can("contributions.review");
  const queue = useReviewQueue({ enabled });
  const held = useHeldDecisions();
  const curated = useCurationPool({ enabled });
  const data = useMemo<DocCountsData | undefined>(() => {
    if (!enabled || !queue.data || !curated.data) return undefined;
    const open = queue.data.filter((s) => !held.has(s.contribution.name ?? ""));
    const { pool, visible, all } = curated.data;
    const proc = processingQueue(
      all.map((r) => r.item),
      queue.data,
      held,
    );
    return {
      review: reviewReady(open).length,
      processing: proc.length,
      waiting: proc.filter(waitsOnCaller).length,
      submissions: proc.filter((e) => e.contribution).length,
      reverify: reviewEntries(pool).length,
      details: detailEntries(pool).length,
      duplicates: duplicatePairs(pool, visible).length,
      published: pool.length,
      verified: pool.filter((r) => r.item.document?.verification?.state === "VERIFIED").length,
    };
  }, [enabled, queue.data, curated.data, held]);
  return { data, isPending: enabled && (queue.isPending || curated.isPending) };
}

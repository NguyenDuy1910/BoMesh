"use client";

import { keepPreviousData, useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Building2, Lock, type LucideIcon } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";

import { api, call, resourceId } from "@/lib/api/client";
import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { batchGetItems, getItem, listItems, searchItems, type Concept } from "@/modules/knowledge/api";
import { invalidateKnowledge, knowledgeKeys, useItem, useKnowledgeBases, useTaxonomy } from "@/modules/knowledge/queries";
import { buildTaxonomy, classSchemes, type Taxonomy } from "@/modules/knowledge/taxonomy";

import {
  batchGetRunTasks,
  countContributions,
  countItems,
  getRunTask,
  listActiveIngestionRuns,
  listRunTasksPage,
  pageContributionsOf,
  type Contribution,
  type IngestionRun,
  type IngestionTask,
  type Item,
} from "./api";
import { useHeldDecisions } from "./decisions";
import { detailsFilter, documentsToProcess, publishedFilter, REVIEW_READY, reverifyFilter, SUBMISSIONS_TO_PROCESS, suggestedFilter, unclassifiedFilter } from "./docFilter";
import { requiredSchemeNames, suggestedGroups, type SuggestedGroup } from "./governance";
import type { DocCounts } from "./model";
import { FIRST_RUN_PAGE, nextRunTaskCursor, taskKey, type RunTaskCursor } from "./processingSteps";
import {
  compileClassificationPrompt,
  listConceptRules,
  listOpenProposals,
  listSchemeVersions,
  listSharedLabels,
  publishConceptScheme,
  type ConceptProposal,
  type ConceptScheme,
} from "./taxonomyApi";

/** Query keys live under the knowledge prefixes so `invalidateKnowledge` refreshes them too. */
export const curationKeys = {
  policy: (ws: string, item: string) => [ws, "items", "policy", item] as const,
  /** One page of Documents → All (filter, order, page token). */
  documents: (ws: string, filter: string, orderBy: string, pageToken: string) => [ws, "items", "documents-page", filter, orderBy, pageToken] as const,
  /** The workspace's runs in flight (the processing strip). */
  activeRuns: (ws: string) => [ws, "ingestionRuns", "active"] as const,
  /** The tasks of the documents on screen in a run in flight (under the active runs, so invalidating them reads them again). */
  runTasks: (ws: string, run: string) => [ws, "ingestionRuns", "active", "tasks", run] as const,
  /** Classification › Gợi ý: the suggested-label facet and card lists (under items, so any document change refreshes them). */
  suggested: (ws: string) => [ws, "items", "suggested-concepts"] as const,
  /** Classification's side reads, under the taxonomy prefix so a taxonomy edit refreshes them. */
  schemePreview: (ws: string, scheme: string, etag: string) => [ws, "taxonomy", "preview", scheme, etag] as const,
  schemeVersions: (ws: string, scheme: string) => [ws, "taxonomy", "versions", scheme] as const,
  sharedLabels: (ws: string) => [ws, "taxonomy", "sharedLabels"] as const,
  proposals: (ws: string) => [ws, "taxonomy", "proposals"] as const,
  conceptRules: (ws: string, concept: string) => [ws, "taxonomy", "rules", concept] as const,
  prompt: (ws: string) => [ws, "taxonomy", "prompt"] as const,
};

/** Refresh every curation read plus the shell's badges and the Overview. */
export function invalidateCuration(qc: QueryClient, ws: string) {
  invalidateKnowledge(qc, ws);
  void qc.invalidateQueries({ queryKey: knowledgeKeys.taxonomy(ws) });
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

/** Each run's tasks for the documents on screen, as one structurally shared list: unchanged runs keep their arrays. */
const taskData = (results: readonly { data?: IngestionTask[] }[]) => results.map((r) => r.data);

/**
 * Where each of `items` (the documents on screen, by ID) is in the runs in flight: its task by item ID (the newest
 * run's when a document is in two), polled every 3 s while a run is in flight — one batch read per run of just these
 * tasks. Undefined while no run is in flight, so a finished run's tasks never linger on rows.
 */
export function useActiveTasks(items: readonly string[]): ReadonlyMap<string, IngestionTask> | undefined {
  const { id } = useWorkspace();
  const runs = useActiveRuns();
  const names = (runs.data ?? []).flatMap((r) => (r.name ? [r.name] : []));
  const wanted = [...new Set(items.filter(Boolean))].sort();
  const data = useQueries({
    queries: names.map((name) => ({
      queryKey: [...curationKeys.runTasks(id, name), wanted],
      queryFn: () => batchGetRunTasks(name, wanted),
      enabled: wanted.length > 0,
      placeholderData: keepPreviousData,
      refetchInterval: 3000,
    })),
    combine: taskData,
  });
  const active = names.length > 0;
  return useMemo(() => {
    if (!active) return undefined;
    const byItem = new Map<string, IngestionTask>();
    for (const tasks of data) for (const task of tasks ?? []) if (!byItem.has(taskKey(task))) byItem.set(taskKey(task), task);
    return byItem;
  }, [active, data]);
}

/**
 * One server page of the runs in flight's tasks in `state` (Processing's Waiting / Processed pills): the first run's
 * pages, then the next run's.
 */
export function useRunTaskPages(state: "QUEUED" | "SUCCEEDED" | null, pageSize: number) {
  const { id } = useWorkspace();
  const runs = useActiveRuns();
  const names = (runs.data ?? []).flatMap((r) => (r.name ? [r.name] : []));
  return useTokenPages(
    [...curationKeys.activeRuns(id), "pill", state, names, pageSize],
    async (pageToken) => {
      const at: RunTaskCursor = pageToken ? (JSON.parse(pageToken) as RunTaskCursor) : FIRST_RUN_PAGE;
      const r = await listRunTasksPage(names[at.run], { filter: `state = ${state}`, orderBy: "createTime", pageSize, pageToken: at.token || undefined });
      const next = nextRunTaskCursor(at, r.nextPageToken, names.length);
      return { tasks: r.tasks ?? [], nextPageToken: next ? JSON.stringify(next) : undefined };
    },
    { enabled: !!state && names.length > 0 },
  );
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
 * Items by name (FULL view): one batch read (ListItems by name), then GetItem only for the ones it leaves out — open
 * candidates a reviewer reads through the reviewer exception, which applies to GetItem alone. Unreadable ones are absent.
 */
export async function readCandidates(ws: string, names: readonly string[], known: ReadonlyMap<string, Item> = new Map()): Promise<Map<string, Item>> {
  const found = new Map(known);
  const wanted = [...new Set(names.filter((n) => n && !known.has(n)))];
  for (const item of await batchGetItems(ws, wanted, { view: "FULL" })) if (item.name) found.set(item.name, item);
  const read = await Promise.all(wanted.filter((n) => !found.has(n)).map((n) => getItem(ws, n, "FULL").catch(() => null)));
  for (const item of read) if (item?.name) found.set(item.name, item);
  return found;
}

/** Contributions with their candidates (`readCandidates`). */
export async function withCandidates(ws: string, contributions: Contribution[], known: ReadonlyMap<string, Item> = new Map()): Promise<Submission[]> {
  const found = await readCandidates(ws, contributions.map((c) => c.item ?? ""), known);
  return contributions.map((contribution) => ({ contribution, item: (contribution.item && found.get(contribution.item)) || null }));
}

/** What the review queue's poll compares: its submissions still being analyzed, by name and etag. */
export const analyzingKey = (contributions: readonly Contribution[]) =>
  contributions
    .filter((c) => c.state === "ANALYZING")
    .map((c) => `${c.name}:${c.etag ?? c.updateTime ?? ""}`)
    .sort()
    .join("|");

/** Root collections the caller owns (the ones they review), shared ones only. */
export function useReviewableBases() {
  const bases = useKnowledgeBases();
  const data = useMemo(() => (bases.data ?? []).filter((b) => b.itemType !== "PERSONAL" && b.access === "OWNER"), [bases.data]);
  return { ...bases, data };
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
  if (policy.data?.bindings?.some((b) => b.members.includes("workspaceMembers"))) return { icon: Building2, label: `Mọi thành viên của ${workspace.displayName}` };
  const name = [...(base.data?.ancestors ?? []).map((a) => a.displayName), base.data?.displayName].filter(Boolean).join(" › ");
  return { icon: Lock, label: name ? `Những người có quyền truy cập ${name}` : "Những người có quyền truy cập" };
}

export interface DocCountsData extends DocCounts {
  /** Preview views without an API (first-sync batches, low-confidence labels): never counted. */
  batches?: undefined;
  confirm?: undefined;
  /** Published documents in scope, and how many of them are verified (Knowledge health's share). */
  published: number;
  verified: number;
}

/** Contribution names with a decision in its Undo window (classification decisions hold other names). */
export const heldContributions = (held: ReadonlySet<string>) => [...held].filter((n) => n.includes("/contributions/"));

/**
 * Items per Documents view for the collections the caller reviews (preview `X.reviewQueues`): the view tabs, the
 * Studio landing and Overview → Knowledge health. Each count is the view's server filter with `pageSize=1`
 * (`totalSize`), in parallel and under its own key, so a decision refreshes only counts. Review leaves out the
 * decisions still in their Undo window; document counts need the caller's shared collections (none: 0, no request);
 * Possible duplicates aren't computed by the server (0). `data` stays undefined for callers who don't review.
 */
export function useDocCounts(): { data?: DocCountsData; isPending: boolean } {
  const { can } = useWorkspace();
  const enabled = can("contributions.review");
  const held = useHeldDecisions();
  const docScope = useDocScope({ enabled });
  const { scope } = docScope;
  const { data: taxonomy } = useTaxonomy();
  // Document counts wait for the scope; the contribution counts don't.
  const doc = (filter: string): CountRead | undefined => (docScope.isPending ? undefined : scope.length ? { of: "items", filter } : null);
  const counts = useCounts(
    [
      { of: "contributions", filter: REVIEW_READY },
      { of: "contributions", filter: SUBMISSIONS_TO_PROCESS },
      doc(documentsToProcess(scope)),
      doc(documentsToProcess(scope, WAITING_STATES)),
      doc(reverifyFilter(scope)),
      doc(detailsFilter(scope, undefined, requiredSchemeNames(taxonomy))),
      doc(publishedFilter(scope)),
      doc(publishedFilter(scope, { verified: true })),
    ],
    { enabled },
  );
  const [review, submissions, docs, failing, reverify, details, published, verified] = counts.data;
  const undo = heldContributions(held).length;
  const data: DocCountsData | undefined =
    enabled && !counts.isPending
      ? {
          review: Math.max(0, (review ?? 0) - undo),
          submissions: submissions ?? 0,
          processing: (submissions ?? 0) + (docs ?? 0),
          waiting: (submissions ?? 0) + (failing ?? 0),
          reverify: reverify ?? 0,
          details: details ?? 0,
          duplicates: 0,
          published: published ?? 0,
          verified: verified ?? 0,
        }
      : undefined;
  return { data, isPending: enabled && counts.isPending };
}

/* ═══════════════ Studio queues: scope, counts and page-scoped side reads ═══════════════ */

/** Processing states that wait on the caller (failed, changed at the source). */
const WAITING_STATES = ["FAILED", "OUTDATED"] as const;

/**
 * The shared root collections the caller looks after (editor or owner; personal "My files" excluded) and their names:
 * the scope of every document list and count (Documents → All's scope).
 */
export function useDocScope({ enabled = true }: { enabled?: boolean } = {}) {
  const bases = useKnowledgeBases({ enabled });
  const scopeBases = useMemo(() => (bases.data ?? []).filter((b) => b.itemType !== "PERSONAL" && (b.access === "EDITOR" || b.access === "OWNER")), [bases.data]);
  const scope = useMemo(() => scopeBases.map((b) => b.name ?? ""), [scopeBases]);
  return { bases: scopeBases, scope, isPending: bases.isPending, isError: bases.isError, error: bases.error, refetch: bases.refetch };
}

/** A count to read: the List method and its filter; null counts 0 without a request, undefined waits (not known yet). */
export type CountRead = { of: "contributions" | "items"; filter: string } | null;

/** A count's key: under the list's knowledge prefix, so any change to contributions or items refreshes it. */
export const countKey = (ws: string, read: NonNullable<CountRead>) => [ws, read.of, "count", read.filter] as const;

const countData = (results: readonly { data?: number; isPending: boolean }[]) => ({ data: results.map((r) => r.data), pending: results.map((r) => r.isPending) });

/**
 * Server counts (`pageSize=1` → `totalSize`), each under its own key, in parallel. A changed filter keeps the count
 * last shown at that position until the new one arrives (so a search never blanks the view), and `isPending` is true
 * only while some count has never been known. A null read counts 0, an undefined one stays pending.
 */
export function useCounts(reads: readonly (CountRead | undefined)[], { enabled = true }: { enabled?: boolean } = {}): { data: (number | undefined)[]; isPending: boolean } {
  const { id } = useWorkspace();
  const result = useQueries({
    queries: reads.flatMap((r) => (r ? [{ queryKey: countKey(id, r), queryFn: () => (r.of === "items" ? countItems(id, r.filter) : countContributions(id, r.filter)), enabled }] : [])),
    combine: countData,
  });
  const shown = useRef<readonly (number | undefined)[]>([]);
  let i = 0;
  let waiting = false;
  const data = reads.map((r, k) => {
    const read = r ? i++ : -1;
    const v = (read >= 0 ? result.data[read] : r === null && enabled ? 0 : undefined) ?? shown.current[k];
    // Unknown and still loading (or not readable yet): a failed count shows as missing instead of loading forever.
    if (v === undefined && (r === undefined || (read >= 0 && result.pending[read]))) waiting = true;
    return v;
  });
  shown.current = data;
  return { data, isPending: enabled && waiting };
}

/** The latest contribution about each document of a page (by item name): one ListContributions page. */
export function useContributionsOf(items: readonly string[]) {
  const { id } = useWorkspace();
  const names = [...new Set(items.filter(Boolean))].sort();
  return useQuery({
    queryKey: [id, "contributions", "of", ...names],
    queryFn: (): Promise<ReadonlyMap<string, Contribution>> => pageContributionsOf(id, names),
    enabled: names.length > 0,
    placeholderData: keepPreviousData,
  });
}

/* ═══════════════ Server-paged document lists (Quality lists, Classification › Gợi ý) ═══════════════ */

/**
 * One server page of documents (ListItems FULL, `pageSize` per page) with the page tokens read so far: Previous goes
 * back through them, Next adds the page's `nextPageToken`. A new filter or order starts over at page 1. The previous
 * page stays on screen while the next one loads.
 */
export function useItemPages(filter: string, orderBy: string, { pageSize = 20, enabled = true }: { pageSize?: number; enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const query = useTokenPages([id, "items", "studio-page", filter, orderBy, pageSize], (pageToken) => listItems(id, { filter, orderBy, pageSize, pageToken, view: "FULL" }), { enabled });
  return { ...query, items: query.data?.items ?? [], pageSize };
}

/* ═══════════════ Classification (Studio › Phân loại) ═══════════════ */

/** Refresh the taxonomy and Classification's side reads (a working-copy edit: labels, counts of changes, previews). */
export function useInvalidateTaxonomy() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useCallback(() => void qc.invalidateQueries({ queryKey: knowledgeKeys.taxonomy(id) }), [qc, id]);
}

/**
 * Writes a saved concept into the taxonomy at once (or takes a deleted one out), so the detail doesn't flash the old
 * values until the refetch that `invalidateCuration` starts.
 */
export function useRememberConcept() {
  const { id } = useWorkspace();
  const qc = useQueryClient();
  return useCallback(
    (concept: Concept, { removed = false }: { removed?: boolean } = {}) =>
      qc.setQueryData<Taxonomy>(knowledgeKeys.taxonomy(id), (t) => {
        if (!t) return t;
        const all = [...t.byScheme.values()].flat();
        const known = all.some((c) => c.name === concept.name);
        const next = removed ? all.filter((c) => c.name !== concept.name) : known ? all.map((c) => (c.name === concept.name ? concept : c)) : [...all, concept];
        return buildTaxonomy(t.schemes, next);
      }),
    [qc, id],
  );
}

/**
 * The scheme's next version as publishing would make it (`:publish` `validateOnly`): the working copy's changes (the
 * tree's dots, Version history's working copy) and the Publish dialog's problems, warnings and impact. Read only while
 * there is something to publish; the scheme's etag keys it, so every edit reads it again.
 */
export function useSchemePreview(scheme: ConceptScheme | undefined, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: curationKeys.schemePreview(id, scheme?.name ?? "", `${scheme?.etag ?? ""}:${scheme?.unpublishedChanges ?? 0}`),
    queryFn: () => publishConceptScheme(scheme!, { validateOnly: true }),
    enabled: enabled && !!scheme && (scheme.unpublishedChanges ?? 0) > 0,
    retry: false,
    staleTime: 30_000,
  });
}

/** A scheme's published versions, newest first (Version history; loads while it's open). */
export function useSchemeVersions(scheme: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.schemeVersions(id, scheme), queryFn: () => listSchemeVersions(scheme), enabled: enabled && !!scheme });
}

/** Labels several concepts share (Duplicate labels and its count on the scheme header). */
export function useSharedLabels({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.sharedLabels(id), queryFn: () => listSharedLabels(id), enabled, staleTime: 60_000 });
}

/** Open concept proposals, both kinds (Gợi ý › New concept proposals and Learned from edits). */
export function useOpenProposals({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.proposals(id), queryFn: () => listOpenProposals(id), enabled, staleTime: 60_000 });
}

/** Classification rules: those that file documents under `concept` (its detail's Rules), or every rule with `concept`
 *  "" (How the assistant classifies). Read-only in the web. */
export function useConceptRules(concept: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.conceptRules(id, concept), queryFn: () => listConceptRules(id, concept || undefined), enabled, staleTime: 5 * 60_000 });
}

/** The classification prompt and the rules checked before it (How the assistant classifies; loads while open). */
export function useClassificationPrompt({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.prompt(id), queryFn: () => compileClassificationPrompt(id), enabled, staleTime: 0 });
}

/**
 * Per concept, how many published documents in `scope` have it suggested (hierarchical: a concept counts the documents
 * of everything under it): one SearchItems read with a `document.suggestedConcepts` facet per classification scheme.
 */
export function useSuggestedCounts(scope: readonly string[], schemes: readonly string[], { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const filter = suggestedFilter(scope);
  return useQuery({
    queryKey: [...curationKeys.suggested(id), "facet", filter, schemes],
    queryFn: async ({ signal }): Promise<ReadonlyMap<string, number>> => {
      // Counted within the whole filter (scope, published, has a suggestion).
      const facetSpecs = schemes.map((s) => ({ field: "document.suggestedConcepts", prefixes: [s], limit: 1000, excludedFromFilter: false }));
      const res = await searchItems(id, { filter, facetSpecs, pageSize: 1 }, { signal });
      const values = (res.facets ?? []).filter((f) => f.field === "document.suggestedConcepts").flatMap((f) => f.values ?? []);
      return new Map(values.map((v) => [v.value ?? "", v.documentCount ?? 0]));
    },
    enabled: enabled && scope.length > 0 && schemes.length > 0,
    staleTime: 60_000,
  });
}

/** The held-decision key of a suggestion card (hidden while its Accept all / Reject all is in the Undo window). */
export const suggestedKey = (concept: string) => `${concept}#suggested`;

export interface ClassificationSuggestions {
  /** Labels awaiting review: one card per concept (decisions in their Undo window left out). */
  groups: SuggestedGroup[];
  /** Per classification scheme the assistant classifies: its Not classified pool's filter and size (non-empty ones). */
  pools: { scheme: ConceptScheme; filter: string; n: number }[];
  /** Open proposals of both kinds, without those in their Undo window. */
  proposals: ConceptProposal[];
  scope: readonly string[];
}

/**
 * What waits in Classification › Gợi ý for the caller (preview `suggestionCount`): suggestion cards, Not classified pools
 * with documents, open proposals. `count` is the Gợi ý tab's number (and Overview's); `data` is undefined for callers
 * without the section or while it loads.
 */
export function useClassificationSuggestions(): { data?: ClassificationSuggestions; count?: number; isPending: boolean; isError: boolean; error: unknown; refetch: () => void } {
  const { can } = useWorkspace();
  const enabled = can("conceptSchemes.update") || can("conceptProposals.decide");
  const { data: t, isPending: taxonomyPending } = useTaxonomy();
  const held = useHeldDecisions();
  const docScope = useDocScope({ enabled });
  const { scope } = docScope;
  const schemes = useMemo(() => classSchemes(t).map((s) => s.name ?? ""), [t]);
  const suggested = useSuggestedCounts(scope, schemes, { enabled });
  const pooled = classSchemes(t).filter((s) => s.llmPolicy !== "NEVER");
  const poolFilters = pooled.map((s) => unclassifiedFilter(scope, s.name ?? ""));
  const pools = useCounts(
    poolFilters.map((filter): CountRead | undefined => (docScope.isPending ? undefined : scope.length && filter ? { of: "items", filter } : null)),
    { enabled },
  );
  const proposals = useOpenProposals({ enabled });
  const pending = enabled && (taxonomyPending || docScope.isPending || (scope.length > 0 && suggested.isPending) || pools.isPending || proposals.isPending);
  const failed = docScope.isError ? docScope : suggested.isError ? suggested : proposals;
  if (!enabled || pending || !proposals.data) {
    return { isPending: pending, isError: !!failed.isError, error: failed.error, refetch: () => void failed.refetch() };
  }
  const groups = suggestedGroups(t, suggested.data ?? new Map()).filter((g) => !held.has(suggestedKey(g.concept)));
  const poolList = pooled.map((scheme, i) => ({ scheme, filter: poolFilters[i], n: pools.data[i] ?? 0 })).filter((p) => p.n > 0);
  const open = proposals.data.filter((p) => !held.has(p.name ?? ""));
  return {
    data: { groups, pools: poolList, proposals: open, scope },
    count: groups.length + poolList.length + open.length,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  };
}

/** The Gợi ý tab's count, for Overview › Knowledge health (undefined without the section or while it loads). */
export function useSuggestionCount(): { data?: number; isPending: boolean } {
  const s = useClassificationSuggestions();
  return { data: s.count, isPending: s.isPending };
}

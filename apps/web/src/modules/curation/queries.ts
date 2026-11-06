"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useWorkspace } from "@/lib/workspace";
import { getItem } from "@/modules/knowledge/api";
import { invalidateKnowledge, knowledgeKeys, useKnowledgeBases } from "@/modules/knowledge/queries";

import { listAllContributions, listAllTopics, listCuratedItems, listReviewQueue, type Contribution, type Item } from "./api";

/** Query keys live under the knowledge prefixes so `invalidateKnowledge` refreshes them too. */
export const curationKeys = {
  queue: (ws: string) => [ws, "contributions", "review-queue"] as const,
  contributions: (ws: string) => [ws, "contributions", "curation-all"] as const,
  items: (ws: string) => [ws, "items", "curated"] as const,
  deletedItems: (ws: string) => [ws, "items", "curated-deleted"] as const,
  topics: (ws: string) => [ws, "topics", "all"] as const,
};

/** Refresh every curation read plus the shell's Documents badge and the Overview. */
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

/** Candidates for contributions, fetched one by one (reviewers may read open candidates only through GetItem). */
async function withCandidates(ws: string, contributions: Contribution[], known: ReadonlyMap<string, Item> = new Map()): Promise<Submission[]> {
  const items = await Promise.all(
    contributions.map((c) => (c.item && known.get(c.item)) || (c.item ? getItem(ws, c.item, "FULL").catch(() => null) : Promise.resolve(null))),
  );
  return contributions.map((contribution, i) => ({ contribution, item: items[i] }));
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

/** Root collections the caller owns ("bases you look after"), shared ones only. */
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

/** Live documents in shared bases the caller looks after (editor or owner; personal "My files" excluded). */
export function useCuratedItems() {
  const { id } = useWorkspace();
  const personal = usePersonalRoots();
  const bases = useKnowledgeBases();
  const query = useQuery({ queryKey: curationKeys.items(id), queryFn: () => listCuratedItems(id) });
  const data = useMemo(() => {
    if (!query.data || !bases.data) return undefined;
    return query.data.filter((it) => {
      const root = it.ancestors?.[0]?.name ?? it.parentItem ?? "";
      return !personal.has(root) && (it.access === "EDITOR" || it.access === "OWNER");
    });
  }, [query.data, bases.data, personal]);
  return { ...query, data, isPending: query.isPending || bases.isPending };
}

/** Every contribution the caller can see (history for the document drawer, decided submissions). */
export function useAllContributions({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.contributions(id), enabled, queryFn: () => listAllContributions(id) });
}

/** Decided-but-unpublished submissions (changes requested, not approved) with their candidates when readable. */
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
export function useAllTopics() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: curationKeys.topics(id), queryFn: () => listAllTopics(id, { deleted: true }) });
}

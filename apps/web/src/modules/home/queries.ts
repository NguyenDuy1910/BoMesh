"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { getItem, searchItems } from "@/modules/knowledge/api";
import type { Resource } from "@/modules/knowledge/model";
import { useKnowledgeModel, useRecentItems } from "@/modules/knowledge/queries";

import { getMemberHome, listItemRevisions } from "./api";

const DAY = 86_400_000;

export const homeKeys = {
  home: (ws: string) => [ws, "home"] as const,
  insights: (ws: string) => [ws, "home", "insights"] as const,
};

export function useMemberHome() {
  const { id, memberId } = useWorkspace();
  return useQuery({ queryKey: homeKeys.home(id), queryFn: () => getMemberHome(id, memberId) });
}

/** When the caller last opened each document (bare item ID → view time). */
export function useLastViews() {
  const recent = useRecentItems(50);
  const views = useMemo(() => new Map((recent.data ?? []).map((r) => [resourceId(r.item), r.viewTime ?? ""])), [recent.data]);
  return { ...recent, views };
}

export interface Insight {
  resource: Resource;
  at: string;
  /** The change itself, in the owner's words (revision change summary or announcement summary). */
  text: string;
  label: string;
  kind: "version" | "announcement";
  /** "Version 5" for a new version; empty for announcements. */
  source: string;
  score: number;
}

const ms = (t?: string) => (t ? Date.parse(t) : 0);

/**
 * Worth knowing (preview `insights()`): source-backed changes in published shared documents —
 * a new version with its change note (≤ 120 days) or an announcement with its summary (≤ 60 days).
 * Skips what the caller opened after it changed; ranked by verification, recency and the bases
 * they read in; three at most.
 */
export function useInsights({ enabled = true, readCollections }: { enabled?: boolean; readCollections: ReadonlySet<string> }) {
  const { id } = useWorkspace();
  const model = useKnowledgeModel();
  const last = useLastViews();
  const since = useMemo(() => new Date(Date.now() - 120 * DAY).toISOString(), []);
  const recentDocs = useQuery({
    queryKey: [...homeKeys.insights(id), since],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () =>
      searchItems(id, {
        filter: `itemType = DOCUMENT AND document.publicationState = PUBLISHED AND updateTime >= "${since}"`,
        orderBy: "updateTime desc",
        pageSize: 12,
      }),
  });
  const candidates = useMemo(
    () =>
      (recentDocs.data?.results ?? [])
        .map((r) => r.item)
        .filter((i): i is NonNullable<typeof i> => !!i)
        .map((i) => model.toResource(i))
        .filter((r) => !r.isPersonal && !r.item.document?.mergedInto)
        .slice(0, 8),
    [recentDocs.data, model],
  );
  const revisions = useQueries({
    queries: candidates.map((r) => ({
      queryKey: [id, "items", "one", r.id, "revisions"],
      queryFn: () => listItemRevisions(id, r.id),
      staleTime: 5 * 60_000,
      retry: false,
    })),
  });
  const settled = revisions.every((q) => !q.isPending);
  const revKey = revisions.map((q) => q.dataUpdatedAt).join(",");

  const data = useMemo<Insight[] | undefined>(() => {
    if (!recentDocs.data || !settled || last.isPending) return undefined;
    const now = Date.now();
    const out: Insight[] = [];
    candidates.forEach((r, i) => {
      const revs = revisions[i]?.data ?? [];
      const latest = revs[0];
      let it: Omit<Insight, "score"> | null = null;
      if (latest && revs.length > 1 && latest.changeSummary && now - ms(latest.createTime) < 120 * DAY && !/reprocess|current version/i.test(latest.changeSummary) && r.readable)
        it = { resource: r, at: latest.createTime ?? "", text: latest.changeSummary, label: `${r.kindMeta.label} updated`, kind: "version", source: `Version ${revs.length}` };
      else if (r.kind === "announcement" && r.summary && now - ms(r.updated) < 60 * DAY)
        it = { resource: r, at: r.updated ?? "", text: r.summary, label: "Announcement", kind: "announcement", source: "" };
      if (!it || ms(last.views.get(r.id)) > ms(it.at)) return;
      const relevance = (r.base && readCollections.has(r.base.name)) || readCollections.has(r.item.parentItem ?? "") ? 2 : 0;
      out.push({ ...it, score: relevance + (r.trust.state === "verified" ? 1 : 0) + Math.max(0, 3 - (now - ms(it.at)) / (30 * DAY)) });
    });
    return out.sort((a, b) => b.score - a.score || ms(b.at) - ms(a.at)).slice(0, 3);
    // revKey stands for the revision results (the array identity changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentDocs.data, settled, revKey, candidates, last.views, last.isPending, readCollections]);

  return { data, isPending: data === undefined && !recentDocs.isError, isError: recentDocs.isError };
}

export interface CardDetails {
  /** What the document is for (its summary). */
  summary: string;
  fileName: string;
  mime: string;
}

/** File type and summary for the cards on screen (the Home read model carries neither); loaded only for those items. */
export function useCardDetails(itemIds: readonly string[]) {
  const { id } = useWorkspace();
  const results = useQueries({
    queries: itemIds.map((item) => ({ queryKey: [id, "items", "one", item, "basic"], queryFn: () => getItem(id, item, "BASIC"), staleTime: 5 * 60_000, retry: false })),
  });
  const key = results.map((r) => r.dataUpdatedAt).join(",");
  return useMemo(
    () =>
      new Map<string, CardDetails>(
        itemIds.map((item, i) => {
          const doc = results[i]?.data?.document;
          return [item, { summary: doc?.summary ?? "", fileName: doc?.fileName ?? "", mime: doc?.mimeType ?? "" }];
        }),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [itemIds.join(","), key],
  );
}

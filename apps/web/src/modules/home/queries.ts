"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { searchItems } from "@/modules/knowledge/api";
import type { Resource } from "@/modules/knowledge/model";
import { knowledgeKeys, useItemsByName, useKnowledgeModel, useRecentItems } from "@/modules/knowledge/queries";

import { getItemRevision, getMemberHome, type MemberHome } from "./api";

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

/**
 * How many readable documents changed in the last 30 days (preview `lede()`'s `fresh`), as the
 * second half of Home's lede. The Home read model carries no such count, so it is one `pageSize: 1`
 * search read for its `totalSize` — the same way Browse counts its Updated windows.
 */
export function useFreshCount({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  // Rounded to the hour so the query key is stable and the request actually settles.
  const since = useMemo(() => new Date(Math.floor((Date.now() - 30 * DAY) / 3_600_000) * 3_600_000).toISOString(), []);
  const query = useQuery({
    queryKey: [...homeKeys.home(id), "fresh", since],
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () =>
      searchItems(id, {
        filter: `itemType = DOCUMENT AND document.publicationState = PUBLISHED AND updateTime >= "${since}"`,
        pageSize: 1,
      }),
  });
  return query.data?.totalSize ?? 0;
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
 * they read in; three at most. The version number comes from `document.revision`; only the
 * current revision of a candidate that is past version 1 and unopened since its last update is
 * read (for its change note), never a revision list per candidate.
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
  /** Candidates whose current revision may be an unseen new version (a revision is never newer than the item's `updateTime`). */
  const versioned = last.isPending
    ? []
    : candidates.filter((r) => r.readable && versionOf(r) > 1 && ms(last.views.get(r.id)) <= ms(r.updated));
  const revisions = useQueries({
    queries: versioned.map((r) => ({
      queryKey: [...knowledgeKeys.item(id, r.id), "revision", r.item.document?.revision ?? ""],
      queryFn: () => getItemRevision(id, r.item.document?.revision ?? ""),
      staleTime: Infinity,
      retry: false,
    })),
  });
  const settled = revisions.every((q) => !q.isPending);
  const revKey = revisions.map((q) => q.dataUpdatedAt).join(",");

  const data = useMemo<Insight[] | undefined>(() => {
    if (!recentDocs.data || !settled || last.isPending) return undefined;
    const now = Date.now();
    const current = new Map(revisions.flatMap((q) => (q.data?.name ? [[q.data.name, q.data] as const] : [])));
    const out: Insight[] = [];
    for (const r of candidates) {
      const latest = current.get(r.item.document?.revision ?? "");
      let it: Omit<Insight, "score"> | null = null;
      if (latest?.changeSummary && now - ms(latest.createTime) < 120 * DAY && !/reprocess|current version/i.test(latest.changeSummary))
        it = { resource: r, at: latest.createTime ?? "", text: latest.changeSummary, label: `${r.kindMeta.label} updated`, kind: "version", source: `Version ${versionOf(r)}` };
      else if (r.kind === "announcement" && r.summary && now - ms(r.updated) < 60 * DAY)
        it = { resource: r, at: r.updated ?? "", text: r.summary, label: "Announcement", kind: "announcement", source: "" };
      if (!it || ms(last.views.get(r.id)) > ms(it.at)) continue;
      const relevance = (r.base && readCollections.has(r.base.name)) || readCollections.has(r.item.parentItem ?? "") ? 2 : 0;
      out.push({ ...it, score: relevance + (r.trust.state === "verified" ? 1 : 0) + Math.max(0, 3 - (now - ms(it.at)) / (30 * DAY)) });
    }
    return out.sort((a, b) => b.score - a.score || ms(b.at) - ms(a.at)).slice(0, 3);
    // revKey stands for the revision results (the array identity changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentDocs.data, settled, revKey, candidates, last.views, last.isPending, readCollections]);

  return { data, isPending: data === undefined && !recentDocs.isError, isError: recentDocs.isError };
}

/** Version number of a document: its current revision's number (revision ID = number). */
function versionOf(r: Resource): number {
  return Number(resourceId(r.item.document?.revision)) || 0;
}

export interface CardDetails {
  /** What the document is for (its summary). */
  summary: string;
  fileName: string;
  mime: string;
}

/**
 * File type and summary for every document Home can show as a card (Continue reading, Start
 * here, Recommended), in one batch read shared by those sections; the Home read model carries
 * neither. Keyed by bare item ID.
 */
export function useCardDetails(home: MemberHome) {
  const names = [
    ...(home.continue?.recentItems ?? []).slice(0, 4).map((i) => i.item),
    ...(home.featured ?? []).map((f) => f.item?.item),
    ...(home.recommended ?? []).map((r) => r.item?.item),
  ];
  const { items } = useItemsByName(names, { view: "BASIC" });
  return useMemo(
    () =>
      new Map<string, CardDetails>(
        [...items.values()].map((item) => {
          const doc = item.document;
          return [resourceId(item.name), { summary: doc?.summary ?? "", fileName: doc?.fileName ?? "", mime: doc?.mimeType ?? "" }];
        }),
      ),
    [items],
  );
}

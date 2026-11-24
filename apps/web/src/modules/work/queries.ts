"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { ApiError, call, api, resourceId, type Schema } from "@/lib/api/client";
import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { getArtifact, getOperation, getRevision, listArtifacts } from "@/modules/artifacts/api";
import { artifactKeys } from "@/modules/artifacts/queries";
import { batchGetItems, listItems, quote, type Item } from "@/modules/knowledge/api";
import { useItemsByName } from "@/modules/knowledge/queries";

import { WORK_KINDS, type WorkKind } from "./kinds";
import { reviewGenerating, type Artifact } from "./model";

type Space = Schema<"Space">;

export const workKeys = {
  list: (ws: string) => [...artifactKeys.all(ws), "work-list"] as const,
  operation: (ws: string, name: string) => [ws, "operations", name] as const,
  docs: (ws: string, scope: string) => [ws, "items", "work-docs", scope] as const,
};

/** Rows per page of `/work`. */
export const WORK_PAGE = 25;

/** Only Work kinds (FILE artifacts are attachments, never listed as work). */
const WORK_KIND_FILTER = `(${(Object.keys(WORK_KINDS) as WorkKind[]).map((k) => `kind = ${k}`).join(" OR ")})`;

export interface WorkListFilter {
  /** Mine (owned by the caller) or shared with me (SPACE-audience work of my spaces owned by others). */
  tab: "mine" | "shared";
  kind?: string;
  /** Bare space ID. */
  space?: string;
  /** Title search (case-insensitive substring). */
  q?: string;
}

function workFilter(ws: string, me: string, { tab, kind, space, q }: WorkListFilter): string {
  return [
    kind ? `kind = ${kind}` : WORK_KIND_FILTER,
    tab === "mine" ? `owner = ${quote(me)}` : `NOT owner = ${quote(me)}`,
    space && `space = ${quote(`workspaces/${ws}/spaces/${space}`)}`,
    q && `displayName = ${quote(`*${q}*`)}`,
  ]
    .filter(Boolean)
    .join(" AND ");
}

/** One page of Work artifacts the caller can read, newest first; re-read every 3 s while a row on it is being generated. */
export function useWorkList(filter: WorkListFilter) {
  const { id, member } = useWorkspace();
  const f = workFilter(id, member.name ?? "", filter);
  const pages = useTokenPages([...workKeys.list(id), f], (pageToken) => listArtifacts(id, { filter: f, orderBy: "updateTime desc", pageSize: WORK_PAGE, pageToken }), {
    enabled: !!member.name,
  });
  const generating = (pages.data?.artifacts ?? []).some((a) => a.state === "GENERATING");
  const { refetch } = pages;
  useEffect(() => {
    if (!generating) return;
    const t = window.setInterval(() => void refetch(), 3000);
    return () => window.clearInterval(t);
  }, [generating, refetch]);
  return pages;
}

/** How many Work artifacts match a tab (`pageSize=1` → `totalSize`). */
export function useWorkCount(tab: WorkListFilter["tab"]) {
  const { id, member } = useWorkspace();
  const f = workFilter(id, member.name ?? "", { tab });
  return useQuery({
    queryKey: [...workKeys.list(id), "count", f],
    queryFn: async () => (await listArtifacts(id, { filter: f, pageSize: 1 })).totalSize ?? 0,
    enabled: !!member.name,
    staleTime: 30_000,
  });
}

/** One piece of work; polled while it or any of its matrix cells is being generated. */
export function useWorkItem(artifact: string) {
  const { id } = useWorkspace();
  const key = resourceId(artifact);
  return useQuery({
    queryKey: artifactKeys.one(id, key),
    queryFn: () => getArtifact(id, key),
    enabled: !!key,
    retry: (count, error) => !(error instanceof ApiError && (error.isNotFound || error.status === 403)) && count < 2,
    refetchInterval: (query) => {
      const a = query.state.data;
      return a && (a.state === "GENERATING" || reviewGenerating(a)) ? 1500 : false;
    },
  });
}

/** The operation that last generated an artifact on this device (its error explains a failure). */
export function useOperation(name: string | null | undefined) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: workKeys.operation(id, name ?? ""),
    queryFn: () => getOperation(name ?? ""),
    enabled: !!name,
    retry: false,
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data && !query.state.data.done ? 1500 : false),
  });
}

/**
 * The current revision of a text kind (DRAFT, STUDY_GUIDE, QUIZ) as Markdown, from the revision's snapshot
 * (GetArtifact `alt=media` answers 500 for generated text artifacts); re-read when the revision moves.
 */
export function useArtifactText(artifact: Artifact | undefined) {
  const { id } = useWorkspace();
  const key = resourceId(artifact?.name);
  const revision = artifact?.revision ?? "";
  return useQuery({
    queryKey: [...artifactKeys.one(id, key), "text", revision],
    queryFn: async () => (await getRevision(id, key, resourceId(revision))).snapshot?.text ?? "",
    enabled: !!key && !!revision && artifact?.kind !== "EVIDENCE_REVIEW",
    staleTime: Infinity,
    /* A new revision of the same artifact keeps the previous text until it arrives (no skeleton flash). */
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey.includes(key) ? previous : undefined),
    retry: false,
  });
}

/** Documents (FULL items) for names, in one batch read; unreadable ones are left out. */
export function useDocs(names: readonly string[]) {
  const docs = useItemsByName(names);
  return { byName: docs.items, isPending: docs.isPending };
}

/* ═══════════════ Materials ═══════════════ */

export interface DocGroup {
  /** Collection name (`workspaces/{w}/items/{i}`). */
  collection: string;
  label: string;
  docs: Item[];
}

/** Doc status in the preview's vocabulary (`STATUS.doc`). */
export function docStatus(item: Item): "ready" | "processing" | "pending" | "failed" | "outdated" | "unsupported" {
  const d = item.document;
  if (d?.contentState === "FAILED") return "failed";
  if (d?.contentState === "PENDING") return "pending";
  switch (d?.indexingState) {
    case "SUCCEEDED":
      return "ready";
    case "OUTDATED":
      return "outdated";
    case "RUNNING":
      return "processing";
    case "FAILED":
      return "failed";
    case "UNSUPPORTED":
      return "unsupported";
    default:
      return "pending";
  }
}

/** Whether a document can be a source: its content is stored and it isn't failed or unsupported. */
export const isUsableDoc = (item: Item) => item.document?.contentState === "AVAILABLE" && !["FAILED", "UNSUPPORTED"].includes(item.document?.indexingState ?? "");

const isDoc = (item: Item) => item.itemKind === "DOCUMENT" && item.state !== "DELETED" && item.document?.purpose !== "CONVERSATION_ATTACHMENT";

/** Documents per page of the materials picker. */
export const MATERIAL_PAGE = 50;
/** Space materials read per space: their names go into one filter, which stays under the server's 4096-character limit. */
const MATERIAL_SCOPE = 35;

/** What a space lends a workflow: its linked collections and the collections and documents filed as materials (one page). */
async function spaceScope(workspace: string, space: Space): Promise<string[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/spaces/{space}/materials", {
      params: { path: { workspace, space: resourceId(space.name) }, query: { pageSize: MATERIAL_SCOPE } },
    }),
  );
  const items = await batchGetItems(workspace, (page.materials ?? []).map((m) => m.item ?? ""));
  const collections = new Set(space.collections ?? []);
  const docs: string[] = [];
  for (const item of items) {
    if (!item.name) continue;
    if (item.itemKind === "COLLECTION") collections.add(item.name);
    else if (isDoc(item)) docs.push(item.name);
  }
  return [...[...collections].map((c) => `ancestors:${quote(c)}`), ...docs.map((d) => `name = ${quote(d)}`)];
}

export interface MaterialPage {
  groups: DocGroup[];
  nextPageToken?: string;
  totalSize?: number;
}

/**
 * One page of the documents a workflow can use, grouped by collection (preview `docGroups`): a space's materials and
 * linked collections, or — without a space — everything the caller can read. `mine` adds My files (private learning
 * workflows). `q` searches titles on the server; group labels come from one batch read of the page's collections.
 */
export function useMaterialDocs(space: Space | null, { mine = false, q = "", enabled = true }: { mine?: boolean; q?: string; enabled?: boolean } = {}) {
  const { id, member } = useWorkspace();
  const personal = member.personalCollection;
  const scope = useQuery({
    queryKey: workKeys.docs(id, `scope|${space?.name ?? "-"}`),
    queryFn: () => spaceScope(id, space!),
    enabled: enabled && !!space?.name,
    staleTime: 30_000,
  });
  const terms = space?.name ? [...(scope.data ?? []), ...(mine && personal ? [`ancestors:${quote(personal)}`] : [])] : null;
  /** A space that lends nothing: no document to list. */
  const none = !!terms && !!scope.data && !terms.length;
  const filter = [
    "itemKind = DOCUMENT AND document.purpose = KNOWLEDGE",
    terms?.length && `(${terms.join(" OR ")})`,
    !space?.name && !mine && personal && `NOT ancestors:${quote(personal)}`,
    q && `displayName = ${quote(`*${q}*`)}`,
  ]
    .filter(Boolean)
    .join(" AND ");
  const pages = useTokenPages<MaterialPage>(
    workKeys.docs(id, filter),
    async (pageToken) => {
      const page = await listItems(id, { filter, orderBy: "displayName", pageSize: MATERIAL_PAGE, pageToken });
      const docs = (page.items ?? []).filter(isDoc);
      const parents = new Map((await batchGetItems(id, [...new Set(docs.map((d) => d.parentItem ?? "").filter(Boolean))])).map((c) => [c.name ?? "", c]));
      const groups = new Map<string, DocGroup>();
      for (const d of docs) {
        const parent = d.parentItem ?? "";
        const p = parents.get(parent);
        /** Other members' My files never feed my work (admins can read them). */
        if (p?.itemType === "PERSONAL" && p.name !== personal) continue;
        const label = p?.itemType === "PERSONAL" ? "Tệp của tôi" : p?.displayName || "Tài liệu";
        const g = groups.get(parent) ?? { collection: parent, label, docs: [] };
        g.docs.push(d);
        groups.set(parent, g);
      }
      return {
        groups: [...groups.values()].sort((a, b) => Number(a.label === "Tệp của tôi") - Number(b.label === "Tệp của tôi") || a.label.localeCompare(b.label)),
        nextPageToken: page.nextPageToken,
        totalSize: page.totalSize,
      };
    },
    { enabled: enabled && !none && (!space?.name || !!scope.data), staleTime: 30_000 },
  );
  return {
    ...pages,
    groups: none ? [] : pages.data?.groups,
    isPending: !none && ((!!space?.name && scope.isPending) || pages.isPending),
    error: scope.error ?? pages.error,
    refetch: () => void (scope.error ? scope.refetch() : pages.refetch()),
  };
}

/**
 * Documents handed to `/work/new` in `docs` (bare IDs), grouped by collection. They stay listed and
 * selectable whatever space is browsed: the space only scopes browsing.
 */
export function usePassedDocs(ids: readonly string[]) {
  const { id, member } = useWorkspace();
  const personal = member.personalCollection;
  return useQuery({
    queryKey: workKeys.docs(id, `passed|${ids.join(",")}`),
    enabled: ids.length > 0,
    staleTime: 30_000,
    queryFn: async (): Promise<DocGroup[]> => {
      const found = new Map((await batchGetItems(id, [...ids])).map((d) => [resourceId(d.name), d]));
      const docs = ids.flatMap((d) => found.get(resourceId(d)) ?? []).filter(isDoc);
      const parents = [...new Set(docs.map((d) => d.parentItem ?? "").filter(Boolean))];
      const parent = new Map((await batchGetItems(id, parents)).filter((c) => !!c.name).map((c) => [c.name ?? "", c]));
      const groups = new Map<string, DocGroup>();
      for (const d of docs) {
        const p = parent.get(d.parentItem ?? "");
        /** Other members' My files never feed my work (admins can read them). */
        if (p?.itemType === "PERSONAL" && p.name !== personal) continue;
        const key = d.parentItem ?? "";
        const label = p?.itemType === "PERSONAL" ? "Tệp của tôi" : p?.displayName || "Tài liệu";
        const g = groups.get(key) ?? { collection: key, label, docs: [] };
        g.docs.push(d);
        groups.set(key, g);
      }
      return [...groups.values()];
    },
  });
}

/** A space's material groups plus the passed documents it lacks (passed ones first, or in their collection's group). */
export function withPassedDocs(groups: DocGroup[] | undefined, passed: DocGroup[] | undefined): DocGroup[] | undefined {
  if (!groups || !passed?.length) return groups;
  const have = new Set(groups.flatMap((g) => g.docs.map((d) => d.name)));
  const extra = passed.map((g) => ({ ...g, docs: g.docs.filter((d) => !have.has(d.name)) })).filter((g) => g.docs.length);
  const byName = (a: Item, b: Item) => (a.displayName ?? "").localeCompare(b.displayName ?? "");
  const merged = groups.map((g) => {
    const e = extra.find((x) => x.collection === g.collection);
    return e ? { ...g, docs: [...g.docs, ...e.docs].sort(byName) } : g;
  });
  const fresh = extra.filter((e) => !groups.some((g) => g.collection === e.collection)).map((g) => ({ ...g, docs: [...g.docs].sort(byName) }));
  return [...fresh, ...merged];
}

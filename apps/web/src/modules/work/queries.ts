"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { ApiError, resourceId, type Schema } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { getArtifact, getOperation, getRevision, listAllArtifacts } from "@/modules/artifacts/api";
import { artifactKeys } from "@/modules/artifacts/queries";
import { getItem, listAllItems, listMaterials, quote, type Item } from "@/modules/knowledge/api";
import { knowledgeKeys } from "@/modules/knowledge/queries";

import { isWorkKind } from "./kinds";
import { reviewGenerating, type Artifact } from "./model";

type Space = Schema<"Space">;

export const workKeys = {
  list: (ws: string) => [...artifactKeys.all(ws), "work-list"] as const,
  operation: (ws: string, name: string) => [ws, "operations", name] as const,
  docs: (ws: string, scope: string) => [ws, "items", "work-docs", scope] as const,
};

/** Every Work artifact the caller can read (own + SPACE-audience ones of their spaces), newest first. */
export function useWorkList({ space, enabled = true }: { space?: string | null; enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const filter = space ? `space = ${quote(space.includes("/") ? space : `workspaces/${id}/spaces/${space}`)}` : undefined;
  return useQuery({
    queryKey: [...workKeys.list(id), filter ?? ""],
    queryFn: () => listAllArtifacts(id, { orderBy: "updateTime desc", filter }),
    select: (rows: Artifact[]) => rows.filter((a) => isWorkKind(a.kind) && a.state !== "DELETED"),
    enabled,
    refetchInterval: (query) => ((query.state.data ?? []).some((a) => a.state === "GENERATING") ? 3000 : false),
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

/** Documents (FULL items) for names, in order; unreadable ones are left out. */
export function useDocs(names: readonly string[]) {
  const { id } = useWorkspace();
  const results = useQueries({
    queries: names.map((name) => ({
      queryKey: knowledgeKeys.item(id, resourceId(name)),
      queryFn: () => getItem(id, resourceId(name)),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const key = results.map((r) => r.data?.name ?? (r.isError ? "x" : "")).join("|");
  return useMemo(() => {
    const byName = new Map<string, Item>();
    for (const r of results) if (r.data?.name) byName.set(r.data.name, r.data);
    return { byName, isPending: results.some((r) => r.isPending) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` captures the resolved items
  }, [key]);
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

const isDoc = (item: Item) => item.itemType === "DOCUMENT" && item.state !== "DELETED" && item.document?.purpose !== "CONVERSATION_ATTACHMENT";

/**
 * Documents a workflow can use, grouped by collection (preview `docGroups`): a space's
 * materials and linked collections, or — without a space — everything the caller can read.
 * `mine` adds My files (private learning workflows).
 */
export function useMaterialDocs(space: Space | null, { mine = false, enabled = true }: { mine?: boolean; enabled?: boolean } = {}) {
  const { id, member } = useWorkspace();
  const personal = member.personalCollection;
  return useQuery({
    queryKey: workKeys.docs(id, `${space?.name ?? "-"}|${mine ? "mine" : ""}`),
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<DocGroup[]> => {
      const collections = await listAllItems(id, { filter: "itemType = COLLECTION" }, 1000);
      const label = new Map(collections.map((c) => [c.name ?? "", c.collection?.kind === "PERSONAL" ? "My files" : (c.displayName ?? "")]));
      /** Other members' My files never feed my work (admins can read them). */
      const othersPersonal = new Set(collections.filter((c) => c.collection?.kind === "PERSONAL" && c.name !== personal).map((c) => c.name));
      const docs: Item[] = [];
      if (space?.name) {
        const materials = await listMaterials(id, resourceId(space.name));
        const items = await Promise.all(materials.map((m) => getItem(id, resourceId(m.item), "BASIC").catch(() => undefined)));
        const scoped = new Set(space.collections ?? []);
        for (const item of items) {
          if (!item) continue;
          if (isDoc(item)) docs.push(item);
          else if (item.itemType === "COLLECTION" && item.name) scoped.add(item.name);
        }
        if (mine && personal) scoped.add(personal);
        for (const name of scoped) docs.push(...(await listAllItems(id, { filter: `itemType = DOCUMENT AND ancestors:${quote(name)}`, orderBy: "displayName" }, 500).catch(() => [])));
      } else {
        const all = await listAllItems(id, { filter: "itemType = DOCUMENT", orderBy: "displayName" }, 1000);
        docs.push(...all.filter((d) => mine || !personal || d.parentItem !== personal));
      }
      const groups = new Map<string, DocGroup>();
      const seen = new Set<string>();
      for (const d of docs) {
        if (!isDoc(d) || !d.name || seen.has(d.name) || othersPersonal.has(d.parentItem)) continue;
        seen.add(d.name);
        const parent = d.parentItem ?? "";
        const g = groups.get(parent) ?? { collection: parent, label: label.get(parent) || "Documents", docs: [] };
        g.docs.push(d);
        groups.set(parent, g);
      }
      return [...groups.values()]
        .map((g) => ({ ...g, docs: g.docs.sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? "")) }))
        .sort((a, b) => Number(a.label === "My files") - Number(b.label === "My files") || a.label.localeCompare(b.label));
    },
  });
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
      const docs = (await Promise.all(ids.map((d) => getItem(id, resourceId(d), "BASIC").catch(() => undefined)))).filter((d): d is Item => !!d && isDoc(d));
      const parents = [...new Set(docs.map((d) => d.parentItem ?? "").filter(Boolean))];
      const cols = await Promise.all(parents.map((p) => getItem(id, resourceId(p), "BASIC").catch(() => undefined)));
      const parent = new Map(cols.filter((c): c is Item => !!c?.name).map((c) => [c.name ?? "", c]));
      const groups = new Map<string, DocGroup>();
      for (const d of docs) {
        const p = parent.get(d.parentItem ?? "");
        /** Other members' My files never feed my work (admins can read them). */
        if (p?.collection?.kind === "PERSONAL" && p.name !== personal) continue;
        const key = d.parentItem ?? "";
        const label = p?.collection?.kind === "PERSONAL" ? "My files" : p?.displayName || "Documents";
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

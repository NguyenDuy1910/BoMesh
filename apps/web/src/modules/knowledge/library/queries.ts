"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { getItem, listSpaces, type Item } from "../api";
import { knowledgeKeys } from "../queries";
import { listMyFiles } from "./api";

/** Query key of the caller's "My files" (under `library`, so knowledge invalidation refreshes it). */
export const myFilesKey = (ws: string) => [...knowledgeKeys.library(ws), "files"] as const;

/** Documents in the caller's personal collection; disabled (empty) when the member has none. */
export function useMyFiles() {
  const { id, member } = useWorkspace();
  const pc = member.personalCollection;
  return useQuery({ queryKey: myFilesKey(id), queryFn: () => listMyFiles(id, pc ?? ""), enabled: !!pc });
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
 * Items for many names at once (saved, recent, contribution candidates). Shares the
 * `useItem` cache. Items the caller can't open (404/403) are simply missing from the map.
 */
export function useItemsByName(names: readonly (string | undefined | null)[]): ItemsByName {
  const { id } = useWorkspace();
  const unique = [...new Set(names.map((n) => resourceId(n)).filter(Boolean))];
  const results = useQueries({
    queries: unique.map((itemId) => ({
      queryKey: knowledgeKeys.item(id, itemId),
      queryFn: () => getItem(id, itemId),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const stamp = results.map((r) => r.dataUpdatedAt).join("|");
  const items = useMemo(() => {
    const out = new Map<string, Item>();
    for (const r of results) if (r.data?.name) out.set(r.data.name, r.data);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `stamp` changes whenever any result's data does
  }, [stamp]);
  const loading = results.some((r) => r.isPending && r.fetchStatus !== "idle");
  // Only a failure that isn't "you can't open it" is an error worth retrying.
  const failed = results.filter((r) => r.isError && !isGone(r.error));
  return {
    items,
    isPending: loading,
    isError: failed.length > 0,
    error: failed[0]?.error,
    refetch: () => failed.forEach((r) => void r.refetch()),
  };
}

function isGone(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 403;
}

/** Workspace spaces (names and types for sharing labels and "Use in…"). Spaces module only. */
export function useSpaces() {
  const { id, hasModule } = useWorkspace();
  return useQuery({ queryKey: [id, "spaces", "all"], queryFn: () => listSpaces(id), enabled: hasModule("spaces"), staleTime: 5 * 60_000 });
}

"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { ApiError } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { knowledgeKeys } from "../queries";
import { getItemContent, type ItemContent } from "./api";

/** A window is read again this long before its first picture's signed URL expires. */
const URL_MARGIN_MS = 30_000;
/** Windows without pictures: their blocks never change for a pinned version. */
const PLAIN_STALE_MS = 10 * 60_000;

function expiresIn(windows: readonly ItemContent[]): number {
  let first = Infinity;
  const visit = (nodes: ItemContent["nodes"]) => {
    for (const node of nodes ?? []) {
      const at = Date.parse(node.image?.expireTime ?? "");
      if (Number.isFinite(at)) first = Math.min(first, at);
      if (node.children) visit(node.children);
    }
  };
  for (const window of windows) visit(window.nodes);
  return first === Infinity ? PLAIN_STALE_MS : Math.max(0, first - Date.now() - URL_MARGIN_MS);
}

/** 4xx answers (not processed, version gone, locked, missing) are final; only a server or network failure is retried. */
const retryServerErrors = (count: number, error: unknown) => !(error instanceof ApiError && error.status < 500) && count < 2;

export interface ContentTarget {
  /** Revision number; default the document's indexed revision. */
  revision?: number;
  /** Structure version; default the revision's current one. */
  version?: string;
  /** Block to open the first window around; the start of the document when empty. */
  anchor?: string;
}

/**
 * The Content View's windows of one Structured Document: the first around `anchor` (or the start), then the parts
 * before and after it on demand (`fetchPreviousPage` / `fetchNextPage`, through the windows' page tokens).
 */
export function useContentWindows(item: string, { revision, version, anchor }: ContentTarget, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useInfiniteQuery({
    queryKey: [...knowledgeKeys.item(id, item), "content", revision ?? 0, version ?? "", anchor ?? ""],
    queryFn: ({ pageParam }) => getItemContent(id, item, { revision, version, ...(pageParam ? { pageToken: pageParam } : { anchor }) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextPageToken || undefined,
    getPreviousPageParam: (first) => first.previousPageToken || undefined,
    enabled: enabled && !!item,
    retry: retryServerErrors,
    staleTime: (q) => expiresIn(q.state.data?.pages ?? []),
  });
}

/** The document's headings (GetItemContent `view=OUTLINE`), for the Reader's outline. */
export function useContentOutline(item: string, { revision, version }: Pick<ContentTarget, "revision" | "version">, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: [...knowledgeKeys.item(id, item), "content", revision ?? 0, version ?? "", "outline"],
    queryFn: () => getItemContent(id, item, { revision, version, view: "OUTLINE" }),
    enabled: enabled && !!item,
    retry: retryServerErrors,
    staleTime: PLAIN_STALE_MS,
  });
}

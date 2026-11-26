"use client";

import { useInfiniteQuery } from "@tanstack/react-query";

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
}

/**
 * The windows of one Structured Document (an artifact revision's content): the first from the start, then the
 * parts after it on demand (`fetchNextPage`, through the windows' page tokens).
 */
export function useContentWindows(item: string, { revision, version }: ContentTarget, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useInfiniteQuery({
    queryKey: [...knowledgeKeys.item(id, item), "content", revision ?? 0, version ?? ""],
    queryFn: ({ pageParam }) => getItemContent(id, item, { revision, version, ...(pageParam ? { pageToken: pageParam } : {}) }),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextPageToken || undefined,
    enabled: enabled && !!item,
    retry: retryServerErrors,
    staleTime: (q) => expiresIn(q.state.data?.pages ?? []),
  });
}

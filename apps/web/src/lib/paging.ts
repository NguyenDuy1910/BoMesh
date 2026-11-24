"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

/** The paging fields every AIP-158 List response carries. */
export interface TokenPage {
  nextPageToken?: string;
  totalSize?: number;
}

/**
 * One server page of an AIP-158 list with the page tokens read so far, for the `Pager` footer: Previous goes back
 * through them, Next adds the page's `nextPageToken`. A new `key` (filter, order, search…) starts over at page 1. The
 * previous page stays on screen while the next one loads. `key` is the query key without the token.
 */
export function useTokenPages<R extends TokenPage>(
  key: readonly unknown[],
  fetchPage: (pageToken: string | undefined) => Promise<R>,
  { enabled = true, staleTime }: { enabled?: boolean; staleTime?: number } = {},
) {
  const id = JSON.stringify(key);
  const [at, setAt] = useState({ id, page: 1, tokens: [""] });
  if (at.id !== id) setAt({ id, page: 1, tokens: [""] });
  const page = at.id === id ? at.page : 1;
  const token = (at.id === id && at.tokens[page - 1]) || "";
  const query = useQuery({
    queryKey: [...key, "page", token],
    queryFn: () => fetchPage(token || undefined),
    enabled,
    staleTime,
    placeholderData: keepPreviousData,
  });
  // A placeholder (the previous page) has no token for the page after the one loading.
  const next = query.isPlaceholderData ? undefined : query.data?.nextPageToken;
  const setPage = (p: number) => setAt({ id, page: p, tokens: p > page && next ? [...at.tokens.slice(0, page), next] : at.tokens });
  return { ...query, page, hasNext: !!next, total: query.data?.totalSize, setPage };
}

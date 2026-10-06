"use client";

import { useSyncExternalStore } from "react";

import { apiRevision, subscribeApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";

/**
 * An API read that refetches whenever a write elsewhere calls `invalidateApiData()`.
 *
 * Pages pass the request function rather than a path so a screen can compose
 * several endpoints into the one shape it renders. `key` names what the read
 * depends on beyond invalidation — e.g. the active workspace, which is not
 * known until the session has hydrated — so the read runs again when it changes.
 */
export function useApiData<T>(read: () => Promise<T>, key: string | number = "") {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  return useApiQuery(read, `${revision}:${key}`);
}

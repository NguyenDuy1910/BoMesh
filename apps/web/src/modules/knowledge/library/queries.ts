"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";

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

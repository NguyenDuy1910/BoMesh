"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { getSource, listSpaces } from "../api";
import { FORMATS, kindMeta, languageName, TRUST, UPDATED_WINDOWS, type FormatKey, type TrustState } from "../model";
import { knowledgeKeys, useKnowledgeBases, useMemberNames, useTopics } from "../queries";
import type { BrowseFacetId } from "./catalog";

export type FacetLabel = (facet: BrowseFacetId, value: string, fallback?: string) => string;

/**
 * Display names for Browse facet values (bare IDs and keys as in the URL): topics, spaces, document
 * types, owners, sources, knowledge bases, trust, windows, formats, languages. `owners` (member
 * names) and `sources` (bare IDs) are resolved on demand.
 */
export function useFacetLabel({ owners = [], sources = [] }: { owners?: readonly string[]; sources?: readonly string[] } = {}): FacetLabel {
  const { id: ws, settings, member, hasModule } = useWorkspace();
  const topics = useTopics();
  const bases = useKnowledgeBases();
  const spaces = useQuery({ queryKey: [ws, "spaces", "all"], queryFn: () => listSpaces(ws), enabled: hasModule("spaces"), staleTime: 5 * 60_000 });
  const memberNames = useMemberNames(owners);
  const sourceResults = useQueries({
    queries: sources.map((sid) => ({ queryKey: knowledgeKeys.source(ws, sid), queryFn: () => getSource(ws, sid), staleTime: 10 * 60_000, retry: false })),
  });
  const sourceKey = sourceResults.map((s) => s.data?.displayName ?? "").join("|");

  return useCallback<FacetLabel>(
    (facet, v, fallback = "") => {
      switch (facet) {
        case "topic":
          return topics.data?.find((t) => resourceId(t.name) === v)?.displayName || fallback || "Untitled topic";
        case "space":
          return spaces.data?.find((s) => resourceId(s.name) === v)?.displayName || "Space";
        case "kind":
          return kindMeta(v, new Map((settings?.documentTypes ?? []).map((t) => [t.key ?? "", t.displayName ?? t.key ?? ""]))).label;
        case "owner":
          return v === "—" ? "No owner" : memberNames.get(`workspaces/${ws}/members/${v}`) || fallback || "Owner";
        case "src":
          return v === "upload" ? "Uploaded files" : sourceResults.find((s) => resourceId(s.data?.name) === v)?.data?.displayName || fallback || "Source";
        case "kb":
          if (member.personalCollection && resourceId(member.personalCollection) === v) return "My files";
          return bases.data?.find((b) => resourceId(b.name) === v)?.displayName || fallback || "Knowledge base";
        case "trust":
          return TRUST[v as TrustState]?.label ?? v;
        case "upd":
          return UPDATED_WINDOWS.find((w) => w[0] === v)?.[1] ?? v;
        case "fmt":
          return FORMATS[v as FormatKey]?.label ?? "Other";
        case "lang":
          return languageName(v);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sourceKey` captures the resolved sources
    [topics.data, spaces.data, settings?.documentTypes, memberNames, sourceKey, bases.data, member.personalCollection, ws],
  );
}

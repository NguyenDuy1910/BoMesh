"use client";

import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces/queries";

import { getSource } from "../api";
import { FORMATS, kindMeta, languageName, TRUST, UPDATED_WINDOWS, type FormatKey, type TrustState } from "../model";
import { knowledgeKeys, useKnowledgeBases, useMemberNames, usePersonalCollectionNames, useTopics } from "../queries";
import type { BrowseFacetId } from "./catalog";

/** A facet value's display name; `.ui` says whether that name is UI vocabulary (translated) rather than a name people gave something. */
export type FacetLabel = ((facet: BrowseFacetId, value: string, fallback?: string) => string) & {
  ui: (facet: BrowseFacetId, value: string, fallback?: string) => boolean;
};

/**
 * Display names for Browse facet values (bare IDs and keys as in the URL): topics, spaces, document
 * types, owners, sources, collections (locked ones too, so a `kb=` link names what it filters by),
 * trust, windows, formats, languages. `owners` (member names) and `sources` (bare IDs) are resolved on demand.
 */
export function useFacetLabel({ owners = [], sources = [] }: { owners?: readonly string[]; sources?: readonly string[] } = {}): FacetLabel {
  const { id: ws, settings } = useWorkspace();
  const topics = useTopics();
  const bases = useKnowledgeBases({ showLocked: true });
  const personal = usePersonalCollectionNames();
  const spaces = useSpaces();
  const memberNames = useMemberNames(owners);
  const sourceResults = useQueries({
    queries: sources.map((sid) => ({ queryKey: knowledgeKeys.source(ws, sid), queryFn: () => getSource(ws, sid), staleTime: 10 * 60_000, retry: false })),
  });
  const sourceKey = sourceResults.map((s) => s.data?.displayName ?? "").join("|");

  const resolve = useCallback(
    (facet: BrowseFacetId, v: string, fallback = ""): [label: string, ui: boolean] => {
      const named = (name: string | undefined, uiName: string): [string, boolean] => (name ? [name, false] : [uiName, true]);
      switch (facet) {
        case "topic":
          return named(topics.data?.find((t) => resourceId(t.name) === v)?.displayName || fallback, "Untitled topic");
        case "space":
          return named(spaces.data?.find((s) => resourceId(s.name) === v)?.displayName, "Space");
        case "kind":
          return [kindMeta(v, new Map((settings?.documentTypes ?? []).map((t) => [t.key ?? "", t.displayName ?? t.key ?? ""]))).label, true];
        case "owner":
          return v === "—" ? ["No owner", true] : named(memberNames.get(`workspaces/${ws}/members/${v}`) || fallback, "Owner");
        case "src":
          return v === "upload" ? ["Uploaded files", true] : named(sourceResults.find((s) => resourceId(s.data?.name) === v)?.data?.displayName || fallback, "Source");
        case "kb": {
          const mine = personal.get(`workspaces/${ws}/items/${v}`);
          return mine ? [mine, true] : named(bases.data?.find((b) => resourceId(b.name) === v)?.displayName || fallback, "Collection");
        }
        case "trust":
          return [TRUST[v as TrustState]?.label ?? v, true];
        case "upd":
          return [UPDATED_WINDOWS.find((w) => w[0] === v)?.[1] ?? v, true];
        case "fmt":
          return [FORMATS[v as FormatKey]?.label ?? "Other", true];
        case "lang":
          return [languageName(v), true];
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sourceKey` captures the resolved sources
    [topics.data, spaces.data, settings?.documentTypes, memberNames, sourceKey, bases.data, personal, ws],
  );
  return useMemo(() => Object.assign((f: BrowseFacetId, v: string, fb?: string) => resolve(f, v, fb)[0], { ui: (f: BrowseFacetId, v: string, fb?: string) => resolve(f, v, fb)[1] }), [resolve]);
}

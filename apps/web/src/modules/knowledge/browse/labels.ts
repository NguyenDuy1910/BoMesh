"use client";

import { useQueries } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useMessages } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces/queries";

import { getSource } from "../api";
import { DOC_TYPES, docTypeOf, languageName, type TrustState, type UpdatedWindow } from "../model";
import { knowledgeKeys, useKnowledgeBases, useTaxonomy } from "../queries";
import { conceptLabel, conceptNameOf, isClassification, schemeByName } from "../taxonomy";
import type { BrowseFacetId } from "./catalog";

/** A facet value's display name; `.ui` says whether that name is UI vocabulary (translated) rather than a name people gave something. */
export type FacetLabel = ((facet: BrowseFacetId, value: string, fallback?: string) => string) & {
  ui: (facet: BrowseFacetId, value: string, fallback?: string) => boolean;
};

/**
 * Display names for Browse facet values (bare IDs and keys as in the URL): concepts (a scheme facet's values), spaces, document
 * types (file classes), owners, sources, collections (locked ones too, so a `kb=` link names what it filters by),
 * trust, windows, languages. Owners are named by the search itself (`ownerNames`: member
 * name → the `document.owner` facet's `displayName`), so no member is read per owner; `sources`
 * (bare IDs) are resolved on demand.
 */
export function useFacetLabel({ ownerNames, sources = [] }: { ownerNames?: ReadonlyMap<string, string>; sources?: readonly string[] } = {}): FacetLabel {
  const { id: ws, member } = useWorkspace();
  const m = useMessages();
  const facets = m.knowledge.browse.facets;
  const taxonomy = useTaxonomy().data;
  const bases = useKnowledgeBases({ showLocked: true });
  const spaces = useSpaces();
  const sourceResults = useQueries({
    queries: sources.map((sid) => ({ queryKey: knowledgeKeys.source(ws, sid), queryFn: () => getSource(ws, sid), staleTime: 10 * 60_000, retry: false })),
  });
  const sourceKey = sourceResults.map((s) => s.data?.displayName ?? "").join("|");

  const resolve = useCallback(
    (facet: BrowseFacetId, v: string, fallback = ""): [label: string, ui: boolean] => {
      const named = (name: string | undefined, uiName: string): [string, boolean] => (name ? [name, false] : [uiName, true]);
      switch (facet) {
        case "space":
          return named(spaces.data?.find((s) => resourceId(s.name) === v)?.displayName || fallback, facets.space);
        case "type":
          return [DOC_TYPES[docTypeOf(v)].label, true];
        case "owner":
          return v === "—" ? ["Chưa có chủ sở hữu", true] : named(ownerNames?.get(`workspaces/${ws}/members/${v}`) || fallback, facets.owner);
        case "src":
          return v === "upload" ? ["Tệp đã tải lên", true] : named(sourceResults.find((s) => resourceId(s.data?.name) === v)?.data?.displayName || fallback, facets.src);
        case "kb":
          return `workspaces/${ws}/items/${v}` === member.personalCollection ? ["Tệp của tôi", true] : named(bases.data?.find((b) => resourceId(b.name) === v)?.displayName || fallback, facets.kb);
        case "trust":
          return [m.state.verification[v as TrustState]?.label ?? v, true];
        case "upd":
          return [m.knowledge.browse.updated[v as UpdatedWindow] ?? v, true];
        case "lang":
          return [languageName(v), true];
        default: {
          // A classification scheme's facet: the concept's preferred label (content).
          const scheme = schemeByName(taxonomy, facet);
          const concept = scheme?.name && isClassification(scheme) ? taxonomy.byName.get(conceptNameOf(scheme.name, v)) : undefined;
          return named(concept ? conceptLabel(taxonomy, concept.name) : fallback, "Khái niệm chưa đặt tên");
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sourceKey` captures the resolved sources
    [taxonomy, spaces.data, ownerNames, sourceKey, bases.data, member.personalCollection, ws, m],
  );
  return useMemo(() => Object.assign((f: BrowseFacetId, v: string, fb?: string) => resolve(f, v, fb)[0], { ui: (f: BrowseFacetId, v: string, fb?: string) => resolve(f, v, fb)[1] }), [resolve]);
}

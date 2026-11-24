"use client";

import { useQueries } from "@tanstack/react-query";

import { List, ListItem, SkeletonRows } from "@/components/ui";
import { resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { useKnowledgeBases } from "@/modules/knowledge/queries";
import { baseColor } from "@/modules/knowledge/bases/model";

import { analyzePolicy, type IamAnalysis } from "../api";
import { ACCESS_LABEL, topCollectionRole } from "../model";
import { peopleKeys } from "../queries";

/** `via` of a collection every member can open (general access All members). */
export const ALL_MEMBERS_VIA = "All members";

export interface BaseAccess {
  /** Bare item ID of the collection. */
  id: string;
  name: string;
  /** How access comes: "Shared directly", group names or `ALL_MEMBERS_VIA`. */
  via: string;
  role: string;
}

const collectionRoles = (analysis: IamAnalysis | undefined) =>
  new Map((analysis?.results ?? []).filter((r) => r.resource?.includes("/items/")).map((r) => [resourceId(r.resource), topCollectionRole(r.roles)]));

/**
 * Collections a principal can open and why (preview `kbAccess`), from AnalyzeWorkspaceIamPolicy:
 * `everyone` (workspaceMembers) and each group explain shared access; the rest of the user's
 * effective roles count as shared directly. `groups` is the (draft) group list to show.
 */
export function useKnowledgeAccess({ user, groups, currentGroups, groupLabel }: { user?: string; groups: readonly string[]; currentGroups?: readonly string[]; groupLabel: (group: string) => string }) {
  const { id } = useWorkspace();
  const bases = useKnowledgeBases();
  const groupSet = [...new Set([...groups, ...(currentGroups ?? [])])];
  const principals = [...(user ? [`user:${resourceId(user)}`] : []), "workspaceMembers", ...groupSet.map((g) => `group:${resourceId(g)}`)];
  const results = useQueries({
    queries: principals.map((principal) => ({ queryKey: peopleKeys.analysis(id, principal), queryFn: () => analyzePolicy(id, principal), staleTime: 30_000 })),
  });
  const pending = bases.isPending || results.some((r) => r.isPending);
  const failed = bases.isError || results.some((r) => r.isError);
  let data: BaseAccess[] | undefined;
  if (!pending && !failed) {
    const byPrincipal = new Map(principals.map((p, i) => [p, collectionRoles(results[i].data)]));
    const everyone = byPrincipal.get("workspaceMembers")!;
    const direct = user ? byPrincipal.get(`user:${resourceId(user)}`)! : new Map<string, string | null>();
    const explained = new Set<string>();
    for (const [base, role] of everyone) if (role) explained.add(base);
    for (const g of currentGroups ?? []) for (const [base, role] of byPrincipal.get(`group:${resourceId(g)}`) ?? []) if (role) explained.add(base);
    data = (bases.data ?? [])
      .filter((b) => b.itemType !== "PERSONAL")
      .map((b): BaseAccess | null => {
        const baseId = resourceId(b.name);
        const own = direct.get(baseId);
        if (own && !explained.has(baseId)) return { id: baseId, name: b.displayName ?? "", via: "Shared directly", role: own };
        const viaGroups = groups.filter((g) => byPrincipal.get(`group:${resourceId(g)}`)?.get(baseId));
        if (viaGroups.length) return { id: baseId, name: b.displayName ?? "", via: viaGroups.map(groupLabel).join(", "), role: byPrincipal.get(`group:${resourceId(viaGroups[0])}`)!.get(baseId)! };
        const all = everyone.get(baseId);
        if (all) return { id: baseId, name: b.displayName ?? "", via: ALL_MEMBERS_VIA, role: all };
        return null;
      })
      .filter((x): x is BaseAccess => x !== null);
  }
  return { data, isPending: pending, isError: failed };
}

/** Coloured dot leading a collection row (preview `kbDot`); `id` is the collection's item ID. */
export function BaseDot({ id }: { id: string }) {
  return <span className="ppl-dot" style={{ background: baseColor(id) }} aria-hidden />;
}

/** `showVia` explains where access comes from (member drawer); a group's own list omits it. */
export function KnowledgeAccessList({ access, empty, linkTab, showVia = true }: { access: { data?: BaseAccess[]; isPending: boolean; isError: boolean }; empty: string; linkTab?: string; showVia?: boolean }) {
  if (access.isPending) return <SkeletonRows rows={2} />;
  if (access.isError || !access.data) return <p className="t-sm muted">Knowledge access didn’t load.</p>;
  if (!access.data.length) return <p className="t-sm muted">{empty}</p>;
  return (
    <List>
      {access.data.map((a) => (
        <ListItem
          key={a.id}
          lead={<BaseDot id={a.id} />}
          title={a.name}
          contentTitle
          description={showVia ? <span translate={a.via === "Shared directly" || a.via === ALL_MEMBERS_VIA ? undefined : "no"}>{a.via}</span> : undefined}
          meta={ACCESS_LABEL[a.role] ?? "Viewer"}
          href={`/studio/collections/${a.id}${linkTab ? `?tab=${linkTab}` : ""}`}
        />
      ))}
    </List>
  );
}

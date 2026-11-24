"use client";

import { useQueries, useQuery } from "@tanstack/react-query";

import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { countContributions, listContributionsPage } from "@/modules/curation/api";
import { contributionsOf } from "@/modules/curation/docFilter";

import { quote, type Contribution } from "../api";
import { knowledgeKeys } from "../queries";
import { listMyFiles } from "./api";
import { CTB_GROUP_FILTER, CTB_GROUPS, type ContributionGroup } from "./contributions";

/** Query key of the caller's "My files" (under `library`, so knowledge invalidation refreshes it). */
export const myFilesKey = (ws: string) => [...knowledgeKeys.library(ws), "files"] as const;

/** Rows per page of My files and My contributions (one server page; its names fit one batch read). */
export const LIBRARY_PAGE = 30;

/** One page of documents in the caller's personal collection (`search`: a `displayName` clause); disabled when the member has none. */
export function useMyFiles(search: string) {
  const { id, member } = useWorkspace();
  const pc = member.personalCollection ?? "";
  return useTokenPages([...myFilesKey(id), search], (pageToken) => listMyFiles(id, pc, { search, pageSize: LIBRARY_PAGE, pageToken }), { enabled: !!pc });
}

const mine = (ws: string) => `contributor = ${quote(`workspaces/${ws}/members/me`)}`;
const OPEN = "(state = ANALYZING OR state = IN_REVIEW OR state = CHANGES_REQUESTED)";

/** The caller's open contributions about a page of documents (one ListContributions read), keyed by item name. */
export function useMyOpenContributions(items: readonly string[]) {
  const { id } = useWorkspace();
  const names = [...new Set(items.filter(Boolean))].sort();
  return useQuery({
    queryKey: knowledgeKeys.contributionList(id, `mineOpen|${names.join(",")}`),
    queryFn: async () => {
      const page = await listContributionsPage(id, { filter: `${mine(id)} AND ${OPEN} AND (${contributionsOf(names)})`, orderBy: "updateTime desc", view: "FULL", pageSize: Math.min(50, names.length * 2) });
      const out = new Map<string, Contribution>();
      for (const c of page.contributions ?? []) if (c.item && !out.has(c.item)) out.set(c.item, c);
      return out;
    },
    enabled: names.length > 0,
  });
}

/** One page of the caller's contributions in a group (newest activity first); `search` is an `itemDisplayName` clause. */
export function useMyContributionPage(group: ContributionGroup, search: string) {
  const { id } = useWorkspace();
  const filter = [mine(id), CTB_GROUP_FILTER[group], search].filter(Boolean).join(" AND ");
  return useTokenPages(knowledgeKeys.contributionList(id, `mine|${filter}`), (pageToken) =>
    listContributionsPage(id, { filter, orderBy: "updateTime desc", view: "FULL", pageSize: LIBRARY_PAGE, pageToken }),
  );
}

/** How many of the caller's contributions each group holds (one `pageSize=1` count per group). */
export function useMyContributionCounts(): Partial<Record<ContributionGroup, number>> {
  const { id } = useWorkspace();
  return useQueries({
    queries: CTB_GROUPS.map(([group]) => ({
      queryKey: knowledgeKeys.contributionList(id, `mineCount|${group}`),
      queryFn: () => countContributions(id, `${mine(id)} AND ${CTB_GROUP_FILTER[group]}`),
      staleTime: 30_000,
    })),
    combine: (results) => Object.fromEntries(CTB_GROUPS.flatMap(([group], i) => (results[i]?.data === undefined ? [] : [[group, results[i].data]]))),
  });
}

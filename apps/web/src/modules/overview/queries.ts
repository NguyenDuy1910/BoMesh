"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";
import { countRequests } from "@/modules/requests/api";

import { countItems, getOverview, listConnections, listRequestPage, listSources, listTopOpenGaps, type OverviewWindow } from "./api";

export const overviewKeys = {
  overview: (ws: string, window: OverviewWindow) => [ws, "overview", window] as const,
  gaps: (ws: string) => [ws, "overview", "gaps"] as const,
  sources: (ws: string) => [ws, "overview", "sources"] as const,
  connections: (ws: string) => [ws, "overview", "connections"] as const,
  access: (ws: string) => [ws, "overview", "access-requests"] as const,
  service: (ws: string) => [ws, "overview", "service-requests"] as const,
  searchable: (ws: string) => [ws, "overview", "searchable"] as const,
};

export function useOverview(window: OverviewWindow) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.overview(id, window), queryFn: () => getOverview(id, window), staleTime: 60_000 });
}

/** How many gaps the Overview lists: the ones asked most. */
const TOP_GAPS = 4;

export function useGaps() {
  const { id, can } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.gaps(id), enabled: can("knowledgeGaps.list"), queryFn: () => listTopOpenGaps(id, TOP_GAPS) });
}

export function useSources() {
  const { id, can } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.sources(id), enabled: can("sources.list"), queryFn: () => listSources(id), staleTime: 60_000 });
}

export function useConnections() {
  const { id, can } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.connections(id), enabled: can("connections.list"), queryFn: () => listConnections(id), staleTime: 60_000 });
}

/** Open access requests to collections: one page (enough to name who and where when they all fit) and the total. */
const ACCESS_PAGE = 50;

export function useAccessRequests() {
  const { id, can } = useWorkspace();
  return useQuery({
    queryKey: overviewKeys.access(id),
    enabled: can("members.create"),
    queryFn: async () => {
      const page = await listRequestPage(id, 'kind = "COLLECTION_ACCESS" AND state = "OPEN"', ACCESS_PAGE, "createTime desc");
      const requests = page.requests ?? [];
      return { requests, total: page.totalSize ?? requests.length, complete: !page.nextPageToken };
    },
    staleTime: 60_000,
  });
}

const DAY = 86_400_000;
const OPEN_SERVICE = 'kind = "SERVICE" AND state = "OPEN"';

/** Office queues past or near their response time: the counts and the first two of each, soonest due first. */
export function useServiceSla() {
  const { id, can, hasModule } = useWorkspace();
  return useQuery({
    queryKey: [...overviewKeys.service(id), "sla"],
    enabled: hasModule("requests") && can("requests.list"),
    queryFn: async () => {
      const now = new Date();
      const day = new Date(now.getTime() + DAY);
      const [late, soon] = await Promise.all([
        listRequestPage(id, `${OPEN_SERVICE} AND overdue = true`, 2, "dueTime"),
        listRequestPage(id, `${OPEN_SERVICE} AND dueTime >= "${now.toISOString()}" AND dueTime <= "${day.toISOString()}"`, 2, "dueTime"),
      ]);
      return { late: late.totalSize ?? 0, soon: soon.totalSize ?? 0, first: [...(late.requests ?? []), ...(soon.requests ?? [])].slice(0, 2) };
    },
    staleTime: 60_000,
  });
}

const RESOLVED = '(state = "APPROVED" OR state = "DENIED" OR state = "ANSWERED" OR state = "CLOSED")';

/** Requests on time: service requests resolved, how many of them after their due date, and how many are open. */
export function useServiceKpi() {
  const { id, can, hasModule } = useWorkspace();
  return useQuery({
    queryKey: [...overviewKeys.service(id), "kpi"],
    enabled: hasModule("requests") && can("requests.list"),
    queryFn: async () => {
      const [done, late, open] = await Promise.all([
        countRequests(id, `kind = "SERVICE" AND ${RESOLVED}`),
        countRequests(id, `kind = "SERVICE" AND ${RESOLVED} AND closedLate = true`),
        countRequests(id, 'kind = "SERVICE" AND (state = "OPEN" OR state = "NEEDS_INFO")'),
      ]);
      return { done, onTime: done - late, open };
    },
    staleTime: 60_000,
  });
}

const PUBLISHED = "itemKind = DOCUMENT AND document.publicationState = PUBLISHED";

/** Published documents and how many of them are searchable (This week › Documents searchable). */
export function useSearchable() {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: overviewKeys.searchable(id),
    queryFn: async () => {
      const [published, ready] = await Promise.all([countItems(id, PUBLISHED), countItems(id, `${PUBLISHED} AND document.indexingState = SUCCEEDED`)]);
      return { published, ready };
    },
    staleTime: 60_000,
  });
}

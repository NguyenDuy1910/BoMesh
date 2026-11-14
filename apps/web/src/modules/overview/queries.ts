"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";

import { countItems, getOverview, hasTopics, listAccessRequests, listConnections, listOpenGaps, listServiceRequests, listSources, type OverviewWindow } from "./api";

export const overviewKeys = {
  overview: (ws: string, window: OverviewWindow) => [ws, "overview", window] as const,
  gaps: (ws: string) => [ws, "overview", "gaps"] as const,
  sources: (ws: string) => [ws, "overview", "sources"] as const,
  connections: (ws: string) => [ws, "overview", "connections"] as const,
  access: (ws: string) => [ws, "overview", "access-requests"] as const,
  service: (ws: string) => [ws, "overview", "service-requests"] as const,
  topics: (ws: string) => [ws, "overview", "has-topics"] as const,
  searchable: (ws: string) => [ws, "overview", "searchable"] as const,
};

export function useOverview(window: OverviewWindow) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.overview(id, window), queryFn: () => getOverview(id, window), staleTime: 60_000 });
}

export function useGaps() {
  const { id, can } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.gaps(id), enabled: can("knowledgeGaps.list"), queryFn: () => listOpenGaps(id) });
}

export function useSources() {
  const { id, can } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.sources(id), enabled: can("sources.list"), queryFn: () => listSources(id), staleTime: 60_000 });
}

export function useConnections() {
  const { id, can } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.connections(id), enabled: can("connections.list"), queryFn: () => listConnections(id), staleTime: 60_000 });
}

export function useAccessRequests() {
  const { id, can } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.access(id), enabled: can("members.create"), queryFn: () => listAccessRequests(id), staleTime: 60_000 });
}

export function useServiceRequests() {
  const { id, can, hasModule } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.service(id), enabled: hasModule("requests") && can("requests.list"), queryFn: () => listServiceRequests(id), staleTime: 60_000 });
}

/** Whether any active topic exists (setup checklist). */
export function useHasTopics({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: overviewKeys.topics(id), enabled, queryFn: () => hasTopics(id), staleTime: 60_000 });
}

const PUBLISHED = "itemType = DOCUMENT AND document.publicationState = PUBLISHED";

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

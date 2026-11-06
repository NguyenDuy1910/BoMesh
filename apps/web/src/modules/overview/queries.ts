"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";

import { getOverview, listAccessRequests, listConnections, listOpenGaps, listServiceRequests, listSources, type OverviewWindow } from "./api";

export const overviewKeys = {
  overview: (ws: string, window: OverviewWindow) => [ws, "overview", window] as const,
  gaps: (ws: string) => [ws, "overview", "gaps"] as const,
  sources: (ws: string) => [ws, "overview", "sources"] as const,
  connections: (ws: string) => [ws, "overview", "connections"] as const,
  access: (ws: string) => [ws, "overview", "access-requests"] as const,
  service: (ws: string) => [ws, "overview", "service-requests"] as const,
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

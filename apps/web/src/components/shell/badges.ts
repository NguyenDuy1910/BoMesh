"use client";

import { useQuery } from "@tanstack/react-query";

import { api, call } from "@/lib/api/client";
import type { NavBadge } from "@/lib/navigation";
import { useWorkspace } from "@/lib/workspace";
import { useRequestsBadge } from "@/modules/requests";
import { countRequests } from "@/modules/requests/api";

/**
 * Attention counts on sidebar items (preview `navItem` counts). Each is one
 * `pageSize=1` list call with a server filter, read from `totalSize`, and only
 * when the caller may make it:
 * - requests: the Requests module's own count (`useRequestsBadge`);
 * - documents: contributions in review;
 * - sources: sources failing or needing re-authorization;
 * - connections: connections expired or failing;
 * - people: pending access requests to knowledge bases.
 * Mutations invalidate `[workspace, "shell-badge"]`, so the counts stay cached across navigation.
 */
const STALE = 5 * 60_000;
const FAILING = 'state = "FAILED" OR state = "REAUTHORIZATION_REQUIRED"';

export function useNavBadges(): Partial<Record<NavBadge, number>> {
  const { id, can, hasModule } = useWorkspace();
  const path = { workspace: id };
  const requests = useRequestsBadge();

  const documents = useQuery({
    queryKey: [id, "shell-badge", "documents"],
    enabled: can("contributions.review"),
    staleTime: STALE,
    queryFn: async () =>
      (await call(api.GET("/api/v1/workspaces/{workspace}/contributions", { params: { path, query: { pageSize: 1, filter: 'state = "IN_REVIEW"' } } })))
        .totalSize ?? 0,
  });

  const sources = useQuery({
    queryKey: [id, "shell-badge", "sources"],
    enabled: can("sources.list"),
    staleTime: STALE,
    queryFn: async () =>
      (await call(api.GET("/api/v1/workspaces/{workspace}/sources", { params: { path, query: { pageSize: 1, filter: FAILING } } }))).totalSize ?? 0,
  });

  const connections = useQuery({
    queryKey: [id, "shell-badge", "connections"],
    enabled: can("sources.list"),
    staleTime: STALE,
    queryFn: async () =>
      (await call(api.GET("/api/v1/workspaces/{workspace}/connections", { params: { path, query: { pageSize: 1, filter: FAILING } } }))).totalSize ?? 0,
  });

  const people = useQuery({
    queryKey: [id, "shell-badge", "people"],
    enabled: can("members.create") && hasModule("requests"),
    staleTime: STALE,
    queryFn: () => countRequests(id, 'kind = "COLLECTION_ACCESS" AND state = "OPEN"'),
  });

  return {
    requests,
    documents: documents.data,
    sources: sources.data,
    connections: connections.data,
    people: people.data,
  };
}

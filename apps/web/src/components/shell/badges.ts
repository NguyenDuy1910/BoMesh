"use client";

import { useQuery } from "@tanstack/react-query";

import { api, call } from "@/lib/api/client";
import type { NavBadge } from "@/lib/navigation";
import { useWorkspace } from "@/lib/workspace";
import { useRequestsBadge } from "@/modules/requests";

/**
 * Attention counts on sidebar items (preview `navItem` counts), each from one
 * cheap list call the caller is allowed to make:
 * - requests: the Requests module's own count (`useRequestsBadge`, shares the /requests list cache);
 * - documents: contributions in review;
 * - sources: sources failing or needing re-authorization;
 * - connections: connections expired or failing;
 * - people: pending access requests to knowledge bases.
 */
const STALE = 60_000;

export function useNavBadges(): Partial<Record<NavBadge, number>> {
  const { id, can, hasModule } = useWorkspace();
  const path = { workspace: id };
  const requests = useRequestsBadge();

  const documents = useQuery({
    queryKey: [id, "shell-badge", "documents"],
    enabled: can("contributions.review"),
    staleTime: STALE,
    queryFn: async () => {
      const page = await call(
        api.GET("/api/v1/workspaces/{workspace}/contributions", {
          params: { path, query: { pageSize: 100, filter: 'state = "IN_REVIEW"' } },
        }),
      );
      return page.totalSize ?? page.contributions?.length ?? 0;
    },
  });

  const sources = useQuery({
    queryKey: [id, "shell-badge", "sources"],
    enabled: can("sources.list"),
    staleTime: STALE,
    queryFn: async () => {
      const page = await call(api.GET("/api/v1/workspaces/{workspace}/sources", { params: { path, query: { pageSize: 500 } } }));
      return (page.sources ?? []).filter((s) => s.state === "FAILED" || s.state === "REAUTHORIZATION_REQUIRED").length;
    },
  });

  const connections = useQuery({
    queryKey: [id, "shell-badge", "connections"],
    enabled: can("sources.list"),
    staleTime: STALE,
    queryFn: async () => {
      const page = await call(api.GET("/api/v1/workspaces/{workspace}/connections", { params: { path, query: { pageSize: 500 } } }));
      return (page.connections ?? []).filter((c) => c.state === "FAILED" || c.state === "REAUTHORIZATION_REQUIRED").length;
    },
  });

  const people = useQuery({
    queryKey: [id, "shell-badge", "people"],
    enabled: can("members.create") && hasModule("requests"),
    staleTime: STALE,
    queryFn: async () => {
      const page = await call(
        api.GET("/api/v1/workspaces/{workspace}/requests", {
          params: { path, query: { pageSize: 100, filter: 'kind = "COLLECTION_ACCESS" AND state = "OPEN"' } },
        }),
      );
      return page.totalSize ?? page.requests?.length ?? 0;
    },
  });

  return {
    requests,
    documents: documents.data,
    sources: sources.data,
    connections: connections.data,
    people: people.data,
  };
}

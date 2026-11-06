"use client";

import { api, call, listAll, type Schema } from "@/lib/api/client";

/**
 * Overview (`/overview`, openapi.yaml "Workspaces"): the admin read model (attention items,
 * KPIs, daily usage), knowledge gaps, and the lookups the attention items name.
 */

export type WorkspaceOverview = Schema<"WorkspaceOverview">;
export type AttentionItem = NonNullable<WorkspaceOverview["attentionItems"]>[number];
export type KnowledgeGap = Schema<"KnowledgeGap">;
export type OverviewWindow = "P1D" | "P7D" | "P30D";

/** The browser's IANA time zone (days are bucketed in it). */
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function getOverview(workspace: string, window: OverviewWindow): Promise<WorkspaceOverview> {
  return call(api.GET("/api/v1/workspaces/{workspace}/overview", { params: { path: { workspace }, query: { window, timeZone: timeZone() } } }));
}

/** Open gaps (questions knowledge couldn't answer well). */
export function listOpenGaps(workspace: string): Promise<KnowledgeGap[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/knowledgeGaps", { params: { path: { workspace }, query: { pageSize: 100, pageToken, filter: 'state = "OPEN"' } } })),
    (page) => page.knowledgeGaps,
  );
}

const gapPath = (workspace: string, gap: string) => ({ workspace, knowledgeGap: gap.slice(gap.lastIndexOf("/") + 1) });

export function dismissGap(workspace: string, gap: string): Promise<KnowledgeGap> {
  return call(api.POST("/api/v1/workspaces/{workspace}/knowledgeGaps/{knowledgeGap}:dismiss", { params: { path: gapPath(workspace, gap) }, body: {} }));
}

export function reopenGap(workspace: string, gap: string): Promise<KnowledgeGap> {
  return call(api.POST("/api/v1/workspaces/{workspace}/knowledgeGaps/{knowledgeGap}:reopen", { params: { path: gapPath(workspace, gap) }, body: {} }));
}

/** Number of documents matching an item filter (`totalSize`). */
export async function countItems(workspace: string, filter: string): Promise<number> {
  const page = await call(api.GET("/api/v1/workspaces/{workspace}/items", { params: { path: { workspace }, query: { filter, pageSize: 1 } } }));
  return page.totalSize ?? page.items?.length ?? 0;
}

export function listSources(workspace: string): Promise<Schema<"Source">[]> {
  return listAll((pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/sources", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })), (p) => p.sources);
}

export function listConnections(workspace: string): Promise<Schema<"Connection">[]> {
  return listAll((pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/connections", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })), (p) => p.connections);
}

/** Open access requests to knowledge bases (People › Requests). */
export function listAccessRequests(workspace: string): Promise<Schema<"Request">[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/requests", { params: { path: { workspace }, query: { pageSize: 200, pageToken, filter: 'kind = "COLLECTION_ACCESS" AND state = "OPEN"' } } })),
    (p) => p.requests,
  );
}

export function approveRequest(workspace: string, request: string, etag?: string): Promise<Schema<"Request">> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests/{request}:approve", {
      params: { path: { workspace, request: request.slice(request.lastIndexOf("/") + 1) } },
      body: { etag },
    }),
  );
}

/** Service requests (office queues and their SLA). */
export function listServiceRequests(workspace: string): Promise<Schema<"Request">[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/requests", { params: { path: { workspace }, query: { pageSize: 200, pageToken, filter: 'kind = "SERVICE"' } } })),
    (p) => p.requests,
  );
}

"use client";

import { api, call, listAll, type Schema } from "@/lib/api/client";

/**
 * Overview (`/overview`, openapi.yaml "Workspaces"): the admin read model (attention counts, KPIs, daily
 * usage), knowledge gaps, and the lists the attention items and the setup checklist read.
 */

export type WorkspaceOverview = Schema<"WorkspaceOverview">;
export type KnowledgeGap = Schema<"KnowledgeGap">;
export type Source = Schema<"Source">;
export type Connection = Schema<"Connection">;
export type Request = Schema<"Request">;
export type OverviewWindow = "P1D" | "P7D" | "P30D";

/** The browser's IANA time zone (days are bucketed in it). */
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function getOverview(workspace: string, window: OverviewWindow): Promise<WorkspaceOverview> {
  return call(api.GET("/api/v1/workspaces/{workspace}/overview", { params: { path: { workspace }, query: { window, timeZone: timeZone() } } }));
}

/** The `pageSize` open gaps asked most often (the server's default order: ask count, then last asked). */
export async function listTopOpenGaps(workspace: string, pageSize: number): Promise<KnowledgeGap[]> {
  const page = await call(api.GET("/api/v1/workspaces/{workspace}/knowledgeGaps", { params: { path: { workspace }, query: { pageSize, filter: 'state = "OPEN"' } } }));
  return page.knowledgeGaps ?? [];
}

const gapPath = (workspace: string, gap: string) => ({ workspace, knowledgeGap: gap.slice(gap.lastIndexOf("/") + 1) });

export function dismissGap(workspace: string, gap: string): Promise<KnowledgeGap> {
  return call(api.POST("/api/v1/workspaces/{workspace}/knowledgeGaps/{knowledgeGap}:dismiss", { params: { path: gapPath(workspace, gap) }, body: {} }));
}

export function reopenGap(workspace: string, gap: string): Promise<KnowledgeGap> {
  return call(api.POST("/api/v1/workspaces/{workspace}/knowledgeGaps/{knowledgeGap}:reopen", { params: { path: gapPath(workspace, gap) }, body: {} }));
}

/** Number of items matching a ListItems filter (`totalSize`). */
export async function countItems(workspace: string, filter: string): Promise<number> {
  const page = await call(api.GET("/api/v1/workspaces/{workspace}/items", { params: { path: { workspace }, query: { filter, pageSize: 1 } } }));
  return page.totalSize ?? page.items?.length ?? 0;
}

/** Whether the workspace has any active topic (the setup checklist's "Load your topics" step). */
export async function hasTopics(workspace: string): Promise<boolean> {
  const page = await call(api.GET("/api/v1/workspaces/{workspace}/topics", { params: { path: { workspace }, query: { pageSize: 1, filter: 'kind = "TOPIC" AND state = "ACTIVE"' } } }));
  return (page.totalSize ?? page.topics?.length ?? 0) > 0;
}

export function listSources(workspace: string): Promise<Source[]> {
  return listAll((pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/sources", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })), (p) => p.sources);
}

export function listConnections(workspace: string): Promise<Connection[]> {
  return listAll((pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/connections", { params: { path: { workspace }, query: { pageSize: 200, pageToken } } })), (p) => p.connections);
}

/** One page of requests matching `filter` (any kind); `pageSize: 1` reads a count from `totalSize`. */
export function listRequestPage(workspace: string, filter: string, pageSize: number, orderBy?: string) {
  return call(api.GET("/api/v1/workspaces/{workspace}/requests", { params: { path: { workspace }, query: { pageSize, filter, orderBy } } }));
}

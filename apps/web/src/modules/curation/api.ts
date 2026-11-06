"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";
import { listAllItems, type Contribution, type Item, type Topic } from "@/modules/knowledge/api";

/**
 * Manage → Documents (`/documents`): reviewer decisions on contributions, every curated
 * document, processing retries, duplicate merges and the taxonomy (openapi.yaml "Knowledge"
 * + "Ingestion"). Path params are bare IDs; bodies carry full resource names.
 */

export type { Contribution, Item, Topic };
export type IngestionRun = Schema<"IngestionRun">;

const cPath = (workspace: string, contribution: string) => ({ workspace, contribution: resourceId(contribution) });
const tPath = (workspace: string, topic: string) => ({ workspace, topic: resourceId(topic) });

/* ═══════════════ Contributions (review queue) ═══════════════ */

/** Open submissions the caller reviews (ANALYZING + IN_REVIEW), oldest first, with events. */
export function listReviewQueue(workspace: string): Promise<Contribution[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/contributions", {
          params: {
            path: { workspace },
            query: { pageSize: 200, pageToken, view: "FULL", orderBy: "createTime", filter: 'state = "IN_REVIEW" OR state = "ANALYZING"' },
          },
        }),
      ),
    (page) => page.contributions,
  );
}

/** Every contribution the caller can see (All documents history: events, decisions), newest first. */
export function listAllContributions(workspace: string): Promise<Contribution[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/contributions", {
          params: { path: { workspace }, query: { pageSize: 200, pageToken, view: "FULL", orderBy: "updateTime desc" } },
        }),
      ),
    (page) => page.contributions,
  );
}

export type ApproveBody = Schema<"ApproveContributionRequest">;

export function approveContribution(workspace: string, contribution: string, body: ApproveBody): Promise<Contribution> {
  return call(api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:approve", { params: { path: cPath(workspace, contribution) }, body }));
}

export function requestContributionChanges(workspace: string, contribution: string, message: string, etag?: string): Promise<Contribution> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:requestChanges", {
      params: { path: cPath(workspace, contribution) },
      body: { message, etag },
    }),
  );
}

export function rejectContribution(workspace: string, contribution: string, message: string, etag?: string): Promise<Contribution> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:reject", { params: { path: cPath(workspace, contribution) }, body: { message, etag } }),
  );
}

/* ═══════════════ Documents ═══════════════ */

/**
 * Every live document in the caller's shared knowledge bases (FULL view for ancestors).
 * The caller's editor rights decide what comes back: unpublished documents only where
 * they hold `items.update`. Documents in members' "My files" are excluded by the caller.
 */
export function listCuratedItems(workspace: string, { deleted = false }: { deleted?: boolean } = {}): Promise<Item[]> {
  return listAllItems(workspace, { filter: "itemType = DOCUMENT", view: "FULL", orderBy: "updateTime desc", showDeleted: deleted }, 2000);
}

export function mergeItem(workspace: string, item: string, targetItem: string, etag?: string): Promise<Item> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/items/{item}:merge", { params: { path: { workspace, item: resourceId(item) } }, body: { targetItem, etag } }),
  );
}

/** Starts processing documents (publish now, retry, republish). Item names are full names. */
export function createIngestionRun(workspace: string, items: readonly string[]): Promise<IngestionRun> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: { selector: { items: [...items] }, trigger: "MANUAL" },
    }),
  );
}

/* ═══════════════ Topics (taxonomy) ═══════════════ */

/** Domains and topics, every state the caller may see (PROPOSED/REJECTED for `topics.accept` holders); `deleted` adds archived ones. */
export function listAllTopics(workspace: string, { deleted = false }: { deleted?: boolean } = {}): Promise<Topic[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/topics", {
          params: { path: { workspace }, query: { pageSize: 500, pageToken, orderBy: "displayName", showDeleted: deleted } },
        }),
      ),
    (page) => page.topics,
  );
}

export function createTopic(workspace: string, topic: Pick<Topic, "displayName" | "kind" | "parentTopic">): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics", { params: { path: { workspace }, query: { requestId: requestId() } }, body: topic }));
}

export function renameTopic(workspace: string, topic: Topic, displayName: string): Promise<Topic> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/topics/{topic}", {
      params: { path: tPath(workspace, topic.name ?? ""), query: { updateMask: "displayName" } },
      body: { displayName, etag: topic.etag },
    }),
  );
}

/** Soft delete ("Archive"); only when no document or contribution uses it. */
export function deleteTopic(workspace: string, topic: string): Promise<Topic> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/topics/{topic}", { params: { path: tPath(workspace, topic) } }));
}

export function undeleteTopic(workspace: string, topic: string): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:undelete", { params: { path: tPath(workspace, topic) }, body: {} }));
}

/** PROPOSED → ACTIVE under a domain (optionally renamed); tags the contributions that proposed it. */
export function acceptTopic(workspace: string, topic: string, body: { parentTopic?: string; displayName?: string }): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:accept", { params: { path: tPath(workspace, topic) }, body }));
}

/** Folds a proposed topic into an existing one. */
export function mergeTopic(workspace: string, topic: string, targetTopic: string): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:merge", { params: { path: tPath(workspace, topic) }, body: { targetTopic } }));
}

/** Dismisses a proposed topic. */
export function rejectTopic(workspace: string, topic: string): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:reject", { params: { path: tPath(workspace, topic) }, body: {} }));
}

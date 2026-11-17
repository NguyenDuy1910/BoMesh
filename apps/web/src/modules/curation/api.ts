"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";
import { listAllItems, listItems, quote, type Contribution, type Item, type Topic } from "@/modules/knowledge/api";

/**
 * Knowledge Studio (`/studio`): reviewer decisions on contributions, every curated document, processing
 * retries, duplicate merges and the topics (openapi.yaml "Knowledge" + "Ingestion"). Path params are bare
 * IDs; bodies carry full resource names.
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

/* ═══════════════ Processing (ingestion runs) ═══════════════ */

/** What a run processes: explicit documents (full item names, ≤1000) and/or the ListItems document filter. */
export interface RunSelector {
  items?: readonly string[];
  filter?: string;
}

/** What the classify step works with: candidate topics (empty = all) and a note read with each document. */
export interface RunClassification {
  topics?: readonly string[];
  note?: string;
}

/** `workspaces/{workspace}/ingestionRuns/{run}` → path params. */
function runPath(run: string) {
  const [, workspace = "", , ingestionRun = ""] = run.split("/");
  return { workspace, ingestionRun };
}

/**
 * Starts processing documents (one ingestion run over the selection; a run never publishes). `classification`
 * goes along only when given (topics chosen, or a note).
 */
export function createIngestionRun(workspace: string, body: { selector: RunSelector; classification?: RunClassification }): Promise<IngestionRun> {
  const { items, filter } = body.selector;
  const c = body.classification;
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        trigger: "MANUAL",
        selector: { ...(items?.length ? { items: [...items] } : {}), ...(filter ? { filter } : {}) },
        ...(c ? { classification: { ...(c.topics?.length ? { topics: [...c.topics] } : {}), ...(c.note ? { note: c.note } : {}) } } : {}),
      },
    }),
  );
}

/** The workspace's runs in flight (QUEUED or RUNNING), newest first. */
export async function listActiveIngestionRuns(workspace: string): Promise<IngestionRun[]> {
  const r = await call(
    api.GET("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace }, query: { filter: "state = QUEUED OR state = RUNNING", orderBy: "createTime desc", pageSize: 20 } },
    }),
  );
  return r.ingestionRuns ?? [];
}

/** One run by its full name (its counts say how far it is). */
export function getIngestionRun(name: string): Promise<IngestionRun> {
  return call(api.GET("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}", { params: { path: runPath(name) } }));
}

/** Stop: what's done stays processed; queued and running documents go back to Not processed (PENDING). */
export function cancelIngestionRun(run: string): Promise<IngestionRun> {
  return call(api.POST("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}:cancel", { params: { path: runPath(run) }, body: {} }));
}

/** A new run over the run's failed and cancelled documents, with the same classification. */
export function retryIngestionRun(run: string): Promise<IngestionRun> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}:retry", { params: { path: runPath(run), query: { requestId: requestId() } }, body: {} }),
  );
}

/** The topics a collection's documents carry, most used first (the Process dialog's "Use {collection}'s topics"). */
export async function collectionTopicUse(workspace: string, collection: string): Promise<string[]> {
  const page = await listItems(workspace, { filter: `ancestors:${quote(collection)} AND itemType = DOCUMENT`, orderBy: "updateTime desc", pageSize: 500 });
  const n = new Map<string, number>();
  for (const it of page.items ?? []) for (const t of it.document?.topics ?? []) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/* ═══════════════ Topics ═══════════════ */

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

/** What a topic carries; the classification signals (keywords … rules) belong to TOPIC kind only. */
export type TopicFields = Pick<Topic, "displayName" | "description" | "parentTopic" | "keywords" | "synonyms" | "guidance" | "examples" | "rules">;
export type TopicRule = Schema<"TopicRule">;

/** Creates a domain or topic; the server picks its ID (IDs are internal and never shown). */
export function createTopic(workspace: string, topic: Partial<TopicFields> & Pick<Topic, "kind">): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics", { params: { path: { workspace }, query: { requestId: requestId() } }, body: topic }));
}

export type TopicPatch = Partial<TopicFields>;

/** Changes only the fields in `patch` (`updateMask` names them); stale etag → ABORTED. */
export function updateTopic(workspace: string, topic: Topic, patch: TopicPatch): Promise<Topic> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/topics/{topic}", {
      params: { path: tPath(workspace, topic.name ?? ""), query: { updateMask: Object.keys(patch).join(",") } },
      body: { ...patch, etag: topic.etag },
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
export function acceptTopic(workspace: string, topic: string, body: Schema<"AcceptTopicRequest">): Promise<Topic> {
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

/**
 * Confirms the assistant's assignments of `topic` (`document.assistantTopics`) on the documents the ListItems
 * `filter` matches (narrowed server-side to what the caller may edit); returns how many were confirmed.
 */
export async function confirmTopicAssignments(workspace: string, topic: string, filter: string): Promise<number> {
  const r = await call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:confirmAssignments", { params: { path: tPath(workspace, topic) }, body: { filter } }));
  return r.confirmedCount ?? 0;
}

export type TopicImportRow = Schema<"TopicImportRow">;
export type ImportTopicsResult = Schema<"ImportTopicsResponse">;
export type TopicImportChange = Schema<"TopicImportChange">;

/** Imports spreadsheet rows the client parsed (one transaction); `validateOnly` reports the same result and changes nothing. */
export function importTopics(workspace: string, body: { rows: readonly TopicImportRow[]; mode: "MERGE" | "REPLACE"; validateOnly?: boolean }): Promise<ImportTopicsResult> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics:import", { params: { path: { workspace } }, body: { ...body, rows: [...body.rows] } }));
}

export type TestClassificationRequest = Schema<"TestTopicClassificationRequest">;
export type TestClassificationResult = Schema<"TestTopicClassificationResponse">;

/** Classifies a sample like CLASSIFYING does (rules first, else the model), with unsaved topic changes; nothing is stored. */
export function testTopicClassification(workspace: string, body: TestClassificationRequest): Promise<TestClassificationResult> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics:testClassification", { params: { path: { workspace } }, body }));
}

export type ClassificationPrompt = Schema<"CompileTopicClassificationPromptResponse">;

/** The `document_profile` prompt processing sends, built from the current topics, and the rules checked before it. */
export function compileClassificationPrompt(workspace: string): Promise<ClassificationPrompt> {
  return call(api.GET("/api/v1/workspaces/{workspace}/topics:compileClassificationPrompt", { params: { path: { workspace } } }));
}

/* ═══════════════ Topic corrections (what reviewers' topic changes teach) ═══════════════ */

export type TopicCorrection = Schema<"TopicCorrection">;

/** Open corrections, newest first. */
export function listOpenTopicCorrections(workspace: string): Promise<TopicCorrection[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/topicCorrections", {
          params: { path: { workspace }, query: { pageSize: 200, pageToken, filter: 'state = "OPEN"' } },
        }),
      ),
    (page) => page.topicCorrections,
  );
}

/** OPEN → DISMISSED (idempotent). */
export function dismissTopicCorrection(workspace: string, correction: string): Promise<TopicCorrection> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/topicCorrections/{topicCorrection}:dismiss", {
      params: { path: { workspace, topicCorrection: resourceId(correction) } },
      body: {},
    }),
  );
}

/* ═══════════════ Documents for Topics → Suggestions ═══════════════ */

/** Documents carrying topics the assistant applied that no person has set or confirmed (Topics to confirm). */
export function listAssistantTaggedDocuments(workspace: string): Promise<Item[]> {
  return listAllItems(workspace, { filter: "itemType = DOCUMENT AND document.assistantTopics:*", view: "FULL", orderBy: "updateTime desc" }, 2000);
}

/** How many documents carry `topic` as the assistant applied it, unconfirmed (a topic's Distribution). */
export async function countAssistantTagged(workspace: string, topic: string): Promise<number> {
  const page = await listItems(workspace, { filter: `itemType = DOCUMENT AND document.assistantTopics:${quote(topic)}`, pageSize: 1, view: "BASIC" });
  return page.totalSize ?? 0;
}

/** The last successful ImportTopics in the audit log: who imported the topics and when (Topics' summary line). */
export async function lastTopicImport(workspace: string): Promise<Schema<"AuditEvent"> | null> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/auditEvents", {
      params: { path: { workspace }, query: { pageSize: 1, filter: 'action = "ImportTopics" AND outcome = "SUCCEEDED"', orderBy: "createTime desc" } },
    }),
  );
  return page.auditEvents?.[0] ?? null;
}

/** Processed documents without any topic (Without a topic). */
export function listDocumentsWithoutTopic(workspace: string): Promise<Item[]> {
  return listAllItems(workspace, { filter: "itemType = DOCUMENT AND document.indexingState = SUCCEEDED AND NOT document.topics:*", view: "FULL", orderBy: "updateTime desc" }, 2000);
}

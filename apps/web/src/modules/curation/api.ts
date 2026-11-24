"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";
import { listItems, quote, searchItems, type Contribution, type Item, type ItemView, type Topic } from "@/modules/knowledge/api";

import { contributionsOf } from "./docFilter";

/**
 * Knowledge Studio (`/studio`): reviewer decisions on contributions, server-paged queues and counts, processing
 * runs and the topics (openapi.yaml "Knowledge" + "Ingestion"). Path params are bare IDs; bodies carry full
 * resource names.
 */

export type { Contribution, Item, Topic };
export type IngestionRun = Schema<"IngestionRun">;
export type IngestionTask = Schema<"IngestionTask">;

const cPath = (workspace: string, contribution: string) => ({ workspace, contribution: resourceId(contribution) });
const tPath = (workspace: string, topic: string) => ({ workspace, topic: resourceId(topic) });

/* ═══════════════ Contributions (review queue) ═══════════════ */

export type ApproveBody = Schema<"ApproveContributionRequest">;

/** `keepalive`: the request outlives the page (a held decision, `../decisions.ts`, sent while the person reloads or leaves). */
export interface DecisionInit {
  keepalive?: boolean;
}

export function approveContribution(workspace: string, contribution: string, body: ApproveBody, { keepalive }: DecisionInit = {}): Promise<Contribution> {
  return call(api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:approve", { params: { path: cPath(workspace, contribution) }, body, keepalive }));
}

export function requestContributionChanges(workspace: string, contribution: string, message: string, etag?: string, { keepalive }: DecisionInit = {}): Promise<Contribution> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:requestChanges", {
      params: { path: cPath(workspace, contribution) },
      body: { message, etag },
      keepalive,
    }),
  );
}

export function rejectContribution(workspace: string, contribution: string, message: string, etag?: string, { keepalive }: DecisionInit = {}): Promise<Contribution> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/contributions/{contribution}:reject", {
      params: { path: cPath(workspace, contribution) },
      body: { message, etag },
      keepalive,
    }),
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
export function createIngestionRun(workspace: string, body: { selector: RunSelector; classification?: RunClassification; readImages?: boolean }): Promise<IngestionRun> {
  const { items, filter } = body.selector;
  const c = body.classification;
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: {
        trigger: "MANUAL",
        selector: { ...(items?.length ? { items: [...items] } : {}), ...(filter ? { filter } : {}) },
        ...(c ? { classification: { ...(c.topics?.length ? { topics: [...c.topics] } : {}), ...(c.note ? { note: c.note } : {}) } } : {}),
        ...(body.readImages ? { readImages: true } : {}),
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

/** One page of a run's tasks (one per document; task ID = item ID): `filter` (AIP-160 on `state`, `errorClass`, `name`, `createTime`). */
export function listRunTasksPage(run: string, { filter, orderBy, pageSize, pageToken }: { filter?: string; orderBy?: string; pageSize: number; pageToken?: string }) {
  return call(
    api.GET("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}/tasks", {
      params: { path: runPath(run), query: { pageSize, pageToken, ...(filter ? { filter } : {}), ...(orderBy ? { orderBy } : {}) } },
    }),
  );
}

/** The tasks of these items in a run, in one batch read (`name = "{run}/tasks/{item}" OR …`); items not in the run are absent. */
export async function batchGetRunTasks(run: string, items: readonly string[]): Promise<IngestionTask[]> {
  if (!items.length) return [];
  const filter = items.map((item) => `name = ${JSON.stringify(`${run}/tasks/${resourceId(item)}`)}`).join(" OR ");
  return (await listRunTasksPage(run, { filter, pageSize: items.length })).tasks ?? [];
}

/** One document's task in a run (its latest run: `document.lastIngestionRun`). */
export function getRunTask(run: string, item: string): Promise<IngestionTask> {
  return call(api.GET("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}/tasks/{task}", { params: { path: { ...runPath(run), task: resourceId(item) } } }));
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
  // One SearchItems read of the `document.topics` facet over the collection's documents (a DOMAIN also counts its topics).
  const res = await searchItems(workspace, { filter: `ancestors:${quote(collection)}`, facetSpecs: [{ field: "document.topics", limit: TOPIC_FACET_LIMIT, excludedFromFilter: false }], pageSize: 1 });
  const values = res.facets?.find((f) => f.field === "document.topics")?.values ?? [];
  return [...values].sort((a, b) => Number(b.documentCount ?? 0) - Number(a.documentCount ?? 0)).map((v) => v.value ?? "");
}

/** Above the topic taxonomy's size: every topic a collection's documents carry. */
const TOPIC_FACET_LIMIT = 1000;

/* ═══════════════ Topics ═══════════════ */

/**
 * Domains and topics, every state the caller may see (PROPOSED/REJECTED for `topics.accept` holders); `deleted` adds
 * archived ones. FULL view: the Studio editor reads the signals (keywords … rules), proposals' evidence and review counts.
 */
export function listAllTopics(workspace: string, { deleted = false }: { deleted?: boolean } = {}): Promise<Topic[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/topics", {
          params: { path: { workspace }, query: { pageSize: 500, pageToken, orderBy: "displayName", showDeleted: deleted, view: "FULL" } },
        }),
      ),
    (page) => page.topics,
  );
}

/** What a topic carries; the classification signals (keywords … rules) belong to TOPIC kind only. */
export type TopicFields = Pick<Topic, "displayName" | "description" | "parentTopic" | "icon" | "color" | "keywords" | "synonyms" | "guidance" | "examples" | "rules">;
export type TopicRule = Schema<"TopicRule">;

/** Creates a domain or topic; the server picks its ID (IDs are internal and never shown). */
export function createTopic(workspace: string, topic: Partial<TopicFields> & Pick<Topic, "kind">): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics", { params: { path: { workspace }, query: { requestId: requestId() } }, body: topic }));
}

export type TopicPatch = Partial<TopicFields>;

/** Changes only the fields in `patch` (`updateMask` names them); stale etag → ABORTED. */
export function updateTopic(workspace: string, topic: Topic, patch: TopicPatch, { keepalive }: DecisionInit = {}): Promise<Topic> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/topics/{topic}", {
      params: { path: tPath(workspace, topic.name ?? ""), query: { updateMask: Object.keys(patch).join(",") } },
      body: { ...patch, etag: topic.etag },
      keepalive,
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
export function acceptTopic(workspace: string, topic: string, body: Schema<"AcceptTopicRequest">, { keepalive }: DecisionInit = {}): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:accept", { params: { path: tPath(workspace, topic) }, body, keepalive }));
}

/** Folds a proposed topic into an existing one. */
export function mergeTopic(workspace: string, topic: string, targetTopic: string, { keepalive }: DecisionInit = {}): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:merge", { params: { path: tPath(workspace, topic) }, body: { targetTopic }, keepalive }));
}

/** Dismisses a proposed topic. */
export function rejectTopic(workspace: string, topic: string, { keepalive }: DecisionInit = {}): Promise<Topic> {
  return call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:reject", { params: { path: tPath(workspace, topic) }, body: {}, keepalive }));
}

/**
 * Confirms the assistant's assignments of `topic` (`document.assistantTopics`) on the documents the ListItems
 * `filter` matches (narrowed server-side to what the caller may edit); returns how many were confirmed.
 */
export async function confirmTopicAssignments(workspace: string, topic: string, filter: string, { keepalive }: DecisionInit = {}): Promise<number> {
  const r = await call(api.POST("/api/v1/workspaces/{workspace}/topics/{topic}:confirmAssignments", { params: { path: tPath(workspace, topic) }, body: { filter }, keepalive }));
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

/** The newest open corrections (one page): Suggestions learns keywords from what reviewers corrected recently. */
export async function listOpenTopicCorrections(workspace: string): Promise<TopicCorrection[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/topicCorrections", {
      params: { path: { workspace }, query: { pageSize: CORRECTIONS_PAGE, filter: 'state = "OPEN"', orderBy: "createTime desc" } },
    }),
  );
  return page.topicCorrections ?? [];
}

/** Recent open corrections Suggestions reads, newest first. */
const CORRECTIONS_PAGE = 200;

/** OPEN → DISMISSED (idempotent). */
export function dismissTopicCorrection(workspace: string, correction: string, { keepalive }: DecisionInit = {}): Promise<TopicCorrection> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/topicCorrections/{topicCorrection}:dismiss", {
      params: { path: { workspace, topicCorrection: resourceId(correction) } },
      body: {},
      keepalive,
    }),
  );
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

/* ═══════════════ Paged reads (Studio queues and counts: one page of ≤ 50 or `pageSize=1`, never a whole collection) ═══════════════ */

/** One page of contributions (ListContributions). */
export function listContributionsPage(
  workspace: string,
  query: { filter: string; orderBy?: string; view?: ItemView; pageSize: number; pageToken?: string },
): Promise<Schema<"ListContributionsResponse">> {
  return call(api.GET("/api/v1/workspaces/{workspace}/contributions", { params: { path: { workspace }, query: { ...query, pageToken: query.pageToken || undefined } } }));
}

/** How many contributions match `filter` (`pageSize=1` → `totalSize`). */
export async function countContributions(workspace: string, filter: string): Promise<number> {
  return (await listContributionsPage(workspace, { filter, pageSize: 1 })).totalSize ?? 0;
}

/** How many items match `filter` (`pageSize=1` → `totalSize`). */
export async function countItems(workspace: string, filter: string): Promise<number> {
  return (await listItems(workspace, { filter, pageSize: 1, view: "BASIC" })).totalSize ?? 0;
}

/**
 * The latest contribution about each of a page of documents (by item name; `item = … OR …`, newest first): one page of
 * at most 50, so an item's latest is missed only behind 50 newer ones of the same page.
 */
export async function pageContributionsOf(workspace: string, items: readonly string[]): Promise<Map<string, Contribution>> {
  const names = [...new Set(items.filter(Boolean))];
  const latest = new Map<string, Contribution>();
  if (!names.length) return latest;
  const page = await listContributionsPage(workspace, { filter: contributionsOf(names), orderBy: "updateTime desc", view: "FULL", pageSize: Math.min(50, names.length * 2) });
  for (const c of page.contributions ?? []) if (c.item && !latest.has(c.item)) latest.set(c.item, c);
  return latest;
}

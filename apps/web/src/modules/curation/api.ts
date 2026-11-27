"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";
import { listItems, quote, searchItems, type Contribution, type Item, type ItemView } from "@/modules/knowledge/api";

import { contributionsOf } from "./docFilter";

/**
 * Knowledge Studio (`/studio`): reviewer decisions on contributions, server-paged queues and counts and processing
 * runs (openapi.yaml "Knowledge" + "Ingestion"); the taxonomy's admin calls are `taxonomyApi.ts`. Path params are bare
 * IDs; bodies carry full resource names.
 */

export type { Contribution, Item };
export type IngestionRun = Schema<"IngestionRun">;
export type IngestionTask = Schema<"IngestionTask">;

const cPath = (workspace: string, contribution: string) => ({ workspace, contribution: resourceId(contribution) });

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

/** What the classify step works with: candidate concepts (with the concepts under them; empty = every published one)
 *  and a note read with each document. */
export interface RunClassification {
  concepts?: readonly string[];
  note?: string;
}

/** `workspaces/{workspace}/ingestionRuns/{run}` → path params. */
function runPath(run: string) {
  const [, workspace = "", , ingestionRun = ""] = run.split("/");
  return { workspace, ingestionRun };
}

/**
 * Starts processing documents (one ingestion run over the selection; a run never publishes). `classification`
 * goes along only when given (concepts chosen, or a note).
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
        ...(c ? { classification: { ...(c.concepts?.length ? { concepts: [...c.concepts] } : {}), ...(c.note ? { note: c.note } : {}) } } : {}),
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

/** The concepts a collection's documents are filed under, most used first (the Process dialog's “Dùng khái niệm của
 *  {collection}”): one SearchItems read of the `document.concepts` facet (a broader concept also counts what's under it). */
export async function collectionConceptUse(workspace: string, collection: string): Promise<string[]> {
  const res = await searchItems(workspace, { filter: `ancestors:${quote(collection)}`, facetSpecs: [{ field: "document.concepts", limit: CONCEPT_FACET_LIMIT, excludedFromFilter: false }], pageSize: 1 });
  const values = res.facets?.find((f) => f.field === "document.concepts")?.values ?? [];
  return [...values].sort((a, b) => Number(b.documentCount ?? 0) - Number(a.documentCount ?? 0)).map((v) => v.value ?? "");
}

/** Above any taxonomy's size: every concept a collection's documents carry. */
const CONCEPT_FACET_LIMIT = 1000;

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

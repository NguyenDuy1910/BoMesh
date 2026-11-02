"use client";

import { apiRequest, queryString } from "@/lib/api/request";

/**
 * Ingestion Runs: the only way Documents get processed.
 *
 * Adding data registers pending Documents; a run takes a snapshot of the
 * Documents its selection names and processes them (parse, contextualize,
 * chunk, embed, index). Types mirror the API DTOs in
 * `backend/api/routers/__init__.py` one for one.
 */

/** Where a Document stands in processing (`DocumentProcessing.state`). */
export type ProcessingState =
  | "pending"
  | "processing"
  | "ready"
  | "failed"
  | "outdated"
  | "unsupported";

/** States a run may select Documents by. */
export type RunSelectableState = "pending" | "failed" | "outdated" | "ready";

export type IngestionRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type IngestionRunItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type IngestionRunTrigger = "manual" | "scheduled" | "api";

/** A Document's processing summary (`Document.processing`). */
export interface DocumentProcessing {
  state: ProcessingState;
  /** Why the latest run could not process it, written for people. */
  error: string | null;
  /** The latest run that included this Document. */
  run_id: string | null;
}

/**
 * What to process. Selectors narrow each other; at least one is required.
 * Without `document_ids`, `states` defaults to pending and outdated.
 */
export interface IngestionRunCreate {
  document_ids?: string[];
  collection_id?: string;
  source_id?: string;
  states?: RunSelectableState[];
  /** `manual` from a BoMesh client. */
  trigger: "manual" | "api";
}

export interface IngestionRunScope {
  selected_documents: number | null;
  collection_id: string | null;
  source_id: string | null;
  states: RunSelectableState[];
  retry_of_run_id: string | null;
}

export interface IngestionRunCounts {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

export interface IngestionRunActor {
  id: string;
  email: string | null;
  display_name: string | null;
}

export interface IngestionRun {
  id: string;
  status: IngestionRunStatus;
  trigger: IngestionRunTrigger;
  scope: IngestionRunScope;
  counts: IngestionRunCounts;
  /** Why the run as a whole stopped, written for people. */
  error: string | null;
  created_by: IngestionRunActor | null;
  /** Processing configuration fixed at creation (models, versions, batching). */
  configuration: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface IngestionRunPage {
  items: IngestionRun[];
  page: number;
  page_size: number;
  total: number;
}

export type IngestionRunPhaseName =
  | "parsing"
  | "contextualizing"
  | "embedding"
  | "storing"
  | "downloading"
  | "expanding";

export interface IngestionRunPhase {
  phase: IngestionRunPhaseName;
  started_at: string | null;
  finished_at: string | null;
  done: number;
  total: number;
}

export interface IngestionRunItem {
  document_id: string;
  name: string;
  collection_id: string | null;
  status: IngestionRunItemStatus;
  /** The phase it is in, or ended in. */
  phase: string | null;
  error: string | null;
  chunk_count: number | null;
  phases: IngestionRunPhase[];
  started_at: string | null;
  finished_at: string | null;
}

export interface IngestionRunItemPage {
  items: IngestionRunItem[];
  page: number;
  page_size: number;
  total: number;
}

export interface IngestionRunListParams {
  page?: number;
  page_size?: number;
  status?: IngestionRunStatus;
  source_id?: string;
  collection_id?: string;
}

export interface IngestionRunItemListParams {
  page?: number;
  page_size?: number;
  status?: IngestionRunItemStatus;
}

/** A run still has work ahead of it. */
export function isRunActive(run: Pick<IngestionRun, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

const runPath = (id: string) => `/ingestion-runs/${encodeURIComponent(id)}`;

export const ingestionRunsApi = {
  /** Snapshots the selected Documents and starts processing them (202). */
  create: (body: IngestionRunCreate) =>
    apiRequest<IngestionRun>("/ingestion-runs", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Newest first. Reads take an optional signal so a poll can abandon them. */
  list: (params: IngestionRunListParams = {}, signal?: AbortSignal) =>
    apiRequest<IngestionRunPage>(`/ingestion-runs${queryString({ ...params })}`, { signal }),

  get: (id: string, signal?: AbortSignal) => apiRequest<IngestionRun>(runPath(id), { signal }),

  /** Running, failed and queued items first, then the rest by name. */
  items: (id: string, params: IngestionRunItemListParams = {}, signal?: AbortSignal) =>
    apiRequest<IngestionRunItemPage>(`${runPath(id)}/items${queryString({ ...params })}`, { signal }),

  cancel: (id: string) =>
    apiRequest<IngestionRun>(`${runPath(id)}/cancel`, { method: "POST" }),

  /** Starts a NEW run over this run's failed, cancelled and skipped items. */
  retry: (id: string) =>
    apiRequest<IngestionRun>(`${runPath(id)}/retry`, { method: "POST" }),
};

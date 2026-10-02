"use client";

import { apiRequest, queryString } from "@/lib/api/request";

/**
 * Ingestions: every time the pipeline takes something in.
 *
 * One resource covers both an uploaded document being parsed and indexed and a
 * connected source being synced, because an operator asks the same questions
 * of either — is it moving, where is it, and if it stopped, why. The shapes
 * below are the backend contract verbatim; wording for people lives in
 * `ingestion-state.ts`.
 */

export type IngestionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type IngestionPhase =
  | "queued"
  | "downloading"
  | "parsing"
  | "contextualizing"
  | "embedding"
  | "storing"
  | "expanding"
  | "syncing"
  | "completed"
  | "failed"
  | "cancelled";

export type IngestionKind = "document" | "source";

export interface IngestionProgress {
  phase: IngestionPhase;
  /** Documents: chunks found. Archives: files accepted. Sources: items discovered. */
  discovered_count: number;
  /** Documents: chunks embedded. Archives: files stored. Sources: items processed. */
  processed_count: number;
  indexed_count: number;
  deleted_count: number;
  failed_count: number;
}

export interface Ingestion {
  id: string;
  kind: IngestionKind;
  /**
   * `managed`: a workspace ingestion the Activity tab tracks. `direct`: a
   * person's own upload, processed on arrival and not listed there.
   */
  mode: "managed" | "direct";
  /** The file name for a document, the source's display name for a sync. */
  title: string | null;
  document_id: string | null;
  collection_id: string | null;
  source_id: string | null;
  connection_id: string | null;
  connector_key: string | null;
  status: IngestionStatus;
  trigger_type: "manual" | "scheduled" | "webhook" | "initial" | "upload" | "retry";
  retry_of_ingestion_id: string | null;
  /** Current or last attempt, from 1. */
  attempt: number;
  /** A reason written for people, set when it failed or timed out. */
  error: string | null;
  progress: IngestionProgress | null;
  started_at: string | null;
  finished_at: string | null;
  /** Finished minus started, or the time elapsed so far while it runs. */
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export type IngestionEventType =
  | "queued"
  | "started"
  | "phase"
  | "retrying"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface IngestionEvent {
  id: string;
  type: IngestionEventType;
  at: string;
  attempt: number | null;
  /** Set when `type` is `phase`. */
  phase: IngestionPhase | null;
  message: string | null;
  /** How long a finished phase took. */
  duration_ms: number | null;
}

export type IngestionWindow = "1h" | "24h" | "7d";

export interface IngestionBucket {
  start: string;
  started: number;
  completed: number;
  /** Includes timed out and cancelled. */
  failed: number;
}

export interface IngestionSummary {
  window: IngestionWindow;
  generated_at: string;
  bucket_seconds: number;
  /** Ingestions started inside the window, by where they are now. */
  totals: Record<IngestionStatus, number>;
  by_kind: { document: number; source: number };
  buckets: IngestionBucket[];
  /** Finished ingestions only; null when none finished in the window. */
  duration_ms: { p50: number; p95: number; max: number } | null;
  /** Pending plus running, right now. */
  active: number;
}

export interface IngestionPage {
  items: Ingestion[];
  page: number;
  page_size: number;
  total: number;
}

export interface IngestionListParams {
  kind?: IngestionKind;
  status?: IngestionStatus;
  collection_id?: string;
  document_id?: string;
  source_id?: string;
  connection_id?: string;
  page?: number;
  /** At most 100. */
  page_size?: number;
}

const path = (id: string) => `/ingestions/${encodeURIComponent(id)}`;

export const ingestionsApi = {
  /** Newest first. */
  list: (params: IngestionListParams = {}, signal?: AbortSignal) =>
    apiRequest<IngestionPage>(`/ingestions${queryString({ ...params })}`, { signal }),

  summary: (window: IngestionWindow, signal?: AbortSignal) =>
    apiRequest<IngestionSummary>(`/ingestions/summary${queryString({ window })}`, { signal }),

  get: (id: string, signal?: AbortSignal) => apiRequest<Ingestion>(path(id), { signal }),

  /** Oldest first. */
  events: (id: string, signal?: AbortSignal) =>
    apiRequest<{ items: IngestionEvent[] }>(`${path(id)}/events`, { signal }),

  /** Only for failed, cancelled or timed out ingestions; anything else is a 409. */
  retry: (id: string) => apiRequest<Ingestion>(`${path(id)}/retry`, { method: "POST" }),

  /** Only for pending or running ingestions; anything else is a 409. */
  cancel: (id: string) => apiRequest<Ingestion>(`${path(id)}/cancel`, { method: "POST" }),
};

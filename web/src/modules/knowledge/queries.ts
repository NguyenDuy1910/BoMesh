"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { getApiConfiguration } from "@/lib/api/config";
import { apiRequest } from "@/lib/api/request";
import { apiRevision, invalidateApiData, subscribeApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { afterVisibleDelay } from "@/lib/hooks/usePolling";
import {
  ingestionRunsApi,
  type IngestionRun,
  type IngestionRunCreate,
} from "@/modules/ingestion/runs-api";
import { uploadCollectionFile } from "@/modules/workspace-control/control-plane-api";
import { knowledgeApi, type DocumentCreateResult } from "@/modules/knowledge/knowledge-api";
import { toWorkspaceCollection, toWorkspaceDocument } from "@/modules/knowledge/view-model";
import type {
  WorkspaceKnowledgeCollection,
  WorkspaceKnowledgeDocument,
} from "@/modules/knowledge/workspace-repository";

/** How long after an answer a view under way is read again. */
const REFRESH_MS = 3000;

/**
 * Everything the Knowledge screen reads: the Collections the caller may
 * browse, and the Documents inside each.
 *
 * `processing` says whether a run is at work somewhere; while it is, or while
 * any document listed is still processing, the list is read again a few
 * seconds after each answer so states move without a reload. Nothing else
 * polls — an upload only registers pending documents.
 */
export function useKnowledge(processing: boolean) {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const query = useApiQuery<KnowledgeSnapshot>(async () => {
    const home = await knowledgeApi.home();
    const collections = home.collections;
    // Documents live inside Collections, so the workspace view is the union of
    // what each readable Collection holds.
    const pages = await Promise.all(
      collections.map((collection) =>
        knowledgeApi
          .collection(collection.id)
          .then((page) => page.documents.map((document) => toWorkspaceDocument(document, collection.title)))
          .catch(() => []),
      ),
    );
    return {
      documentCount: collections.reduce((total, collection) => total + collection.document_count, 0),
      collections: collections.map(toWorkspaceCollection),
      documents: pages.flat(),
      personalCollectionId: home.personal_collection_id,
    };
  }, revision);

  const { data, reload } = query;
  useRefreshWhile(
    processing || (data?.documents.some((document) => document.state === "processing") ?? false),
    data,
    reload,
  );
  return query;
}

export interface KnowledgeSnapshot {
  documentCount: number;
  collections: WorkspaceKnowledgeCollection[];
  documents: WorkspaceKnowledgeDocument[];
  personalCollectionId: string | null;
}

/**
 * Read again `REFRESH_MS` after each answer while `active`, and once more when
 * it stops: the read that saw the last work finish may predate the result.
 * Re-arming on every new answer, rather than on an interval, means a slow
 * read is never overlapped by the next one.
 */
export function useRefreshWhile(active: boolean, data: unknown, reload: () => void) {
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return afterVisibleDelay(REFRESH_MS, reload);
    }
    if (wasActive.current) {
      wasActive.current = false;
      reload();
    }
  }, [active, data, reload]);
}

const ACTIVE_RUN_STATUSES = ["running", "queued"] as const;

/**
 * The Ingestion Runs still at work, running first, as the caller may see them.
 *
 * Best-effort: a caller who cannot read runs simply sees none, which only
 * hides the progress line — it never blocks the documents.
 */
export function useActiveRuns(): IngestionRun[] {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const query = useApiQuery<IngestionRun[]>(async () => {
    if (!getApiConfiguration()) return [];
    const pages = await Promise.all(
      ACTIVE_RUN_STATUSES.map((status) =>
        ingestionRunsApi.list({ status, page_size: 20 }).catch(() => ({ items: [] as IngestionRun[] })),
      ),
    );
    return pages.flatMap((page) => page.items);
  }, revision);
  const runs = query.data ?? [];
  useRefreshWhile(runs.length > 0, query.data, query.reload);
  return runs;
}

/** What an upload of several files did, file by file. */
export interface UploadOutcome {
  /** The Documents registered, pending, in upload order. */
  documents: { id: string; name: string }[];
  /** The files that were refused, with the reason the API gave. */
  failures: { name: string; reason: string }[];
}

/**
 * Writes the Knowledge and Library screens perform.
 *
 * Each one goes to the endpoint that owns that lifecycle and then invalidates,
 * so the list a person is looking at reflects what the server now holds rather
 * than what the click optimistically assumed.
 */
export const knowledgeActions = {
  async createCollection(title: string, description?: string) {
    const collection = await knowledgeApi.createCollection(title, description);
    invalidateApiData();
    return collection;
  },
  /**
   * Store files in a Collection as pending Documents. Nothing is processed: a
   * run does that, when someone asks for one. One refused file does not stop
   * the others.
   */
  async upload(files: File[], collectionId: string): Promise<UploadOutcome> {
    const results = await Promise.allSettled(
      files.map((file) =>
        uploadCollectionFile<DocumentCreateResult>(collectionId, file, { idempotencyKey: crypto.randomUUID() }),
      ),
    );
    const outcome: UploadOutcome = { documents: [], failures: [] };
    results.forEach((result, index) => {
      const name = files[index].name;
      if (result.status === "fulfilled") outcome.documents.push({ id: result.value.document.id, name });
      else outcome.failures.push({ name, reason: result.reason instanceof Error ? result.reason.message : "Upload failed." });
    });
    if (outcome.documents.length) invalidateApiData();
    return outcome;
  },
  /** Start one Ingestion Run over a selection. */
  async process(body: IngestionRunCreate) {
    const run = await ingestionRunsApi.create(body);
    invalidateApiData();
    return run;
  },
  async remove(documentId: string) {
    await apiRequest(`/documents/${documentId}`, { method: "DELETE" });
    invalidateApiData();
  },
};

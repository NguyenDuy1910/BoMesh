"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getApiConfiguration } from "@/lib/api/config";
import { apiRequest } from "@/lib/api/request";
import { apiRevision, invalidateApiData, subscribeApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { afterVisibleDelay, usePolling } from "@/lib/hooks/usePolling";
import { uploadCollectionFile } from "@/modules/workspace-control/control-plane-api";
import { knowledgeApi } from "@/modules/knowledge/knowledge-api";
import {
  lastActivityLabel,
  toWorkspaceCollection,
  toWorkspaceDocument,
} from "@/modules/knowledge/view-model";
import type {
  WorkspaceKnowledgeCollection,
  WorkspaceKnowledgeDocument,
} from "@/modules/knowledge/workspace-repository";
import {
  describeConnector,
  knowledgeConnectors,
  type KnowledgeConnector,
} from "@/modules/knowledge/connectors";
import {
  connectionsApi,
  sourcesApi,
  type Connection,
  type ConnectorCapability,
  type Source,
} from "@/modules/knowledge/integrations-api";
import {
  ingestionsApi,
  type Ingestion,
  type IngestionEvent,
  type IngestionSummary,
  type IngestionWindow,
} from "@/modules/knowledge/ingestions-api";
import { canRetryIndexing } from "@/modules/knowledge/document-facts";
import { ACTIVE_STATUSES, isActive } from "@/modules/knowledge/ingestion-state";

/**
 * Everything the Knowledge shell reads.
 *
 * The workspace home lists the Collections the caller may browse; each is then
 * read for the Documents inside it. They are separate loads from connections
 * and sync activity because connecting an account must refresh the sources
 * list without re-reading every document.
 */
export function useKnowledge() {
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
      lastSyncLabel: lastActivityLabel(collections),
      collections: collections.map(toWorkspaceCollection),
      documents: pages.flat(),
      personalCollectionId: home.personal_collection_id,
    };
  }, revision);

  // While anything listed is still indexing, read again a few seconds after
  // each answer arrives, so "Indexing" becomes "Indexed" without a reload.
  // Re-arming on every new snapshot, rather than on an interval, means a slow
  // read is never overlapped by the next one.
  const { data, reload } = query;
  const indexing = data?.documents.some((document) => document.state === "indexing") ?? false;
  useEffect(() => {
    if (!indexing) return;
    return afterVisibleDelay(3000, reload);
  }, [data, indexing, reload]);

  return query;
}

export interface KnowledgeSnapshot {
  documentCount: number;
  lastSyncLabel: string;
  collections: WorkspaceKnowledgeCollection[];
  documents: WorkspaceKnowledgeDocument[];
  personalCollectionId: string | null;
}

/**
 * Writes the Knowledge screen performs.
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
  async upload(file: File, collectionId: string) {
    await uploadCollectionFile(collectionId, file, { idempotencyKey: crypto.randomUUID() });
    invalidateApiData();
  },
  /**
   * Index again the documents whose last indexing failed.
   *
   * Only a failed document with an ingestion behind it can be retried; the rest
   * of a selection is left alone rather than rejected, and the count retried is
   * returned so the caller can say what actually happened.
   */
  async retryIndexing(documents: WorkspaceKnowledgeDocument[]) {
    const retryable = documents.filter(canRetryIndexing);
    await Promise.all(retryable.map((document) => ingestionsApi.retry(document.latestIngestion!.id)));
    if (retryable.length) invalidateApiData();
    return retryable.length;
  },
  /**
   * Index documents again from their stored content, whatever their last
   * indexing did. Every document is sent and the backend decides: it refuses
   * one already indexing, or one a connector wrote, with its own reason. One
   * refusal does not stop the rest; the reasons are returned, counted.
   */
  async reindex(documents: WorkspaceKnowledgeDocument[]) {
    const results = await Promise.allSettled(documents.map((document) => knowledgeApi.reindex(document.id)));
    const refused = new Map<string, number>();
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      const reason = result.reason instanceof Error ? result.reason.message : "The request failed";
      refused.set(reason, (refused.get(reason) ?? 0) + 1);
    }
    const started = documents.length - [...refused.values()].reduce((total, count) => total + count, 0);
    if (started) invalidateApiData();
    return { started, refused };
  },
  async retryIngestion(id: string) {
    const next = await ingestionsApi.retry(id);
    invalidateApiData();
    return next;
  },
  async cancelIngestion(id: string) {
    const next = await ingestionsApi.cancel(id);
    invalidateApiData();
    return next;
  },
  async remove(documentId: string) {
    await apiRequest(`/documents/${documentId}`, { method: "DELETE" });
    invalidateApiData();
  },
};

/**
 * What this deployment can actually connect.
 *
 * The catalogue in `connectors.ts` only describes; the backend's registry
 * decides. Each entry carries the registry's own record beside the
 * description, because whether a connector is authorized by OAuth, takes an
 * API token, or is unavailable here are all facts about this deployment.
 */
export interface ConnectorEntry {
  connector: KnowledgeConnector;
  capability?: ConnectorCapability;
}

export function useConnectorCatalogue() {
  return useApiQuery<ConnectorEntry[]>(async () => {
    if (!getApiConfiguration()) {
      return knowledgeConnectors.map((connector) => ({ connector }));
    }
    const { items } = await connectionsApi.providers();
    // A response that is not the documented `{items}` shape is a broken deployment, not
    // a deployment with no connectors — and the reader gets a sentence rather
    // than whatever a property access on `undefined` happens to throw.
    if (!Array.isArray(items)) {
      throw new Error("The connector registry returned an unexpected response.");
    }
    return items.map((capability) => ({
      connector: describeConnector(capability.connector_key, capability.display_name),
      capability,
    }));
  });
}

export interface ConnectionsSnapshot {
  connections: Connection[];
  sources: Source[];
  /** Source syncs only, newest first. The Activity tab reads its own live feed. */
  runs: Ingestion[];
  /** False in the design preview, where there is no registry to connect against. */
  live: boolean;
}

/**
 * Connected accounts, what they synchronize, and how those syncs went.
 *
 * One load, because the three are read together everywhere: a source is shown
 * with the account behind it, and an account is shown with how much depends on
 * it. Sync history is best-effort — it being unavailable should not empty the
 * list of connections.
 */
export function useConnections() {
  return useApiQuery<ConnectionsSnapshot>(async () => {
    if (!getApiConfiguration()) {
      return { connections: [], sources: [], runs: [], live: false };
    }
    const [connections, sources] = await Promise.all([
      connectionsApi.list(),
      sourcesApi.list(),
    ]);
    const runs = await ingestionsApi
      .list({ kind: "source", page_size: 50 })
      .catch(() => ({ items: [] as Ingestion[] }));
    return {
      connections: connections.items,
      sources: sources.items,
      runs: runs.items,
      live: true,
    };
  });
}

export interface LiveIngestions {
  /** Newest first. */
  items: Ingestion[];
  /** Everything the caller may see, beyond the page that was read. */
  total: number;
  summary: IngestionSummary | null;
  /** When the last answer arrived, on this machine's clock. */
  receivedAt: number;
  error: string | null;
  refresh: () => void;
}

const LIVE_PAGE = 100;

/**
 * The ingestion feed and its charts, kept current.
 *
 * Every 2 seconds while anything is queued or running, every 15 while the
 * pipeline is idle, and not at all while the tab is hidden. The newest page is
 * normally enough to hold everything in flight; when the summary counts more
 * active work than that page shows, the active ones are read directly, so a
 * lane is never missing because a burst of newer uploads pushed it off page 1.
 */
export function useLiveIngestions(range: IngestionWindow): LiveIngestions {
  const [state, setState] = useState<Omit<LiveIngestions, "error" | "refresh"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = usePolling(
    async (signal) => {
      try {
        const [page, summary] = await Promise.all([
          ingestionsApi.list({ page_size: LIVE_PAGE }, signal),
          ingestionsApi.summary(range, signal),
        ]);
        const byId = new Map(page.items.map((item) => [item.id, item]));
        const listedActive = page.items.filter(isActive).length;
        if (summary.active > listedActive && page.total > page.items.length) {
          const pages = await Promise.all(
            ACTIVE_STATUSES.map((status) => ingestionsApi.list({ status, page_size: LIVE_PAGE }, signal)),
          );
          for (const item of pages.flatMap((extra) => extra.items)) {
            if (!byId.has(item.id)) byId.set(item.id, item);
          }
        }
        if (signal.aborted) return;
        const items = [...byId.values()];
        busy.current = summary.active > 0 || items.some(isActive);
        setState({ items, total: page.total, summary, receivedAt: Date.now() });
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Activity could not be loaded.");
      }
    },
    () => (busy.current ? 2000 : 15000),
    range,
  );

  return {
    items: state?.items ?? [],
    total: state?.total ?? 0,
    summary: state?.summary ?? null,
    receivedAt: state?.receivedAt ?? 0,
    error,
    refresh,
  };
}

export interface IngestionDetail {
  ingestion: Ingestion | null;
  events: IngestionEvent[];
  receivedAt: number;
  error: string | null;
  refresh: () => void;
}

/**
 * One ingestion and its timeline, re-read every 1.5 seconds while it is
 * queued or running and left alone once it has finished. Mount it under a
 * `key` of the ingestion id so switching ingestions starts from empty.
 */
export function useIngestionDetail(id: string): IngestionDetail {
  const [state, setState] = useState<Omit<IngestionDetail, "error" | "refresh"> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  const refresh = usePolling(
    async (signal) => {
      try {
        const [ingestion, timeline] = await Promise.all([
          ingestionsApi.get(id, signal),
          ingestionsApi.events(id, signal),
        ]);
        if (signal.aborted) return;
        live.current = isActive(ingestion);
        setState({ ingestion, events: timeline.items, receivedAt: Date.now() });
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        // Stop rather than hammer an ingestion that cannot be read; the panel
        // offers to try again.
        live.current = false;
        setError(cause instanceof Error ? cause.message : "This activity could not be loaded.");
      }
    },
    () => (live.current ? 1500 : null),
    id,
  );

  return {
    ingestion: state?.ingestion ?? null,
    events: state?.events ?? [],
    receivedAt: state?.receivedAt ?? 0,
    error,
    refresh,
  };
}

"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getApiConfiguration } from "@/lib/api/config";
import { apiRevision, invalidateApiData, subscribeApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { afterVisibleDelay, usePolling } from "@/lib/hooks/usePolling";
import {
  describeConnector,
  knowledgeConnectors,
  type KnowledgeConnector,
} from "@/modules/ingestion/connectors";
import {
  collectionsApi,
  connectionsApi,
  sourcesApi,
  type Connection,
  type ConnectorCapability,
  type Source,
} from "@/modules/ingestion/integrations-api";
import {
  ingestionRunsApi,
  isRunActive,
  type IngestionRun,
  type IngestionRunCreate,
  type IngestionRunItem,
  type IngestionRunItemStatus,
  type IngestionRunStatus,
} from "@/modules/ingestion/runs-api";

/**
 * What the deployment can connect.
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
    // A response that is not the documented `{items}` shape is a broken
    // deployment, not one with no connectors, and the reader gets a sentence
    // rather than whatever a property access on `undefined` throws.
    if (!Array.isArray(items)) {
      throw new Error("The connector registry returned an unexpected response.");
    }
    return items.map((capability) => ({
      connector: describeConnector(capability.connector_key, capability.display_name),
      capability,
    }));
  });
}

export interface CollectionName {
  id: string;
  title: string;
}

export interface SourceInventory {
  connections: Connection[];
  sources: Source[];
  /** Destination names, so a source or a run can say where its documents live. */
  collections: CollectionName[];
  /** False in the design preview, where there is no registry to connect against. */
  live: boolean;
}

/** How often sources are read again while one of them is syncing. */
const SYNC_POLL_MS = 3000;

/**
 * Connected accounts, their sources and the collections those fill.
 *
 * One load, because they are read together everywhere: a source is shown with
 * its account and its collection, and a run names the source or collection it
 * processed. While a sync is running the load repeats, so "Syncing…" turns
 * into "Last synced just now" and the pending count follows without a reload.
 */
export function useSourceInventory() {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const query = useApiQuery<SourceInventory>(async () => {
    if (!getApiConfiguration()) {
      return { connections: [], sources: [], collections: [], live: false };
    }
    const [connections, sources, collections] = await Promise.all([
      connectionsApi.list(),
      sourcesApi.list(),
      collectionsApi.list(),
    ]);
    return {
      connections: connections.items,
      sources: sources.items,
      collections: collections.items.map((item) => ({ id: item.id, title: item.title })),
      live: true,
    };
  }, revision);

  const { data, reload } = query;
  const syncing = data?.sources.some((source) => source.sync?.status === "running") ?? false;
  useEffect(() => {
    if (!syncing) return;
    return afterVisibleDelay(SYNC_POLL_MS, reload);
  }, [data, syncing, reload]);

  return query;
}

/** How often a list or a run is read while something in it is moving. */
const ACTIVE_POLL_MS = 2000;
/** The run list still notices a scheduled run starting, just less eagerly. */
const IDLE_LIST_POLL_MS = 15000;

export const RUNS_PAGE_SIZE = 25;

export interface RunList {
  runs: IngestionRun[];
  total: number;
  loaded: boolean;
  error: string | null;
  refresh: () => void;
}

/** Newest runs first, re-read every 2 seconds while any of them is moving. */
export function useRunList(params: { page: number; status?: IngestionRunStatus }): RunList {
  const [state, setState] = useState<{ runs: IngestionRun[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const moving = useRef(false);
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);

  const refresh = usePolling(
    async (signal) => {
      try {
        const page = await ingestionRunsApi.list(
          { page: params.page, page_size: RUNS_PAGE_SIZE, status: params.status },
          signal,
        );
        if (signal.aborted) return;
        moving.current = page.items.some(isRunActive);
        setState({ runs: page.items, total: page.total });
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Runs could not be loaded.");
      }
    },
    () => (moving.current ? ACTIVE_POLL_MS : IDLE_LIST_POLL_MS),
    `${params.page}:${params.status ?? ""}:${revision}`,
  );

  return {
    runs: state?.runs ?? [],
    total: state?.total ?? 0,
    loaded: state !== null,
    error,
    refresh,
  };
}

export const RUN_ITEMS_PAGE_SIZE = 50;

export interface RunDetail {
  run: IngestionRun | null;
  items: IngestionRunItem[];
  /** Items matching the current filter, beyond the page that was read. */
  itemTotal: number;
  error: string | null;
  refresh: () => void;
}

/**
 * One run and a page of its items, re-read every 2 seconds while the run is
 * queued or running and left alone once it has finished.
 */
export function useRunDetail(
  id: string,
  params: { page: number; status?: IngestionRunItemStatus },
): RunDetail {
  const [state, setState] = useState<{ run: IngestionRun; items: IngestionRunItem[]; itemTotal: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const moving = useRef(true);

  const refresh = usePolling(
    async (signal) => {
      try {
        const [run, items] = await Promise.all([
          ingestionRunsApi.get(id, signal),
          ingestionRunsApi.items(
            id,
            { page: params.page, page_size: RUN_ITEMS_PAGE_SIZE, status: params.status },
            signal,
          ),
        ]);
        if (signal.aborted) return;
        moving.current = isRunActive(run);
        setState({ run, items: items.items, itemTotal: items.total });
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        // Stop rather than hammer a run that cannot be read; the page offers
        // to try again.
        moving.current = false;
        setError(cause instanceof Error ? cause.message : "This run could not be loaded.");
      }
    },
    () => (moving.current ? ACTIVE_POLL_MS : null),
    `${id}:${params.page}:${params.status ?? ""}`,
  );

  return {
    run: state?.run.id === id ? state.run : null,
    items: state?.run.id === id ? state.items : [],
    itemTotal: state?.run.id === id ? state.itemTotal : 0,
    error,
    refresh,
  };
}

/**
 * Writes the Ingestion screen performs. Each one invalidates, so Knowledge's
 * processing states and the source list follow what the server now holds.
 */
export const ingestionActions = {
  async createRun(body: IngestionRunCreate) {
    const run = await ingestionRunsApi.create(body);
    invalidateApiData();
    return run;
  },
  /** Process what a source's syncs left waiting. */
  processSource(sourceId: string) {
    return ingestionActions.createRun({
      source_id: sourceId,
      states: ["pending", "outdated"],
      trigger: "manual",
    });
  },
  async cancelRun(id: string) {
    const run = await ingestionRunsApi.cancel(id);
    invalidateApiData();
    return run;
  },
  /** A new run over the documents this one did not finish. */
  async retryRun(id: string) {
    const run = await ingestionRunsApi.retry(id);
    invalidateApiData();
    return run;
  },
  async syncSource(id: string) {
    const source = await sourcesApi.sync(id);
    invalidateApiData();
    return source;
  },
};

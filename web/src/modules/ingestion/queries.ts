"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { getApiConfiguration } from "@/lib/api/config";
import { ApiError } from "@/lib/api/request";
import { apiRevision, invalidateApiData, subscribeApiData } from "@/lib/api/revision";
import { useApiQuery } from "@/lib/hooks/useApiQuery";
import { afterVisibleDelay, usePolling } from "@/lib/hooks/usePolling";
import { approvalRequestsApi } from "@/modules/manage/access/directory";
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
  type Schedule,
  type Source,
} from "@/modules/ingestion/integrations-api";
import {
  ingestionRunsApi,
  isRunActive,
  type IngestionRun,
  type IngestionRunItem,
  type IngestionRunStatus,
} from "@/modules/ingestion/runs-api";
import { cronFor, type ScheduleDraft } from "@/modules/ingestion/schedule";

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

/** A knowledge base a source can land in. */
export interface KnowledgeBaseOption {
  id: string;
  title: string;
  /** Holds `collection.update`, so new sources may add to it. */
  canAddSources: boolean;
  /** Documents in it, when the API reports a count. */
  documentCount: number | null;
}

export interface SourceInventory {
  connections: Connection[];
  sources: Source[];
  knowledgeBases: KnowledgeBaseOption[];
  /** Recent runs, newest first: which sources are being made searchable right now. */
  runs: IngestionRun[];
}

/** How often the inventory is read again while a source is syncing. */
const SYNC_POLL_MS = 3000;
/** Enough recent runs to find every active one in a normal workspace. */
const RECENT_RUNS = 50;

/**
 * Sources whose sync someone here started, to be made searchable once the sync
 * has found what changed. The server processes only after scheduled syncs; a
 * person pressing "Sync now" means the same thing, so the page finishes the job
 * while it is open. Anything it could not finish shows as waiting in the source
 * drawer, with Process now.
 */
const processAfterSync = new Set<string>();

function markForProcessing(sourceIds: Iterable<string>) {
  for (const id of sourceIds) processAfterSync.add(id);
}

async function processWaiting(inventory: SourceInventory) {
  let started = false;
  for (const source of inventory.sources) {
    if (!processAfterSync.has(source.id) || source.sync?.status === "running") continue;
    processAfterSync.delete(source.id);
    const busy = inventory.runs.some((run) => run.scope.source_id === source.id && isRunActive(run));
    if (source.sync?.status !== "succeeded" || source.pending_documents === 0 || busy) continue;
    try {
      await ingestionRunsApi.create({ source_id: source.id, states: ["pending", "outdated"], trigger: "manual" });
      started = true;
    } catch {
      // "Nothing to process" or no `ingestion.run`: the drawer still offers it.
    }
  }
  if (started) invalidateApiData();
}

function toKnowledgeBase(item: { id: string; title: string; [key: string]: unknown }): KnowledgeBaseOption {
  const permissions = item.permissions;
  const count = item.item_count;
  return {
    id: item.id,
    title: item.title,
    canAddSources: !Array.isArray(permissions) || permissions.includes("collection.update"),
    documentCount: typeof count === "number" ? count : null,
  };
}

/**
 * Connected accounts, their sources, the knowledge bases those fill and the
 * runs processing them. One load, because they are read together everywhere.
 * While a sync or a run is moving the load repeats, so "Syncing" turns into
 * "Up to date" without a reload.
 */
export function useSourceInventory() {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const query = useApiQuery<SourceInventory>(async () => {
    const [connections, sources, collections, runs] = await Promise.all([
      connectionsApi.list(),
      sourcesApi.list(),
      collectionsApi.list(),
      // Someone without `ingestion.read` sees only their own runs, and no
      // runs at all is still a usable page.
      ingestionRunsApi.list({ page_size: RECENT_RUNS }).catch(() => null),
    ]);
    return {
      connections: connections.items,
      sources: sources.items,
      knowledgeBases: collections.items.map(toKnowledgeBase),
      runs: runs?.items ?? [],
    };
  }, revision);

  const { data, reload } = query;
  const moving = Boolean(
    data && (data.sources.some((source) => source.sync?.status === "running") || data.runs.some(isRunActive)),
  );
  useEffect(() => {
    if (data) void processWaiting(data);
  }, [data]);
  useEffect(() => {
    if (!moving) return;
    return afterVisibleDelay(SYNC_POLL_MS, reload);
  }, [data, moving, reload]);

  return query;
}

/** How often a list or a run is read while something in it is moving. */
const ACTIVE_POLL_MS = 2000;
/** The run list still notices a scheduled run starting, just less eagerly. */
const IDLE_LIST_POLL_MS = 15000;

export const RUNS_PAGE_SIZE = 10;

export interface RunList {
  runs: IngestionRun[];
  total: number;
  loaded: boolean;
  error: string | null;
  refresh: () => void;
}

/** Newest runs first, re-read every 2 seconds while any of them is moving. */
export function useRunList(params: { page: number; status?: IngestionRunStatus; sourceId?: string }): RunList {
  const [state, setState] = useState<{ runs: IngestionRun[]; total: number; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const moving = useRef(false);
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const key = `${params.page}:${params.status ?? ""}:${params.sourceId ?? ""}`;

  const refresh = usePolling(
    async (signal) => {
      try {
        const page = await ingestionRunsApi.list(
          { page: params.page, page_size: RUNS_PAGE_SIZE, status: params.status, source_id: params.sourceId },
          signal,
        );
        if (signal.aborted) return;
        moving.current = page.items.some(isRunActive);
        setState({ runs: page.items, total: page.total, key });
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Sync history could not be loaded.");
      }
    },
    () => (moving.current ? ACTIVE_POLL_MS : IDLE_LIST_POLL_MS),
    `${key}:${revision}`,
  );

  // A new filter shows its own rows, never the previous filter's.
  const current = state?.key === key ? state : null;
  return {
    runs: current?.runs ?? [],
    total: current?.total ?? 0,
    loaded: current !== null,
    error,
    refresh,
  };
}

export const FAILED_ITEMS_PAGE_SIZE = 50;

export interface RunDetail {
  run: IngestionRun | null;
  /** Documents that could not be processed, first page. */
  failedItems: IngestionRunItem[];
  failedTotal: number;
  error: string | null;
  refresh: () => void;
}

/**
 * One run and its failed documents, re-read every 2 seconds while the run is
 * queued or running and left alone once it has finished.
 */
export function useRunDetail(id: string | null): RunDetail {
  const [state, setState] = useState<{ run: IngestionRun; items: IngestionRunItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const moving = useRef(true);
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);

  const refresh = usePolling(
    async (signal) => {
      if (!id) return;
      try {
        const [run, items] = await Promise.all([
          ingestionRunsApi.get(id, signal),
          ingestionRunsApi.items(id, { page: 1, page_size: FAILED_ITEMS_PAGE_SIZE, status: "failed" }, signal),
        ]);
        if (signal.aborted) return;
        moving.current = isRunActive(run);
        setState({ run, items: items.items, total: items.total });
        setError(null);
      } catch (cause) {
        if (signal.aborted) return;
        // Stop rather than hammer a run that cannot be read; the drawer offers
        // to try again.
        moving.current = false;
        setError(cause instanceof Error ? cause.message : "This sync could not be loaded.");
      }
    },
    () => (id && moving.current ? ACTIVE_POLL_MS : null),
    `${id ?? ""}:${revision}`,
  );

  const current = state?.run.id === id ? state : null;
  return {
    run: current?.run ?? null,
    failedItems: current?.items ?? [],
    failedTotal: current?.total ?? 0,
    error,
    refresh,
  };
}

/** Pending `plugin_installation` requests, by connector key: apps someone already asked for. */
export function useRequestedConnectors(enabled: boolean) {
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  return useApiQuery<ReadonlySet<string>>(async () => {
    if (!enabled) return new Set();
    const page = await approvalRequestsApi.list({ request_type: "plugin_installation", status: "pending" });
    return new Set(
      page.items
        .filter((request) => request.request_type === "plugin_installation" && request.status === "pending")
        .map((request) => request.target_id.toLowerCase()),
    );
  }, `${enabled}:${revision}`);
}

export interface SourceCreate {
  collection_id: string;
  display_name: string;
  resource_type: string;
  external_resource_id: string;
}

/**
 * Every write the Sources page performs. Each one invalidates, so the page,
 * the sidebar badge and Knowledge follow what the server now holds.
 */
export const ingestionActions = {
  /** Sync now: find what changed, then make it searchable. */
  async syncSource(id: string) {
    const source = await sourcesApi.sync(id);
    markForProcessing([id]);
    invalidateApiData();
    return source;
  },

  /** Process what earlier syncs left waiting. */
  async processSource(id: string) {
    const run = await ingestionRunsApi.create({ source_id: id, states: ["pending", "outdated"], trigger: "manual" });
    invalidateApiData();
    return run;
  },

  /** Pause stops syncs and the schedule; the schedule keeps its cadence for Resume. */
  async setPaused(source: Source, paused: boolean) {
    await sourcesApi.update(source.id, { status: paused ? "paused" : "ready" });
    if (source.schedule && source.schedule.enabled === paused) {
      await sourcesApi.setScheduleEnabled(source.id, !paused);
    }
    invalidateApiData();
  },

  /** Lifecycle removal. Documents already synced stay in their knowledge base. */
  async removeSource(id: string) {
    await sourcesApi.remove(id);
    invalidateApiData();
  },

  /** Manual removes the schedule; daily and weekly replace it. A paused source keeps it off. */
  async saveSchedule(source: Source, draft: ScheduleDraft): Promise<Schedule | null> {
    const cron = cronFor(draft);
    let schedule: Schedule | null = null;
    if (!cron) {
      if (source.schedule) await sourcesApi.removeSchedule(source.id);
    } else {
      schedule = await sourcesApi.putSchedule(source.id, {
        schedule_type: "cron",
        cron_expression: cron,
        timezone: draft.timezone,
        enabled: source.status !== "paused" && source.status !== "disabled",
        overlap_policy: source.schedule?.overlap_policy ?? "skip",
      });
    }
    invalidateApiData();
    return schedule;
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

  /** Asks the provider whether the account still works. */
  async checkConnection(id: string) {
    const result = await connectionsApi.validate(id);
    invalidateApiData();
    return result;
  },

  /** Lifecycle removal of an account no source uses. */
  async removeConnection(id: string) {
    await connectionsApi.remove(id);
    invalidateApiData();
  },

  /** A new secret for a credential account, checked before it counts. */
  async replaceCredentials(id: string, credentials: Record<string, unknown>) {
    await connectionsApi.updateCredentials(id, credentials);
    const result = await connectionsApi.validate(id);
    invalidateApiData();
    return result;
  },

  /**
   * After an account signs in again, its stopped sources sync at once rather
   * than at their next scheduled time. Returns the sources that started.
   */
  async resumeAfterReconnect(connectionId: string, sources: readonly Source[]) {
    const waiting = sources.filter(
      (source) =>
        source.connection_id === connectionId &&
        source.status !== "paused" &&
        source.status !== "disabled" &&
        source.sync?.status !== "running",
    );
    const started: Source[] = [];
    for (const source of waiting) {
      try {
        await sourcesApi.sync(source.id);
        started.push(source);
      } catch {
        // A source the server still refuses keeps its status and its call-out.
      }
    }
    markForProcessing(started.map((source) => source.id));
    invalidateApiData();
    return started;
  },

  async createKnowledgeBase(title: string) {
    const created = await collectionsApi.create(title.trim());
    invalidateApiData();
    return created;
  },

  /**
   * One source per picked resource; each starts its first sync on create. On a
   * failure the sources already created are returned with the error so the
   * wizard can retry only the rest.
   */
  async createSources(
    connectionId: string,
    bodies: readonly SourceCreate[],
    schedule: ScheduleDraft,
  ): Promise<{ created: Source[]; failed: { body: SourceCreate; error: unknown } | null }> {
    const cron = cronFor(schedule);
    const created: Source[] = [];
    let failed: { body: SourceCreate; error: unknown } | null = null;
    for (const body of bodies) {
      try {
        created.push(
          await connectionsApi.createSource(connectionId, {
            ...body,
            schedule: cron
              ? { schedule_type: "cron", cron_expression: cron, timezone: schedule.timezone, enabled: true, overlap_policy: "skip" }
              : null,
          }),
        );
      } catch (error) {
        failed = { body, error };
        break;
      }
    }
    markForProcessing(created.map((source) => source.id));
    invalidateApiData();
    return { created, failed };
  },

  /** Asks this workspace's source managers to make a connector available. A pending duplicate counts as asked. */
  async requestConnector(connectorKey: string) {
    try {
      await approvalRequestsApi.create({ request_type: "plugin_installation", target_id: connectorKey });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 409)) throw error;
      invalidateApiData();
    }
  },
};

"use client";

import { api, call, listAll, requestId, resourceId, type Schema } from "@/lib/api/client";

/**
 * Ingestion calls (api_design.md §6): the connector catalog, connected accounts
 * (connections), sources and their syncs, processing runs (ingestion runs), and
 * CONNECTOR requests for apps the platform hasn't turned on. Path parameters are
 * bare IDs; names in bodies and filters are full resource names.
 */

export type Connector = Schema<"Connector">;
export type Connection = Schema<"Connection">;
export type ConnectionResource = Schema<"ConnectionResource">;
export type Source = Schema<"Source">;
export type SourceSchedule = Schema<"SourceSchedule">;
export type PublishingPolicy = NonNullable<Source["publishingPolicy"]>;
export type Sync = Schema<"Sync">;
export type SyncState = NonNullable<Sync["state"]>;
export type IngestionRun = Schema<"IngestionRun">;
export type Request = Schema<"Request">;

const PAGE = 200;

/* ═══════════════ Connectors (platform catalog) ═══════════════ */

/** Members see ACTIVE connectors only; platform callers see the whole catalog. */
export function listConnectors(): Promise<Connector[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/connectors", { params: { query: { pageSize: PAGE, pageToken } } })),
    (page) => page.connectors,
  );
}

/* ═══════════════ Connections (connected accounts) ═══════════════ */

const conn = (workspace: string, connection: string) => ({ workspace, connection: resourceId(connection) });

export function listConnections(workspace: string): Promise<Connection[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/workspaces/{workspace}/connections", { params: { path: { workspace }, query: { pageSize: PAGE, pageToken, orderBy: "createTime" } } })),
    (page) => page.connections,
  );
}

export function getConnection(workspace: string, connection: string): Promise<Connection> {
  return call(api.GET("/api/v1/workspaces/{workspace}/connections/{connection}", { params: { path: conn(workspace, connection) } }));
}

/**
 * Workspace-owned connection (empty `owner`). Without `apiToken` an OAuth connector
 * starts AUTHORIZING with an `authorizationUri`; with one (and its `config`) it is ACTIVE at once.
 */
export function createConnection(workspace: string, body: Connection): Promise<Connection> {
  return call(api.POST("/api/v1/workspaces/{workspace}/connections", { params: { path: { workspace }, query: { requestId: requestId() } }, body }));
}

/** FAILED_PRECONDITION while sources still use it. */
export function deleteConnection(workspace: string, connection: string): Promise<unknown> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/connections/{connection}", { params: { path: conn(workspace, connection) } }));
}

export function testConnection(workspace: string, connection: string): Promise<Schema<"TestConnectionResponse">> {
  return call(api.POST("/api/v1/workspaces/{workspace}/connections/{connection}:test", { params: { path: conn(workspace, connection) }, body: {} }));
}

/** Back to AUTHORIZING with a fresh `authorizationUri`. */
export function reauthorizeConnection(workspace: string, connection: string): Promise<Connection> {
  return call(api.POST("/api/v1/workspaces/{workspace}/connections/{connection}:reauthorize", { params: { path: conn(workspace, connection) }, body: {} }));
}

/** What the account can reach under `path` (a provider resource path; empty = root). */
export function browseResources(workspace: string, connection: string, path?: string): Promise<ConnectionResource[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/connections/{connection}:browseResources", {
          params: { path: conn(workspace, connection), query: { path: path || undefined, pageSize: PAGE, pageToken } },
        }),
      ),
    (page) => page.resources,
  );
}

/* ═══════════════ Sources ═══════════════ */

const src = (workspace: string, source: string) => ({ workspace, source: resourceId(source) });

export function listSources(workspace: string): Promise<Source[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/sources", { params: { path: { workspace }, query: { pageSize: PAGE, pageToken } } })),
    (page) => page.sources,
  );
}

export function getSource(workspace: string, source: string): Promise<Source> {
  return call(api.GET("/api/v1/workspaces/{workspace}/sources/{source}", { params: { path: src(workspace, source) } }));
}

/** Creates the source and starts its first sync (trigger CREATION). */
export function createSource(workspace: string, body: Source): Promise<Source> {
  return call(api.POST("/api/v1/workspaces/{workspace}/sources", { params: { path: { workspace }, query: { requestId: requestId() } }, body }));
}

/** Mutable: `displayName`, `config`, `schedule` (omitted under the mask = manual), `publishingPolicy`. */
export function updateSource(workspace: string, source: Source, patch: Partial<Source>, updateMask: readonly string[]): Promise<Source> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/sources/{source}", {
      params: { path: src(workspace, source.name ?? ""), query: { updateMask: updateMask.join(",") } },
      body: { connection: source.connection, targetCollection: source.targetCollection, externalResource: source.externalResource, ...patch, etag: source.etag },
    }),
  );
}

/** Removes the source; the documents it synced stay. */
export function deleteSource(workspace: string, source: string): Promise<unknown> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/sources/{source}", { params: { path: src(workspace, source) } }));
}

export function pauseSource(workspace: string, source: string): Promise<Source> {
  return call(api.POST("/api/v1/workspaces/{workspace}/sources/{source}:pause", { params: { path: src(workspace, source) }, body: {} }));
}

export function resumeSource(workspace: string, source: string): Promise<Source> {
  return call(api.POST("/api/v1/workspaces/{workspace}/sources/{source}:resume", { params: { path: src(workspace, source) }, body: {} }));
}

/* ═══════════════ Syncs ═══════════════ */

/** A sync's source name, from the sync's own name (`…/sources/{source}/syncs/{sync}`). */
export function sourceOfSync(sync: Pick<Sync, "name">): string {
  const name = sync.name ?? "";
  const i = name.indexOf("/syncs/");
  return i < 0 ? "" : name.slice(0, i);
}

export interface SyncFilter {
  /** Source name; omitted = every source (`sources/-`). */
  source?: string;
  state?: SyncState;
}

/** Newest first; at most `limit` syncs. */
export function listSyncs(workspace: string, { source, state }: SyncFilter = {}, limit = 500): Promise<Sync[]> {
  const filter = [state && `state = ${state}`, source && `source = "${source}"`].filter(Boolean).join(" AND ") || undefined;
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/sources/{source}/syncs", {
          params: { path: { workspace, source: "-" }, query: { pageSize: Math.min(limit, PAGE), pageToken, filter, orderBy: "startTime desc" } },
        }),
      ),
    (page) => page.syncs,
    limit,
  );
}

export function getSync(workspace: string, sync: string): Promise<Sync> {
  const source = resourceId(sourceOfSync({ name: sync }));
  return call(api.GET("/api/v1/workspaces/{workspace}/sources/{source}/syncs/{sync}", { params: { path: { workspace, source, sync: resourceId(sync) } } }));
}

/** Sync now (MANUAL). FAILED_PRECONDITION while one runs or the source is paused. */
export function createSync(workspace: string, source: string): Promise<Sync> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/sources/{source}/syncs", { params: { path: src(workspace, source), query: { requestId: requestId() } }, body: {} }),
  );
}

/* ═══════════════ Processing (ingestion runs) ═══════════════ */

/** Publish what a source left waiting (PENDING or OUTDATED documents it registered). */
export function publishWaiting(workspace: string, source: string): Promise<IngestionRun> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: { trigger: "MANUAL", selector: { source, states: ["PENDING", "OUTDATED"] } },
    }),
  );
}

/* ═══════════════ Connector requests ═══════════════ */

/** The caller's open CONNECTOR requests (one per requested app). */
export function listMyConnectorRequests(workspace: string, member: string): Promise<Request[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/requests", {
          params: { path: { workspace }, query: { filter: `kind = CONNECTOR AND requester = "${member}" AND state = OPEN`, pageSize: 100, pageToken } },
        }),
      ),
    (page) => page.requests,
    200,
  );
}

/** Asks the platform admin to turn an app on. */
export function requestConnector(workspace: string, connector: Connector): Promise<Request> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/requests", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body: { kind: "CONNECTOR", target: connector.name, title: `Turn on ${connector.displayName ?? "an app"}` },
    }),
  );
}

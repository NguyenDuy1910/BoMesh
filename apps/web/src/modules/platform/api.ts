/**
 * Platform console API (`/api/v1`, platform callers): workspaces, users, connectors,
 * cross-workspace ingestion (`workspaces/-/…`, metadata only), the ingestion policy,
 * audit events, components and incidents. Long work returns an Operation that
 * `waitForOperation` polls until done.
 */

import { api, ApiError, call, listAll, resourceId, type Schema } from "@/lib/api/client";

import { DAY, lastSegment, POLICY_MASK, workspaceIdOf } from "./model";

type Operation = Schema<"Operation">;
export type Workspace = Schema<"Workspace">;
export type User = Schema<"User">;
export type Connector = Schema<"Connector">;
export type IngestionTask = Schema<"IngestionTask">;
export type IngestionRun = Schema<"IngestionRun">;
export type IngestionWorkspaceSummary = Schema<"IngestionWorkspaceSummary">;
export type IngestionPolicy = Schema<"IngestionPolicy">;
export type PlatformAuditEvent = Schema<"PlatformAuditEvent">;
export type WorkspaceAuditEvent = Schema<"AuditEvent">;
export type Component = Schema<"Component">;
export type Incident = Schema<"Incident">;
export type UsageWindow = "P1D" | "P7D" | "P30D";
export type WorkspaceUsage = Schema<"WorkspaceUsage">;

const PAGE = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls an Operation until `done`; returns its `response`, or throws its `error` as an ApiError. */
export async function waitForOperation<T>(operation: Operation, { interval = 800, timeout = 120_000 } = {}): Promise<T> {
  let op = operation;
  const started = Date.now();
  while (!op.done) {
    if (Date.now() - started > timeout) throw new Error("This is taking longer than expected. Check again in a minute.");
    await sleep(interval);
    op = await call(api.GET("/api/v1/operations/{operation}", { params: { path: { operation: resourceId(op.name) } } }));
  }
  if (op.error) {
    const reason = op.error.details?.find((d) => d.reason)?.reason;
    throw new ApiError(op.error.message ?? "Something went wrong. Try again.", 400, "FAILED_PRECONDITION", reason);
  }
  return op.response as T;
}

/* ── Workspaces ─────────────────────────────────────────────────────────── */

export function listWorkspaces(): Promise<Workspace[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces", { params: { query: { pageSize: PAGE, pageToken } } })),
    (r) => r.workspaces,
    5000,
  );
}

export interface CreateWorkspaceInput {
  displayName: string;
  code: string;
  initialAdminEmail: string;
  template: NonNullable<Workspace["template"]>;
}

/** Starts provisioning and waits for it; the new workspace is CREATING until provisioning finishes. */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  const op = await call(api.POST("/api/v1/workspaces", { body: input }));
  return waitForOperation<Workspace>(op);
}

export function getWorkspace(id: string): Promise<Workspace> {
  return call(api.GET("/api/v1/workspaces/{workspace}", { params: { path: { workspace: id } } }));
}

export function suspendWorkspace(w: Workspace): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:suspend", { params: { path: { workspace: lastSegment(w.name) } }, body: {} }));
}

export function activateWorkspace(w: Workspace): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:activate", { params: { path: { workspace: lastSegment(w.name) } }, body: {} }));
}

export function pauseIngestion(w: Workspace): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:pauseIngestion", { params: { path: { workspace: lastSegment(w.name) } }, body: {} }));
}

export function resumeIngestion(w: Workspace): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:resumeIngestion", { params: { path: { workspace: lastSegment(w.name) } }, body: {} }));
}

/** Members of a workspace, readable only where the caller is a member; null when the caller may not read them. */
export async function listWorkspaceMembers(id: string): Promise<Schema<"Member">[] | null> {
  try {
    return await listAll(
      (pageToken) => call(api.GET("/api/v1/workspaces/{workspace}/members", { params: { path: { workspace: id }, query: { pageSize: PAGE, pageToken } } })),
      (r) => r.members,
      5000,
    );
  } catch (error) {
    if (error instanceof ApiError && (error.isNotFound || error.status === 403)) return null;
    throw error;
  }
}

/** Workspace admins; null when the caller may not read the workspace's members. */
export async function listWorkspaceAdmins(id: string): Promise<Schema<"Member">[] | null> {
  const members = await listWorkspaceMembers(id);
  return members && members.filter((m) => m.roles?.includes("roles/workspaceAdmin"));
}

/* ── Usage ──────────────────────────────────────────────────────────────── */

export async function summarizeUsage(window: UsageWindow): Promise<WorkspaceUsage[]> {
  const r = await call(api.GET("/api/v1/workspaces:summarizeUsage", { params: { query: { window } } }));
  return r.workspaceUsages ?? [];
}

/** CSV of every workspace's usage in the window; resolves to the signed download URI. */
export async function exportUsage(window: UsageWindow): Promise<string> {
  const op = await call(api.POST("/api/v1/workspaces:exportUsage", { body: { window } }));
  const result = await waitForOperation<Schema<"WorkspaceExportResponse">>(op);
  if (!result.downloadUri) throw new Error("The export finished without a file. Try again.");
  return result.downloadUri;
}

/* ── Users ──────────────────────────────────────────────────────────────── */

export function listUsers(): Promise<User[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/users", { params: { query: { pageSize: PAGE, pageToken, orderBy: "displayName" } } })),
    (r) => r.users,
    10_000,
  );
}

/** The account using this email, if one exists. */
export async function findUserByEmail(email: string): Promise<User | null> {
  const r = await call(api.GET("/api/v1/users", { params: { query: { pageSize: 1, filter: `email = ${JSON.stringify(email.trim().toLowerCase())}` } } }));
  return r.users?.[0] ?? null;
}

export function updatePlatformRole(user: User, platformRole: NonNullable<User["platformRole"]>): Promise<User> {
  return call(
    api.PATCH("/api/v1/users/{user}", {
      params: { path: { user: lastSegment(user.name) }, query: { updateMask: "platformRole" } },
      body: { email: user.email, platformRole },
    }),
  );
}

export function suspendUser(user: User): Promise<User> {
  return call(api.POST("/api/v1/users/{user}:suspend", { params: { path: { user: lastSegment(user.name) } }, body: {} }));
}

export function activateUser(user: User): Promise<User> {
  return call(api.POST("/api/v1/users/{user}:activate", { params: { path: { user: lastSegment(user.name) } }, body: {} }));
}

/* ── Connectors ─────────────────────────────────────────────────────────── */

export async function listConnectors(): Promise<Connector[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/connectors", { params: { query: { pageSize: PAGE, pageToken } } })),
    (r) => r.connectors,
  );
}

export function enableConnector(c: Connector): Promise<Connector> {
  return call(api.POST("/api/v1/connectors/{connector}:enable", { params: { path: { connector: lastSegment(c.name) } }, body: {} }));
}

export function disableConnector(c: Connector): Promise<Connector> {
  return call(api.POST("/api/v1/connectors/{connector}:disable", { params: { path: { connector: lastSegment(c.name) } }, body: {} }));
}

/** Saves the shared OAuth client; an empty secret keeps the stored one. */
export function updateConnectorOauth(c: Connector, clientId: string, clientSecret: string): Promise<Connector> {
  const secret = clientSecret.trim();
  return call(
    api.PATCH("/api/v1/connectors/{connector}", {
      params: {
        path: { connector: lastSegment(c.name) },
        query: { updateMask: secret ? "oauthClient.clientId,oauthClient.clientSecret" : "oauthClient.clientId" },
      },
      body: { oauthClient: secret ? { clientId: clientId.trim(), clientSecret: secret } : { clientId: clientId.trim() }, etag: c.etag },
    }),
  );
}

export interface ConnectorRequest {
  workspaceId: string;
  request: Schema<"Request">;
}

/**
 * `CONNECTOR` requests for one connector across workspaces (platform admins decide them).
 * Workspaces with the requests module off or unreadable are skipped.
 */
export async function listConnectorRequests(connector: Connector, workspaces: readonly Workspace[]): Promise<ConnectorRequest[]> {
  const results = await Promise.allSettled(
    workspaces.map(async (w) => {
      const id = lastSegment(w.name);
      const r = await call(
        api.GET("/api/v1/workspaces/{workspace}/requests", {
          params: { path: { workspace: id }, query: { pageSize: PAGE, filter: 'kind = "CONNECTOR"' } },
        }),
      );
      return (r.requests ?? []).filter((q) => q.target === connector.name).map((request) => ({ workspaceId: id, request }));
    }),
  );
  return results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => Date.parse(b.request.createTime ?? "") - Date.parse(a.request.createTime ?? ""));
}

/* ── Ingestion (metadata only) ──────────────────────────────────────────── */

const since = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Per-workspace queue, throughput, failure rate and error classes; `windowMs` limits to runs created in that window. */
export async function summarizeIngestion(windowMs?: number): Promise<IngestionWorkspaceSummary[]> {
  const r = await call(
    api.GET("/api/v1/workspaces/{workspace}/ingestionRuns:summarize", {
      params: { path: { workspace: "-" }, query: windowMs ? { filter: `createTime >= "${since(windowMs)}"` } : {} },
    }),
  );
  return r.workspaceSummaries ?? [];
}

/** Recent tasks across workspaces, newest first (no item names or content for platform callers). */
export function listRecentTasks(limit = 1000): Promise<IngestionTask[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}/tasks", {
          params: {
            path: { workspace: "-", ingestionRun: "-" },
            query: { pageSize: Math.min(PAGE, limit), pageToken, orderBy: "createTime desc", filter: `createTime >= "${since(7 * DAY)}"` },
          },
        }),
      ),
    (r) => r.tasks,
    limit,
  );
}

/** Platform retry: a new run over the workspace's FAILED documents. */
export function retryFailed(workspaceId: string): Promise<IngestionRun> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace: workspaceId } },
      body: { selector: { states: ["FAILED"] }, trigger: "PLATFORM_RETRY" },
    }),
  );
}

export function cancelRun(run: IngestionRun): Promise<IngestionRun> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}:cancel", {
      params: { path: { workspace: workspaceIdOf(run.name), ingestionRun: lastSegment(run.name) } },
      body: {},
    }),
  );
}

export function getIngestionPolicy(): Promise<IngestionPolicy> {
  return call(api.GET("/api/v1/ingestionPolicies/{ingestionPolicy}", { params: { path: { ingestionPolicy: "default" } } }));
}

export function updateIngestionPolicy(body: IngestionPolicy): Promise<IngestionPolicy> {
  return call(
    api.PATCH("/api/v1/ingestionPolicies/{ingestionPolicy}", {
      params: { path: { ingestionPolicy: "default" }, query: { updateMask: POLICY_MASK } },
      body,
    }),
  );
}

/* ── Audit ──────────────────────────────────────────────────────────────── */

/** Events not tied to a workspace (platform sign-ins, account and catalog changes) since `windowMs` ago. */
export function listPlatformAuditEvents(windowMs: number): Promise<PlatformAuditEvent[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/auditEvents", { params: { query: { pageSize: PAGE, pageToken, filter: `createTime >= "${since(windowMs)}"` } } })),
    (r) => r.auditEvents,
    5000,
  );
}

/** The latest successful change to the platform ingestion policy (from the audit log), if any. */
export async function getLastPolicyChange(): Promise<PlatformAuditEvent | null> {
  const r = await call(
    api.GET("/api/v1/auditEvents", {
      params: { query: { pageSize: 1, filter: 'target = "ingestionPolicies/default" AND action = "UpdateIngestionPolicy" AND outcome = "SUCCEEDED"' } },
    }),
  );
  return r.auditEvents?.[0] ?? null;
}

/** Workspace events across workspaces (metadata only: no description or target) since `windowMs` ago. */
export function listWorkspaceAuditEvents(windowMs: number): Promise<WorkspaceAuditEvent[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/auditEvents", {
          params: { path: { workspace: "-" }, query: { pageSize: PAGE, pageToken, filter: `createTime >= "${since(windowMs)}"` } },
        }),
      ),
    (r) => r.auditEvents,
    5000,
  );
}

/* ── Health ─────────────────────────────────────────────────────────────── */

export function listComponents(): Promise<Component[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/components", { params: { query: { pageSize: PAGE, pageToken } } })),
    (r) => r.components,
  );
}

export function listIncidents(windowMs: number): Promise<Incident[]> {
  return listAll(
    (pageToken) =>
      call(api.GET("/api/v1/incidents", { params: { query: { pageSize: PAGE, pageToken, filter: `startTime >= "${since(windowMs)}"` } } })),
    (r) => r.incidents,
    1000,
  );
}

/**
 * Platform console API (`/api/v1`, platform callers): workspaces, users, connectors,
 * cross-workspace ingestion (`workspaces/-/…`, metadata only), the ingestion policy,
 * audit events, components and incidents. Long work returns an Operation that
 * `waitForOperation` polls until done.
 */

import { api, ApiError, call, listAll, resourceId, type Schema } from "@/lib/api/client";

import { DAY, lastSegment, mergeAuditPage, PLATFORM_WORKSPACE_ACTIONS, POLICY_MASK, type AuditCursor } from "./model";

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

/** Bounded configuration (workspaces, connectors, components) and windowed incidents: read whole, this many per call. */
const PAGE = 1000;
/** Admins shown in the workspace drawer (one page). */
const ADMINS_PAGE = 50;
/** A workspace asks for a connector about once; one short page each. */
const REQUESTS_PER_WORKSPACE = 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls an Operation until `done`; returns its `response`, or throws its `error` as an ApiError. */
export async function waitForOperation<T>(operation: Operation, { interval = 800, timeout = 120_000 } = {}): Promise<T> {
  let op = operation;
  const started = Date.now();
  while (!op.done) {
    if (Date.now() - started > timeout) throw new Error("Việc này lâu hơn dự kiến. Hãy kiểm tra lại sau một phút.");
    await sleep(interval);
    op = await call(api.GET("/api/v1/operations/{operation}", { params: { path: { operation: resourceId(op.name) } } }));
  }
  if (op.error) {
    const reason = op.error.details?.find((d) => d.reason)?.reason;
    throw new ApiError(op.error.message ?? "Đã xảy ra lỗi. Hãy thử lại.", 400, "FAILED_PRECONDITION", reason);
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

/** Archives a workspace; `confirmationCode` must equal its web address (`code`). `:activate` restores it. */
export function archiveWorkspace(w: Workspace): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:archive", { params: { path: { workspace: lastSegment(w.name) } }, body: { confirmationCode: w.code } }));
}

export function pauseIngestion(w: Workspace): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:pauseIngestion", { params: { path: { workspace: lastSegment(w.name) } }, body: {} }));
}

export function resumeIngestion(w: Workspace): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:resumeIngestion", { params: { path: { workspace: lastSegment(w.name) } }, body: {} }));
}

/**
 * The user's membership of a workspace (one-row `name` read): null when they aren't a member, "hidden" when the
 * caller may not read that workspace's members.
 */
export async function getMembership(workspaceId: string, userId: string): Promise<Schema<"Member"> | "hidden" | null> {
  try {
    const r = await call(
      api.GET("/api/v1/workspaces/{workspace}/members", {
        params: { path: { workspace: workspaceId }, query: { pageSize: 1, filter: `name = ${JSON.stringify(`workspaces/${workspaceId}/members/${userId}`)}` } },
      }),
    );
    return r.members?.[0] ?? null;
  } catch (error) {
    if (error instanceof ApiError && (error.isNotFound || error.status === 403)) return "hidden";
    throw error;
  }
}

/** Workspace admins (first page, server `roles` filter); null when the caller may not read the workspace's members. */
export async function listWorkspaceAdmins(id: string): Promise<Schema<"Member">[] | null> {
  try {
    const r = await call(
      api.GET("/api/v1/workspaces/{workspace}/members", {
        params: { path: { workspace: id }, query: { pageSize: ADMINS_PAGE, filter: 'roles:"roles/workspaceAdmin"' } },
      }),
    );
    return r.members ?? [];
  } catch (error) {
    if (error instanceof ApiError && (error.isNotFound || error.status === 403)) return null;
    throw error;
  }
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
  if (!result.downloadUri) throw new Error("Đã xuất xong nhưng không có tệp. Hãy thử lại.");
  return result.downloadUri;
}

/* ── Users ──────────────────────────────────────────────────────────────── */

export interface UserQuery {
  search?: string;
  platformRole?: string;
  state?: string;
}

/** The ListUsers filter for the Users page's search box and filters (search: name or email, wildcard). */
export function userFilter({ search, platformRole, state }: UserQuery): string {
  const q = search?.trim();
  const needle = q ? JSON.stringify(`*${q}*`) : "";
  return [needle && `(displayName = ${needle} OR email = ${needle})`, platformRole && `platformRole = ${platformRole}`, state && `state = ${state}`].filter(Boolean).join(" AND ");
}

/** One page of accounts, by name. */
export function listUsersPage(filter: string, pageSize: number, pageToken?: string) {
  return call(api.GET("/api/v1/users", { params: { query: { pageSize, pageToken, orderBy: "displayName", filter: filter || undefined } } }));
}

export function getUser(id: string): Promise<User> {
  return call(api.GET("/api/v1/users/{user}", { params: { path: { user: id } } }));
}

/** Accounts by resource name in one batch read (`name = "users/a" OR …`); missing accounts are absent. */
export async function batchGetUsers(names: readonly string[]): Promise<User[]> {
  const unique = [...new Set(names.filter((n) => n.startsWith("users/")))];
  if (!unique.length) return [];
  const r = await listUsersPage(unique.map((n) => `name = ${JSON.stringify(n)}`).join(" OR "), unique.length);
  return r.users ?? [];
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
 * `CONNECTOR` requests for one connector across workspaces (platform admins decide them): per workspace, one page
 * of that connector's requests (server `target` filter), newest first. Workspaces with the requests module off or
 * unreadable are skipped.
 */
export async function listConnectorRequests(connector: Connector, workspaces: readonly Workspace[]): Promise<ConnectorRequest[]> {
  const filter = `kind = CONNECTOR AND target = ${JSON.stringify(connector.name ?? "")}`;
  const results = await Promise.allSettled(
    workspaces.map(async (w) => {
      const id = lastSegment(w.name);
      const r = await call(
        api.GET("/api/v1/workspaces/{workspace}/requests", {
          params: { path: { workspace: id }, query: { pageSize: REQUESTS_PER_WORKSPACE, filter, orderBy: "createTime desc" } },
        }),
      );
      return (r.requests ?? []).map((request) => ({ workspaceId: id, request }));
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

export interface TaskQuery {
  /** Workspace ID, or "" for every workspace. */
  workspace: string;
  /** ListIngestionTasks filter (state, errorClass, job ID, …); the 7-day window is added here. */
  filter: string;
  orderBy?: string;
}

/** One page of the last 7 days' tasks, newest first (no item names or content for platform callers). */
export function listTasksPage({ workspace, filter, orderBy = "createTime desc" }: TaskQuery, pageSize: number, pageToken?: string) {
  const window = `createTime >= "${since(7 * DAY)}"`;
  return call(
    api.GET("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}/tasks", {
      params: {
        path: { workspace: workspace || "-", ingestionRun: "-" },
        query: { pageSize, pageToken, orderBy, filter: filter ? `${window} AND (${filter})` : window },
      },
    }),
  );
}

/** One task by resource name (`workspaces/{w}/ingestionRuns/{r}/tasks/{t}`). */
export function getTask(name: string): Promise<IngestionTask> {
  const [, workspace, , ingestionRun, , task] = name.split("/");
  return call(api.GET("/api/v1/workspaces/{workspace}/ingestionRuns/{ingestionRun}/tasks/{task}", { params: { path: { workspace, ingestionRun, task } } }));
}

/** Platform retry: a new run over the workspace's FAILED documents. */
export function retryFailed(workspaceId: string): Promise<IngestionRun> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/ingestionRuns", {
      params: { path: { workspace: workspaceId } },
      body: { selector: { filter: "document.indexingState = FAILED" }, trigger: "PLATFORM_RETRY" },
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

export interface AuditQuery {
  windowMs: number;
  /** "" every event, "platform" events not about a workspace, else a workspace ID. */
  scope: string;
  category?: string;
  outcome?: "SUCCEEDED" | "FAILED";
  /** Matched against the action (`Suspend workspace` → `*Suspendworkspace*`, case-insensitive). */
  search?: string;
}

export interface AuditPage {
  platform: PlatformAuditEvent[];
  workspace: WorkspaceAuditEvent[];
  nextPageToken?: string;
}

/**
 * One page of the console's audit log: platform events and workspace lifecycle events merged newest first. Each
 * page reads at most `pageSize + seen + 1` events from each stream (one call each), filtered on the server.
 */
export async function listAuditPage(q: AuditQuery, pageSize: number, pageToken?: string): Promise<AuditPage> {
  const cursor: AuditCursor | null = pageToken ? (JSON.parse(pageToken) as AuditCursor) : null;
  const needle = q.search?.replace(/\s+/g, "");
  const common = [
    `createTime >= "${since(q.windowMs)}"`,
    cursor ? `createTime <= "${cursor.before}"` : "",
    q.category ? `category = ${q.category}` : "",
    q.outcome ? `outcome = ${q.outcome}` : "",
    needle ? `action = ${JSON.stringify(`*${needle}*`)}` : "",
  ].filter(Boolean);
  const size = pageSize + (cursor?.seen.length ?? 0) + 1;
  const platformScope = q.scope === "platform" ? 'NOT target = "workspaces/*"' : q.scope ? `target = ${JSON.stringify(`workspaces/${q.scope}*`)}` : "";
  const lifecycle = `(${PLATFORM_WORKSPACE_ACTIONS.map((a) => `action = "${a}"`).join(" OR ")})`;
  const [platform, workspace] = await Promise.all([
    call(api.GET("/api/v1/auditEvents", { params: { query: { pageSize: size, filter: [...common, platformScope].filter(Boolean).join(" AND ") } } })),
    q.scope === "platform"
      ? { auditEvents: [] as WorkspaceAuditEvent[], nextPageToken: undefined }
      : call(
          api.GET("/api/v1/workspaces/{workspace}/auditEvents", {
            params: { path: { workspace: q.scope || "-" }, query: { pageSize: size, filter: [...common, lifecycle].join(" AND ") } },
          }),
        ),
  ]);
  const page = mergeAuditPage(platform.auditEvents ?? [], workspace.auditEvents ?? [], cursor, pageSize, Boolean(platform.nextPageToken || workspace.nextPageToken));
  return { platform: page.platform, workspace: page.workspace, nextPageToken: page.next ? JSON.stringify(page.next) : undefined };
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

/** Every event matching `q`, newest first, up to `max` (CSV export); `capped` when more matched. */
export async function listAuditEvents(q: AuditQuery, max: number): Promise<AuditPage & { capped: boolean }> {
  const out: AuditPage = { platform: [], workspace: [] };
  let token: string | undefined;
  do {
    const page = await listAuditPage(q, Math.min(500, max - out.platform.length - out.workspace.length), token);
    out.platform.push(...page.platform);
    out.workspace.push(...page.workspace);
    token = page.nextPageToken;
  } while (token && out.platform.length + out.workspace.length < max);
  return { ...out, capped: Boolean(token) };
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

/**
 * The platform console's client.
 *
 * Real reads (`/platform/workspaces`, `/users`, `/audit-logs`, `/health`) go
 * through `workspaceDirectoryApi.platform`; this module composes them into what
 * the console screens show. Everything else is proposed in `api_contract.md`
 * ("Proposed — UI built, API pending", anchors `proposed-platform-*`) and is
 * answered by the pending layer until the backend exists. While a pending
 * feature is on, the list readers merge the REAL rows with what this browser
 * changed, so a screen shows one list: rows that exist only here carry
 * `source: "local"`, rows whose status was changed here `changed_locally`.
 */

import { invalidateApiData } from "@/lib/api/revision";
import { isPendingFeatureEnabled, pendingApi } from "@/lib/api/pending";
import { pendingPlatformAuditExport } from "@/lib/api/pending/platform-audit-export";
import { pendingPlatformCapabilities } from "@/lib/api/pending/platform-capabilities";
import { pendingPlatformConnectors } from "@/lib/api/pending/platform-connectors";
import { pendingPlatformHealthHistory } from "@/lib/api/pending/platform-health-history";
import { pendingPlatformUsage } from "@/lib/api/pending/platform-usage";
import { pendingPlatformUsers } from "@/lib/api/pending/platform-users";
import { pendingPlatformWorkspaces } from "@/lib/api/pending/platform-workspaces";
import {
  workspaceDirectoryApi,
  type AuditEvent,
  type Member,
  type SystemHealth,
  type WorkspaceHealth,
} from "@/modules/manage/access/directory";
import { readSince } from "@/modules/manage/activity/activity-log";
import { PLATFORM_AUDIT_WINDOW_MS, type PlatformAuditFilter, type PlatformAuditWindow } from "@/modules/platform/audit-filter";

/* ── Workspaces (`platform.workspace_admin`) ─────────────────────────────── */

export type PlatformWorkspaceStatus = "active" | "suspended";

/**
 * A workspace row: the server's, or one created in this browser.
 *
 * The documented `GET /platform/workspaces` row is `Workspace` (id, code, name,
 * status, settings); owner, counts and dates are filled in only where the
 * server sends them, so every one of them is optional here.
 */
export interface PlatformWorkspace extends Pick<WorkspaceHealth, "id" | "code" | "name" | "status" | "settings"> {
  created_at?: string | null;
  updated_at?: string | null;
  owner?: WorkspaceHealth["owner"];
  member_count?: number | null;
  connection_count?: number | null;
  /** `local`: created in this browser and nowhere else (part of `platform.workspace_admin`). */
  source: "server" | "local";
  /** A server row whose status was changed in this browser only. */
  changed_locally: boolean;
}

export interface PlatformWorkspaceCreate {
  name: string;
  /** The workspace's web address; see `workspaceCodeProblem` in `./workspace-code`. */
  code: string;
  /** Becomes the first admin. */
  owner_email: string;
}

/** Every workspace, with suspensions and creations made in this browser applied. Needs `platform.tenant.read`. */
export async function listPlatformWorkspaces(query: { search?: string } = {}): Promise<PlatformWorkspace[]> {
  if (!isPendingFeatureEnabled("platform.workspace_admin")) {
    const page = await workspaceDirectoryApi.platform.workspaces(query.search?.trim() ?? "");
    return page.items.map((row) => ({ ...row, source: "server", changed_locally: false }));
  }
  return pendingApi("platform.workspace_admin", () => pendingPlatformWorkspaces.list(query.search ?? ""));
}

/** 422 for an invalid name, code or email; 409 when the code is taken. */
export async function createPlatformWorkspace(body: PlatformWorkspaceCreate): Promise<PlatformWorkspace> {
  const created = await pendingApi("platform.workspace_admin", () => pendingPlatformWorkspaces.create(body));
  invalidateApiData();
  return created;
}

/** Suspend or reactivate. */
export async function updatePlatformWorkspace(
  workspaceId: string,
  body: { status: PlatformWorkspaceStatus },
): Promise<PlatformWorkspace> {
  const updated = await pendingApi("platform.workspace_admin", () => pendingPlatformWorkspaces.update(workspaceId, body));
  invalidateApiData();
  return updated;
}

/* ── Users (`platform.user_admin`) ───────────────────────────────────────── */

export type PlatformAccountStatus = "active" | "suspended";

/** An account as `/platform/users` returns it, plus its platform role. */
export interface PlatformUser extends Member {
  /** Null when the server has not said yet; the caller's own row is always known. */
  is_platform_admin: boolean | null;
  /** Role or status was changed in this browser only. */
  changed_locally: boolean;
}

export interface PlatformUserUpdate {
  is_platform_admin?: boolean;
  status?: PlatformAccountStatus;
}

/** Every account, with role and suspension changes made in this browser applied. Needs `platform.user.read`. */
export async function listPlatformUsers(query: { search?: string } = {}): Promise<PlatformUser[]> {
  if (!isPendingFeatureEnabled("platform.user_admin")) {
    const page = await workspaceDirectoryApi.platform.users(query.search?.trim() ?? "");
    return page.items.map((row) => ({ ...row, is_platform_admin: null, changed_locally: false }));
  }
  return pendingApi("platform.user_admin", () => pendingPlatformUsers.list(query.search ?? ""));
}

/** 403 when the target is the caller: nobody changes their own platform role or status. */
export async function updatePlatformUser(userId: string, body: PlatformUserUpdate): Promise<PlatformUser> {
  const updated = await pendingApi("platform.user_admin", () => pendingPlatformUsers.update(userId, body));
  invalidateApiData();
  return updated;
}

/* ── Connectors (`platform.connectors`) ──────────────────────────────────── */

/** Sign-in settings shared by every workspace. The secret is write-only. */
export interface PlatformConnectorOAuthClient {
  client_id: string | null;
  has_secret: boolean;
  /** True when the deployment configuration already provides the client. */
  deployment_configured: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface PlatformConnector {
  key: string;
  name: string;
  description: string;
  /** Built in (file upload): always available, nothing to configure. */
  built_in: boolean;
  /** The deployment has an adapter for it; unsupported ones can only be requested. */
  supported: boolean;
  available: boolean;
  authentication: "oauth" | "credentials" | "none";
  workspace_count: number;
  request_count: number;
  /** Present for OAuth connectors only. */
  oauth_client: PlatformConnectorOAuthClient | null;
}

export interface PlatformConnectorUpdate {
  available?: boolean;
  /** `client_secret` is stored encrypted and never returned; omit it to keep the current one. */
  oauth_client?: { client_id: string; client_secret?: string };
}

/** Needs `platform.tenant.read`. */
export function listPlatformConnectors(): Promise<PlatformConnector[]> {
  return pendingApi("platform.connectors", () => pendingPlatformConnectors.list());
}

/** Turn availability on or off, or save the OAuth client. Proposed permission `platform.connector.manage`. */
export async function updatePlatformConnector(key: string, body: PlatformConnectorUpdate): Promise<PlatformConnector> {
  const updated = await pendingApi("platform.connectors", () => pendingPlatformConnectors.update(key, body));
  invalidateApiData();
  return updated;
}

/* ── AI capabilities (`platform.capabilities`) ───────────────────────────── */

export type PlatformCapabilityKey = "chat" | "embeddings" | "vision_parsing" | "contextualization";

/** `not_checked`: no health probe covers it yet, or the caller cannot read health. */
export type PlatformCapabilityStatus = "operational" | "degraded" | "down" | "not_configured" | "not_checked";

export interface PlatformCapability {
  key: PlatformCapabilityKey;
  name: string;
  description: string;
  status: PlatformCapabilityStatus;
  /** The deployment setting that chooses the model (an environment variable name). */
  setting: string;
  /** The model in use, as the server's health check reports it; null when not reported. */
  model: string | null;
  checked_at: string | null;
}

/** Read-only; models are chosen in the deployment configuration. Needs `platform.tenant.read`. */
export function listPlatformCapabilities(): Promise<PlatformCapability[]> {
  return pendingApi("platform.capabilities", () => pendingPlatformCapabilities.list());
}

/* ── Usage (`platform.usage`) ────────────────────────────────────────────── */

export type PlatformUsageWindow = "7d" | "30d" | "90d";

export interface PlatformUsageTotals {
  questions: number;
  active_people: number;
  documents_processed: number;
}

export interface PlatformUsageWorkspace extends PlatformUsageTotals {
  workspace_id: string;
  name: string;
}

export interface PlatformUsage {
  window: PlatformUsageWindow;
  /** First day of the window (UTC date). */
  start: string;
  generated_at: string;
  totals: PlatformUsageTotals;
  /** The equally long span just before `start`. */
  previous: PlatformUsageTotals;
  /** One entry per day, oldest first. */
  daily: { date: string; questions: number }[];
  /** Most questions first. Empty when the workspace list cannot be read. */
  workspaces: PlatformUsageWorkspace[];
}

/** Needs `platform.tenant.read`. */
export function getPlatformUsage(query: { window: PlatformUsageWindow }): Promise<PlatformUsage> {
  return pendingApi("platform.usage", () => pendingPlatformUsage.get(query.window));
}

/* ── Audit log (real `GET /platform/audit-logs`) ─────────────────────────── */

/** Ten pages of 100: enough for a console view; `truncated` says when the window holds more. */
const AUDIT_MAX_PAGES = 10;

export interface PlatformAuditEvents {
  /** Newest first, every one inside the window. */
  items: AuditEvent[];
  /** The window holds more events than were read; narrow it or search. */
  truncated: boolean;
}

/**
 * Every recorded event in the window, across workspaces and the platform.
 * The endpoint filters by search only and lists newest first, so the window is
 * read page by page, the same way the workspace Activity screen reads its own.
 * Needs `platform.audit.read`.
 */
export async function listPlatformAuditEvents(query: { search?: string; window: PlatformAuditWindow }): Promise<PlatformAuditEvents> {
  const search = query.search?.trim() ?? "";
  const { rows, truncated } = await readSince(
    (page) => workspaceDirectoryApi.platform.audit(search, page),
    (event) => event.created_at,
    Date.now() - PLATFORM_AUDIT_WINDOW_MS[query.window],
    AUDIT_MAX_PAGES,
  );
  return { items: rows, truncated };
}

export interface PlatformAuditExportQuery extends PlatformAuditFilter {
  format: "csv";
  window: PlatformAuditWindow;
  search?: string;
}

/** The audit log as CSV, filtered exactly like the Audit log page (up to 10,000 events). Needs `platform.audit.read`. */
export function exportPlatformAuditLogs(query: PlatformAuditExportQuery): Promise<Blob> {
  return pendingApi("platform.audit_export", () => pendingPlatformAuditExport.csv(query));
}

/* ── System health (real `GET /platform/health`; history `platform.health_history`) ── */

/**
 * The live health report. While health history is pending, every report read
 * here is also kept by its local implementation, so the history reflects real
 * checks. Needs `platform.health.read`.
 */
export async function getPlatformHealth(): Promise<SystemHealth> {
  const report = await workspaceDirectoryApi.platform.health();
  if (isPendingFeatureEnabled("platform.health_history")) pendingPlatformHealthHistory.record(report);
  return report;
}

/** `no_data`: no check ran that day. */
export type PlatformHealthDayStatus = "healthy" | "issues" | "no_data";

export interface PlatformHealthDay {
  /** UTC date. */
  date: string;
  status: PlatformHealthDayStatus;
  checks: number;
}

export interface PlatformHealthServiceHistory {
  /** The `/platform/health` service name. */
  name: string;
  checks: number;
  /** Healthy checks over probed checks; null when it was never probed in the window. */
  uptime_percent: number | null;
  /** One entry per day of the window, oldest first. */
  daily: PlatformHealthDay[];
}

export interface PlatformHealthIncident {
  id: string;
  service: string;
  /** The worst status seen while it lasted. */
  status: "degraded" | "unhealthy";
  error_category: string | null;
  started_at: string;
  /** Null while it is still going on. */
  resolved_at: string | null;
}

export interface PlatformHealthHistory {
  days: number;
  start: string;
  generated_at: string;
  services: PlatformHealthServiceHistory[];
  /** Newest first. */
  incidents: PlatformHealthIncident[];
}

/** Daily status, uptime and incidents per service. Needs `platform.health.read`. */
export function getPlatformHealthHistory(query: { days: number }): Promise<PlatformHealthHistory> {
  return pendingApi("platform.health_history", () => pendingPlatformHealthHistory.get(query.days));
}

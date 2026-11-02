/**
 * Workspace settings the API does not serve yet. The name is real
 * (`PATCH /workspaces/{workspace_id}` through the directory client); the web
 * address, brand colour and archive are pending
 * (`api_contract.md#proposed-workspace-url-code`, `#proposed-workspace-branding`,
 * `#proposed-workspace-archive`). Each write invalidates API data so the shell
 * and every open screen re-read what changed.
 */

import { invalidateApiData } from "@/lib/api/revision";
import { pendingApi } from "@/lib/api/pending";
import * as pendingWorkspaceSettings from "@/lib/api/pending/workspace-settings";

export interface WorkspaceArchiveRequest {
  /** The workspace URL code, typed by the person to confirm. */
  confirm_code: string;
}

export interface WorkspaceArchive {
  workspace_id: string;
  status: "archived";
  archived_at: string;
  archived_by: { id: string; display_name: string | null };
}

/** The accent palette a workspace may choose (token `html[data-accent]` values). */
export const WORKSPACE_ACCENTS = ["indigo", "teal", "ocean", "plum", "graphite"] as const;
export type WorkspaceAccent = (typeof WORKSPACE_ACCENTS)[number];

/** `Workspace.settings.branding`. */
export interface WorkspaceBranding {
  accent: WorkspaceAccent;
  /** Null while the workspace uses the default color. */
  updated_at: string | null;
}

export interface WorkspaceBrandingUpdate {
  accent: WorkspaceAccent;
}

/** The workspace's web address (`Workspace.code`) and when it last changed. */
export interface WorkspaceCode {
  code: string;
  /** Null while the workspace keeps the address it was created with. */
  updated_at: string | null;
}

export interface WorkspaceCodeUpdate {
  code: string;
}

/** API pending: `POST /workspaces/{workspace_id}/archive` (`tenant.manage`). */
export async function archiveWorkspace(workspaceId: string, body: WorkspaceArchiveRequest): Promise<WorkspaceArchive> {
  const archive = await pendingApi("workspace.archive", () => pendingWorkspaceSettings.archiveWorkspace(workspaceId, body));
  invalidateApiData();
  return archive;
}

/** API pending: `status`/`archived_at` of `GET /workspaces/{workspace_id}`; null while active. */
export async function getWorkspaceArchive(workspaceId: string): Promise<WorkspaceArchive | null> {
  return pendingApi("workspace.archive", () => pendingWorkspaceSettings.getWorkspaceArchive(workspaceId));
}

/** API pending: `settings.branding` of `GET /workspaces/{workspace_id}` (any member). */
export async function getWorkspaceBranding(workspaceId: string): Promise<WorkspaceBranding> {
  return pendingApi("workspace.branding", () => pendingWorkspaceSettings.getWorkspaceBranding(workspaceId));
}

/** API pending: `PATCH /workspaces/{workspace_id}` `{ settings: { branding } }` (`tenant.manage`). */
export async function updateWorkspaceBranding(
  workspaceId: string,
  body: WorkspaceBrandingUpdate,
): Promise<WorkspaceBranding> {
  const branding = await pendingApi("workspace.branding", () => pendingWorkspaceSettings.updateWorkspaceBranding(workspaceId, body));
  // The shell re-reads the brand accent for everyone who follows it.
  invalidateApiData();
  return branding;
}

/** API pending: `code` of `GET /workspaces/{workspace_id}`, including a change not yet on the server. */
export async function getWorkspaceCode(workspaceId: string): Promise<WorkspaceCode> {
  return pendingApi("workspace.url_code", () => pendingWorkspaceSettings.getWorkspaceCode(workspaceId));
}

/** API pending: `PATCH /workspaces/{workspace_id}` `{ code }` (`tenant.manage`); 409 when taken, 422 when malformed. */
export async function updateWorkspaceCode(workspaceId: string, body: WorkspaceCodeUpdate): Promise<WorkspaceCode> {
  const code = await pendingApi("workspace.url_code", () => pendingWorkspaceSettings.updateWorkspaceCode(workspaceId, body));
  invalidateApiData();
  return code;
}

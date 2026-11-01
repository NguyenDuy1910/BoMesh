/**
 * Local implementations of `workspace.archive` (proposed
 * `POST /workspaces/{workspace_id}/archive`), `workspace.branding` (proposed
 * `settings.branding` on `GET`/`PATCH /workspaces/{workspace_id}`) and
 * `workspace.url_code` (proposed `code` on `PATCH /workspaces/{workspace_id}`).
 *
 * All three are workspace-wide, so their stores are not per account.
 * Archiving here only records the request in this browser, and a changed web
 * address is only known to this browser: the real workspace keeps its status
 * and code until the endpoints exist.
 */
import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission, type PendingCaller } from "@/lib/api/pending";
import {
  WORKSPACE_ACCENTS,
  type WorkspaceArchive,
  type WorkspaceArchiveRequest,
  type WorkspaceBranding,
  type WorkspaceBrandingUpdate,
  type WorkspaceCode,
  type WorkspaceCodeUpdate,
} from "@/modules/manage/settings/api";
import { workspaceCodeProblem } from "@/modules/platform/workspace-code";

const archiveStore = (workspaceId: string) =>
  pendingStore<WorkspaceArchive | null>("workspace.archive", null, workspaceId, () => null);

const codeStore = (workspaceId: string) =>
  pendingStore<WorkspaceCode | null>("workspace.url_code", null, workspaceId, () => null);

/** The address the workspace answers to here: a change made in this browser, else the real one. */
function currentCode(caller: PendingCaller, workspaceId: string): WorkspaceCode {
  return codeStore(workspaceId).read() ?? { code: caller.workspace?.code ?? "", updated_at: null };
}

export function getWorkspaceArchive(workspaceId: string): WorkspaceArchive | null {
  requirePendingPermission(pendingCaller(workspaceId), null, "");
  return archiveStore(workspaceId).read();
}

export function archiveWorkspace(workspaceId: string, body: WorkspaceArchiveRequest): WorkspaceArchive {
  const caller = pendingCaller(workspaceId);
  requirePendingPermission(caller, "tenant.manage", "You don't have permission to archive this workspace.");
  const store = archiveStore(workspaceId);
  if (store.read()) throw new ApiError("This workspace is already archived.", 409);
  // The URL code is what the person types to prove they mean this workspace.
  const { code } = currentCode(caller, workspaceId);
  if (!code || body.confirm_code.trim() !== code) {
    throw new ApiError("Type the workspace URL code exactly as shown to confirm.", 422);
  }
  const archive: WorkspaceArchive = {
    workspace_id: workspaceId,
    status: "archived",
    archived_at: new Date().toISOString(),
    archived_by: { id: caller.accountId!, display_name: caller.displayName ?? caller.email },
  };
  store.write(archive);
  return archive;
}

const brandingStore = (workspaceId: string) =>
  pendingStore<WorkspaceBranding>("workspace.branding", null, workspaceId, () => ({ accent: "indigo", updated_at: null }));

export function getWorkspaceBranding(workspaceId: string): WorkspaceBranding {
  requirePendingPermission(pendingCaller(workspaceId), null, "");
  return brandingStore(workspaceId).read();
}

export function updateWorkspaceBranding(workspaceId: string, body: WorkspaceBrandingUpdate): WorkspaceBranding {
  const caller = pendingCaller(workspaceId);
  requirePendingPermission(caller, "tenant.manage", "You don't have permission to change the workspace color.");
  if (!WORKSPACE_ACCENTS.includes(body.accent)) throw new ApiError("Choose one of the listed colors.", 422);
  return brandingStore(workspaceId).write({ accent: body.accent, updated_at: new Date().toISOString() });
}

export function getWorkspaceCode(workspaceId: string): WorkspaceCode {
  const caller = pendingCaller(workspaceId);
  requirePendingPermission(caller, null, "");
  return currentCode(caller, workspaceId);
}

export function updateWorkspaceCode(workspaceId: string, body: WorkspaceCodeUpdate): WorkspaceCode {
  const caller = pendingCaller(workspaceId);
  requirePendingPermission(caller, "tenant.manage", "You don't have permission to change the web address.");
  const code = body.code.trim();
  const problem = workspaceCodeProblem(code);
  if (problem) throw new ApiError(problem, 422);
  const current = currentCode(caller, workspaceId);
  if (code === current.code) return current;
  // Addresses are unique across every workspace. This browser only knows the
  // caller's own workspaces; the server checks all of them.
  const taken = caller.session?.workspaces.find((workspace) => workspace.id !== workspaceId && workspace.code === code);
  if (taken) throw new ApiError(`That address is already used by ${taken.name}. Try another.`, 409);
  const changed: WorkspaceCode = { code, updated_at: new Date().toISOString() };
  codeStore(workspaceId).write(changed);
  return changed;
}

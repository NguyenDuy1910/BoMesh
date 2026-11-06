import { api, call, type Schema } from "@/lib/api/client";

export type Workspace = Schema<"Workspace">;
export type WorkspaceSettings = Schema<"WorkspaceSettings">;

/** UpdateWorkspace (`workspaces.update`): `displayName` and `code`; `etag` guards concurrent edits. */
export function updateWorkspace(workspace: string, body: Partial<Pick<Workspace, "displayName" | "code" | "etag">>, updateMask: string): Promise<Workspace> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}", {
      params: { path: { workspace }, query: { updateMask } },
      body: body as Workspace,
    }),
  );
}

/** UpdateWorkspaceSettings (`workspaces.updateSettings`). */
export function updateSettings(workspace: string, body: WorkspaceSettings, updateMask: string): Promise<WorkspaceSettings> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/settings", {
      params: { path: { workspace }, query: { updateMask } },
      body,
    }),
  );
}

/** ArchiveWorkspace (`workspaces.archive`): `confirmationCode` must equal the workspace code. */
export function archiveWorkspace(workspace: string, confirmationCode: string, etag?: string): Promise<Workspace> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}:archive", {
      params: { path: { workspace } },
      body: { confirmationCode, etag },
    }),
  );
}

/** ActivateWorkspace (`workspaces.activate`, platform operators): restores an archived workspace. */
export function activateWorkspace(workspace: string): Promise<Workspace> {
  return call(api.POST("/api/v1/workspaces/{workspace}:activate", { params: { path: { workspace } }, body: {} }));
}

import { api, call, type Schema } from "@/lib/api/client";

export type Workspace = Schema<"Workspace">;
export type WorkspaceSettings = Schema<"WorkspaceSettings">;

/** UpdateWorkspace (`workspaces.update`): `displayName`, `code` and `visibility`; `etag` guards concurrent edits. */
export function updateWorkspace(
  workspace: string,
  body: Partial<Pick<Workspace, "displayName" | "code" | "visibility" | "etag">>,
  updateMask: string,
): Promise<Workspace> {
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

/** UploadMapBackground (`workspaces.updateSettings`): one JPEG/PNG/WebP `file` part; keeps the saved strength. */
export function uploadMapBackground(workspace: string, image: Blob, fileName: string): Promise<WorkspaceSettings> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/settings:uploadMapBackground", {
      params: { path: { workspace } },
      // The schema types the binary part as a string; the request carries the image itself as multipart.
      body: { file: fileName },
      bodySerializer: () => {
        const form = new FormData();
        form.append("file", image, fileName);
        return form;
      },
    }),
  );
}

/** Map background strength (0–100), or no value to remove the background and its image. */
export function updateMapBackground(workspace: string, strength: number | null): Promise<WorkspaceSettings> {
  return strength === null
    ? updateSettings(workspace, {}, "branding.mapBackground")
    : updateSettings(workspace, { branding: { mapBackground: { strength } } }, "branding.mapBackground.strength");
}

/** UploadWorkspaceLogo (`workspaces.updateSettings`): one PNG/JPEG/WebP `file` part of at most 1 MB. */
export function uploadLogo(workspace: string, image: Blob, fileName: string): Promise<WorkspaceSettings> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/settings:uploadLogo", {
      params: { path: { workspace } },
      // The schema types the binary part as a string; the request carries the image itself as multipart.
      body: { file: fileName },
      bodySerializer: () => {
        const form = new FormData();
        form.append("file", image, fileName);
        return form;
      },
    }),
  );
}

/** Removes the workspace logo and deletes its image. */
export function removeLogo(workspace: string): Promise<WorkspaceSettings> {
  return updateSettings(workspace, {}, "branding.logo");
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

import { api, call, type Schema } from "@/lib/api/client";

export type WorkspaceAssistant = Schema<"WorkspaceAssistant">;

/** UpdateWorkspaceAssistant (`workspaces.updateAssistant`); `etag` in the body guards concurrent edits. */
export function updateAssistant(workspace: string, body: WorkspaceAssistant, updateMask: string): Promise<WorkspaceAssistant> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/assistant", {
      params: { path: { workspace }, query: { updateMask } },
      body,
    }),
  );
}

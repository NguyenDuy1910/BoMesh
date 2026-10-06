/**
 * Local implementation of `platform.workspace_admin`. Imported only by
 * `modules/platform/api.ts`.
 *
 * Reads the REAL `/platform/workspaces` list and layers this browser's changes
 * on it: workspaces created here (kept only here, `source: "local"`) and
 * status overrides keyed by the real workspace id. Code uniqueness is checked
 * against both.
 */

import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPlatformPermission } from "@/lib/api/pending";
import { workspaceDirectoryApi } from "@/modules/manage/access/directory";
import type { PlatformWorkspace, PlatformWorkspaceCreate, PlatformWorkspaceStatus } from "@/modules/platform/api";
import { workspaceCodeProblem } from "@/modules/platform/workspace-code";

interface WorkspaceAdminState {
  created: PlatformWorkspace[];
  /** Real workspace id → status set here. */
  status: Record<string, { status: PlatformWorkspaceStatus; updated_at: string }>;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function authorizedStore() {
  const caller = pendingCaller(null);
  // Mirrors the proposed `platform.tenant.manage`, which no session holds yet.
  requirePendingPlatformPermission(caller, "platform.tenant.read", "You need platform permission to manage workspaces.");
  return pendingStore<WorkspaceAdminState>("platform.workspace_admin", caller.accountId, null, () => ({ created: [], status: {} }));
}

async function serverWorkspaces(search: string): Promise<PlatformWorkspace[]> {
  const page = await workspaceDirectoryApi.platform.workspaces(search);
  return page.items.map((workspace) => ({ ...workspace, source: "server" as const, changed_locally: false }));
}

function withOverrides(rows: PlatformWorkspace[], state: WorkspaceAdminState): PlatformWorkspace[] {
  return rows.map((row) => {
    const override = state.status[row.id];
    return override
      ? { ...row, status: override.status, updated_at: override.updated_at, changed_locally: row.source === "server" }
      : row;
  });
}

export const pendingPlatformWorkspaces = {
  async list(search: string): Promise<PlatformWorkspace[]> {
    const store = authorizedStore();
    const state = store.read();
    const needle = search.trim().toLowerCase();
    const local = state.created.filter((row) =>
      !needle || row.name.toLowerCase().includes(needle) || row.code.includes(needle),
    );
    return withOverrides([...local, ...(await serverWorkspaces(search.trim()))], state);
  },

  async create(body: PlatformWorkspaceCreate): Promise<PlatformWorkspace> {
    const store = authorizedStore();
    const name = body.name?.trim() ?? "";
    const code = body.code?.trim() ?? "";
    const email = body.owner_email?.trim().toLowerCase() ?? "";
    if (name.length < 2 || name.length > 255) throw new ApiError("Use 2 to 255 characters for the workspace name.", 422);
    const codeProblem = workspaceCodeProblem(code);
    if (codeProblem) throw new ApiError(codeProblem, 422);
    if (!EMAIL_PATTERN.test(email)) throw new ApiError("Enter a full email address, like sam@company.com.", 422);

    const state = store.read();
    const taken = state.created.find((row) => row.code === code)
      ?? (await serverWorkspaces(code)).find((row) => row.code === code);
    if (taken) throw new ApiError(`The web address “${code}” is already used by ${taken.name}. Try another.`, 409);

    const now = new Date().toISOString();
    const workspace: PlatformWorkspace = {
      id: `local-${code}`,
      code,
      name,
      status: "active",
      settings: {},
      created_at: now,
      updated_at: now,
      owner: { display_name: null, email },
      member_count: 0,
      connection_count: 0,
      source: "local",
      changed_locally: false,
    };
    store.update((current) => ({ ...current, created: [workspace, ...current.created] }));
    return workspace;
  },

  async update(workspaceId: string, body: { status: PlatformWorkspaceStatus }): Promise<PlatformWorkspace> {
    const store = authorizedStore();
    if (body?.status !== "active" && body?.status !== "suspended") {
      throw new ApiError("A workspace is either active or suspended.", 422);
    }
    const updatedAt = new Date().toISOString();
    const state = store.read();
    const local = state.created.find((row) => row.id === workspaceId);
    if (local) {
      const updated = { ...local, status: body.status, updated_at: updatedAt };
      store.write({ ...state, created: state.created.map((row) => (row.id === workspaceId ? updated : row)) });
      return updated;
    }
    const server = (await serverWorkspaces("")).find((row) => row.id === workspaceId);
    if (!server) throw new ApiError("This workspace no longer exists.", 404);
    const next = store.write({
      ...state,
      status: { ...state.status, [workspaceId]: { status: body.status, updated_at: updatedAt } },
    });
    return withOverrides([server], next)[0];
  },
};

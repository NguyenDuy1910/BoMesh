/**
 * Local implementation of `platform.user_admin`. Imported only by
 * `modules/platform/api.ts`.
 *
 * Reads the REAL `/platform/users` list and applies overrides set in this
 * browser, keyed by the real user id. The server does not report platform
 * roles yet, so `is_platform_admin` is null unless it was set here — except
 * for the caller, whose own platform grants are in the session.
 */

import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPlatformPermission, type PendingCaller } from "@/lib/api/pending";
import { workspaceDirectoryApi } from "@/modules/manage/access/directory";
import type { PlatformUser, PlatformUserUpdate } from "@/modules/platform/api";

/** User id → what was changed here. */
type UserOverrides = Record<string, PlatformUserUpdate & { updated_at: string }>;

function authorize() {
  const caller = pendingCaller(null);
  // Mirrors the proposed `platform.user.manage`, which no session holds yet.
  requirePendingPlatformPermission(caller, "platform.user.read", "You need platform permission to manage accounts.");
  const store = pendingStore<UserOverrides>("platform.user_admin", caller.accountId, null, () => ({}));
  return { caller, store };
}

async function serverUsers(caller: PendingCaller, search: string, overrides: UserOverrides): Promise<PlatformUser[]> {
  const page = await workspaceDirectoryApi.platform.users(search);
  return page.items.map((user) => {
    const override = overrides[user.id];
    const self = user.id === caller.accountId;
    return {
      ...user,
      status: override?.status ?? user.status,
      is_platform_admin: override?.is_platform_admin ?? (self ? caller.platformPermissions.length > 0 : null),
      changed_locally: Boolean(override),
    };
  });
}

export const pendingPlatformUsers = {
  async list(search: string): Promise<PlatformUser[]> {
    const { caller, store } = authorize();
    return serverUsers(caller, search.trim(), store.read());
  },

  async update(userId: string, body: PlatformUserUpdate): Promise<PlatformUser> {
    const { caller, store } = authorize();
    const hasRole = body?.is_platform_admin !== undefined;
    const hasStatus = body?.status !== undefined;
    if (!hasRole && !hasStatus) throw new ApiError("Change the platform role, the account status, or both.", 422);
    if (hasRole && typeof body.is_platform_admin !== "boolean") throw new ApiError("Say whether they are a platform admin.", 422);
    if (hasStatus && body.status !== "active" && body.status !== "suspended") {
      throw new ApiError("An account is either active or suspended.", 422);
    }
    if (userId === caller.accountId) {
      throw new ApiError("You can’t change your own platform role or account status. Ask another platform admin.", 403);
    }
    const overrides = store.read();
    const target = (await serverUsers(caller, "", overrides)).find((user) => user.id === userId);
    if (!target) throw new ApiError("This account no longer exists.", 404);
    const change: PlatformUserUpdate & { updated_at: string } = {
      ...overrides[userId],
      ...(hasRole ? { is_platform_admin: body.is_platform_admin } : {}),
      ...(hasStatus ? { status: body.status } : {}),
      updated_at: new Date().toISOString(),
    };
    store.write({ ...overrides, [userId]: change });
    return {
      ...target,
      status: change.status ?? target.status,
      is_platform_admin: change.is_platform_admin ?? target.is_platform_admin,
      changed_locally: true,
    };
  },
};

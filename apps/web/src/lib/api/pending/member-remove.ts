/**
 * Local implementation of `workspace.member_remove`. Imported only by
 * `modules/manage/access/api.ts`.
 *
 * The proposed `DELETE /users/{user_id}` tombstones the membership
 * (`tenant_memberships.deleted_at`); `POST /users` already readmits a removed
 * member with the roles given. Until the route exists, a removal is recorded
 * in this browser for the whole workspace and the member is hidden here only:
 * the server still lets them in. The guard rules mirror the contract — never
 * yourself, never the last member who can run the workspace.
 */

import { ApiError } from "@/lib/api/request";
import { pendingCaller, pendingStore, requirePendingPermission } from "@/lib/api/pending";
import { workspaceDirectoryApi } from "@/modules/manage/access/directory";
import type { RemovedMember } from "@/modules/manage/access/api";

type Removals = Record<string, RemovedMember>;

/** What running the workspace takes; the server checks its administrator role, the console reads what roles allow. */
const FULL_CONTROL = ["user.manage", "role.manage", "tenant.manage"];

function storeFor(workspaceId: string | null) {
  return pendingStore<Removals>("workspace.member_remove", null, workspaceId, () => ({}));
}

function authorize() {
  const caller = pendingCaller(null);
  requirePendingPermission(caller, "user.manage", "You need permission to manage members to remove someone.");
  return { caller, store: storeFor(caller.workspaceId) };
}

export const pendingMemberRemoval = {
  /** Members removed in this browser for the active workspace; empty when signed out. */
  list(): RemovedMember[] {
    const caller = pendingCaller(null);
    if (!caller.session) return [];
    return Object.values(storeFor(caller.workspaceId).read()).sort((left, right) => right.removed_at.localeCompare(left.removed_at));
  },

  async remove(userId: string): Promise<RemovedMember> {
    const { caller, store } = authorize();
    if (userId === caller.accountId) throw new ApiError("You can’t remove yourself. Ask another admin.", 409);
    const removals = store.read();
    const members = (await workspaceDirectoryApi.members()).items.filter((member) => !removals[member.id]);
    const target = members.find((member) => member.id === userId);
    if (!target) throw new ApiError("This person isn’t a member of the workspace.", 404);

    // The last member whose role runs the workspace stays. Roles are readable only with role.manage.
    const roles = await workspaceDirectoryApi.roles().then((page) => page.items).catch(() => null);
    if (roles) {
      const runsWorkspace = new Set(
        roles.filter((role) => FULL_CONTROL.every((code) => role.permission_codes.includes(code))).map((role) => role.id),
      );
      const isRunner = (member: (typeof members)[number]) =>
        member.status === "active" && member.roles.some((role) => runsWorkspace.has(role.id));
      if (isRunner(target) && !members.some((member) => member.id !== userId && isRunner(member))) {
        throw new ApiError("This is the workspace’s only admin. Make someone else an admin first.", 409);
      }
    }

    const removal: RemovedMember = {
      user_id: target.id,
      email: target.email,
      display_name: target.display_name,
      removed_at: new Date().toISOString(),
      removed_by: caller.accountId,
    };
    store.write({ ...removals, [userId]: removal });
    return removal;
  },

  /** Undo a local removal. On the server the same person is readmitted through `POST /users`. */
  async restore(userId: string): Promise<void> {
    const { store } = authorize();
    store.update((removals) => {
      const next = { ...removals };
      delete next[userId];
      return next;
    });
  },
};

/**
 * People & access client functions whose API is still pending
 * (`backend/docs_design/api_contract.md`, "Proposed — UI built, API pending").
 * The real IAM calls live in `directory.ts`; only this module may import the
 * local implementations under `lib/api/pending/`.
 */

import { pendingApi } from "@/lib/api/pending";
import { pendingMemberRemoval } from "@/lib/api/pending/member-remove";
import { invalidateApiData } from "@/lib/api/revision";

/** A membership removed from the workspace (proposed `DELETE /users/{user_id}` response). */
export interface RemovedMember {
  user_id: string;
  email: string;
  display_name: string | null;
  removed_at: string;
  removed_by: string | null;
}

/** Remove someone from this workspace: proposed `DELETE /users/{user_id}` (`user.manage`; 409 for yourself or the last admin). */
export async function removeWorkspaceMember(userId: string): Promise<RemovedMember> {
  const removed = await pendingApi("workspace.member_remove", () => pendingMemberRemoval.remove(userId));
  invalidateApiData();
  return removed;
}

/** Undo a removal made in this browser. On the server, `POST /users` readmits a removed member. */
export async function restoreWorkspaceMember(userId: string): Promise<void> {
  await pendingApi("workspace.member_remove", () => pendingMemberRemoval.restore(userId));
  invalidateApiData();
}

/** Members removed in this browser for the active workspace, newest first. Synchronous overlay; part of the key. */
export function listRemovedMembers(): RemovedMember[] {
  return pendingMemberRemoval.list();
}

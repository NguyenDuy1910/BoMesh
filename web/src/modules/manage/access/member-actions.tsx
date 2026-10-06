"use client";

import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { RadioGroup } from "@/components/ui/Radio";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { useToast } from "@/components/ui/Toast";
import { accessErrorMessage, canGrant, memberRoleId, type RoleChoice } from "@/modules/manage/access/access-model";
import { removeWorkspaceMember, restoreWorkspaceMember } from "@/modules/manage/access/api";
import { describeAccess } from "@/modules/manage/access/capabilities";
import { memberName, workspaceDirectoryApi, type GroupRef, type Member } from "@/modules/manage/access/directory";
import { pluralize } from "@/lib/format";

type StandingChange = { kind: "suspend" | "reactivate"; members: Member[]; after?: () => void; open: boolean };

/** Everything the members table and member drawer can do to a membership. */
export interface MemberActions {
  /** Member id → role id chosen but not yet confirmed by a refetch. */
  pendingRoles: Record<string, string>;
  changeRole: (members: Member[], roleId: string) => Promise<void>;
  addToGroup: (members: Member[], group: GroupRef) => Promise<void>;
  removeFromGroup: (member: Member, group: GroupRef) => Promise<void>;
  suspend: (members: Member[], after?: () => void) => void;
  reactivate: (members: Member[], after?: () => void) => void;
  openChangeRole: (members: Member[], after?: () => void) => void;
  /** Asks, then removes the membership (API pending: hidden in this browser only). */
  remove: (member: Member, after?: () => void) => void;
  /** The confirmation and role dialogs; render once. */
  dialogs: React.ReactNode;
}

/**
 * Every change to someone's membership, shared by the members table and the
 * member drawer so both behave the same. The server refuses any change to the
 * caller's own access, so the caller is skipped and told why rather than
 * sent to a request that can only fail.
 */
export function useMemberActions({
  callerId,
  roles,
  callerPermissions,
}: {
  callerId: string | null;
  roles: RoleChoice[];
  callerPermissions: readonly string[];
}): MemberActions {
  const toast = useToast();
  /** Role chosen in a select but not confirmed by a refetch yet, so the select does not snap back. */
  const [pendingRoles, setPendingRoles] = useState<Record<string, string>>({});
  const [standing, setStanding] = useState<StandingChange | null>(null);
  const [roleDialog, setRoleDialog] = useState<{ members: Member[]; after?: () => void } | null>(null);
  const [removing, setRemoving] = useState<{ member: Member; after?: () => void; open: boolean } | null>(null);

  const others = (members: Member[]) => {
    const rest = members.filter((member) => member.id !== callerId);
    if (rest.length < members.length && members.length > 1) {
      toast.show({ tone: "info", message: "You were skipped", description: "You can’t change your own access. Another admin can." });
    }
    return rest;
  };

  const roleName = (roleId: string) => roles.find((role) => role.id === roleId)?.name ?? "the new role";

  /** Set each member's role; the result toast offers Undo, which puts each changed member back. */
  async function changeRole(members: Member[], roleId: string) {
    const targets = others(members).filter((member) => memberRoleId(member) !== roleId);
    if (!targets.length) return;
    setPendingRoles((current) => ({ ...current, ...Object.fromEntries(targets.map((member) => [member.id, roleId])) }));
    const results = await Promise.allSettled(
      targets.map((member) => workspaceDirectoryApi.saveMember(member.id, { role_ids: [roleId] })),
    );
    setPendingRoles((current) => {
      const next = { ...current };
      for (const member of targets) delete next[member.id];
      return next;
    });
    const changed = targets.filter((_, index) => results[index].status === "fulfilled");
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) {
      toast.show({
        tone: "err",
        message: changed.length ? `Changed ${pluralize(changed.length, "member")}; ${targets.length - changed.length} failed` : "Role not changed",
        description: accessErrorMessage(failed.reason, "The role couldn’t be changed."),
      });
    }
    if (!changed.length) return;
    const previous = changed.map((member) => [member, memberRoleId(member)] as const);
    toast.show({
      message: changed.length > 1 ? `${changed.length} members are now ${roleName(roleId)}` : `${memberName(changed[0])} is now ${roleName(roleId)}`,
      action: {
        label: "Undo",
        onClick: () => {
          void Promise.allSettled(
            previous.map(([member, before]) => workspaceDirectoryApi.saveMember(member.id, { role_ids: before ? [before] : [] })),
          ).then((undone) => {
            const failure = undone.find((result): result is PromiseRejectedResult => result.status === "rejected");
            toast.show(
              failure
                ? { tone: "err", message: "Couldn’t undo the role change", description: accessErrorMessage(failure.reason, "Try changing it back by hand.") }
                : { tone: "info", message: "Role change undone" },
            );
          });
        },
      },
    });
  }

  async function addToGroup(members: Member[], group: GroupRef) {
    const targets = others(members).filter((member) => !member.groups.some((item) => item.id === group.id));
    if (!targets.length) {
      toast.show({ tone: "info", message: `Everyone selected is already in ${group.display_name}` });
      return;
    }
    const results = await Promise.allSettled(
      targets.map((member) =>
        workspaceDirectoryApi.saveMember(member.id, { group_ids: [...member.groups.map((item) => item.id), group.id] }),
      ),
    );
    const added = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) {
      toast.show({ tone: "err", message: `Couldn’t add ${targets.length - added} to ${group.display_name}`, description: accessErrorMessage(failed.reason, "Try again.") });
    }
    if (added) {
      toast.show({ message: targets.length === 1 && added === 1 ? `Added ${memberName(targets[0])} to ${group.display_name}` : `Added ${pluralize(added, "person", "people")} to ${group.display_name}` });
    }
  }

  async function removeFromGroup(member: Member, group: GroupRef) {
    const before = member.groups.map((item) => item.id);
    try {
      await workspaceDirectoryApi.saveMember(member.id, { group_ids: before.filter((id) => id !== group.id) });
    } catch (cause) {
      toast.show({ tone: "err", message: `Couldn’t remove ${memberName(member)} from ${group.display_name}`, description: accessErrorMessage(cause, "Try again.") });
      return;
    }
    toast.show({
      message: `Removed ${memberName(member)} from ${group.display_name}`,
      action: {
        label: "Undo",
        onClick: () => {
          void workspaceDirectoryApi.saveMember(member.id, { group_ids: before }).catch((cause: unknown) =>
            toast.show({ tone: "err", message: "Couldn’t undo", description: accessErrorMessage(cause, "Add them to the group again.") }),
          );
        },
      },
    });
  }

  function requestStanding(kind: StandingChange["kind"], members: Member[], after?: () => void) {
    const targets = others(members).filter((member) =>
      kind === "suspend" ? member.status === "active" : member.status === "suspended",
    );
    if (!targets.length) {
      toast.show({ tone: "info", message: kind === "suspend" ? "No one selected can be suspended" : "No one selected is suspended" });
      return;
    }
    setStanding({ kind, members: targets, after, open: true });
  }

  const single = standing?.members.length === 1 ? standing.members[0] : null;
  const subject = single ? memberName(single).split(/\s+/)[0] : "They";

  const dialogs = (
    <>
      <ConfirmDialog
        confirmLabel={standing?.kind === "suspend" ? "Suspend" : "Reactivate"}
        description={
          standing?.kind === "suspend"
            ? `${subject} won’t be able to open this workspace until you reactivate them. Their account, other workspaces and everything they own stay as they are.`
            : `${subject} can open this workspace again with the same role and groups.`
        }
        destructive={standing?.kind === "suspend"}
        onClose={() => setStanding((current) => current && { ...current, open: false })}
        onConfirm={async () => {
          if (!standing) return;
          const status = standing.kind === "suspend" ? "suspended" : "active";
          const results = await Promise.allSettled(
            standing.members.map((member) => workspaceDirectoryApi.saveMember(member.id, { status })),
          );
          const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failed && results.every((result) => result.status === "rejected")) {
            throw new Error(accessErrorMessage(failed.reason, "Nothing changed. Try again."));
          }
          const done = standing.members.filter((_, index) => results[index].status === "fulfilled");
          const verb = standing.kind === "suspend" ? "Suspended" : "Reactivated";
          toast.show({ message: done.length === 1 ? `${verb} ${memberName(done[0])}` : `${verb} ${pluralize(done.length, "member")}` });
          if (failed) toast.show({ tone: "err", message: `${results.length - done.length} couldn’t be changed`, description: accessErrorMessage(failed.reason, "Try again.") });
          standing.after?.();
        }}
        open={Boolean(standing?.open)}
        title={
          standing?.kind === "suspend"
            ? single ? `Suspend ${memberName(single)}?` : `Suspend ${standing.members.length} members?`
            : single ? `Reactivate ${memberName(single)}?` : `Reactivate ${standing?.members.length ?? 0} members?`
        }
      />
      <ConfirmDialog
        confirmLabel="Remove"
        description={
          <>
            {removing ? memberName(removing.member).split(/\s+/)[0] : "They"} will lose access to this workspace. Their account and other workspaces stay, and you can add them back later.
            <span className="mt-2 flex items-center gap-2 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
              <PreviewTag /> Not connected to the server yet: they’re hidden in this browser only.
            </span>
          </>
        }
        onClose={() => setRemoving((current) => current && { ...current, open: false })}
        onConfirm={async () => {
          if (!removing) return;
          const { member, after } = removing;
          try {
            await removeWorkspaceMember(member.id);
          } catch (cause) {
            throw new Error(accessErrorMessage(cause, `${memberName(member)} wasn’t removed. Try again.`));
          }
          toast.show({
            message: `Removed ${memberName(member)}`,
            action: {
              label: "Undo",
              onClick: () => {
                void restoreWorkspaceMember(member.id).catch((cause: unknown) =>
                  toast.show({ tone: "err", message: "Couldn’t undo", description: accessErrorMessage(cause, "Add them back from Add member.") }),
                );
              },
            },
          });
          after?.();
        }}
        open={Boolean(removing?.open)}
        title={removing ? `Remove ${memberName(removing.member)}?` : "Remove member?"}
      />
      {roleDialog && (
        <ChangeRoleDialog
          callerPermissions={callerPermissions}
          members={roleDialog.members}
          onClose={() => setRoleDialog(null)}
          onSave={async (roleId) => {
            await changeRole(roleDialog.members, roleId);
            setRoleDialog(null);
            roleDialog.after?.();
          }}
          roles={roles}
        />
      )}
    </>
  );

  return {
    pendingRoles,
    changeRole,
    addToGroup,
    removeFromGroup,
    suspend: (members: Member[], after?: () => void) => requestStanding("suspend", members, after),
    reactivate: (members: Member[], after?: () => void) => requestStanding("reactivate", members, after),
    openChangeRole: (members: Member[], after?: () => void) => {
      const targets = others(members);
      if (targets.length) setRoleDialog({ members: targets, after });
    },
    remove: (member: Member, after?: () => void) => {
      if (member.id !== callerId) setRemoving({ member, after, open: true });
    },
    dialogs,
  };
}

/** Pick one role for one or several members; each choice says what it allows. */
function ChangeRoleDialog({
  members,
  roles,
  callerPermissions,
  onClose,
  onSave,
}: {
  members: Member[];
  roles: RoleChoice[];
  callerPermissions: readonly string[];
  onClose: () => void;
  onSave: (roleId: string) => Promise<void>;
}) {
  const current = members.length === 1 ? memberRoleId(members[0]) : "";
  const [roleId, setRoleId] = useState(current);
  const [busy, setBusy] = useState(false);
  const one = members.length === 1;

  return (
    <Dialog
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button
            disabled={!roleId || roleId === current}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(roleId);
              } finally {
                setBusy(false);
              }
            }}
          >
            Change role
          </Button>
        </>
      }
      onClose={onClose}
      open
      title={one ? `Change role for ${memberName(members[0])}` : `Change role for ${members.length} members`}
    >
      <RadioGroup
        aria-label="Role"
        name="change-role"
        onChange={setRoleId}
        options={roles
          .filter((role) => role.active || role.id === current)
          .map((role) => ({
            value: role.id,
            label: role.name,
            description: !canGrant(role, callerPermissions)
              ? "Allows more than you can give"
              : role.permissions
                ? describeAccess(role.permissions)
                : undefined,
            disabled: !canGrant(role, callerPermissions),
          }))}
        value={roleId}
      />
    </Dialog>
  );
}

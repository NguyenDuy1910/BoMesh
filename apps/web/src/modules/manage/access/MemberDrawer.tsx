"use client";

import { Check, Pause, Play, Plus, Trash2, User, Users } from "lucide-react";

import { Avatar } from "@/components/ui/Avatar";
import { Button, ButtonLink } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { Menu, MenuItem, MenuLabel, type MenuTriggerProps } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tag } from "@/components/ui/Tag";
import { Tooltip } from "@/components/ui/Tooltip";
import { memberRoleId, roleOptions, SELF_LOCK, type LastActive, type RoleChoice } from "@/modules/manage/access/access-model";
import { abilitySentences, describeAccess } from "@/modules/manage/access/capabilities";
import { memberName, memberStatus, type GroupRef, type KnowledgeGrants, type Member } from "@/modules/manage/access/directory";
import { KnowledgeAccessList, knowledgeAccessRows } from "@/modules/manage/access/KnowledgeAccessList";
import type { MemberActions } from "@/modules/manage/access/member-actions";
import { formatDateTime, formatRelative } from "@/lib/format";

/**
 * One member: their role and what it allows, their groups, the knowledge
 * they can open and where to see what they did. Opened from a row, a search
 * result or a link (`?member=<id>`).
 */
export function MemberDrawer({
  memberId,
  member,
  loading,
  roles,
  groups,
  grants,
  lastActive,
  callerId,
  callerPermissions,
  actions,
  onClose,
  removeEnabled,
}: {
  memberId: string | null;
  member: Member | null;
  loading: boolean;
  roles: RoleChoice[];
  groups: GroupRef[];
  grants: KnowledgeGrants | null | undefined;
  lastActive: LastActive | null;
  callerId: string | null;
  callerPermissions: readonly string[];
  actions: MemberActions;
  onClose: () => void;
  removeEnabled: boolean;
}) {
  if (!memberId) return null;
  if (!member) {
    return (
      <Drawer onClose={onClose} open title={loading ? "Loading member" : "Member not found"}>
        {loading ? (
          <SkeletonRows columns={2} label="Loading member" rows={5} />
        ) : (
          <EmptyState description="They may have been removed, or the link is out of date." icon={<User />} size="md" title="This person isn’t a member" />
        )}
      </Drawer>
    );
  }

  const isSelf = member.id === callerId;
  const name = memberName(member);
  const roleId = actions.pendingRoles[member.id] ?? memberRoleId(member);
  const role = roles.find((item) => item.id === roleId) ?? null;
  const freeGroups = groups.filter((group) => !member.groups.some((item) => item.id === group.id));
  const suspended = memberStatus(member) === "suspended";
  const accountDisabled = member.status === "inactive";
  const opensEverything = Boolean(role?.permissions?.includes("collection.read"));
  const canSeeActivity = callerPermissions.includes("audit.read");

  const standingButton = suspended ? (
    !accountDisabled && (
      <Button icon={<Play aria-hidden="true" size={16} />} onClick={() => actions.reactivate([member])} variant="secondary">
        Reactivate
      </Button>
    )
  ) : (
    <Button disabled={isSelf} icon={<Pause aria-hidden="true" size={16} />} onClick={() => actions.suspend([member])} variant="secondary">
      Suspend
    </Button>
  );

  return (
    <Drawer
      description={member.email}
      footer={
        isSelf ? (
          <Tooltip label="You can’t suspend or remove yourself. Another admin can.">
            <span className="inline-flex" tabIndex={0}>{standingButton}</span>
          </Tooltip>
        ) : (
          <>
            {removeEnabled && (
              <Button className="mr-auto" icon={<Trash2 aria-hidden="true" size={16} />} onClick={() => actions.remove(member, onClose)} variant="danger-ghost">
                Remove
              </Button>
            )}
            {standingButton}
          </>
        )
      }
      header={suspended && <div className="mt-2"><StatusBadge kind="member" value="suspended" /></div>}
      icon={<Avatar className="h-10 w-10 text-[length:var(--text-size-meta)]" name={name} />}
      onClose={onClose}
      open
      title={isSelf ? `${name} (you)` : name}
    >
      {accountDisabled && (
        <Callout className="mb-5" tone="warn" title="Account disabled">
          Their BoMesh account is turned off everywhere, so they can’t sign in. A platform admin can turn it back on.
        </Callout>
      )}

      <DrawerSection title="Role">
        <Select
          aria-describedby={`member-role-help-${member.id}`}
          aria-label="Role"
          disabled={isSelf}
          onChange={(event) => void actions.changeRole([member], event.target.value)}
          options={roleOptions(roles, roleId, callerPermissions)}
          placeholder={roleId ? undefined : "No role"}
          value={roleId}
        />
        <p className="mt-1.5 text-[length:var(--text-size-meta)] text-[var(--text-secondary)]" id={`member-role-help-${member.id}`}>
          {isSelf ? SELF_LOCK : role?.permissions ? describeAccess(role.permissions) : "Choose what they can do in this workspace."}
        </p>
        {role?.permissions && role.permissions.length > 0 && (
          <>
            <h4 className="mb-2 mt-3.5 text-[length:var(--text-size-meta)] font-medium text-[var(--text-tertiary)]">What this role can do</h4>
            <ul className="grid gap-1.5 text-[13.5px] text-[var(--text-secondary)]">
              {abilitySentences(role.permissions).map((sentence) => (
                <li className="flex items-start gap-2" key={sentence}>
                  <Check aria-hidden="true" className="mt-[3px] shrink-0 text-[var(--status-success-text)]" size={14} />
                  <span>{sentence}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </DrawerSection>

      <DrawerSection
        actions={
          !isSelf && groups.length > 0 && (
            <Menu
              align="end"
              disabled={!freeGroups.length}
              trigger={(props: MenuTriggerProps) => (
                <Button {...props} disabled={props.disabled} icon={<Plus aria-hidden="true" size={14} />} size="sm" variant="secondary">
                  Add to group
                </Button>
              )}
            >
              <MenuLabel>Add {name.split(/\s+/)[0]} to</MenuLabel>
              {freeGroups.map((group) => (
                <MenuItem icon={<Users size={16} />} key={group.id} onSelect={() => void actions.addToGroup([member], group)}>
                  {group.display_name}
                </MenuItem>
              ))}
            </Menu>
          )
        }
        title="Groups"
      >
        {member.groups.length ? (
          <div className="flex flex-wrap gap-1.5">
            {member.groups.map((group) => (
              <Tag
                key={group.id}
                onRemove={isSelf ? undefined : () => void actions.removeFromGroup(member, group)}
                removeLabel={`Remove from ${group.display_name}`}
              >
                {group.display_name}
              </Tag>
            ))}
          </div>
        ) : (
          <p className="text-[13.5px] text-[var(--text-tertiary)]">Not in any group.</p>
        )}
      </DrawerSection>

      <DrawerSection title="Knowledge access">
        {opensEverything ? (
          <Callout tone="neutral">Their role lets them open every knowledge base in this workspace.</Callout>
        ) : grants ? (
          <KnowledgeAccessList
            empty="Nothing is shared with them or their groups yet."
            grants={grants}
            rows={knowledgeAccessRows(grants, [
              { type: "user", id: member.id, via: "Direct" },
              ...member.groups.map((group) => ({ type: "group" as const, id: group.id, via: `Group: ${group.display_name}` })),
            ])}
          />
        ) : (
          <KnowledgeAccessList empty="" grants={grants} rows={[]} />
        )}
      </DrawerSection>

      {canSeeActivity && (
        <DrawerSection title="Activity">
          {lastActive && (
            <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
              <dt className="text-[var(--text-tertiary)]">Last active</dt>
              <dd className="text-[var(--text-primary)]" title={lastActive[member.id] ? formatDateTime(lastActive[member.id]) : undefined}>
                {lastActive[member.id] ? formatRelative(lastActive[member.id]) : "Not in the last 30 days"}
              </dd>
            </dl>
          )}
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/manage/activity?tab=changes&person=${member.id}`} size="sm">View their changes</ButtonLink>
            <ButtonLink href={`/manage/activity?tab=signins&person=${member.id}`} size="sm">View sign-ins</ButtonLink>
          </div>
        </DrawerSection>
      )}
    </Drawer>
  );
}

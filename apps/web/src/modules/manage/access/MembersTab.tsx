"use client";

import { MoreHorizontal, Pause, Play, Shield, Trash2, User, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { BulkActionButton, DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { Menu, MenuItem, MenuLabel, MenuSeparator, type MenuTriggerProps } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { Select } from "@/components/ui/Select";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tag } from "@/components/ui/Tag";
import { Toolbar } from "@/components/ui/Toolbar";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import {
  memberRoleId,
  roleOptions,
  SELF_LOCK,
  type LastActive,
  type Loadable,
  type RoleChoice,
} from "@/modules/manage/access/access-model";
import { AddMemberDialog } from "@/modules/manage/access/AddMemberDialog";
import { listRemovedMembers, restoreWorkspaceMember } from "@/modules/manage/access/api";
import { memberName, memberStatus, type GroupRef, type KnowledgeGrants, type Member } from "@/modules/manage/access/directory";
import { useMemberActions, type MemberActions } from "@/modules/manage/access/member-actions";
import { MemberDrawer } from "@/modules/manage/access/MemberDrawer";
import { formatDateTime, formatRelative, pluralize } from "@/lib/format";

export interface MemberFilters {
  q: string;
  role: string;
  group: string;
  status: string;
}

export const EMPTY_MEMBER_FILTERS: MemberFilters = { q: "", role: "", group: "", status: "" };

const PAGE_SIZE = 20;
const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
];

export function MembersTab({
  members,
  roles,
  groups,
  grants,
  lastActive,
  callerId,
  callerPermissions,
  filters,
  onFiltersChange,
  addOpen,
  onAddOpenChange,
  openMemberId,
  onOpenMember,
  removeEnabled,
}: {
  members: Loadable<Member[]>;
  roles: RoleChoice[];
  groups: GroupRef[];
  grants: KnowledgeGrants | null | undefined;
  lastActive: LastActive | null;
  callerId: string | null;
  callerPermissions: readonly string[];
  filters: MemberFilters;
  onFiltersChange: (filters: MemberFilters) => void;
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  openMemberId: string | null;
  onOpenMember: (memberId: string | null) => void;
  /** `workspace.member_remove` is API-pending; its entry points render only when enabled. */
  removeEnabled: boolean;
}) {
  const actions = useMemberActions({ callerId, roles, callerPermissions });
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const all = members.data ?? [];
  const roleName = (roleId: string) => roles.find((role) => role.id === roleId)?.name ?? "";

  const rows = useMemo(() => {
    const term = filters.q.trim().toLowerCase();
    return all.filter(
      (member) =>
        (!term || `${memberName(member)} ${member.email}`.toLowerCase().includes(term))
        && (!filters.role || member.roles.some((role) => role.id === filters.role))
        && (!filters.group || member.groups.some((group) => group.id === filters.group))
        && (!filters.status || memberStatus(member) === filters.status),
    );
  }, [all, filters]);
  const filtered = Boolean(filters.q || filters.role || filters.group || filters.status);
  const setFilter = (patch: Partial<MemberFilters>) => {
    setPage(1);
    onFiltersChange({ ...filters, ...patch });
  };
  const selectedMembers = all.filter((member) => selected.includes(member.id));
  const clearSelection = () => setSelected([]);

  const columns: DataTableColumn<Member>[] = [
    {
      id: "person",
      header: "Person",
      sortable: true,
      sortValue: (member) => memberName(member).toLowerCase(),
      cell: (member) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar className="h-8 w-8 text-[12px]" name={memberName(member)} />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-[var(--text-primary)]">{memberName(member)}</span>
              {member.id === callerId && <Tag className="h-5 px-1.5 text-[length:var(--text-size-caption)]">You</Tag>}
              {memberStatus(member) === "suspended" && <StatusBadge kind="member" value="suspended" />}
            </div>
            <div className="truncate text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{member.email}</div>
          </div>
        </div>
      ),
    },
    {
      id: "role",
      header: "Role",
      sortable: true,
      sortValue: (member) => roleName(memberRoleId(member)).toLowerCase(),
      width: 230,
      cell: (member) => <RoleCell actions={actions} callerId={callerId} callerPermissions={callerPermissions} member={member} roles={roles} />,
    },
    {
      id: "groups",
      header: "Groups",
      hideBelow: 900,
      cell: (member) => <GroupTags groups={member.groups} />,
    },
    ...(lastActive
      ? [
          {
            id: "lastActive",
            header: "Last active",
            sortable: true,
            hideBelow: 1080,
            sortValue: (member: Member) => lastActive[member.id] ?? "",
            cell: (member: Member) =>
              lastActive[member.id] ? (
                <span className="text-[var(--text-secondary)]" title={formatDateTime(lastActive[member.id])}>
                  {formatRelative(lastActive[member.id])}
                </span>
              ) : (
                <span className="text-[var(--text-tertiary)]">Not in 30 days</span>
              ),
          } satisfies DataTableColumn<Member>,
        ]
      : []),
  ];

  const openMember = openMemberId ? all.find((member) => member.id === openMemberId) ?? null : null;

  const removed = removeEnabled ? listRemovedMembers() : [];

  return (
    <>
      {removed.length > 0 && (
        <Callout
          actions={
            <Button
              onClick={() => void Promise.all(removed.map((removal) => restoreWorkspaceMember(removal.user_id)))}
              size="sm"
              variant="secondary"
            >
              Restore
            </Button>
          }
          className="mb-4"
          title={<span className="inline-flex items-center gap-2">Removed in this browser <PreviewTag /></span>}
          tone="neutral"
        >
          {removed.map((removal) => removal.display_name || removal.email).join(", ")}{" "}
          {removed.length === 1 ? "is" : "are"} hidden here. Removing members isn’t connected to the server yet, so they can still open the workspace.
        </Callout>
      )}
      <Toolbar
        end={members.data && <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)] tabular-nums">{pluralize(rows.length, "person", "people")}</span>}
        filters={
          <>
            <FilterChip label="Role" onChange={(role) => setFilter({ role })} options={roles.map((role) => ({ value: role.id, label: role.name }))} value={filters.role} />
            {groups.length > 0 && (
              <FilterChip label="Group" onChange={(group) => setFilter({ group })} options={groups.map((group) => ({ value: group.id, label: group.display_name }))} value={filters.group} />
            )}
            <FilterChip label="Status" onChange={(status) => setFilter({ status })} options={STATUS_OPTIONS} value={filters.status} />
            <ClearFilters active={Boolean(filters.role || filters.group || filters.status)} onClear={() => setFilter({ role: "", group: "", status: "" })} />
          </>
        }
        search={<SearchInput ariaLabel="Search people" onChange={(q) => setFilter({ q })} placeholder="Search people" value={filters.q} />}
      />
      <DataTable
        activeRowId={openMemberId}
        ariaLabel="Workspace members"
        bulkActions={() => (
          <>
            {groups.length > 0 && (
              <Menu
                trigger={(props: MenuTriggerProps) => (
                  <BulkActionButton {...props} icon={<Users />}>Add to group…</BulkActionButton>
                )}
              >
                <MenuLabel>Add selected people to</MenuLabel>
                {groups.map((group) => (
                  <MenuItem icon={<Users size={16} />} key={group.id} onSelect={() => void actions.addToGroup(selectedMembers, group).then(clearSelection)}>
                    {group.display_name}
                  </MenuItem>
                ))}
              </Menu>
            )}
            <BulkActionButton icon={<Shield />} onClick={() => actions.openChangeRole(selectedMembers, clearSelection)}>Change role…</BulkActionButton>
            <BulkActionButton icon={<Pause />} onClick={() => actions.suspend(selectedMembers, clearSelection)}>Suspend</BulkActionButton>
          </>
        )}
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            action={<Button onClick={() => onAddOpenChange(true)} variant="secondary">Add member</Button>}
            boxed
            description="Add people who already have a BoMesh account. They can start asking right away."
            icon={<Users />}
            title="Only you are here"
          />
        }
        error={members.error}
        filtered={filtered}
        loading={!members.data && !members.error}
        noResultsState={
          <EmptyState
            action={<Button onClick={() => onFiltersChange(EMPTY_MEMBER_FILTERS)} variant="secondary">Clear filters</Button>}
            boxed
            description="Try a different name or email, or clear the filters."
            size="md"
            title="No people match"
          />
        }
        onClearFilters={() => onFiltersChange(EMPTY_MEMBER_FILTERS)}
        onRetry={members.reload}
        onRowClick={(member) => onOpenMember(member.id)}
        onSelectionChange={setSelected}
        pagination={{ page, pageSize: PAGE_SIZE, total: rows.length, onPageChange: setPage }}
        rowActions={(member) => (
          <MemberMenu
            actions={actions}
            isSelf={member.id === callerId}
            member={member}
            onOpen={() => onOpenMember(member.id)}
            removeEnabled={removeEnabled}
          />
        )}
        rowLabel={memberName}
        selectable
        selectedIds={selected}
      />
      {actions.dialogs}
      <MemberDrawer
        actions={actions}
        callerId={callerId}
        callerPermissions={callerPermissions}
        grants={grants}
        groups={groups}
        lastActive={lastActive}
        loading={!members.data && !members.error}
        member={openMember}
        memberId={openMemberId}
        onClose={() => onOpenMember(null)}
        removeEnabled={removeEnabled}
        roles={roles}
      />
      <AddMemberDialog
        callerPermissions={callerPermissions}
        groups={groups}
        members={all}
        onClose={() => onAddOpenChange(false)}
        onOpenMember={(memberId) => {
          onAddOpenChange(false);
          onOpenMember(memberId);
        }}
        open={addOpen}
        roles={roles}
      />
    </>
  );
}

/**
 * The role, changed in place. Your own row is locked: the server never lets
 * anyone change their own access, so the control explains instead of failing.
 */
function RoleCell({
  member,
  roles,
  callerId,
  callerPermissions,
  actions,
}: {
  member: Member;
  roles: RoleChoice[];
  callerId: string | null;
  callerPermissions: readonly string[];
  actions: MemberActions;
}) {
  const current = actions.pendingRoles[member.id] ?? memberRoleId(member);
  const isSelf = member.id === callerId;
  const select = (
    <Select
      aria-label={`Role for ${memberName(member)}`}
      className={cn(
        "max-w-[220px]",
        "[&>select]:border-transparent [&>select]:bg-transparent [&>select]:shadow-none [&>select:hover:not(:disabled)]:border-[var(--border-default)]",
        isSelf && "pointer-events-none [&>select]:opacity-100",
      )}
      disabled={isSelf}
      onChange={(event) => void actions.changeRole([member], event.target.value)}
      options={roleOptions(roles, current, callerPermissions)}
      placeholder={current ? undefined : "No role"}
      size="sm"
      value={current}
    />
  );
  return isSelf ? (
    <Tooltip label={SELF_LOCK}>
      <span className="inline-flex w-full max-w-[220px]" tabIndex={0}>{select}</span>
    </Tooltip>
  ) : (
    select
  );
}

function GroupTags({ groups }: { groups: GroupRef[] }) {
  if (!groups.length) return <span className="text-[var(--text-tertiary)]">—</span>;
  const shown = groups.slice(0, 2);
  const rest = groups.slice(2);
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {shown.map((group) => <Tag key={group.id}>{group.display_name}</Tag>)}
      {rest.length > 0 && <Tag title={rest.map((group) => group.display_name).join(", ")}>+{rest.length}</Tag>}
    </div>
  );
}

function MemberMenu({
  member,
  isSelf,
  actions,
  onOpen,
  removeEnabled,
}: {
  member: Member;
  isSelf: boolean;
  actions: MemberActions;
  onOpen: () => void;
  removeEnabled: boolean;
}) {
  const suspended = member.status === "suspended";
  return (
    <Menu align="end" ariaLabel={`More actions for ${memberName(member)}`} label={<MoreHorizontal aria-hidden="true" size={16} />} showChevron={false} tooltip="More actions">
      <MenuItem icon={<User size={16} />} onSelect={onOpen}>View details</MenuItem>
      <MenuItem disabled={isSelf} icon={<Shield size={16} />} onSelect={() => actions.openChangeRole([member])}>Change role…</MenuItem>
      <MenuSeparator />
      {suspended ? (
        <MenuItem icon={<Play size={16} />} onSelect={() => actions.reactivate([member])}>Reactivate</MenuItem>
      ) : (
        <MenuItem disabled={isSelf || member.status !== "active"} icon={<Pause size={16} />} onSelect={() => actions.suspend([member])}>
          {isSelf ? "Suspend (not for yourself)" : "Suspend"}
        </MenuItem>
      )}
      {removeEnabled && (
        <MenuItem danger disabled={isSelf} icon={<Trash2 size={16} />} onSelect={() => actions.remove(member)} textValue="Remove from workspace">
          <span className="flex flex-1 items-center justify-between gap-3">
            Remove from workspace
            {isSelf && <span className="text-[length:var(--text-size-caption)] text-[var(--text-tertiary)]">You</span>}
          </span>
        </MenuItem>
      )}
    </Menu>
  );
}

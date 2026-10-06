"use client";

import { MoreHorizontal, Pencil, Trash2, Users } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { SearchInput } from "@/components/ui/SearchInput";
import { useToast } from "@/components/ui/Toast";
import { Toolbar } from "@/components/ui/Toolbar";
import { accessErrorMessage, type Loadable, type RoleChoice } from "@/modules/manage/access/access-model";
import { memberName, workspaceDirectoryApi, type Group, type KnowledgeGrants, type Member } from "@/modules/manage/access/directory";
import { GroupDrawer } from "@/modules/manage/access/GroupDrawer";
import { pluralize } from "@/lib/format";

const NAME_LIMIT = 40;
const DESCRIPTION_LIMIT = 80;

/** A group's mark: a rounded tile, so groups never read as people. */
export function GroupIcon({ size = 32 }: { size?: 32 | 40 }) {
  return (
    <span
      aria-hidden="true"
      className={
        size === 40
          ? "grid h-10 w-10 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--surface-inset)] text-[var(--text-secondary)]"
          : "grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--surface-inset)] text-[var(--text-secondary)]"
      }
    >
      <Users size={size === 40 ? 18 : 16} />
    </span>
  );
}

/** Collections shared with each group, by group id. */
function knowledgeCountByGroup(grants: KnowledgeGrants): Record<string, number> {
  const seen: Record<string, Set<string>> = {};
  for (const grant of grants.grants) {
    if (grant.principal_type !== "group") continue;
    (seen[grant.principal_id] ??= new Set()).add(grant.collection_id);
  }
  return Object.fromEntries(Object.entries(seen).map(([id, collections]) => [id, collections.size]));
}

export function GroupsTab({
  groups,
  members,
  roles,
  grants,
  createOpen,
  onCreateOpenChange,
  openGroupId,
  onOpenGroup,
}: {
  groups: Loadable<Group[]>;
  /** Null without `user.manage`: avatars and the people picker need the member list. */
  members: Member[] | null;
  roles: RoleChoice[];
  grants: KnowledgeGrants | null | undefined;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  openGroupId: string | null;
  onOpenGroup: (groupId: string | null) => void;
}) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [renaming, setRenaming] = useState<Group | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const all = groups.data ?? [];
  const term = search.trim().toLowerCase();
  const rows = all.filter((group) => !term || `${group.display_name} ${group.description ?? ""}`.toLowerCase().includes(term));
  const knowledgeCounts = useMemo(() => (grants ? knowledgeCountByGroup(grants) : null), [grants]);
  const membersOf = (groupId: string) => (members ?? []).filter((member) => member.groups.some((group) => group.id === groupId));

  const columns: DataTableColumn<Group>[] = [
    {
      id: "group",
      header: "Group",
      sortable: true,
      sortValue: (group) => group.display_name.toLowerCase(),
      cell: (group) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <GroupIcon />
          <div className="min-w-0">
            <div className="truncate font-medium text-[var(--text-primary)]">{group.display_name}</div>
            <div className="truncate text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{group.description || "No description"}</div>
          </div>
        </div>
      ),
    },
    {
      id: "members",
      header: "Members",
      sortable: true,
      sortValue: (group) => group.member_count,
      width: 200,
      cell: (group) => {
        if (!group.member_count) return <span className="text-[var(--text-tertiary)]">No members</span>;
        const people = membersOf(group.id);
        return (
          <div className="flex items-center gap-2">
            {people.length > 0 && (
              <span className="flex -space-x-1.5">
                {people.slice(0, 4).map((member) => (
                  <Avatar className="ring-2 ring-[var(--surface-base)]" key={member.id} name={memberName(member)} size="sm" />
                ))}
              </span>
            )}
            <span className="tabular-nums text-[var(--text-secondary)]">{group.member_count.toLocaleString()}</span>
          </div>
        );
      },
    },
    {
      id: "knowledge",
      header: "Knowledge access",
      hideBelow: 900,
      width: 200,
      cell: (group) =>
        grants === undefined ? (
          <span className="text-[var(--text-tertiary)]">…</span>
        ) : !knowledgeCounts ? (
          <span className="text-[var(--text-tertiary)]">—</span>
        ) : knowledgeCounts[group.id] ? (
          <span className="text-[var(--text-secondary)]">{pluralize(knowledgeCounts[group.id], "knowledge base")}</span>
        ) : (
          <span className="text-[var(--text-tertiary)]">None</span>
        ),
    },
  ];

  return (
    <>
      <Toolbar search={<SearchInput ariaLabel="Search groups" onChange={setSearch} placeholder="Search groups" value={search} />} />
      <DataTable
        activeRowId={openGroupId}
        ariaLabel="Groups"
        columns={columns}
        data={rows}
        emptyState={
          <EmptyState
            action={<Button onClick={() => onCreateOpenChange(true)} variant="secondary">Create group</Button>}
            boxed
            description="Groups let you share knowledge with a whole team in one step."
            icon={<Users />}
            title="No groups yet"
          />
        }
        error={groups.error}
        filtered={Boolean(term)}
        loading={!groups.data && !groups.error}
        noResultsState={
          <EmptyState
            action={<Button onClick={() => setSearch("")} variant="secondary">Clear search</Button>}
            boxed
            description="Try a different name."
            size="md"
            title="No groups match"
          />
        }
        onRetry={groups.reload}
        onRowClick={(group) => onOpenGroup(group.id)}
        rowActions={(group) => (
          <Menu align="end" ariaLabel={`More actions for ${group.display_name}`} label={<MoreHorizontal aria-hidden="true" size={16} />} showChevron={false} tooltip="More actions">
            <MenuItem icon={<Users size={16} />} onSelect={() => onOpenGroup(group.id)}>Open</MenuItem>
            <MenuItem icon={<Pencil size={16} />} onSelect={() => setRenaming(group)}>Rename</MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 size={16} />} onSelect={() => setDeleting(group)}>Delete group</MenuItem>
          </Menu>
        )}
      />

      <GroupDrawer
        grants={grants}
        groupId={openGroupId}
        members={members}
        onClose={() => onOpenGroup(null)}
        onDelete={setDeleting}
        onRename={setRenaming}
        roles={roles}
        summary={all.find((group) => group.id === openGroupId) ?? null}
      />

      {(createOpen || renaming) && (
        <GroupFormDialog
          existing={all}
          group={renaming}
          onClose={() => {
            setRenaming(null);
            onCreateOpenChange(false);
          }}
          onCreated={(group) => onOpenGroup(group.id)}
        />
      )}

      <ConfirmDialog
        confirmLabel="Delete group"
        description={deleting ? deleteConsequence(deleting, grants) : ""}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await workspaceDirectoryApi.deleteGroup(deleting.id);
          } catch (cause) {
            throw new Error(accessErrorMessage(cause, "The group wasn’t deleted. Try again."));
          }
          if (openGroupId === deleting.id) onOpenGroup(null);
          toast.show({ message: `Deleted group ${deleting.display_name}` });
        }}
        open={Boolean(deleting)}
        title={deleting ? `Delete ${deleting.display_name}?` : "Delete group?"}
      />
    </>
  );
}

function deleteConsequence(group: Group, grants: KnowledgeGrants | null | undefined) {
  const people = group.member_count
    ? `${pluralize(group.member_count, "member")} stay in the workspace but lose access that came from this group.`
    : "No one is in this group.";
  const shared = grants ? new Set(grants.grants.filter((grant) => grant.principal_type === "group" && grant.principal_id === group.id).map((grant) => grant.collection_id)).size : 0;
  return shared ? `${people} ${pluralize(shared, "knowledge base")} will stop being shared with it.` : people;
}

/** Create a group, or rename one. Names are unique in a workspace, ignoring case. */
function GroupFormDialog({
  group,
  existing,
  onClose,
  onCreated,
}: {
  group: Group | null;
  existing: Group[];
  onClose: () => void;
  onCreated: (group: Group) => void;
}) {
  const toast = useToast();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(group?.display_name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trimmed = name.trim();
  const nameError = !trimmed
    ? "Enter a group name."
    : existing.some((item) => item.id !== group?.id && item.display_name.trim().toLowerCase() === trimmed.toLowerCase())
      ? "A group with this name already exists."
      : null;

  const save = async () => {
    setTouched(true);
    if (nameError) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (group) {
        const nextDescription = description.trim() || null;
        await workspaceDirectoryApi.saveGroup(group.id, {
          details: {
            ...(trimmed !== group.display_name ? { display_name: trimmed } : {}),
            ...(nextDescription !== (group.description || null) ? { description: nextDescription } : {}),
          },
        });
        toast.show({ message: trimmed !== group.display_name ? `Renamed group to ${trimmed}` : `Saved ${trimmed}` });
      } else {
        const created = await workspaceDirectoryApi.createGroup({ display_name: trimmed, ...(description.trim() ? { description: description.trim() } : {}) });
        toast.show({ message: `Created group ${trimmed}` });
        onCreated(created);
      }
      onClose();
    } catch (cause) {
      setFailure(accessErrorMessage(cause, "The group wasn’t saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button loading={busy} onClick={() => void save()}>{group ? "Rename" : "Create group"}</Button>
        </>
      }
      initialFocusRef={nameRef}
      onClose={onClose}
      open
      size="sm"
      title={group ? "Rename group" : "Create group"}
    >
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FormField error={touched ? nameError : null} htmlFor="group-name" label="Name" required>
          <Input
            id="group-name"
            maxLength={NAME_LIMIT}
            onBlur={() => setTouched(true)}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Marketing"
            ref={nameRef}
            value={name}
          />
        </FormField>
        <FormField htmlFor="group-description" label="Description">
          <Input
            id="group-description"
            maxLength={DESCRIPTION_LIMIT}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Who belongs in this group"
            value={description}
          />
        </FormField>
        {failure && <p className="text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" role="alert">{failure}</p>}
        <button className="sr-only" tabIndex={-1} type="submit">Save</button>
      </form>
    </Dialog>
  );
}

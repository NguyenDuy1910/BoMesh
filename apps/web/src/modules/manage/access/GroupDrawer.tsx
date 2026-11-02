"use client";

import { Pencil, Trash2, UserPlus, Users, X } from "lucide-react";
import { useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Dialog } from "@/components/ui/Dialog";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { SearchInput } from "@/components/ui/SearchInput";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { accessErrorMessage, memberRoleId, type RoleChoice } from "@/modules/manage/access/access-model";
import { memberName, workspaceDirectoryApi, type Group, type GroupMember, type KnowledgeGrants, type Member } from "@/modules/manage/access/directory";
import { GroupIcon } from "@/modules/manage/access/GroupsTab";
import { KnowledgeAccessList, knowledgeAccessRows } from "@/modules/manage/access/KnowledgeAccessList";
import { pluralize } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

/**
 * One group: who is in it and which knowledge bases are shared with it.
 * Membership is read from the group's detail (lists leave it empty) and
 * written as the complete set (`PUT /groups/{id}/members`).
 */
export function GroupDrawer({
  groupId,
  summary,
  members,
  roles,
  grants,
  onClose,
  onRename,
  onDelete,
}: {
  groupId: string | null;
  /** The list row, shown while the detail loads. */
  summary: Group | null;
  members: Member[] | null;
  roles: RoleChoice[];
  grants: KnowledgeGrants | null | undefined;
  onClose: () => void;
  onRename: (group: Group) => void;
  onDelete: (group: Group) => void;
}) {
  const toast = useToast();
  const detail = useApiData(
    () => (groupId ? workspaceDirectoryApi.group(groupId) : Promise.resolve(null)),
    `group:${groupId ?? ""}`,
  );
  const [picking, setPicking] = useState(false);
  if (!groupId) return null;

  const group = detail.data?.id === groupId ? detail.data : null;
  const shown = group ?? summary;
  if (!shown) {
    return (
      <Drawer onClose={onClose} open title={detail.error ? "Group not found" : "Loading group"}>
        {detail.error ? (
          <EmptyState description="It may have been deleted, or the link is out of date." icon={<Users />} size="md" title="This group no longer exists" />
        ) : (
          <SkeletonRows columns={2} label="Loading group" rows={4} />
        )}
      </Drawer>
    );
  }

  const people = group?.members ?? [];
  const byId = Object.fromEntries((members ?? []).map((member) => [member.id, member]));
  const roleOf = (person: GroupMember) => {
    const member = byId[person.id];
    return member ? roles.find((role) => role.id === memberRoleId(member))?.name ?? person.email : person.email;
  };

  const replaceMembers = async (ids: string[]) => workspaceDirectoryApi.saveGroup(groupId, { memberIds: ids });

  const removePerson = async (person: GroupMember) => {
    const before = people.map((item) => item.id);
    try {
      await replaceMembers(before.filter((id) => id !== person.id));
    } catch (cause) {
      toast.show({ tone: "err", message: `Couldn’t remove ${memberName(person)}`, description: accessErrorMessage(cause, "Try again.") });
      return;
    }
    toast.show({
      message: `Removed ${memberName(person)} from ${shown.display_name}`,
      action: {
        label: "Undo",
        onClick: () => {
          void replaceMembers(before).catch((cause: unknown) =>
            toast.show({ tone: "err", message: "Couldn’t undo", description: accessErrorMessage(cause, "Add them to the group again.") }),
          );
        },
      },
    });
  };

  const addButton = (
    <Button disabled={!members || !group} icon={<UserPlus aria-hidden="true" size={14} />} onClick={() => setPicking(true)} size="sm" variant="secondary">
      Add people
    </Button>
  );

  return (
    <Drawer
      description={shown.description || undefined}
      footer={
        <>
          <Button className="mr-auto" icon={<Trash2 aria-hidden="true" size={16} />} onClick={() => onDelete(shown)} variant="danger-ghost">
            Delete group
          </Button>
          <Button icon={<Pencil aria-hidden="true" size={16} />} onClick={() => onRename(shown)} variant="secondary">Rename</Button>
        </>
      }
      icon={<GroupIcon size={40} />}
      onClose={onClose}
      open
      title={shown.display_name}
    >
      <DrawerSection
        actions={
          members ? addButton : (
            <Tooltip label="Adding people needs permission to manage members.">
              <span className="inline-flex" tabIndex={0}>{addButton}</span>
            </Tooltip>
          )
        }
        title={
          <>
            Members <span className="font-normal text-[var(--text-tertiary)]">{(group ? people.length : shown.member_count).toLocaleString()}</span>
          </>
        }
      >
        {detail.error && !group ? (
          <ErrorState description={detail.error} layout="inline" onAction={detail.reload} />
        ) : !group ? (
          <SkeletonRows columns={2} label="Loading members" rows={Math.min(Math.max(shown.member_count, 1), 4)} />
        ) : people.length ? (
          <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]">
            {people.map((person) => (
              <li className="flex min-w-0 items-center gap-2.5 px-3.5 py-2.5" key={person.id}>
                <Avatar name={memberName(person)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[var(--text-primary)]">{memberName(person)}</div>
                  <div className="truncate text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{roleOf(person)}</div>
                </div>
                <Button
                  aria-label={`Remove ${memberName(person)} from ${shown.display_name}`}
                  icon={<X aria-hidden="true" size={14} />}
                  onClick={() => void removePerson(person)}
                  size="sm"
                  variant="ghost"
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13.5px] text-[var(--text-tertiary)]">No one is in this group yet.</p>
        )}
      </DrawerSection>

      <DrawerSection title="Knowledge bases">
        {grants ? (
          <KnowledgeAccessList
            empty="Not shared with any knowledge base. Share from a knowledge base’s Access tab."
            grants={grants}
            rows={knowledgeAccessRows(grants, [{ type: "group", id: shown.id, via: "" }])}
          />
        ) : (
          <KnowledgeAccessList empty="" grants={grants} rows={[]} />
        )}
      </DrawerSection>

      {picking && group && members && (
        <AddPeopleDialog
          candidates={members.filter((member) => !people.some((person) => person.id === member.id))}
          group={group}
          onClose={() => setPicking(false)}
          onSave={async (ids) => {
            await replaceMembers([...people.map((person) => person.id), ...ids]);
            toast.show({ message: `Added ${pluralize(ids.length, "person", "people")} to ${group.display_name}` });
          }}
        />
      )}
    </Drawer>
  );
}

/** Tick the people to add; only workspace members who aren't in the group yet are offered. */
function AddPeopleDialog({
  group,
  candidates,
  onClose,
  onSave,
}: {
  group: Group;
  candidates: Member[];
  onClose: () => void;
  onSave: (ids: string[]) => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const term = search.trim().toLowerCase();
  const matches = candidates.filter((member) => !term || `${memberName(member)} ${member.email}`.toLowerCase().includes(term));

  return (
    <Dialog
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button
            disabled={!selected.length}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setFailure(null);
              try {
                await onSave(selected);
                onClose();
              } catch (cause) {
                setFailure(accessErrorMessage(cause, "No one was added. Try again."));
              } finally {
                setBusy(false);
              }
            }}
          >
            {selected.length ? `Add ${pluralize(selected.length, "person", "people")}` : "Add people"}
          </Button>
        </>
      }
      onClose={onClose}
      open
      title={`Add people to ${group.display_name}`}
    >
      <SearchInput ariaLabel="Search people" autoFocus className="mb-3 w-full" onChange={setSearch} placeholder="Search people" value={search} />
      <div className="max-h-80 overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
        {!candidates.length ? (
          <p className="px-3.5 py-3 text-[13.5px] text-[var(--text-tertiary)]">Everyone is already in this group.</p>
        ) : !matches.length ? (
          <p className="px-3.5 py-3 text-[13.5px] text-[var(--text-tertiary)]">No one matches “{search}”.</p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {matches.map((member) => (
              <li key={member.id}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3.5 py-2.5 hover:bg-[var(--surface-subtle)]">
                  <Checkbox
                    aria-label={memberName(member)}
                    checked={selected.includes(member.id)}
                    onCheckedChange={(on) => setSelected((current) => (on ? [...current, member.id] : current.filter((id) => id !== member.id)))}
                  />
                  <Avatar name={memberName(member)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[var(--text-primary)]">{memberName(member)}</span>
                    <span className="block truncate text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{member.email}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      {failure && <p className="mt-2 text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" role="alert">{failure}</p>}
    </Dialog>
  );
}

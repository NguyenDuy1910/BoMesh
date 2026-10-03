"use client";

import { Plus, UsersRound } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { CommandBar } from "@/components/layout/CommandBar";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/Input";
import { SearchInput } from "@/components/ui/SearchInput";
import { Skeleton } from "@/components/ui/Skeleton";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import {
  memberName,
  workspaceDirectoryApi,
  type Group,
  type GroupMember,
} from "@/modules/workspace-control/directory";
import { pluralize } from "@/modules/workspace-control/format";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

export function GroupsPanel({ rows }: { rows: Group[] }) {
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<Group | "new" | null>(null);
  const matching = rows.filter((row) =>
    `${row.display_name} ${row.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const columns: Column<Group>[] = [
    {
      key: "display_name",
      label: "Group",
      primary: true,
      sortable: true,
      render: (row) => (
        <CellTitle
          subtitle={row.description ?? undefined}
          title={
            <span className="inline-flex items-center gap-2">
              {row.display_name}
              {row.status !== "active" && <Badge tone="warning">Inactive</Badge>}
            </span>
          }
        />
      ),
    },
    { key: "member_count", label: "People", width: 110, align: "right", render: (row) => pluralize(row.member_count, "person", "people") },
  ];

  return <>
    <CommandBar
      action={<Button icon={<Plus size={16} />} onClick={() => setTarget("new")}>Create group</Button>}
      count={pluralize(matching.length, "group")}
      search={{ value: search, onChange: setSearch, placeholder: "Search groups…", label: "Search groups" }}
    />
    <DataTable
      ariaLabel="Groups"
      columns={columns}
      data={matching}
      emptyState={
        <EmptyState
          description={search
            ? "Try a different search."
            : "A group is a team, like Finance or Support. Share a collection with a group and everyone in it gets access."}
          icon={<UsersRound size={20} />}
          size="sm"
          title={search ? "No matching groups" : "No groups yet"}
        />
      }
      onRowClick={setTarget}
    />
    {target && (
      <GroupDialog
        group={target === "new" ? null : target}
        key={target === "new" ? "new" : target.id}
        onClose={() => setTarget(null)}
      />
    )}
  </>;
}

/** Create a group, or rename it, describe it and choose who is in it, in one place. */
function GroupDialog({ group, onClose }: { group: Group | null; onClose: () => void }) {
  const { toast } = useToast();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const detail = useControlPlaneData(
    () => (group ? workspaceDirectoryApi.group(group.id) : Promise.resolve(null)),
    group?.id ?? "new",
  );
  const directory = useControlPlaneData(() => workspaceDirectoryApi.members());
  const [name, setName] = useState(group?.display_name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [memberIds, setMemberIds] = useState<string[] | null>(group ? null : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const current = detail.data?.members ?? [];
  const chosen = memberIds ?? current.map((member) => member.id);
  const loadingMembers = Boolean(group) && !detail.data && !detail.error;
  const membersChanged = memberIds !== null
    && [...memberIds].sort().join() !== current.map((member) => member.id).sort().join();
  const detailsChanged = group !== null && (
    name.trim() !== group.display_name || (description.trim() || null) !== (group.description ?? null)
  );
  const canSave = name.trim().length > 0 && (group === null || detailsChanged || membersChanged);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (group) {
        await workspaceDirectoryApi.saveGroup(group.id, {
          details: detailsChanged
            ? { display_name: name.trim(), description: description.trim() || null }
            : undefined,
          memberIds: membersChanged ? chosen : undefined,
        });
        toast({ title: "Group saved", variant: "success" });
      } else {
        await workspaceDirectoryApi.createGroup(
          { display_name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
          chosen,
        );
        toast({
          title: `${name.trim()} created`,
          description: chosen.length
            ? `${pluralize(chosen.length, "person", "people")} added. Share a collection with this group to give them access.`
            : "Add people now or later, then share a collection with this group.",
          variant: "success",
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The group could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      className="max-w-xl"
      footer={<>
        {group && (
          <Button className="mr-auto" onClick={() => setConfirmDelete(true)} variant="danger">Delete group</Button>
        )}
        <Button onClick={onClose} variant="secondary">Cancel</Button>
        <Button disabled={!canSave} loading={busy} onClick={submit}>{group ? "Save changes" : "Create group"}</Button>
      </>}
      initialFocusRef={group ? undefined : nameRef}
      onClose={onClose}
      open
      title={group ? group.display_name : "Create group"}
    >
      <div className="grid gap-5">
        <label className="configuration-field">Group name
          <Input maxLength={255} onChange={(event) => setName(event.target.value)} placeholder="For example: Finance team" ref={nameRef} value={name} />
        </label>
        <label className="configuration-field">
          <span>Description <span className="font-normal text-[var(--text-tertiary)]">(optional)</span></span>
          <Textarea
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Who is in this group, so others pick the right one"
            rows={2}
            value={description}
          />
        </label>
        <div className="grid gap-2">
          <span className="flex items-baseline justify-between text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">
            People in this group
            <span className="text-[length:var(--text-size-meta)] font-normal text-[var(--text-tertiary)]">
              {pluralize(chosen.length, "person", "people")} selected
            </span>
          </span>
          {detail.error ? (
            <ErrorState description={detail.error} layout="inline" onAction={detail.reload} />
          ) : loadingMembers ? (
            <Skeleton className="h-40 w-full rounded-[var(--radius-md)]" />
          ) : (
            <PeopleChecklist
              candidates={directory.data?.items.filter((member) => member.status === "active") ?? null}
              current={current}
              directoryError={directory.error}
              onChange={setMemberIds}
              selected={chosen}
            />
          )}
        </div>
        {error && <ErrorState description={error} layout="inline" />}
      </div>
      {group && (
        <ConfirmDialog
          confirmLabel="Delete group"
          description={<>
            <strong>{group.display_name}</strong> is removed and everyone loses the access that was shared with the group.
            Their own roles and anything shared with them directly stay as they are.
          </>}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await workspaceDirectoryApi.deleteGroup(group.id);
            setConfirmDelete(false);
            onClose();
          }}
          open={confirmDelete}
          title="Delete this group?"
        />
      )}
    </Dialog>
  );
}

/**
 * Tick the people who belong. Members of the group are listed first. Without
 * permission to read the member directory, only current members can be shown,
 * and they can only be removed.
 */
function PeopleChecklist({
  candidates,
  current,
  directoryError,
  selected,
  onChange,
}: {
  candidates: GroupMember[] | null;
  current: GroupMember[];
  directoryError: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  // Current members first, then everyone else by name. The order does not
  // follow the ticks, so a row never jumps away from the pointer.
  const people = useMemo(() => {
    const members = new Set(current.map((person) => person.id));
    const byId = new Map<string, GroupMember>();
    for (const person of [...current, ...(candidates ?? [])]) byId.set(person.id, person);
    const term = search.trim().toLowerCase();
    return [...byId.values()]
      .filter((person) => !term || `${memberName(person)} ${person.email}`.toLowerCase().includes(term))
      .sort((a, b) =>
        Number(members.has(b.id)) - Number(members.has(a.id))
        || memberName(a).localeCompare(memberName(b)),
      );
  }, [candidates, current, search]);

  if (candidates === null && !directoryError) {
    return <Skeleton className="h-40 w-full rounded-[var(--radius-md)]" />;
  }

  return (
    <div className="grid gap-2">
      <SearchInput ariaLabel="Search people" debounceMs={0} onChange={setSearch} placeholder="Search by name or email…" value={search} />
      {directoryError && (
        <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
          Only current members are shown. Adding people needs permission to manage members.
        </p>
      )}
      <div className="max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
        {people.length ? people.map((person) => {
          const checked = selected.includes(person.id);
          return (
            <label
              className={cn(
                "flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-[var(--surface-hover)]",
                checked && "bg-[var(--surface-selected)]",
              )}
              key={person.id}
            >
              <input
                checked={checked}
                className="accent-[var(--accent-primary)]"
                onChange={() => onChange(checked ? selected.filter((id) => id !== person.id) : [...selected, person.id])}
                type="checkbox"
              />
              <Avatar name={memberName(person)} size="sm" />
              <span className="grid min-w-0">
                <span className="truncate text-[length:var(--text-size-ui)] text-[var(--text-primary)]">{memberName(person)}</span>
                {person.display_name && (
                  <span className="truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{person.email}</span>
                )}
              </span>
            </label>
          );
        }) : (
          <p className="px-3 py-4 text-center text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
            {search ? "Nobody matches that search." : "No members in this workspace yet."}
          </p>
        )}
      </div>
    </div>
  );
}

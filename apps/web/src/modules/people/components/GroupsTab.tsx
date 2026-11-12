"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { Check, Pencil, Plus, Users } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { EmptyState, Gate, NoMatches, SearchInput, SkeletonCards, UserAvatar, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";

import { createGroup, updateGroup, type Group } from "../api";
import { groupNameError, needsTools } from "../model";
import { usePeopleClient, type Directory } from "../queries";
import { Dialog } from "./Dialog";
import { useKnowledgeAccess } from "./KnowledgeAccess";

type DirQuery = { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

function GroupCard({ group, dir, fresh, onOpen }: { group: Group; dir: Directory; fresh: boolean; onOpen: () => void }) {
  const members = dir.people.filter((p) => p.groups.includes(group.name ?? ""));
  const access = useKnowledgeAccess({ groups: [group.name ?? ""], groupLabel: () => group.displayName });
  const shared = access.data?.filter((a) => a.via !== "Everyone").length ?? 0;
  return (
    <div
      className={fresh ? "card card--action ppl-group ppl-fresh" : "card card--action ppl-group"}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
    >
      <span className="card__title truncate" translate="no">
        {group.displayName}
      </span>
      <p className="t-sm muted clamp-2 ppl-group__desc" translate={group.description ? "no" : undefined}>
        {group.description || "No description"}
      </p>
      <div className="row between gap-8">
        {members.length ? (
          <span className="row gap-8">
            <span className="avatar-group">
              {members.slice(0, 4).map((m) => (
                <UserAvatar key={m.id} name={m.displayName} size="sm" />
              ))}
            </span>
            <span className="t-xs muted num">{plural(members.length, "member")}</span>
          </span>
        ) : (
          <span className="t-xs muted">No members</span>
        )}
        <span className="t-xs muted">{shared ? plural(shared, "collection") : ""}</span>
      </div>
    </div>
  );
}

/** Groups (preview `groupsTab`): reusable teams as cards; New group lives in the page header. */
export function GroupsTab({ query, fresh, onOpen }: { query: DirQuery; fresh: ReadonlySet<string>; onOpen: (group: Group) => void }) {
  const [q, setQ] = useState("");
  return (
    <Gate
      query={query}
      skeleton={<SkeletonCards cards={6} />}
      isEmpty={(d) => d.groups.length === 0}
      empty={<EmptyState icon={Users} boxed title="No groups yet" description="Groups let you share knowledge with a whole team in one step." />}
    >
      {(dir) => {
        const needle = q.trim().toLowerCase();
        const rows = dir.groups.filter((g) => !needle || g.displayName.toLowerCase().includes(needle) || (g.description ?? "").toLowerCase().includes(needle));
        return (
          <>
            {needsTools(dir.groups.length, Boolean(needle)) ? (
              <div className="toolbar">
                <SearchInput value={q} onChange={setQ} placeholder="Search groups" label="Search groups" />
              </div>
            ) : null}
            {rows.length ? (
              <div className="grid cols-3">
                {rows.map((g) => (
                  <GroupCard key={g.name} group={g} dir={dir} fresh={fresh.has(g.name ?? "")} onOpen={() => onOpen(g)} />
                ))}
              </div>
            ) : (
              <NoMatches what="groups" onClear={() => setQ("")} />
            )}
          </>
        );
      }}
    </Gate>
  );
}

/**
 * Create a group, or edit its name and description (preview `M['ppl-group-form']`): a two-field form in a dialog.
 * `group` null = create.
 */
export function GroupFormDialog({
  state,
  dir,
  onClose,
  onCreated,
}: {
  state: { group: Group | null } | null;
  dir: Directory | undefined;
  onClose: () => void;
  onCreated: (group: Group) => void;
}) {
  return state ? <GroupForm key={state.group?.name ?? "new"} group={state.group} dir={dir} onClose={onClose} onCreated={onCreated} /> : null;
}

function GroupForm({ group, dir, onClose, onCreated }: { group: Group | null; dir: Directory | undefined; onClose: () => void; onCreated: (group: Group) => void }) {
  const { ws, refresh } = usePeopleClient();
  const [name, setName] = useState(group?.displayName ?? "");
  const [desc, setDesc] = useState(group?.description ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = (dir?.groups ?? []).filter((g) => g.name !== group?.name).map((g) => g.displayName);
  const changed = name.trim() !== (group?.displayName ?? "");
  const err = touched || (name.trim() && changed) ? groupNameError(name, others) : "";

  async function save() {
    setTouched(true);
    if (busy || groupNameError(name, others)) {
      document.getElementById("ppl-gn-name")?.focus();
      return;
    }
    setBusy(true);
    try {
      if (group) {
        const saved = await updateGroup(ws, group.name ?? "", { displayName: name.trim(), description: desc.trim() });
        await refresh();
        onClose();
        toast(`Saved ${saved.displayName}`);
      } else {
        const created = await createGroup(ws, { displayName: name.trim(), description: desc.trim() });
        await refresh();
        onClose();
        toast(`Created ${created.displayName}`);
        onCreated(created);
      }
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
      setBusy(false);
    }
  }

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === "Enter") void save();
  };

  return (
    <Dialog
      isOpen
      onClose={onClose}
      guard={busy}
      icon={group ? Pencil : Users}
      title={group ? "Edit group details" : "Create group"}
      description={group ? "Rename it or say who belongs in it. Members and access stay as they are." : "Share knowledge with a whole team in one step."}
      footerStart={group ? undefined : "Next, you’ll add people to it."}
      footer={
        <>
          <Button variant="ghost" isDisabled={busy} onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void save()}>
            {group ? <Check className="i" aria-hidden /> : <Plus className="i" aria-hidden />}
            {group ? "Save changes" : "Create group"}
          </Button>
        </>
      }
    >
      <TextField value={name} onChange={setName} isRequired isInvalid={Boolean(err)} isDisabled={busy} maxLength={40} autoFocus>
        <Label>Name</Label>
        <Input id="ppl-gn-name" placeholder="e.g. Customer support" onKeyDown={onEnter} />
        <FieldError>{err}</FieldError>
      </TextField>
      <TextField value={desc} onChange={setDesc} isDisabled={busy} maxLength={80}>
        <Label>
          Description <span className="label__opt">(optional)</span>
        </Label>
        <Input placeholder="Who belongs in this group" onKeyDown={onEnter} />
      </TextField>
    </Dialog>
  );
}

"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import { Plus, Trash2, Users, X } from "lucide-react";
import { useState } from "react";

import { EmptyState, IconButton, ItemIcon, List, ListItem, SearchInput, UserAvatar, confirm, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { addToGroup, deleteGroup, removeFromGroup, updateGroup, type Group } from "../api";
import { groupNameError } from "../model";
import { usePeopleClient, type Directory, type Person } from "../queries";
import { KnowledgeAccessList, useKnowledgeAccess } from "./KnowledgeAccess";
import { DrawerSection, SideDrawer } from "./SideDrawer";

interface Draft {
  id: string;
  name: string;
  desc: string;
  touched: boolean;
}

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/** Group drawer (preview `DR['ppl-group']`): rename, members, shared bases, delete. */
export function GroupDrawer({ dir, groupName, onClose }: { dir: Directory | undefined; groupName: string | null; onClose: () => void }) {
  const { can } = useWorkspace();
  const { ws, refresh } = usePeopleClient();
  const manage = can("groups.create");
  const group = groupName ? dir?.groupByName.get(groupName) : undefined;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const f: Draft | null = group ? (draft?.id === group.name ? draft : { id: group.name ?? "", name: group.displayName, desc: group.description ?? "", touched: false }) : null;
  const others = dir?.groups.filter((g) => g.name !== group?.name).map((g) => g.displayName) ?? [];
  const err = f?.touched ? groupNameError(f.name, others) : "";
  const dirty = Boolean(group && f && (f.name.trim() !== group.displayName || f.desc.trim() !== (group.description ?? "")));
  const members = group && dir ? dir.people.filter((p) => p.groups.includes(group.name ?? "")) : [];

  async function save() {
    if (!group || !f || busy) return;
    setDraft({ ...f, touched: true });
    if (groupNameError(f.name, others)) return;
    const prev = { displayName: group.displayName, description: group.description ?? "" };
    setBusy(true);
    try {
      const saved = await updateGroup(ws, group.name ?? "", { displayName: f.name.trim(), description: f.desc.trim() });
      await refresh();
      setDraft(null);
      toast(`Saved ${saved.displayName}`, {
        undo: () =>
          void updateGroup(ws, group.name ?? "", prev)
            .then(() => setDraft(null))
            .catch(fail)
            .finally(() => void refresh()),
      });
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!group) return;
    const access = members.length ? `${plural(members.length, "member")} stay in the workspace but lose access that came from this group.` : "No one is in this group.";
    const ok = await confirm({ title: `Delete ${group.displayName}?`, description: access, confirmLabel: "Delete group", tone: "danger" });
    if (!ok) return;
    try {
      await deleteGroup(ws, group.name ?? "");
    } catch (error) {
      fail(error);
      return;
    }
    onClose();
    void refresh();
    toast(`Deleted ${group.displayName}`);
  }

  return (
    <SideDrawer
      isOpen={Boolean(groupName)}
      onClose={onClose}
      title={group ? group.displayName : "Group deleted"}
      contentTitle={Boolean(group)}
      description={group ? plural(members.length, "member") : undefined}
      lead={group ? <ItemIcon icon={Users} tone="accent" /> : undefined}
      footStart={
        group && manage ? (
          <Button variant="danger-soft" onPress={() => void remove()}>
            <Trash2 className="i" aria-hidden />
            Delete group
          </Button>
        ) : null
      }
      foot={
        group && manage ? (
          <Button variant="primary" isDisabled={!dirty} isPending={busy} onPress={() => void save()}>
            Save
          </Button>
        ) : null
      }
    >
      {group && dir && f ? (
        <GroupBody group={group} dir={dir} draft={f} err={err} manage={manage} members={members} onDraft={setDraft} />
      ) : dir ? (
        <EmptyState icon={Users} compact title="This group no longer exists" />
      ) : null}
    </SideDrawer>
  );
}

function GroupBody({
  group,
  dir,
  draft: f,
  err,
  manage,
  members,
  onDraft,
}: {
  group: Group;
  dir: Directory;
  draft: Draft;
  err: string;
  manage: boolean;
  members: Person[];
  onDraft: (d: Draft) => void;
}) {
  const { ws, refresh } = usePeopleClient();
  const [q, setQ] = useState("");
  const name = group.name ?? "";
  const access = useKnowledgeAccess({ groups: [name], groupLabel: () => group.displayName });
  const shared = { ...access, data: access.data?.filter((a) => a.via !== "Everyone") };
  const needle = q.trim().toLowerCase();
  const candidates = needle
    ? dir.people.filter((p) => !p.groups.includes(name) && (p.displayName.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle))).slice(0, 6)
    : [];

  async function add(person: Person) {
    try {
      await addToGroup(ws, name, person.name);
    } catch (error) {
      fail(error);
      return;
    }
    setQ("");
    void refresh();
    toast(`Added ${person.displayName} to ${group.displayName}`, {
      undo: () => void removeFromGroup(ws, name, person.name).catch(fail).finally(() => void refresh()),
    });
  }

  async function drop(person: Person) {
    try {
      await removeFromGroup(ws, name, person.name);
    } catch (error) {
      fail(error);
      return;
    }
    void refresh();
    toast(`Removed ${person.displayName} from ${group.displayName}`, {
      undo: () => void addToGroup(ws, name, person.name).catch(fail).finally(() => void refresh()),
    });
  }

  return (
    <>
      <section className="drawer__section stack gap-16">
        <TextField value={f.name} onChange={(v) => onDraft({ ...f, name: v, touched: true })} isRequired isInvalid={Boolean(err)} isReadOnly={!manage} maxLength={40}>
          <Label>Name</Label>
          <Input translate="no" />
          <FieldError>{err}</FieldError>
        </TextField>
        <TextField value={f.desc} onChange={(v) => onDraft({ ...f, desc: v })} isReadOnly={!manage} maxLength={80}>
          <Label>
            Description <span className="label__opt">(optional)</span>
          </Label>
          <Input placeholder="Who belongs in this group" />
        </TextField>
      </section>
      <DrawerSection title={`Members · ${fmtNum(members.length)}`}>
        {manage ? (
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Add people by name or email" label="Add people to group" fullWidth className="ppl-full" />
            {needle ? (
              <div className="mt-8">
                {candidates.length ? (
                  <List>
                    {candidates.map((p) => (
                      <ListItem
                        key={p.id}
                        lead={<UserAvatar name={p.displayName} size="sm" />}
                        title={p.displayName}
                        contentTitle
                        description={<span translate="no">{p.email}</span>}
                        actions={
                          <Button size="sm" variant="secondary" onPress={() => void add(p)}>
                            <Plus className="i" aria-hidden />
                            Add
                          </Button>
                        }
                      />
                    ))}
                  </List>
                ) : (
                  <p className="t-sm muted">No one else matches “{q}”.</p>
                )}
              </div>
            ) : null}
          </>
        ) : null}
        <div className="mt-12">
          {members.length ? (
            <List>
              {members.map((p) => (
                <ListItem
                  key={p.id}
                  lead={<UserAvatar name={p.displayName} size="sm" />}
                  title={p.displayName}
                  contentTitle
                  description={dir.roleByName.get(p.role)?.label}
                  actions={manage ? <IconButton icon={X} tip={`Remove ${p.displayName} from group`} size="sm" onPress={() => void drop(p)} /> : null}
                />
              ))}
            </List>
          ) : (
            <p className="t-sm muted">No one is in this group yet.</p>
          )}
        </div>
      </DrawerSection>
      <DrawerSection title="Knowledge bases">
        <KnowledgeAccessList access={shared} linkTab="access" showVia={false} empty="Not shared with any knowledge base yet. Share from a knowledge base’s Access tab." />
      </DrawerSection>
    </>
  );
}

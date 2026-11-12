"use client";

import { Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { useState } from "react";

import { EmptyState, IconButton, ItemIcon, List, ListItem, SearchInput, UserAvatar, confirm, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { addToGroup, createGroup, deleteGroup, getItemPolicy, removeFromGroup, setItemPolicy, type Group } from "../api";
import { rolesOf, withGrants } from "../model";
import { usePeopleClient, type Directory, type Person } from "../queries";
import { KnowledgeAccessList, useKnowledgeAccess } from "./KnowledgeAccess";
import { MoreMenu } from "./MoreMenu";
import { DrawerSection, SideDrawer } from "./SideDrawer";

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/**
 * Group drawer (preview `DR['ppl-group']`): members first (add by search, remove; instant with Undo), then the
 * collections shared with it; ⋯ Edit details · Delete group (confirm, then Undo).
 */
export function GroupDrawer({ dir, groupName, onClose, onEdit }: { dir: Directory | undefined; groupName: string | null; onClose: () => void; onEdit: (group: Group) => void }) {
  const { can } = useWorkspace();
  const manage = can("groups.create");
  const group = groupName ? dir?.groupByName.get(groupName) : undefined;
  return (
    <SideDrawer
      isOpen={Boolean(groupName)}
      onClose={onClose}
      title={group ? group.displayName : "Group deleted"}
      contentTitle={Boolean(group)}
      description={group?.description ? <span translate="no">{group.description}</span> : undefined}
      lead={group ? <ItemIcon icon={Users} tone="accent" /> : undefined}
      headActions={group && manage ? <GroupMenu group={group} dir={dir!} onEdit={onEdit} onDeleted={onClose} /> : null}
    >
      {group && dir ? <GroupBody group={group} dir={dir} manage={manage} /> : dir ? <EmptyState icon={Users} compact title="This group no longer exists" /> : null}
    </SideDrawer>
  );
}

function GroupMenu({ group, dir, onEdit, onDeleted }: { group: Group; dir: Directory; onEdit: (group: Group) => void; onDeleted: () => void }) {
  const { ws, refresh } = usePeopleClient();
  const name = group.name ?? "";
  const access = useKnowledgeAccess({ groups: [name], groupLabel: () => group.displayName });

  async function remove() {
    const members = dir.people.filter((p) => p.groups.includes(name));
    const shared = (access.data ?? []).filter((a) => a.via !== "Everyone");
    const ok = await confirm({
      title: `Delete ${group.displayName}?`,
      description: [
        members.length ? "Its members stay in the workspace but lose access that came from this group." : "No one is in this group.",
        shared.length === 1 ? "One collection stops being shared with it." : shared.length ? `${shared.length} collections stop being shared with it.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Delete group",
      tone: "danger",
    });
    if (!ok) return;
    const id = resourceId(name);
    const principal = `group:${id}`;
    try {
      // What Undo puts back: the group under its old ID, its members, and its grants on collections.
      const grants = await Promise.all(
        shared.map(async (a) => {
          const item = `workspaces/${ws}/items/${a.id}`;
          return { item, roles: rolesOf(await getItemPolicy(ws, item), principal) };
        }),
      );
      await deleteGroup(ws, name);
      onDeleted();
      void refresh();
      toast(`Deleted ${group.displayName}`, {
        undo: () =>
          void (async () => {
            await createGroup(ws, { displayName: group.displayName, description: group.description ?? "" }, id);
            await Promise.all(members.map((p) => addToGroup(ws, name, p.name)));
            for (const { item, roles } of grants) {
              if (roles.length) await setItemPolicy(ws, item, withGrants(await getItemPolicy(ws, item), principal, roles));
            }
          })()
            .catch(fail)
            .finally(() => void refresh()),
      });
    } catch (error) {
      fail(error);
    }
  }

  return (
    <MoreMenu
      actions={[
        { id: "edit", label: "Edit details", icon: Pencil, onAction: () => onEdit(group) },
        { id: "delete", label: "Delete group", icon: Trash2, danger: true, sep: true, onAction: () => void remove() },
      ]}
    />
  );
}

function GroupBody({ group, dir, manage }: { group: Group; dir: Directory; manage: boolean }) {
  const { ws, refresh } = usePeopleClient();
  const [q, setQ] = useState("");
  const name = group.name ?? "";
  const members = dir.people.filter((p) => p.groups.includes(name));
  const access = useKnowledgeAccess({ groups: [name], groupLabel: () => group.displayName });
  const shared = { ...access, data: access.data?.filter((a) => a.via !== "Everyone") };
  const needle = q.trim().toLowerCase();
  const candidates = needle
    ? dir.people.filter((p) => !p.groups.includes(name) && (p.displayName.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle))).slice(0, 6)
    : [];

  async function add(person: Person) {
    setQ("");
    try {
      await addToGroup(ws, name, person.name);
    } catch (error) {
      fail(error);
      return;
    }
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
                        className="ppl-cand"
                        lead={<UserAvatar name={p.displayName} size="sm" />}
                        title={p.displayName}
                        contentTitle
                        description={<span translate="no">{p.email}</span>}
                        onPress={() => void add(p)}
                        actions={
                          <span className="ppl-cand__add">
                            <Plus className="i i-sm" aria-hidden />
                            Add
                          </span>
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
                  actions={
                    manage ? (
                      <span className="reveal-on-hover">
                        <IconButton icon={X} tip={`Remove ${p.displayName} from group`} size="sm" onPress={() => void drop(p)} />
                      </span>
                    ) : null
                  }
                />
              ))}
            </List>
          ) : needle ? null : (
            <p className="t-sm muted">{manage ? "No one is in this group yet. Search above to add people." : "No one is in this group yet."}</p>
          )}
        </div>
      </DrawerSection>
      <DrawerSection title="Collections">
        <KnowledgeAccessList access={shared} linkTab="access" showVia={false} empty="Not shared with any collection yet. Share from a collection’s Access tab." />
      </DrawerSection>
    </>
  );
}

"use client";

import { Pencil, Plus, Trash2, Users, X } from "lucide-react";
import { useState } from "react";

import { EmptyState, IconButton, ItemIcon, List, ListItem, Pager, SearchInput, UserAvatar, confirm, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { SEARCH_PAUSE_MS, useDebounced } from "@/lib/debounce";
import { fmtNum } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { addToGroup, createGroup, deleteGroup, getItemPolicy, listAllMembers, removeFromGroup, setItemPolicy, type Group } from "../api";
import { literal, memberFilter, rolesOf, withGrants } from "../model";
import { useMemberPages, usePeopleClient, type Directory, type Person } from "../queries";
import { ALL_MEMBERS_VIA, KnowledgeAccessList, useKnowledgeAccess } from "./KnowledgeAccess";
import { MoreMenu } from "./MoreMenu";
import { DrawerSection, SideDrawer } from "./SideDrawer";

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });
const PAGE = 20;
/** Undo of a group delete puts back at most this many memberships (read just before the delete). */
const UNDO_MEMBERS = 2000;

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
      title={group ? group.displayName : "Đã xóa nhóm"}
      contentTitle={Boolean(group)}
      description={group?.description ? <span translate="no">{group.description}</span> : undefined}
      lead={group ? <ItemIcon icon={Users} tone="accent" /> : undefined}
      headActions={group && manage ? <GroupMenu group={group} onEdit={onEdit} onDeleted={onClose} /> : null}
    >
      {group && dir ? <GroupBody group={group} dir={dir} manage={manage} /> : dir ? <EmptyState icon={Users} compact title="Nhóm này không còn tồn tại" /> : null}
    </SideDrawer>
  );
}

function GroupMenu({ group, onEdit, onDeleted }: { group: Group; onEdit: (group: Group) => void; onDeleted: () => void }) {
  const { ws, refresh } = usePeopleClient();
  const name = group.name ?? "";
  const access = useKnowledgeAccess({ groups: [name], groupLabel: () => group.displayName });

  async function remove() {
    const count = group.memberCount ?? 0;
    const shared = (access.data ?? []).filter((a) => a.via !== ALL_MEMBERS_VIA);
    const ok = await confirm({
      title: `Xóa ${group.displayName}?`,
      description: [
        count ? "Các thành viên vẫn ở lại không gian làm việc nhưng mất quyền truy cập có được từ nhóm này." : "Nhóm này không có ai.",
        shared.length === 1 ? "Một kho tài liệu sẽ ngừng chia sẻ với nhóm." : shared.length ? `${shared.length} kho tài liệu sẽ ngừng chia sẻ với nhóm.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Xóa nhóm",
      tone: "danger",
    });
    if (!ok) return;
    const id = resourceId(name);
    const principal = `group:${id}`;
    try {
      // What Undo puts back: the group under its old ID, its members, and its grants on collections.
      const members = count ? await listAllMembers(ws, `groups:${literal(name)}`, UNDO_MEMBERS) : [];
      const grants = await Promise.all(
        shared.map(async (a) => {
          const item = `workspaces/${ws}/items/${a.id}`;
          return { item, roles: rolesOf(await getItemPolicy(ws, item), principal) };
        }),
      );
      await deleteGroup(ws, name);
      onDeleted();
      void refresh();
      toast(`Đã xóa ${group.displayName}`, {
        undo: () =>
          void (async () => {
            await createGroup(ws, { displayName: group.displayName, description: group.description ?? "" }, id);
            await Promise.all(members.map((m) => addToGroup(ws, name, m.name ?? "")));
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
        { id: "edit", label: "Sửa chi tiết", icon: Pencil, onAction: () => onEdit(group) },
        { id: "delete", label: "Xóa nhóm", icon: Trash2, danger: true, sep: true, onAction: () => void remove() },
      ]}
    />
  );
}

function GroupBody({ group, dir, manage }: { group: Group; dir: Directory; manage: boolean }) {
  const { ws, refresh } = usePeopleClient();
  const [q, setQ] = useState("");
  const name = group.name ?? "";
  const membersPage = useMemberPages(dir, memberFilter({ group: name }), { pageSize: PAGE });
  const members = membersPage.rows ?? [];
  const access = useKnowledgeAccess({ groups: [name], groupLabel: () => group.displayName });
  const shared = { ...access, data: access.data?.filter((a) => a.via !== ALL_MEMBERS_VIA) };
  const needle = useDebounced(q.trim(), SEARCH_PAUSE_MS);
  const found = useMemberPages(dir, memberFilter({ q: needle, notGroup: name }), { pageSize: 6, enabled: Boolean(needle) });
  const candidates = needle ? (found.rows ?? []) : [];

  async function add(person: Person) {
    setQ("");
    try {
      await addToGroup(ws, name, person.name);
    } catch (error) {
      fail(error);
      return;
    }
    void refresh();
    toast(`Đã thêm ${person.displayName} vào ${group.displayName}`, {
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
    toast(`Đã gỡ ${person.displayName} khỏi ${group.displayName}`, {
      undo: () => void addToGroup(ws, name, person.name).catch(fail).finally(() => void refresh()),
    });
  }

  return (
    <>
      <DrawerSection title={`Thành viên · ${fmtNum(group.memberCount ?? members.length)}`}>
        {manage ? (
          <>
            <SearchInput value={q} onChange={setQ} placeholder="Thêm người theo tên hoặc email" label="Thêm người vào nhóm" fullWidth className="ppl-full" />
            {q.trim() ? (
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
                            Thêm
                          </span>
                        }
                      />
                    ))}
                  </List>
                ) : found.isPending ? null : (
                  <p className="t-sm muted">{`Không còn ai khác khớp với “${q}”.`}</p>
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
                        <IconButton icon={X} tip={`Gỡ ${p.displayName} khỏi nhóm`} size="sm" onPress={() => void drop(p)} />
                      </span>
                    ) : null
                  }
                />
              ))}
            </List>
          ) : q.trim() ? null : (
            <p className="t-sm muted">{manage ? "Nhóm chưa có ai. Tìm ở trên để thêm người." : "Nhóm này chưa có ai."}</p>
          )}
          {membersPage.page > 1 || membersPage.hasNext ? (
            <Pager page={membersPage.page} pageSize={PAGE} total={group.memberCount} pageCount={members.length} hasNext={membersPage.hasNext} onPageChange={membersPage.setPage} />
          ) : null}
        </div>
      </DrawerSection>
      <DrawerSection title="Kho tài liệu">
        <KnowledgeAccessList access={shared} linkTab="access" showVia={false} empty="Chưa được chia sẻ với kho tài liệu nào. Hãy chia sẻ từ thẻ Quyền truy cập của kho tài liệu." />
      </DrawerSection>
    </>
  );
}

"use client";

import { Button } from "@heroui/react";
import { Activity, ArrowRight, BookOpen, Building2, Copy, Database, Lock, Shield, Trash2, Users, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { EditableTitle, EmptyState, IconButton, ItemIcon, LinkButton, List, ListItem, SwitchRow, Tick, UserAvatar, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { CATEGORY_TONES, categoryTone, type CategoryTone } from "@/lib/tones";
import { useWorkspace } from "@/lib/workspace";

import { createRole, deleteRole, undeleteRole, updateRole } from "../api";
import { PERMISSION_GROUPS, grantable, isSwitchOn, memberFilter, roleNameError, toggleSwitch, uniqueCopyName, type PermissionSwitch, type WorkspaceRole } from "../model";
import { useMemberPages, usePeopleClient, usePermissionCatalog, type Directory } from "../queries";
import { Dialog } from "./Dialog";
import { SideDrawer } from "./SideDrawer";

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/** Permission group marks (preview `PERM_GROUP_MARK`); a group without one gets a shield in its hashed tone. */
const GROUP_MARKS: Readonly<Record<string, readonly [LucideIcon, CategoryTone]>> = {
  Workspace: [Building2, "blue"],
  People: [Users, "violet"],
  Knowledge: [BookOpen, "teal"],
  Sources: [Database, "amber"],
  Activity: [Activity, "pink"],
};

/** A permission group's tinted icon tile, the same in the matrix bands and the role drawer. */
export function PermissionGroupMark({ group }: { group: string }) {
  const [icon, tone] = GROUP_MARKS[group] ?? [Shield, categoryTone(group)];
  return <ItemIcon icon={icon} tone={tone} size="sm" />;
}

/** A role's tone is its place among the workspace's roles (built-in first), the same in the matrix and its drawer (preview `roleTone`). */
export const roleTone = (roles: readonly WorkspaceRole[], name: string): CategoryTone =>
  CATEGORY_TONES[Math.max(0, roles.findIndex((r) => r.name === name)) % CATEGORY_TONES.length];

interface VisibleGroup {
  group: string;
  items: readonly PermissionSwitch[];
}

/**
 * The permission switches this workspace shows: groups of modules that are on, switches the catalog lets custom roles
 * hold. `ready` is false until the catalog loads. `label` gives a group's heading.
 */
export function usePermissionGroups() {
  const { hasModule } = useWorkspace();
  const catalog = usePermissionCatalog();
  const set = catalog.data ?? new Set<string>();
  const groups: VisibleGroup[] = PERMISSION_GROUPS.filter((g) => !g.module || hasModule(g.module))
    .map((g) => ({ group: g.group, items: g.items.filter((item) => grantable(item, set).length) }))
    .filter((g) => g.items.length);
  const label = (group: string) => PERMISSION_GROUPS.find((g) => g.group === group)?.title ?? group;
  return { ready: !catalog.isPending, catalog: set, groups, label };
}

/**
 * One role (preview `DR['ppl-role']`): who has it, then what it allows by group. Built-in: read-only, allowed permissions
 * only, Duplicate to customise. Custom: the name and description are click-to-edit and each permission a switch (all at
 * once with Undo); Delete is the header action, blocked while someone holds the role.
 */
export function RoleDrawer({
  dir,
  opened,
  isOpen,
  onOpen,
  onClose,
  onShowMembers,
}: {
  dir: Directory;
  /** The role in the address; undefined when it no longer exists or the drawer is closed. */
  opened: WorkspaceRole | undefined;
  isOpen: boolean;
  /** Open another role's drawer (the copy made by Duplicate). */
  onOpen: (role: string) => void;
  onClose: () => void;
  onShowMembers: (role: string, fromBlocked?: boolean) => void;
}) {
  const { can } = useWorkspace();
  const { ws, refresh } = usePeopleClient();
  const { catalog, groups, label } = usePermissionGroups();
  const [pending, setPending] = useState<{ role: string; perms: string[] } | null>(null);
  const [blocked, setBlocked] = useState<WorkspaceRole | null>(null);
  // The drawer keeps showing its role while it closes (or after deleting it), not "Role deleted".
  const [last, setLast] = useState(opened);
  if (opened && opened !== last) setLast(opened);
  const role = opened ?? (isOpen ? undefined : last);
  const manage = can("roles.create");

  if (!role) {
    return (
      <SideDrawer isOpen={isOpen} onClose={onClose} title="Đã xóa vai trò">
        <EmptyState icon={Shield} compact title="Vai trò này không còn nữa" />
      </SideDrawer>
    );
  }

  const edit = manage && !role.builtIn;
  const perms = pending?.role === role.name ? pending.perms : role.permissions;
  const held = new Set(perms);
  const n = dir.roleCounts.get(role.name) ?? 0;
  const others = dir.roles.filter((r) => r.name !== role.name).map((r) => r.label);

  const rename = async (name: string) => {
    const err = roleNameError(name, others);
    if (err) return err;
    const prev = role.label;
    try {
      await updateRole(ws, role.name, { displayName: name });
    } catch (error) {
      fail(error);
      return;
    }
    void refresh();
    toast(`Đã đổi tên thành “${name}”`, { undo: () => void updateRole(ws, role.name, { displayName: prev }).catch(fail).finally(() => void refresh()) });
  };

  const describe = async (description: string) => {
    const prev = role.description;
    try {
      await updateRole(ws, role.name, { description });
    } catch (error) {
      fail(error);
      return;
    }
    void refresh();
    toast(description ? "Đã cập nhật mô tả" : "Đã xóa mô tả", {
      undo: () => void updateRole(ws, role.name, { description: prev }).catch(fail).finally(() => void refresh()),
    });
  };

  const duplicate = async () => {
    try {
      const created = await createRole(ws, {
        displayName: uniqueCopyName(role.label, dir.roles.map((r) => r.label)),
        description: role.description,
        includedPermissions: role.permissions.filter((p) => catalog.has(p)),
      });
      await refresh();
      onOpen(created.name ?? "");
      toast(`Đã tạo ${created.displayName}. Bật hoặc tắt từng quyền.`, {
        undo: () =>
          void deleteRole(ws, created.name ?? "")
            .then(() => onOpen(role.name))
            .catch(fail)
            .finally(() => void refresh()),
      });
    } catch (error) {
      fail(error);
    }
  };

  // No one holds it (else it's blocked), so deleting is reversible: at once, with Undo.
  const remove = async () => {
    if (n) {
      setBlocked(role);
      return;
    }
    try {
      await deleteRole(ws, role.name);
    } catch (error) {
      fail(error);
      return;
    }
    onClose();
    void refresh();
    toast(`Đã xóa ${role.label}`, { undo: () => void undeleteRole(ws, role.name).catch(fail).finally(() => void refresh()) });
  };

  // A permission is a switch: it applies at once with Undo.
  const toggle = async (item: PermissionSwitch, on: boolean) => {
    const prev = role.permissions;
    const next = toggleSwitch(perms, item, on, catalog);
    setPending({ role: role.name, perms: next });
    try {
      await updateRole(ws, role.name, { includedPermissions: next });
      await refresh();
      toast(`${on ? "Đã bật" : "Đã tắt"} một quyền của ${role.label}`, {
        undo: () => void updateRole(ws, role.name, { includedPermissions: prev }).catch(fail).finally(() => void refresh()),
      });
    } catch (error) {
      fail(error);
    } finally {
      setPending(null);
    }
  };

  const sections = groups
    .map((g) => ({ ...g, items: edit ? g.items : g.items.filter((item) => isSwitchOn(item, held, catalog)) }))
    .filter((g) => g.items.length);

  return (
    <SideDrawer
      isOpen={isOpen}
      onClose={onClose}
      lead={<ItemIcon icon={Shield} tone={roleTone(dir.roles, role.name)} />}
      title={edit ? <EditableTitle as="span" value={role.label} onCommit={rename} label="Đổi tên vai trò" maxLength={40} /> : role.label}
      // An editable name marks its own text as content, so its "Rename role" label still localizes.
      contentTitle={!role.builtIn && !edit}
      description={
        edit ? (
          <EditableTitle
            as="span"
            className="ppl-desc-edit"
            value={role.description}
            onCommit={describe}
            label="Sửa mô tả"
            maxLength={90}
            placeholder="Người có vai trò này làm gì"
            emptyText="Thêm mô tả"
          />
        ) : role.description ? (
          <span translate={role.builtIn ? undefined : "no"}>{role.description}</span>
        ) : undefined
      }
      headActions={edit ? <IconButton icon={Trash2} tip="Xóa vai trò" onPress={() => void remove()} /> : null}
    >
      {role.builtIn ? (
        <div className="ppl-rd-note mb-16">
          <Lock className="i i-sm" aria-hidden />
          <span className="grow">Có sẵn, không thay đổi được</span>
          {manage ? (
            <Button size="sm" variant="secondary" onPress={() => void duplicate()}>
              <Copy className="i" aria-hidden />
              Nhân bản để tùy chỉnh
            </Button>
          ) : null}
        </div>
      ) : null}
      {n ? (
        <LinkButton icon={ArrowRight} onPress={() => onShowMembers(role.name)}>
          {`${plural(n, "member")} có vai trò này`}
        </LinkButton>
      ) : (
        <span className="t-sm muted">Chưa ai có vai trò này</span>
      )}
      <section className="drawer__section ppl-rd-perms" aria-label="Quyền">
        {sections.length ? (
          sections.map((g) => (
            <div key={g.group} className="ppl-perm-group">
              <h4 className="ppl-perm-group__title">
                <PermissionGroupMark group={g.group} />
                <span>{label(g.group)}</span>
              </h4>
              {edit ? (
                g.items.map((item) => (
                  <SwitchRow key={item.id} title={item.title} isSelected={isSwitchOn(item, held, catalog)} isDisabled={Boolean(pending)} onChange={(on) => void toggle(item, on)} />
                ))
              ) : (
                <ul className="ppl-perms">
                  {g.items.map((item) => (
                    <li key={item.id} className="ppl-perm">
                      <Tick on />
                      <span>{item.title}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        ) : (
          <p className="t-sm muted">Vai trò này chưa có quyền nào.</p>
        )}
      </section>
      <BlockedDialog role={blocked} dir={dir} onClose={() => setBlocked(null)} onShowMembers={(name) => onShowMembers(name, true)} />
    </SideDrawer>
  );
}

/** A role still in use can't be deleted (preview `M['ppl-role-blocked']`): who holds it, and Show members. */
function BlockedDialog({ role, dir, onClose, onShowMembers }: { role: WorkspaceRole | null; dir: Directory; onClose: () => void; onShowMembers: (role: string) => void }) {
  const count = role ? (dir.roleCounts.get(role.name) ?? 0) : 0;
  const shown = useMemberPages(dir, memberFilter({ role: role?.name }), { pageSize: 3, enabled: Boolean(role) }).rows ?? [];
  return (
    <Dialog
      isOpen={Boolean(role)}
      onClose={onClose}
      icon={Shield}
      tone="warning"
      title={`Chưa thể xóa ${role?.label ?? ""}`}
      description="Chuyển mọi người có vai trò này sang vai trò khác, rồi xóa vai trò."
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Hủy
          </Button>
          <Button
            variant="primary"
            onPress={() => {
              onClose();
              if (role) onShowMembers(role.name);
            }}
          >
            Hiện thành viên
            <ArrowRight className="i" aria-hidden />
          </Button>
        </>
      }
    >
      <div>
        <div className="t-sm muted mb-8">{`${plural(count, "member")} có vai trò này`}</div>
        <List className="ppl-blocked">
          {shown.map((p) => (
            <ListItem key={p.id} lead={<UserAvatar name={p.displayName} size="sm" />} title={p.displayName} contentTitle description={<span translate="no">{p.email}</span>} />
          ))}
        </List>
        {count > shown.length ? <p className="t-sm muted mt-8">{`Và ${count - shown.length} người khác`}</p> : null}
      </div>
    </Dialog>
  );
}

"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import clsx from "clsx";
import { ArrowRight, Check, Copy, Lock, Minus, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { ChoiceGroup, EmptyState, Gate, List, ListItem, SkeletonRows, SwitchRow, UserAvatar, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createRole, deleteRole, undeleteRole, updateRole } from "../api";
import { MEMBER_ROLE, PERMISSION_GROUPS, grantable, isSwitchOn, roleNameError, toggleSwitch, uniqueCopyName, type PermissionSwitch, type WorkspaceRole } from "../model";
import { usePeopleClient, usePermissionCatalog, type Directory } from "../queries";
import { Dialog } from "./Dialog";
import { MoreMenu } from "./MoreMenu";

type DirQuery = { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/** `?role=` value of a role: bare ID (`workspaceAdmin`, or the custom role ID). */
export const roleParam = (role: string) => resourceId(role);

/**
 * Roles (preview `rolesTab`): the role list beside the selected role. Built-in roles read as a checklist with
 * Duplicate to customise; a custom role's permissions switch in place (instant, Undo); ⋯ Edit details · Delete role.
 * New role lives in the page header (`creating`).
 */
export function RolesTab({
  query,
  selected,
  onSelect,
  onShowMembers,
  creating,
  onCreatingChange,
}: {
  query: DirQuery;
  /** `?role=` value. */
  selected: string;
  onSelect: (param: string) => void;
  onShowMembers: (role: string, fromBlocked?: boolean) => void;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const { can, hasModule } = useWorkspace();
  const { ws, refresh } = usePeopleClient();
  const catalog = usePermissionCatalog();
  const manageRoles = can("roles.create");
  const [pending, setPending] = useState<{ role: string; perms: string[] } | null>(null);
  const [editing, setEditing] = useState<WorkspaceRole | null>(null);
  const [blocked, setBlocked] = useState<WorkspaceRole | null>(null);

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={5} />} isEmpty={(d) => !d.roles.length} empty={<EmptyState icon={Shield} boxed title="No roles yet" description="Roles decide what people can do in this workspace." />}>
      {(dir) => {
        const role = dir.roles.find((r) => roleParam(r.name) === selected) ?? dir.roles[0];
        const perms = pending?.role === role.name ? pending.perms : role.permissions;
        const editable = manageRoles && !role.builtIn;
        const set = catalog.data ?? new Set<string>();
        const held = new Set(perms);
        const count = (name: string) => dir.people.filter((p) => p.role === name).length;
        const n = count(role.name);
        const groups = PERMISSION_GROUPS.filter((g) => !g.module || hasModule(g.module));

        const duplicate = async (src: WorkspaceRole) => {
          try {
            const created = await createRole(ws, {
              displayName: uniqueCopyName(src.label, dir.roles.map((r) => r.label)),
              description: src.description,
              includedPermissions: src.permissions.filter((p) => set.has(p)),
            });
            await refresh();
            onSelect(roleParam(created.name ?? ""));
            toast(`Created ${created.displayName}. Switch its permissions on or off.`, {
              undo: () =>
                void deleteRole(ws, created.name ?? "")
                  .then(() => onSelect(roleParam(src.name)))
                  .catch(fail)
                  .finally(() => void refresh()),
            });
          } catch (error) {
            fail(error);
          }
        };

        // No one holds it (else it's blocked), so deleting is reversible: at once, with Undo.
        const remove = async (target: WorkspaceRole) => {
          if (count(target.name)) {
            setBlocked(target);
            return;
          }
          try {
            await deleteRole(ws, target.name);
          } catch (error) {
            fail(error);
            return;
          }
          onSelect(roleParam(MEMBER_ROLE));
          void refresh();
          toast(`Deleted ${target.label}`, {
            undo: () =>
              void undeleteRole(ws, target.name)
                .then(() => onSelect(roleParam(target.name)))
                .catch(fail)
                .finally(() => void refresh()),
          });
        };

        // A permission is a toggle: it applies at once with Undo.
        const toggle = async (item: (typeof groups)[number]["items"][number], on: boolean) => {
          const prev = role.permissions;
          const next = toggleSwitch(perms, item, on, set);
          setPending({ role: role.name, perms: next });
          try {
            await updateRole(ws, role.name, { includedPermissions: next });
            await refresh();
            toast(`${on ? "Turned on" : "Turned off"} a permission for ${role.label}`, {
              undo: () => void updateRole(ws, role.name, { includedPermissions: prev }).catch(fail).finally(() => void refresh()),
            });
          } catch (error) {
            fail(error);
          } finally {
            setPending(null);
          }
        };

        const roleItem = (r: WorkspaceRole) => (
          <ListItem
            key={r.name}
            title={r.label}
            contentTitle={!r.builtIn}
            description={plural(count(r.name), "member")}
            onPress={() => onSelect(roleParam(r.name))}
            className={clsx("ppl-role-item", r.name === role.name && "is-active")}
          />
        );
        const builtIn = dir.roles.filter((r) => r.builtIn);
        const custom = dir.roles.filter((r) => !r.builtIn);

        return (
          <div className="ppl-roles">
            <nav className="ppl-roles__nav" aria-label="Roles">
              {custom.length ? (
                <>
                  <div className="ppl-roles__label">Built-in</div>
                  <List>{builtIn.map(roleItem)}</List>
                  <div className="ppl-roles__label">Custom</div>
                  <List>{custom.map(roleItem)}</List>
                </>
              ) : (
                <List>{builtIn.map(roleItem)}</List>
              )}
            </nav>
            <div className="ppl-roles__main">
              <div className="card card--lg">
                <div className="ppl-role-head">
                  <div className="grow">
                    <h2 className="t-heading" translate={role.builtIn ? undefined : "no"}>
                      {role.label}
                    </h2>
                    <p className="t-sm muted mt-4">{role.description || "No description"}</p>
                    <p className="ppl-role-meta">
                      {role.builtIn ? (
                        <>
                          <span className="row gap-4">
                            <Lock className="i i-xs" aria-hidden />
                            Built-in, can’t be changed
                          </span>
                          <span aria-hidden>·</span>
                        </>
                      ) : null}
                      {n ? (
                        <button type="button" className="link-button" onClick={() => onShowMembers(role.name)}>
                          {`${plural(n, "member")} with this role`}
                        </button>
                      ) : (
                        <span>No one has this role yet</span>
                      )}
                    </p>
                  </div>
                  <div className="row gap-4 none">
                    {manageRoles && role.builtIn ? (
                      <Button size="sm" variant="secondary" onPress={() => void duplicate(role)}>
                        <Copy className="i" aria-hidden />
                        Duplicate to customise
                      </Button>
                    ) : null}
                    {manageRoles && !role.builtIn ? (
                      <MoreMenu
                        actions={[
                          { id: "edit", label: "Edit details", icon: Pencil, onAction: () => setEditing(role) },
                          { id: "delete", label: "Delete role", icon: Trash2, danger: true, sep: true, onAction: () => void remove(role) },
                        ]}
                      />
                    ) : null}
                  </div>
                </div>
                {groups.map((g) => {
                  const items = g.items.filter((item) => grantable(item, set).length);
                  if (!items.length) return null;
                  return (
                    <div key={g.group} className="ppl-perm-group">
                      <div className="row between gap-8">
                        <h3 className="t-subheading">{g.group}</h3>
                        <span className="t-xs muted num">
                          {items.filter((item) => isSwitchOn(item, held, set)).length} of {items.length}
                        </span>
                      </div>
                      {editable ? (
                        <div>
                          {items.map((item) => (
                            <SwitchRow
                              key={item.id}
                              title={item.title}
                              isSelected={isSwitchOn(item, held, set)}
                              isDisabled={Boolean(pending)}
                              onChange={(on) => void toggle(item, on)}
                            />
                          ))}
                        </div>
                      ) : (
                        <ul className="ppl-perms">
                          {items.map((item) => {
                            const on = isSwitchOn(item, held, set);
                            const Icon = on ? Check : Minus;
                            return (
                              <li key={item.id} className={clsx("ppl-perm", on && "is-on")}>
                                <Icon className="i i-sm" aria-hidden />
                                <span>{item.title}</span>
                                <span className="sr-only">{on ? "Allowed" : "Not allowed"}</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            <RoleFormDialog
              state={creating ? { role: null } : editing ? { role: editing } : null}
              dir={dir}
              switches={groups.flatMap((g) => g.items.filter((item) => grantable(item, set).length))}
              onClose={() => (creating ? onCreatingChange(false) : setEditing(null))}
              onCreated={(name) => onSelect(roleParam(name))}
            />
            <BlockedDialog role={blocked} dir={dir} onClose={() => setBlocked(null)} onShowMembers={(name) => onShowMembers(name, true)} />
          </div>
        );
      }}
    </Gate>
  );
}

/** A role still in use can't be deleted (preview `M['ppl-role-blocked']`): who holds it, and Show members. */
function BlockedDialog({ role, dir, onClose, onShowMembers }: { role: WorkspaceRole | null; dir: Directory; onClose: () => void; onShowMembers: (role: string) => void }) {
  const holders = role ? dir.people.filter((p) => p.role === role.name) : [];
  const shown = holders.slice(0, 3);
  return (
    <Dialog
      isOpen={Boolean(role)}
      onClose={onClose}
      icon={Shield}
      tone="warning"
      title={`Can’t delete ${role?.label ?? ""} yet`}
      description="Move everyone with this role to another role, then delete it."
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onPress={() => {
              onClose();
              if (role) onShowMembers(role.name);
            }}
          >
            Show members
            <ArrowRight className="i" aria-hidden />
          </Button>
        </>
      }
    >
      <div>
        <div className="t-sm muted mb-8">{`${plural(holders.length, "member")} with this role`}</div>
        <List className="ppl-blocked">
          {shown.map((p) => (
            <ListItem key={p.id} lead={<UserAvatar name={p.displayName} size="sm" />} title={p.displayName} contentTitle description={<span translate="no">{p.email}</span>} />
          ))}
        </List>
        {holders.length > shown.length ? <p className="t-sm muted mt-8">And {holders.length - shown.length} more</p> : null}
      </div>
    </Dialog>
  );
}

/** Create role / Edit role details (preview `M['ppl-role-form']`). */
function RoleFormDialog({
  state,
  dir,
  switches,
  onClose,
  onCreated,
}: {
  state: { role: WorkspaceRole | null } | null;
  dir: Directory;
  switches: readonly PermissionSwitch[];
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  return state ? <RoleForm key={state.role?.name ?? "new"} role={state.role} dir={dir} switches={switches} onClose={onClose} onCreated={onCreated} /> : null;
}

function RoleForm({ role, dir, switches, onClose, onCreated }: { role: WorkspaceRole | null; dir: Directory; switches: readonly PermissionSwitch[]; onClose: () => void; onCreated: (name: string) => void }) {
  const { ws, refresh } = usePeopleClient();
  const catalog = usePermissionCatalog();
  const [name, setName] = useState(role?.label ?? "");
  const [desc, setDesc] = useState(role?.description ?? "");
  const [from, setFrom] = useState<string>(MEMBER_ROLE);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = dir.roles.filter((r) => r.name !== role?.name).map((r) => r.label);
  const err = touched || name.trim() !== (role?.label ?? "") ? roleNameError(name, others) : "";
  const set = catalog.data ?? new Set<string>();
  const member = dir.roleByName.get(MEMBER_ROLE);
  // Starting points: the Member role (when it exists) or nothing. Counted in switches, like the role panel.
  const memberHeld = new Set(member?.permissions);
  const starts = [
    ...(member ? [{ value: member.name, title: member.label, description: `${switches.filter((item) => isSwitchOn(item, memberHeld, set)).length} of ${switches.length} permissions` }] : []),
    { value: "empty", title: "Start empty", description: "Turn on only what it needs" },
  ];

  async function save() {
    setTouched(true);
    if (busy || roleNameError(name, others)) {
      document.getElementById("ppl-rf-name")?.focus();
      return;
    }
    setBusy(true);
    try {
      if (role) {
        await updateRole(ws, role.name, { displayName: name.trim(), description: desc.trim() });
        await refresh();
        onClose();
        toast(`Saved ${name.trim()}`);
      } else {
        const base = from === "empty" ? [] : (dir.roleByName.get(from)?.permissions ?? []);
        const created = await createRole(ws, { displayName: name.trim(), description: desc.trim(), includedPermissions: base.filter((p) => set.has(p)) });
        await refresh();
        onClose();
        onCreated(created.name ?? "");
        toast(`Created ${created.displayName}`);
      }
    } catch (error) {
      fail(error);
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
      size={role ? "md" : "lg"}
      icon={role ? Pencil : Shield}
      title={role ? "Edit role details" : "Create role"}
      description={role ? "Rename it or describe who it’s for. Permissions stay as they are." : "Pick a starting point, then fine-tune each permission."}
      footerStart={role ? undefined : "No one gets this role until you assign it."}
      footer={
        <>
          <Button variant="ghost" isDisabled={busy} onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void save()}>
            {role ? <Check className="i" aria-hidden /> : <Plus className="i" aria-hidden />}
            {role ? "Save changes" : "Create role"}
          </Button>
        </>
      }
    >
      <TextField value={name} onChange={setName} isRequired isInvalid={Boolean(err)} isDisabled={busy} maxLength={40} autoFocus>
        <Label>Name</Label>
        <Input id="ppl-rf-name" placeholder="e.g. Support lead" onKeyDown={onEnter} />
        <FieldError>{err}</FieldError>
      </TextField>
      <TextField value={desc} onChange={setDesc} isDisabled={busy} maxLength={90}>
        <Label>
          Description <span className="label__opt">(optional)</span>
        </Label>
        <Input placeholder="What people with this role do" onKeyDown={onEnter} />
      </TextField>
      {role ? null : (
        <div className="field">
          <span className="label">Start from</span>
          <ChoiceGroup label="Start from" name="ppl-rf-from" columns={starts.length} value={from} onChange={setFrom} options={starts} isDisabled={busy} />
        </div>
      )}
    </Dialog>
  );
}

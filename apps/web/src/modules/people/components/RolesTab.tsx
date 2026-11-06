"use client";

import { Button, Dropdown, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import { Copy, MoreHorizontal, Pencil, Plus, Shield, Trash2 } from "lucide-react";
import { useState } from "react";

import { Callout, EmptyState, Gate, List, ListItem, SaveBar, Segmented, SkeletonRows, StatusChip, SwitchRow, confirm, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createRole, deleteRole, undeleteRole, updateRole } from "../api";
import { MEMBER_ROLE, PERMISSION_GROUPS, grantable, isSwitchOn, roleNameError, samePermissions, toggleSwitch, uniqueCopyName, type WorkspaceRole } from "../model";
import { usePeopleClient, usePermissionCatalog, type Directory } from "../queries";

type DirQuery = { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/** `?role=` value of a role: bare ID (`workspaceAdmin`, or the custom role ID). */
export const roleParam = (role: string) => resourceId(role);

export function RolesTab({
  query,
  selected,
  onSelect,
  onShowMembers,
}: {
  query: DirQuery;
  /** `?role=` value. */
  selected: string;
  onSelect: (param: string) => void;
  onShowMembers: (role: string) => void;
}) {
  const { can, hasModule } = useWorkspace();
  const { ws, refresh } = usePeopleClient();
  const catalog = usePermissionCatalog();
  const manageRoles = can("roles.create");
  const [draft, setDraft] = useState<{ role: string; perms: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<{ role: WorkspaceRole | null } | null>(null);
  const [blocked, setBlocked] = useState<WorkspaceRole | null>(null);

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={5} />} isEmpty={(d) => !d.roles.length} empty={<EmptyState icon={Shield} boxed title="No roles yet" description="Roles decide what people can do in this workspace." />}>
      {(dir) => {
        const role = dir.roles.find((r) => roleParam(r.name) === selected) ?? dir.roles[0];
        const perms = draft?.role === role.name ? draft.perms : role.permissions;
        const dirty = draft?.role === role.name && !samePermissions(draft.perms, role.permissions);
        const editable = manageRoles && !role.builtIn;
        const set = catalog.data ?? new Set<string>();
        const held = new Set(perms);
        const count = (name: string) => dir.people.filter((p) => p.role === name).length;
        const n = count(role.name);
        const groups = PERMISSION_GROUPS.filter((g) => !g.module || hasModule(g.module));

        const select = async (next: WorkspaceRole) => {
          if (next.name === role.name) return;
          if (dirty) {
            const ok = await confirm({ title: "Discard unsaved changes?", description: `Your changes to ${role.label} haven’t been saved.`, confirmLabel: "Discard", tone: "danger" });
            if (!ok) return;
          }
          setDraft(null);
          onSelect(roleParam(next.name));
        };

        const duplicate = async (src: WorkspaceRole) => {
          try {
            const created = await createRole(ws, {
              displayName: uniqueCopyName(src.label, dir.roles.map((r) => r.label)),
              description: src.description,
              includedPermissions: src.permissions.filter((p) => set.has(p)),
            });
            await refresh();
            setDraft(null);
            onSelect(roleParam(created.name ?? ""));
            toast(`Created ${created.displayName}`, {
              action: {
                label: "Rename",
                onPress: () => setForm({ role: { name: created.name ?? "", label: created.displayName, description: created.description ?? "", builtIn: false, permissions: created.includedPermissions } }),
              },
            });
          } catch (error) {
            fail(error);
          }
        };

        const remove = async (target: WorkspaceRole) => {
          if (count(target.name)) {
            setBlocked(target);
            return;
          }
          const ok = await confirm({ title: `Delete ${target.label}?`, description: "The role and its permissions are deleted.", confirmLabel: "Delete role", tone: "danger" });
          if (!ok) return;
          try {
            await deleteRole(ws, target.name);
          } catch (error) {
            fail(error);
            return;
          }
          setDraft(null);
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

        const save = async () => {
          if (!dirty || !draft || busy) return;
          const prev = role.permissions;
          setBusy(true);
          try {
            await updateRole(ws, role.name, { includedPermissions: draft.perms });
            await refresh();
            setDraft(null);
            toast(`Saved ${role.label}`, {
              undo: () => void updateRole(ws, role.name, { includedPermissions: prev }).catch(fail).finally(() => void refresh()),
            });
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        };

        const roleItem = (r: WorkspaceRole) => (
          <ListItem
            key={r.name}
            title={r.label}
            contentTitle={!r.builtIn}
            description={plural(count(r.name), "member")}
            onPress={() => void select(r)}
            className={r.name === role.name ? "ppl-role-item is-active" : "ppl-role-item"}
          />
        );
        const builtIn = dir.roles.filter((r) => r.builtIn);
        const custom = dir.roles.filter((r) => !r.builtIn);

        return (
          <div className="ppl-roles">
            <nav className="ppl-roles__nav" aria-label="Roles">
              <div className="ppl-roles__label">Built-in</div>
              <List>{builtIn.map(roleItem)}</List>
              <div className="ppl-roles__label">Custom</div>
              {custom.length ? <List>{custom.map(roleItem)}</List> : <p className="t-sm muted">No custom roles yet.</p>}
              {manageRoles ? (
                <div className="mt-12">
                  <Button variant="secondary" size="sm" fullWidth onPress={() => setForm({ role: null })}>
                    <Plus className="i" aria-hidden />
                    Create role
                  </Button>
                </div>
              ) : null}
            </nav>
            <div className="ppl-roles__main">
              <div className="card card--lg">
                <div className="row-start gap-12">
                  <div className="grow">
                    <div className="row gap-8 wrap">
                      <h2 className="t-heading" translate={role.builtIn ? undefined : "no"}>
                        {role.label}
                      </h2>
                      {role.builtIn ? <StatusChip label="Built-in" variant="outline" dot={false} size="sm" /> : null}
                    </div>
                    <p className="t-sm muted mt-4">{role.description || "No description"}</p>
                    <div className="t-sm mt-8">
                      {n ? (
                        <button type="button" className="link-button" onClick={() => onShowMembers(role.name)}>
                          {plural(n, "member")} with this role
                        </button>
                      ) : (
                        <span className="muted">No one has this role yet.</span>
                      )}
                    </div>
                  </div>
                  <div className="row gap-4 none">
                    {manageRoles && role.builtIn ? (
                      <Button size="sm" variant="secondary" onPress={() => void duplicate(role)}>
                        <Copy className="i" aria-hidden />
                        Duplicate
                      </Button>
                    ) : null}
                    {manageRoles && !role.builtIn ? (
                      <>
                        <Button size="sm" variant="secondary" onPress={() => setForm({ role })}>
                          <Pencil className="i" aria-hidden />
                          Edit details
                        </Button>
                        <Dropdown>
                          <Button size="sm" variant="ghost" isIconOnly aria-label="More actions">
                            <MoreHorizontal className="i" aria-hidden />
                          </Button>
                          <Dropdown.Popover placement="bottom end">
                            <Dropdown.Menu aria-label="Role actions" onAction={(key) => void (key === "dup" ? duplicate(role) : remove(role))}>
                              <Dropdown.Item id="dup" textValue="Duplicate">
                                <Copy className="i" aria-hidden />
                                <Label>Duplicate</Label>
                              </Dropdown.Item>
                              <Dropdown.Item id="delete" textValue="Delete role" variant="danger">
                                <Trash2 className="i" aria-hidden />
                                <Label>Delete role</Label>
                              </Dropdown.Item>
                            </Dropdown.Menu>
                          </Dropdown.Popover>
                        </Dropdown>
                      </>
                    ) : null}
                  </div>
                </div>
                {role.builtIn ? <Callout description="Built-in roles can’t be changed. Duplicate one to make a custom role." /> : null}
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
                      <div>
                        {items.map((item) => (
                          <SwitchRow
                            key={item.id}
                            title={item.title}
                            isSelected={isSwitchOn(item, held, set)}
                            isDisabled={!editable}
                            onChange={(on) => {
                              const next = toggleSwitch(perms, item, on, set);
                              setDraft(samePermissions(next, role.permissions) ? null : { role: role.name, perms: next });
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <SaveBar isDirty={dirty} isSaving={busy} onDiscard={() => setDraft(null)} onSave={() => void save()} message={`Unsaved changes to ${role.label}`} />
            </div>
            <RoleFormDialog
              state={form}
              dir={dir}
              onClose={() => setForm(null)}
              onCreated={(name) => {
                setDraft(null);
                onSelect(roleParam(name));
              }}
            />
            <Modal.Backdrop isOpen={Boolean(blocked)} onOpenChange={(open) => (open ? undefined : setBlocked(null))}>
              <Modal.Container size="sm">
                <Modal.Dialog>
                  <Modal.Header>
                    <Modal.Heading>Can’t delete {blocked?.label} yet</Modal.Heading>
                  </Modal.Header>
                  <Modal.Body>
                    <p className="muted">Move {plural(blocked ? count(blocked.name) : 0, "member")} to another role first.</p>
                  </Modal.Body>
                  <Modal.Footer>
                    <Button variant="tertiary" slot="close">
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onPress={() => {
                        const target = blocked;
                        setBlocked(null);
                        if (target) onShowMembers(target.name);
                      }}
                    >
                      Show members
                    </Button>
                  </Modal.Footer>
                </Modal.Dialog>
              </Modal.Container>
            </Modal.Backdrop>
          </div>
        );
      }}
    </Gate>
  );
}

/** Create role / Edit role details (preview `M['ppl-role-form']`). */
function RoleFormDialog({ state, dir, onClose, onCreated }: { state: { role: WorkspaceRole | null } | null; dir: Directory; onClose: () => void; onCreated: (name: string) => void }) {
  return (
    <Modal.Backdrop isOpen={Boolean(state)} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Container size="sm">
        <Modal.Dialog>{state ? <RoleForm role={state.role} dir={dir} onClose={onClose} onCreated={onCreated} /> : null}</Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function RoleForm({ role, dir, onClose, onCreated }: { role: WorkspaceRole | null; dir: Directory; onClose: () => void; onCreated: (name: string) => void }) {
  const { ws, refresh } = usePeopleClient();
  const catalog = usePermissionCatalog();
  const [name, setName] = useState(role?.label ?? "");
  const [desc, setDesc] = useState(role?.description ?? "");
  const [from, setFrom] = useState<"member" | "empty">("member");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = dir.roles.filter((r) => r.name !== role?.name).map((r) => r.label);
  const err = touched ? roleNameError(name, others) : "";

  async function save() {
    setTouched(true);
    if (busy || roleNameError(name, others)) return;
    setBusy(true);
    try {
      if (role) {
        await updateRole(ws, role.name, { displayName: name.trim(), description: desc.trim() });
        await refresh();
        onClose();
        toast(`Saved ${name.trim()}`);
      } else {
        const base = from === "member" ? (dir.roleByName.get(MEMBER_ROLE)?.permissions ?? []) : [];
        const created = await createRole(ws, {
          displayName: name.trim(),
          description: desc.trim(),
          includedPermissions: base.filter((p) => catalog.data?.has(p)),
        });
        await refresh();
        onClose();
        onCreated(created.name ?? "");
        toast(`Created ${created.displayName}`);
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal.CloseTrigger aria-label="Close" />
      <Modal.Header>
        <Modal.Heading>{role ? "Edit role details" : "Create role"}</Modal.Heading>
      </Modal.Header>
      <Modal.Body className="stack gap-16">
        <TextField value={name} onChange={setName} isRequired isInvalid={Boolean(err)} maxLength={40} autoFocus>
          <Label>Name</Label>
          <Input placeholder="e.g. Support lead" onKeyDown={(e) => e.key === "Enter" && void save()} />
          <FieldError>{err}</FieldError>
        </TextField>
        <TextField value={desc} onChange={setDesc} maxLength={90}>
          <Label>
            Description <span className="label__opt">(optional)</span>
          </Label>
          <Input placeholder="What people with this role do" onKeyDown={(e) => e.key === "Enter" && void save()} />
        </TextField>
        {role ? null : (
          <div className="field">
            <span className="label">Start with permissions from</span>
            <Segmented
              label="Start from"
              full
              value={from}
              onChange={setFrom}
              options={[
                { value: "member", label: "Member" },
                { value: "empty", label: "Nothing" },
              ]}
            />
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="tertiary" slot="close">
          Cancel
        </Button>
        <Button variant="primary" isPending={busy} onPress={() => void save()}>
          {role ? "Save" : "Create role"}
        </Button>
      </Modal.Footer>
    </>
  );
}

"use client";

import { Button, FieldError, Input, Label, TextField } from "@heroui/react";
import clsx from "clsx";
import { Plus, Shield } from "lucide-react";
import { Fragment, useState, type KeyboardEvent } from "react";

import { ChoiceGroup, EmptyState, Gate, ItemIcon, SkeletonRows, Tick, toast } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { fmtNum, plural } from "@/lib/format";

import { createRole } from "../api";
import { MEMBER_ROLE, isSwitchOn, roleNameError, type PermissionSwitch } from "../model";
import { usePeopleClient, type Directory } from "../queries";
import { Dialog } from "./Dialog";
import { PermissionGroupMark, RoleDrawer, roleTone, usePermissionGroups } from "./RoleDrawer";
import { RoleSelect } from "./RoleSelect";

type DirQuery = { data?: Directory; isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };

const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

/** `?role=` value of a role: bare ID (`workspaceAdmin`, or the custom role ID). */
const roleParam = (role: string) => resourceId(role);

/**
 * Roles (preview `rolesTab`): compared at a glance — permissions down the side by group, one column per role (built-in
 * first), every cell a tick. Nothing is edited here: a role's name opens its drawer (`?role=`), where that one role is
 * renamed, described, switched and deleted. Phones show one role's column at a time, picked above the table.
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
  /** `?role=` value: the role whose drawer is open. */
  selected: string | null;
  onSelect: (param: string | null) => void;
  onShowMembers: (role: string, fromBlocked?: boolean) => void;
  creating: boolean;
  onCreatingChange: (open: boolean) => void;
}) {
  const { ready, catalog, groups, label } = usePermissionGroups();
  const [focus, setFocus] = useState<string | null>(null);

  return (
    <Gate query={query} skeleton={<SkeletonRows rows={5} />} isEmpty={(d) => !d.roles.length} empty={<EmptyState icon={Shield} boxed title="No roles yet" description="Roles decide what people can do in this workspace." />}>
      {(dir) => {
        if (!ready) return <SkeletonRows rows={5} />;
        const roles = dir.roles;
        const opened = selected ? roles.find((r) => roleParam(r.name) === selected) : undefined;
        const shown = roles.find((r) => r.name === focus) ?? opened ?? roles[0];
        const switches = groups.flatMap((g) => g.items);
        const heldBy = new Map(roles.map((r) => [r.name, new Set(r.permissions)]));
        const on = (role: string, item: PermissionSwitch) => isSwitchOn(item, heldBy.get(role)!, catalog);
        // Opening a role also picks its column on phones (preview `openRole`).
        const open = (name: string) => {
          setFocus(name);
          onSelect(roleParam(name));
        };

        return (
          <>
            <div className="ppl-mx-pick">
              <RoleSelect value={shown.name} roles={roles} onChange={setFocus} ariaLabel="Role to show" fullWidth />
            </div>
            <div className="ppl-mx table-root table-root--primary">
              <div className="table__scroll-container">
                <table className="table__content" aria-label="Roles and permissions">
                  <thead className="table__header">
                    <tr>
                      <th scope="col" className="table__column ppl-mx__perm">
                        <span className="sr-only">Permission</span>
                      </th>
                      {roles.map((r) => (
                        <th key={r.name} scope="col" className={clsx("table__column ppl-mx__role", r === shown && "is-focus")}>
                          <div className="ppl-mx__head">
                            <ItemIcon icon={Shield} tone={roleTone(roles, r.name)} size="sm" />
                            <button type="button" className="ppl-mx__name" onClick={() => open(r.name)}>
                              <span className="truncate" translate={r.builtIn ? undefined : "no"}>
                                {r.label}
                              </span>
                            </button>
                            <div className="ppl-mx__count">
                              {`${plural(dir.people.filter((p) => p.role === r.name).length, "person", "people")} · ${fmtNum(switches.filter((item) => on(r.name, item)).length)}/${plural(switches.length, "permission")}`}
                            </div>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="table__body">
                    {groups.map((g) => (
                      <Fragment key={g.group}>
                        <tr className="ppl-mx__group">
                          <th scope="rowgroup" colSpan={roles.length + 1}>
                            <span className="ppl-mx__band">
                              <PermissionGroupMark group={g.group} />
                              <span className="ppl-mx__gname">{label(g.group)}</span>
                              <span className="ppl-mx__gcount">{plural(g.items.length, "permission")}</span>
                            </span>
                          </th>
                        </tr>
                        {g.items.map((item) => (
                          <tr key={item.id} className="table__row ppl-mx__row">
                            <th scope="row" className="table__cell ppl-mx__perm">
                              {item.title}
                            </th>
                            {roles.map((r) => (
                              <td key={r.name} className={clsx("table__cell ppl-mx__cell", r === shown && "is-focus")}>
                                <Tick on={on(r.name, item)} />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <RoleDrawer dir={dir} opened={opened} isOpen={Boolean(selected)} onOpen={open} onClose={() => onSelect(null)} onShowMembers={onShowMembers} />
            {creating ? <CreateRoleDialog dir={dir} switches={switches} onClose={() => onCreatingChange(false)} onCreated={open} /> : null}
          </>
        );
      }}
    </Gate>
  );
}

/** Create role (preview `M['ppl-role-form']`): name, description and a starting point; the new role's drawer opens next. */
function CreateRoleDialog({ dir, switches, onClose, onCreated }: { dir: Directory; switches: readonly PermissionSwitch[]; onClose: () => void; onCreated: (name: string) => void }) {
  const { ws, refresh } = usePeopleClient();
  const { catalog } = usePermissionGroups();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [from, setFrom] = useState<string>(MEMBER_ROLE);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = dir.roles.map((r) => r.label);
  const err = touched || name.trim() ? roleNameError(name, others) : "";
  const member = dir.roleByName.get(MEMBER_ROLE);
  // Starting points: the Member role (when it exists) or nothing. Counted in switches, like the matrix.
  const memberHeld = new Set(member?.permissions);
  const starts = [
    ...(member ? [{ value: member.name, title: member.label, description: `${switches.filter((item) => isSwitchOn(item, memberHeld, catalog)).length} of ${switches.length} permissions` }] : []),
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
      const base = from === "empty" ? [] : (dir.roleByName.get(from)?.permissions ?? []);
      const created = await createRole(ws, { displayName: name.trim(), description: desc.trim(), includedPermissions: base.filter((p) => catalog.has(p)) });
      await refresh();
      onClose();
      onCreated(created.name ?? "");
      toast(`Created ${created.displayName}`);
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
      size="lg"
      icon={Shield}
      title="Create role"
      description="Pick a starting point, then fine-tune each permission."
      footerStart="No one gets this role until you assign it."
      footer={
        <>
          <Button variant="ghost" isDisabled={busy} onPress={onClose}>
            Cancel
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void save()}>
            <Plus className="i" aria-hidden />
            Create role
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
      <div className="field">
        <span className="label">Start from</span>
        <ChoiceGroup label="Start from" name="ppl-rf-from" columns={starts.length} value={from} onChange={setFrom} options={starts} isDisabled={busy} />
      </div>
    </Dialog>
  );
}

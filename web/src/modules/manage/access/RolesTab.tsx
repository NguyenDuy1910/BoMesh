"use client";

import { Copy, MoreHorizontal, Pencil, Power, Shield } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SaveBar } from "@/components/patterns/SaveBar";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Select } from "@/components/ui/Select";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { Switch } from "@/components/ui/Switch";
import { Tag } from "@/components/ui/Tag";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { accessErrorMessage, uniqueCopyName, type Loadable } from "@/modules/manage/access/access-model";
import { areasFor, describeAccess, toggleAbility } from "@/modules/manage/access/capabilities";
import { workspaceDirectoryApi, type Permission, type Role } from "@/modules/manage/access/directory";
import { pluralize } from "@/lib/format";

const NAME_LIMIT = 40;

/**
 * Roles and what each allows. Built-in roles are read-only and can be
 * duplicated; custom roles are edited as sentences grouped by area and saved
 * together from the sticky bar. The server also refuses to let anyone edit a
 * role they hold, or give abilities they lack — the switches say so first.
 */
export function RolesTab({
  roles,
  catalogue,
  callerPermissions,
  callerRoleCodes,
  canSeeMembers,
  selectedRoleId,
  onSelectRole,
  onDirtyChange,
  onShowMembers,
  createOpen,
  onCreateOpenChange,
}: {
  roles: Loadable<Role[]>;
  /** Assignable permissions (`GET /permissions`), for abilities a role does not have yet. */
  catalogue: Permission[] | null;
  callerPermissions: readonly string[];
  callerRoleCodes: readonly string[];
  canSeeMembers: boolean;
  selectedRoleId: string | null;
  onSelectRole: (roleId: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onShowMembers: (roleId: string) => void;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const all = roles.data ?? [];
  const role = all.find((item) => item.id === selectedRoleId) ?? all[0] ?? null;
  const [draft, setDraft] = useState<{ roleId: string; codes: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [renaming, setRenaming] = useState<Role | null>(null);
  const [disabling, setDisabling] = useState<Role | null>(null);
  // A draft belongs to one role; selecting another (after the page confirmed the discard) drops it.
  if (draft && draft.roleId !== role?.id) setDraft(null);
  const codes = draft && role && draft.roleId === role.id ? draft.codes : role?.permission_codes ?? [];
  const dirty = Boolean(
    role && draft && draft.roleId === role.id
      && (draft.codes.length !== role.permission_codes.length || draft.codes.some((code) => !role.permission_codes.includes(code))),
  );

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const describe = useMemo(() => {
    const byCode = Object.fromEntries((catalogue ?? []).map((permission) => [permission.code, permission.description]));
    return (code: string) => byCode[code];
  }, [catalogue]);
  const areas = useMemo(
    () => areasFor([...new Set([...(catalogue ?? []).map((permission) => permission.code), ...codes])], describe),
    [catalogue, codes, describe],
  );

  if (roles.error && !roles.data) {
    return <ErrorState description={roles.error} onAction={roles.reload} title="Roles didn’t load" />;
  }
  if (!roles.data) return <SkeletonRows columns={2} label="Loading roles" rows={5} />;

  const holdsRole = Boolean(role && callerRoleCodes.includes(role.code));
  const locked = !role || role.is_system || holdsRole;

  const duplicate = async (source: Role) => {
    const grantable = source.permission_codes.filter((code) => callerPermissions.includes(code));
    try {
      const created = await workspaceDirectoryApi.createRole({
        display_name: uniqueCopyName(source.display_name, all.map((item) => item.display_name)),
        permission_codes: grantable,
      });
      setDraft(null);
      onSelectRole(created.id);
      toast.show({
        message: `Duplicated ${source.display_name}`,
        description: grantable.length < source.permission_codes.length ? "Abilities you don’t have were left off." : undefined,
        action: { label: "Rename", onClick: () => setRenaming(created) },
      });
    } catch (cause) {
      toast.show({ tone: "err", message: `Couldn’t duplicate ${source.display_name}`, description: accessErrorMessage(cause, "Try again.") });
    }
  };

  const save = async () => {
    if (!role || !draft) return;
    setSaving(true);
    try {
      await workspaceDirectoryApi.updateRole(role.id, { permission_codes: draft.codes });
      setDraft(null);
      toast.show({ message: `Saved changes to ${role.display_name}` });
    } catch (cause) {
      toast.show({ tone: "err", message: `Changes to ${role.display_name} weren’t saved`, description: accessErrorMessage(cause, "Try again.") });
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (target: Role, active: boolean) => {
    try {
      await workspaceDirectoryApi.updateRole(target.id, { status: active ? "active" : "inactive" });
      toast.show({ message: active ? `Enabled ${target.display_name}` : `Disabled ${target.display_name}` });
    } catch (cause) {
      const message = accessErrorMessage(cause, "Try again.");
      if (!active) throw new Error(message);
      toast.show({ tone: "err", message: `Couldn’t enable ${target.display_name}`, description: message });
    }
  };

  return (
    <>
      {!all.length ? (
        <EmptyState
          action={<Button onClick={() => onCreateOpenChange(true)} variant="secondary">Create role</Button>}
          boxed
          description="Roles decide what members can do in this workspace."
          icon={<Shield />}
          title="No roles yet"
        />
      ) : (
        role && (
          <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-5 max-[900px]:grid-cols-[196px_minmax(0,1fr)] max-[900px]:gap-4">
            <nav aria-label="Roles" className="sticky top-3 flex flex-col gap-0.5">
              {all.map((item) => {
                const current = item.id === role.id;
                return (
                  <button
                    aria-current={current ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[var(--radius-md)] px-3 py-[9px] text-left transition-colors duration-[var(--duration-fast)]",
                      "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                      current ? "bg-[var(--accent-soft)] text-[var(--text-accent)]" : "text-[var(--text-primary)] hover:bg-[var(--surface-hover)]",
                    )}
                    key={item.id}
                    onClick={() => item.id !== role.id && onSelectRole(item.id)}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.display_name}</span>
                      <span className={cn("block truncate text-[length:var(--text-size-meta)]", current ? "text-[var(--text-accent)] opacity-80" : "text-[var(--text-tertiary)]")}>
                        {pluralize(item.member_count, "member")}
                        {item.status !== "active" && " · Disabled"}
                        {item.is_system && <span className="hidden max-[900px]:inline"> · Built-in</span>}
                      </span>
                    </span>
                    {item.is_system && <Tag className="max-[900px]:hidden">Built-in</Tag>}
                  </button>
                );
              })}
            </nav>

            <div className="min-w-0">
              <section aria-labelledby="role-title" className="rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]">
                <div className="p-[var(--card-px)]">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-[18px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]" id="role-title">{role.display_name}</h2>
                        {role.is_system && <Tag>Built-in</Tag>}
                        {role.status !== "active" && <Tag>Disabled</Tag>}
                      </div>
                      <p className="mt-1 text-[var(--text-secondary)]">{describeAccess(codes)}</p>
                      <div className="mt-1.5 text-[13.5px]">
                        {role.member_count ? (
                          canSeeMembers ? (
                            <Button onClick={() => onShowMembers(role.id)} size="sm" variant="link">
                              {pluralize(role.member_count, "member")} with this role
                            </Button>
                          ) : (
                            <span className="text-[var(--text-secondary)]">{pluralize(role.member_count, "member")} with this role</span>
                          )
                        ) : (
                          <span className="text-[var(--text-tertiary)]">No one has this role yet.</span>
                        )}
                      </div>
                    </div>
                    {!role.is_system && (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button icon={<Pencil aria-hidden="true" size={14} />} onClick={() => setRenaming(role)} size="sm" variant="secondary">Rename</Button>
                        <Menu align="end" ariaLabel={`More actions for ${role.display_name}`} label={<MoreHorizontal aria-hidden="true" size={16} />} showChevron={false} tooltip="More actions">
                          <MenuItem icon={<Copy size={16} />} onSelect={() => void duplicate(role)}>Duplicate</MenuItem>
                          <MenuSeparator />
                          {role.status === "active" ? (
                            <MenuItem danger disabled={holdsRole} icon={<Power size={16} />} onSelect={() => setDisabling(role)}>
                              {holdsRole ? "Disable role (you have it)" : "Disable role"}
                            </MenuItem>
                          ) : (
                            <MenuItem icon={<Power size={16} />} onSelect={() => void setActive(role, true)}>Enable role</MenuItem>
                          )}
                        </Menu>
                      </div>
                    )}
                  </div>
                  {role.is_system ? (
                    <Callout
                      actions={<Button icon={<Copy aria-hidden="true" size={14} />} onClick={() => void duplicate(role)} size="sm" variant="secondary">Duplicate</Button>}
                      className="mt-3.5"
                      tone="neutral"
                    >
                      Built-in roles can’t be changed. Duplicate it to make a custom role.
                    </Callout>
                  ) : holdsRole ? (
                    <Callout className="mt-3.5" tone="neutral">
                      You have this role, so you can’t change what it allows. Another admin can.
                    </Callout>
                  ) : role.status !== "active" ? (
                    <Callout
                      actions={<Button onClick={() => void setActive(role, true)} size="sm" variant="secondary">Enable role</Button>}
                      className="mt-3.5"
                      tone="neutral"
                    >
                      This role is disabled, so no one can be given it until you enable it again.
                    </Callout>
                  ) : null}
                </div>

                <div className="border-t border-[var(--border-subtle)] p-[var(--card-px)]">
                  {areas.map(({ area, capabilities }) => {
                    const on = capabilities.filter((capability) => codes.includes(capability.code)).length;
                    return (
                      <div className="mt-5 first:mt-0" key={area.id}>
                        <div className="mb-2 flex items-baseline justify-between gap-3 text-[length:var(--text-size-meta)]">
                          <h3 className="font-semibold text-[var(--text-secondary)]">{area.title}</h3>
                          <span className="text-[var(--text-tertiary)] tabular-nums">{on} of {capabilities.length}</span>
                        </div>
                        {area.note && <p className="mb-2 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{area.note}</p>}
                        <ul className="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)]">
                          {capabilities.map((capability) => {
                            const checked = codes.includes(capability.code);
                            const beyondCaller = !checked && !callerPermissions.includes(capability.code);
                            const control = (
                              <Switch
                                checked={checked}
                                disabled={locked || beyondCaller}
                                label={capability.label}
                                onChange={(next) =>
                                  setDraft({ roleId: role.id, codes: toggleAbility(codes, capability.code, next) })
                                }
                              />
                            );
                            return (
                              <li className="flex items-center gap-4 px-4 py-[11px]" key={capability.code}>
                                <span className="min-w-0 flex-1 text-[14px] text-[var(--text-primary)]">{capability.label}</span>
                                {beyondCaller && !locked ? (
                                  <Tooltip label="You can only give abilities you have yourself.">
                                    <span className="inline-flex" tabIndex={0}>{control}</span>
                                  </Tooltip>
                                ) : (
                                  control
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </section>
              {dirty && (
                <SaveBar
                  message={role.display_name}
                  onDiscard={() => setDraft(null)}
                  onSave={() => void save()}
                  saving={saving}
                />
              )}
            </div>
          </div>
        )
      )}

      {(createOpen || renaming) && (
        <RoleFormDialog
          callerPermissions={callerPermissions}
          existing={all}
          onClose={() => {
            setRenaming(null);
            onCreateOpenChange(false);
          }}
          onCreated={(created) => {
            setDraft(null);
            onSelectRole(created.id);
          }}
          role={renaming}
        />
      )}

      {disabling && disabling.member_count > 0 ? (
        <Dialog
          footer={
            <>
              <Button onClick={() => setDisabling(null)} variant="secondary">Cancel</Button>
              {canSeeMembers && (
                <Button
                  onClick={() => {
                    const id = disabling.id;
                    setDisabling(null);
                    onShowMembers(id);
                  }}
                >
                  Show members
                </Button>
              )}
            </>
          }
          onClose={() => setDisabling(null)}
          open
          role="alertdialog"
          size="sm"
          title={`Can’t disable ${disabling.display_name} yet`}
        >
          <p className="text-[var(--text-secondary)]">
            {pluralize(disabling.member_count, "member")} {disabling.member_count === 1 ? "has" : "have"} this role. Move {disabling.member_count === 1 ? "them" : "them all"} to another role first.
          </p>
        </Dialog>
      ) : (
        <ConfirmDialog
          confirmLabel="Disable role"
          description="It stays in the list with its abilities, but no one can be given it until you enable it again."
          onClose={() => setDisabling(null)}
          onConfirm={() => (disabling ? setActive(disabling, false) : undefined)}
          open={Boolean(disabling)}
          title={disabling ? `Disable ${disabling.display_name}?` : "Disable role?"}
        />
      )}
    </>
  );
}

/** Create a role from a starting point, or rename one. Names are unique, ignoring case. */
function RoleFormDialog({
  role,
  existing,
  callerPermissions,
  onClose,
  onCreated,
}: {
  role: Role | null;
  existing: Role[];
  callerPermissions: readonly string[];
  onClose: () => void;
  onCreated: (role: Role) => void;
}) {
  const toast = useToast();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const starters = existing.filter((item) => item.status === "active");
  const leastAllowed = [...starters].sort((left, right) => left.permission_codes.length - right.permission_codes.length)[0];
  const [name, setName] = useState(role?.display_name ?? "");
  const [from, setFrom] = useState(leastAllowed?.id ?? "");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const trimmed = name.trim();
  const nameError = !trimmed
    ? "Enter a role name."
    : existing.some((item) => item.id !== role?.id && item.display_name.trim().toLowerCase() === trimmed.toLowerCase())
      ? "A role with this name already exists."
      : null;
  const source = starters.find((item) => item.id === from) ?? null;
  const copied = source ? source.permission_codes.filter((code) => callerPermissions.includes(code)) : [];
  const leftOff = source ? source.permission_codes.length - copied.length : 0;

  const save = async () => {
    setTouched(true);
    if (nameError) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (role) {
        if (trimmed !== role.display_name) await workspaceDirectoryApi.updateRole(role.id, { display_name: trimmed });
        toast.show({ message: `Saved ${trimmed}` });
      } else {
        const created = await workspaceDirectoryApi.createRole({ display_name: trimmed, permission_codes: copied });
        toast.show({ message: `Created role ${trimmed}` });
        onCreated(created);
      }
      onClose();
    } catch (cause) {
      setFailure(accessErrorMessage(cause, "The role wasn’t saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      footer={
        <>
          <Button onClick={onClose} variant="secondary">Cancel</Button>
          <Button loading={busy} onClick={() => void save()}>{role ? "Save" : "Create role"}</Button>
        </>
      }
      initialFocusRef={nameRef}
      onClose={onClose}
      open
      size="sm"
      title={role ? "Rename role" : "Create role"}
    >
      <form
        className="grid gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FormField error={touched ? nameError : null} htmlFor="role-name" label="Name" required>
          <Input
            id="role-name"
            maxLength={NAME_LIMIT}
            onBlur={() => setTouched(true)}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Support lead"
            ref={nameRef}
            value={name}
          />
        </FormField>
        {!role && (
          <FormField
            help={
              source
                ? `Copies what ${source.display_name} allows. You can change it next.${leftOff ? " Abilities you don’t have are left off." : ""}`
                : "No abilities. Turn on only what this role needs."
            }
            htmlFor="role-from"
            label="Start from"
            required
          >
            <Select
              id="role-from"
              onChange={(event) => setFrom(event.target.value)}
              options={[
                ...starters.map((item) => ({ value: item.id, label: item.display_name })),
                { value: "", label: "Nothing" },
              ]}
              value={from}
            />
          </FormField>
        )}
        {failure && <p className="text-[length:var(--text-size-meta)] text-[var(--status-danger-text)]" role="alert">{failure}</p>}
        <button className="sr-only" tabIndex={-1} type="submit">Save</button>
      </form>
    </Dialog>
  );
}

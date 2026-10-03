"use client";

import { Copy, Lock, Plus, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";

import { CommandBar } from "@/components/layout/CommandBar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/Input";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/cn";
import { areasFor, describeAccess, toggleAbility } from "@/modules/workspace-control/capabilities";
import { workspaceDirectoryApi, type Permission, type Role } from "@/modules/workspace-control/directory";
import { pluralize } from "@/modules/workspace-control/format";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

/** What the role dialog is for: a new role (maybe copied from another), or an existing one. */
type RoleTarget = { kind: "create"; from?: Role } | { kind: "open"; role: Role };

export function RolesPanel({ rows }: { rows: Role[] }) {
  const [target, setTarget] = useState<RoleTarget | null>(null);
  const columns: Column<Role>[] = [
    {
      key: "display_name",
      label: "Role",
      primary: true,
      sortable: true,
      render: (row) => (
        <CellTitle
          subtitle={describeAccess(row.permission_codes)}
          title={
            <span className="inline-flex items-center gap-2">
              {row.display_name}
              {row.status !== "active" && <Badge tone="warning">Disabled</Badge>}
            </span>
          }
        />
      ),
    },
    { key: "member_count", label: "People", width: 100, align: "right", render: (row) => pluralize(row.member_count, "person", "people") },
    {
      key: "is_system",
      label: "Type",
      width: 120,
      priority: "medium",
      render: (row) => <Badge tone={row.is_system ? "neutral" : "brand"}>{row.is_system ? "Built-in" : "Custom"}</Badge>,
    },
  ];

  return <>
    <CommandBar
      action={<Button icon={<Plus size={16} />} onClick={() => setTarget({ kind: "create" })}>Create role</Button>}
      count={pluralize(rows.length, "role")}
    />
    <DataTable
      ariaLabel="Workspace roles"
      columns={columns}
      data={rows}
      emptyState={
        <EmptyState
          description="A role is a set of things people can do. Create one, then give it to members."
          icon={<ShieldCheck size={20} />}
          size="sm"
          title="No roles yet"
        />
      }
      onRowClick={(role) => setTarget({ kind: "open", role })}
    />
    {target && (
      <RoleDialog
        key={target.kind === "open" ? target.role.id : `create-${target.from?.id ?? "blank"}`}
        onClose={() => setTarget(null)}
        onCopy={(role) => setTarget({ kind: "create", from: role })}
        roles={rows}
        target={target}
      />
    )}
  </>;
}

function RoleDialog({
  target,
  roles,
  onClose,
  onCopy,
}: {
  target: RoleTarget;
  roles: Role[];
  onClose: () => void;
  onCopy: (role: Role) => void;
}) {
  const { toast } = useToast();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const catalogue = useControlPlaneData(workspaceDirectoryApi.permissions);
  const existing = target.kind === "open" ? target.role : null;
  const builtIn = Boolean(existing?.is_system);
  const [name, setName] = useState(
    existing?.display_name ?? (target.kind === "create" && target.from ? `${target.from.display_name} (copy)` : ""),
  );
  // Until the catalogue arrives a copy keeps everything; it is narrowed to
  // what the administrator may grant once it does.
  const [chosen, setChosen] = useState<string[] | null>(
    existing?.permission_codes ?? (target.kind === "create" && target.from ? target.from.permission_codes : null),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStatus, setConfirmStatus] = useState(false);

  const grantable = new Set((catalogue.data?.items ?? []).map((permission) => permission.code));
  const selected = chosen ?? (grantable.has("knowledge.read") ? ["knowledge.read"] : []);
  const shown = builtIn ? selected : [...new Set([...grantable, ...selected])];
  const valid = name.trim().length > 0 && selected.length > 0;
  const changed = existing !== null && (
    name.trim() !== existing.display_name
    || [...selected].sort().join() !== [...existing.permission_codes].sort().join()
  );
  const active = existing?.status !== "inactive";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await workspaceDirectoryApi.updateRole(existing.id, {
          ...(name.trim() !== existing.display_name ? { display_name: name.trim() } : {}),
          permission_codes: selected,
        });
        toast({ title: "Role saved", description: `${pluralize(existing.member_count, "person", "people")} with this role get the change right away.`, variant: "success" });
      } else {
        const created = await workspaceDirectoryApi.createRole({ display_name: name.trim(), permission_codes: selected });
        toast({ title: `${created.display_name} created`, description: "Give it to members from the Members tab.", variant: "success" });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The role could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const title = existing ? existing.display_name : "Create role";
  const footer = builtIn && existing ? <>
    <Button icon={<Copy size={14} />} onClick={() => onCopy(existing)} variant="secondary">Make an editable copy</Button>
    <Button onClick={onClose}>Done</Button>
  </> : <>
    {existing && (
      <Button className="mr-auto" onClick={() => setConfirmStatus(true)} variant={active ? "danger" : "secondary"}>
        {active ? "Disable role" : "Enable role"}
      </Button>
    )}
    <Button onClick={onClose} variant="secondary">Cancel</Button>
    <Button disabled={!valid || (existing !== null && !changed)} loading={busy} onClick={submit}>
      {existing ? "Save changes" : "Create role"}
    </Button>
  </>;

  return (
    <Dialog className="max-w-2xl" footer={footer} initialFocusRef={builtIn ? undefined : nameRef} onClose={onClose} open title={title}>
      <div className="grid gap-5">
        {builtIn ? (
          <p className="flex items-start gap-2 rounded-[var(--radius-md)] bg-[var(--surface-inset)] px-3 py-2.5 text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">
            <Lock aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
            Built-in roles can't be changed. Make an editable copy to start a role of your own from this one.
          </p>
        ) : (
          <label className="configuration-field">Role name
            <Input
              maxLength={255}
              onChange={(event) => setName(event.target.value)}
              placeholder="For example: Content editor"
              ref={nameRef}
              value={name}
            />
          </label>
        )}

        {target.kind === "create" && !target.from && roles.length > 0 && (
          <div className="grid gap-2">
            <span className="text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">Start from</span>
            <div className="flex flex-wrap gap-2">
              {roles.filter((role) => role.status === "active").map((role) => (
                <button
                  className="rounded-full border border-[var(--border-subtle)] px-3 py-1 text-[length:var(--text-size-meta)] font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  key={role.id}
                  onClick={() => setChosen(role.permission_codes.filter((code) => grantable.has(code)))}
                  type="button"
                >
                  {role.display_name}
                </button>
              ))}
            </div>
            <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
              Copies what that role allows. You can still adjust it below.
            </span>
          </div>
        )}

        <fieldset className="grid gap-4">
          <legend className="mb-1 flex w-full items-baseline justify-between text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">
            What people with this role can do
            <span className="text-[length:var(--text-size-meta)] font-normal text-[var(--text-tertiary)]">
              {describeAccess(selected)}
            </span>
          </legend>
          {catalogue.error && !builtIn ? (
            <ErrorState description={catalogue.error} layout="inline" onAction={catalogue.reload} />
          ) : !catalogue.data && !builtIn ? (
            <div aria-busy="true" className="grid gap-2" role="status">
              <span className="sr-only">Loading abilities</span>
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12 w-2/3" />
            </div>
          ) : (
            <AbilityChecklist
              catalogue={catalogue.data?.items ?? []}
              codes={shown}
              grantable={grantable}
              onChange={setChosen}
              readOnly={builtIn}
              selected={selected}
            />
          )}
        </fieldset>
        {error && <ErrorState description={error} layout="inline" />}
      </div>
      {existing && !builtIn && (
        <ConfirmDialog
          confirmLabel={active ? "Disable role" : "Enable role"}
          description={active
            ? <>Nobody can be given <strong>{existing.display_name}</strong> while it is disabled. Move everyone who has it to another role first.</>
            : <>Members can be given <strong>{existing.display_name}</strong> again.</>}
          destructive={active}
          onClose={() => setConfirmStatus(false)}
          onConfirm={async () => {
            await workspaceDirectoryApi.updateRole(existing.id, { status: active ? "inactive" : "active" });
            setConfirmStatus(false);
            onClose();
          }}
          open={confirmStatus}
          title={active ? "Disable this role?" : "Enable this role?"}
        />
      )}
    </Dialog>
  );
}

/**
 * Abilities grouped by area, each with a sentence on what it means. Ticking
 * one ticks what it depends on. An ability the administrator does not hold
 * cannot be granted by them, so it is shown locked rather than hidden.
 */
function AbilityChecklist({
  codes,
  selected,
  grantable,
  catalogue,
  readOnly,
  onChange,
}: {
  codes: string[];
  selected: string[];
  grantable: Set<string>;
  catalogue: Permission[];
  readOnly: boolean;
  onChange: (codes: string[]) => void;
}) {
  const held = new Set(selected);
  const areas = areasFor(codes, (code) => catalogue.find((permission) => permission.code === code)?.description);

  return (
    <div className="grid gap-4">
      {areas.map(({ area, capabilities }) => (
        <section className="grid gap-1.5" key={area.id}>
          <h3 className="text-[length:var(--text-size-meta)] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{area.title}</h3>
          {area.note && !readOnly && (
            <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">{area.note}</p>
          )}
          <div className="grid gap-1">
            {capabilities.map((capability) => {
              const checked = held.has(capability.code);
              const locked = readOnly || !grantable.has(capability.code);
              if (readOnly && !checked) return null;
              return (
                <label
                  className={cn(
                    "flex items-start gap-3 rounded-[var(--radius-md)] px-2 py-2 transition-colors",
                    locked ? "cursor-default" : "cursor-pointer hover:bg-[var(--surface-hover)]",
                  )}
                  key={capability.code}
                >
                  <input
                    checked={checked}
                    className="mt-1 accent-[var(--accent-primary)]"
                    disabled={locked}
                    onChange={(event) => onChange(toggleAbility(selected, capability.code, event.target.checked))}
                    type="checkbox"
                  />
                  <span className="grid gap-0.5">
                    <span className="text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">{capability.label}</span>
                    {capability.hint && (
                      <span className="text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{capability.hint}</span>
                    )}
                    {!readOnly && locked && (
                      <span className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                        Only someone who can do this themselves can change it.
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

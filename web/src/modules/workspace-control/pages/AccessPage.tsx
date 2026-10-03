"use client";

import { Check, Copy, LoaderCircle, UserPlus, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { FilterTrigger, CommandBar } from "@/components/layout/CommandBar";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CellTitle, DataTable, type Column } from "@/components/ui/DataTable";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Input } from "@/components/ui/Input";
import { PageLoadingSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Tabs } from "@/components/ui/Tabs";
import { useToast } from "@/components/ui/Toast";
import { useClipboard } from "@/lib/hooks/useClipboard";
import { useRouteState } from "@/lib/hooks/useRouteState";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { GroupsPanel } from "@/modules/workspace-control/access/GroupsPanel";
import { GroupPicker, RolePicker } from "@/modules/workspace-control/access/pickers";
import { RolesPanel } from "@/modules/workspace-control/access/RolesPanel";
import {
  workspaceDirectoryApi,
  memberName,
  memberStatus,
  roleNames,
  type Account,
  type Group,
  type Member,
  type Role,
} from "@/modules/workspace-control/directory";
import { SectionHeader } from "@/modules/workspace-control/components/SectionHeader";
import { pluralize } from "@/modules/workspace-control/format";
import { useControlPlaneData } from "@/modules/workspace-control/queries";

type AccessTab = "members" | "groups" | "roles";

const tabs = [
  { id: "members", label: "Members" },
  { id: "groups", label: "Groups" },
  { id: "roles", label: "Roles" },
];

export function AccessPage() {
  const [routeTab, setRouteTab] = useRouteState("tab", "members");
  const session = useAuthSession();
  const tab = tabs.some((item) => item.id === routeTab) ? (routeTab as AccessTab) : "members";

  return (
    <>
      <SectionHeader section="access" />
      <div className="tab-bar">
        <Tabs activeTab={tab} ariaLabel="Access sections" idBase="access" onChange={setRouteTab} tabs={tabs} variant="underline" />
      </div>
      <div aria-labelledby={`access-${tab}`} id={`access-${tab}-panel`} role="tabpanel">
        {tab === "members" && <MembersSection actorUserId={session?.user_id ?? null} />}
        {tab === "groups" && <GroupsSection />}
        {tab === "roles" && <RolesSection />}
      </div>
    </>
  );
}

function MembersSection({ actorUserId }: { actorUserId: string | null }) {
  const members = useControlPlaneData(() => workspaceDirectoryApi.members());
  const roles = useControlPlaneData(() => workspaceDirectoryApi.roles());
  // Groups are optional here: someone who manages members but not groups
  // still gets the members tab, just without group choices.
  const groups = useControlPlaneData(() => workspaceDirectoryApi.groups());
  const error = members.error || roles.error;

  if (error) {
    return <AccessDataError description={error} onRetry={() => { members.reload(); roles.reload(); }} />;
  }
  if (!members.data || !roles.data || (!groups.data && !groups.error)) {
    return <AccessDataLoading label="Loading members" />;
  }
  return (
    <MembersPanel
      actorUserId={actorUserId}
      groups={groups.data?.items ?? null}
      roles={roles.data.items}
      rows={members.data.items}
    />
  );
}

function GroupsSection() {
  const groups = useControlPlaneData(() => workspaceDirectoryApi.groups());

  if (groups.error) return <AccessDataError description={groups.error} onRetry={groups.reload} />;
  if (!groups.data) return <AccessDataLoading label="Loading groups" />;
  return <GroupsPanel rows={groups.data.items} />;
}

function RolesSection() {
  const roles = useControlPlaneData(() => workspaceDirectoryApi.roles());

  if (roles.error) return <AccessDataError description={roles.error} onRetry={roles.reload} />;
  if (!roles.data) return <AccessDataLoading label="Loading roles" />;
  return <RolesPanel rows={roles.data.items} />;
}

/* The tab's command bar is not rendered until its data arrives, so the
   placeholder stands in for it too, at the command bar's distance from the
   tab bar. */
function AccessDataLoading({ label }: { label: string }) {
  return <PageLoadingSkeleton className="pt-[var(--space-4)]" controls label={label} />;
}

function AccessDataError({ description, onRetry }: { description: string; onRetry: () => void }) {
  return <ErrorState className="mt-[var(--space-4)]" description={description} layout="inline" onAction={onRetry} />;
}

function MembersPanel({
  actorUserId,
  rows,
  roles,
  groups,
}: {
  actorUserId: string | null;
  rows: Member[];
  roles: Role[];
  /** Null when the viewer cannot manage groups. */
  groups: Group[] | null;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Member | null>(null);
  const matching = useMemo(() => rows.filter((row) => {
    const term = search.toLowerCase();
    return (!term || `${memberName(row)} ${row.email} ${roleNames(row)}`.toLowerCase().includes(term))
      && (!status || memberStatus(row) === status);
  }), [rows, search, status]);

  const columns: Column<Member>[] = [
    {
      key: "email",
      label: "Member",
      primary: true,
      sortable: true,
      render: (row) => (
        <CellTitle icon={<Avatar name={memberName(row)} size="md" />} subtitle={row.email} title={memberName(row)} />
      ),
    },
    { key: "membership", label: "Role", priority: "medium", render: (row) => roleNames(row) || "No role yet" },
    {
      key: "groups",
      label: "Groups",
      priority: "low",
      render: (row) => row.groups.map((group) => group.display_name).join(", ") || "—",
    },
    { key: "status", label: "Status", width: 110, render: (row) => <StatusBadge status={memberStatus(row)} /> },
  ];

  const filtered = Boolean(search || status);

  return <>
    <CommandBar
      action={<Button icon={<UserPlus size={16} />} onClick={() => setOpen(true)}>Add member</Button>}
      count={pluralize(matching.length, "member")}
      filters={
        <FilterTrigger
          label="Filter by status"
          onChange={setStatus}
          options={[
            { value: "", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "suspended", label: "Suspended" },
          ]}
          value={status}
        />
      }
      search={{ value: search, onChange: setSearch, placeholder: "Search members…", label: "Search members" }}
    />
    <DataTable
      ariaLabel="Workspace members"
      columns={columns}
      data={matching}
      emptyState={
        <EmptyState
          description={filtered ? "Try a different search or status." : "Add a member to give them access to this workspace."}
          icon={<Users size={20} />}
          size="sm"
          title={filtered ? "No matching members" : "No members yet"}
        />
      }
      onRowClick={setSelected}
    />
    {selected && (
      <MemberDialog
        actorUserId={actorUserId}
        groups={groups}
        key={selected.id}
        member={selected}
        onClose={() => setSelected(null)}
        roles={roles}
      />
    )}
    <AddMemberDialog
      groups={groups}
      onClose={() => setOpen(false)}
      onOpenMember={(memberId) => {
        setOpen(false);
        setSelected(rows.find((row) => row.id === memberId) ?? null);
      }}
      open={open}
      roles={roles}
    />
  </>;
}

/** Change what one person can do here: their role and their groups, saved together. */
function MemberDialog({
  actorUserId,
  member,
  roles,
  groups,
  onClose,
}: {
  actorUserId: string | null;
  member: Member;
  roles: Role[];
  groups: Group[] | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const initialRoleId = member.roles[0]?.id ?? "";
  const initialGroupIds = member.groups.map((group) => group.id);
  const [roleId, setRoleId] = useState(initialRoleId);
  const [groupIds, setGroupIds] = useState(initialGroupIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmStatusChange, setConfirmStatusChange] = useState(false);
  const active = memberStatus(member) === "active";
  const isCurrentUser = member.id === actorUserId;
  const roleChanged = roleId !== initialRoleId;
  const groupsChanged = [...groupIds].sort().join() !== [...initialGroupIds].sort().join();

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await workspaceDirectoryApi.saveMember(member.id, {
        ...(roleChanged ? { role_ids: roleId ? [roleId] : [] } : {}),
        ...(groupsChanged ? { group_ids: groupIds } : {}),
      });
      toast({ title: `${memberName(member)} updated`, variant: "success" });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this member.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      className="max-w-xl"
      footer={<>
        {!isCurrentUser && (
          <Button className="mr-auto" onClick={() => setConfirmStatusChange(true)} variant={active ? "danger" : "secondary"}>
            {active ? "Suspend access" : "Restore access"}
          </Button>
        )}
        <Button onClick={onClose} variant="secondary">Cancel</Button>
        <Button disabled={!roleChanged && !groupsChanged} loading={busy} onClick={save}>Save changes</Button>
      </>}
      onClose={onClose}
      open
      title={memberName(member)}
    >
      <div className="grid gap-5">
        <div className="flex items-center gap-3">
          <Avatar name={memberName(member)} size="lg" />
          <div className="min-w-0">
            <p className="truncate font-medium text-[var(--text-primary)]">{memberName(member)}</p>
            <p className="truncate text-sm text-[var(--text-secondary)]">{member.email}</p>
          </div>
          {!active && <Badge className="ml-auto" dot tone="warning">Suspended</Badge>}
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">Role</legend>
          {isCurrentUser && (
            <p className="mb-1 text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">
              You can't change your own role. Ask another workspace administrator.
            </p>
          )}
          <RolePicker
            disabled={isCurrentUser}
            name={`member-role-${member.id}`}
            onChange={setRoleId}
            roles={roles}
            value={roleId}
          />
        </fieldset>
        {groups && (
          <div className="grid gap-2">
            <span className="text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">Groups</span>
            <GroupPicker groups={groups} onChange={setGroupIds} value={groupIds} />
          </div>
        )}
        {error && <ErrorState description={error} layout="inline" />}
      </div>
      <ConfirmDialog
        confirmLabel={active ? "Suspend access" : "Restore access"}
        description={
          active
            ? <>Suspending {memberName(member)} immediately removes their access to this workspace.</>
            : <>Restoring {memberName(member)} lets them access this workspace again with their assigned role.</>
        }
        destructive={active}
        onClose={() => setConfirmStatusChange(false)}
        onConfirm={async () => {
          await workspaceDirectoryApi.saveMember(member.id, { status: active ? "suspended" : "active" });
          onClose();
        }}
        open={confirmStatusChange}
        title={active ? "Suspend workspace access?" : "Restore workspace access?"}
      />
    </Dialog>
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOKUP_DELAY_MS = 350;

type AccountLookup =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "found"; account: Account }
  | { state: "missing"; email: string }
  | { state: "error"; message: string };

/**
 * Add someone who already has an account. Identities are never created
 * here: the email resolves to an existing account, shown back for
 * confirmation, and only then are a role and groups offered.
 */
function AddMemberDialog({
  open,
  roles,
  groups,
  onClose,
  onOpenMember,
}: {
  open: boolean;
  roles: Role[];
  groups: Group[] | null;
  onClose: () => void;
  onOpenMember: (memberId: string) => void;
}) {
  const { toast } = useToast();
  const emailRef = useRef<HTMLInputElement | null>(null);
  const [email, setEmail] = useState("");
  const [lookup, setLookup] = useState<AccountLookup>({ state: "idle" });
  const [roleId, setRoleId] = useState("");
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `/roles` lists only roles this workspace can assign; the server re-checks.
  const chosen = roleId || defaultRoleId(roles);
  const address = email.trim().toLowerCase();
  const account = lookup.state === "found" ? lookup.account : null;
  const canAdd = Boolean(account && account.status === "active" && account.workspace_membership === "none" && chosen);

  // The account is looked up only for a whole address, after typing pauses.
  useEffect(() => {
    setError(null);
    if (!EMAIL_PATTERN.test(address)) {
      setLookup({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    setLookup({ state: "checking" });
    const timer = window.setTimeout(() => {
      workspaceDirectoryApi.lookupAccount(address, controller.signal)
        .then((found) => setLookup(found ? { state: "found", account: found } : { state: "missing", email: address }))
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setLookup({ state: "error", message: cause instanceof Error ? cause.message : "Could not look up this email." });
        });
    }, LOOKUP_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [address]);

  const close = () => {
    setEmail("");
    setRoleId("");
    setGroupIds([]);
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!account || !canAdd) return;
    const role = roles.find((item) => item.id === chosen);
    setBusy(true);
    setError(null);
    try {
      const member = await workspaceDirectoryApi.addMember({ email: account.email, role_ids: [chosen], group_ids: groupIds });
      toast({
        title: `${memberName(member)} added`,
        description: role ? `They can now use this workspace as ${role.display_name}.` : undefined,
        variant: "success",
      });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add this member.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      className="max-w-xl"
      footer={<>
        <Button onClick={close} variant="secondary">Cancel</Button>
        <Button disabled={!canAdd} form="add-member-form" loading={busy} type="submit">Add to workspace</Button>
      </>}
      initialFocusRef={emailRef}
      onClose={close}
      open={open}
      title="Add member"
    >
      <form
        className="grid gap-5"
        id="add-member-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-2">
          <label className="configuration-field">Email
            <span className="relative block">
              <Input
                aria-describedby="add-member-lookup"
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@company.com"
                ref={emailRef}
                spellCheck={false}
                type="email"
                value={email}
              />
              {lookup.state === "checking" && (
                <LoaderCircle
                  aria-label="Looking up account"
                  className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--text-tertiary)]"
                />
              )}
            </span>
          </label>
          <div aria-live="polite" id="add-member-lookup">
            <AccountLookupResult lookup={lookup} onOpenMember={onOpenMember} />
          </div>
        </div>

        {canAdd && (
          <>
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">Role</legend>
              <RolePicker name="new-member-role" onChange={setRoleId} roles={roles} value={chosen} />
            </fieldset>
            {groups && groups.length > 0 && (
              <div className="grid gap-2">
                <span className="text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">
                  Groups <span className="font-normal text-[var(--text-tertiary)]">(optional)</span>
                </span>
                <GroupPicker groups={groups} onChange={setGroupIds} value={groupIds} />
              </div>
            )}
          </>
        )}
        {error && <ErrorState description={error} layout="inline" />}
      </form>
    </Dialog>
  );
}

function AccountLookupResult({
  lookup,
  onOpenMember,
}: {
  lookup: AccountLookup;
  onOpenMember: (memberId: string) => void;
}) {
  const { copy, copied } = useClipboard();

  if (lookup.state === "idle") {
    return <p className="text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">Enter the email they sign in with. They need a BoThesis account.</p>;
  }
  if (lookup.state === "checking") {
    return <Skeleton className="h-[3.75rem] w-full rounded-[var(--radius-md)]" />;
  }
  if (lookup.state === "error") {
    return <ErrorState description={lookup.message} layout="inline" />;
  }
  if (lookup.state === "missing") {
    return (
      <div className="grid gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] px-3 py-3">
        <p className="text-[length:var(--text-size-ui)] text-[var(--text-primary)]">
          No BoThesis account uses <strong>{lookup.email}</strong>.
        </p>
        <p className="text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">
          Send them the sign-up link, then add them here once they have an account.
        </p>
        <div>
          <Button
            icon={copied ? <Check size={14} /> : <Copy size={14} />}
            onClick={() => void copy(`${window.location.origin}/auth/signup`)}
            size="sm"
            variant="secondary"
          >
            {copied ? "Link copied" : "Copy sign-up link"}
          </Button>
        </div>
      </div>
    );
  }

  const { account } = lookup;
  const name = account.display_name || account.email;
  const standing = account.status === "disabled"
    ? { tone: "danger" as const, label: "Account disabled", note: "This account is disabled and cannot be added." }
    : account.workspace_membership === "active"
      ? { tone: "neutral" as const, label: "Already a member", note: null }
      : account.workspace_membership === "suspended"
        ? { tone: "warning" as const, label: "Suspended here", note: "Their access to this workspace is suspended. Restore it from their member details." }
        : { tone: "success" as const, label: "Can be added", note: null };

  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-inset)] px-3 py-2.5">
        <Avatar name={name} size="md" />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-[length:var(--text-size-ui)] font-medium text-[var(--text-primary)]">{name}</span>
          {account.display_name && (
            <span className="truncate text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">{account.email}</span>
          )}
        </span>
        <Badge dot tone={standing.tone}>{standing.label}</Badge>
      </div>
      {standing.note && (
        <p className="text-[length:var(--text-size-meta)] text-[var(--text-secondary)]">
          {standing.note}
          {account.workspace_membership === "suspended" && (
            <>
              {" "}
              <button
                className="font-medium text-[var(--text-primary)] underline underline-offset-2 hover:text-[var(--text-accent)]"
                onClick={() => onOpenMember(account.id)}
                type="button"
              >
                Open member details
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Prefer the ordinary member role; never default anyone to administrator. */
function defaultRoleId(roles: Role[]) {
  const assignable = roles.filter((role) => role.status === "active");
  return (
    assignable.find((role) => role.code === "tenant_member")
    ?? assignable.find((role) => !role.permission_codes.includes("user.manage"))
    ?? assignable[0]
  )?.id ?? "";
}

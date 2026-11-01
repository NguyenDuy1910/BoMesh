"use client";

import { MoreHorizontal, Pause, Play, Shield, ShieldOff, UserRound, Users } from "lucide-react";
import { useRef, useState } from "react";

import { Page } from "@/components/shell/Page";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CellTitle, DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { ui } from "@/components/ui/design-system";
import { Drawer, DrawerSection } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClearFilters, FilterChip } from "@/components/ui/FilterChip";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { PageHeader } from "@/components/ui/PageHeader";
import { PreviewTag } from "@/components/ui/PreviewTag";
import { SearchInput } from "@/components/ui/SearchInput";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { Toolbar } from "@/components/ui/Toolbar";
import { usePendingFeature } from "@/lib/api/pending";
import { cn } from "@/lib/cn";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { memberName, memberStatus } from "@/modules/manage/access/directory";
import { listPlatformUsers, updatePlatformUser, type PlatformUser } from "@/modules/platform/api";
import { Facts } from "@/modules/platform/components/Facts";
import { pluralize } from "@/lib/format";
import { useApiData } from "@/lib/hooks/useApiData";

type Confirmation = { user: PlatformUser; change: "make_admin" | "remove_admin" | "suspend" | "reactivate" };

const SELF_EXPLANATION = "You can’t change your own platform role or account status. Ask another platform admin.";

/** The platform role as a word; `null` means the server has not reported it yet. */
function roleLabel(user: PlatformUser): string {
  if (user.is_platform_admin === null) return "Not reported yet";
  return user.is_platform_admin ? "Platform admin" : "Standard";
}

function confirmationCopy({ user, change }: Confirmation) {
  const name = memberName(user);
  const first = (user.display_name?.trim() || user.email).split(" ")[0];
  switch (change) {
    case "make_admin":
      return {
        title: `Make ${name} a platform admin?`,
        description: "They’ll be able to manage every workspace, user and connector on this deployment.",
        confirmLabel: "Make platform admin",
        destructive: false,
        toast: `Made ${name} a platform admin`,
      };
    case "remove_admin":
      return {
        title: `Remove ${name} as platform admin?`,
        description: "They lose access to the platform console. Their workspace roles stay the same.",
        confirmLabel: "Remove platform admin",
        destructive: true,
        toast: `Removed ${name} as platform admin`,
      };
    case "suspend":
      return {
        title: `Suspend ${name}?`,
        description: `${first} can’t sign in to any workspace until you reactivate the account. Nothing is deleted.`,
        confirmLabel: "Suspend account",
        destructive: true,
        toast: `Suspended ${name}`,
      };
    case "reactivate":
      return {
        title: `Reactivate ${name}?`,
        description: `${first} can sign in to their workspaces again.`,
        confirmLabel: "Reactivate account",
        destructive: false,
        toast: `Reactivated ${name}`,
      };
  }
}

/**
 * Platform → Users: every account, its platform role and whether it can sign
 * in. Role and suspension changes go through `platform.user_admin`; nobody can
 * change their own row, and the screen says why instead of hiding the action.
 */
export function PlatformUsersPage() {
  const canAdmin = usePendingFeature("platform.user_admin");
  const session = useAuthSession();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const query = useApiData(() => listPlatformUsers({ search }), search);
  const all = query.data ?? [];

  const rows = all.filter((user) => {
    if (status && memberStatus(user) !== status) return false;
    if (role === "admin") return user.is_platform_admin === true;
    if (role === "standard") return user.is_platform_admin === false;
    if (role === "unknown") return user.is_platform_admin === null;
    return true;
  });
  const filtered = Boolean(search || role || status);
  const roleOptions = [
    { value: "admin", label: "Platform admin" },
    { value: "standard", label: "Standard" },
    ...(all.some((user) => user.is_platform_admin === null) ? [{ value: "unknown", label: "Not reported yet" }] : []),
  ];

  const remembered = useRef<PlatformUser | null>(null);
  const found = openId ? all.find((user) => user.id === openId) ?? null : null;
  if (found) remembered.current = found;
  const selected = found ?? (remembered.current?.id === openId ? remembered.current : null);

  const isSelf = (user: PlatformUser) => user.id === session?.user_id;

  const apply = async (confirmation: Confirmation) => {
    const { user, change } = confirmation;
    await updatePlatformUser(user.id, change === "make_admin" || change === "remove_admin"
      ? { is_platform_admin: change === "make_admin" }
      : { status: change === "suspend" ? "suspended" : "active" });
    toast.show({ message: confirmationCopy(confirmation).toast });
  };

  const columns: DataTableColumn<PlatformUser>[] = [
    {
      id: "name",
      header: "Person",
      sortable: true,
      sortValue: (user) => memberName(user).toLowerCase(),
      cell: (user) => (
        <CellTitle
          icon={<Avatar name={memberName(user)} size="lg" />}
          subtitle={[user.display_name?.trim() ? user.email : null, user.changed_locally ? "Changed in this browser" : null].filter(Boolean).join(" · ") || undefined}
          title={(
            <span className="inline-flex max-w-full items-center gap-2">
              <span className="truncate">{memberName(user)}</span>
              {isSelf(user) && <span className="font-normal text-text-tertiary">· You</span>}
              {user.changed_locally && <PreviewTag />}
            </span>
          )}
        />
      ),
    },
    {
      id: "role",
      // `is_platform_admin` is a proposed field (`platform.user_admin`); the server does not send it yet.
      header: <span className="inline-flex items-center gap-2">Platform role <PreviewTag /></span>,
      width: 210,
      cell: (user) => user.is_platform_admin
        ? <Badge dot={false} tone="accent">Platform admin</Badge>
        : <span className="text-text-tertiary">{roleLabel(user)}</span>,
    },
    {
      id: "status",
      header: "Status",
      width: 140,
      cell: (user) => <StatusBadge kind="member" value={memberStatus(user)} />,
    },
  ];

  const roleItems = (user: PlatformUser) => {
    const self = isSelf(user);
    const make = (
      <MenuItem disabled={self} icon={<Shield size={16} />} key="make" onSelect={() => setConfirming({ user, change: "make_admin" })} shortcut={self ? "You" : undefined}>
        Make platform admin
      </MenuItem>
    );
    const remove = (
      <MenuItem disabled={self} icon={<ShieldOff size={16} />} key="remove" onSelect={() => setConfirming({ user, change: "remove_admin" })} shortcut={self ? "You" : undefined}>
        Remove platform admin
      </MenuItem>
    );
    // An unreported role offers both: the operator may know what the server does not say yet.
    if (user.is_platform_admin === null) return [make, remove];
    return user.is_platform_admin ? [remove] : [make];
  };

  const rowMenu = (user: PlatformUser) => {
    const self = isSelf(user);
    const suspended = memberStatus(user) === "suspended";
    return (
      <Menu
        align="end"
        trigger={(props) => (
          <button {...props} aria-label={`More actions for ${memberName(user)}`} className={cn(ui.iconButton, "size-8")}>
            <MoreHorizontal aria-hidden="true" size={16} />
          </button>
        )}
      >
        <MenuItem icon={<UserRound size={16} />} onSelect={() => setOpenId(user.id)}>View details</MenuItem>
        {canAdmin && (
          <>
            <MenuSeparator />
            {roleItems(user)}
            <MenuItem
              danger={!suspended}
              disabled={self}
              icon={suspended ? <Play size={16} /> : <Pause size={16} />}
              onSelect={() => setConfirming({ user, change: suspended ? "reactivate" : "suspend" })}
              shortcut={self ? "You" : undefined}
            >
              {suspended ? "Reactivate account" : "Suspend account"}
            </MenuItem>
          </>
        )}
      </Menu>
    );
  };

  const copy = confirming ? confirmationCopy(confirming) : null;

  return (
    <Page>
      <PageHeader sub="Everyone with a BoMesh account." title="Users" />
      <Toolbar
        end={query.data && <span className="text-meta text-text-tertiary">{pluralize(rows.length, "account")}</span>}
        filters={(
          <>
            <FilterChip label="Platform role" onChange={setRole} options={roleOptions} value={role} />
            <FilterChip
              label="Status"
              onChange={setStatus}
              options={[{ value: "active", label: "Active" }, { value: "suspended", label: "Suspended" }]}
              value={status}
            />
            <ClearFilters active={Boolean(role || status)} onClear={() => { setRole(""); setStatus(""); }} />
          </>
        )}
        search={<SearchInput ariaLabel="Search by name or email" onChange={setSearch} placeholder="Search by name or email" value={search} />}
      />
      <DataTable
        activeRowId={selected?.id ?? null}
        ariaLabel="Accounts"
        columns={columns}
        data={rows}
        emptyState={(
          <EmptyState
            description="People appear here once they sign up or are added to a workspace."
            icon={<Users aria-hidden="true" />}
            title="No accounts yet"
          />
        )}
        error={query.error}
        filtered={filtered}
        loading={!query.data && !query.error}
        onClearFilters={() => {
          setSearch("");
          setRole("");
          setStatus("");
        }}
        onRetry={query.reload}
        onRowClick={(user) => setOpenId(user.id)}
        rowActions={rowMenu}
      />

      <Drawer
        description={selected?.email}
        footer={selected && canAdmin && (isSelf(selected) ? (
          <span className="mr-auto text-meta text-text-tertiary">{SELF_EXPLANATION}</span>
        ) : (
          <>
            {memberStatus(selected) === "suspended" ? (
              <Button onClick={() => setConfirming({ user: selected, change: "reactivate" })} variant="secondary">Reactivate account</Button>
            ) : (
              <Button onClick={() => setConfirming({ user: selected, change: "suspend" })} variant="danger-ghost">Suspend account</Button>
            )}
            {selected.is_platform_admin !== true && (
              <Button onClick={() => setConfirming({ user: selected, change: "make_admin" })} variant="secondary">Make platform admin</Button>
            )}
            {selected.is_platform_admin !== false && (
              <Button onClick={() => setConfirming({ user: selected, change: "remove_admin" })} variant="secondary">Remove platform admin</Button>
            )}
          </>
        ))}
        header={selected && (selected.is_platform_admin || memberStatus(selected) === "suspended" || selected.changed_locally) ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {memberStatus(selected) === "suspended" && <StatusBadge kind="member" value="suspended" />}
            {selected.is_platform_admin && <Badge dot={false} tone="accent">Platform admin</Badge>}
            {selected.changed_locally && <PreviewTag />}
          </div>
        ) : undefined}
        icon={selected && <Avatar name={memberName(selected)} size="xl" />}
        onClose={() => setOpenId(null)}
        open={Boolean(selected)}
        title={selected ? `${memberName(selected)}${isSelf(selected) ? " (you)" : ""}` : ""}
      >
        {selected && (
          <>
            {selected.changed_locally && (
              <Callout className="mb-5" tone="neutral">
                Changed in this browser only. The server still reports the original role and status.
              </Callout>
            )}
            <DrawerSection title="Account">
              <Facts
                items={[
                  ["Platform role", roleLabel(selected)],
                  ["Account", memberStatus(selected) === "suspended" ? "Suspended — can’t sign in" : "Active"],
                ]}
              />
            </DrawerSection>
            {isSelf(selected) && !canAdmin && <p className="text-meta text-text-tertiary">{SELF_EXPLANATION}</p>}
          </>
        )}
      </Drawer>

      <ConfirmDialog
        confirmLabel={copy?.confirmLabel ?? ""}
        description={copy?.description ?? ""}
        destructive={copy?.destructive ?? false}
        onClose={() => setConfirming(null)}
        onConfirm={() => (confirming ? apply(confirming) : undefined)}
        open={Boolean(confirming)}
        title={copy?.title ?? ""}
      />
    </Page>
  );
}

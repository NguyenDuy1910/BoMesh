"use client";

import { Button } from "@heroui/react";
import { Building2, ChevronRight, Pause, Play, Shield, User as UserIcon, Users } from "lucide-react";

import {
  ClearFilters,
  confirm,
  DataTable,
  EmptyState,
  FilterButton,
  Gate,
  KeyValue,
  List,
  ListItem,
  NoMatches,
  Page,
  PageHeader,
  PreviewChip,
  SearchInput,
  SkeletonRows,
  StatusChip,
  SwitchRow,
  toast,
  UserAvatar,
  WorkspaceMark,
} from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { fmtNum, plural, rel } from "@/lib/format";
import { useMessages } from "@/lib/i18n";
import { useSession } from "@/lib/session";

import { activateUser, suspendUser, updatePlatformRole, type User } from "../api";
import { lastSegment, ROLE_OPTIONS, userName, type PlatformRole } from "../model";
import { pk, useInvalidatePlatform, useIsPlatformAdmin, usePlatformUsers, useReadableMemberships } from "../queries";
import { MoreMenu, PlatformDrawer, PREVIEW_TIP, useUrlState, workspaceUrl } from "./shared";

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
];

/** Search and filters appear once the list is long enough to need them (preview `TOOLS_MIN`). */
const TOOLS_MIN = 7;

const lastActive = (u: User) => (u.lastActiveTime ? rel(u.lastActiveTime) : "Never");

function RoleChip({ role }: { role: User["platformRole"] }) {
  if (role === "ADMIN") return <StatusChip label="Platform admin" tone="accent" icon={Shield} size="sm" />;
  if (role === "OPERATOR") return <StatusChip label="Platform operator" tone="default" icon={Shield} size="sm" />;
  return null;
}

/**
 * Role and suspension changes (never on your own account). Granting platform admin is high-risk and asks once;
 * everything else is reversible and applies at once with Undo (preview `toggleAdmin` / `suspendUser`).
 */
function useUserActions() {
  const invalidate = useInvalidatePlatform();

  const run = async (work: () => Promise<User>, message: string, undo: (updated: User) => Promise<User>) => {
    try {
      const updated = await work();
      await invalidate(pk.users);
      toast(message, {
        undo: () =>
          void undo(updated)
            .then(() => invalidate(pk.users))
            .catch((error: unknown) => toast(errorMessage(error), { tone: "danger" })),
      });
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const setRole = async (u: User, role: PlatformRole) => {
    const name = userName(u);
    const before = u.platformRole ?? "NONE";
    if (role === before) return;
    if (role === "ADMIN") {
      const ok = await confirm({
        title: `Make ${name} a platform admin?`,
        description: "They’ll manage every workspace, user and connector on this deployment.",
        confirmLabel: "Make platform admin",
        tone: "accent",
      });
      if (!ok) return;
    }
    const message =
      role === "ADMIN"
        ? `${name} is now a platform admin`
        : role === "OPERATOR"
          ? before === "ADMIN"
            ? `${name} is no longer a platform admin`
            : `${name} is now a platform operator`
          : `${name} is no longer a platform ${before === "ADMIN" ? "admin" : "operator"}`;
    await run(() => updatePlatformRole(u, role), message, (updated) => updatePlatformRole(updated, before));
  };

  const toggleSuspend = (u: User) => {
    const name = userName(u);
    const on = u.state !== "SUSPENDED";
    return run(
      () => (on ? suspendUser(u) : activateUser(u)),
      on ? `Suspended ${name}. They can’t sign in to any workspace.` : `Reactivated ${name}`,
      (updated) => (on ? activateUser(updated) : suspendUser(updated)),
    );
  };

  return { setRole, toggleSuspend };
}

/** Preview `DR['pf-user']`: status, last active, workspaces, platform role; suspend in ⋯, reactivate in the footer. */
function UserDrawer({ userId, users, onClose }: { userId: string | null; users: readonly User[] | undefined; onClose: () => void }) {
  const session = useSession();
  const isAdmin = useIsPlatformAdmin();
  const actions = useUserActions();
  const memberships = useReadableMemberships(Boolean(userId));
  if (!userId) return <PlatformDrawer isOpen={false} onClose={onClose} title="">{null}</PlatformDrawer>;
  const u = users?.find((x) => lastSegment(x.name) === userId);
  if (!u) {
    return (
      <PlatformDrawer isOpen onClose={onClose} title={users ? "Account not found" : "Loading account"}>
        {users ? <EmptyState icon={UserIcon} title="This account no longer exists" compact /> : <SkeletonRows rows={3} />}
      </PlatformDrawer>
    );
  }
  const self = u.name === session?.user.name;
  const name = userName(u);
  const role = u.platformRole ?? "NONE";
  const suspended = u.state === "SUSPENDED";
  const mships = memberships.data?.byUser.get(u.name ?? "");
  const manage = isAdmin && !self;
  return (
    <PlatformDrawer
      isOpen
      onClose={onClose}
      lead={<UserAvatar name={name} size="lg" />}
      title={self ? `${name} (you)` : name}
      description={u.email}
      headActions={
        manage && !suspended ? <MoreMenu items={[{ id: "suspend", label: "Suspend account", icon: Pause, danger: true, onAction: () => void actions.toggleSuspend(u) }]} /> : null
      }
      footer={
        manage && suspended ? (
          <Button variant="primary" onPress={() => void actions.toggleSuspend(u)}>
            <Play className="i" aria-hidden />
            Reactivate account
          </Button>
        ) : null
      }
    >
      <div className="drawer__section">
        <KeyValue
          pairs={[
            ["Status", <StatusChip key="s" kind="member" value={suspended ? "suspended" : "active"} />],
            ["Last active", lastActive(u)],
            !isAdmin && role !== "NONE" && ["Platform role", <RoleChip key="r" role={role} />],
          ]}
        />
      </div>
      <div className="drawer__section">
        <div className="pf-sec-head">
          <h3 className="drawer__section-title">Workspaces</h3>
          <span className="t-xs muted num">{mships ? fmtNum(mships.length) : ""}</span>
        </div>
        {memberships.isPending ? (
          <SkeletonRows rows={2} />
        ) : memberships.isError ? (
          <p className="t-sm muted">Workspaces didn’t load.</p>
        ) : mships?.length ? (
          <List>
            {mships.map(({ workspace: w, roles, suspended: off }) => (
              <ListItem
                key={w.name}
                lead={<WorkspaceMark name={w.displayName ?? ""} logo={w.logoUri} size={28} />}
                title={<span translate="no">{w.displayName}</span>}
                label={w.displayName}
                description={<span className="mono">{workspaceUrl(w)}</span>}
                meta={off ? "Suspended" : roles.includes("roles/workspaceAdmin") ? "Admin" : "Member"}
                actions={<ChevronRight className="i i-sm muted" aria-hidden />}
                href={`/p/workspaces?open=${lastSegment(w.name)}`}
              />
            ))}
          </List>
        ) : memberships.data?.hidden ? (
          <p className="t-sm muted">Not in any workspace you belong to.</p>
        ) : (
          <EmptyState icon={Building2} title="Not in any workspace" description="Platform admins can manage workspaces without joining them." compact boxed />
        )}
        {memberships.data?.hidden ? <p className="t-xs muted mt-8">Only workspaces you belong to are listed. Members of other workspaces aren’t visible to the platform console.</p> : null}
      </div>
      {isAdmin ? (
        <div className="drawer__section">
          <SwitchRow
            title="Platform admin"
            description={self ? "You can’t change your own platform role." : "Can manage every workspace, user and connector."}
            isSelected={role === "ADMIN"}
            isDisabled={self}
            onChange={(on) => void actions.setRole(u, on ? "ADMIN" : "NONE")}
          />
          <SwitchRow
            title="Platform operator"
            description={role === "ADMIN" ? "Included in platform admin." : "Can see every workspace, user and indexing job without changing them."}
            isSelected={role !== "NONE"}
            isDisabled={self || role === "ADMIN"}
            onChange={(on) => void actions.setRole(u, on ? "OPERATOR" : "NONE")}
          />
        </div>
      ) : null}
    </PlatformDrawer>
  );
}

/** Preview `P.pUsers`: every account on the deployment; status and platform role sit next to the name. */
export function UsersPage() {
  const m = useMessages();
  const url = useUrlState();
  const session = useSession();
  const users = usePlatformUsers();
  const q = url.get("q");
  const role = url.get("role");
  const status = url.get("status");
  const filtered = Boolean(q || role || status);

  return (
    <Page width="wide">
      <PageHeader title={m.nav.users} chips={<PreviewChip tooltip={PREVIEW_TIP} />} />
      <Gate
        query={users}
        skeleton={<SkeletonRows rows={8} />}
        isEmpty={(data) => data.length === 0}
        empty={<EmptyState icon={Users} title="No accounts yet" description="People appear here once they sign up or are invited to a workspace." boxed />}
      >
        {(all) => {
          const needle = q.trim().toLowerCase();
          const rows = all
            .filter(
              (u) =>
                (!needle || [u.displayName, u.email, u.username].some((v) => v?.toLowerCase().includes(needle))) &&
                (!role || (u.platformRole ?? "NONE") === role) &&
                (!status || u.state === status),
            )
            .sort((a, b) => userName(a).localeCompare(userName(b)));
          return (
            <>
              {all.length >= TOOLS_MIN || filtered ? (
                <div className="toolbar">
                  <SearchInput value={q} onChange={(v) => url.set({ q: v })} placeholder="Search by name or email" />
                  <FilterButton label="Platform role" value={role} onChange={(v) => url.set({ role: v })} options={ROLE_OPTIONS} />
                  <FilterButton label="Status" value={status} onChange={(v) => url.set({ status: v })} options={STATUS_OPTIONS} />
                  <ClearFilters isActive={Boolean(role || status)} onClear={() => url.set({ role: null, status: null })} />
                </div>
              ) : null}
              {rows.length ? (
                <DataTable
                  label="Users"
                  rows={rows}
                  getRowId={(u) => lastSegment(u.name)}
                  onRowAction={(u) => url.set({ open: lastSegment(u.name) })}
                  columns={[
                    {
                      id: "name",
                      header: "Person",
                      primary: true,
                      sortValue: (u) => userName(u).toLowerCase(),
                      cell: (u) => (
                        <div className="row gap-12">
                          <UserAvatar name={userName(u)} />
                          <div className="stack">
                            <span className="cell-title row gap-8 wrap">
                              <span className="truncate">
                                {userName(u)}
                                {u.name === session?.user.name ? <span className="muted t-sm"> (you)</span> : null}
                              </span>
                              {u.state === "SUSPENDED" ? <StatusChip kind="member" value="suspended" size="sm" /> : null}
                              <RoleChip role={u.platformRole} />
                            </span>
                            <span className="cell-sub truncate">{u.email}</span>
                          </div>
                        </div>
                      ),
                    },
                    {
                      id: "last",
                      header: "Last active",
                      className: "hide-md",
                      hideOnMobile: true,
                      sortValue: (u) => Date.parse(u.lastActiveTime ?? "") || 0,
                      cell: (u) => <span className="muted">{lastActive(u)}</span>,
                    },
                  ]}
                  footer={
                    <div className="table-foot">
                      <span className="num">{plural(rows.length, "account")}</span>
                    </div>
                  }
                />
              ) : (
                <NoMatches what="people" onClear={() => url.set({ q: null, role: null, status: null })} />
              )}
            </>
          );
        }}
      </Gate>
      <UserDrawer userId={url.get("open") || null} users={users.data} onClose={() => url.set({ open: null })} />
    </Page>
  );
}

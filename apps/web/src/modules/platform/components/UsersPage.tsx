"use client";

import { Button } from "@heroui/react";
import { Building2, ChevronRight, Pause, Play, Shield, User as UserIcon, Users } from "lucide-react";

import { PageChrome } from "@/components/shell/page-chrome";
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
import { fmtDate, fmtNum, plural, rel } from "@/lib/format";
import { useSession } from "@/lib/session";

import { activateUser, suspendUser, updatePlatformRole, type User } from "../api";
import { lastSegment, ROLE_OPTIONS, userName, type PlatformRole } from "../model";
import { pk, useInvalidatePlatform, useIsPlatformAdmin, usePlatformUsers, useReadableMemberships } from "../queries";
import { PlatformDrawer, PREVIEW_TIP, useUrlState, workspaceUrl } from "./shared";

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
];

const lastActive = (u: User) => (u.lastActiveTime ? rel(u.lastActiveTime) : "Never");

function RoleChip({ role }: { role: User["platformRole"] }) {
  if (role === "ADMIN") return <StatusChip label="Platform admin" tone="accent" icon={Shield} size="sm" />;
  if (role === "OPERATOR") return <StatusChip label="Platform operator" tone="default" icon={Shield} size="sm" />;
  return <span className="muted hide-sm">Standard</span>;
}

/** Role and suspension changes with the preview's confirmations (never on your own account). */
function useUserActions() {
  const invalidate = useInvalidatePlatform();

  const run = async (work: Promise<unknown>, message: string) => {
    try {
      await work;
      await invalidate(pk.users);
      toast(message);
    } catch (error) {
      toast(errorMessage(error), { tone: "danger" });
    }
  };

  const setRole = async (u: User, role: PlatformRole) => {
    const name = userName(u);
    const current = u.platformRole ?? "NONE";
    if (role === current) return;
    let ok: boolean;
    let message: string;
    if (role === "ADMIN") {
      ok = await confirm({ title: `Make ${name} a platform admin?`, description: "They’ll manage every workspace, user and connector on this deployment.", confirmLabel: "Make platform admin", tone: "accent" });
      message = `${name} is now a platform admin`;
    } else if (role === "OPERATOR" && current === "NONE") {
      ok = await confirm({ title: `Make ${name} a platform operator?`, description: "They’ll see every workspace, user and indexing job on this deployment, without changing them.", confirmLabel: "Make platform operator", tone: "accent" });
      message = `${name} is now a platform operator`;
    } else if (current === "ADMIN") {
      ok = await confirm({ title: `Remove ${name} as platform admin?`, description: "They lose access to the platform console. Their workspace roles stay the same.", confirmLabel: "Remove platform admin", tone: "danger" });
      message = `${name} is no longer a platform admin`;
    } else {
      ok = await confirm({ title: `Remove ${name} as platform operator?`, description: "They lose access to the platform console. Their workspace roles stay the same.", confirmLabel: "Remove platform operator", tone: "danger" });
      message = `${name} is no longer a platform operator`;
    }
    if (ok) await run(updatePlatformRole(u, role), message);
  };

  const toggleSuspend = async (u: User) => {
    const name = userName(u);
    const first = name.split(" ")[0];
    if (u.state === "SUSPENDED") {
      const ok = await confirm({ title: `Reactivate ${name}?`, description: `${first} can sign in to their workspaces again.`, confirmLabel: "Reactivate account", tone: "accent" });
      if (ok) await run(activateUser(u), `Reactivated ${name}`);
      return;
    }
    const ok = await confirm({
      title: `Suspend ${name}?`,
      description: `${first} can’t sign in to any workspace until you reactivate the account. Nothing is deleted.`,
      confirmLabel: "Suspend account",
      tone: "danger",
    });
    if (ok) await run(suspendUser(u), `Suspended ${name}`);
  };

  return { setRole, toggleSuspend };
}

/** Preview `DR['pf-user']`: status, last active, platform role switches, suspend or reactivate. */
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
  const mships = memberships.data?.byUser.get(u.name ?? "");
  return (
    <PlatformDrawer
      isOpen
      onClose={onClose}
      lead={<UserAvatar name={name} size="lg" />}
      title={self ? `${name} (you)` : name}
      description={u.email}
      footerStart={
        isAdmin && !self ? (
          u.state === "SUSPENDED" ? (
            <Button variant="tertiary" onPress={() => void actions.toggleSuspend(u)}>
              <Play className="i" aria-hidden />
              Reactivate account
            </Button>
          ) : (
            <Button variant="danger-soft" onPress={() => void actions.toggleSuspend(u)}>
              <Pause className="i" aria-hidden />
              Suspend account
            </Button>
          )
        ) : null
      }
      footer={
        <Button variant="tertiary" onPress={onClose}>
          Done
        </Button>
      }
    >
      <div className="drawer__section">
        <KeyValue
          pairs={[
            ["Status", <StatusChip key="s" kind="member" value={u.state === "SUSPENDED" ? "suspended" : "active"} />],
            ["Last active", lastActive(u)],
            ["Joined", fmtDate(u.createTime)],
            !isAdmin && ["Platform role", <RoleChip key="r" role={role} />],
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
            {mships.map(({ workspace: w, roles, suspended }) => (
              <ListItem
                key={w.name}
                lead={<WorkspaceMark name={w.displayName ?? ""} size={28} />}
                title={<span translate="no">{w.displayName}</span>}
                label={w.displayName}
                description={<span className="mono">{workspaceUrl(w)}</span>}
                meta={
                  <span className="row gap-6">
                    {suspended ? "Suspended" : roles.includes("roles/workspaceAdmin") ? "Admin" : "Member"}
                    <ChevronRight className="i-sm muted" aria-hidden />
                  </span>
                }
                href={`/p/workspaces?open=${lastSegment(w.name)}`}
              />
            ))}
          </List>
        ) : memberships.data?.hidden ? (
          <p className="t-sm muted">Not in any workspace you belong to.</p>
        ) : (
          <EmptyState
            icon={Building2}
            title="Not in any workspace"
            description="Platform admins can manage workspaces without joining them."
            compact
            boxed
          />
        )}
        {memberships.data?.hidden ? (
          <p className="t-xs muted mt-8">Only workspaces you belong to are listed. Members of other workspaces aren’t visible to the platform console.</p>
        ) : null}
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

/** Preview `P.pUsers`: accounts across workspaces with role and status filters. */
export function UsersPage() {
  const url = useUrlState();
  const session = useSession();
  const users = usePlatformUsers();
  const q = url.get("q");
  const role = url.get("role");
  const status = url.get("status");

  return (
    <Page>
      <PageChrome crumbs={[{ label: "Users" }]} />
      <PageHeader title="Users" chips={<PreviewChip tooltip={PREVIEW_TIP} />} />
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
              <div className="toolbar">
                <SearchInput value={q} onChange={(v) => url.set({ q: v })} placeholder="Search by name or email" />
                <FilterButton label="Platform role" value={role} onChange={(v) => url.set({ role: v })} options={ROLE_OPTIONS} />
                <FilterButton label="Status" value={status} onChange={(v) => url.set({ status: v })} options={STATUS_OPTIONS} />
                <ClearFilters isActive={Boolean(role || status)} onClear={() => url.set({ role: null, status: null })} />
              </div>
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
                            <span className="cell-title truncate">
                              {userName(u)}
                              {u.name === session?.user.name ? <span className="muted t-sm"> (you)</span> : null}
                            </span>
                            <span className="cell-sub truncate">{u.email}</span>
                          </div>
                        </div>
                      ),
                    },
                    { id: "role", header: "Platform role", cell: (u) => <RoleChip role={u.platformRole} /> },
                    {
                      id: "last",
                      header: "Last active",
                      className: "hide-md",
                      hideOnMobile: true,
                      sortValue: (u) => Date.parse(u.lastActiveTime ?? "") || 0,
                      cell: (u) => <span className="muted">{lastActive(u)}</span>,
                    },
                    { id: "status", header: "Status", cell: (u) => <StatusChip kind="member" value={u.state === "SUSPENDED" ? "suspended" : "active"} /> },
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

"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useTokenPages } from "@/lib/paging";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";

import {
  analyzePolicy,
  getMember,
  getWorkspacePolicy,
  listAccessRequestPage,
  listCustomRoles,
  listGroups,
  listMemberPage,
  listPermissions,
  listPredefinedRoles,
  setWorkspacePolicy,
  type Group,
  type Member,
  type Policy,
} from "./api";
import { ADMIN_ROLE, directRoles, literal, primaryRole, roleCounts, withRoles, workspaceRoles, type GuardMember, type WorkspaceRole } from "./model";

/** Query keys; every key starts with the workspace ID, mutations invalidate `[ws, "people"]`. */
export const peopleKeys = {
  all: (ws: string) => [ws, "people"] as const,
  members: (ws: string) => [ws, "people", "members"] as const,
  member: (ws: string, id: string) => [ws, "people", "member", id] as const,
  admins: (ws: string) => [ws, "people", "admins"] as const,
  groups: (ws: string) => [ws, "people", "groups"] as const,
  roles: (ws: string) => [ws, "people", "roles"] as const,
  policy: (ws: string) => [ws, "people", "policy"] as const,
  requests: (ws: string) => [ws, "people", "requests"] as const,
  analysis: (ws: string, principal: string) => [ws, "people", "analysis", principal] as const,
  lastSignIn: (ws: string, user: string) => [ws, "people", "lastSignIn", user] as const,
  permissions: ["permission-catalog"] as const,
  predefinedRoles: ["predefined-roles"] as const,
};

/** Refresh People data plus what depends on it (sidebar badge, member names elsewhere). Resolves once refetched. */
export function invalidatePeople(qc: QueryClient, ws: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: peopleKeys.all(ws) }),
    qc.invalidateQueries({ queryKey: [ws, "shell-badge", "access"] }),
    qc.invalidateQueries({ queryKey: [ws, "members"] }),
  ]);
}

export function useGroupsQuery() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: peopleKeys.groups(id), queryFn: () => listGroups(id) });
}

export function usePolicyQuery() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: peopleKeys.policy(id), queryFn: () => getWorkspacePolicy(id), retry: false });
}

/** Built-in and custom workspace roles. */
export function useRolesQuery() {
  const { id } = useWorkspace();
  const predefined = useQuery({ queryKey: peopleKeys.predefinedRoles, queryFn: listPredefinedRoles, staleTime: 30 * 60_000 });
  const custom = useQuery({ queryKey: peopleKeys.roles(id), queryFn: () => listCustomRoles(id) });
  const data = useMemo(
    () => (predefined.data && custom.data ? workspaceRoles(predefined.data, custom.data.map((r) => ({ ...r, includedPermissions: r.includedPermissions ?? [] }))) : undefined),
    [predefined.data, custom.data],
  );
  return {
    data,
    isPending: predefined.isPending || custom.isPending,
    isError: predefined.isError || custom.isError,
    error: predefined.error ?? custom.error,
    refetch: () => Promise.all([predefined.refetch(), custom.refetch()]),
  };
}

/** Permission IDs custom roles may include. */
export function usePermissionCatalog() {
  return useQuery({
    queryKey: peopleKeys.permissions,
    queryFn: async () => new Set((await listPermissions()).filter((p) => p.customRolesSupported !== false).map((p) => resourceId(p.name))),
    staleTime: 30 * 60_000,
  });
}

/** Knowledge-base access requests matching `filter` (e.g. pending ones), one server page at a time. */
export function useAccessRequestPages(filter: string, orderBy: string, pageSize: number, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useTokenPages([...peopleKeys.requests(id), filter, orderBy, pageSize], (pageToken) => listAccessRequestPage(id, { filter, orderBy, pageSize, pageToken }), { enabled });
}

export function useAnalysis(principal: string | null, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: peopleKeys.analysis(id, principal ?? ""),
    queryFn: () => analyzePolicy(id, principal!),
    enabled: enabled && Boolean(principal),
    staleTime: 30_000,
  });
}

/** A member with the role the UI shows and their group names. */
export interface Person extends GuardMember {
  /** Bare member ID (= user ID). */
  id: string;
  /** `workspaces/{w}/members/{m}`. */
  name: string;
  displayName: string;
  email: string;
  groups: string[];
  member: Member;
}

/** The role the UI shows: the workspace roles bound directly in the policy, else the member's own `roles` (no policy access). */
function toPerson(member: Member, policy: Policy | undefined, roleNames: ReadonlySet<string>): Person {
  const held = policy ? directRoles(policy, resourceId(member.user), roleNames) : (member.roles ?? []).filter((r) => roleNames.has(r));
  return {
    id: resourceId(member.name),
    name: member.name ?? "",
    user: member.user,
    displayName: member.displayName || member.email || "Ai đó",
    email: member.email ?? "",
    state: member.state,
    role: primaryRole(held.length ? held : (member.roles ?? [])),
    groups: member.groups ?? [],
    member,
  };
}

export interface Directory {
  roles: WorkspaceRole[];
  groups: Group[];
  roleByName: Map<string, WorkspaceRole>;
  groupByName: Map<string, Group>;
  /** Active workspace admins (the self / last-admin guards). */
  admins: Person[];
  /** People per role, from the workspace policy. */
  roleCounts: ReadonlyMap<string, number>;
  /** A listed member as a row. */
  person: (member: Member) => Person;
  /** The caller's `users/{id}`. */
  self: string;
}

/** How many active admins the guards read: they only need to know whether another one remains. */
const ADMIN_PAGE = 50;

/** Roles, groups, the policy and the active admins joined into one directory (Gate-compatible); members are read a page at a time. */
export function useDirectory() {
  const { id } = useWorkspace();
  const session = useSession();
  const groups = useGroupsQuery();
  const policy = usePolicyQuery();
  const roles = useRolesQuery();
  const admins = useQuery({
    queryKey: peopleKeys.admins(id),
    queryFn: async () => (await listMemberPage(id, { filter: `roles:${literal(ADMIN_ROLE)} AND state = "ACTIVE"`, pageSize: ADMIN_PAGE })).members ?? [],
  });
  const data = useMemo((): Directory | undefined => {
    if (!groups.data || !roles.data || !admins.data) return undefined;
    if (policy.isPending) return undefined;
    const roleNames = new Set(roles.data.map((r) => r.name));
    const person = (m: Member) => toPerson(m, policy.data, roleNames);
    return {
      roles: roles.data,
      groups: groups.data,
      roleByName: new Map(roles.data.map((r) => [r.name, r])),
      groupByName: new Map(groups.data.map((g) => [g.name ?? "", g])),
      admins: admins.data.map(person).filter((p) => p.role === ADMIN_ROLE),
      roleCounts: roleCounts(policy.data, roleNames),
      person,
      self: session?.user.name ?? "",
    };
  }, [groups.data, roles.data, admins.data, policy.data, policy.isPending, session?.user.name]);
  const failed = groups.isError || roles.isError || admins.isError;
  return {
    data,
    isPending: !data && !failed,
    isError: failed,
    error: groups.error ?? roles.error ?? admins.error,
    refetch: () => Promise.all([groups.refetch(), roles.refetch(), policy.refetch(), admins.refetch()]),
  };
}

/** One page of members matching `filter` (see `memberFilter`), as directory rows. */
export function useMemberPages(dir: Directory | undefined, filter: string, { orderBy = "displayName", pageSize, enabled = true }: { orderBy?: string; pageSize: number; enabled?: boolean }) {
  const { id } = useWorkspace();
  const pages = useTokenPages([...peopleKeys.members(id), filter, orderBy, pageSize], (pageToken) => listMemberPage(id, { filter: filter || undefined, orderBy, pageSize, pageToken }), {
    enabled: enabled && Boolean(dir),
  });
  const members = pages.data?.members;
  const rows = useMemo(() => (dir && members ? members.map(dir.person) : undefined), [dir, members]);
  return { ...pages, rows };
}

/** One member by bare ID (the member drawer); `null` once it no longer exists. */
export function usePerson(dir: Directory | undefined, memberId: string | null) {
  const { id } = useWorkspace();
  const query = useQuery({ queryKey: peopleKeys.member(id, memberId ?? ""), queryFn: () => getMember(id, memberId!), enabled: Boolean(memberId), retry: false });
  const person = useMemo(() => (dir && query.data ? dir.person(query.data) : undefined), [dir, query.data]);
  return { person, gone: query.isError };
}

/** Gives each user (`users/{id}` → role) exactly one workspace role: read-modify-write of the policy. */
export async function applyRoles(workspace: string, changes: ReadonlyMap<string, string>, roleNames: ReadonlySet<string>) {
  const current = await getWorkspacePolicy(workspace);
  const byId = new Map([...changes].map(([user, role]) => [resourceId(user), role]));
  await setWorkspacePolicy(workspace, withRoles(current, byId, roleNames));
}

export function usePeopleClient() {
  const qc = useQueryClient();
  const { id } = useWorkspace();
  const refresh = useCallback(() => invalidatePeople(qc, id), [qc, id]);
  return { qc, ws: id, refresh };
}

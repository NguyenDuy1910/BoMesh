"use client";

import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { resourceId } from "@/lib/api/client";
import { useSession } from "@/lib/session";
import { useWorkspace } from "@/lib/workspace";

import {
  analyzePolicy,
  getWorkspacePolicy,
  listAccessRequests,
  listCustomRoles,
  listGroups,
  listMembers,
  listPermissions,
  listPredefinedRoles,
  setWorkspacePolicy,
  type Group,
  type Member,
} from "./api";
import { directRoles, primaryRole, withRoles, workspaceRoles, type GuardMember, type WorkspaceRole } from "./model";

/** Query keys; every key starts with the workspace ID, mutations invalidate `[ws, "people"]`. */
export const peopleKeys = {
  all: (ws: string) => [ws, "people"] as const,
  members: (ws: string) => [ws, "people", "members"] as const,
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
    qc.invalidateQueries({ queryKey: [ws, "shell-badge", "people"] }),
    qc.invalidateQueries({ queryKey: [ws, "members"] }),
  ]);
}

export function useMembersQuery() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: peopleKeys.members(id), queryFn: () => listMembers(id) });
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

export function useAccessRequestsQuery({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: peopleKeys.requests(id), queryFn: () => listAccessRequests(id), enabled });
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

function toPerson(member: Member, role: string): Person {
  return {
    id: resourceId(member.name),
    name: member.name ?? "",
    user: member.user,
    displayName: member.displayName || member.email || "Someone",
    email: member.email ?? "",
    state: member.state,
    role,
    groups: member.groups ?? [],
    member,
  };
}

export interface Directory {
  people: Person[];
  roles: WorkspaceRole[];
  groups: Group[];
  roleByName: Map<string, WorkspaceRole>;
  groupByName: Map<string, Group>;
  personById: Map<string, Person>;
  /** The caller's `users/{id}`. */
  self: string;
}

/** Members, roles and groups joined into one directory (Gate-compatible). */
export function useDirectory() {
  const session = useSession();
  const members = useMembersQuery();
  const groups = useGroupsQuery();
  const policy = usePolicyQuery();
  const roles = useRolesQuery();
  const data = useMemo((): Directory | undefined => {
    if (!members.data || !groups.data || !roles.data) return undefined;
    if (policy.isPending) return undefined;
    const roleNames = new Set(roles.data.map((r) => r.name));
    const people = members.data.map((m) => {
      const held = policy.data ? directRoles(policy.data, resourceId(m.user), roleNames) : (m.roles ?? []).filter((r) => roleNames.has(r));
      return toPerson(m, primaryRole(held.length ? held : (m.roles ?? [])));
    });
    return {
      people,
      roles: roles.data,
      groups: groups.data,
      roleByName: new Map(roles.data.map((r) => [r.name, r])),
      groupByName: new Map(groups.data.map((g) => [g.name ?? "", g])),
      personById: new Map(people.map((p) => [p.id, p])),
      self: session?.user.name ?? "",
    };
  }, [members.data, groups.data, roles.data, policy.data, policy.isPending, session?.user.name]);
  const failed = members.isError || groups.isError || roles.isError;
  return {
    data,
    isPending: !data && !failed,
    isError: failed,
    error: members.error ?? groups.error ?? roles.error,
    refetch: () => Promise.all([members.refetch(), groups.refetch(), roles.refetch(), policy.refetch()]),
  };
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
  return { qc, ws: id, refresh: () => invalidatePeople(qc, id) };
}

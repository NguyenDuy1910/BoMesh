"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useTokenPages } from "@/lib/paging";
import { useSession } from "@/lib/session";

import {
  batchGetUsers,
  getIngestionPolicy,
  getLastPolicyChange,
  getMembership,
  getTask,
  getUser,
  listAuditPage,
  listComponents,
  listConnectors,
  listIncidents,
  listTasksPage,
  listUsersPage,
  listWorkspaces,
  summarizeIngestion,
  summarizeUsage,
  type AuditQuery,
  type TaskQuery,
  type UsageWindow,
  type User,
  type Workspace,
} from "./api";
import { buildIndexing, DAY, indexingAlerts, lastSegment, unhealthyComponents } from "./model";

/** Platform data is not workspace-scoped: every key starts with "platform". */
export const pk = {
  all: ["platform"] as const,
  workspaces: ["platform", "workspaces"] as const,
  usage: (window: UsageWindow) => ["platform", "usage", window] as const,
  users: ["platform", "users"] as const,
  memberships: ["platform", "memberships"] as const,
  connectors: ["platform", "connectors"] as const,
  indexing: ["platform", "indexing"] as const,
  tasks: ["platform", "indexing", "tasks"] as const,
  policy: ["platform", "ingestion-policy"] as const,
  audit: (days: string) => ["platform", "audit", days] as const,
  components: ["platform", "components"] as const,
  incidents: ["platform", "incidents"] as const,
};

/** The caller may change things (platform admin); operators read only. */
export function useIsPlatformAdmin(): boolean {
  return useSession()?.user.platformRole === "ADMIN";
}

export function useInvalidatePlatform() {
  const client = useQueryClient();
  return (...keys: readonly (readonly unknown[])[]) => Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

export function usePlatformWorkspaces() {
  return useQuery({ queryKey: pk.workspaces, queryFn: listWorkspaces, staleTime: 30_000 });
}

/** Workspace ID → Workspace, for joining names onto rows. */
export function useWorkspaceIndex() {
  const { data } = usePlatformWorkspaces();
  return new Map((data ?? []).map((w) => [lastSegment(w.name), w]));
}

export function useUsage(window: UsageWindow) {
  return useQuery({ queryKey: pk.usage(window), queryFn: () => summarizeUsage(window), staleTime: 60_000 });
}

/** One server page of accounts matching `filter` (see `userFilter`), by name; `total` = matching accounts. */
export function useUserPages(filter: string, pageSize: number) {
  return useTokenPages([...pk.users, "page", filter, pageSize], (pageToken) => listUsersPage(filter, pageSize, pageToken), { staleTime: 30_000 });
}

/** One account by ID. */
export function usePlatformUser(id: string | null) {
  return useQuery({ queryKey: [...pk.users, "get", id], queryFn: () => getUser(id ?? ""), enabled: Boolean(id), staleTime: 30_000 });
}

/** Accounts by resource name, one batch read for the names on screen (actors, targets). */
export function useUsersByName(names: readonly string[]) {
  const wanted = [...new Set(names.filter((n) => n.startsWith("users/")))].sort();
  const query = useQuery({ queryKey: [...pk.users, "batch", wanted], queryFn: () => batchGetUsers(wanted), enabled: wanted.length > 0, staleTime: 60_000 });
  return new Map<string, User>((query.data ?? []).map((u) => [u.name ?? "", u]));
}

export interface ReadableMemberships {
  /** The user's memberships in workspaces whose members the caller can read. */
  rows: { workspace: Workspace; roles: string[]; suspended: boolean }[];
  /** Workspaces whose members the caller can't read (it isn't a member there). */
  hidden: number;
}

/** One user's memberships the API lets the caller see: a one-row `name` read per workspace (workspaces are bounded). */
export function useReadableMemberships(userId: string | null) {
  const client = useQueryClient();
  return useQuery({
    queryKey: [...pk.memberships, userId],
    enabled: Boolean(userId),
    staleTime: 60_000,
    queryFn: async (): Promise<ReadableMemberships> => {
      const workspaces = await client.fetchQuery({ queryKey: pk.workspaces, queryFn: listWorkspaces, staleTime: 30_000 });
      const found = await Promise.all(workspaces.map((w) => getMembership(lastSegment(w.name), userId ?? "")));
      const rows: ReadableMemberships["rows"] = [];
      let hidden = 0;
      found.forEach((m, i) => {
        if (m === "hidden") hidden += 1;
        else if (m) rows.push({ workspace: workspaces[i], roles: m.roles ?? [], suspended: m.state === "SUSPENDED" });
      });
      return { rows, hidden };
    },
  });
}

export function useConnectors() {
  return useQuery({ queryKey: pk.connectors, queryFn: listConnectors, staleTime: 30_000 });
}

/** Live queue plus last-24-hour summaries, per workspace. */
export function useIngestionSummaries() {
  return useQuery({
    queryKey: pk.indexing,
    queryFn: async () => {
      const [now, day] = await Promise.all([summarizeIngestion(), summarizeIngestion(DAY)]);
      return { now, day };
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** One server page of the last 7 days' jobs matching `q`, newest first. */
export function useTaskPages(q: TaskQuery, pageSize: number, enabled = true) {
  return useTokenPages([...pk.tasks, "page", q, pageSize], (pageToken) => listTasksPage(q, pageSize, pageToken), { enabled, staleTime: 30_000 });
}

/** One job by resource name. */
export function useTask(name: string | null) {
  return useQuery({ queryKey: [...pk.tasks, "get", name], queryFn: () => getTask(name ?? ""), enabled: Boolean(name), staleTime: 30_000, retry: false });
}

export function useIngestionPolicy() {
  return useQuery({ queryKey: pk.policy, queryFn: getIngestionPolicy });
}

/** Who last changed the platform ingestion policy, from the audit log (null when unknown or unreadable). */
export function useLastPolicyChange() {
  return useQuery({ queryKey: [...pk.policy, "last-change"], queryFn: () => getLastPolicyChange().catch(() => null), staleTime: 60_000 });
}

/** One server page of the console's audit log (platform events plus workspace lifecycle events), newest first. */
export function useAuditPages(q: AuditQuery, pageSize: number) {
  return useTokenPages([...pk.audit(String(q.windowMs / DAY)), "page", q, pageSize], (pageToken) => listAuditPage(q, pageSize, pageToken), { staleTime: 30_000 });
}

export function useComponents() {
  return useQuery({ queryKey: pk.components, queryFn: listComponents, staleTime: 30_000, refetchInterval: 60_000 });
}

export function useIncidents() {
  return useQuery({ queryKey: pk.incidents, queryFn: () => listIncidents(30 * DAY), staleTime: 60_000 });
}

/**
 * Sidebar attention counts for the platform console (preview `X.pIndexAlerts()`, the Jobs sub-row count and the
 * degraded-services count): `indexing` = degraded + paused workspaces (Indexing row and its By workspace sub-row),
 * `failedJobs` = failed jobs in the last 24 hours (Indexing › Jobs), `health` = components degraded or down.
 */
export function usePlatformNavBadges(): { indexing?: number; failedJobs?: number; health?: number } {
  const workspaces = usePlatformWorkspaces();
  const summaries = useIngestionSummaries();
  const components = useComponents();
  const rows = workspaces.data && summaries.data ? buildIndexing(workspaces.data, summaries.data.now, summaries.data.day) : undefined;
  return {
    indexing: rows ? indexingAlerts(rows) : undefined,
    failedJobs: rows ? rows.reduce((a, r) => a + r.failed, 0) : undefined,
    health: components.data ? unhealthyComponents(components.data).length : undefined,
  };
}

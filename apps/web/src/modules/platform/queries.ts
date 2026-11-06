"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/lib/session";

import {
  getIngestionPolicy,
  getLastPolicyChange,
  listComponents,
  listConnectors,
  listIncidents,
  listPlatformAuditEvents,
  listRecentTasks,
  listUsers,
  listWorkspaceMembers,
  listWorkspaceAuditEvents,
  listWorkspaces,
  summarizeIngestion,
  summarizeUsage,
  type UsageWindow,
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

export function usePlatformUsers() {
  return useQuery({ queryKey: pk.users, queryFn: listUsers, staleTime: 30_000 });
}

export interface ReadableMemberships {
  /** User resource name → their memberships in workspaces whose members the caller can read. */
  byUser: Map<string, { workspace: Workspace; roles: string[]; suspended: boolean }[]>;
  /** Workspaces whose members the caller can't read (it isn't a member there). */
  hidden: number;
}

/** Memberships the API lets the caller see: members of every workspace it belongs to. */
export function useReadableMemberships(enabled: boolean) {
  const client = useQueryClient();
  return useQuery({
    queryKey: pk.memberships,
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<ReadableMemberships> => {
      const workspaces = await client.fetchQuery({ queryKey: pk.workspaces, queryFn: listWorkspaces, staleTime: 30_000 });
      const lists = await Promise.all(workspaces.map((w) => listWorkspaceMembers(lastSegment(w.name))));
      const byUser: ReadableMemberships["byUser"] = new Map();
      let hidden = 0;
      lists.forEach((members, i) => {
        if (!members) {
          hidden += 1;
          return;
        }
        for (const m of members) {
          if (!m.user) continue;
          const rows = byUser.get(m.user) ?? [];
          rows.push({ workspace: workspaces[i], roles: m.roles ?? [], suspended: m.state === "SUSPENDED" });
          byUser.set(m.user, rows);
        }
      });
      return { byUser, hidden };
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

export function useRecentTasks() {
  return useQuery({ queryKey: pk.tasks, queryFn: () => listRecentTasks(), staleTime: 30_000, refetchInterval: 60_000 });
}

export function useIngestionPolicy() {
  return useQuery({ queryKey: pk.policy, queryFn: getIngestionPolicy });
}

/** Who last changed the platform ingestion policy, from the audit log (null when unknown or unreadable). */
export function useLastPolicyChange() {
  return useQuery({ queryKey: [...pk.policy, "last-change"], queryFn: () => getLastPolicyChange().catch(() => null), staleTime: 60_000 });
}

/** Platform events plus workspace events (metadata only) in the window, newest first. */
export function useAuditEvents(days: string) {
  return useQuery({
    queryKey: pk.audit(days),
    queryFn: async () => {
      const windowMs = Number(days) * DAY;
      const [platform, workspace] = await Promise.all([listPlatformAuditEvents(windowMs), listWorkspaceAuditEvents(windowMs)]);
      return { platform, workspace };
    },
    staleTime: 30_000,
  });
}

export function useComponents() {
  return useQuery({ queryKey: pk.components, queryFn: listComponents, staleTime: 30_000, refetchInterval: 60_000 });
}

export function useIncidents() {
  return useQuery({ queryKey: pk.incidents, queryFn: () => listIncidents(30 * DAY), staleTime: 60_000 });
}

/**
 * Sidebar attention counts for the platform console (preview `X.pIndexAlerts()` and the
 * degraded-services count): `indexing` = degraded + paused workspaces, `health` = components degraded or down.
 */
export function usePlatformNavBadges(): { indexing?: number; health?: number } {
  const workspaces = usePlatformWorkspaces();
  const summaries = useIngestionSummaries();
  const components = useComponents();
  const indexing =
    workspaces.data && summaries.data
      ? indexingAlerts(buildIndexing(workspaces.data, summaries.data.now, summaries.data.day, []))
      : undefined;
  return { indexing, health: components.data ? unhealthyComponents(components.data).length : undefined };
}

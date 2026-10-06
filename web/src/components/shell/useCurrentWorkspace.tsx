"use client";

import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { rememberWorkspaceAccent } from "@/lib/appearance";
import { apiRevision, subscribeApiData } from "@/lib/api/revision";
import {
  hasAnySessionPermission,
  hasPlatformPermission,
  hasSessionPermission,
  type AuthSession,
} from "@/lib/auth/session";
import { serviceStatusKey } from "@/lib/status";
import { useAuthSession } from "@/lib/hooks/useAuthSession";
import { sourcesNeedingAttention } from "@/modules/ingestion/connection-state";
import { connectionsApi, sourcesApi } from "@/modules/ingestion/integrations-api";
import {
  approvalRequestsApi,
  REVIEW_PERMISSION,
  workspaceDirectoryApi,
  type Member,
} from "@/modules/manage/access/directory";
import { getWorkspaceBranding } from "@/modules/manage/settings/api";
import { apiRequest } from "@/lib/api/request";
import { isPendingFeatureEnabled } from "@/lib/api/pending";

export interface CurrentWorkspaceSummary {
  id: string;
  name: string;
  code: string;
}

export interface CurrentViewer {
  id: string;
  email: string | null;
  /** Display name, falling back to the email. */
  name: string;
  /** The caller's role names when the API lets them read their own membership; otherwise "Member". */
  roleLabel: string;
}

export interface WorkspaceAttention {
  /** Sources whose last sync failed or whose account needs reconnecting. */
  sources: number;
  /** Pending approval requests the caller may decide. */
  requests: number;
  /** Platform services that are not operational (platform health readers only). */
  outages: number;
}

export interface CurrentWorkspaceValue {
  workspace: CurrentWorkspaceSummary | null;
  viewer: CurrentViewer | null;
  session: AuthSession | null;
  attention: WorkspaceAttention;
  refreshAttention: () => void;
}

const NO_ATTENTION: WorkspaceAttention = { sources: 0, requests: 0, outages: 0 };

const CurrentWorkspaceContext = createContext<CurrentWorkspaceValue | null>(null);

/** A read that may be refused or unreachable counts as nothing needing attention. */
async function quietly<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch {
    return fallback;
  }
}

/** Sources a person must act on — the same rule the Sources page's callout uses. */
async function countSourcesNeedingAttention(): Promise<number> {
  const [sources, connections] = await Promise.all([
    sourcesApi.list(),
    quietly(() => connectionsApi.list(), { items: [], total: 0 }),
  ]);
  return sourcesNeedingAttention(sources.items, connections.items).length;
}

/** Pending requests someone else made that this caller's permissions let them decide. */
async function countReviewableRequests(session: AuthSession): Promise<number> {
  const page = await approvalRequestsApi.list({ status: "pending" });
  return page.items.filter(
    (request) => request.requester.id !== session.user_id
      && hasSessionPermission(session, REVIEW_PERMISSION[request.request_type]),
  ).length;
}

/** Platform services that are not operational, from `GET /platform/health`. */
async function countOutages(): Promise<number> {
  const health = await workspaceDirectoryApi.platform.health();
  return health.services.filter((service) => serviceStatusKey(service.status) !== "operational").length;
}

/** `GET /users/{id}` needs `user.manage`; everyone else is simply a member here. */
async function readRoleLabel(session: AuthSession): Promise<string> {
  const user = await apiRequest<Member>(`/users/${session.user_id}`);
  const names = user.roles.map((role) => role.display_name).filter(Boolean);
  return names.length ? names.join(", ") : "Member";
}

/**
 * The workspace the whole shell renders around, loaded once: identity from the
 * session, and attention counts from real data. Counts re-read whenever any
 * screen calls `invalidateApiData()` (a source reconnected, a request
 * decided), and every failed read quietly counts as zero.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const session = useAuthSession();
  const revision = useSyncExternalStore(subscribeApiData, apiRevision, () => 0);
  const [attention, setAttention] = useState<WorkspaceAttention>(NO_ATTENTION);
  const [roleLabel, setRoleLabel] = useState("Member");
  const [refreshes, setRefreshes] = useState(0);
  const refreshAttention = useCallback(() => setRefreshes((value) => value + 1), []);

  const workspaceId = session?.active_workspace_id ?? null;
  const userId = session?.user_id ?? null;

  useEffect(() => {
    if (!session) {
      setAttention(NO_ATTENTION);
      return;
    }
    let cancelled = false;
    const canSeeSources = hasAnySessionPermission(session, ["source.manage", "ingestion.read"]);
    const canReview = hasAnySessionPermission(session, Object.values(REVIEW_PERMISSION));
    const canReadHealth = hasPlatformPermission(session, "platform.health.read");
    void Promise.all([
      canSeeSources ? quietly(countSourcesNeedingAttention, 0) : 0,
      canReview ? quietly(() => countReviewableRequests(session), 0) : 0,
      canReadHealth ? quietly(countOutages, 0) : 0,
    ]).then(([sources, requests, outages]) => {
      if (!cancelled) setAttention({ sources, requests, outages });
    });
    return () => {
      cancelled = true;
    };
    // `session` changes identity on every revision; the ids, revision and
    // explicit refreshes are what decide a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, userId, revision, refreshes]);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    if (hasSessionPermission(session, "user.manage")) {
      void quietly(() => readRoleLabel(session), "Member").then((label) => {
        if (!cancelled) setRoleLabel(label);
      });
    } else {
      setRoleLabel("Member");
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, userId]);

  // The account preference "Workspace brand" follows the workspace accent. The
  // boot script in lib/appearance applies it; this only keeps its cache fresh.
  useEffect(() => {
    if (!workspaceId || !isPendingFeatureEnabled("workspace.branding")) return;
    let cancelled = false;
    void quietly(() => getWorkspaceBranding(workspaceId), null).then((branding) => {
      if (!cancelled && branding) rememberWorkspaceAccent(workspaceId, branding.accent);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, revision]);

  const value = useMemo<CurrentWorkspaceValue>(() => {
    const membership = session?.workspaces.find((item) => item.id === session.active_workspace_id) ?? null;
    return {
      workspace: membership ? { id: membership.id, name: membership.name, code: membership.code } : null,
      viewer: session
        ? {
            id: session.user_id,
            email: session.email,
            name: session.display_name?.trim() || session.email || "Signed in",
            roleLabel,
          }
        : null,
      session,
      attention,
      refreshAttention,
    };
  }, [attention, refreshAttention, roleLabel, session]);

  return <CurrentWorkspaceContext value={value}>{children}</CurrentWorkspaceContext>;
}

/** The active workspace, the signed-in viewer and the shell's attention counts. */
export function useCurrentWorkspace(): CurrentWorkspaceValue {
  const value = use(CurrentWorkspaceContext);
  if (!value) throw new Error("useCurrentWorkspace must be used inside the product shell.");
  return value;
}

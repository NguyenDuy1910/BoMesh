"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import { api, call, listAll, resourceId, type Schema } from "@/lib/api/client";
import { getSession, useSession } from "@/lib/session";

/**
 * The active workspace (auth_contract.md "Workspace selection").
 *
 * Sessions carry no workspace: the client picks one from ListWorkspaces
 * (last used on this device, else `users/me/preferences.lastWorkspace`, else
 * the only membership) and names it in every request. Navigation is
 * presentation over TestWorkspaceIamPermissions; the API still authorizes
 * every request.
 */

/** Workspace permissions the shell and pages test once per workspace. */
export const WORKSPACE_PERMISSIONS = [
  "workspaces.getOverview",
  "workspaces.update",
  "workspaces.updateSettings",
  "workspaces.updateAssistant",
  "workspaces.archive",
  "workspaces.setIamPolicy",
  "contributions.review",
  "items.create",
  "items.update",
  "items.publish",
  "items.verify",
  "items.delete",
  "topics.create",
  "topics.update",
  "sources.list",
  "sources.create",
  "connections.list",
  "connections.create",
  "members.create",
  "members.delete",
  "roles.create",
  "groups.create",
  "auditEvents.list",
  "auditEvents.export",
  "knowledgeGaps.list",
  "spaces.create",
  "requests.list",
  "artifacts.create",
  "readingLists.create",
  "readingLists.publish",
  "contributions.create",
] as const;

export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number];
export type WorkspaceModule = "spaces" | "work" | "requests";

export interface WorkspaceContextValue {
  /** The Workspace resource. */
  workspace: Schema<"Workspace">;
  /** Bare ID for path parameters: `{ workspace: id }`. */
  id: string;
  /** Resource name `workspaces/{id}`. */
  name: string;
  /** The caller's membership (`members/me`), with `personalCollection`. */
  member: Schema<"Member">;
  /** Bare member ID for `members/{member}` paths. */
  memberId: string;
  settings: Schema<"WorkspaceSettings"> | null;
  workspaces: Schema<"Workspace">[];
  can: (permission: WorkspacePermission) => boolean;
  hasModule: (module: WorkspaceModule) => boolean;
  /** Opens another workspace: discards workspace-scoped routes and caches. */
  switchTo: (workspaceId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const activeKey = (user: string) => `bomesh.workspace.${resourceId(user)}`;

/** The workspace this device last opened for the signed-in user. */
export function rememberedWorkspace(): string | null {
  const session = getSession();
  return session ? window.localStorage.getItem(activeKey(session.user.name)) : null;
}

/** Records the choice locally and in `users/me/preferences.lastWorkspace`. */
export async function rememberWorkspace(workspaceId: string): Promise<void> {
  const session = getSession();
  if (!session) return;
  window.localStorage.setItem(activeKey(session.user.name), workspaceId);
  await call(
    api.PATCH("/api/v1/users/{user}/preferences", {
      params: { path: { user: "me" }, query: { updateMask: "lastWorkspace" } },
      body: { lastWorkspace: `workspaces/${workspaceId}` },
    }),
  ).catch(() => undefined);
}

export async function listMyWorkspaces(): Promise<Schema<"Workspace">[]> {
  return listAll(
    (pageToken) => call(api.GET("/api/v1/workspaces", { params: { query: { pageSize: 100, pageToken } } })),
    (page) => page.workspaces,
  );
}

/**
 * Resolves which workspace to open: remembered on this device, else the
 * server-side `lastWorkspace`, else the only one. `null` means "show the chooser".
 */
export async function resolveWorkspace(workspaces: Schema<"Workspace">[]): Promise<string | null> {
  const ids = new Set(workspaces.map((w) => resourceId(w.name)));
  const local = rememberedWorkspace();
  if (local && ids.has(local)) return local;
  const preferences = await call(
    api.GET("/api/v1/users/{user}/preferences", { params: { path: { user: "me" } } }),
  ).catch(() => null);
  const last = resourceId(preferences?.lastWorkspace);
  if (last && ids.has(last)) return last;
  return workspaces.length === 1 ? resourceId(workspaces[0].name) : null;
}

interface Loaded {
  workspaces: Schema<"Workspace">[];
  workspace: Schema<"Workspace">;
  member: Schema<"Member">;
  settings: Schema<"WorkspaceSettings"> | null;
  permissions: string[];
}

async function loadWorkspace(): Promise<Loaded | null> {
  const workspaces = await listMyWorkspaces();
  const chosen = await resolveWorkspace(workspaces);
  const workspace = workspaces.find((w) => resourceId(w.name) === chosen);
  if (!workspace || !chosen) return null;
  const path = { workspace: chosen };
  const [member, settings, permissions] = await Promise.all([
    call(api.GET("/api/v1/workspaces/{workspace}/members/{member}", { params: { path: { ...path, member: "me" } } })),
    call(api.GET("/api/v1/workspaces/{workspace}/settings", { params: { path } })).catch(() => null),
    call(
      api.POST("/api/v1/workspaces/{workspace}:testIamPermissions", {
        params: { path },
        body: { permissions: [...WORKSPACE_PERMISSIONS] },
      }),
    ),
  ]);
  window.localStorage.setItem(activeKey(getSession()!.user.name), chosen);
  return { workspaces, workspace, member, settings, permissions: permissions.permissions ?? [] };
}

export const workspaceQueryKey = ["workspace-context"] as const;

/** Loads the active workspace; renders `fallback` states through the render props. */
export function WorkspaceProvider({
  children,
  loading,
  chooser,
  failed,
}: {
  children: ReactNode;
  loading: ReactNode;
  /** Rendered when no workspace is chosen yet (several memberships, or none). */
  chooser: ReactNode;
  failed: (error: unknown, retry: () => void) => ReactNode;
}) {
  const session = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: [...workspaceQueryKey, session?.user.name],
    queryFn: loadWorkspace,
    enabled: Boolean(session),
    staleTime: 5 * 60_000,
  });

  const switchTo = useCallback(
    (workspaceId: string) => {
      void rememberWorkspace(workspaceId).then(() => {
        queryClient.clear();
        router.push("/home");
      });
    },
    [queryClient, router],
  );

  const value = useMemo<WorkspaceContextValue | null>(() => {
    const data = query.data;
    if (!data) return null;
    const granted = new Set(data.permissions);
    const modules = data.settings?.modules ?? {};
    return {
      workspace: data.workspace,
      id: resourceId(data.workspace.name),
      name: data.workspace.name!,
      member: data.member,
      memberId: resourceId(data.member.name) || "me",
      settings: data.settings,
      workspaces: data.workspaces,
      can: (permission) => granted.has(permission),
      hasModule: (module) => Boolean(modules[module]),
      switchTo,
    };
  }, [query.data, switchTo]);

  if (query.isPending) return <>{loading}</>;
  if (query.isError) return <>{failed(query.error, () => void query.refetch())}</>;
  if (!value) return <>{chooser}</>;
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** The active workspace. Only valid inside the workspace shell. */
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace() is used outside the workspace shell.");
  return value;
}

/** The active workspace when inside the shell, else null (platform console, auth pages). */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

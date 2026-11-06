"use client";

import { useQuery } from "@tanstack/react-query";

import { api, ApiError, call, resourceId, type Schema } from "@/lib/api/client";
import { clearSession, getSession, storeSession, type StoredSession } from "@/lib/session";
import { listMyWorkspaces, rememberWorkspace, resolveWorkspace } from "@/lib/workspace";

/**
 * Identity calls for the signed-out pages (backend/docs_design/auth_contract.md):
 * CreateSession → GetUser(me) → session stored; then workspace selection.
 */

type Credential = Schema<"SessionCredential">;

async function createSession(credential: Credential): Promise<StoredSession> {
  const session = await call(api.POST("/api/v1/sessions", { body: { credential } }));
  if (!session.accessToken || !session.name) throw new ApiError("Sign-in could not be completed.", 500, "INTERNAL");
  // The token is needed to read users/me; store it first, then complete the session.
  const provisional: StoredSession = {
    name: session.name,
    accessToken: session.accessToken,
    expireTime: session.expireTime,
    user: { name: session.user ?? "", email: "" },
  };
  storeSession(provisional);
  try {
    const user = await call(api.GET("/api/v1/users/{user}", { params: { path: { user: "me" } } }));
    const stored: StoredSession = {
      ...provisional,
      user: {
        name: user.name ?? provisional.user.name,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        platformRole: user.platformRole,
      },
    };
    storeSession(stored);
    return stored;
  } catch (error) {
    clearSession();
    throw error;
  }
}

/** Email when it contains `@`, otherwise username. */
export function signInWithPassword(identifier: string, password: string): Promise<StoredSession> {
  const id = identifier.trim();
  return createSession({ password: id.includes("@") ? { email: id, password } : { username: id, password } });
}

export function signInWithGoogle(idToken: string): Promise<StoredSession> {
  return createSession({ google: { idToken } });
}

export interface NewAccount {
  displayName: string;
  email: string;
  password: string;
}

/** CreateUser does not sign in; CreateSession follows. */
export async function createAccount(account: NewAccount): Promise<StoredSession> {
  const email = account.email.trim();
  await call(
    api.POST("/api/v1/users", {
      body: { email, password: account.password, displayName: account.displayName.trim() },
    }),
  );
  return createSession({ password: { email, password: account.password } });
}

/** `validateOnly` CreateUser: resolves `true` when the email is already in use. */
export async function emailInUse(email: string): Promise<boolean> {
  try {
    await call(
      api.POST("/api/v1/users", {
        params: { query: { validateOnly: true } },
        // validateOnly checks email/username only; the password is a placeholder that passes the strength check.
        body: { email: email.trim(), password: "validate-only-0" },
      }),
    );
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.reason === "EMAIL_ALREADY_USED") return true;
    return false;
  }
}

/** Always answers the same, whether or not an account uses the address. */
export async function sendPasswordReset(email: string): Promise<void> {
  await call(api.POST("/api/v1/users:sendPasswordReset", { body: { email: email.trim() } }));
}

export async function resetPassword(resetToken: string, newPassword: string): Promise<void> {
  await call(api.POST("/api/v1/users:resetPassword", { body: { resetToken, newPassword } }));
}

/** DeleteSession, then forget the token locally even when the server can't be reached. */
export async function signOut(): Promise<void> {
  const session = getSession();
  try {
    if (session) {
      await call(api.DELETE("/api/v1/sessions/{session}", { params: { path: { session: resourceId(session.name) } } }));
    }
  } catch {
    // Already ended or offline: local sign-out still happens.
  } finally {
    clearSession();
  }
}

/* ── Workspace memory (when each workspace was last opened on this device) ── */

const openedKey = (user: string) => `bomesh.workspaceOpened.${resourceId(user)}`;

export function workspacesOpened(): Record<string, number> {
  const session = getSession();
  if (!session) return {};
  try {
    return (JSON.parse(window.localStorage.getItem(openedKey(session.user.name)) ?? "{}") as Record<string, number>) ?? {};
  } catch {
    return {};
  }
}

export function markWorkspaceOpened(workspaceId: string): void {
  const session = getSession();
  if (!session) return;
  const opened = { ...workspacesOpened(), [workspaceId]: Date.now() };
  window.localStorage.setItem(openedKey(session.user.name), JSON.stringify(opened));
}

/** Records the choice (device + preferences) and returns the route to open. */
export async function openWorkspace(workspaceId: string, next?: string | null): Promise<string> {
  markWorkspaceOpened(workspaceId);
  await rememberWorkspace(workspaceId);
  return safeNext(next) ?? "/home";
}

/** Only same-origin absolute paths are followed after sign-in. */
export function safeNext(next?: string | null): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  return next;
}

/** After sign-in: the resolved workspace opens directly, otherwise the chooser. */
export async function routeAfterSignIn(next?: string | null): Promise<string> {
  const workspaces = await listMyWorkspaces();
  const chosen = await resolveWorkspace(workspaces);
  if (chosen) return openWorkspace(chosen, next);
  const target = safeNext(next);
  return target ? `/workspaces?next=${encodeURIComponent(target)}` : "/workspaces";
}

/** "Workspace admin" for `roles/workspaceAdmin`; custom roles by their ID. */
export function roleLabel(roles: string[] | undefined): string {
  if (roles?.includes("roles/workspaceAdmin")) return "Workspace admin";
  const custom = roles?.find((r) => r !== "roles/workspaceMember");
  if (custom) {
    const id = resourceId(custom) ?? custom;
    const words = id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return "Member";
}

/** Custom workspace roles are named by their `displayName` (GetRole); built-in roles by `roleLabel`. */
export async function roleDisplayName(workspaceId: string, roles: string[] | undefined): Promise<string> {
  const custom = roles?.find((r) => r !== "roles/workspaceMember" && r !== "roles/workspaceAdmin");
  if (!custom || roles?.includes("roles/workspaceAdmin")) return roleLabel(roles);
  const role = await call(
    api.GET("/api/v1/workspaces/{workspace}/roles/{role}", { params: { path: { workspace: workspaceId, role: resourceId(custom) } } }),
  ).catch(() => null);
  return role?.displayName || roleLabel(roles);
}

/** `roleDisplayName` for the shell: the built-in label at once, the custom role's name once loaded. */
export function useRoleDisplayName(workspaceId: string | null | undefined, roles: string[] | undefined): string {
  const { data } = useQuery({
    queryKey: [workspaceId, "role-name", roles?.join(",")],
    enabled: Boolean(workspaceId && roles),
    staleTime: 5 * 60_000,
    queryFn: () => roleDisplayName(workspaceId!, roles),
  });
  return data ?? roleLabel(roles);
}

export const TEMPLATE_LABEL: Record<NonNullable<Schema<"Workspace">["template"]>, string> = {
  ENTERPRISE: "Enterprise",
  CAMPUS: "Campus",
};

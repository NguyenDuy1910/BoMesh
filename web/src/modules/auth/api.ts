import { getApiUrl } from "@/lib/api/config";
import { getAuthSession, storeAuthSession, type AuthSession } from "@/lib/auth/session";

export async function completeGoogleSignIn(credential: string): Promise<AuthSession> {
  return requestSession(
    { method: "google", credential },
    undefined,
    "Google sign-in could not be completed.",
  );
}

export async function completePasswordSignIn(identifier: string, password: string): Promise<AuthSession> {
  const normalizedIdentifier = identifier.trim();
  return requestSession(
    normalizedIdentifier.includes("@")
      ? { method: "password", email: normalizedIdentifier, password }
      : { method: "password", username: normalizedIdentifier, password },
    undefined,
    "Sign-in details are incorrect.",
  );
}

export async function createPasswordAccount(input: {
  username?: string;
  email: string;
  password: string;
  display_name?: string;
}): Promise<AuthSession> {
  const body: Record<string, string> = {
    ...input,
    ...(input.username?.trim() ? { username: input.username.trim() } : {}),
  };
  delete body.username;
  if (input.username?.trim()) body.username = input.username.trim();
  return requestSession(
    body,
    undefined,
    "Account could not be created.",
    "POST",
    "/api/v1/auth/accounts",
  );
}

export async function switchWorkspace(workspaceId: string): Promise<AuthSession> {
  const current = getAuthSession();
  if (!current) throw new Error("Your session has expired. Please sign in again.");
  return requestSession(
    { active_workspace_id: workspaceId },
    current.access_token,
    "Your workspace could not be changed.",
    "PATCH",
    "/api/v1/auth/session",
  );
}

async function requestSession(
  body: Record<string, string>,
  accessToken?: string,
  fallbackError = "Sign-in could not be completed.",
  method = "POST",
  path = "/api/v1/auth/sessions",
): Promise<AuthSession> {
  const apiUrl = getApiUrl();
  if (!apiUrl) {
    throw new Error("Sign-in is unavailable because the BoThesis API URL is not configured.");
  }
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as AuthSession | { detail?: unknown } | null;
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
      ? payload.detail
      : fallbackError;
    throw new Error(detail);
  }
  const next = payload as AuthSession;
  storeAuthSession(next);
  return next;
}

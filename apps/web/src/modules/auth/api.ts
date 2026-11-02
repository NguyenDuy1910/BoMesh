import { getApiUrl } from "@/lib/api/config";
import { ApiError, apiRequest } from "@/lib/api/request";
import { clearAuthSession, getAuthSession, storeAuthSession, type AuthSession } from "@/lib/auth/session";
import { pendingApi } from "@/lib/api/pending";
import * as pendingPasswordReset from "@/lib/api/pending/password-reset";

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
  email: string;
  password: string;
  display_name: string;
}): Promise<AuthSession> {
  return requestSession(
    { email: input.email.trim(), password: input.password, display_name: input.display_name.trim() },
    undefined,
    "Account could not be created.",
    "POST",
    "/api/v1/auth/accounts",
  );
}

export async function switchWorkspace(workspaceId: string): Promise<AuthSession> {
  const current = getAuthSession();
  if (!current) throw new ApiError("Your session has expired. Please sign in again.", 401);
  return requestSession(
    { active_workspace_id: workspaceId },
    current.access_token,
    "Your workspace could not be changed.",
    "PATCH",
    "/api/v1/auth/session",
  );
}

/** `GET /auth/session`: the memberships as they are now, not as the token was minted. */
type CurrentSession = Omit<AuthSession, "access_token" | "token_type">;

/**
 * Re-read the current session so memberships granted after sign-in appear
 * without signing in again. The access token is unchanged; only the context
 * the server resolves for it is refreshed.
 */
export async function refreshSession(): Promise<AuthSession> {
  const current = getAuthSession();
  if (!current) throw new ApiError("Your session has expired. Please sign in again.", 401);
  const fresh = await apiRequest<CurrentSession>("/auth/session");
  const next: AuthSession = { ...current, ...fresh };
  storeAuthSession(next);
  return next;
}

/**
 * `DELETE /auth/session`, then forget the credentials locally. The browser is
 * signed out even when the server cannot be reached (auth_contract.md).
 */
export async function signOut(): Promise<void> {
  try {
    if (getAuthSession()) await apiRequest<void>("/auth/session", { method: "DELETE" });
  } catch {
    // Revocation failed (offline or already ended); local sign-out still happens.
  } finally {
    clearAuthSession();
  }
}

export interface PasswordResetRequest {
  email: string;
}

/** The same answer whether or not an account uses the address. */
export interface PasswordResetAccepted {
  status: "accepted";
  expires_in_minutes: number;
}

export interface PasswordResetCompletion {
  password: string;
}

/** Every session of the account ends; the person signs in with the new password. */
export interface PasswordResetCompleted {
  status: "completed";
}

/** API pending: `POST /auth/password-resets` (public). */
export async function requestPasswordReset(body: PasswordResetRequest): Promise<PasswordResetAccepted> {
  return pendingApi("auth.password_reset", () => pendingPasswordReset.requestPasswordReset(body));
}

/** API pending: `POST /auth/password-resets/{token}/complete` (public). */
export async function completePasswordReset(
  token: string,
  body: PasswordResetCompletion,
): Promise<PasswordResetCompleted> {
  return pendingApi("auth.password_reset", () => pendingPasswordReset.completePasswordReset(token, body));
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
    throw new ApiError("Sign-in is unavailable because the BoMesh API URL is not configured.");
  }
  let response: Response;
  try {
    response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("BoMesh couldn't be reached. Check your connection and try again.");
  }
  const payload = await response.json().catch(() => null) as AuthSession | { detail?: unknown } | null;
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "detail" in payload && typeof payload.detail === "string"
      ? payload.detail
      : fallbackError;
    // The status is what screens act on (401 wrong credentials, 403 no
    // workspace, 409 account exists); the detail is operator-facing.
    throw new ApiError(detail, response.status);
  }
  const next = payload as AuthSession;
  storeAuthSession(next);
  return next;
}

/**
 * Local implementation of `auth.password_reset` (proposed
 * `POST /auth/password-resets`, `POST /auth/password-resets/{token}/complete`).
 *
 * No email can be sent from the browser, so the reset link a real server
 * would email is written to the developer console instead. Nothing here
 * changes a real password: completing a reset only marks the local token used.
 */
import { ApiError } from "@/lib/api/request";
import { pendingStore } from "@/lib/api/pending";
import type {
  PasswordResetAccepted,
  PasswordResetCompleted,
  PasswordResetCompletion,
  PasswordResetRequest,
} from "@/modules/auth/api";

const TOKEN_LIFETIME_MINUTES = 30;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface StoredResetToken {
  email: string;
  expires_at: string;
  used_at: string | null;
}

/** Signed-out flow: one browser-wide store, not tied to an account or workspace. */
const tokens = () =>
  pendingStore<Record<string, StoredResetToken>>("auth.password_reset", null, null, () => ({}));

export function requestPasswordReset(body: PasswordResetRequest): PasswordResetAccepted {
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new ApiError("Enter a valid email address.", 422);
  const token = crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + TOKEN_LIFETIME_MINUTES * 60_000).toISOString();
  tokens().update((current) => ({ ...current, [token]: { email, expires_at: expiresAt, used_at: null } }));
  const origin = globalThis.location?.origin ?? "";
  // The stand-in for the email a real server sends. The response never says
  // whether an account exists, so it cannot be used to discover accounts.
  console.info("[pending-api] auth.password_reset link:", `${origin}/auth/password-reset/${token}`);
  return { status: "accepted", expires_in_minutes: TOKEN_LIFETIME_MINUTES };
}

export function completePasswordReset(token: string, body: PasswordResetCompletion): PasswordResetCompleted {
  const store = tokens();
  const stored = store.read()[token];
  if (!stored || stored.used_at || Date.parse(stored.expires_at) <= Date.now()) {
    throw new ApiError("This reset link has expired or was already used. Request a new one.", 404);
  }
  if (body.password.length < PASSWORD_MIN || body.password.length > PASSWORD_MAX) {
    throw new ApiError(`Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters for your password.`, 422);
  }
  store.update((current) => ({ ...current, [token]: { ...stored, used_at: new Date().toISOString() } }));
  return { status: "completed" };
}

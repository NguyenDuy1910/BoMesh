import type { AuthSession } from "@/lib/auth/session";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Accounts accept 8–128 characters (`AccountCreate`); the product also asks for letters and numbers. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/** The inline message for a work email, or undefined when it is fine. */
export function emailError(value: string): string | undefined {
  const email = value.trim();
  if (!email) return "Enter your work email.";
  if (!EMAIL_PATTERN.test(email)) return "Enter an email like name@company.com.";
  return undefined;
}

export interface PasswordRule {
  met: boolean;
  label: string;
}

/** The rules shown live under a new password. */
export function passwordRules(password: string): PasswordRule[] {
  return [
    { met: password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX, label: `At least ${PASSWORD_MIN} characters` },
    { met: /[A-Za-z]/.test(password) && /\d/.test(password), label: "Letters and numbers" },
  ];
}

export function newPasswordError(password: string): string | undefined {
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return passwordRules(password).every((rule) => rule.met)
    ? undefined
    : `Use at least ${PASSWORD_MIN} characters with letters and numbers.`;
}

/** Only same-origin paths; `//host` and `/\host` would leave the app. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (next?.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) return next;
  return null;
}

/**
 * Where a fresh session goes: the page that sent the person to sign in, else
 * straight into chat when there is one workspace, else the picker.
 */
export function destinationAfterSignIn(session: AuthSession, next: string | null | undefined): string {
  return safeNextPath(next) ?? (session.workspaces.length === 1 ? "/chat" : "/workspaces");
}

/** A query parameter of the current URL, read at event time (no Suspense boundary needed). */
export function currentSearchParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

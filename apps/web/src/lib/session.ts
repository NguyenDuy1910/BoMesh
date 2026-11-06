"use client";

import { useSyncExternalStore } from "react";

/**
 * The signed-in browser session (auth_contract.md).
 *
 * CreateSession returns the bearer token once; it is kept in localStorage with
 * the caller's User so the shell can render before any request. Sessions carry
 * no workspace: the active workspace is a client choice (`lib/workspace.tsx`).
 * A 401 for the current token clears the session; a late 401 for a replaced
 * token is ignored. Sessions expire at `expireTime` without refresh, so a timer
 * signs the UI out at that moment instead of waiting for the next request to fail.
 */
export interface StoredSession {
  /** `sessions/{session}`. */
  name: string;
  accessToken: string;
  expireTime?: string;
  user: {
    /** `users/{user}`. */
    name: string;
    email: string;
    username?: string;
    displayName?: string;
    platformRole?: "NONE" | "OPERATOR" | "ADMIN";
  };
}

const storageKey = "bomesh.session";
const listeners = new Set<() => void>();
let cached: StoredSession | null | undefined;
let expiryTimer: number | undefined;

/** Clears the session when its `expireTime` passes (setTimeout caps at ~24.8 days). */
function armExpiry(session: StoredSession | null) {
  window.clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (!session?.expireTime) return;
  const delay = Math.min(Date.parse(session.expireTime) - Date.now(), 2 ** 31 - 1);
  if (delay > 0) expiryTimer = window.setTimeout(clearSession, delay);
}

function read(): StoredSession | null {
  if (cached === undefined) {
    if (typeof window === "undefined") return null;
    try {
      const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as StoredSession | null;
      cached = value?.accessToken && value.user?.name ? value : null;
    } catch {
      cached = null;
    }
    armExpiry(cached);
  }
  // A sleeping laptop can miss the timer; never hand out an expired token.
  return cached?.expireTime && Date.parse(cached.expireTime) <= Date.now() ? null : cached;
}

function emit() {
  for (const listener of listeners) listener();
}

export function getSession(): StoredSession | null {
  return read();
}

export function sessionToken(): string | undefined {
  return read()?.accessToken;
}

export function storeSession(session: StoredSession): void {
  cached = session;
  window.localStorage.setItem(storageKey, JSON.stringify(session));
  armExpiry(session);
  emit();
}

/** Updates the cached User after UpdateUser (display name). */
export function updateSessionUser(patch: Partial<StoredSession["user"]>): void {
  const current = read();
  if (current) storeSession({ ...current, user: { ...current.user, ...patch } });
}

export function clearSession(): void {
  cached = null;
  armExpiry(null);
  window.localStorage.removeItem(storageKey);
  emit();
}

/** Called by the API boundary on 401; only the token that failed is cleared. */
export function handleUnauthenticated(authorization: string | null): void {
  const current = read();
  if (current && authorization === `Bearer ${current.accessToken}`) clearSession();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey) return;
    cached = undefined;
    armExpiry(null);
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current session; `null` when signed out (and during server render). */
export function useSession(): StoredSession | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** Platform scope is separate from workspace roles (auth_contract.md). */
export function isPlatformOperator(session: StoredSession | null): boolean {
  return session?.user.platformRole === "OPERATOR" || session?.user.platformRole === "ADMIN";
}

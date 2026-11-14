"use client";

import { useSyncExternalStore } from "react";

/**
 * The signed-in browser session (auth_contract.md "Client session boundary").
 *
 * CreateSession returns the bearer token once; it is kept in localStorage with
 * the caller's User so the shell can render before any request. Sessions carry
 * no workspace: the active workspace is a client choice (`lib/workspace.tsx`).
 *
 * Sessions end at `expireTime` and cannot be renewed. When the current session
 * ends — a timer at `expireTime`, or a 401 for its token — it is kept, marked
 * `expired`: the page stays mounted with its data, no request carries the dead
 * token, and the shell asks the person to sign in again in place
 * (`SessionExpiredDialog`). A late 401 for a replaced token is ignored. Sign-out
 * clears the session. Other tabs follow every change through the `storage` event.
 */
export interface StoredSession {
  /** `sessions/{session}`. */
  name: string;
  accessToken: string;
  /** On this device's clock (`clientExpireTime`). */
  expireTime?: string;
  /** Set once the token stopped working: `expireTime` passed, or the API answered 401 for it. */
  expired?: boolean;
  user: {
    /** `users/{user}`. */
    name: string;
    email: string;
    username?: string;
    displayName?: string;
    platformRole?: "NONE" | "OPERATOR" | "ADMIN";
  };
}

/**
 * How the stored session changed (`watchSession`):
 * - `expired`: the current session ended; keep the page and its data, stop requests.
 * - `renewed`: the same user signed in again; refetch what is on screen.
 * - `switched`: a different user signed in; nothing of the previous user may stay.
 * - `ended`: signed out.
 */
export type SessionTransition = "none" | "expired" | "renewed" | "switched" | "ended";

export function sessionTransition(prev: StoredSession | null, next: StoredSession | null): SessionTransition {
  if (!next) return prev ? "ended" : "none";
  if (!prev) return "none";
  if (prev.name === next.name) return !prev.expired && next.expired ? "expired" : "none";
  return prev.user.name === next.user.name ? "renewed" : "switched";
}

function pastExpiry(session: StoredSession, now: number): boolean {
  return Boolean(session.expireTime) && Date.parse(session.expireTime!) <= now;
}

/** A stored session as read from storage; one past its `expireTime` is expired. */
export function parseSession(raw: string | null, now: number): StoredSession | null {
  try {
    const value = JSON.parse(raw ?? "null") as StoredSession | null;
    if (!value?.accessToken || !value.user?.name) return null;
    return !value.expired && pastExpiry(value, now) ? { ...value, expired: true } : value;
  } catch {
    return null;
  }
}

/**
 * `expireTime` on this device's clock: the session's lifetime (`expireTime - createTime`)
 * counted from `now`, so a skewed device clock cannot end a fresh session at once.
 */
export function clientExpireTime(session: { expireTime?: string; createTime?: string }, now: number): string | undefined {
  const expire = Date.parse(session.expireTime ?? "");
  const create = Date.parse(session.createTime ?? "");
  if (Number.isNaN(expire)) return undefined;
  if (Number.isNaN(create)) return session.expireTime;
  return new Date(now + expire - create).toISOString();
}

const storageKey = "bomesh.session";
type Watcher = (prev: StoredSession | null, next: StoredSession | null) => void;
const listeners = new Set<() => void>();
const watchers = new Set<Watcher>();
let cached: StoredSession | null | undefined;
let expiryTimer: number | undefined;
let followingTabs = false;

function read(): StoredSession | null {
  if (cached === undefined) {
    if (typeof window === "undefined") return null;
    cached = parseSession(window.localStorage.getItem(storageKey), Date.now());
    armExpiry(cached);
  }
  return cached;
}

/** Expires the session when its `expireTime` passes (setTimeout caps at ~24.8 days, so long waits re-arm). */
function armExpiry(session: StoredSession | null) {
  window.clearTimeout(expiryTimer);
  expiryTimer = undefined;
  if (!session?.expireTime || session.expired) return;
  const delay = Math.min(Math.max(Date.parse(session.expireTime) - Date.now(), 0), 2 ** 31 - 1);
  expiryTimer = window.setTimeout(() => {
    if (read() !== session) return;
    if (pastExpiry(session, Date.now())) expire(session);
    else armExpiry(session);
  }, delay);
}

/** Every change goes through here: own writes (`persist`) and other tabs' writes (`storage` event). */
function commit(next: StoredSession | null, persist: boolean) {
  const prev = read();
  cached = next;
  if (persist) {
    if (next) window.localStorage.setItem(storageKey, JSON.stringify(next));
    else window.localStorage.removeItem(storageKey);
  }
  armExpiry(next);
  // Watchers (caches) run before React re-renders, so no component renders the next state with the previous user's data.
  for (const watcher of watchers) watcher(prev, next);
  for (const listener of listeners) listener();
}

function expire(session: StoredSession) {
  commit({ ...session, expired: true }, true);
}

function followOtherTabs() {
  if (followingTabs) return;
  followingTabs = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    // `key` is null when another tab cleared all storage.
    if (event.key !== null && event.key !== storageKey) return;
    commit(parseSession(window.localStorage.getItem(storageKey), Date.now()), false);
  });
}

/** The signed-in session, or null when signed out or expired. */
export function getSession(): StoredSession | null {
  const current = read();
  return current && !current.expired && !pastExpiry(current, Date.now()) ? current : null;
}

/** The session that expired and awaits re-authentication, or null. */
export function getExpiredSession(): StoredSession | null {
  const current = read();
  return current && (current.expired || pastExpiry(current, Date.now())) ? current : null;
}

/** The bearer token to send; never one that has expired. */
export function sessionToken(): string | undefined {
  const current = read();
  if (!current || current.expired) return undefined;
  // A sleeping device can miss the timer.
  if (pastExpiry(current, Date.now())) {
    expire(current);
    return undefined;
  }
  return current.accessToken;
}

export function storeSession(session: StoredSession): void {
  commit(session, true);
}

/** Updates the cached User after UpdateUser (display name). */
export function updateSessionUser(patch: Partial<StoredSession["user"]>): void {
  const current = read();
  if (current) storeSession({ ...current, user: { ...current.user, ...patch } });
}

/** Sign-out: forget the session (every tab leaves). */
export function clearSession(): void {
  commit(null, true);
}

/** Called by the API boundary on 401: only the current token expires the session; a replaced one is ignored. */
export function handleUnauthenticated(authorization: string | null): void {
  const current = read();
  if (current && !current.expired && authorization === `Bearer ${current.accessToken}`) expire(current);
}

/** Runs `watcher(prev, next)` synchronously on every change, before components re-render. */
export function watchSession(watcher: Watcher): () => void {
  followOtherTabs();
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

function subscribe(listener: () => void) {
  followOtherTabs();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The session the UI is rendered for — kept while expired so the page stays; `null` when signed out (and during server render). */
export function useSession(): StoredSession | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/** `true` while the current session has expired and awaits re-authentication. */
export function useSessionExpired(): boolean {
  return useSyncExternalStore(subscribe, () => read()?.expired === true, () => false);
}

/** Platform scope is separate from workspace roles (auth_contract.md). */
export function isPlatformOperator(session: StoredSession | null): boolean {
  return session?.user.platformRole === "OPERATOR" || session?.user.platformRole === "ADMIN";
}

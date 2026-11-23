import { shareToken } from "../shares/model.ts";

/** Base for resolving `?next=`; never requested. */
const ORIGIN = "https://bomesh.invalid";

/**
 * Where sign-in may return to (`?next=`): a path on this site, never Sign in itself.
 * Resolving it the way the browser will catches what a prefix check misses
 * (`//evil.example`, `/\evil.example`, `/<tab>/evil.example`), so `next` cannot
 * become an open redirect or a sign-in loop.
 */
export function safeNext(next?: string | null): string | null {
  if (!next?.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(next, ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== ORIGIN || url.pathname === "/signin") return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Sign in, then back to `next`; `reason: "expired"` makes the page explain why. */
export function signInHref(next: string, reason?: "expired"): string {
  const params = new URLSearchParams({ next });
  if (reason) params.set("reason", reason);
  return `/signin?${params}`;
}

/** The code of a join link `/w/{code}` (the last segment), or null. */
export function joinCode(pathname: string): string | null {
  const m = /^\/w\/([^/?#]+)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Is `next` a link someone was sent: a share landing (`/s/{token}`) or a public workspace's join link (`/w/{code}`)?
 * Signing in or up returns there directly, whatever the workspace.
 */
export function isLinkNext(next: string | null | undefined): next is string {
  if (!next) return false;
  const path = next.split(/[?#]/)[0];
  return shareToken(path) !== null || joinCode(path) !== null;
}

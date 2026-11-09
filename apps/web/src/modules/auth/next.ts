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

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import "./support/register-aliases.mjs";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const storage = new MemoryStorage();
const storageListeners: Array<(event: { key: string | null }) => void> = [];
mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-09T10:00:00Z") });
Object.assign(globalThis, {
  window: {
    localStorage: storage,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
      if (type === "storage") storageListeners.push(listener);
    },
    removeEventListener: () => undefined,
  },
});

process.env.NEXT_PUBLIC_BOMESH_API_URL = "http://api.test";
const session = await import("../src/lib/session.ts");
const { api, ApiError, call, rawFetch } = await import("../src/lib/api/client.ts");
const { safeNext, signInHref } = await import("../src/modules/auth/next.ts");
type StoredSession = import("../src/lib/session.ts").StoredSession;
type SessionTransition = import("../src/lib/session.ts").SessionTransition;

const KEY = "bomesh.session";
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const make = (id: string, user: string, expireTime = inSeconds(900)): StoredSession => ({
  name: `sessions/${id}`,
  accessToken: `token-${id}`,
  expireTime,
  user: { name: `users/${user}`, email: `${user}@example.com` },
});

/** Records every transition while `run` executes. */
function transitions(run: () => void): SessionTransition[] {
  const seen: SessionTransition[] = [];
  const stop = session.watchSession((prev, next) => seen.push(session.sessionTransition(prev, next)));
  try {
    run();
  } finally {
    stop();
  }
  return seen;
}

test("sessionTransition: expiry, same-user renewal, account switch, sign-out", () => {
  const a1 = make("a1", "ana");
  const a2 = make("a2", "ana");
  const b1 = make("b1", "bao");
  const expired = { ...a1, expired: true };
  assert.equal(session.sessionTransition(null, a1), "none");
  assert.equal(session.sessionTransition(a1, { ...a1, user: { ...a1.user, displayName: "Ana" } }), "none");
  assert.equal(session.sessionTransition(a1, expired), "expired");
  assert.equal(session.sessionTransition(expired, expired), "none");
  assert.equal(session.sessionTransition(expired, a2), "renewed");
  assert.equal(session.sessionTransition(expired, b1), "switched");
  assert.equal(session.sessionTransition(a1, b1), "switched");
  assert.equal(session.sessionTransition(expired, null), "ended");
  assert.equal(session.sessionTransition(null, null), "none");
});

test("parseSession marks a session past expireTime expired and rejects incomplete records", () => {
  const live = make("p1", "ana");
  assert.deepEqual(session.parseSession(JSON.stringify(live), Date.now()), live);
  assert.equal(session.parseSession(JSON.stringify(make("p2", "ana", inSeconds(-1))), Date.now())?.expired, true);
  assert.equal(session.parseSession(JSON.stringify({ name: "sessions/x", user: { name: "users/x" } }), Date.now()), null);
  assert.equal(session.parseSession("{not json", Date.now()), null);
  assert.equal(session.parseSession(null, Date.now()), null);
});

test("clientExpireTime counts the server lifetime from now, whatever the device clock says", () => {
  const now = Date.parse("2026-11-09T10:00:00Z");
  // The server clock is an hour ahead: a 900 s session must still last 900 s here.
  const server = { createTime: "2026-11-09T11:00:00Z", expireTime: "2026-11-09T11:15:00Z" };
  assert.equal(session.clientExpireTime(server, now), "2026-11-09T10:15:00.000Z");
  assert.equal(session.clientExpireTime({ expireTime: "2026-11-09T11:15:00Z" }, now), "2026-11-09T11:15:00Z");
  assert.equal(session.clientExpireTime({}, now), undefined);
});

test("the expiry timer expires the session but keeps it for the page", () => {
  const a = make("t1", "ana", inSeconds(900));
  session.storeSession(a);
  assert.equal(session.sessionToken(), a.accessToken);
  const seen = transitions(() => mock.timers.tick(900_000));
  assert.deepEqual(seen, ["expired"]);
  assert.equal(session.sessionToken(), undefined);
  assert.equal(session.getSession(), null);
  assert.equal(session.getExpiredSession()?.name, a.name);
  assert.equal(JSON.parse(storage.getItem(KEY)!).expired, true, "other tabs learn it from storage");
  session.clearSession();
});

test("a sleeping device that missed the timer never hands out the dead token", () => {
  const a = make("t2", "ana", inSeconds(60));
  session.storeSession(a);
  // Wall clock jumps past expireTime without the timer having run yet.
  mock.timers.setTime(Date.now() + 61_000);
  const seen = transitions(() => assert.equal(session.sessionToken(), undefined));
  assert.deepEqual(seen, ["expired"]);
  session.clearSession();
});

test("a 401 expires only the current token; stale tokens and repeats are ignored", () => {
  const a = make("u1", "ana");
  const replaced = make("u0", "ana");
  session.storeSession(a);
  assert.deepEqual(
    transitions(() => session.handleUnauthenticated(`Bearer ${replaced.accessToken}`)),
    [],
    "a late 401 for a replaced token cannot end the newer session",
  );
  assert.deepEqual(transitions(() => session.handleUnauthenticated(null)), []);
  assert.equal(session.getSession()?.name, a.name);
  assert.deepEqual(transitions(() => session.handleUnauthenticated(`Bearer ${a.accessToken}`)), ["expired"]);
  assert.deepEqual(transitions(() => session.handleUnauthenticated(`Bearer ${a.accessToken}`)), [], "no 401 storm");
  session.clearSession();
});

test("signing in again: same user renews, another user switches, sign-out ends", () => {
  const a = make("r1", "ana");
  session.storeSession(a);
  session.handleUnauthenticated(`Bearer ${a.accessToken}`);
  assert.deepEqual(transitions(() => session.storeSession(make("r2", "ana"))), ["renewed"]);
  assert.equal(session.sessionToken(), "token-r2");

  session.handleUnauthenticated("Bearer token-r2");
  assert.deepEqual(transitions(() => session.storeSession(make("r3", "bao"))), ["switched"]);
  assert.deepEqual(transitions(() => session.clearSession()), ["ended"]);
  assert.equal(storage.getItem(KEY), null);
});

test("another tab's sign-in resolves this tab's expired session", () => {
  const a = make("x1", "ana");
  session.storeSession(a);
  session.handleUnauthenticated(`Bearer ${a.accessToken}`);
  const fresh = make("x2", "ana");
  const seen = transitions(() => {
    storage.setItem(KEY, JSON.stringify(fresh)); // written by the other tab
    for (const listener of storageListeners) listener({ key: KEY });
  });
  assert.deepEqual(seen, ["renewed"]);
  assert.equal(session.sessionToken(), fresh.accessToken);

  const other = transitions(() => {
    storage.setItem(KEY, JSON.stringify({ ...fresh, expired: true }));
    for (const listener of storageListeners) listener({ key: KEY });
  });
  assert.deepEqual(other, ["expired"], "an expiry seen by another tab expires this one too");
  session.clearSession();
});

test("safeNext follows only same-origin paths and never Sign in itself", () => {
  assert.equal(safeNext("/knowledge?q=travel%20policy#top"), "/knowledge?q=travel%20policy#top");
  assert.equal(safeNext("/knowledge/collections/abc"), "/knowledge/collections/abc");
  for (const bad of [
    null,
    undefined,
    "",
    "home",
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "javascript:alert(1)",
    "/signin?next=/home",
  ]) {
    assert.equal(safeNext(bad), null, String(bad));
  }
});

test("signInHref keeps the address and says why", () => {
  const href = signInHref("/knowledge?q=a&b=c", "expired");
  const url = new URL(href, "https://bomesh.test");
  assert.equal(url.pathname, "/signin");
  assert.equal(url.searchParams.get("next"), "/knowledge?q=a&b=c");
  assert.equal(url.searchParams.get("reason"), "expired");
  assert.equal(new URL(signInHref("/home"), "https://bomesh.test").searchParams.get("reason"), null);
});

test("while expired the API boundary sends nothing but the public sign-in methods", async (context) => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string) => {
    const request = input instanceof Request ? input : new Request(input);
    sent.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get("Authorization") ?? "-"}`);
    return new Response(JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED", message: "no" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = realFetch;
    session.clearSession();
  });

  const a = make("b1", "ana");
  session.storeSession(a);
  const workspace = () => call(api.GET("/api/v1/workspaces/{workspace}", { params: { path: { workspace: "w1" } } }));
  // The server rejects the current token: the session expires.
  await assert.rejects(workspace(), ApiError);
  assert.deepEqual(sent, ["GET /api/v1/workspaces/w1 Bearer token-b1"]);
  assert.equal(session.getExpiredSession()?.name, a.name);

  // Expired: answered locally with 401, never sent.
  await assert.rejects(workspace(), (error: unknown) => error instanceof ApiError && error.status === 401);
  await assert.rejects(rawFetch("/api/v1/workspaces/w1/items/x?alt=media"), ApiError);
  assert.equal(sent.length, 1);

  // Signing in again is public and still goes out (CreateSession has no token to carry).
  await assert.rejects(call(api.POST("/api/v1/sessions", { body: { credential: { password: { email: "ana@example.com", password: "x" } } } })));
  assert.deepEqual(sent.slice(1), ["POST /api/v1/sessions -"]);
});

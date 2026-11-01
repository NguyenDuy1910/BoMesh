import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import "./support/register-aliases.mjs";

class MemoryStorage {
  #items = new Map<string, string>();
  getItem(key: string) { return this.#items.get(key) ?? null; }
  setItem(key: string, value: string) { this.#items.set(key, String(value)); }
  removeItem(key: string) { this.#items.delete(key); }
  clear() { this.#items.clear(); }
}

const globals = globalThis as Record<string, unknown>;
globals.window = globalThis;
globals.localStorage = new MemoryStorage();
globals.sessionStorage = new MemoryStorage();
globals.__BOMESH_PENDING_LATENCY__ = 0;
process.env.NEXT_PUBLIC_BOMESH_API_URL = "http://api.test";
console.info = () => {};

const { listKnowledgeGaps, updateKnowledgeGap } = await import("../src/modules/manage/overview/api.ts");
const { exportAuditLogs } = await import("../src/modules/manage/activity/api.ts");
const { createPlatformWorkspace, updatePlatformUser } = await import("../src/modules/platform/api.ts");
const { ApiError } = await import("../src/lib/api/request.ts");

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const ME = "22222222-2222-2222-2222-222222222222";

function signIn({ permissions = [] as string[], platform = [] as string[] } = {}) {
  (globals.sessionStorage as MemoryStorage).setItem("bomesh.auth.session", JSON.stringify({
    access_token: "token",
    token_type: "bearer",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    session_id: "session-1",
    user_id: ME,
    email: "me@example.com",
    display_name: "Me",
    active_workspace_id: WORKSPACE,
    permissions,
    workspaces: [{ id: WORKSPACE, code: "acme", name: "Acme", role_codes: [], permissions }],
    platform_permissions: platform,
  }));
}

/** Answers `/api/v1<path>` from a table; anything else is a 404, as the API would say. */
function serve(routes: Record<string, (url: URL) => unknown>) {
  const requested: string[] = [];
  globals.fetch = async (input: string | URL) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    requested.push(path + url.search);
    const route = routes[path];
    if (!route) return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
    return new Response(JSON.stringify(route(url)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return requested;
}

async function rejectsWith(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error: unknown) => error instanceof ApiError && error.status === status);
}

beforeEach(() => {
  (globals.localStorage as MemoryStorage).clear();
  (globals.sessionStorage as MemoryStorage).clear();
  serve({});
});

test("a dismissed knowledge gap leaves the list and comes back on undo", async () => {
  signIn({ permissions: ["tenant.manage"] });
  serve({
    "/collections": () => ({
      items: [{ id: "c-hr", item_type: "collection", title: "HR Policies" }],
      total: 1,
    }),
  });

  const before = await listKnowledgeGaps(WORKSPACE, { window: "7d" });
  const gap = before.items.find((item) => item.question.includes("notice period"));
  assert.ok(gap);
  assert.equal(gap.suggested_collection_id, "c-hr");
  assert.equal(before.items.find((item) => item.question.includes("SCIM"))?.suggested_collection_id, null);

  const dismissed = await updateKnowledgeGap(WORKSPACE, gap.id, { dismissed: true });
  assert.equal(dismissed.dismissed, true);
  const hidden = await listKnowledgeGaps(WORKSPACE, { window: "7d" });
  assert.ok(!hidden.items.some((item) => item.id === gap.id));
  const all = await listKnowledgeGaps(WORKSPACE, { window: "7d", include_dismissed: true });
  assert.equal(all.items.find((item) => item.id === gap.id)?.dismissed, true);

  await updateKnowledgeGap(WORKSPACE, gap.id, { dismissed: false });
  const restored = await listKnowledgeGaps(WORKSPACE, { window: "7d" });
  assert.ok(restored.items.some((item) => item.id === gap.id && !item.dismissed));
});

test("knowledge gaps need permission to manage the workspace", async () => {
  signIn({ permissions: ["tenant.read"] });
  await rejectsWith(listKnowledgeGaps(WORKSPACE, { window: "30d" }), 403);
  await rejectsWith(updateKnowledgeGap(WORKSPACE, "gap-contractor-notice", { dismissed: true }), 403);
});

test("the CSV export is built from the real audit list, filtered and safely quoted", async () => {
  signIn({ permissions: ["audit.read"] });
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const event = (id: string, created_at: string, outcome: string, actor: string, title: string) => ({
    id,
    action: "collection.updated",
    resource_type: "collection",
    resource_id: id,
    outcome,
    details: { title, ip_address: "10.0.0.1" },
    actor: { id: `actor-${id}`, email: `${id}@example.com`, display_name: actor },
    created_at,
  });
  const requested = serve({
    "/audit-logs": () => ({
      items: [
        event("a", recent, "success", 'Lee, "Ace"', "Plans, 2026"),
        event("b", recent, "failure", "=HYPERLINK()", "Budget"),
        event("c", old, "success", "Too old", "Outside the window"),
      ],
      total: 3,
    }),
  });

  const blob = await exportAuditLogs({ format: "csv", window: "7d", outcome: "success" });
  assert.match(blob.type, /^text\/csv/);
  const lines = (await blob.text()).replace(/^\uFEFF/, "").trimEnd().split("\r\n");
  assert.equal(lines[0], "Time,Actor,Action,Target,Outcome,IP address");
  assert.equal(lines.length, 2, "only the recent successful event remains");
  // Quoting and column order matter here; the wording comes from audit-actions (its own test).
  assert.match(lines[1], new RegExp(`^${recent},"Lee, ""Ace""",[^",]+,"[^"]*Plans, 2026",Succeeded,10\\.0\\.0\\.1$`));
  assert.ok(requested.every((path) => path.startsWith("/audit-logs")), "nothing but the audit list is read");

  const failures = await exportAuditLogs({ format: "csv", window: "7d", outcome: "failure" });
  const failureRow = (await failures.text()).trimEnd().split("\r\n")[1];
  assert.ok(failureRow.startsWith(`${recent},'=HYPERLINK()`), "a formula-looking name is neutralised");
});

test("exporting activity needs permission to view it", async () => {
  signIn({ permissions: ["tenant.read"] });
  await rejectsWith(exportAuditLogs({ format: "csv", window: "30d" }), 403);
});

test("a new workspace's web address must be well formed and unused", async () => {
  signIn({ platform: ["platform.tenant.read"] });
  serve({
    "/platform/workspaces": () => ({
      items: [{ id: "w-1", code: "northwind", name: "Northwind", status: "active", settings: {}, created_at: "", updated_at: "", owner: null, member_count: 4, connection_count: 0 }],
      total: 1,
    }),
  });
  const body = { name: "Litware Labs", owner_email: "sam@litware.com" };

  for (const code of ["ab", "Litware", "-litware", "litware-", "a".repeat(33), "lit ware"]) {
    await rejectsWith(createPlatformWorkspace({ ...body, code }), 422);
  }
  await rejectsWith(createPlatformWorkspace({ ...body, code: "northwind" }), 409);

  const created = await createPlatformWorkspace({ ...body, code: "litware-labs" });
  assert.equal(created.source, "local");
  assert.equal(created.code, "litware-labs");
  await rejectsWith(createPlatformWorkspace({ ...body, code: "litware-labs" }), 409);
});

test("workspace administration needs a platform grant", async () => {
  signIn({ permissions: ["tenant.manage"] });
  await rejectsWith(createPlatformWorkspace({ name: "Litware", code: "litware", owner_email: "sam@litware.com" }), 403);
});

test("nobody can change their own platform role or account status", async () => {
  signIn({ platform: ["platform.user.read"] });
  serve({
    "/platform/users": () => ({
      items: [
        { id: ME, email: "me@example.com", display_name: "Me", status: "active", roles: [], groups: [] },
        { id: "u-2", email: "kim@example.com", display_name: "Kim", status: "active", roles: [], groups: [] },
      ],
      total: 2,
    }),
  });

  await rejectsWith(updatePlatformUser(ME, { is_platform_admin: false }), 403);
  await rejectsWith(updatePlatformUser(ME, { status: "suspended" }), 403);

  const promoted = await updatePlatformUser("u-2", { is_platform_admin: true });
  assert.equal(promoted.is_platform_admin, true);
  const suspended = await updatePlatformUser("u-2", { status: "suspended" });
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.is_platform_admin, true, "earlier changes are kept");
});

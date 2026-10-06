import assert from "node:assert/strict";
import test from "node:test";

// Maps `@/` to web/src for the modules below; they must load after it.
import "../web/tests/support/register-aliases.mjs";
import type { AuthSession } from "../web/src/lib/auth/session.ts";

const {
  MANAGE_NAV,
  PLATFORM_NAV,
  WORKSPACE_NAV,
  canAccessPath,
  isNavItemActive,
  isPlatformPath,
  visibleNavItems,
} = await import("../web/src/lib/navigation.ts");
const { LEGACY_REDIRECTS } = await import("../web/src/lib/legacy-redirects.ts");

function session(permissions: string[] = [], platform: string[] = []): AuthSession {
  return {
    access_token: "t",
    token_type: "bearer",
    expires_at: "2099-01-01T00:00:00Z",
    session_id: "s",
    user_id: "u",
    email: "person@example.com",
    display_name: "Person",
    active_workspace_id: "w",
    permissions,
    workspaces: [{ id: "w", code: "w", name: "Workspace", role_codes: [], permissions }],
    platform_permissions: platform,
  };
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

const member = session(["knowledge.read"]);
const workspaceAdmin = session([
  "knowledge.read",
  "tenant.read",
  "tenant.manage",
  "source.manage",
  "ingestion.read",
  "user.manage",
  "role.manage",
  "group.manage",
  "access.manage",
  "audit.read",
]);
const platformAdmin = session(["knowledge.read"], [
  "platform.tenant.read",
  "platform.user.read",
  "platform.audit.read",
  "platform.health.read",
]);

test("everyone in a workspace gets New chat, Inbox, Search and Knowledge, in the prototype's order", () => {
  assert.deepEqual(ids(visibleNavItems(WORKSPACE_NAV, member)), ["new-chat", "inbox", "search", "knowledge"]);
  // The inbox is an API-pending feature: switched off, its entry point is gone.
  assert.deepEqual(
    ids(visibleNavItems(WORKSPACE_NAV, member, (key) => key !== "notifications.inbox")),
    ["new-chat", "search", "knowledge"],
  );
});

test("Manage lists only what the caller may open", () => {
  assert.deepEqual(ids(visibleNavItems(MANAGE_NAV, member)), []);
  assert.deepEqual(
    ids(visibleNavItems(MANAGE_NAV, workspaceAdmin)),
    ["overview", "sources", "access", "assistant", "activity", "settings"],
  );

  // Overview needs both tenant.read and tenant.manage.
  assert.deepEqual(ids(visibleNavItems(MANAGE_NAV, session(["tenant.read"]))), []);
  assert.deepEqual(ids(visibleNavItems(MANAGE_NAV, session(["tenant.read", "tenant.manage"]))), ["overview", "assistant", "settings"]);
  assert.deepEqual(ids(visibleNavItems(MANAGE_NAV, session(["tenant.manage"]))), ["assistant", "settings"]);

  for (const code of ["source.manage", "ingestion.read"]) {
    assert.deepEqual(ids(visibleNavItems(MANAGE_NAV, session([code]))), ["sources"], code);
  }
  for (const code of ["user.manage", "role.manage", "group.manage", "access.manage"]) {
    assert.deepEqual(ids(visibleNavItems(MANAGE_NAV, session([code]))), ["access"], code);
  }
  assert.deepEqual(ids(visibleNavItems(MANAGE_NAV, session(["audit.read"]))), ["activity"]);

  // Assistant setup is API-pending: switched off, it disappears even for admins.
  assert.deepEqual(
    ids(visibleNavItems(MANAGE_NAV, workspaceAdmin, (key) => key !== "workspace.assistant_settings")),
    ["overview", "sources", "access", "activity", "settings"],
  );
});

test("platform items follow platform permissions only, never workspace ones", () => {
  assert.deepEqual(ids(visibleNavItems(PLATFORM_NAV, workspaceAdmin)), []);
  assert.deepEqual(
    ids(visibleNavItems(PLATFORM_NAV, platformAdmin)),
    ["p-workspaces", "p-users", "p-connectors", "p-capabilities", "p-usage", "p-audit", "p-health"],
  );
  assert.deepEqual(ids(visibleNavItems(PLATFORM_NAV, session([], ["platform.audit.read"]))), ["p-audit"]);
  assert.deepEqual(
    ids(visibleNavItems(PLATFORM_NAV, platformAdmin, (key) => !key.startsWith("platform."))),
    ["p-workspaces", "p-users", "p-audit", "p-health"],
  );
});

test("exactly one destination is current, and actions never are", () => {
  const all = [...WORKSPACE_NAV, ...MANAGE_NAV, ...PLATFORM_NAV];
  const current = (pathname: string) => ids(all.filter((item) => isNavItemActive(item, pathname)));

  assert.deepEqual(current("/knowledge"), ["knowledge"]);
  assert.deepEqual(current("/knowledge/c1"), ["knowledge"]);
  // A document belongs to Knowledge.
  assert.deepEqual(current("/documents/d1"), ["knowledge"]);
  assert.deepEqual(current("/knowledgeable"), []);
  assert.deepEqual(current("/manage/sources"), ["sources"]);
  assert.deepEqual(current("/manage/access"), ["access"]);
  assert.deepEqual(current("/platform/users"), ["p-users"]);
  assert.deepEqual(current("/platform/health"), ["p-health"]);
  // New chat, Search and Inbox start something; they never show as the page you are on.
  assert.deepEqual(current("/chat"), []);
  assert.deepEqual(current("/chat/abc"), []);
});

test("the platform console owns every /platform address", () => {
  assert.equal(isPlatformPath("/platform"), true);
  assert.equal(isPlatformPath("/platform/workspaces"), true);
  assert.equal(isPlatformPath("/platforms"), false);
  assert.equal(isPlatformPath("/manage/overview"), false);
});

test("an address opens only for callers its nav item allows", () => {
  for (const path of ["/chat", "/chat/c1", "/chats", "/knowledge", "/knowledge/c1", "/documents/d1"]) {
    assert.equal(canAccessPath(path, member), true, path);
  }
  for (const path of ["/manage", "/manage/overview", "/manage/access", "/manage/sources?tab=history", "/platform", "/platform/workspaces"]) {
    assert.equal(canAccessPath(path, member), false, path);
  }

  assert.equal(canAccessPath("/manage", workspaceAdmin), true);
  assert.equal(canAccessPath("/manage/access?tab=requests", workspaceAdmin), true);
  // Unknown management addresses are never opened by default.
  assert.equal(canAccessPath("/manage/unknown", workspaceAdmin), false);
  assert.equal(canAccessPath("/platform/users", workspaceAdmin), false);

  assert.equal(canAccessPath("/platform", platformAdmin), true);
  assert.equal(canAccessPath("/platform/health", platformAdmin), true);
  assert.equal(canAccessPath("/platform/health", session([], ["platform.tenant.read"])), false);
  assert.equal(canAccessPath("/manage/overview", platformAdmin), false);

  // A pending feature that is switched off closes its page too.
  assert.equal(canAccessPath("/manage/assistant", workspaceAdmin, (key) => key !== "workspace.assistant_settings"), false);
  assert.equal(canAccessPath("/chat", null), false);
});

/**
 * The subset of Next's redirect matching the table uses: `:name(a|b)` and
 * `:name*` segments, `has` query conditions, the original query passed
 * through with the destination's own query winning, first match wins.
 */
function redirect(url: string): string | null {
  const [path, search = ""] = url.split("?");
  const query = new URLSearchParams(search);
  for (const rule of LEGACY_REDIRECTS) {
    const pattern = rule.source.replace(/\/:\w+(\([^)]*\))?(\*)?/g, (_, group: string | undefined, star: string | undefined) =>
      star ? "(?:/[^/]+)*" : group ? `/${group}` : "/[^/]+");
    if (!new RegExp(`^${pattern}$`).test(path)) continue;
    if (rule.has?.some((condition) => !query.has(condition.key) || (condition.value !== undefined && query.get(condition.key) !== condition.value))) continue;
    const [destinationPath, destinationSearch = ""] = rule.destination.split("?");
    const merged = new URLSearchParams(search);
    for (const [key, value] of new URLSearchParams(destinationSearch)) merged.set(key, value);
    return merged.size ? `${destinationPath}?${merged}` : destinationPath;
  }
  return null;
}

test("legacy addresses land on their new pages", () => {
  const cases: [string, string][] = [
    ["/app", "/chat"],
    ["/app?action=new", "/chat?action=new"],
    ["/app?action=search", "/chat?action=search"],
    ["/library", "/knowledge/personal"],
    ["/workspace-control", "/manage/overview"],
    ["/workspace-control/dashboard", "/manage/overview"],
    ["/workspace-control/knowledge", "/knowledge"],
    ["/workspace-control/collections/c1", "/knowledge"],
    ["/workspace-control/ingestion?tab=runs", "/manage/sources?tab=history"],
    ["/workspace-control/ingestion?tab=schedules", "/manage/sources?tab=sources"],
    ["/workspace-control/ingestion?tab=sources", "/manage/sources?tab=sources"],
    ["/workspace-control/ingestion", "/manage/sources?tab=sources"],
    ["/workspace-control/agent", "/manage/assistant"],
    ["/workspace-control/experience", "/manage/assistant"],
    ["/workspace-control/access", "/manage/access"],
    ["/workspace-control/access?tab=groups", "/manage/access?tab=groups"],
    ["/workspace-control/roles", "/manage/access?tab=roles"],
    ["/workspace-control/activity", "/manage/activity"],
    ["/workspace-control/audit-logs", "/manage/activity"],
    ["/workspace-control/settings", "/manage/settings"],
    ["/workspace-control/platform", "/platform/workspaces"],
    ["/workspace-control/platform/users", "/platform/users"],
    ["/workspace-control/platform/integrations", "/platform/connectors"],
    ["/workspace-control/platform/models", "/platform/capabilities"],
    ["/workspace-control/platform/usage", "/platform/usage"],
    ["/workspace-control/platform/audit", "/platform/audit"],
    ["/workspace-control/platform/system", "/platform/health"],
    ["/workspace-control/something-old", "/manage/overview"],
  ];
  for (const [from, to] of cases) assert.equal(redirect(from), to, from);

  // New addresses are never redirected.
  for (const path of ["/chat", "/knowledge", "/manage/overview", "/platform/workspaces"]) {
    assert.equal(redirect(path), null, path);
  }
});

test("every redirect is permanent and lands on a page the navigation knows", () => {
  const destinations = [...WORKSPACE_NAV, ...MANAGE_NAV, ...PLATFORM_NAV].flatMap((item) => (item.href ? [item.href] : []));
  for (const rule of LEGACY_REDIRECTS) {
    assert.equal(rule.permanent, true, rule.source);
    const [path] = rule.destination.split("?");
    assert.ok(
      destinations.includes(path) || path === "/knowledge/personal",
      `${rule.source} → ${rule.destination} is not a navigation page`,
    );
  }
});

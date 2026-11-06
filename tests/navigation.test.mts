import assert from "node:assert/strict";
import test from "node:test";

// Maps `@/` to apps/web/src for the modules below; they must load after it.
import "../apps/web/tests/support/register-aliases.mjs";
import type { NavAccess } from "../apps/web/src/lib/navigation.ts";

const { MANAGE_NAV, MEMBER_NAV, PLATFORM_NAV, ROUTES, isNavItemActive, manageNav, matchRoute, memberNav, routeGate } = await import(
  "../apps/web/src/lib/navigation.ts"
);

function access(permissions: string[] = [], modules: string[] = []): NavAccess {
  return {
    can: (p) => permissions.includes(p),
    hasModule: (m) => modules.includes(m),
  };
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

const member = access();
const admin = access(
  [
    "workspaces.getOverview",
    "workspaces.updateAssistant",
    "workspaces.updateSettings",
    "contributions.review",
    "sources.list",
    "connections.list",
    "members.create",
    "auditEvents.list",
  ],
  ["spaces", "work", "requests"],
);

test("everyone gets Home and Knowledge; Work and Requests follow the workspace modules, in the preview's order", () => {
  assert.deepEqual(ids(memberNav(member)), ["home", "knowledge"]);
  assert.deepEqual(ids(memberNav(access([], ["requests"]))), ["home", "knowledge", "requests"]);
  assert.deepEqual(ids(memberNav(admin)), ids(MEMBER_NAV));
});

test("Manage lists only what the caller may open", () => {
  assert.deepEqual(ids(manageNav(member)), []);
  assert.deepEqual(ids(manageNav(admin)), ids(MANAGE_NAV));
  assert.deepEqual(ids(manageNav(access(["contributions.review"]))), ["documents"]);
  assert.deepEqual(ids(manageNav(access(["sources.list", "connections.list"]))), ["sources", "connections"]);
  assert.deepEqual(ids(manageNav(access(["workspaces.updateSettings"]))), ["settings"]);
});

test("routes carry the preview's titles, modes and nav items", () => {
  assert.deepEqual(matchRoute("/home"), { title: "Home", mode: "workspace", nav: "home" });
  assert.equal(matchRoute("/knowledge/library").nav, "knowledge");
  assert.equal(matchRoute("/knowledge/collections/abc").title, "Collection");
  assert.equal(matchRoute("/knowledge/abc").title, "Knowledge base");
  assert.equal(matchRoute("/work/new").title, "New work");
  assert.equal(matchRoute("/work/w1").bare, true);
  assert.equal(matchRoute("/chat/c1").bare, true);
  assert.equal(matchRoute("/doc/d1").bare, true);
  assert.equal(matchRoute("/home/").title, "Home");
  assert.equal(matchRoute("/p/health").mode, "platform");
  assert.equal(matchRoute("/signin").mode, "auth");
  assert.equal(matchRoute("/password-reset/tok").mode, "auth");
});

test("unknown addresses are Not found, in the console for /p/…", () => {
  assert.deepEqual(matchRoute("/nope"), { title: "Not found", mode: "workspace" });
  assert.equal(matchRoute("/p/nope").mode, "platform");
  assert.equal(matchRoute("/knowledge/a/b/c").title, "Not found");
});

test("exactly one sidebar item is current per screen", () => {
  const all = [...MEMBER_NAV, ...MANAGE_NAV, ...PLATFORM_NAV];
  for (const [path, id] of [
    ["/home", "home"],
    ["/knowledge/bases", "knowledge"],
    ["/doc/x", "knowledge"],
    ["/requests/new", "requests"],
    ["/people", "people"],
    ["/p/audit", "p-audit"],
  ] as const) {
    const route = matchRoute(path);
    assert.deepEqual(
      all.filter((item) => isNavItemActive(item, route)).map((item) => item.id),
      [id],
      path,
    );
  }
  assert.deepEqual(all.filter((item) => isNavItemActive(item, matchRoute("/chat"))), []);
});

test("permission is checked before the module, and gated routes render a state instead of the page", () => {
  assert.equal(routeGate(matchRoute("/settings"), member), "permission");
  assert.equal(routeGate(matchRoute("/settings"), admin), null);
  assert.equal(routeGate(matchRoute("/spaces"), member), "module");
  assert.equal(routeGate(matchRoute("/space/s1"), admin), null);
  assert.equal(routeGate(matchRoute("/home"), member), null);
});

test("every sidebar destination has a route with the same gate", () => {
  for (const item of [...MEMBER_NAV, ...MANAGE_NAV, ...PLATFORM_NAV]) {
    const route = matchRoute(item.href);
    assert.notEqual(route.title, "Not found", item.href);
    assert.equal(route.nav, item.id, item.href);
    assert.equal(route.permission, item.permission, item.href);
    assert.equal(route.module, item.module, item.href);
  }
  assert.equal(new Set(ROUTES.map((r) => r.pattern)).size, ROUTES.length);
});

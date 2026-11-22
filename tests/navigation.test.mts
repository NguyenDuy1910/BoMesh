import assert from "node:assert/strict";
import test from "node:test";

// Maps `@/` to apps/web/src for the modules below; they must load after it.
import "../apps/web/tests/support/register-aliases.mjs";
import type { NavAccess } from "../apps/web/src/lib/navigation.ts";

const {
  MANAGE_NAV,
  MEMBER_NAV,
  PLATFORM_NAV,
  ROUTES,
  STUDIO_NAV,
  YOUR_WORK_NAV,
  isNavItemActive,
  manageNav,
  matchRoute,
  memberNav,
  routeGate,
  sectionOf,
  sectionTitle,
  studioLanding,
  studioSections,
  indexingSections,
  yourWorkNav,
} = await import("../apps/web/src/lib/navigation.ts");

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

test("everyone gets Home, Knowledge and New chat; Work and Requests follow the workspace modules, in the preview's order", () => {
  assert.deepEqual(ids(memberNav(member)), ["home", "knowledge", "chat"]);
  assert.deepEqual(ids(memberNav(access([], ["requests"]))), ["home", "knowledge", "chat", "requests"]);
  assert.deepEqual(ids(memberNav(admin)), ids(MEMBER_NAV));
});

test("Your work: Projects only while projects are available, Spaces with its module, My contributions for contributors", () => {
  assert.deepEqual(ids(yourWorkNav(member, false, true)), ["projects"]);
  assert.deepEqual(ids(yourWorkNav(member, false, false)), []);
  assert.deepEqual(ids(yourWorkNav(admin, true, true)), ids(YOUR_WORK_NAV));
  assert.deepEqual(ids(yourWorkNav(admin, true, false)), ids(YOUR_WORK_NAV).filter((id) => id !== "projects"));
});

test("Manage lists only what the caller may open; Knowledge Studio follows its sections", () => {
  assert.deepEqual(ids(manageNav(member, false)), []);
  assert.deepEqual(ids(manageNav(member, true)), ["studio"]);
  assert.deepEqual(ids(manageNav(admin, true)), ["overview", "studio", "people", "assistant", "activity", "settings"]);
  assert.deepEqual(ids(manageNav(access(["workspaces.updateSettings"]), false)), ["settings"]);
});

test("Knowledge Studio sections follow permissions and collection ownership, in two clusters", () => {
  const can = (perms: string[]) => (p: string) => perms.includes(p);
  assert.deepEqual(ids(studioSections({ can: can([]), managesCollections: false })), []);
  assert.deepEqual(ids(studioSections({ can: can([]), managesCollections: true })), ["collections"]);
  const all = studioSections({ can: can(["contributions.review", "topics.update", "sources.list"]), managesCollections: true });
  assert.deepEqual(ids(all), ["documents", "collections", "topics", "sources"]);
  assert.deepEqual(all.map((s) => Boolean(s.gap)), [false, true, false, false]);
  assert.equal(studioLanding(all, {}), "documents");
  assert.equal(studioLanding(all, { documents: 2, sources: 1 }), "documents");
  assert.equal(studioLanding(all, { documents: 0, sources: 1 }), "sources");
  assert.equal(studioLanding(all.slice(1), {}), "collections");
});

test("a section comes from ?tab= and falls back; its title may differ from its label", () => {
  assert.equal(sectionOf(indexingSections, "jobs"), "jobs");
  assert.equal(sectionOf(indexingSections, "nope"), "workspaces");
  assert.equal(sectionOf(indexingSections, null, "policies"), "policies");
  assert.equal(sectionTitle(indexingSections, "jobs"), "Indexing jobs");
});

test("routes carry the preview's titles, modes and nav items", () => {
  assert.deepEqual(matchRoute("/home"), { title: "Home", mode: "workspace", nav: "home" });
  assert.equal(matchRoute("/knowledge/library").nav, "knowledge");
  assert.equal(matchRoute("/knowledge/lists/abc").title, "Not found");
  assert.equal(matchRoute("/studio/collections/abc").nav, "studio");
  assert.equal(matchRoute("/space/s1").nav, "spaces");
  assert.equal(matchRoute("/project/p1").nav, "projects");
  assert.equal(matchRoute("/work/new").title, "New work");
  assert.equal(matchRoute("/work/w1").bare, true);
  assert.equal(matchRoute("/chat/c1").bare, true);
  assert.equal(matchRoute("/doc/d1").bare, true);
  assert.equal(matchRoute("/home/").title, "Home");
  assert.equal(matchRoute("/p/health").mode, "platform");
  assert.equal(matchRoute("/signin").mode, "auth");
  assert.equal(matchRoute("/password-reset/tok").mode, "auth");
  for (const gone of ["/inbox", "/chats", "/recent", "/bases", "/documents", "/sources", "/connections", "/knowledge/collections/abc"])
    assert.equal(matchRoute(gone).title, "Not found", gone);
});

test("unknown addresses are Not found, in the console for /p/…", () => {
  assert.deepEqual(matchRoute("/nope"), { title: "Not found", mode: "workspace" });
  assert.equal(matchRoute("/p/nope").mode, "platform");
  assert.equal(matchRoute("/knowledge/a/b/c").title, "Not found");
});

test("exactly one sidebar item is current per screen", () => {
  const all = [...MEMBER_NAV, ...YOUR_WORK_NAV, ...MANAGE_NAV, STUDIO_NAV, ...PLATFORM_NAV];
  for (const [path, id] of [
    ["/home", "home"],
    ["/studio", "studio"],
    ["/studio/collections/abc", "studio"],
    ["/doc/x", "knowledge"],
    ["/chat", "chat"],
    ["/requests/new", "requests"],
    ["/knowledge/map", "knowledge"],
    ["/contributions", "contributions"],
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
  // A conversation is current in the sidebar's Recent list, not as New chat; search has no item.
  for (const path of ["/search", "/chat/c1"]) assert.deepEqual(all.filter((item) => isNavItemActive(item, matchRoute(path))), [], path);
});

test("permission is checked before the module, and gated routes render a state instead of the page", () => {
  assert.equal(routeGate(matchRoute("/settings"), member), "permission");
  assert.equal(routeGate(matchRoute("/settings"), admin), null);
  assert.equal(routeGate(matchRoute("/spaces"), member), "module");
  assert.equal(routeGate(matchRoute("/space/s1"), admin), null);
  assert.equal(routeGate(matchRoute("/home"), member), null);
});

test("every sidebar destination has a route with the same gate", () => {
  for (const item of [...MEMBER_NAV, ...YOUR_WORK_NAV, ...MANAGE_NAV, STUDIO_NAV, ...PLATFORM_NAV]) {
    const route = matchRoute(item.href);
    assert.notEqual(route.title, "Not found", item.href);
    assert.equal(route.nav, item.id, item.href);
    assert.equal(route.permission, item.permission, item.href);
    assert.equal(route.module, item.module, item.href);
  }
  assert.equal(new Set(ROUTES.map((r) => r.pattern)).size, ROUTES.length);
});

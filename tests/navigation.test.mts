import assert from "node:assert/strict";
import test from "node:test";

// Maps `@/` to apps/web/src for the modules below; they must load after it.
import "../apps/web/tests/support/register-aliases.mjs";
import type { NavAccess, RouteInfo } from "../apps/web/src/lib/navigation.ts";

const {
  MANAGE_NAV,
  MEMBER_NAV,
  PLATFORM_NAV,
  ROUTES,
  STUDIO_NAV,
  YOUR_WORK_NAV,
  isComingSoon,
  isNavItemActive,
  manageNav,
  matchRoute,
  memberNav,
  peopleSections,
  routeGate,
  sectionOf,
  sectionTitle,
  studioLanding,
  studioSections,
  indexingSections,
  yourWorkNav,
} = await import("../apps/web/src/lib/navigation.ts");
const { messages: vi } = await import("../apps/web/src/i18n/messages/index.ts");

function access(permissions: string[] = [], modules: string[] = []): NavAccess {
  return {
    can: (p) => permissions.includes(p),
    hasModule: (m) => modules.includes(m),
  };
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

/** A route with its title in the catalog's Vietnamese. */
const route = (path: string): Omit<RouteInfo, "title"> & { title: string } => {
  const r = matchRoute(path);
  return { ...r, title: r.title(vi) };
};

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

test("everyone gets Home, Knowledge and New chat; Requests follows its module; Work (a later phase) shows as coming soon", () => {
  assert.deepEqual(ids(memberNav(member)), ["home", "knowledge", "chat", "work"]);
  assert.deepEqual(ids(memberNav(access([], ["requests"]))), ["home", "knowledge", "chat", "work", "requests"]);
  assert.deepEqual(ids(memberNav(admin)), ids(MEMBER_NAV));
  assert.deepEqual(memberNav(member).filter(isComingSoon).map((i) => i.id), ["work"]);
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
  assert.equal(sectionTitle(indexingSections, "jobs", vi), "Tác vụ lập chỉ mục");
  assert.equal(sectionTitle(indexingSections, "nope", vi), "");
});

test("routes carry the preview's titles, modes and nav items", () => {
  assert.deepEqual(route("/home"), { title: "Trang chủ", mode: "workspace", nav: "home" });
  assert.equal(route("/knowledge/library").nav, "knowledge");
  assert.equal(route("/knowledge/lists/abc").title, "Không tìm thấy");
  assert.equal(route("/studio/collections/abc").nav, "studio");
  assert.equal(route("/space/s1").nav, "spaces");
  assert.equal(route("/project/p1").nav, "projects");
  assert.equal(route("/work/new").title, "Công việc mới");
  assert.equal(route("/work/w1").bare, true);
  assert.equal(route("/chat/c1").bare, true);
  assert.equal(route("/doc/d1").bare, true);
  assert.equal(route("/home/").title, "Trang chủ");
  assert.equal(route("/p/health").mode, "platform");
  assert.equal(route("/signin").mode, "auth");
  assert.equal(route("/password-reset/tok").mode, "auth");
  for (const gone of ["/inbox", "/chats", "/recent", "/bases", "/documents", "/sources", "/connections", "/knowledge/collections/abc"])
    assert.equal(route(gone).title, "Không tìm thấy", gone);
});

test("route titles are catalog names", () => {
  assert.equal(matchRoute("/studio").title(vi), "Quản trị tài liệu");
  assert.equal(matchRoute("/chat").title(vi), "Trò chuyện mới");
  assert.equal(matchRoute("/contributions").title(vi), "Tài liệu tôi đã gửi");
  assert.equal(matchRoute("/people").title(vi), "Người dùng & phân quyền");
  assert.equal(matchRoute("/activity").title(vi), "Nhật ký hoạt động");
  assert.equal(matchRoute("/nope").title(vi), "Không tìm thấy");
});

test("sidebar rows and sections are named from the catalog (product language §2.1)", () => {
  const names = (items: readonly { label: (m: typeof vi) => string }[]) => items.map((item) => item.label(vi));
  assert.deepEqual(names(MEMBER_NAV), ["Trang chủ", "Tài liệu", "Trò chuyện mới", "Công việc", "Yêu cầu"]);
  assert.deepEqual(names(YOUR_WORK_NAV), ["Dự án", "Cộng đồng", "Tài liệu tôi đã gửi"]);
  assert.deepEqual(names(manageNav(access(["workspaces.getOverview", "members.create", "auditEvents.list"]), true)), [
    "Tổng quan",
    "Quản trị tài liệu",
    "Người dùng & phân quyền",
    "Nhật ký hoạt động",
  ]);
  assert.equal(MEMBER_NAV[1].home?.(vi), "Tra cứu");
  const studio = studioSections({ can: () => true, managesCollections: true });
  assert.deepEqual(names(studio), ["Tài liệu", "Kho tài liệu", "Chủ đề", "Nguồn dữ liệu"]);
  assert.deepEqual(studio.map((s) => s.id), ["documents", "collections", "topics", "sources"]);
  assert.deepEqual(names(peopleSections), ["Thành viên", "Nhóm", "Vai trò", "Yêu cầu truy cập"]);
  assert.deepEqual([vi.nav.group.yourWork, vi.nav.group.manage, vi.nav.group.recent], ["Cá nhân", "Quản trị", "Gần đây"]);
});

test("unknown addresses are Not found, in the console for /p/…", () => {
  assert.deepEqual(route("/nope"), { title: "Không tìm thấy", mode: "workspace" });
  assert.equal(route("/p/nope").mode, "platform");
  assert.equal(route("/knowledge/a/b/c").title, "Không tìm thấy");
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
    const r = route(item.href);
    assert.notEqual(r.title, "Không tìm thấy", item.href);
    assert.equal(r.nav, item.id, item.href);
    assert.equal(r.permission, item.permission, item.href);
    assert.equal(r.module, item.module, item.href);
  }
  assert.equal(new Set(ROUTES.map((r) => r.pattern)).size, ROUTES.length);
});

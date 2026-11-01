/**
 * Checks the product shell's navigation contract against a running app:
 *
 * - the sidebar lists only what each persona may open (member, workspace
 *   admin, platform operator) and exactly one destination is current;
 * - an address the caller may not open renders the no-access page;
 * - legacy addresses redirect permanently to their new pages;
 * - clicking a page tab changes only the page: the sidebar's markup, width
 *   and scroll stay put and focus stays on the tab;
 * - menus and the palette close on Escape and give focus back.
 *
 *   node scripts/nav-contract.mjs            (BASE_URL defaults to http://localhost:3000)
 */
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const WORKSPACE = "00000000-0000-0000-0000-000000000001";
const ADMIN = [
  "knowledge.read", "tenant.read", "tenant.manage", "source.manage", "ingestion.read",
  "user.manage", "role.manage", "group.manage", "access.manage", "audit.read",
];
const PERSONAS = {
  member: { permissions: ["knowledge.read"], platform: [] },
  admin: { permissions: ADMIN, platform: [] },
  operator: { permissions: ["knowledge.read"], platform: ["platform.tenant.read", "platform.user.read", "platform.audit.read", "platform.health.read"] },
};

const session = (persona) => ({
  access_token: "local-verification-token",
  token_type: "bearer",
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  session_id: "s",
  user_id: `u-${persona}`,
  email: `${persona}@example.com`,
  display_name: persona,
  active_workspace_id: WORKSPACE,
  permissions: PERSONAS[persona].permissions,
  workspaces: [{ id: WORKSPACE, code: "vikki", name: "Vikki Bank", role_codes: [], permissions: PERSONAS[persona].permissions }],
  platform_permissions: PERSONAS[persona].platform,
});

let failures = 0;
const check = (ok, message) => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${message}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch();

async function pageFor(persona) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(([s, user]) => {
    sessionStorage.setItem("bomesh.auth.session", s);
    localStorage.setItem("bomesh.appearance", JSON.stringify({ theme: "light" }));
    localStorage.setItem(`bomesh.tour.seen.${user}`, "seen");
    window.__BOMESH_PENDING_LATENCY__ = 0;
  }, [JSON.stringify(session(persona)), `u-${persona}`]);
  await context.route(/\/api\/v1\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith("/knowledge/home")
      ? { collections: [], recent_documents: [], personal_collection_id: null }
      : path.endsWith("/collections/personal")
        ? { id: "c0", title: "My uploads" }
        : { items: [], total: 0 };
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });
  return context.newPage();
}

const sidebar = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector("nav.side");
    if (!nav) return null;
    const scroller = nav.querySelector(".recents");
    return {
      html: nav.innerHTML,
      width: Math.round(nav.getBoundingClientRect().width),
      scrollTop: scroller ? scroller.scrollTop : 0,
      links: [...nav.querySelectorAll("a.nav-item, a.new-chat, button.nav-item")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => el.textContent.trim().replace(/\d+$/, "").replace(/⌘K$/, "")),
      current: [...nav.querySelectorAll("a.nav-item[aria-current='page']")].map((el) => el.textContent.trim()),
    };
  });

async function visit(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  await page.waitForSelector("nav.side", { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

console.log("\nSidebar by persona");
const expected = {
  member: ["New chat", "Inbox", "Search", "Knowledge"],
  admin: ["New chat", "Inbox", "Search", "Knowledge", "Overview", "Sources", "People & access", "Assistant setup", "Activity", "Settings"],
  operator: ["New chat", "Inbox", "Search", "Knowledge"],
};
for (const persona of Object.keys(PERSONAS)) {
  const page = await pageFor(persona);
  await visit(page, "/knowledge");
  const state = await sidebar(page);
  check(Boolean(state), `${persona}: sidebar renders`);
  check(JSON.stringify(state?.links) === JSON.stringify(expected[persona]), `${persona}: items ${JSON.stringify(state?.links)}`);
  check(state?.current.length === 1 && state.current[0] === "Knowledge", `${persona}: exactly one current item (${state?.current.join(", ")})`);

  await visit(page, "/manage/access");
  const refused = await page.getByText("You don’t have access to this page").isVisible().catch(() => false);
  check(persona === "admin" ? !refused : refused, `${persona}: /manage/access ${persona === "admin" ? "opens" : "shows no-access"}`);

  if (persona === "operator") {
    await visit(page, "/platform/users");
    const platform = await sidebar(page);
    check(platform?.links.includes("System health") && !platform.links.includes("Knowledge"), "operator: platform sidebar swaps to platform items");
    check(platform?.current.length === 1 && platform.current[0] === "Users", `operator: one current platform item (${platform?.current.join(", ")})`);
  }
  await page.context().close();
}

console.log("\nLegacy redirects");
for (const [from, to] of [
  ["/app?action=new", "/chat?action=new"],
  ["/library", "/knowledge/personal"],
  ["/workspace-control", "/manage/overview"],
  ["/workspace-control/ingestion?tab=runs", "/manage/sources?tab=history"],
  ["/workspace-control/ingestion?tab=schedules", "/manage/sources?tab=sources"],
  ["/workspace-control/access?tab=roles", "/manage/access?tab=roles"],
  ["/workspace-control/experience", "/manage/assistant"],
  ["/workspace-control/platform/integrations", "/platform/connectors"],
  ["/workspace-control/platform/system", "/platform/health"],
]) {
  const response = await fetch(`${BASE}${from}`, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  check(response.status === 308 && location.replace(BASE, "") === to, `${from} → ${location.replace(BASE, "") || response.status}`);
}

console.log("\nPage tabs leave the sidebar alone");
{
  const page = await pageFor("admin");
  let tested = 0;
  for (const path of ["/manage/access", "/manage/sources", "/manage/activity"]) {
    await visit(page, path);
    const tabs = page.locator("[role='tab']");
    const count = await tabs.count();
    if (count < 2) continue;
    tested += 1;
    const before = await sidebar(page);
    for (let i = 0; i < count; i += 1) {
      const label = (await tabs.nth(i).textContent())?.trim().replace(/\s+/g, " ");
      await tabs.nth(i).click();
      await page.waitForTimeout(400);
      const after = await sidebar(page);
      check(after.html === before.html && after.width === before.width && after.scrollTop === before.scrollTop, `${path} "${label}" leaves the sidebar unchanged`);
      const role = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      check(role === "tab", `${path} "${label}" keeps focus on the tab`);
    }
  }
  check(tested > 0, `tabbed pages checked: ${tested}`);

  console.log("\nLayers close on Escape and return focus");
  await visit(page, "/knowledge");
  const trigger = page.locator("nav.side .ws-switch");
  await trigger.click();
  await page.waitForSelector("[role='menu']");
  await page.keyboard.press("Escape");
  check(await trigger.evaluate((el) => el === document.activeElement), "workspace menu: Esc returns focus to its trigger");
  const searchItem = page.locator('nav.side [data-tour="search"]');
  await searchItem.click();
  await page.waitForSelector("[role='dialog'][aria-label='Search']");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check(await searchItem.evaluate((el) => el === document.activeElement), "palette: Esc returns focus to Search");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  check(await page.locator("[role='dialog'][aria-label='Search']").isVisible(), "⌘K / Ctrl+K opens the palette");
  await page.keyboard.press("Escape");
  await page.context().close();
}

console.log(`\n=== ${failures === 0 ? "navigation contract holds" : `${failures} violation(s)`} ===`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);

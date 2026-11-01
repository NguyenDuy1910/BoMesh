/**
 * WCAG AA contrast audit.
 *
 *   node scripts/contrast.mjs
 *     Token audit (default; no server needed). Loads src/app/tokens.css into a
 *     blank Chromium page and, for light and dark × every accent, resolves each
 *     text/background token pair the product paints — text on canvas, base,
 *     raised, subtle and inset; accent text; on-accent on accent; status text
 *     on status backgrounds; evidence text on evidence backgrounds; inverse,
 *     danger, file-type and avatar labels — composites translucent layers onto
 *     the surface they sit on, and fails below 4.5:1.
 *
 *   node scripts/contrast.mjs [--theme=light|dark] [--accent=<accent>] <path ...>
 *     Page audit against the running app (BASE_URL, default localhost:3000):
 *     walks every visible text node, resolves its colour against the first
 *     opaque background behind it, and reports anything under AA for its size.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")),
);
const paths = args.filter((a) => !a.startsWith("--"));

const ACCENTS = ["indigo", "teal", "ocean", "plum", "graphite"];
const THEMES = ["light", "dark"];
const AA = 4.5;

/**
 * [label, foreground token, background token, surface the background sits on].
 * The surface matters only when the background is translucent (dark status
 * and evidence fills); it is composited first.
 */
const surfaces = ["--surface-canvas", "--surface-base", "--surface-raised", "--surface-subtle", "--surface-inset", "--surface-hover"];
const PAIRS = [
  ...["--text-primary", "--text-secondary", "--text-tertiary"].flatMap((fg) =>
    surfaces.map((bg) => [`${fg} on ${bg}`, fg, bg, bg]),
  ),
  ["--text-accent on --surface-base", "--text-accent", "--surface-base", "--surface-base"],
  ["--text-accent on --surface-canvas", "--text-accent", "--surface-canvas", "--surface-canvas"],
  ["--text-accent on --accent-soft", "--text-accent", "--accent-soft", "--surface-base"],
  ["--text-accent on --accent-soft-hover", "--text-accent", "--accent-soft-hover", "--surface-base"],
  ["--text-primary on --surface-selected", "--text-primary", "--surface-selected", "--surface-base"],
  ["--text-on-accent on --accent-primary", "--text-on-accent", "--accent-primary", "--surface-base"],
  ["--text-on-danger on --danger-solid", "--text-on-danger", "--danger-solid", "--surface-base"],
  ["--text-inverse on --surface-inverse", "--text-inverse", "--surface-inverse", "--surface-base"],
  ...["success", "warning", "danger", "info", "neutral"].flatMap((tone) => [
    [`--status-${tone}-text on --status-${tone}-bg`, `--status-${tone}-text`, `--status-${tone}-bg`, "--surface-base"],
    [`--status-${tone}-text on --surface-base`, `--status-${tone}-text`, "--surface-base", "--surface-base"],
    [`--status-${tone}-text on --surface-canvas`, `--status-${tone}-text`, "--surface-canvas", "--surface-canvas"],
  ]),
  ...["success", "danger", "info"].map((tone) => [
    `--status-${tone}-on-inverse on --surface-inverse`,
    `--status-${tone}-on-inverse`,
    "--surface-inverse",
    "--surface-base",
  ]),
  ["--evidence-text on --evidence-bg", "--evidence-text", "--evidence-bg", "--surface-base"],
  ["--evidence-text on --evidence-strong", "--evidence-text", "--evidence-strong", "--surface-base"],
  ["--text-primary on --evidence-strong", "--text-primary", "--evidence-strong", "--surface-base"],
  ["--code-text on --code-surface", "--code-text", "--code-surface", "--surface-base"],
  ["--code-muted on --code-surface", "--code-muted", "--code-surface", "--surface-base"],
  ...["pdf", "doc", "sheet", "slides", "archive", "web", "image", "text"].map((kind) => [
    `--file-label on --file-${kind}`,
    "--file-label",
    `--file-${kind}`,
    "--surface-base",
  ]),
  ...Array.from({ length: 10 }, (_, i) => [
    `white initials (--file-label) on --avatar-${i + 1}`,
    "--file-label",
    `--avatar-${i + 1}`,
    "--surface-base",
  ]),
];

async function tokenAudit() {
  const tokensPath = join(dirname(fileURLToPath(import.meta.url)), "../src/app/tokens.css");
  const css = readFileSync(tokensPath, "utf8");
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`);

  let failures = 0;
  let checked = 0;
  for (const theme of THEMES) {
    for (const accent of ACCENTS) {
      const results = await page.evaluate(
        ({ theme, accent, pairs }) => {
          const root = document.documentElement;
          root.dataset.theme = theme;
          root.dataset.accent = accent;
          const style = getComputedStyle(root);
          // Canvas parses every CSS colour syntax Chromium computes
          // (rgb, slash alpha, color(srgb …), color-mix) and composites
          // translucent layers exactly as the page would.
          const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
          const paint = (...layers) => {
            ctx.clearRect(0, 0, 1, 1);
            for (const layer of layers) {
              ctx.fillStyle = "#000";
              ctx.fillStyle = layer;
              ctx.fillRect(0, 0, 1, 1);
            }
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b];
          };
          const value = (token) => {
            const raw = style.getPropertyValue(token).trim();
            if (!raw) throw new Error(`${token} is not defined for ${theme}/${accent}`);
            // Resolve var()/color-mix() through a real property.
            const probe = document.createElement("i");
            probe.style.color = raw;
            document.body.append(probe);
            const resolved = getComputedStyle(probe).color;
            probe.remove();
            return resolved;
          };
          const lin = (v) => {
            const s = v / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          };
          const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
          return pairs.map(([label, fg, bg, under]) => {
            const back = paint(value(under), value(bg));
            const front = paint(value(under), value(bg), value(fg));
            const [l1, l2] = [lum(front), lum(back)];
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            return { label, ratio: Math.round(ratio * 100) / 100 };
          });
        },
        { theme, accent, pairs: PAIRS },
      );
      const bad = results.filter((r) => r.ratio < AA);
      checked += results.length;
      failures += bad.length;
      const lowest = results.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      console.log(
        `${theme.padEnd(5)} ${accent.padEnd(8)}  ${results.length} pairs, ${bad.length} below ${AA}:1` +
          `  (lowest ${lowest.ratio}:1 — ${lowest.label})`,
      );
      for (const b of bad) console.log(`    ${String(b.ratio).padStart(5)}:1  ${b.label}`);
    }
  }
  await browser.close();
  console.log(`\n=== tokens: ${checked} pairs checked, ${failures} below AA ===`);
  if (failures > 0) process.exitCode = 1;
}

async function pageAudit() {
  const BASE = process.env.BASE_URL ?? "http://localhost:3000";
  const theme = flags.theme ?? "light";
  const accent = flags.accent ?? "indigo";
  const session = {
    access_token: "local-verification-token",
    token_type: "bearer",
    session_id: "local-verification-session",
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    user_id: "00000000-0000-0000-0000-000000000002",
    email: "duy.nguyen@enterprise.ai",
    display_name: "Duy Nguyen",
    active_workspace_id: "00000000-0000-0000-0000-000000000001",
    permissions: ["tenant.read", "tenant.manage", "knowledge.read", "user.manage", "role.manage", "group.manage", "audit.read"],
    workspaces: [
      { id: "00000000-0000-0000-0000-000000000001", code: "vikki", name: "Vikki Bank", role_codes: ["owner"], permissions: ["tenant.read", "tenant.manage"] },
    ],
    platform_permissions: ["platform.tenant.read", "platform.user.read", "platform.audit.read", "platform.health.read"],
  };
  const workspaces = {
    total: 126,
    items: [
      { id: "w1", name: "Galaxy FinX", code: "galaxy-finx", status: "active", created_at: "2025-03-04T09:12:00Z", member_count: 248, connection_count: 6, owner: { display_name: "Duy Nguyen" } },
      { id: "w3", name: "Operations Lab", code: "ops-lab", status: "pending", created_at: "2025-06-30T15:45:00Z", member_count: 36, connection_count: 3, owner: { display_name: "Minh Pham" } },
      { id: "w4", name: "External Pilot", code: "external-pilot", status: "inactive", created_at: "2025-07-14T08:20:00Z", member_count: 12, connection_count: 2, owner: { display_name: "Lan Nguyen" } },
      { id: "w6", name: "Legacy Workspace", code: "legacy", status: "archived", created_at: "2024-11-19T13:30:00Z", member_count: 9, connection_count: 1, owner: { display_name: "System Admin" } },
    ],
  };
  const users = {
    total: 24,
    items: [
      { id: "u1", display_name: "Duy Nguyen", email: "duy@enterprise.ai", status: true, created_at: "2025-01-10T09:00:00Z", membership: { role: { code: "owner", display_name: "Owner" } } },
      { id: "u5", display_name: "Vendor Support", email: "vendor@partner.io", status: false, created_at: "2025-05-30T09:00:00Z", membership: { role: { code: "member", display_name: "Member" } } },
    ],
  };
  const overview = {
    tenant: { id: "t1", code: "vikki", name: "Vikki Bank", status: "active", updated_at: "2026-09-01T00:00:00Z" },
    metrics: { active_users: 24, active_roles: 4, active_groups: 3, active_integration_connections: 6, items: 38 },
    attention: { pending_access_requests: 2 },
    recent_activity: [],
  };

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1560, height: 960 } });
  await context.addInitScript(
    ([s, appearance]) => {
      sessionStorage.setItem("bomesh.auth.session", s);
      localStorage.setItem("bomesh.appearance", appearance);
    },
    [JSON.stringify(session), JSON.stringify({ theme, accent })],
  );
  await context.route(/\/api\/v1\/(?!knowledge(?:\/|$)|agent(?:\/|$))/, async (route) => {
    const url = route.request().url();
    const body = url.includes("/platform/workspaces")
      ? workspaces
      : url.includes("/overview")
        ? overview
        : url.includes("/users")
          ? users
          : { items: [], total: 0 };
    await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
  });

  const page = await context.newPage();
  let failures = 0;
  let checked = 0;

  for (const path of paths) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const parse = (c) => {
        const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
        return { r: m[0] ?? 0, g: m[1] ?? 0, b: m[2] ?? 0, a: m[3] ?? 1 };
      };
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const over = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });

      function backdrop(el) {
        let acc = null;
        let node = el;
        while (node && node !== document.documentElement) {
          const bg = parse(getComputedStyle(node).backgroundColor);
          if (bg.a > 0) acc = acc ? over(acc, bg) : bg;
          if (acc && acc.a >= 0.999) return acc;
          node = node.parentElement;
        }
        const root = parse(getComputedStyle(document.body).backgroundColor);
        return acc ? over(acc, root.a > 0 ? root : { r: 255, g: 255, b: 255, a: 1 })
                   : root.a > 0 ? root : { r: 255, g: 255, b: 255, a: 1 };
      }

      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      while (walker.nextNode()) {
        const text = walker.currentNode.textContent?.trim();
        if (!text || text.length < 2) continue;
        const el = walker.currentNode.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.3) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;

        const size = parseFloat(cs.fontSize);
        const weight = Number(cs.fontWeight) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const fg = parse(cs.color);
        const bg = backdrop(el);
        const solid = fg.a < 1 ? over(fg, bg) : fg;
        const l1 = lum(solid);
        const l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const threshold = large ? 3 : 4.5;
        out.push({
          text: text.slice(0, 42),
          ratio: Math.round(ratio * 100) / 100,
          threshold,
          color: cs.color,
          size,
          pass: ratio >= threshold,
        });
      }
      return out;
    });

    checked += result.length;
    const bad = result.filter((r) => !r.pass);
    failures += bad.length;
    console.log(`\n${path}  —  ${result.length} text elements, ${bad.length} below AA`);
    for (const b of bad.slice(0, 14)) {
      console.log(`  ${String(b.ratio).padStart(5)}:1 (needs ${b.threshold})  ${b.size}px  ${b.color}  "${b.text}"`);
    }
  }

  console.log(`\n=== ${theme}/${accent}: ${checked} checked, ${failures} below AA ===`);
  await browser.close();
  if (failures > 0) process.exitCode = 1;
}

await (paths.length > 0 ? pageAudit() : tokenAudit());

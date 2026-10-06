import assert from "node:assert/strict";
import test from "node:test";

import {
  APPEARANCE_CHANGE_EVENT,
  APPEARANCE_STORAGE_KEY,
  WORKSPACE_ACCENT_KEY_PREFIX,
  appearanceBootScript,
  parseAppearance,
} from "../src/lib/appearance.ts";

/**
 * Runs the inline boot script against a minimal browser stand-in and returns
 * the attributes it put on <html>, plus hooks to fire the events it listens to.
 */
function boot(stored: string | null, prefersDark = false, { workspaceId = "", pathname = "/chat" } = {}) {
  const storage = new Map<string, string>();
  if (stored !== null) storage.set(APPEARANCE_STORAGE_KEY, stored);
  const listeners = new Map<string, () => void>();
  const media = { matches: prefersDark, addEventListener: (_: string, fn: () => void) => listeners.set("media", fn) };
  const dataset: Record<string, string> = {};
  const location = { pathname };
  const session = workspaceId ? JSON.stringify({ active_workspace_id: workspaceId }) : null;
  const window = {
    matchMedia: () => media,
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    location,
    sessionStorage: { getItem: (key: string) => (key === "bomesh.auth.session" ? session : null) },
  };
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null };
  new Function("window", "document", "localStorage", appearanceBootScript)(
    window,
    { documentElement: { dataset } },
    localStorage,
  );
  return { dataset, storage, media, location, fire: (type: string) => listeners.get(type)?.() };
}

const cases: (string | null)[] = [
  null,
  "not json",
  "null",
  JSON.stringify({ theme: "dark", accent: "plum", background: "mesh", density: "compact", reduceMotion: true }),
  JSON.stringify({ theme: "sepia", accent: "rose", background: "soft", density: 3, reduceMotion: "yes" }),
];

test("the boot script applies exactly what parseAppearance reads", () => {
  for (const stored of cases) {
    const parsed = parseAppearance(stored);
    const { dataset } = boot(stored);
    assert.deepEqual(
      dataset,
      {
        theme: parsed.theme === "system" ? "light" : parsed.theme,
        accent: parsed.accent === "workspace" ? "indigo" : parsed.accent,
        bg: parsed.background,
        density: parsed.density,
        reducedMotion: String(parsed.reduceMotion),
      },
      `stored: ${stored}`,
    );
  }
});

test("unknown or missing values fall back to light-system, indigo, plain, comfortable", () => {
  assert.deepEqual(boot(null).dataset, {
    theme: "light",
    accent: "indigo",
    bg: "plain",
    density: "comfortable",
    reducedMotion: "false",
  });
});

test("system theme follows the OS and re-applies on change and on save", () => {
  const page = boot(JSON.stringify({ theme: "system" }), true);
  assert.equal(page.dataset.theme, "dark");
  page.media.matches = false;
  page.fire("media");
  assert.equal(page.dataset.theme, "light");
  page.storage.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ theme: "dark", accent: "teal" }));
  page.fire(APPEARANCE_CHANGE_EVENT);
  assert.equal(page.dataset.theme, "dark");
  assert.equal(page.dataset.accent, "teal");
});

test("the workspace brand accent follows the active workspace, but never the platform console", () => {
  const page = boot(JSON.stringify({ accent: "workspace" }), false, { workspaceId: "w1" });
  assert.equal(page.dataset.accent, "indigo", "no cached brand yet");
  page.storage.set(`${WORKSPACE_ACCENT_KEY_PREFIX}w1`, "teal");
  page.fire(APPEARANCE_CHANGE_EVENT);
  assert.equal(page.dataset.accent, "teal");
  page.location.pathname = "/platform/workspaces";
  page.fire(APPEARANCE_CHANGE_EVENT);
  assert.equal(page.dataset.accent, "indigo");
  // A personal accent wins over the brand.
  page.location.pathname = "/chat";
  page.storage.set(APPEARANCE_STORAGE_KEY, JSON.stringify({ accent: "plum" }));
  page.fire(APPEARANCE_CHANGE_EVENT);
  assert.equal(page.dataset.accent, "plum");
});

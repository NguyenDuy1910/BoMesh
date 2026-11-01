/**
 * Appearance preferences: colour theme, accent, canvas background, density
 * and reduced motion.
 *
 * They are device-wide (one browser renders every account and the sign-in
 * page the same way) and applied as attributes on <html>, which is all
 * tokens.css reads:
 *
 *   data-theme          light | dark   (resolved; "system" follows the OS)
 *   data-accent         indigo | teal | ocean | plum | graphite
 *                       (the "workspace" preference resolves to the active
 *                       workspace's brand accent, cached by the shell)
 *   data-bg             plain | soft | mesh
 *   data-density        comfortable | compact
 *   data-reduced-motion true | false
 *
 * `appearanceBootScript` is the only code that writes those attributes. It
 * runs before first paint (app/layout.tsx) and keeps listening, so a change
 * saved by `useAccountPreferences`, a change in another tab, or an OS theme
 * switch re-applies without any component being mounted.
 *
 * Deliberately free of "use client": the root layout (a server component)
 * reads the boot script, and the account preferences UI reads the options.
 */

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export const ACCENTS = ["indigo", "teal", "ocean", "plum", "graphite"] as const;
/** "workspace" follows the active workspace's brand accent (indigo in the platform console). */
export const ACCENT_PREFERENCES = ["workspace", ...ACCENTS] as const;
export const BACKGROUNDS = ["plain", "soft", "mesh"] as const;
export const DENSITIES = ["comfortable", "compact"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type Accent = (typeof ACCENTS)[number];
export type AccentPreference = (typeof ACCENT_PREFERENCES)[number];
export type Background = (typeof BACKGROUNDS)[number];
export type Density = (typeof DENSITIES)[number];

export interface AppearancePreferences {
  theme: ThemePreference;
  accent: AccentPreference;
  background: Background;
  density: Density;
  reduceMotion: boolean;
}

export interface AppearanceOption<T extends string> {
  value: T;
  label: string;
}

export const THEME_OPTIONS: readonly AppearanceOption<ThemePreference>[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match system" },
];

/** `swatch` is a CSS colour for a picker chip; it does not change with the theme. */
export const ACCENT_OPTIONS: readonly (AppearanceOption<Accent> & { swatch: string })[] = [
  { value: "indigo", label: "Indigo", swatch: "var(--accent-swatch-indigo)" },
  { value: "teal", label: "Teal", swatch: "var(--accent-swatch-teal)" },
  { value: "ocean", label: "Ocean", swatch: "var(--accent-swatch-ocean)" },
  { value: "plum", label: "Plum", swatch: "var(--accent-swatch-plum)" },
  { value: "graphite", label: "Graphite", swatch: "var(--accent-swatch-graphite)" },
];

export const BACKGROUND_OPTIONS: readonly AppearanceOption<Background>[] = [
  { value: "plain", label: "Plain" },
  { value: "soft", label: "Soft glow" },
  { value: "mesh", label: "Mesh" },
];

export const DENSITY_OPTIONS: readonly AppearanceOption<Density>[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "system",
  accent: "workspace",
  background: "plain",
  density: "comfortable",
  reduceMotion: false,
};

export const APPEARANCE_STORAGE_KEY = "bomesh.appearance";
/** Dispatched on `window` after the stored appearance changes in this tab. */
export const APPEARANCE_CHANGE_EVENT = "bomesh-appearance";
/** `<prefix><workspace id>` holds that workspace's brand accent, written by the shell. */
export const WORKSPACE_ACCENT_KEY_PREFIX = "bomesh.workspace-accent.";
/** Where the signed-in session (and so the active workspace id) is kept. */
const AUTH_SESSION_KEY = "bomesh.auth.session";

/**
 * Cache a workspace's brand accent for the boot script and re-apply. Called by
 * the shell after the branding read resolves; the boot script stays the only
 * writer of `data-accent`.
 */
export function rememberWorkspaceAccent(workspaceId: string, accent: string): void {
  if (typeof window === "undefined" || !ACCENTS.includes(accent as Accent)) return;
  try {
    if (window.localStorage.getItem(WORKSPACE_ACCENT_KEY_PREFIX + workspaceId) === accent) return;
    window.localStorage.setItem(WORKSPACE_ACCENT_KEY_PREFIX + workspaceId, accent);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(APPEARANCE_CHANGE_EVENT));
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Normalises whatever is stored; unknown or missing values fall back to defaults. */
export function parseAppearance(serialized: string | null): AppearancePreferences {
  let stored: Partial<Record<keyof AppearancePreferences, unknown>> = {};
  try {
    const value: unknown = JSON.parse(serialized ?? "{}");
    if (value && typeof value === "object") stored = value as typeof stored;
  } catch {
    // A corrupt entry is ignored; the defaults apply.
  }
  return {
    theme: oneOf(THEME_PREFERENCES, stored.theme, DEFAULT_APPEARANCE.theme),
    accent: oneOf(ACCENT_PREFERENCES, stored.accent, DEFAULT_APPEARANCE.accent),
    background: oneOf(BACKGROUNDS, stored.background, DEFAULT_APPEARANCE.background),
    density: oneOf(DENSITIES, stored.density, DEFAULT_APPEARANCE.density),
    reduceMotion: typeof stored.reduceMotion === "boolean" ? stored.reduceMotion : DEFAULT_APPEARANCE.reduceMotion,
  };
}

/**
 * Inline, dependency-free script for `<Script strategy="beforeInteractive">`.
 * Mirrors `parseAppearance` with the same option lists, injected below.
 */
export const appearanceBootScript = `(function(){
var K=${JSON.stringify(APPEARANCE_STORAGE_KEY)},E=${JSON.stringify(APPEARANCE_CHANGE_EVENT)},W=${JSON.stringify(WORKSPACE_ACCENT_KEY_PREFIX)},S=${JSON.stringify(AUTH_SESSION_KEY)};
var A=${JSON.stringify(ACCENTS)};
var O={theme:${JSON.stringify(THEME_PREFERENCES)},accent:${JSON.stringify(ACCENT_PREFERENCES)},background:${JSON.stringify(BACKGROUNDS)},density:${JSON.stringify(DENSITIES)}};
var D=${JSON.stringify(DEFAULT_APPEARANCE)};
var root=document.documentElement,dark=window.matchMedia("(prefers-color-scheme: dark)");
function pick(s,k){return O[k].indexOf(s[k])>=0?s[k]:D[k]}
function brand(){try{
if(window.location.pathname.indexOf("/platform")===0)return A[0];
var id=(JSON.parse(window.sessionStorage.getItem(S)||"null")||{}).active_workspace_id;
var a=id?localStorage.getItem(W+id):null;return A.indexOf(a)>=0?a:A[0];
}catch(e){return A[0]}}
function apply(){
var s={};try{s=JSON.parse(localStorage.getItem(K)||"{}")||{}}catch(e){}
var t=pick(s,"theme"),a=pick(s,"accent");
root.dataset.theme=t==="system"?(dark.matches?"dark":"light"):t;
root.dataset.accent=a==="workspace"?brand():a;
root.dataset.bg=pick(s,"background");
root.dataset.density=pick(s,"density");
root.dataset.reducedMotion=s.reduceMotion===true?"true":"false";
}
apply();
window.addEventListener(E,apply);
window.addEventListener("storage",function(e){if(e.key===K||e.key===null)apply()});
dark.addEventListener("change",apply);
})();`;

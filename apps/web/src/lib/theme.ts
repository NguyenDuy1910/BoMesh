/**
 * Appearance — one personal theme for the whole interface, with the HeroUI
 * Theme Builder's dimensions: mode (light | dark | system), accent colour,
 * base (how much the accent tints neutrals), radius and font. Named themes
 * bundle these; any change after picking one makes a custom theme.
 * `applyTheme()` writes the CSS variables `tokens.css` derives every colour
 * from. Status and evidence colours stay fixed: they carry meaning, not brand.
 * Ported from the UX preview (`scripts/core/theme.js`).
 */

export type ThemeMode = "light" | "dark" | "system";

export interface Accent {
  id: string;
  label: string;
  /** OKLCH lightness (%), chroma, hue. */
  l: number;
  c: number;
  h: number;
  /** Text on the accent. */
  ink: "light" | "dark";
}

export interface Look {
  /** A THEMES id, or `custom`. */
  theme: string;
  /** An ACCENTS id, or `custom` (uses `hue`). */
  accent: string;
  hue: number;
  base: string;
  radius: string;
  font: string;
}

export interface NamedTheme {
  id: string;
  label: string;
  note: string;
  accent: string;
  base: string;
  radius: string;
  font: string;
}

/** Accent palette. */
export const ACCENTS: readonly Accent[] = [
  { id: "green", label: "Green", l: 62.04, c: 0.195, h: 139.21, ink: "light" },
  { id: "emerald", label: "Emerald", l: 60, c: 0.145, h: 163, ink: "light" },
  { id: "teal", label: "Teal", l: 58, c: 0.105, h: 186, ink: "light" },
  { id: "cyan", label: "Cyan", l: 60, c: 0.115, h: 215, ink: "light" },
  { id: "sky", label: "Sky", l: 62, c: 0.15, h: 238, ink: "light" },
  { id: "blue", label: "Blue", l: 62.04, c: 0.195, h: 253.83, ink: "light" },
  { id: "indigo", label: "Indigo", l: 54, c: 0.2, h: 275, ink: "light" },
  { id: "violet", label: "Violet", l: 56, c: 0.235, h: 292, ink: "light" },
  { id: "purple", label: "Purple", l: 55, c: 0.245, h: 305, ink: "light" },
  { id: "fuchsia", label: "Fuchsia", l: 59, c: 0.25, h: 322, ink: "light" },
  { id: "pink", label: "Pink", l: 62, c: 0.215, h: 355, ink: "light" },
  { id: "rose", label: "Rose", l: 61, c: 0.215, h: 15, ink: "light" },
  { id: "red", label: "Red", l: 58, c: 0.215, h: 27, ink: "light" },
  { id: "orange", label: "Orange", l: 65, c: 0.19, h: 45, ink: "light" },
  { id: "amber", label: "Amber", l: 78, c: 0.16, h: 75, ink: "dark" },
  { id: "yellow", label: "Yellow", l: 86, c: 0.17, h: 95, ink: "dark" },
  { id: "lime", label: "Lime", l: 79, c: 0.2, h: 130, ink: "dark" },
  { id: "graphite", label: "Graphite", l: 26, c: 0.012, h: 286, ink: "light" },
];

/** Base: multiplier on the export's neutral chroma (Theme Builder "base" 0.02 = 1). */
export const BASES = [
  { id: "none", label: "Neutral", tint: 0 },
  { id: "subtle", label: "Subtle", tint: 0.5 },
  { id: "default", label: "Tinted", tint: 1 },
  { id: "rich", label: "Rich", tint: 1.8 },
] as const;

/** Radius (HeroUI --radius in rem; form fields get 1.5×). */
export const RADII = [
  { id: "none", label: "None", rem: 0 },
  { id: "sm", label: "Small", rem: 0.25 },
  { id: "md", label: "Medium", rem: 0.5 },
  { id: "lg", label: "Large", rem: 0.75 },
  { id: "xl", label: "Extra large", rem: 1 },
] as const;

/** Fonts: CSS stack and the Google Fonts family loaded on demand (system fallback offline). */
export const FONTS = [
  { id: "google", label: "Google Sans", stack: '"Google Sans Flex", "Google Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', google: null },
  { id: "inter", label: "Inter", stack: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', google: "Inter:wght@400..700" },
  { id: "vietnam", label: "Be Vietnam Pro", stack: '"Be Vietnam Pro", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', google: "Be+Vietnam+Pro:wght@400;500;600;700" },
  { id: "plex", label: "IBM Plex Sans", stack: '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', google: "IBM+Plex+Sans:wght@400;500;600;700" },
  { id: "manrope", label: "Manrope", stack: '"Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', google: "Manrope:wght@400..700" },
  { id: "system", label: "System", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', google: null },
] as const;

/** Named themes: complete looks people can pick in one click. */
export const THEMES: readonly NamedTheme[] = [
  { id: "bomesh", label: "BoMesh", note: "HeroUI CRM · default", accent: "green", base: "default", radius: "md", font: "google" },
  { id: "heroui", label: "HeroUI", note: "Blue on neutral gray", accent: "blue", base: "none", radius: "md", font: "inter" },
  { id: "ocean", label: "Ocean", note: "Calm cyan", accent: "cyan", base: "subtle", radius: "lg", font: "inter" },
  { id: "sky", label: "Sky", note: "Bright and airy", accent: "sky", base: "subtle", radius: "md", font: "google" },
  { id: "forest", label: "Forest", note: "Deep emerald", accent: "emerald", base: "rich", radius: "md", font: "google" },
  { id: "teal", label: "Lagoon", note: "Soft teal", accent: "teal", base: "default", radius: "md", font: "vietnam" },
  { id: "midnight", label: "Midnight", note: "Indigo, great in dark mode", accent: "indigo", base: "subtle", radius: "md", font: "plex" },
  { id: "lavender", label: "Lavender", note: "Violet, rounded", accent: "violet", base: "default", radius: "lg", font: "manrope" },
  { id: "plum", label: "Plum", note: "Rich purple", accent: "purple", base: "rich", radius: "lg", font: "manrope" },
  { id: "orchid", label: "Orchid", note: "Fuchsia", accent: "fuchsia", base: "subtle", radius: "xl", font: "inter" },
  { id: "sakura", label: "Sakura", note: "Pink, very round", accent: "pink", base: "default", radius: "xl", font: "vietnam" },
  { id: "rose", label: "Rose", note: "Warm rose", accent: "rose", base: "subtle", radius: "lg", font: "manrope" },
  { id: "crimson", label: "Crimson", note: "Sharp red", accent: "red", base: "none", radius: "sm", font: "plex" },
  { id: "sunset", label: "Sunset", note: "Orange", accent: "orange", base: "default", radius: "lg", font: "google" },
  { id: "amber", label: "Amber", note: "Warm and golden", accent: "amber", base: "rich", radius: "md", font: "vietnam" },
  { id: "lemon", label: "Lemon", note: "Yellow with dark text", accent: "yellow", base: "subtle", radius: "md", font: "inter" },
  { id: "lime", label: "Lime", note: "Fresh lime", accent: "lime", base: "subtle", radius: "sm", font: "inter" },
  { id: "graphite", label: "Graphite", note: "Monochrome", accent: "graphite", base: "none", radius: "sm", font: "inter" },
];

export const DEFAULT_LOOK: Look = { theme: "bomesh", accent: "green", hue: 200, base: "default", radius: "md", font: "google" };
export const DEFAULT_MODE: ThemeMode = "light";

export const MODE_LABEL: Record<ThemeMode, string> = { light: "Light", dark: "Dark", system: "System" };

/* ── Pure colour helpers ── */

/** The resolved accent; `custom` uses the look's hue at a balanced lightness and chroma. */
export function accentOf(look: Look): Accent {
  if (look.accent === "custom") return { id: "custom", label: "Custom", l: 60, c: 0.17, h: Number(look.hue) || 0, ink: "light" };
  return ACCENTS.find((a) => a.id === look.accent) ?? ACCENTS[0];
}

const isMono = (a: Accent) => a.c < 0.03;

/** Per-mode accent: deep accents get lighter in dark mode; graphite flips to near-white with dark ink. */
export function accentFor(a: Accent, dark: boolean): { l: number; ink: "light" | "dark" } {
  if (!dark) return { l: a.l, ink: a.ink };
  if (isMono(a)) return { l: 92, ink: "dark" };
  return { l: Math.max(a.l, 64), ink: a.ink };
}

export const oklch = (l: number, c: number, h: number) =>
  `oklch(${l}% ${Math.round(c * 10000) / 10000} ${Math.round(h * 100) / 100})`;

/** CSS colour of an accent in a mode (swatches, previews). */
export function accentColor(look: Look, dark: boolean): string {
  const a = accentOf(look);
  const m = accentFor(a, dark);
  return oklch(m.l, a.c, a.h);
}

/** The same colour as sRGB hex (colour pickers that take hex values). */
export function accentHex(look: Look, dark: boolean): string {
  const a = accentOf(look);
  const m = accentFor(a, dark);
  return oklchToHex(m.l, a.c, a.h);
}

export const themeById = (id: string) => THEMES.find((t) => t.id === id);
export const themeLabel = (look: Look) => themeById(look.theme)?.label ?? "Custom";
export const fontById = (id: string) => FONTS.find((f) => f.id === id) ?? FONTS[0];

/** Keep a stored look only if every part is still known. */
export function validLook(l: Partial<Look> | null | undefined): l is Look {
  return (
    !!l &&
    (l.accent === "custom" || ACCENTS.some((a) => a.id === l.accent)) &&
    BASES.some((b) => b.id === l.base) &&
    RADII.some((r) => r.id === l.radius) &&
    FONTS.some((f) => f.id === l.font)
  );
}

/** Colours to draw a theme's mini preview without touching the live variables. */
export function themePreview(t: Partial<Look>, dark: boolean) {
  const look: Look = { ...DEFAULT_LOOK, ...t };
  const a = accentOf(look);
  const m = accentFor(a, dark);
  const tint = (BASES.find((b) => b.id === look.base) ?? BASES[2]).tint;
  const hue = isMono(a) ? 286 : a.h;
  return {
    bg: oklch(dark ? 12 : 97.02, 0.02 * tint, hue),
    surface: oklch(dark ? 21.03 : 100, (dark ? 0.04 : 0.01) * tint, hue),
    line: oklch(dark ? 30 : 90, 0.02 * tint, hue),
    text: oklch(dark ? 99.11 : 21.03, 0.02 * tint, hue),
    muted: oklch(dark ? 70.5 : 55.17, 0.04 * tint, hue),
    accent: oklch(m.l, a.c, a.h),
    ink: m.ink === "dark" ? "oklch(21.03% 0.0059 285.89)" : "oklch(99.11% 0 0)",
    radius: (RADII.find((r) => r.id === look.radius) ?? RADII[2]).rem,
    font: fontById(look.font).stack,
  };
}

/* ── Painting (shared by the pre-paint boot script and the live app) ── */

/** Registry data the self-contained painter needs. */
const PAINT_DATA = {
  accents: ACCENTS,
  bases: BASES,
  radii: RADII,
  fonts: FONTS,
};
type PaintData = typeof PAINT_DATA;

/**
 * Writes the theme into CSS variables on <html>. Self-contained (no outer
 * references) so the boot script can embed it with `Function#toString`.
 */
function paintAppearance(mode: string, look: Look, data: PaintData): void {
  const html = document.documentElement;
  const dark = mode === "dark" || (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  let a: Accent = data.accents[0];
  if (look.accent === "custom") a = { id: "custom", label: "Custom", l: 60, c: 0.17, h: Number(look.hue) || 0, ink: "light" };
  else for (const x of data.accents) if (x.id === look.accent) a = x;
  const mono = a.c < 0.03;
  let l = a.l;
  let ink = a.ink;
  if (dark) {
    if (mono) {
      l = 92;
      ink = "dark";
    } else l = Math.max(a.l, 64);
  }
  let tint: number = data.bases[2].tint;
  for (const b of data.bases) if (b.id === look.base) tint = b.tint;
  let radius: number = data.radii[2].rem;
  for (const r of data.radii) if (r.id === look.radius) radius = r.rem;
  let font: string = data.fonts[0].stack;
  for (const f of data.fonts) if (f.id === look.font) font = f.stack;
  const st = html.style;
  html.dataset.theme = dark ? "dark" : "light";
  html.style.colorScheme = dark ? "dark" : "light";
  st.setProperty("--accent-l", l + "%");
  st.setProperty("--accent-c", String(a.c));
  st.setProperty("--accent-h", String(a.h));
  st.setProperty("--accent-fg", ink === "dark" ? "var(--eclipse)" : "var(--snow)");
  // Light accents (amber, yellow, lime) need more foreground in soft text to stay readable on light canvases.
  st.setProperty("--accent-ink", dark ? "73%" : ink === "dark" ? "40%" : "70%");
  st.setProperty("--base-hue", String(mono ? 286 : a.h));
  st.setProperty("--tint", String(tint));
  st.setProperty("--radius", radius + "rem");
  st.setProperty("--field-radius", radius * 1.5 + "rem");
  st.setProperty("--font-sans", font);
}

/* ── Store (persisted on this device) ── */

export const APPEARANCE_STORAGE_KEY = "bomesh.appearance";

export interface AppearanceState {
  mode: ThemeMode;
  look: Look;
}

const DEFAULT_STATE: AppearanceState = { mode: DEFAULT_MODE, look: DEFAULT_LOOK };
let state: AppearanceState | null = null;
const listeners = new Set<() => void>();
const changeListeners = new Set<(next: AppearanceState) => void>();

function isMode(v: unknown): v is ThemeMode {
  return v === "light" || v === "dark" || v === "system";
}

function readStored(): AppearanceState | null {
  try {
    const raw = JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "null") as Partial<AppearanceState> | null;
    if (!raw) return null;
    return {
      mode: isMode(raw.mode) ? raw.mode : DEFAULT_MODE,
      look: validLook(raw.look) ? { ...DEFAULT_LOOK, ...raw.look } : DEFAULT_LOOK,
    };
  } catch {
    return null;
  }
}

/** Whether this device has an explicit appearance (else the account's saved one may apply). */
export function hasStoredAppearance(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(APPEARANCE_STORAGE_KEY) !== null;
}

export function getAppearance(): AppearanceState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  if (!state) state = readStored() ?? DEFAULT_STATE;
  return state;
}

/** Light or dark after resolving `system`. */
export function resolvedMode(mode: ThemeMode = getAppearance().mode): "light" | "dark" {
  if (mode !== "system") return mode;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const loadedFonts = new Set<string>();
/** Load a Google font the first time it's needed. */
export function ensureFont(id: string): void {
  const f = fontById(id);
  if (!f.google || loadedFonts.has(id) || document.getElementById("font-" + id)) return;
  loadedFonts.add(id);
  const link = document.createElement("link");
  link.id = "font-" + id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
  document.head.append(link);
}

/** Paint the current appearance (or a given one) onto <html>. */
export function applyTheme(next: AppearanceState = getAppearance()): void {
  paintAppearance(next.mode, next.look, PAINT_DATA);
  ensureFont(next.look.font);
}

/**
 * Replace the appearance. `origin: "user"` notifies change listeners (the
 * shell saves it to the account); `"sync"` applies a value that came from the
 * account and is not saved back.
 */
export function setAppearance(next: AppearanceState, origin: "user" | "sync" = "user"): void {
  state = next;
  window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
  applyTheme(next);
  for (const l of listeners) l();
  if (origin === "user") for (const l of changeListeners) l(next);
}

export function setMode(mode: ThemeMode): void {
  setAppearance({ ...getAppearance(), mode });
}

/** Apply a named theme. */
export function setThemePreset(id: string): void {
  const t = themeById(id);
  if (!t) return;
  const cur = getAppearance();
  setAppearance({ ...cur, look: { ...cur.look, theme: t.id, accent: t.accent, base: t.base, radius: t.radius, font: t.font } });
}

/** Change one dimension; the look stays a named theme only while it still matches one. */
export function setLook(patch: Partial<Look>): void {
  const cur = getAppearance();
  const look = { ...cur.look, ...patch };
  const match = look.accent !== "custom" && THEMES.find((t) => t.accent === look.accent && t.base === look.base && t.radius === look.radius && t.font === look.font);
  look.theme = match ? match.id : "custom";
  setAppearance({ ...cur, look });
}

/** Live hue preview while dragging the slider: paints without notifying or persisting. */
export function previewHue(hue: number): void {
  const cur = getAppearance();
  applyTheme({ ...cur, look: { ...cur.look, accent: "custom", hue } });
}

/** Restore the BoMesh default (mode is kept). */
export function resetLook(): void {
  setAppearance({ ...getAppearance(), look: DEFAULT_LOOK });
}

/** Called for user-made changes (not account sync). */
export function onAppearanceChange(fn: (next: AppearanceState) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

/** Store subscription (React: `useAppearance` in the shell). Also follows the OS scheme and other tabs. */
export function subscribeAppearance(fn: () => void): () => void {
  listeners.add(fn);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    if (getAppearance().mode !== "system") return;
    applyTheme();
    fn();
  };
  media.addEventListener("change", onScheme);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== APPEARANCE_STORAGE_KEY) return;
    state = readStored() ?? DEFAULT_STATE;
    applyTheme();
    fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    media.removeEventListener("change", onScheme);
    window.removeEventListener("storage", onStorage);
  };
}

/* ── Account sync (`users/me/preferences.appearance`) ── */

/** Contract shape of `UserAppearance` (openapi.yaml). */
export interface RemoteAppearance {
  mode?: "SYSTEM" | "LIGHT" | "DARK";
  theme?: string;
  accentColor?: string;
  backgroundTint?: string;
  cornerRadius?: "SHARP" | "DEFAULT" | "ROUNDED";
  font?: string;
}

const RADIUS_TO_REMOTE: Record<string, RemoteAppearance["cornerRadius"]> = { none: "SHARP", sm: "SHARP", md: "DEFAULT", lg: "ROUNDED", xl: "ROUNDED" };
const RADIUS_FROM_REMOTE: Record<string, string> = { SHARP: "sm", DEFAULT: "md", ROUNDED: "lg" };

/* OKLCH ↔ sRGB hex, for the contract's `accentColor`. */
function oklchToHex(lPct: number, c: number, hDeg: number): string {
  const L = lPct / 100;
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return (
    "#" +
    lin
      .map((v) => {
        const x = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
        return Math.round(Math.min(1, Math.max(0, x)) * 255)
          .toString(16)
          .padStart(2, "0");
      })
      .join("")
  ).toUpperCase();
}

function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L * 100, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** The appearance in the contract's shape (radius is coarser there). */
export function toRemoteAppearance(s: AppearanceState): RemoteAppearance {
  const a = accentOf(s.look);
  return {
    mode: s.mode === "dark" ? "DARK" : s.mode === "system" ? "SYSTEM" : "LIGHT",
    theme: s.look.theme,
    accentColor: oklchToHex(a.l, a.c, a.h),
    backgroundTint: s.look.base,
    cornerRadius: RADIUS_TO_REMOTE[s.look.radius] ?? "DEFAULT",
    font: s.look.font,
  };
}

/** The account's saved appearance, or null when it has none. */
export function fromRemoteAppearance(r: RemoteAppearance | undefined): AppearanceState | null {
  if (!r || (!r.mode && !r.theme && !r.accentColor)) return null;
  const mode: ThemeMode = r.mode === "DARK" ? "dark" : r.mode === "SYSTEM" ? "system" : "light";
  const preset = r.theme ? themeById(r.theme) : undefined;
  if (preset) {
    return { mode, look: { ...DEFAULT_LOOK, theme: preset.id, accent: preset.accent, base: preset.base, radius: preset.radius, font: preset.font } };
  }
  const look: Look = { ...DEFAULT_LOOK, theme: "custom" };
  if (r.accentColor) {
    const hex = r.accentColor.toUpperCase();
    const known = ACCENTS.find((a) => oklchToHex(a.l, a.c, a.h) === hex);
    if (known) look.accent = known.id;
    else {
      const c = hexToOklch(hex);
      if (c) {
        look.accent = "custom";
        look.hue = Math.round(c.h);
      }
    }
  }
  if (r.backgroundTint && BASES.some((b) => b.id === r.backgroundTint)) look.base = r.backgroundTint;
  if (r.cornerRadius) look.radius = RADIUS_FROM_REMOTE[r.cornerRadius] ?? look.radius;
  if (r.font && FONTS.some((f) => f.id === r.font)) look.font = r.font;
  const match = look.accent !== "custom" && THEMES.find((t) => t.accent === look.accent && t.base === look.base && t.radius === look.radius && t.font === look.font);
  if (match) look.theme = match.id;
  return { mode, look };
}

/* ── Boot script: applies the stored appearance and language before first paint ── */

/** Device key of the interface language (`src/lib/i18n.ts`); read here so the boot script can set `<html lang>`. */
export const LANGUAGE_STORAGE_KEY = "bomesh.language";

/**
 * Inline `<head>` script for the root layout. Reads the device's appearance
 * (and interface language) from localStorage and paints them before React
 * hydrates, so there is no flash of the default theme.
 */
export function appearanceBootScript(): string {
  return `(function(){try{var s=JSON.parse(localStorage.getItem(${JSON.stringify(APPEARANCE_STORAGE_KEY)})||"null")||{};var d=${JSON.stringify(DEFAULT_LOOK)};var l=s.look&&typeof s.look==="object"?s.look:{};for(var k in d)if(l[k]===undefined)l[k]=d[k];(${paintAppearance.toString()})(s.mode||${JSON.stringify(DEFAULT_MODE)},l,${JSON.stringify(PAINT_DATA)});var g=localStorage.getItem(${JSON.stringify(LANGUAGE_STORAGE_KEY)});if(g==="en"||g==="vi")document.documentElement.lang=g;}catch(e){}})();`;
}

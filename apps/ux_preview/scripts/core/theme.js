'use strict';
/* Theme — the whole interface follows one personal appearance setting, the
   same dimensions as the HeroUI Theme Builder: mode (light | dark | system),
   accent colour, base (how much the accent tints neutrals: canvas, surfaces,
   borders, text), radius and font. Named themes bundle these; any change
   after picking one makes a custom theme. applyTheme() writes the CSS
   variables tokens.css derives every colour from, so buttons, links, focus
   rings, selection, chips, charts and every neutral re-theme together.
   Status (success/warning/danger) and evidence colours stay fixed: they
   carry meaning, not brand. */

/** Accent palette: [id, label, L (%), C, H, ink on accent: 'light' | 'dark']. */
const ACCENTS = [
  ['sage', 'Sage', 54, 0.115, 156, 'light'],
  ['green', 'Green', 62.04, 0.195, 139.21, 'light'],
  ['emerald', 'Emerald', 60, 0.145, 163, 'light'],
  ['teal', 'Teal', 58, 0.105, 186, 'light'],
  ['cyan', 'Cyan', 60, 0.115, 215, 'light'],
  ['sky', 'Sky', 62, 0.15, 238, 'light'],
  ['blue', 'Blue', 62.04, 0.195, 253.83, 'light'],
  ['indigo', 'Indigo', 54, 0.2, 275, 'light'],
  ['violet', 'Violet', 56, 0.235, 292, 'light'],
  ['purple', 'Purple', 55, 0.245, 305, 'light'],
  ['fuchsia', 'Fuchsia', 59, 0.25, 322, 'light'],
  ['pink', 'Pink', 62, 0.215, 355, 'light'],
  ['rose', 'Rose', 61, 0.215, 15, 'light'],
  ['red', 'Red', 58, 0.215, 27, 'light'],
  ['orange', 'Orange', 65, 0.19, 45, 'light'],
  ['amber', 'Amber', 78, 0.16, 75, 'dark'],
  ['yellow', 'Yellow', 86, 0.17, 95, 'dark'],
  ['lime', 'Lime', 79, 0.2, 130, 'dark'],
  ['graphite', 'Graphite', 26, 0.012, 286, 'light'],
];
/** Base: multiplier on the export's neutral chroma (Theme Builder "base" 0.02 = 1). */
const BASES = [['none', 'Neutral', 0], ['subtle', 'Subtle', 0.5], ['default', 'Tinted', 1], ['rich', 'Rich', 1.8]];
/** Radius (HeroUI --radius; form fields get 1.5×). */
const RADII = [['none', 'None', 0], ['sm', 'Small', 0.25], ['md', 'Medium', 0.5], ['lg', 'Large', 0.75], ['xl', 'Extra large', 1]];
/** Fonts: [id, label, CSS stack, Google Fonts family (loaded on demand; system fallback offline)]. */
const FONTS = [
  ['google', 'Google Sans', '"Google Sans Flex", "Google Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', null],
  ['inter', 'Inter', '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', 'Inter:wght@400..700'],
  ['vietnam', 'Be Vietnam Pro', '"Be Vietnam Pro", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', 'Be+Vietnam+Pro:wght@400;500;600;700'],
  ['plex', 'IBM Plex Sans', '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', 'IBM+Plex+Sans:wght@400;500;600;700'],
  ['manrope', 'Manrope', '"Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', 'Manrope:wght@400..700'],
  ['system', 'System', 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', null],
];
/** Named themes: complete looks people can pick in one click. */
const THEMES = [
  { id: 'bomesh', label: 'BoMesh', note: 'Calm sage', accent: 'sage', base: 'subtle', radius: 'md', font: 'google' },
  { id: 'crm', label: 'Fresh green', note: 'HeroUI CRM green', accent: 'green', base: 'default', radius: 'md', font: 'google' },
  { id: 'heroui', label: 'HeroUI', note: 'Blue on neutral gray', accent: 'blue', base: 'none', radius: 'md', font: 'inter' },
  { id: 'ocean', label: 'Ocean', note: 'Calm cyan', accent: 'cyan', base: 'subtle', radius: 'lg', font: 'inter' },
  { id: 'sky', label: 'Sky', note: 'Bright and airy', accent: 'sky', base: 'subtle', radius: 'md', font: 'google' },
  { id: 'forest', label: 'Forest', note: 'Deep emerald', accent: 'emerald', base: 'rich', radius: 'md', font: 'google' },
  { id: 'teal', label: 'Lagoon', note: 'Soft teal', accent: 'teal', base: 'default', radius: 'md', font: 'vietnam' },
  { id: 'midnight', label: 'Midnight', note: 'Indigo, great in dark mode', accent: 'indigo', base: 'subtle', radius: 'md', font: 'plex' },
  { id: 'lavender', label: 'Lavender', note: 'Violet, rounded', accent: 'violet', base: 'default', radius: 'lg', font: 'manrope' },
  { id: 'plum', label: 'Plum', note: 'Rich purple', accent: 'purple', base: 'rich', radius: 'lg', font: 'manrope' },
  { id: 'orchid', label: 'Orchid', note: 'Fuchsia', accent: 'fuchsia', base: 'subtle', radius: 'xl', font: 'inter' },
  { id: 'sakura', label: 'Sakura', note: 'Pink, very round', accent: 'pink', base: 'default', radius: 'xl', font: 'vietnam' },
  { id: 'rose', label: 'Rose', note: 'Warm rose', accent: 'rose', base: 'subtle', radius: 'lg', font: 'manrope' },
  { id: 'crimson', label: 'Crimson', note: 'Sharp red', accent: 'red', base: 'none', radius: 'sm', font: 'plex' },
  { id: 'sunset', label: 'Sunset', note: 'Orange', accent: 'orange', base: 'default', radius: 'lg', font: 'google' },
  { id: 'amber', label: 'Amber', note: 'Warm and golden', accent: 'amber', base: 'rich', radius: 'md', font: 'vietnam' },
  { id: 'lemon', label: 'Lemon', note: 'Yellow with dark text', accent: 'yellow', base: 'subtle', radius: 'md', font: 'inter' },
  { id: 'lime', label: 'Lime', note: 'Fresh lime', accent: 'lime', base: 'subtle', radius: 'sm', font: 'inter' },
  { id: 'graphite', label: 'Graphite', note: 'Monochrome', accent: 'graphite', base: 'none', radius: 'sm', font: 'inter' },
];
const DEFAULT_LOOK = { theme: 'bomesh', accent: 'sage', hue: 200, base: 'subtle', radius: 'md', font: 'google' };
S.look = { ...DEFAULT_LOOK };

const themeOpt = (list, id) => list.find(x => x[0] === id);
/** The resolved accent: { id, label, l, c, h, ink } — 'custom' uses S.look.hue at a balanced lightness and chroma. */
function accentOf(look = S.look) {
  if (look.accent === 'custom') return { id: 'custom', label: 'Custom', l: 60, c: 0.17, h: +look.hue || 0, ink: 'light' };
  const a = themeOpt(ACCENTS, look.accent) || ACCENTS[0];
  return { id: a[0], label: a[1], l: a[2], c: a[3], h: a[4], ink: a[5] };
}
const isMono = a => a.c < 0.03;
/** Per-mode accent: deep accents get lighter in dark mode; graphite flips to near-white with dark ink. */
function accentFor(a, dark) {
  if (!dark) return { l: a.l, ink: a.ink };
  if (isMono(a)) return { l: 92, ink: 'dark' };
  return { l: Math.max(a.l, 64), ink: a.ink };
}
const oklch = (l, c, h) => `oklch(${l}% ${Math.round(c * 10000) / 10000} ${Math.round(h * 100) / 100})`;
/** CSS colour of an accent in the current mode (swatches, previews). */
const accentColor = (look = S.look, dark = resolvedTheme() === 'dark') => { const a = accentOf(look), m = accentFor(a, dark); return oklch(m.l, a.c, a.h); };
const themeById = id => THEMES.find(t => t.id === id);
const themeLabel = (look = S.look) => (themeById(look.theme)?.label || 'Custom');

function resolvedTheme() { return S.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : S.theme; }
/** Load a Google font the first time it's needed (works from file:// when online; falls back to the system stack). */
function ensureFont(id) {
  const f = themeOpt(FONTS, id); if (!f?.[3] || document.getElementById('font-' + id)) return;
  const link = document.createElement('link'); link.id = 'font-' + id; link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${f[3]}&display=swap`;
  document.head.append(link);
}
/** Write the theme into CSS variables on <html>; tokens.css derives every colour from them. */
function applyTheme() {
  const html = document.documentElement, dark = resolvedTheme() === 'dark';
  const a = accentOf(), m = accentFor(a, dark), st = html.style;
  const base = themeOpt(BASES, S.look.base) || BASES[2], radius = themeOpt(RADII, S.look.radius) || RADII[2], font = themeOpt(FONTS, S.look.font) || FONTS[0];
  html.dataset.theme = dark ? 'dark' : 'light';
  st.setProperty('--accent-l', m.l + '%');
  st.setProperty('--accent-c', String(a.c));
  st.setProperty('--accent-h', String(a.h));
  st.setProperty('--accent-fg', m.ink === 'dark' ? 'var(--eclipse)' : 'var(--snow)');
  // Light accents (amber, yellow, lime) need more foreground in soft text to stay readable on light canvases.
  st.setProperty('--accent-ink', dark ? '73%' : m.ink === 'dark' ? '40%' : '70%');
  st.setProperty('--base-hue', String(isMono(a) ? 286 : a.h));
  st.setProperty('--tint', String(base[2]));
  st.setProperty('--radius', radius[2] + 'rem');
  st.setProperty('--field-radius', radius[2] * 1.5 + 'rem');
  st.setProperty('--font-sans', font[2]);
  ensureFont(font[0]);
}
function setTheme(t) { S.theme = t; applyTheme(); persist(); refresh(); }
/** Apply a named theme. */
function setThemePreset(id) {
  const t = themeById(id); if (!t) return;
  Object.assign(S.look, { theme: t.id, accent: t.accent, base: t.base, radius: t.radius, font: t.font });
  applyTheme(); persist(); refresh();
}
/** Change one dimension; the look stays a named theme only while it still matches one. */
function setLook(patch) {
  Object.assign(S.look, patch);
  const match = S.look.accent !== 'custom' && THEMES.find(t => ['accent', 'base', 'radius', 'font'].every(k => t[k] === S.look[k]));
  S.look.theme = match ? match.id : 'custom';
  applyTheme(); persist(); refresh();
}
/** Restore the BoMesh default (mode is kept). */
function resetLook() { S.look = { ...DEFAULT_LOOK }; applyTheme(); persist(); refresh(); }
/** Keep a stored look only if every part is still known. */
function validLook(l) {
  return !!l && (l.accent === 'custom' || !!themeOpt(ACCENTS, l.accent)) && !!themeOpt(BASES, l.base) && !!themeOpt(RADII, l.radius) && !!themeOpt(FONTS, l.font);
}
/** Colours to draw a theme's mini preview without touching the live variables. */
function themePreview(t, dark = resolvedTheme() === 'dark') {
  const look = { ...DEFAULT_LOOK, ...t }, a = accentOf(look), m = accentFor(a, dark), tint = (themeOpt(BASES, look.base) || BASES[2])[2], hue = isMono(a) ? 286 : a.h;
  return {
    bg: oklch(dark ? 12 : 97.02, 0.02 * tint, hue),
    surface: oklch(dark ? 21.03 : 100, (dark ? 0.04 : 0.01) * tint, hue),
    line: oklch(dark ? 30 : 90, 0.02 * tint, hue),
    text: oklch(dark ? 99.11 : 21.03, 0.02 * tint, hue),
    muted: oklch(dark ? 70.5 : 55.17, 0.04 * tint, hue),
    accent: oklch(m.l, a.c, a.h),
    ink: m.ink === 'dark' ? 'oklch(21.03% 0.0059 285.89)' : 'oklch(99.11% 0 0)',
    radius: (themeOpt(RADII, look.radius) || RADII[2])[2],
    font: (themeOpt(FONTS, look.font) || FONTS[0])[2],
  };
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => S.theme === 'system' && (applyTheme(), refresh()));

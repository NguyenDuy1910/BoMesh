'use strict';
/* UI state (S), view-state buckets (ui()), and local persistence.
   Durable mock data (D) and review context survive reloads; transient
   overlays and unsaved drafts do not. */
const S = {
  persona: 'member', ws: 'ws-northwind', signedIn: true,
  theme: 'light',                 // light | dark | system (resolved on <html data-theme>)
  ui: {},                         // per-screen view state, see ui()
  modal: null, drawer: null, menu: null, palette: null, toasts: [],
  navOpen: false,                 // mobile sidebar
  collapsed: false,               // desktop sidebar hidden
  pageState: 'live',              // prototype state: live | loading | empty | error
  navLoading: false, visited: new Set(),
  cur: null, lastPath: null, crumbs: null,
  device: 'desktop', protoMin: false,
  inbox: { read: new Set(), dismissed: new Set() },
};

/** A named view-state bucket, created from `init` on first use. */
function ui(key, init = {}) { if (!S.ui[key]) S.ui[key] = clone(init); return S.ui[key]; }
function getPath(path) { return path.split('.').reduce((o, k) => o?.[k], S.ui); }
function setPath(path, val) { const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((o, k) => (o[k] ??= {}), S.ui); o[last] = val; }

/* ── Personas & permissions ── */
const me = () => PERSONAS[S.persona];
const can = p => me().perms.includes(p);
/** Workspace admin = may manage the workspace (permission-based, never persona-name based). */
const isAdmin = () => can('tenant.manage');
const isOperator = () => S.persona === 'operator';

/* ── Persistence ── */
const STORE_KEY = 'bomesh-prototype-v7';
/** Persisted collections. Keys in WS_DATA_KEYS are saved per workspace, the rest globally.
    Feature modules may push extra keys (e.g. 'pAudit'); new workspace collections go in WS_DATA_KEYS too. */
const DATA_KEYS = ['workspaces', 'pWorkspaces', 'pUsers', 'pConnectors', 'pModels', 'pServices', ...WS_DATA_KEYS];
let _persistTimer = 0;
function snapshot() {
  const pick = (src, keys) => Object.fromEntries(keys.filter(k => src[k] !== undefined).map(k => [k, src[k]]));
  const globalKeys = DATA_KEYS.filter(k => !WS_DATA_KEYS.has(k)), wsKeys = DATA_KEYS.filter(k => WS_DATA_KEYS.has(k));
  return {
    version: 7, savedAt: Date.now(),
    context: { persona: S.persona, ws: S.ws, signedIn: S.signedIn, theme: S.theme, look: S.look, lang: S.lang, collapsed: S.collapsed, protoMin: S.protoMin, manageOpen: !!S.manageOpen, read: [...S.inbox.read], dismissed: [...S.inbox.dismissed] },
    profiles: Object.fromEntries(Object.entries(PERSONAS).map(([id, p]) => [id, { name: p.name }])),
    data: { global: pick(DB.global, globalKeys), ws: Object.fromEntries(Object.entries(DB.ws).map(([id, store]) => [id, pick(store, wsKeys)])) },
  };
}
function persistNow() { clearTimeout(_persistTimer); try { localStorage.setItem(STORE_KEY, JSON.stringify(snapshot())); } catch (_) { } }
function persist() { clearTimeout(_persistTimer); _persistTimer = setTimeout(persistNow, 300); }
function hydrate() {
  let saved; try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) { return; }
  if (!saved || saved.version !== 7 || !saved.data?.global) return;
  Object.entries(saved.data.global).forEach(([k, v]) => { if (DATA_KEYS.includes(k)) DB.global[k] = v; });
  Object.entries(saved.data.ws || {}).forEach(([id, store]) => { DB.ws[id] ??= {}; Object.entries(store).forEach(([k, v]) => { if (WS_DATA_KEYS.has(k)) DB.ws[id][k] = v; }); });
  // Member workspaces are the same records as the platform list.
  D.pWorkspaces = D.pWorkspaces.map(w => { const m = D.workspaces.find(x => x.id === w.id); if (!m) return w; Object.assign(m, w); return m; });
  Object.entries(saved.profiles || {}).forEach(([id, p]) => { if (PERSONAS[id] && p?.name) PERSONAS[id].name = p.name; });
  const c = saved.context || {};
  if (PERSONAS[c.persona]) S.persona = c.persona;
  if (D.pWorkspaces.some(w => w.id === c.ws)) S.ws = c.ws;
  if (typeof c.signedIn === 'boolean') S.signedIn = c.signedIn;
  if (['light', 'dark', 'system'].includes(c.theme)) S.theme = c.theme;
  // A named theme is its bundle: a stored BoMesh look always follows the current default definition.
  if (validLook(c.look)) S.look = c.look.theme === 'bomesh' ? { ...DEFAULT_LOOK } : { ...DEFAULT_LOOK, ...c.look };
  if (UI_LANGS.some(l => l[0] === c.lang)) S.lang = c.lang;
  S.collapsed = !!c.collapsed; S.protoMin = !!c.protoMin; S.manageOpen = !!c.manageOpen;
  S.inbox.read = new Set(c.read || []); S.inbox.dismissed = new Set(c.dismissed || []);
}
function resetPrototype() {
  clearTimeout(_persistTimer);
  window.removeEventListener('beforeunload', persistNow);
  localStorage.removeItem(STORE_KEY);
  location.hash = '';
  location.reload();
}
window.addEventListener('beforeunload', persistNow);

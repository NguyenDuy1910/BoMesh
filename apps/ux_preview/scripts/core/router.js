'use strict';
/* Hash router. The route table below IS the information architecture:
   every screen, its mode (auth | workspace | platform | proto), its nav
   item, and the permission that gates it. Feature modules register the
   page renderer as P[page]. */
const P = {}, A = {}, M = {}, DR = {}, PO = {}, MENUS = {}, AFTER = {};
/** Cross-module functions (e.g. X.inboxUnread, X.openCitation). Features own their keys. */
const X = {};
const ROUTES = [];
function route(path, def) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  ROUTES.push({ path, re, keys, ...def });
}
// Signed-out and workspace selection
route('/signin', { page: 'signin', mode: 'auth', title: 'Sign in' });
route('/signup', { page: 'signup', mode: 'auth', title: 'Create account' });
route('/password-reset', { page: 'passwordReset', mode: 'auth', title: 'Reset your password' });
route('/password-reset/:token', { page: 'passwordResetToken', mode: 'auth', title: 'Choose a new password' });
route('/workspaces', { page: 'workspaces', mode: 'auth', title: 'Choose a workspace' });
// A public workspace's own address (/w/{code}): join it as a member. Works signed out (sign in or create an account, then back
// here); a private or unknown workspace answers the same way (features/auth.js).
route('/w/:code', { page: 'joinWorkspace', mode: 'auth', title: 'Join a workspace' });
// Member — Home is the knowledge-first landing in every workspace; `module` routes exist only where the workspace has that module on (core/workspace.js)
route('/home', { page: 'home', mode: 'workspace', nav: 'home', title: 'Home' });
route('/spaces', { page: 'spaces', mode: 'workspace', nav: 'spaces', title: 'Spaces', module: 'spaces', simLoad: true });
route('/space/:id', { page: 'space', mode: 'workspace', nav: 'space', title: 'Space', module: 'spaces', simLoad: true });
route('/work', { page: 'work', mode: 'workspace', nav: 'work', title: 'Work', module: 'work', simLoad: true });
route('/work/new', { page: 'workNew', mode: 'workspace', nav: 'work', title: 'New work', module: 'work' });
route('/work/:id', { page: 'workItem', mode: 'workspace', nav: 'work', title: 'Work', module: 'work', bare: true });
route('/requests', { page: 'requests', mode: 'workspace', nav: 'requests', title: 'Requests', module: 'requests', simLoad: true });
route('/requests/new', { page: 'requestNew', mode: 'workspace', nav: 'requests', title: 'New request', module: 'requests' });
route('/requests/:id', { page: 'requestItem', mode: 'workspace', nav: 'requests', title: 'Request', module: 'requests' });
// New chat (/chat) starts a conversation; an open one (/chat/:id) is marked in the sidebar's Recent list, not on New chat.
route('/chat', { page: 'chats', mode: 'workspace', nav: 'chat', title: 'New chat', bare: true });
route('/chat/:id', { page: 'chatThread', mode: 'workspace', nav: 'conversation', title: 'Conversation', bare: true });
// A share someone was sent (/s/{share id}) or an invite (/s/{token}): works signed out; opens the target or says why not (features/shares.js).
route('/s/:token', { page: 'share', mode: 'auth', title: 'Shared link' });
// Your work: your project folders, your submissions (your conversations are the sidebar's Recent list).
route('/projects', { page: 'projects', mode: 'workspace', nav: 'projects', title: 'Projects', simLoad: true });
route('/project/:id', { page: 'project', mode: 'workspace', nav: 'projects', title: 'Project' });
route('/contributions', { page: 'contributions', mode: 'workspace', nav: 'contributions', title: 'My contributions', simLoad: true });
route('/search', { page: 'search', mode: 'workspace', nav: 'search', title: 'Search' });
// Knowledge: Browse (the organization's knowledge: search, topics, filters) → Reader; the Map draws the same knowledge as a tree; My library is personal.
route('/knowledge', { page: 'catalog', mode: 'workspace', nav: 'knowledge', title: 'Knowledge', simLoad: true });
route('/knowledge/map', { page: 'atlas', mode: 'workspace', nav: 'knowledge', title: 'Knowledge map', simLoad: true });
route('/knowledge/library', { page: 'library', mode: 'workspace', nav: 'knowledge', title: 'My library', simLoad: true });
route('/doc/:id', { page: 'docViewer', mode: 'workspace', nav: 'knowledge', title: 'Document', bare: true });
// Workspace admin
route('/overview', { page: 'overview', mode: 'workspace', nav: 'overview', title: 'Overview', perm: 'tenant.manage', simLoad: true });
// Knowledge Studio: the one place knowledge is run, its sections listed under it in the sidebar —
//   Documents (every document: All · Processing · Review; publication and processing are separate states, nothing is
//   processed until someone chooses, and a submission is processed before it's reviewed) · Collections (where documents live, who reads them) · Topics (what
//   documents are about: the topics and their suggestions) · Sources (what comes in, with the accounts it signs in with).
// Each section shows only to the people who can use it; the page itself is open to anyone with one (P.studio decides).
route('/studio', { page: 'studio', mode: 'workspace', nav: 'studio', title: 'Knowledge Studio', simLoad: true });
// One collection: access, the sources that feed it, settings (its owners and editors).
route('/studio/collections/:id', { page: 'kbDetail', mode: 'workspace', nav: 'studio', title: 'Collection', simLoad: true });
route('/people', { page: 'people', mode: 'workspace', nav: 'people', title: 'People', perm: 'user.manage', simLoad: true });
route('/assistant', { page: 'assistant', mode: 'workspace', nav: 'assistant', title: 'Assistant', perm: 'tenant.manage' });
route('/activity', { page: 'activity', mode: 'workspace', nav: 'activity', title: 'Activity', perm: 'audit.read', simLoad: true });
route('/settings', { page: 'settings', mode: 'workspace', nav: 'settings', title: 'Settings', perm: 'tenant.manage' });
// Platform operator
route('/p/workspaces', { page: 'pWorkspaces', mode: 'platform', nav: 'p-workspaces', title: 'Workspaces', perm: 'platform.tenant.read', simLoad: true });
route('/p/users', { page: 'pUsers', mode: 'platform', nav: 'p-users', title: 'Users', perm: 'platform.user.read', simLoad: true });
route('/p/connectors', { page: 'pConnectors', mode: 'platform', nav: 'p-connectors', title: 'Connectors', perm: 'platform.tenant.read' });
route('/p/indexing', { page: 'pIndexing', mode: 'platform', nav: 'p-indexing', title: 'Indexing', perm: 'platform.health.read', simLoad: true });
route('/p/usage', { page: 'pUsage', mode: 'platform', nav: 'p-usage', title: 'Usage', perm: 'platform.tenant.read', simLoad: true });
route('/p/audit', { page: 'pAudit', mode: 'platform', nav: 'p-audit', title: 'Audit log', perm: 'platform.audit.read', simLoad: true });
route('/p/health', { page: 'pHealth', mode: 'platform', nav: 'p-health', title: 'System health', perm: 'platform.health.read' });
// Prototype-only
route('/design', { page: 'design', mode: 'proto', title: 'Design system' });

/** Old addresses keep working. Each entry: [pattern, (match, query) → new address]. */
const REDIRECTS = [
  [/^\/access$/, () => '/people'], [/^\/p\/models$/, () => '/p/health'], [/^\/review$/, () => '/chat'], [/^\/knowledge\/browse$/, () => '/knowledge'],
  // All conversations and the Recent page became the sidebar's Recent list; My library's Contributions became My contributions.
  [/^\/(chats|recent)$/, () => '/chat'],
  [/^\/knowledge\/library$/, (m, q) => (q.tab === 'contributions' ? `/contributions?${q.open ? 'open=' + encodeURIComponent(q.open) : ''}` : q.tab === 'recent' ? '/chat' : null)],
  [/^\/(documents|knowledge-health)$/, () => '/studio'],
  // Old Studio sections (Review, Taxonomy, Library, Master data, Quality, Knowledge flow) and Documents views (Issues →
  // Processing; Quality → All with ?quality=) land in Documents or Topics: P.studio (features/curation.js legacyOf) renders
  // and rewrites ?tab=, ?view=, ?part=, ?mode=, ?queue=, ?life= and ?seg=.
  // Sources and Connections were pages of their own; now they are Knowledge Studio → Sources (accounts are one of its views).
  [/^\/sources$/, (m, q) => `/studio?${new URLSearchParams({ ...q, tab: 'sources', ...(q.tab === 'history' ? { view: 'history' } : {}) })}`],
  [/^\/connections$/, () => '/studio?tab=sources&view=accounts'],
  [/^\/bases$/, () => '/studio?tab=collections'],
  [/^\/bases\/([^/]+)$/, (m, q) => `/studio/collections/${m[1]}${Object.keys(q).length ? '?' + new URLSearchParams(q) : ''}`],
];

function parseHash() {
  const h = decodeURI(location.hash.slice(1)) || (S.signedIn ? homeRoute() : '/signin');
  let [p, q = ''] = h.split('?');
  // Redirects apply in order and chain (e.g. /documents → /studio, then Knowledge Studio rewrites its old tab).
  for (const [re, to] of REDIRECTS) {
    const m = p.match(re); if (!m) continue;
    const next = to(m, Object.fromEntries(new URLSearchParams(q))); if (next == null) continue;
    const keep = q; [p, q = ''] = next.split('?'); if (!next.includes('?')) q = keep;
    history.replaceState(null, '', '#' + p + (q ? '?' + q : ''));
  }
  const query = Object.fromEntries(new URLSearchParams(q));
  for (const r of ROUTES) {
    const m = p.match(r.re);
    if (m) { const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); return { r, params, query, path: p, full: h }; }
  }
  return { r: { page: 'notFound', mode: 'workspace', title: 'Not found' }, params: {}, query, path: p, full: h };
}
function go(path) { if (location.hash.slice(1) === path) render(); else location.hash = path; }
/** Patch query params of the current address without adding history (tabs, filters, selected record). */
function setQuery(patch) {
  const q = { ...S.cur.query, ...patch };
  Object.keys(q).forEach(k => (q[k] === '' || q[k] == null) && delete q[k]);
  const qs = new URLSearchParams(q).toString();
  history.replaceState(null, '', '#' + S.cur.path + (qs ? '?' + qs : ''));
  render();
}
/** Run an action after navigation settles (e.g. open a dialog on the destination page). */
function goThen(path, fn) { go(path); setTimeout(fn, 60); }

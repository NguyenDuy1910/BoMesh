'use strict';
/* Hash router. The route table below IS the information architecture:
   every screen, its mode (auth | workspace | platform | proto), its nav
   item, and the permission that gates it. Feature modules register the
   page renderer as P[page]. */
const P = {}, A = {}, M = {}, DR = {}, MENUS = {}, AFTER = {};
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
route('/workspaces', { page: 'workspaces', mode: 'auth', title: 'Choose a workspace' });
// Member — `module` routes exist only where the workspace has that module on (core/workspace.js)
route('/home', { page: 'home', mode: 'workspace', nav: 'home', title: 'Home', module: 'home' });
route('/spaces', { page: 'spaces', mode: 'workspace', nav: 'spaces', title: 'Spaces', module: 'spaces', simLoad: true });
route('/space/:id', { page: 'space', mode: 'workspace', nav: 'space', title: 'Space', module: 'spaces', simLoad: true });
route('/work', { page: 'work', mode: 'workspace', nav: 'work', title: 'Work', module: 'work', simLoad: true });
route('/work/new', { page: 'workNew', mode: 'workspace', nav: 'work', title: 'New work', module: 'work' });
route('/work/:id', { page: 'workItem', mode: 'workspace', nav: 'work', title: 'Work', module: 'work', bare: true });
route('/requests', { page: 'requests', mode: 'workspace', nav: 'requests', title: 'Requests', module: 'requests', simLoad: true });
route('/requests/new', { page: 'requestNew', mode: 'workspace', nav: 'requests', title: 'New request', module: 'requests' });
route('/requests/:id', { page: 'requestItem', mode: 'workspace', nav: 'requests', title: 'Request', module: 'requests' });
route('/chat', { page: 'chatHome', mode: 'workspace', nav: 'chat', title: 'New chat', bare: true });
route('/chat/:id', { page: 'chatThread', mode: 'workspace', nav: 'chat', title: 'Chat', bare: true });
route('/chats', { page: 'chats', mode: 'workspace', nav: 'chats', title: 'Conversations', simLoad: true });
route('/inbox', { page: 'inbox', mode: 'workspace', nav: 'inbox', title: 'Inbox', simLoad: true });
route('/search', { page: 'search', mode: 'workspace', nav: 'search', title: 'Search' });
// Knowledge: Discover → Browse (one catalog for search and filters) → Reader; Library is personal; bases are the governed homes.
route('/knowledge', { page: 'hub', mode: 'workspace', nav: 'knowledge', title: 'Knowledge', simLoad: true });
route('/knowledge/browse', { page: 'catalog', mode: 'workspace', nav: 'knowledge', title: 'Browse knowledge', simLoad: true });
route('/knowledge/library', { page: 'library', mode: 'workspace', nav: 'knowledge', title: 'My library', simLoad: true });
route('/knowledge/bases', { page: 'kbList', mode: 'workspace', nav: 'knowledge', title: 'Knowledge bases', simLoad: true });
route('/knowledge/collections/:id', { page: 'collection', mode: 'workspace', nav: 'knowledge', title: 'Collection', simLoad: true });
route('/knowledge/:id', { page: 'kbDetail', mode: 'workspace', nav: 'knowledge', title: 'Knowledge base', simLoad: true });
route('/doc/:id', { page: 'docViewer', mode: 'workspace', nav: 'knowledge', title: 'Document', bare: true });
// Workspace admin
route('/overview', { page: 'overview', mode: 'workspace', nav: 'overview', title: 'Overview', perm: 'tenant.manage', simLoad: true });
route('/sources', { page: 'sources', mode: 'workspace', nav: 'sources', title: 'Sources', perm: 'source.manage', simLoad: true });
route('/connections', { page: 'connections', mode: 'workspace', nav: 'connections', title: 'Connections', perm: 'source.manage', simLoad: true });
route('/people', { page: 'people', mode: 'workspace', nav: 'people', title: 'People', perm: 'user.manage', simLoad: true });
route('/assistant', { page: 'assistant', mode: 'workspace', nav: 'assistant', title: 'Assistant', perm: 'tenant.manage' });
route('/activity', { page: 'activity', mode: 'workspace', nav: 'activity', title: 'Activity', perm: 'audit.read', simLoad: true });
route('/knowledge-health', { page: 'khealth', mode: 'workspace', nav: 'khealth', title: 'Knowledge health', perm: 'knowledge.manage', simLoad: true });
route('/settings', { page: 'settings', mode: 'workspace', nav: 'settings', title: 'Settings', perm: 'tenant.manage' });
// Platform operator
route('/p/workspaces', { page: 'pWorkspaces', mode: 'platform', nav: 'p-workspaces', title: 'Workspaces', perm: 'platform.tenant.read', simLoad: true });
route('/p/users', { page: 'pUsers', mode: 'platform', nav: 'p-users', title: 'Users', perm: 'platform.user.read', simLoad: true });
route('/p/connectors', { page: 'pConnectors', mode: 'platform', nav: 'p-connectors', title: 'Connectors', perm: 'platform.tenant.read' });
route('/p/usage', { page: 'pUsage', mode: 'platform', nav: 'p-usage', title: 'Usage', perm: 'platform.tenant.read', simLoad: true });
route('/p/audit', { page: 'pAudit', mode: 'platform', nav: 'p-audit', title: 'Audit log', perm: 'platform.audit.read', simLoad: true });
route('/p/health', { page: 'pHealth', mode: 'platform', nav: 'p-health', title: 'System health', perm: 'platform.health.read' });
// Prototype-only
route('/design', { page: 'design', mode: 'proto', title: 'Design system' });

/** Old addresses keep working. */
const REDIRECTS = { '/access': '/people', '/p/models': '/p/health', '/review': '/chat', '/documents': '/knowledge/browse' };

function parseHash() {
  const h = decodeURI(location.hash.slice(1)) || (S.signedIn ? homeRoute() : '/signin');
  let [p, q = ''] = h.split('?');
  if (REDIRECTS[p]) { p = REDIRECTS[p]; history.replaceState(null, '', '#' + p + (q ? '?' + q : '')); }
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

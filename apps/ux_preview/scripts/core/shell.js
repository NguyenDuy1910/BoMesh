'use strict';
/* App shell: permission-aware sidebar, topbar, workspace switcher, account
   menu, preferences. One shell for every persona and every workspace
   template; destinations appear only when the workspace has the module on
   (core/workspace.js) and the caller has the permission. */

/** Member destinations, filtered by workspace modules. */
function memberNav() {
  return [
    { id: 'home', label: 'Home', icon: 'home', to: '/home' },
    { id: 'inbox', label: 'Inbox', icon: 'inbox', to: '/inbox', count: () => X.inboxUnread?.() || 0 },
    hasModule('work') && { id: 'work', label: 'Work', icon: 'sparkles', to: '/work' },
    hasModule('requests') && { id: 'requests', label: 'Requests', icon: 'clipboard', to: '/requests', count: () => X.requestsBadge?.() || 0 },
    { id: 'knowledge', label: 'Knowledge', icon: 'book', to: '/knowledge' },
    { id: 'chats', label: 'Conversations', icon: 'message', to: '/chats' },
  ].filter(Boolean);
}
const MANAGE_NAV = [
  { id: 'overview', label: 'Overview', icon: 'home', to: '/overview', perm: 'tenant.manage' },
  { id: 'documents', label: 'Documents', icon: 'files', to: '/documents', perm: 'knowledge.manage', count: () => X.docsBadge?.() || 0 },
  { id: 'sources', label: 'Sources', icon: 'refresh', to: '/sources', perm: 'source.manage', count: () => D.sources.filter(s => ['failed', 'reconnect'].includes(s.status)).length, alert: true },
  { id: 'connections', label: 'Connections', icon: 'plug', to: '/connections', perm: 'source.manage', count: () => D.accounts.filter(a => a.status === 'expired' || a.status === 'error').length, alert: true },
  { id: 'people', label: 'People', icon: 'users', to: '/people', perm: 'user.manage', count: () => pendingRequests().length },
  { id: 'assistant', label: 'Assistant', icon: 'sparkles', to: '/assistant', perm: 'tenant.manage' },
  { id: 'activity', label: 'Activity', icon: 'activity', to: '/activity', perm: 'audit.read' },
  { id: 'settings', label: 'Settings', icon: 'settings', to: '/settings', perm: 'tenant.manage' },
];
const PLATFORM_NAV = [
  { id: 'p-workspaces', label: 'Workspaces', icon: 'building', to: '/p/workspaces' },
  { id: 'p-users', label: 'Users', icon: 'users', to: '/p/users' },
  { id: 'p-connectors', label: 'Connectors', icon: 'plug', to: '/p/connectors' },
  { id: 'p-indexing', label: 'Indexing', icon: 'database', to: '/p/indexing', count: () => X.pIndexAlerts?.() || 0, alert: true },
  { id: 'p-usage', label: 'Usage', icon: 'chart', to: '/p/usage' },
  { id: 'p-audit', label: 'Audit log', icon: 'activity', to: '/p/audit' },
  { id: 'p-health', label: 'System health', icon: 'server', to: '/p/health', count: () => D.pServices.filter(s => s.status !== 'operational').length, alert: true },
];

function navItem(n, active) {
  const c = n.count ? n.count() : 0;
  return `<a class="nav-item" href="#${n.to}" ${active ? 'aria-current="page"' : ''}>${ic(n.icon)}<span class="nav-item__label">${esc(n.label)}</span>${c ? `<span class="badge ${n.alert ? 'badge--danger' : ''}" aria-label="${c} need attention">${c}</span>` : ''}</a>`;
}
function sidebar() {
  const cur = S.cur, platform = cur.r.mode === 'platform', ws = curWs(), p = me();
  const head = platform
    ? `<button type="button" class="ws-switch" data-menu="ws" aria-haspopup="menu" aria-expanded="false" aria-label="Switch workspace"><span class="ws-mark" style="background:var(--foreground);color:var(--background)">${ic('layers', 'i-sm')}</span><span class="grow stack"><span class="ws-switch__name truncate">Platform console</span><span class="ws-switch__meta">All workspaces</span></span>${ic('chevrons', 'i-sm')}</button>`
    : `<button type="button" class="ws-switch" data-menu="ws" aria-haspopup="menu" aria-expanded="false" aria-label="Switch workspace">${wsMark(ws, 28)}<span class="grow stack"><span class="ws-switch__name truncate">${esc(ws.name)}</span><span class="ws-switch__meta truncate">${esc(p.role)}</span></span>${ic('chevrons', 'i-sm')}</button>`;
  const search = iconBtn('search', 'Search  ⌘K', { act: 'palette', size: 'sm' });
  let body = '';
  if (!platform) {
    body += `<div class="sidebar__group">${memberNav().map(n => navItem(n, cur.r.nav === n.id)).join('')}</div>`;
    if (hasModule('spaces')) {
      const mine = mySpaces();
      body += `<div class="sidebar__group"><div class="sidebar__group-label"><span>Spaces</span><a href="#/spaces" ${cur.r.nav === 'spaces' ? 'aria-current="page"' : ''}>All</a></div>${mine.slice(0, 8).map(sp => `<a class="nav-item" href="#/space/${sp.id}" ${cur.path === '/space/' + sp.id ? 'aria-current="page"' : ''} title="${esc(sp.name)}"><span class="space-dot" style="background:${esc(sp.color || 'var(--accent)')}" aria-hidden="true"></span><span class="nav-item__label">${esc(sp.name)}</span>${sp.code ? `<span class="nav-item__meta">${esc(sp.code)}</span>` : ''}</a>`).join('') || `<a class="nav-item nav-item--recent" href="#/spaces"><span class="nav-item__label">Find or create a space</span></a>`}</div>`;
    }
    const manage = MANAGE_NAV.filter(n => can(n.perm));
    if (manage.length) body += `<div class="sidebar__group"><div class="sidebar__group-label">Manage</div>${manage.map(n => navItem(n, cur.r.nav === n.id)).join('')}</div>`;
    if (!hasModule('spaces')) {
      const recents = myConvs().sort((a, b) => b.at - a.at).slice(0, 6);
      if (recents.length) body += `<div class="sidebar__group"><div class="sidebar__group-label"><span>Recent</span></div>${recents.map(c => `<a class="nav-item nav-item--recent" href="#/chat/${c.id}" ${cur.path === '/chat/' + c.id ? 'aria-current="page"' : ''} title="${esc(c.title)}"><span class="nav-item__label">${esc(c.title)}</span></a>`).join('')}</div>`;
    }
  } else {
    body += `<div class="sidebar__group">${PLATFORM_NAV.map(n => navItem(n, cur.r.nav === n.id)).join('')}</div>`;
    body += `<div class="sidebar__group"><div class="sidebar__group-label">Workspace</div><a class="nav-item" href="#${homeRoute()}">${ic('arrow-left')}<span class="nav-item__label">Back to ${esc(ws.name)}</span></a></div>`;
  }
  const foot = `<div class="sidebar__footer"><button type="button" class="user-button" data-menu="me" aria-haspopup="menu" aria-expanded="false" aria-label="Account and preferences">${avatar(p.name)}<span class="grow stack"><span class="user-button__name truncate">${esc(p.name)}</span><span class="user-button__meta truncate">${esc(p.email)}</span></span>${ic('chevrons', 'i-sm muted')}</button></div>`;
  return `<aside class="sidebar" aria-label="Main navigation"><div class="sidebar__header">${head}${search}</div><nav class="sidebar__content">${body}</nav>${foot}</aside>`;
}
function topbar() {
  const list = S.crumbs || [{ label: S.cur.r.title }];
  const bc = `<nav class="breadcrumbs" aria-label="Breadcrumb">${list.map((c, i) => (i ? ic('chevron-right') : '') + (c.to && i < list.length - 1 ? `<a href="#${c.to}">${esc(c.label)}</a>` : `<span ${i === list.length - 1 ? 'aria-current="page"' : ''} class="truncate">${esc(c.label)}</span>`)).join('')}</nav>`;
  return `<header class="topbar">${iconBtn('panel-left', 'Toggle sidebar', { act: 'nav-toggle', size: 'sm' })}<span class="separator separator--v" style="height:16px;align-self:center"></span>${bc}<div class="topbar__end" id="topbar-end">${S.topbarEnd || ''}</div></header>`;
}
/** Pages may place compact contextual actions in the topbar (e.g. chat Share). */
function topbarActions(html) { S.topbarEnd = html; return ''; }

MENUS.ws = () => {
  const items = [{ section: 'Workspaces' }];
  workspacesForMe().forEach(w => items.push({ html: `${wsMark(w, 22)}<span class="grow truncate">${esc(w.name)}</span>`, checked: S.cur.r.mode !== 'platform' && S.ws === w.id, run: () => switchWorkspace(w.id) }));
  items.push({ sep: true });
  if (isOperator()) items.push(S.cur.r.mode === 'platform' ? { label: 'Back to workspace', icon: 'arrow-left', run: () => go(homeRoute()) } : { label: 'Platform console', icon: 'layers', run: () => go('/p/workspaces') });
  items.push({ label: 'All workspaces', icon: 'grid', run: () => go('/workspaces') });
  return items;
};
function switchWorkspace(id) {
  if (S.ws === id && S.cur.r.mode === 'workspace') return refresh();
  enterWorkspace(id);
}
/** Conversations the caller can see: shared demo threads plus their own. */
const myConvs = () => D.convs.filter(c => !c.owner || c.owner === me().id);
MENUS.me = () => [
  { html: `${avatar(me().name, 'lg')}<span class="stack grow" style="min-width:0"><span class="medium truncate">${esc(me().name)}</span><span class="t-xs muted truncate">${esc(me().role)}</span></span>`, run: () => openModal('prefs') },
  { sep: true },
  { label: 'Preferences', icon: 'settings', run: () => openModal('prefs') },
  ...X.appearance.menuItems(),
  X.lang.menuItem(),
  { sep: true },
  { label: 'Keyboard shortcuts', icon: 'command', run: () => openModal('shortcuts') },
  X.startTour && S.cur.r.mode !== 'platform' && { label: 'Product tour', icon: 'route', run: () => X.startTour() },
  isOperator() && S.cur.r.mode !== 'platform' && { label: 'Platform console', icon: 'layers', run: () => go('/p/workspaces') },
  { sep: true },
  { label: 'Sign out', icon: 'logout', run: () => { S.signedIn = false; persist(); go('/signin'); toast('Signed out', { tone: 'accent' }); } },
].filter(Boolean);

M.prefs = () => {
  const f = ui('prefs', { name: me().name, steps: true, notif: { syncs: true, requests: true, docs: true, digest: true } });
  const notif = (k, t, d) => switchRow({ title: t, desc: d, on: f.notif[k], act: 'pref-notif', data: { k } });
  return {
    title: 'Preferences', size: 'lg',
    body: `${field({ id: 'pref-name', label: 'Display name', control: input({ id: 'pref-name', bind: 'prefs.name', value: f.name }) })}
      ${field({ id: 'pref-email', label: 'Email', desc: 'Managed by your sign-in provider.', control: input({ id: 'pref-email', value: me().email, attrs: 'readonly' }) })}
      <div class="field"><span class="label">Appearance</span><div class="pref-look">${X.appearance.dot()}<span class="grow"><span class="medium">${esc(themeLabel())}</span><span class="t-xs muted" style="display:block">${esc(X.appearance.detail())}</span></span>${btn('Change', { size: 'sm', icon: 'palette', act: 'look-open' })}</div></div>
      ${X.lang.field()}
      <div class="mt-16">${switchRow({ title: 'Show how answers were found', desc: 'Show the searches and analysis steps above each answer.', on: f.steps, act: 'pref-steps' })}</div>
      <h3 class="t-subheading mt-16">Email notifications</h3>
      ${isAdmin() ? notif('syncs', 'A source stops syncing', 'So knowledge doesn’t go stale unnoticed.') + notif('requests', 'Someone requests access', 'For knowledge bases you own.') : ''}
      ${notif('docs', 'Documents I rely on change', 'When a source cited in your chats is updated.')}
      ${notif('digest', 'Weekly summary', isAdmin() ? 'Questions, knowledge gaps and sync health.' : 'New knowledge shared with you.')}`,
    foot: btn('Cancel', { act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'pref-save' }),
  };
};
A['pref-steps'] = () => { const f = ui('prefs'); f.steps = !f.steps; refreshLayer(); };
A['pref-notif'] = el => { const n = ui('prefs').notif; n[el.dataset.k] = !n[el.dataset.k]; refreshLayer(); };
A['pref-save'] = () => { const name = ui('prefs').name.trim(); if (!name) { toast('Enter a display name.', { tone: 'danger' }); return; } PERSONAS[S.persona].name = name; persist(); closeModal(); refresh(); toast('Preferences saved'); };
const prefShowSteps = () => S.ui.prefs?.steps !== false;
M.shortcuts = () => ({
  size: 'sm', title: 'Keyboard shortcuts',
  body: `<dl class="kv" style="grid-template-columns:1fr auto;gap:12px 16px">${[['Search or ask', '⌘ K'], ['New chat', '⌘ ⇧ O'], ['Send message', '↵'], ['New line', '⇧ ↵'], ['Close dialog or panel', 'Esc']].map(([a, k]) => `<dt class="fg">${a}</dt><dd class="row gap-4">${k.split(' ').map(kbd).join('')}</dd>`).join('')}</dl>`,
  foot: btn('Done', { v: 'primary', act: 'close-modal' }),
});

function noAccessPage() {
  return `<div class="page">${emptyState({ icon: 'lock', title: 'You don’t have access to this page', desc: 'Ask a workspace admin if you need it. Everything you can use is in the sidebar.', actions: btn('Go home', { v: 'primary', href: homeRoute() }) + btn('Browse knowledge', { href: '/knowledge' }) })}</div>`;
}
/** A route whose module this workspace hasn't turned on. */
function moduleOffPage(m) {
  return `<div class="page">${emptyState({ icon: 'layers', title: `${MODULES[m]?.label || 'This feature'} isn’t on in ${esc(curWs().name)}`, desc: esc(MODULES[m]?.desc || '') + (isAdmin() ? ' You can turn it on in Settings → Workspace setup.' : ' Ask a workspace admin if your team needs it.'), actions: (isAdmin() ? btn('Open workspace setup', { v: 'primary', href: '/settings?tab=setup' }) : '') + btn('Go home', { href: homeRoute() }) })}</div>`;
}
P.notFound = () => `<div class="page">${emptyState({ icon: 'search', title: 'This page doesn’t exist', desc: 'The link may be old or mistyped.', actions: btn('Go home', { v: 'primary', href: homeRoute() }) })}</div>`;

'use strict';
/* App shell: permission-aware sidebar, topbar, workspace switcher, account
   menu, preferences. One shell for every persona and every workspace
   template; destinations appear only when the workspace has the module on
   (core/workspace.js) and the caller has the permission. */

/** Member destinations, filtered by workspace modules. Conversations live under Projects and Recent (features/projects.js);
    Inbox is the bell in the topbar; the full conversation list is in the sidebar's Recent and one ⌘K away (`/chats`). */
function memberNav() {
  return [
    { id: 'home', label: 'Home', icon: 'home', to: '/home' },
    { id: 'knowledge', label: 'Knowledge', icon: 'book', to: '/knowledge' },
    hasModule('work') && { id: 'work', label: 'Work', icon: 'sparkles', to: '/work' },
    hasModule('requests') && { id: 'requests', label: 'Requests', icon: 'clipboard', to: '/requests', count: () => X.requestsBadge?.() || 0 },
  ].filter(Boolean);
}
/** Pages that aren't sidebar rows (Inbox has the topbar bell): the palette lists them first. */
const MORE_PAGES = [
  { label: 'Inbox', icon: 'inbox', to: '/inbox' },
  { label: 'All conversations', icon: 'message', to: '/chats' },
];
const MANAGE_NAV = [
  { id: 'overview', label: 'Overview', icon: 'home', to: '/overview', perm: 'tenant.manage' },
  // Counts exactly what the landing tab shows: Documents opens on the Review queue while it has items.
  { id: 'documents', label: 'Documents', icon: 'files', to: '/documents', perm: 'knowledge.manage', count: () => (canReview() ? reviewQueue().length : 0), tone: 'accent' },
  // Owners and editors of a base manage it here even without workspace roles; owners who don't manage People see their bases' access requests.
  { id: 'bases', label: 'Knowledge bases', icon: 'book', to: '/bases', show: () => canManageKbs(), count: () => (can('user.manage') ? 0 : pendingRequests().filter(r => kbRole(kbById(r.kb)) === 'owner').length), tone: 'accent' },
  // Each root cause is counted once: a source that stopped because its account expired counts on Connections only.
  { id: 'sources', label: 'Sources', icon: 'refresh', to: '/sources', perm: 'source.manage', count: () => X.srcBadge?.() || 0, tone: 'danger' },
  { id: 'connections', label: 'Connections', icon: 'plug', to: '/connections', perm: 'source.manage', count: () => X.accBadge?.() || 0, tone: 'danger' },
  { id: 'people', label: 'People', icon: 'users', to: '/people', perm: 'user.manage', count: () => pendingRequests().length, tone: 'accent' },
  { id: 'assistant', label: 'Assistant', icon: 'sparkles', to: '/assistant', perm: 'tenant.manage' },
  { id: 'activity', label: 'Activity', icon: 'activity', to: '/activity', perm: 'audit.read' },
  { id: 'settings', label: 'Settings', icon: 'settings', to: '/settings', perm: 'tenant.manage' },
];
const PLATFORM_NAV = [
  { id: 'p-workspaces', label: 'Workspaces', icon: 'building', to: '/p/workspaces', count: () => X.pWsAttention?.() || 0, tone: 'accent' },
  { id: 'p-users', label: 'Users', icon: 'users', to: '/p/users' },
  { id: 'p-connectors', label: 'Connectors', icon: 'plug', to: '/p/connectors' },
  { id: 'p-indexing', label: 'Indexing', icon: 'database', to: '/p/indexing', count: () => X.pIndexAlerts?.() || 0, tone: 'danger' },
  { id: 'p-usage', label: 'Usage', icon: 'chart', to: '/p/usage' },
  { id: 'p-audit', label: 'Audit log', icon: 'activity', to: '/p/audit' },
  { id: 'p-health', label: 'System health', icon: 'server', to: '/p/health', count: () => D.pServices.filter(s => s.status !== 'operational').length, tone: 'danger' },
];

function navItem(n, active) {
  const c = n.count ? n.count() : 0;
  return `<a class="nav-item" href="#${n.to}" ${active ? 'aria-current="page"' : ''}>${ic(n.icon)}<span class="nav-item__label">${esc(n.label)}</span>${badge(c, { tone: n.tone || 'accent' })}</a>`;
}
function sidebar() {
  const cur = S.cur, platform = cur.r.mode === 'platform', ws = curWs(), p = me();
  // One workspace and no console: the header is a static identity row, not a switcher with a one-item menu.
  const switcher = platform || isOperator() || workspacesForMe().length > 1;
  const head = platform
    ? `<button type="button" class="ws-switch" data-menu="ws" aria-haspopup="menu" aria-expanded="false" aria-label="Switch workspace"><span class="ws-mark" style="background:var(--foreground);color:var(--background)">${ic('layers', 'i-sm')}</span><span class="grow stack"><span class="ws-switch__name truncate">Platform console</span><span class="ws-switch__meta">All workspaces</span></span>${ic('chevrons', 'i-sm')}</button>`
    : switcher ? `<button type="button" class="ws-switch" data-menu="ws" aria-haspopup="menu" aria-expanded="false" aria-label="Switch workspace">${wsMark(ws, 28)}<span class="grow stack"><span class="ws-switch__name truncate">${esc(ws.name)}</span><span class="ws-switch__meta truncate">${esc(p.role)}</span></span>${ic('chevrons', 'i-sm')}</button>`
      : `<div class="ws-switch ws-switch--static">${wsMark(ws, 28)}<span class="grow stack"><span class="ws-switch__name truncate">${esc(ws.name)}</span><span class="ws-switch__meta truncate">${esc(p.role)}</span></span></div>`;
  let body = '';
  if (!platform) {
    body += `<div class="sidebar__group">${memberNav().map(n => navItem(n, cur.r.nav === n.id)).join('')}</div>`;
    body += X.projects?.sidebar(cur) || '';
    if (hasModule('spaces')) {
      const mine = mySpaces();
      body += `<div class="sidebar__group"><div class="sidebar__group-label"><span>Spaces</span><a href="#/spaces" ${cur.r.nav === 'spaces' ? 'aria-current="page"' : ''}>All</a></div>${mine.slice(0, 8).map(sp => `<a class="nav-item" href="#/space/${sp.id}" ${cur.path === '/space/' + sp.id ? 'aria-current="page"' : ''}><span class="space-dot" style="background:${esc(sp.color || 'var(--accent)')}" aria-hidden="true"></span><span class="nav-item__label">${esc(sp.name)}</span>${sp.code ? `<span class="nav-item__meta">${esc(sp.code)}</span>` : ''}</a>`).join('') || `<a class="nav-item nav-item--recent" href="#/spaces"><span class="nav-item__label">Find or create a space</span></a>`}</div>`;
    }
    const manage = MANAGE_NAV.filter(n => (n.show ? n.show() : can(n.perm)));
    if (manage.length) {
      // Progressive disclosure: administration stays one row until it's needed (open on a Manage page or by choice);
      // collapsed, a dot says something inside needs attention (red when something is broken) — the counts live on the rows.
      const here = manage.some(n => cur.r.nav === n.id), open = here || S.manageOpen;
      const need = manage.filter(n => n.count?.()), tone = need.some(n => n.tone === 'danger') ? 'danger' : 'accent';
      body += `<div class="sidebar__group"><button type="button" class="sidebar__group-label sidebar__group-toggle" data-act="nav-manage" aria-expanded="${open}" ${here ? 'aria-disabled="true"' : ''}><span>Manage</span>${!open ? badge(need.length, { tone, dot: true, label: tone === 'danger' ? 'Something needs fixing' : 'Something needs you' }) : ''}${here ? '' : ic(open ? 'chevron-up' : 'chevron-down', 'i-xs')}</button>${open ? manage.map(n => navItem(n, cur.r.nav === n.id)).join('') : ''}</div>`;
    }
  } else {
    body += `<div class="sidebar__group">${PLATFORM_NAV.map(n => navItem(n, cur.r.nav === n.id)).join('')}</div>`;
    body += `<div class="sidebar__group"><div class="sidebar__group-label">Workspace</div><a class="nav-item" href="#${homeRoute()}">${ic('arrow-left')}<span class="nav-item__label">Back to ${esc(ws.name)}</span></a></div>`;
  }
  const foot = `<div class="sidebar__footer"><button type="button" class="user-button" data-menu="me" aria-haspopup="menu" aria-expanded="false" aria-label="Account and preferences">${avatar(p.name)}<span class="grow stack"><span class="user-button__name truncate">${esc(p.name)}</span><span class="user-button__meta truncate">${esc(p.email)}</span></span>${ic('chevrons', 'i-sm muted')}</button></div>`;
  return `<aside class="sidebar" aria-label="Main navigation"><div class="sidebar__header">${head}</div><nav class="sidebar__content">${body}</nav>${foot}</aside>`;
}
/** Breadcrumbs only when they add a level the H1 doesn't (depth ≥ 2); Manage pages say where they live ("Manage › Sources"). */
function crumbTrail() {
  const cur = S.cur, manage = cur.r.mode === 'workspace' && MANAGE_NAV.some(n => n.id === cur.r.nav);
  let list = S.crumbs || [{ label: cur.r.title }];
  if (manage && list[0]?.label !== 'Manage') list = [{ label: 'Manage' }, ...list];
  return list.length >= 2 ? list : [];
}
function topbar() {
  const list = crumbTrail(), inApp = S.cur.r.mode === 'workspace';
  const bc = list.length ? `<nav class="breadcrumbs" aria-label="Breadcrumb">${list.map((c, i) => (i ? ic('chevron-right') : '') + (c.to && i < list.length - 1 ? `<a href="#${c.to}">${esc(c.label)}</a>` : `<span ${i === list.length - 1 ? 'aria-current="page"' : ''} class="truncate">${esc(c.label)}</span>`)).join('')}</nav>` : '';
  const unread = inApp ? X.inboxUnread?.() || 0 : 0;
  const search = `<button type="button" class="topbar-search" id="topbar-search" data-act="palette" aria-label="Search, ask or go to (⌘K)" aria-keyshortcuts="Meta+K">${ic('search')}<span class="topbar-search__label">Search</span>${kbd('⌘K')}</button>`;
  const bell = inApp ? `<a class="button button--ghost button--icon-only button--muted topbar-bell" id="topbar-inbox" href="#/inbox" data-tip="Inbox" aria-label="${unread ? `Inbox, ${unread} unread` : 'Inbox'}" ${S.cur.r.nav === 'inbox' ? 'aria-current="page"' : ''}>${ic('bell')}${unread ? `<span class="topbar-bell__badge" aria-hidden="true">${unread > 9 ? '9+' : unread}</span>` : ''}</a>` : '';
  return `<header class="topbar">${iconBtn('panel-left', 'Toggle sidebar', { act: 'nav-toggle', size: 'sm' })}${bc ? `<span class="separator separator--v topbar__sep"></span>${bc}` : ''}<div class="topbar__end" id="topbar-end">${S.topbarEnd || ''}${search}${bell}</div></header>`;
}
/** Pages may place compact contextual actions in the topbar (e.g. chat Share). */
function topbarActions(html) { S.topbarEnd = html; return ''; }
A['nav-manage'] = el => { if (el.getAttribute('aria-disabled') === 'true') return; S.manageOpen = !S.manageOpen; persist(); refresh(); $('[data-act="nav-manage"]')?.focus(); };

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
/** Account menu: who you are (opens Preferences), the two personal settings with their current value, Help, Sign out — seven rows
    at most, so Sign out is always visible. Mode/theme details live in the Appearance drawer; the console in the workspace switcher. */
MENUS.me = () => [
  { html: `${avatar(me().name, 'lg')}<span class="stack grow" style="min-width:0"><span class="medium truncate">${esc(me().name)}</span><span class="t-xs muted truncate">${esc(me().email)}</span></span>${ic('settings', 'menu-item__trail')}`, run: () => openPrefs() },
  { sep: true },
  X.appearance.menuItem(),
  X.lang.menuItem(),
  MENUS.help().length > 1 && { label: 'Help', icon: 'help', meta: '›', run: () => { const tg = $('[data-menu="me"]'); if (tg) setTimeout(() => openMenu(tg, MENUS.help(), 'help'), 0); } },
  { sep: true },
  { label: 'Sign out', icon: 'logout', run: () => { S.signedIn = false; persist(); go('/signin'); toast('Signed out', { tone: 'accent' }); } },
].filter(Boolean);
/** Help: shortcuts only where there is a keyboard; the product tour inside a workspace. */
MENUS.help = () => [
  { section: 'Help' },
  !matchMedia('(hover: none), (pointer: coarse)').matches && { label: 'Keyboard shortcuts', icon: 'command', run: () => openModal('shortcuts') },
  X.startTour && S.cur.r.mode !== 'platform' && { label: 'Product tour', icon: 'route', run: () => X.startTour() },
].filter(Boolean);

/* Preferences apply immediately, like Appearance and Language: each switch flips at once with an Undo toast, the display name
   commits on Enter or when the field loses focus, and the footer is a single Done. Closing never leaves half-applied state:
   an uncommitted name draft is dropped, and the draft is rebuilt from the saved name every time the dialog opens. */
const PREF_DEFAULTS = { name: '', err: '', steps: true, notif: { syncs: true, requests: true, docs: true, digest: true } };
const prefs = () => ui('prefs', PREF_DEFAULTS);
function openPrefs(focus = '') {
  Object.assign(prefs(), { name: me().name, err: '' });
  openModal('prefs', { focus });
  if (focus) requestAnimationFrame(() => requestAnimationFrame(() => $('#pref-' + focus)?.scrollIntoView({ block: 'start', behavior: 'smooth' })));
}
M.prefs = () => {
  const f = prefs();
  if (!f.name && !f.err) f.name = me().name;
  const notif = (k, t, d) => switchRow({ title: t, desc: d, on: f.notif[k], act: 'pref-notif', data: { k, t } });
  return {
    title: 'Preferences', size: 'lg', icon: 'settings', desc: 'Changes apply right away and are saved for you.',
    body: `${field({ id: 'pref-name', label: 'Display name', error: f.err, desc: 'Press Enter to save.', control: input({ id: 'pref-name', bind: 'prefs.name', value: f.name, onEnter: 'pref-name', invalid: !!f.err, attrs: 'data-change="pref-name" autocomplete="name"' }) })}
      ${field({ id: 'pref-email', label: 'Email', desc: 'Managed by your sign-in provider.', control: input({ id: 'pref-email', value: me().email, attrs: 'readonly' }) })}
      <div class="field"><span class="label">Appearance</span><div class="pref-look">${X.appearance.dot()}<span class="grow"><span class="medium">${esc(themeLabel())}</span><span class="t-xs muted" style="display:block">${esc(X.appearance.detail())}</span></span>${btn('Change', { size: 'sm', icon: 'palette', act: 'look-open' })}</div></div>
      ${X.lang.field()}
      <div class="mt-16">${switchRow({ title: 'Show how answers were found', desc: 'Show the searches and analysis steps above each answer.', on: f.steps, act: 'pref-steps' })}</div>
      <h3 class="t-subheading mt-16" id="pref-notif">Email notifications</h3>
      ${isAdmin() ? notif('syncs', 'A source stops syncing', 'So knowledge doesn’t go stale unnoticed.') + notif('requests', 'Someone requests access', 'For knowledge bases you own.') : ''}
      ${notif('docs', 'Documents I rely on change', 'When a source cited in your chats is updated.')}
      ${notif('digest', 'Weekly summary', isAdmin() ? 'Questions, knowledge gaps and sync health.' : 'New knowledge shared with you.')}`,
    foot: btn('Done', { v: 'primary', act: 'close-modal' }),
  };
};
A['pref-name'] = el => {
  const f = prefs(), name = String(el?.value ?? f.name).trim(), before = me().name;
  if (!name) { f.err = 'Enter a display name.'; refreshLayer(); $('#pref-name')?.focus(); return; }
  if (f.err) f.err = '';
  if (name === before) { refreshLayer(); return; }
  f.name = name; PERSONAS[S.persona].name = name; persist(); refresh();
  toast('Display name updated', { action: { label: 'Undo', run: () => { PERSONAS[S.persona].name = before; if (S.modal?.name === 'prefs') prefs().name = before; persist(); refresh(); } } });
};
A['pref-steps'] = () => {
  const f = prefs(); f.steps = !f.steps; refreshLayer();
  toast(f.steps ? 'Answer steps shown' : 'Answer steps hidden', { action: { label: 'Undo', run: () => { f.steps = !f.steps; S.modal ? refreshLayer() : refresh(); } } });
};
A['pref-notif'] = el => {
  const n = prefs().notif, k = el.dataset.k; n[k] = !n[k]; refreshLayer();
  toast(n[k] ? 'Email notification turned on' : 'Email notification turned off', { action: { label: 'Undo', run: () => { n[k] = !n[k]; if (S.modal) refreshLayer(); } } });
};
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

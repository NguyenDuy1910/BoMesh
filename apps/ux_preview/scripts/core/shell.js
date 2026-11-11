'use strict';
/* App shell: permission-aware sidebar, topbar, workspace switcher, account
   menu, preferences. One shell for every persona and every workspace
   template; destinations appear only when the workspace has the module on
   (core/workspace.js) and the caller has the permission. */

/** WORKSPACE: where the organisation's knowledge and work live, filtered by workspace modules. Inbox is the topbar bell.
    Conversations, projects and recent items each have their own page (AI Chat, Projects, Recent): the sidebar never lists them inline. */
function memberNav() {
  return [
    { id: 'home', label: 'Home', icon: 'home', to: '/home' },
    { id: 'knowledge', label: 'Knowledge', icon: 'book', to: '/knowledge' },
    { id: 'chat', label: 'AI Chat', icon: 'message', to: '/chat' },
    hasModule('work') && { id: 'work', label: 'Work', icon: 'sparkles', to: '/work' },
    hasModule('requests') && { id: 'requests', label: 'Requests', icon: 'clipboard', to: '/requests', count: () => X.requestsBadge?.() || 0 },
  ].filter(Boolean);
}
/** YOUR WORK: what you touched lately, your project folders, your spaces, your submissions. My contributions counts only what
    waits on you (changes requested); it shows to contributors and to anyone who still has submissions to follow. */
function yourWorkNav() {
  return [
    { id: 'recent', label: 'Recent', icon: 'clock', to: '/recent' },
    { id: 'projects', label: 'Projects', icon: 'folder', to: '/projects' },
    hasModule('spaces') && { id: 'spaces', label: 'Spaces', icon: 'layers', to: '/spaces' },
    (canContribute() || myContributions().length > 0) && { id: 'contributions', label: 'My contributions', icon: 'upload', to: '/contributions', count: () => myContributions().filter(d => stageOf(d) === 'changes').length, tone: 'accent' },
  ].filter(Boolean);
}
/** Pages that aren't sidebar rows (Inbox has the topbar bell): the palette lists them first. */
const MORE_PAGES = [
  { label: 'Inbox', icon: 'inbox', to: '/inbox' },
];
/** Manage = run the workspace. Everything about knowledge — where it comes from (sources and their accounts), where it
    lives and who reads it (knowledge bases), how it's classified (taxonomy), and the review → publish work — is one
    destination, Knowledge Studio; its tabs show to whoever can use them. The rest is people, the assistant, audit, settings. */
const MANAGE_NAV = [
  { id: 'overview', label: 'Overview', icon: 'dashboard', to: '/overview', perm: 'tenant.manage' },
  // One badge, the landing tab's: the review queue (accent), else broken sources or accounts (danger), else access requests the owner decides.
  { id: 'studio', label: 'Knowledge Studio', icon: 'library', to: '/studio', show: () => X.studioTabs?.().length > 0, count: () => X.studioBadge?.().n || 0, tone: () => X.studioBadge?.().tone || 'accent' },
  { id: 'people', label: 'People', icon: 'users', to: '/people', perm: 'user.manage', count: () => pendingRequests().length, tone: 'accent' },
  { id: 'assistant', label: 'Assistant', icon: 'bot', to: '/assistant', perm: 'tenant.manage' },
  { id: 'activity', label: 'Activity', icon: 'activity', to: '/activity', perm: 'audit.read' },
  { id: 'settings', label: 'Settings', icon: 'settings', to: '/settings', perm: 'tenant.manage' },
];
/** MANAGE rows the caller may use (an editor who owns a base sees Knowledge Studio only). */
const manageNav = () => MANAGE_NAV.filter(n => (n.show ? n.show() : can(n.perm)));
const PLATFORM_NAV = [
  { id: 'p-workspaces', label: 'Workspaces', icon: 'building', to: '/p/workspaces', count: () => X.pWsAttention?.() || 0, tone: 'accent' },
  { id: 'p-users', label: 'Users', icon: 'users', to: '/p/users' },
  { id: 'p-connectors', label: 'Connectors', icon: 'plug', to: '/p/connectors' },
  { id: 'p-indexing', label: 'Indexing', icon: 'database', to: '/p/indexing', count: () => X.pIndexAlerts?.() || 0, tone: 'danger' },
  { id: 'p-usage', label: 'Usage', icon: 'chart', to: '/p/usage' },
  { id: 'p-audit', label: 'Audit log', icon: 'activity', to: '/p/audit' },
  { id: 'p-health', label: 'System health', icon: 'server', to: '/p/health', count: () => D.pServices.filter(s => s.status !== 'operational').length, tone: 'danger' },
];

/* Collapsible sidebar groups (Your work, Manage) remember their state per person; open until someone collapses them. */
DATA_KEYS.push('navGroups');
const navGroups = () => ((D.navGroups ??= {})[me().id] ??= {});
/** Routes whose row lives under another id: a space page is under Spaces. */
const NAV_OF = { space: 'spaces' };
const toneOf = n => (typeof n.tone === 'function' ? n.tone() : n.tone) || 'accent';
/** Below 1024 px the sidebar is off-canvas; above it, it is either expanded or a 56 px icon rail (S.collapsed). */
const narrowFrame = () => ($('#frame')?.clientWidth || innerWidth) < 1024;
const railMode = () => S.collapsed && !narrowFrame();
function navItem(n, active, rail = false) {
  const c = n.count ? n.count() : 0;
  // In the rail the label stays in the DOM (it names the link) and shows as a tooltip.
  return `<a class="nav-item" id="nav-${esc(n.id)}" href="#${n.to}" ${active ? 'aria-current="page"' : ''} ${rail ? `data-tip="${esc(n.label)}" data-tip-side="right"` : ''}>${ic(n.icon)}<span class="nav-item__label">${esc(n.label)}</span>${badge(c, { tone: toneOf(n) })}</a>`;
}
/** A labelled group of rows. With `key` it collapses: it stays open while you're on one of its pages, and collapsed it shows
    a dot when something inside needs attention (red when something is broken) — the counts themselves live on the rows.
    In the rail every group is open and the label becomes a hairline. */
function navGroup({ key, label, items, active, rail }) {
  if (!items.length) return '';
  const rows = items.map(n => navItem(n, active === n.id, rail)).join('');
  if (!key || rail) return `<div class="sidebar__group" role="group" aria-label="${esc(label)}"><div class="sidebar__group-label" aria-hidden="true">${esc(label)}</div>${rows}</div>`;
  const here = items.some(n => n.id === active), open = here || navGroups()[key] !== false;
  const need = items.filter(n => n.count?.()), tone = need.some(n => toneOf(n) === 'danger') ? 'danger' : 'accent';
  const dot = open ? '' : badge(need.length, { tone, dot: true, label: tone === 'danger' ? 'Something needs fixing' : 'Something needs you' });
  return `<div class="sidebar__group" role="group" aria-label="${esc(label)}"><button type="button" class="sidebar__group-label sidebar__group-toggle" data-act="nav-group" data-group="${key}" aria-expanded="${open}" ${here ? 'aria-disabled="true"' : ''}><span class="sidebar__group-text">${esc(label)}</span>${dot}${here ? '' : ic('chevron-down', 'i-xs sidebar__group-chev')}</button>${open ? rows : ''}</div>`;
}
/** The sidebar toggle: collapses to the rail / expands on desktop (⌘\), closes the off-canvas sidebar below 1024 px. */
function sidebarToggle() {
  const narrow = narrowFrame(), rail = railMode();
  const label = narrow ? 'Close sidebar' : rail ? 'Expand sidebar' : 'Collapse sidebar';
  return iconBtn(narrow ? 'x' : 'panel-left', label, { act: 'nav-toggle', size: 'sm', id: 'sidebar-toggle', cls: 'sidebar__toggle', aria: `aria-expanded="${!rail}" aria-controls="sidebar" ${narrow ? '' : 'aria-keyshortcuts="Meta+Backslash Control+Backslash"'}` });
}
function sidebar() {
  const cur = S.cur, platform = cur.r.mode === 'platform', ws = curWs(), p = me(), active = NAV_OF[cur.r.nav] || cur.r.nav, rail = railMode();
  const tip = label => (rail ? `data-tip="${esc(label)}" data-tip-side="right"` : '');
  // One workspace and no console: the header is a static identity row, not a switcher with a one-item menu.
  const switcher = platform || isOperator() || workspacesForMe().length > 1;
  const wsName = platform ? 'Platform console' : ws.name;
  const mark = platform ? `<span class="ws-mark ws-mark--console" aria-hidden="true">${ic('layers', 'i-sm')}</span>` : wsMark(ws, 24);
  const ident = `${mark}<span class="grow stack ws-switch__text"><span class="ws-switch__name truncate">${esc(wsName)}</span><span class="ws-switch__meta truncate">${platform ? 'All workspaces' : 'Workspace'}</span></span>`;
  const head = switcher
    ? `<button type="button" class="ws-switch" data-menu="ws" aria-haspopup="menu" aria-expanded="false" aria-label="Switch workspace: ${esc(wsName)}" ${tip(wsName)}>${ident}${ic('chevrons', 'i-sm')}</button>`
    : `<div class="ws-switch ws-switch--static" ${tip(wsName)}>${ident}</div>`;
  // Search is the sidebar's first row (an icon in the rail); the top row offers it only while the sidebar is off-canvas.
  const search = `<div class="sidebar__search"><button type="button" class="side-search" id="side-search" data-act="palette" aria-label="Search anything (⌘K)" aria-keyshortcuts="Meta+K" ${tip('Search (⌘K)')}>${ic('search')}<span class="side-search__label">Search anything…</span>${kbd('⌘K')}</button></div>`;
  const body = platform
    ? navGroup({ label: 'Console', items: PLATFORM_NAV, active, rail }) + navGroup({ label: 'Workspace', items: [{ id: 'back', label: `Back to ${ws.name}`, icon: 'arrow-left', to: homeRoute() }], rail })
    : navGroup({ label: 'Workspace', items: memberNav(), active, rail }) + navGroup({ key: 'work', label: 'Your work', items: yourWorkNav(), active, rail }) + navGroup({ key: 'manage', label: 'Manage', items: manageNav(), active, rail });
  const foot = `<div class="sidebar__footer"><button type="button" class="user-button" data-menu="me" aria-haspopup="menu" aria-expanded="false" aria-label="Account and preferences" ${tip(p.name)}>${avatar(p.name)}<span class="grow stack user-button__text"><span class="user-button__name truncate">${esc(p.name)}</span><span class="user-button__meta truncate">${esc(p.role)}</span></span>${ic('chevrons', 'i-sm')}</button></div>`;
  return `<aside class="${cx('sidebar', rail && 'is-rail')}" id="sidebar" aria-label="Main navigation"><div class="sidebar__header">${head}${sidebarToggle()}</div>${search}<nav class="sidebar__content" aria-label="Pages">${body}</nav>${foot}</aside>`;
}
/** CompactHeader: the app's one top row. Left: the menu button (off-canvas only), then the page's context — its parents as a
    quiet trail, its title (the page's H1 for index pages; for entity and reading pages, which carry their own H1, the title
    appears once that header scrolls away), its chip and a short status line. Right: the page's actions, then global controls
    (search while the sidebar is off-canvas, Inbox). Its inner row is aligned with the page's content column (--page-max). */
function topbar() {
  const cur = S.cur, inApp = cur.r.mode === 'workspace', h = S.head || {}, list = S.crumbs || [];
  const parents = list.slice(0, -1), title = h.title || list.at(-1)?.label || '';
  const own = !!h.title && !h.hero;   // the top row holds the page's H1
  const near = [...parents].reverse().find(c => c.to);
  const back = near ? `<a class="button button--ghost button--icon-only button--sm button--muted topbar__back" href="#${near.to}" aria-label="Back to ${esc(near.label)}" data-tip="${esc(near.label)}">${ic('arrow-left')}</a>` : '';
  const trail = parents.length ? `<nav class="topbar__trail" aria-label="Breadcrumb">${parents.map(c => (c.to ? `<a class="topbar__crumb" href="#${c.to}">${esc(c.label)}</a>` : `<span class="topbar__crumb">${esc(c.label)}</span>`) + ic('chevron-right', 'i-xs topbar__chev')).join('')}</nav>` : '';
  const titleEl = !title ? '' : own ? `<h1 class="topbar__title truncate">${esc(title)}</h1>` : `<span class="topbar__title topbar__title--peek truncate" aria-hidden="true">${esc(title)}</span>`;
  const context = `<div class="topbar__context">${back}${trail}${titleEl}${own && h.extra ? `<span class="topbar__extra">${h.extra}</span>` : ''}${own && h.meta ? `<span class="topbar__meta truncate">${h.meta}</span>` : ''}</div>`;
  const actions = (h.actions || '') + (S.topbarEnd || '');
  const unread = inApp ? X.inboxUnread?.() || 0 : 0;
  const menu = iconBtn('menu', 'Open sidebar', { act: 'nav-toggle', size: 'sm', id: 'topbar-menu', cls: 'topbar__menu', aria: 'aria-controls="sidebar" aria-expanded="false"' });
  const search = iconBtn('search', 'Search anything', { act: 'palette', id: 'topbar-search', size: 'sm', cls: 'topbar-search', aria: 'aria-keyshortcuts="Meta+K"' });
  const bell = inApp ? `<a class="button button--ghost button--icon-only button--sm button--muted topbar-bell" id="topbar-inbox" href="#/inbox" data-tip="Inbox" aria-label="${unread ? `Inbox, ${unread} unread` : 'Inbox'}" ${cur.r.nav === 'inbox' ? 'aria-current="page"' : ''}>${ic('bell')}${unread ? `<span class="topbar-bell__badge" aria-hidden="true">${unread > 9 ? '9+' : unread}</span>` : ''}</a>` : '';
  return `<header class="topbar"><div class="topbar__inner">${menu}${context}<div class="topbar__end" id="topbar-end">${actions ? `<div class="topbar__actions">${actions}</div>` : ''}<div class="topbar__global">${search}${bell}</div></div></div></header>`;
}
A['nav-group'] = el => {
  if (el.getAttribute('aria-disabled') === 'true') return;
  const g = navGroups(), k = el.dataset.group; g[k] = g[k] === false;
  persist(); refresh(); $(`[data-act="nav-group"][data-group="${k}"]`)?.focus();
};

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
  body: `<dl class="kv" style="grid-template-columns:1fr auto;gap:12px 16px">${[['Search or ask', '⌘ K'], ['New chat', '⌘ ⇧ O'], ['Collapse or expand the sidebar', '⌘ \\'], ['Send message', '↵'], ['New line', '⇧ ↵'], ['Close dialog or panel', 'Esc']].map(([a, k]) => `<dt class="fg">${a}</dt><dd class="row gap-4">${k.split(' ').map(kbd).join('')}</dd>`).join('')}</dl>`,
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

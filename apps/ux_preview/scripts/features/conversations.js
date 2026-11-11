(() => {
'use strict';
/* Conversations: the list under AI Chat's composer (/chat) — the caller's conversations, searchable and filterable
   by project, with rename, move and delete (immediate, with Undo). The one conversation ⋯ menu lives here and is
   shared by those rows, project pages and the thread topbar (X.conversations.menu). */

const C = () => X.chat;
const UIK = 'chats', PER = 20;

/** Where a conversation lives: its project, else its space, else the one knowledge base it searched. */
function context(c) {
  const proj = X.projects?.of(c);
  if (proj) return { label: proj.name, icon: 'folder' };
  const sp = c.space && hasModule('spaces') && spaceById(c.space);
  if (sp) return { label: sp.name, icon: spaceType(sp.type).icon };
  const kb = (c.scope || []).map(kbById).find(k => k && canReadKb(k));
  return kb ? { label: kb.name, icon: 'book' } : null;
}
/** One level up from an open conversation (its breadcrumb parent): the project, the space, else AI Chat. */
function parentPath(c) {
  const proj = X.projects?.of(c); if (proj) return '/project/' + proj.id;
  const sp = c.space && hasModule('spaces') && spaceById(c.space); if (sp) return '/space/' + sp.id;
  return '/chat';
}

/** AI Chat's list, below the composer: title, where it lives (project / space / base), last answer, when. The whole row opens
    the conversation; ⋯ (on hover) renames, moves or deletes it. Search and the Project filter appear once the list needs them. */
function listHtml() {
  const u = ui(UIK, { q: '', project: '' });
  const all = myConvs();
  all.forEach(c => C().ensureSeed(c));
  const projects = X.projects?.list() || [];
  if (u.project && u.project !== 'none' && !projects.some(p => p.id === u.project)) u.project = '';
  const inProject = c => !u.project || (u.project === 'none' ? !X.projects?.of(c) : c.project === u.project);
  const rows = all.filter(c => inProject(c) && matchesQ(UIK, c.title, C().lastLine(c))).sort((a, b) => b.at - a.at);
  const none = () => emptyState({ icon: 'message', title: 'No conversations yet', desc: 'Ask a question above. Your conversations stay here, so you can pick one up later.', compact: true });
  const row = c => {
    const where = context(c), last = C().lastLine(c);
    return item({
      title: esc(c.title), titleExtra: where ? chip(where.label, { icon: where.icon, size: 'sm' }) : '',
      desc: last ? esc(last) : '', meta: `<span class="num" data-tip="${esc(fmtDateTime(c.at))}">${esc(rel(c.at))}</span>`,
      href: '/chat/' + c.id, cls: 'conv-row',
      trail: `<span class="reveal-on-hover">${iconBtn('more', `Options for ${c.title}`, { size: 'sm', menu: 'conv-menu', data: { id: c.id } })}</span>`,
    });
  };
  const ok = () => {
    if (!all.length) return none();
    if (!rows.length) return noMatches(UIK, ['project'], 'conversations');
    return list(paginate(rows, UIK, PER).map(row), 'conv-list') + pager(rows.length, UIK, PER);
  };
  const live = S.pageState === 'live' && !S.navLoading;
  const projFilter = projects.length ? filterButton('Project', UIK, 'project', [['none', 'No project'], ...projects.map(p => [p.id, p.name])]) : '';
  const tools = live && needsTools(all.length, UIK, ['project']) ? `<div class="conv-tools">${searchField({ uiKey: UIK, placeholder: 'Search conversations' })}${projFilter}${clearFilters(UIK, ['project'])}</div>` : '';
  const count = live && all.length ? `<span class="conv-head__count num">${fmtNum(all.length)}</span>` : '';
  return `<section class="conv-sec" aria-labelledby="conv-h">
    <div class="conv-head"><h2 class="conv-head__title" id="conv-h">Conversations</h2>${count}<span class="grow"></span>${tools}</div>
    ${gate({ ok, empty: none, loading: () => skelRows(4) })}</section>`;
}

/** The one ⋯ menu for a conversation, wherever it's shown. Rename · move to a project · Delete conversation. */
function menu(c) {
  if (!c || !C().isMine(c)) return [];
  return [
    { label: 'Rename', icon: 'pencil', run: () => A['conv-rename']({ dataset: { id: c.id } }) },
    ...(X.projects?.moveItems(c) || []),
    { sep: true },
    { label: 'Delete conversation', icon: 'trash', danger: true, run: () => A['conv-delete']({ dataset: { id: c.id } }) },
  ];
}
MENUS['conv-menu'] = el => menu(convById(el.dataset.id));

/* Rename (the name is limited by maxlength, so only "empty" needs a message) */
const vName = v => !v.trim() ? 'Enter a name.' : '';
A['conv-rename'] = el => {
  const c = convById(el.dataset.id); if (!c) return;
  S.ui.convRename = { id: c.id, title: c.title, touched: false, busy: false }; openModal('conv-rename');
  requestAnimationFrame(() => $('#conv-rename-in')?.select());
};
M['conv-rename'] = () => {
  const f = ui('convRename'), err = f.touched ? vName(f.title) : '', dis = f.busy ? 'disabled' : '';
  return { size: 'sm', icon: 'pencil', title: 'Rename conversation',
    body: field({ id: 'conv-rename-in', label: 'Name', error: err, control: input({ id: 'conv-rename-in', bind: 'convRename.title', value: f.title, autofocus: true, onEnter: 'conv-rename-save', invalid: !!err, attrs: `maxlength="80" data-live ${dis}` }) }),
    foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Rename', { v: 'primary', act: 'conv-rename-save', loading: f.busy }) };
};
A['conv-rename-save'] = async () => {
  const f = ui('convRename'); if (f.busy) return; f.touched = true;
  if (vName(f.title)) { refreshLayer(); $('#conv-rename-in')?.focus(); return; }
  const c = convById(f.id), title = f.title.trim(); if (!c || c.title === title) return closeModal();
  f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(300);
  const before = c.title; c.title = title;
  closeModal(); refresh();
  toast(`Renamed to “${title}”`, { action: { label: 'Undo', run: () => { c.title = before; refresh(); } } });
};

/* Delete: reversible, so it happens at once and Undo puts it back where it was. Deleting the open conversation goes one level up. */
A['conv-delete'] = el => {
  const c = convById(el.dataset.id); if (!c) return;
  C().stopIfIn(c.id);
  const i = D.convs.indexOf(c); if (i < 0) return;
  D.convs.splice(i, 1);
  const u = C().cui(); if (u.panel?.conv === c.id) u.panel = null;
  const wasOpen = S.cur.path === '/chat/' + c.id;
  persist();
  if (wasOpen) go(parentPath(c)); else refresh();
  toast(`Deleted “${c.title}”`, { action: { label: 'Undo', run: () => { if (!D.convs.includes(c)) D.convs.splice(Math.min(i, D.convs.length), 0, c); persist(); if (wasOpen) go('/chat/' + c.id); else refresh(); } } });
};

X.conversations = { menu, context, list: listHtml };
})();

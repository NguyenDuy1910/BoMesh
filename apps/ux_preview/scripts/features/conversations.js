(() => {
'use strict';
/* Conversations (/chats): the caller's conversations, searchable and filterable
   by project, with rename and delete (immediate, with Undo). The one conversation
   ⋯ menu lives here and is shared by /chats rows, the sidebar, project pages and
   the thread topbar (X.conversations.menu). */

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
/** One level up from an open conversation (its breadcrumb parent): the project, the space, else Conversations. */
function parentPath(c) {
  const proj = X.projects?.of(c); if (proj) return '/project/' + proj.id;
  const sp = c.space && hasModule('spaces') && spaceById(c.space); if (sp) return '/space/' + sp.id;
  return '/chats';
}

P.chats = () => {
  const u = ui(UIK, { q: '', project: '' });
  const all = myConvs();
  all.forEach(c => C().ensureSeed(c));
  const projects = X.projects?.list() || [];
  if (u.project && u.project !== 'none' && !projects.some(p => p.id === u.project)) u.project = '';
  const inProject = c => !u.project || (u.project === 'none' ? !X.projects?.of(c) : c.project === u.project);
  const found = all.filter(c => inProject(c) && matchesQ(UIK, c.title, C().lastLine(c)));
  const rows = u.sort ? applySort(found, UIK, { title: c => c.title.toLowerCase(), at: c => c.at }) : [...found].sort((a, b) => b.at - a.at);
  const none = () => emptyState({ icon: 'message', title: 'No conversations yet', desc: 'Ask a question and your conversations appear here.', actions: btn('New chat', { v: 'primary', icon: 'message-plus', href: '/chat' }), boxed: true });
  const row = c => {
    const cx_ = context(c), last = C().lastLine(c);
    const ctx = cx_ ? chip(cx_.label, { icon: cx_.icon, size: 'sm' }) : '';
    return `<tr class="table__row" data-act="conv-open" data-id="${c.id}" tabindex="0">
      <td class="table__cell table__cell--primary conv-title-cell"><div class="row gap-8"><span class="cell-title truncate">${esc(c.title)}</span>${ctx}</div>${last ? `<div class="cell-sub truncate conv-sub">${esc(last)}</div>` : ''}</td>
      <td class="table__cell table__cell--hide-sm conv-preview"><span class="muted truncate">${esc(last)}</span></td>
      <td class="table__cell conv-updated"><span class="muted num">${rel(c.at)}</span></td>
      <td class="table__cell table__cell--actions"><span class="reveal-on-hover">${iconBtn('more', `Options for ${c.title}`, { size: 'sm', menu: 'conv-menu', data: { id: c.id } })}</span></td></tr>`;
  };
  const ok = () => {
    if (!all.length) return none();
    if (!rows.length) return noMatches(UIK, ['project'], 'conversations');
    // Sorting earns its place on a long list (or once a sort is applied); a short one stays newest first.
    const sortable = needsTools(all.length, UIK, ['sort']), head = (label, key) => (sortable ? sortHead(label, key, UIK) : th(label));
    return table({ label: 'Conversations', head: head('Title', 'title') + th('Last answer', 'table__cell--hide-sm') + head('Updated', 'at') + th('<span class="sr-only">Actions</span>', 'table__column--actions'), rows: paginate(rows, UIK, PER).map(row), foot: rows.length > PER ? pager(rows.length, UIK, PER) : '' });
  };
  // Search and the Project filter earn their place once there's something to search.
  const projFilter = projects.length ? filterButton('Project', UIK, 'project', [['none', 'No project'], ...projects.map(p => [p.id, p.name])]) : '';
  const toolbar = needsTools(all.length, UIK, ['project']) ? `<div class="toolbar">${searchField({ uiKey: UIK, placeholder: 'Search conversations' })}${projFilter}${clearFilters(UIK, ['project'])}</div>` : '';
  return `<div class="page">${pageHeader({ title: 'Conversations', actions: btn('New chat', { v: 'primary', icon: 'message-plus', href: '/chat' }) })}
    ${S.pageState === 'empty' ? '' : toolbar}
    ${gate({ ok, empty: none })}</div>`;
};
A['conv-open'] = el => go('/chat/' + el.dataset.id);

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

X.conversations = { menu, context };
})();

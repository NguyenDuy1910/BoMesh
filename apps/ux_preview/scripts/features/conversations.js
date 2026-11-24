(() => {
'use strict';
/* Conversations: what every list of them shares — where one lives, the sidebar's Recent rows (shell.js recentGroup), the line that
   says when a source of one of its answers changed (chat.js, living answers), and the one conversation ⋯ menu (rename, move,
   delete — immediate, with Undo) used by those rows, project pages and the thread topbar (X.conversations.menu). An open
   conversation renames from its title instead (X.conversations.title: click to edit), so its ⋯ leaves Rename out. */

const C = () => X.chat;

/** Where a conversation lives: its project, else its space, else the one collection it searched. */
function context(c) {
  const proj = X.projects?.of(c);
  if (proj) return { label: proj.name, icon: 'folder' };
  const sp = c.space && hasModule('spaces') && spaceById(c.space);
  if (sp) return { label: sp.name, icon: spaceType(sp.type).icon };
  const kb = (c.scope || []).map(kbById).find(k => k && canReadKb(k));
  return kb ? { label: kb.name, icon: 'book' } : null;
}
/** One level up from an open conversation (where Delete lands): the project, the space, else New chat. */
function parentPath(c) {
  const proj = X.projects?.of(c); if (proj) return '/project/' + proj.id;
  const sp = c.space && hasModule('spaces') && spaceById(c.space); if (sp) return '/space/' + sp.id;
  return '/chat';
}

/** "⟳ {document} changed" when one of the conversation's answers relies on a document that changed since; '' otherwise. */
function staleLine(c) {
  const o = C().outdatedAnswers(c); if (!o.length) return '';
  const docs = C().changedSources(c, o[0]);
  return `<span class="conv-stale">${ic('retry', 'i-xs')}<span class="truncate">${docs.length > 1 ? esc(`${docs.length} sources changed`) : `<span translate="no">${esc(docTitle(docs[0]))}</span> <span>changed</span>`}</span></span>`;
}
/** The sidebar's Recent rows: the 20 most recently active conversations, newest first; title, ⟳ when an answer relies on a
    document that changed (its tooltip says which), ⋯ on hover. The open conversation is the current row. Older ones are
    found through Search and project pages. */
function sidebarRows() {
  const all = myConvs().slice().sort((a, b) => b.at - a.at).slice(0, 20);
  const open = S.cur?.r.page === 'chatThread' ? S.cur.params.id : null;
  return all.map(c => {
    C().ensureSeed(c);
    const o = C().outdatedAnswers(c), docs = o.length ? C().changedSources(c, o[0]) : [];
    const why = docs.length > 1 ? `${docs.length} sources changed` : docs.length ? `${docTitle(docs[0])} changed` : '';
    return `<div class="${cx('conv-nav', c.id === open && 'is-current')}">
      <a class="nav-item conv-nav__link" href="#/chat/${esc(c.id)}"${c.id === open ? ' aria-current="page"' : ''}><span class="nav-item__label" translate="no">${esc(c.title)}</span>${why ? `<span class="conv-nav__stale" data-tip="${esc(why)}" aria-label="${esc(why)}">${ic('retry', 'i-xs')}</span>` : ''}</a>
      <span class="conv-nav__more">${iconBtn('more', `Options for ${c.title}`, { size: 'sm', menu: 'conv-menu', data: { id: c.id } })}</span>
    </div>`;
  }).join('');
}

/** The one ⋯ menu for a conversation, wherever it's shown. Rename (rows only: the open thread renames from its title) ·
    move to a project · Delete conversation. */
function menu(c, { rename = true } = {}) {
  if (!c || !C().isMine(c)) return [];
  return [
    rename && { label: 'Rename', icon: 'pencil', run: () => A['conv-rename']({ dataset: { id: c.id } }) },
    ...(X.projects?.moveItems(c) || []),
    { sep: true },
    { label: 'Delete conversation', icon: 'trash', danger: true, run: () => A['conv-delete']({ dataset: { id: c.id } }) },
  ].filter(Boolean);
}
MENUS['conv-menu'] = el => menu(convById(el.dataset.id));

/* Rename from a row's ⋯ (a row is one link, so the name is edited in a small dialog; the name is limited by maxlength,
   so only "empty" needs a message) */
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

/* Rename an open conversation: its title in the top row is the control. Applies at once with Undo; an empty or
   unchanged name just closes. */
function titleHtml(c) {
  const u = C().cui(), on = u.renaming === c.id;
  if (!C().isMine(c)) return '';
  return editableTitle({ id: 'conv-title', value: on ? u.renameVal : c.title, editing: on, edit: 'conv-title-edit', commit: 'conv-title-done', cancel: 'conv-title-cancel', tag: 'h1', cls: 'topbar__title', label: 'Rename conversation', maxlength: 80, data: { id: c.id } });
}
A['conv-title-edit'] = el => {
  const c = convById(el.dataset.id); if (!c || !C().isMine(c)) return;
  Object.assign(C().cui(), { renaming: c.id, renameVal: c.title }); refresh();
};
A['conv-title-cancel'] = () => { const u = C().cui(); if (!u.renaming) return; u.renaming = null; refresh(); };
/** Enter or leaving the field. Idempotent: Enter re-renders, then the field loses focus. */
A['conv-title-done'] = el => {
  const u = C().cui(), c = convById(el.dataset.id); if (!c || u.renaming !== c.id) return;
  const title = el.value.trim(); u.renaming = null;
  if (!title || title === c.title) { refresh(); return; }
  const before = c.title; c.title = title; refresh();
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

X.conversations = { menu, context, staleLine, sidebarRows, title: titleHtml };
})();

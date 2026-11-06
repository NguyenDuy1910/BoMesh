(() => {
'use strict';
/* Conversations (/chats): the caller's conversations, searchable, with rename
   and delete (confirm + Undo). Rename/delete are shared with the thread topbar. */

const C = () => X.chat;
const UIK = 'chats', PER = 20;

P.chats = () => {
  const u = ui(UIK, { q: '' });
  const all = myConvs();
  all.forEach(c => C().ensureSeed(c));
  const found = all.filter(c => matchesQ(UIK, c.title, C().lastLine(c)));
  const rows = u.sort ? applySort(found, UIK, { title: c => c.title.toLowerCase(), at: c => c.at }) : [...found].sort((a, b) => b.at - a.at);
  const none = () => emptyState({ icon: 'message', title: 'No conversations yet', desc: 'Ask a question and your conversations appear here.', actions: btn('New chat', { v: 'primary', icon: 'message-plus', href: '/chat' }), boxed: true });
  const row = c => {
    const sp = c.space && hasModule('spaces') && spaceById(c.space);
    const kb = !sp && (c.scope || []).map(kbById).find(k => k && canReadKb(k)); const last = C().lastLine(c);
    const ctx = sp ? chip(sp.name, { icon: spaceType(sp.type).icon, size: 'sm' }) : kb ? chip(kb.name, { icon: 'book', size: 'sm' }) : '';
    return `<tr class="table__row" data-act="conv-open" data-id="${c.id}" tabindex="0">
      <td class="table__cell table__cell--primary conv-title-cell"><div class="row gap-8"><span class="cell-title truncate">${esc(c.title)}</span>${ctx}</div>${last ? `<div class="cell-sub truncate conv-sub">${esc(last)}</div>` : ''}</td>
      <td class="table__cell table__cell--hide-sm conv-preview"><span class="muted truncate">${esc(last)}</span></td>
      <td class="table__cell conv-updated"><span class="muted num">${rel(c.at)}</span></td>
      <td class="table__cell table__cell--actions">${iconBtn('more', 'More', { size: 'sm', menu: 'conv-row', data: { id: c.id } })}</td></tr>`;
  };
  const ok = () => {
    if (!all.length) return none();
    if (!rows.length) return noMatches(UIK, [], 'conversations');
    return table({ label: 'Conversations', head: sortHead('Title', 'title', UIK) + th('Last answer', 'table__cell--hide-sm') + sortHead('Updated', 'at', UIK) + th('<span class="sr-only">Actions</span>', 'table__column--actions'), rows: paginate(rows, UIK, PER).map(row), foot: pager(rows.length, UIK, PER) });
  };
  return `<div class="page">${pageHeader({ title: 'Conversations', actions: btn('New chat', { v: 'primary', icon: 'message-plus', href: '/chat' }) })}
    <div class="toolbar">${searchField({ uiKey: UIK, placeholder: 'Search conversations' })}</div>
    ${gate({ ok, empty: none })}</div>`;
};
A['conv-open'] = el => go('/chat/' + el.dataset.id);
MENUS['conv-row'] = el => [
  { label: 'Rename', icon: 'pencil', run: () => A['conv-rename'](el) },
  ...(X.projects?.moveItems(convById(el.dataset.id)) || []),
  { sep: true },
  { label: 'Delete', icon: 'trash', danger: true, run: () => A['conv-delete'](el) },
];

/* Rename */
const vName = v => !v.trim() ? 'Enter a name.' : v.trim().length > 80 ? 'Use 80 characters or fewer.' : '';
A['conv-rename'] = el => { const c = convById(el.dataset.id); if (!c) return; S.ui.convRename = { id: c.id, title: c.title, err: '' }; openModal('conv-rename'); };
M['conv-rename'] = p => {
  const f = ui('convRename');
  return { size: 'sm', title: 'Rename conversation',
    body: field({ id: 'conv-rename-in', label: 'Name', error: f.err, control: input({ id: 'conv-rename-in', bind: 'convRename.title', value: f.title, autofocus: true, onEnter: 'conv-rename-save', invalid: !!f.err }) }),
    foot: btn('Cancel', { act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'conv-rename-save', loading: p.busy }) };
};
A['conv-rename-save'] = async () => {
  const f = ui('convRename'), p = S.modal.props; f.err = vName(f.title);
  if (f.err) { refreshLayer(); $('#conv-rename-in')?.focus(); return; }
  p.busy = true; p.guard = true; refreshLayer(); await sleep(400);
  const c = convById(f.id); const before = c?.title; if (c) c.title = f.title.trim();
  closeModal(); refresh();
  if (c) toast('Conversation renamed', { action: { label: 'Undo', run: () => { c.title = before; refresh(); } } });
};

/* Delete (confirm, then Undo puts it back where it was) */
A['conv-delete'] = el => {
  const c = convById(el.dataset.id); if (!c) return;
  confirmAction({ title: 'Delete this conversation?', body: `“${esc(c.title)}” will be removed from your conversations.`, confirm: 'Delete', danger: true, delay: 300,
    onConfirm: () => {
      C().stopIfIn(c.id);
      const i = D.convs.indexOf(c); if (i < 0) return;
      D.convs.splice(i, 1);
      const u = C().cui(); if (u.panel?.conv === c.id) u.panel = null;
      const wasOpen = S.cur.path === '/chat/' + c.id;
      if (wasOpen) go('/chat'); else refresh();
      toast('Conversation deleted', { action: { label: 'Undo', run: () => { if (!D.convs.includes(c)) D.convs.splice(Math.min(i, D.convs.length), 0, c); if (wasOpen) go('/chat/' + c.id); else refresh(); } } });
    } });
};
})();

(() => {
'use strict';
/* Projects (/project/:id): ChatGPT-style folders for AI conversations. A
   project has a name, its conversations and references to Knowledge
   documents (attached to every new chat started in it). It is not a document
   store, a dashboard or a task list: Knowledge stays the source of truth.
   The sidebar shows Projects (expandable folders) and Recent (conversations
   in no project), so each conversation appears exactly once.
   Exports: X.projects { sidebar, of, byId, refs, moveItems }.
   Actions: proj-*. Modal: proj-name. Menus: proj-row, conv-nav. */

const MAX_REFS = 10, KIDS = 6, RECENT = 8;
const C = () => X.chat;
const mine = p => !p.owner || p.owner === me().id;
/** Projects the caller can see: seeded demo folders plus their own, most recently used first. */
const all = () => (D.projects ??= []);
const convsIn = p => myConvs().filter(c => c.project === p.id).sort((a, b) => b.at - a.at);
const lastAt = p => Math.max(p.created || 0, ...convsIn(p).map(c => c.at));
const myProjects = () => all().filter(mine).sort((a, b) => lastAt(b) - lastAt(a));
const byId = id => all().find(p => p.id === id && mine(p)) || null;
const of = c => (c?.project ? byId(c.project) : null);
/** Knowledge references the caller can open, as composer attachments. Unreadable ones are never shown or attached. */
const readableDocs = p => (p?.docs || []).map(docById).filter(d => d && canOpenRes(d));
const refs = pid => readableDocs(byId(pid)).map(d => ({ name: d.name, type: d.type, kind: 'ref', doc: d.id, ready: true }));
const nav = () => ui('projNav', { open: {} });
const save = () => { persist(); refresh(); };

/* ═══════════════ Sidebar ═══════════════ */
function convLink(c, cur, sub) {
  const here = cur.path === '/chat/' + c.id;
  return `<div class="${cx('side-conv', sub && 'side-conv--sub')}"><a class="nav-item nav-item--recent" href="#/chat/${esc(c.id)}" ${here ? 'aria-current="page"' : ''} title="${esc(c.title)}"><span class="nav-item__label">${esc(c.title)}</span></a>${iconBtn('more', `Options for ${c.title}`, { size: 'sm', menu: 'conv-nav', data: { id: c.id }, cls: 'side-more' })}</div>`;
}
/** Projects (folders, expandable) and Recent (conversations in no project). */
function sidebar(cur) {
  const u = nav(), conv = cur.r.page === 'chatThread' ? convById(cur.params.id) : null;
  const active = cur.r.page === 'project' ? cur.params.id : conv?.project;
  const projects = myProjects();
  const folders = projects.map(p => {
    const open = u.open[p.id] ?? p.id === active, convs = convsIn(p), here = cur.path === '/project/' + p.id;
    const kids = open ? `<div class="side-kids" role="group" aria-label="${esc(p.name)}">${convs.slice(0, KIDS).map(c => convLink(c, cur, true)).join('')}${convs.length > KIDS ? `<a class="nav-item nav-item--recent side-kids__more" href="#/project/${esc(p.id)}"><span class="nav-item__label">See all ${fmtNum(convs.length)}</span></a>` : ''}<a class="nav-item nav-item--recent side-kids__new" href="#/project/${esc(p.id)}" ${here ? 'aria-current="page"' : ''}>${ic('message-plus', 'i-sm')}<span class="nav-item__label">New chat</span></a></div>` : '';
    return `<div class="side-proj"><div class="side-conv"><button type="button" class="nav-item side-proj__toggle" id="side-proj-${esc(p.id)}" data-act="proj-toggle" data-id="${esc(p.id)}" aria-expanded="${open}" title="${esc(p.name)}">${ic(open ? 'folder-open' : 'folder')}<span class="nav-item__label">${esc(p.name)}</span></button>${iconBtn('more', `Options for ${p.name}`, { size: 'sm', menu: 'proj-row', data: { id: p.id }, cls: 'side-more' })}</div>${kids}</div>`;
  }).join('') || `<button type="button" class="nav-item nav-item--recent" data-act="proj-new">${ic('folder-plus', 'i-sm')}<span class="nav-item__label">New project</span></button>`;
  const loose = myConvs().filter(c => !of(c)).sort((a, b) => b.at - a.at);
  const recent = loose.length ? `<div class="sidebar__group"><div class="sidebar__group-label"><span>Recent</span><a href="#/chats" ${cur.r.nav === 'chats' ? 'aria-current="page"' : ''}>All</a></div>${loose.slice(0, RECENT).map(c => convLink(c, cur, false)).join('')}</div>` : '';
  return `<div class="sidebar__group"><div class="sidebar__group-label"><span>Projects</span>${iconBtn('plus', 'New project', { size: 'sm', act: 'proj-new', cls: 'side-add' })}</div>${folders}</div>${recent}`;
}

/* ═══════════════ Project page: start a chat, its Knowledge, its chats ═══════════════ */
P.project = ({ params }) => {
  const p = byId(params.id);
  if (!p) {
    crumbs([{ label: 'Project not found' }]);
    return `<div class="page">${emptyState({ icon: 'folder', title: 'This project isn’t available', desc: 'It may have been deleted, or it belongs to someone else.', actions: btn('Home', { v: 'primary', href: '/home' }), boxed: true })}</div>`;
  }
  crumbs([{ label: p.name }]);
  const key = 'proj:' + p.id, c = C().composer(key), docs = readableDocs(p), convs = convsIn(p);
  convs.forEach(x => C().ensureSeed(x));
  const docChips = docs.map(d => `<span class="proj-doc"><a class="proj-doc__link" href="#/doc/${esc(d.id)}" title="${esc(d.name)}">${fileIcon(d.type, 'sm')}<span class="truncate">${esc(d.name.replace(/\.[a-z0-9]{1,5}$/i, ''))}</span></a>${iconBtn('x', `Remove ${d.name} from this project`, { size: 'sm', act: 'proj-doc-remove', data: { id: p.id, doc: d.id }, cls: 'proj-doc__x' })}</span>`).join('');
  const knowledge = `<section class="proj-sec" aria-labelledby="proj-docs-h"><div class="proj-sec__head"><h2 class="proj-sec__title" id="proj-docs-h">Knowledge</h2><span class="proj-sec__note">${docs.length ? 'Attached to every new chat here' : ''}</span><span class="grow"></span>${docs.length < MAX_REFS ? btn('Add', { v: 'ghost', size: 'sm', icon: 'plus', act: 'proj-docs-add', data: { id: p.id } }) : ''}</div>
    ${docs.length ? `<div class="proj-docs">${docChips}</div>` : `<p class="proj-empty">Add documents from Knowledge to use them in every chat in this project. Nothing is copied; access rules still apply.</p>`}</section>`;
  const chats = `<section class="proj-sec" aria-labelledby="proj-chats-h"><div class="proj-sec__head"><h2 class="proj-sec__title" id="proj-chats-h">Chats</h2></div>
    ${convs.length ? `<div class="proj-chats">${convs.map(x => { const last = C().lastLine(x); return `<div class="proj-chat"><a class="proj-chat__link" href="#/chat/${esc(x.id)}"><span class="proj-chat__title truncate">${esc(x.title)}</span>${last ? `<span class="proj-chat__last truncate">${esc(last)}</span>` : ''}</a><span class="proj-chat__at">${esc(rel(x.at))}</span>${iconBtn('more', `Options for ${x.title}`, { size: 'sm', menu: 'conv-nav', data: { id: x.id } })}</div>`; }).join('')}</div>`
      : `<p class="proj-empty">Chats you start here stay in this project. You can also move a chat here from its ⋯ menu.</p>`}</section>`;
  return `<div class="page page--narrow proj">
    <header class="proj-head"><span class="proj-head__icon" aria-hidden="true">${ic('folder')}</span><h1 class="proj-head__title">${esc(p.name)}</h1>${iconBtn('more', 'Project options', { menu: 'proj-row', data: { id: p.id } })}</header>
    <div class="proj-ask chat-drop" data-drop="${esc(key)}">${C().composerHtml({ key, holder: c, placeholder: `New chat in ${p.name}`, lg: true })}</div>
    ${knowledge}${chats}
  </div>`;
};
AFTER.project = ({ changed }) => C().afterComposer(changed);

/* ═══════════════ Create, rename, delete ═══════════════ */
const vName = v => (!v.trim() ? 'Enter a name.' : v.trim().length > 60 ? 'Use 60 characters or fewer.' : '');
/** Ask for the name only. props: id (rename) or conv (create and move that conversation into it). */
function openName(props = {}) { const p = props.id && byId(props.id); S.ui.projName = { name: p ? p.name : '', err: '' }; openModal('proj-name', props); }
M['proj-name'] = props => {
  const f = ui('projName');
  return {
    size: 'sm', title: props.id ? 'Rename project' : 'New project',
    body: field({ id: 'proj-name-in', label: 'Name', error: f.err, control: input({ id: 'proj-name-in', bind: 'projName.name', value: f.name, autofocus: true, onEnter: 'proj-name-save', invalid: !!f.err, attrs: 'maxlength="60"' }) }),
    foot: btn('Cancel', { act: 'close-modal' }) + btn(props.id ? 'Save' : 'Create', { v: 'primary', act: 'proj-name-save' }),
  };
};
A['proj-name-save'] = () => {
  const f = ui('projName'), props = S.modal?.props || {}; f.err = vName(f.name);
  if (f.err) { refreshLayer(); $('#proj-name-in')?.focus(); return; }
  const name = f.name.trim();
  if (props.id) {
    const p = byId(props.id); if (!p) return closeModal();
    const before = p.name; p.name = name; closeModal(); save();
    toast('Project renamed', { action: { label: 'Undo', run: () => { p.name = before; save(); } } });
    return;
  }
  const p = { id: uid('pj'), owner: me().id, name, created: Date.now(), docs: [] };
  all().unshift(p); nav().open[p.id] = true; closeModal();
  const conv = props.conv && convById(props.conv);
  if (conv) { conv.project = p.id; save(); toast(`Moved to “${name}”`); return; }
  persist(); go('/project/' + p.id);
};
A['proj-new'] = () => openName();
A['proj-toggle'] = el => { const u = nav(), id = el.dataset.id, cur = S.cur, conv = cur.r.page === 'chatThread' ? convById(cur.params.id) : null; const active = cur.r.page === 'project' ? cur.params.id : conv?.project; u.open[id] = !(u.open[id] ?? id === active); refresh(); };
/** Delete keeps the conversations: they move back to Recent. Undo restores the project and its conversations. */
function remove(p) {
  const convs = convsIn(p);
  confirmAction({
    title: `Delete “${p.name}”?`, confirm: 'Delete project', danger: true, delay: 0,
    body: convs.length ? `Its ${plural(convs.length, 'conversation')} move to Recent. Knowledge documents are not affected.` : 'Knowledge documents are not affected.',
    onConfirm: () => {
      const i = all().indexOf(p); if (i < 0) return;
      all().splice(i, 1); convs.forEach(c => delete c.project);
      const here = S.cur.path === '/project/' + p.id;
      persist(); if (here) go('/home'); else refresh();
      toast(`Deleted “${p.name}”`, { action: { label: 'Undo', run: () => { all().splice(Math.min(i, all().length), 0, p); convs.forEach(c => (c.project = p.id)); persist(); if (here) go('/project/' + p.id); else refresh(); } } });
    },
  });
}
MENUS['proj-row'] = el => {
  const p = byId(el.dataset.id); if (!p) return [];
  return [
    S.cur.path !== '/project/' + p.id && { label: 'New chat in project', icon: 'message-plus', run: () => go('/project/' + p.id) },
    { label: 'Rename', icon: 'pencil', run: () => openName({ id: p.id }) },
    { sep: true },
    { label: 'Delete project', icon: 'trash', danger: true, run: () => remove(p) },
  ].filter(Boolean);
};

/* ═══════════════ Organize conversations ═══════════════ */
function move(conv, pid) {
  const before = conv.project; if (before === pid) return;
  if (pid) conv.project = pid; else delete conv.project;
  save();
  const p = pid && byId(pid);
  toast(p ? `Moved to “${p.name}”` : 'Removed from the project', { action: { label: 'Undo', run: () => { if (before) conv.project = before; else delete conv.project; save(); } } });
}
/** Menu items to file a conversation: other projects, a new one, or back to Recent. */
function moveItems(conv) {
  if (!conv || !C().isMine(conv)) return [];
  const others = myProjects().filter(p => p.id !== conv.project);
  return [
    { section: conv.project ? 'Move to another project' : 'Move to project' },
    ...others.slice(0, 8).map(p => ({ label: p.name, icon: 'folder', run: () => move(conv, p.id) })),
    { label: 'New project…', icon: 'folder-plus', run: () => openName({ conv: conv.id }) },
    conv.project && { label: 'Remove from project', icon: 'x', run: () => move(conv, null) },
  ].filter(Boolean);
}
MENUS['conv-nav'] = el => {
  const c = convById(el.dataset.id); if (!c) return [];
  return [
    { label: 'Rename', icon: 'pencil', run: () => A['conv-rename']?.({ dataset: { id: c.id } }) },
    ...moveItems(c),
    { sep: true },
    { label: 'Delete', icon: 'trash', danger: true, run: () => A['conv-delete']?.({ dataset: { id: c.id } }) },
  ];
};

/* ═══════════════ Knowledge references ═══════════════ */
A['proj-docs-add'] = el => { S.ui.wkPick = { q: '', sel: {}, project: el.dataset.id }; openModal('wk-pick'); };
A['proj-doc-remove'] = el => {
  const p = byId(el.dataset.id); if (!p) return;
  const i = p.docs.indexOf(el.dataset.doc); if (i < 0) return;
  p.docs.splice(i, 1); save();
  toast('Removed from the project', { action: { label: 'Undo', run: () => { p.docs.splice(i, 0, el.dataset.doc); save(); } } });
};
/** Add picked documents to a project (called by the Knowledge picker). */
function addDocs(pid, ids) {
  const p = byId(pid); if (!p) return 0;
  const fresh = ids.filter(id => !p.docs.includes(id) && canOpenRes(docById(id))).slice(0, MAX_REFS - p.docs.length);
  p.docs.push(...fresh); persist();
  return fresh.length;
}

X.projects = { sidebar, of, byId, refs, moveItems, addDocs, room: pid => MAX_REFS - (byId(pid)?.docs.length || 0), docIds: pid => byId(pid)?.docs || [] };
})();

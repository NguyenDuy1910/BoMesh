(() => {
'use strict';
/* Projects (/projects, /project/:id): ChatGPT-style folders for AI conversations.
   A project has a name, its conversations and its project documents (references
   to Knowledge documents, attached to every new chat started in it — shown as
   removable chips in the project's composer). It is not a document store, a
   dashboard or a task list: Knowledge stays the source of truth.
   /projects lists your folders (Your work → Projects in the sidebar); the
   sidebar never lists folders or conversations inline. Every conversation is
   also in AI Chat, so moving one out of a project never loses it.
   Exports: X.projects { of, byId, refs, moveItems, addDocs, list, max, room, docIds }.
   Actions: proj-*. Modal: proj-name. Menus: proj-row (conversation rows use conv-menu). */

const MAX_REFS = 10;
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
const save = () => { persist(); refresh(); };

/* ═══════════════ Projects page: your folders, most recently used first ═══════════════ */
P.projects = () => {
  const uk = 'projList', projects = myProjects(), tools = needsTools(projects.length, uk);
  const rows = projects.filter(p => matchesQ(uk, p.name));
  const row = p => {
    const n = convsIn(p).length, docs = readableDocs(p).length;
    return item({
      lead: itemIcon('folder', '', 'sm'), title: esc(p.name), href: '/project/' + p.id,
      desc: esc([plural(n, 'conversation'), plural(docs, 'document')].join(' · ')),
      meta: esc(rel(lastAt(p))),
      trail: `<span class="reveal-on-hover">${iconBtn('more', `Options for ${p.name}`, { size: 'sm', menu: 'proj-row', data: { id: p.id } })}</span>`,
    });
  };
  const empty = () => emptyState({ icon: 'folder', title: 'No projects yet', desc: 'A project keeps related chats together, with the documents every new chat in it starts from. Only you can see your projects.', actions: btn('New project', { v: 'primary', icon: 'folder-plus', act: 'proj-new' }), boxed: true });
  // The empty state carries the one New project; with folders it moves to the header.
  const head = pageHeader({ title: 'Projects', actions: projects.length ? btn('New project', { v: 'primary', icon: 'folder-plus', act: 'proj-new' }) : '' });
  const body = gate({
    empty,
    ok: () => !projects.length ? empty()
      : (tools ? `<div class="toolbar">${searchField({ uiKey: uk, placeholder: 'Search projects' })}</div>` : '')
        + (rows.length ? list(rows.map(row), 'proj-list') : noMatches(uk, [], 'projects')),
  });
  return `<div class="page page--narrow">${head}${body}</div>`;
};

/* ═══════════════ Project page: start a chat (with the project documents attached), its documents, its conversations ═══════════════ */
P.project = ({ params }) => {
  const p = byId(params.id);
  if (!p) {
    crumbs([{ label: 'Projects', to: '/projects' }, { label: 'Project not found' }]);
    return `<div class="page">${emptyState({ icon: 'folder', title: 'This project isn’t available', desc: 'It may have been deleted, or it belongs to someone else.', actions: btn('Your projects', { v: 'primary', href: '/projects' }) + btn('AI Chat', { href: '/chat' }), boxed: true })}</div>`;
  }
  crumbs([{ label: 'Projects', to: '/projects' }, { label: p.name }]);
  const key = 'proj:' + p.id, c = C().composer(key), docs = readableDocs(p), convs = convsIn(p);
  convs.forEach(x => C().ensureSeed(x));
  const docChips = docs.map(d => `<span class="proj-doc" data-reveal-root><a class="proj-doc__link" href="#/doc/${esc(d.id)}" data-tip="${esc(d.name)}">${fileIcon(d.type, 'sm')}<span class="truncate">${esc(bareName(d.name))}</span></a><span class="reveal-on-hover">${iconBtn('x', `Remove ${d.name} from this project`, { size: 'sm', act: 'proj-doc-remove', data: { id: p.id, doc: d.id }, cls: 'proj-doc__x' })}</span></span>`).join('');
  // Empty: one clear, clickable invitation instead of a hint plus a separate button. With documents: chips plus a quiet Add.
  const addBtn = docs.length && docs.length < MAX_REFS ? btn('Add', { v: 'ghost', size: 'sm', icon: 'plus', act: 'proj-docs-add', data: { id: p.id } }) : docs.length ? `<span class="proj-sec__note">${MAX_REFS} of ${MAX_REFS}</span>` : '';
  const knowledge = `<section class="proj-sec" aria-labelledby="proj-docs-h"><div class="proj-sec__head"><h2 class="proj-sec__title" id="proj-docs-h">Project documents</h2><span class="proj-sec__note">${docs.length ? 'Every new chat here starts with these' : ''}</span><span class="grow"></span>${addBtn}</div>
    ${docs.length ? `<div class="proj-docs">${docChips}</div>` : `<button type="button" class="proj-add" data-act="proj-docs-add" data-id="${esc(p.id)}"><span class="proj-add__icon" aria-hidden="true">${ic('book')}</span><span class="proj-add__body"><span class="proj-add__title">Add documents from Knowledge</span><span class="proj-add__desc">Every new chat here starts with them. Nothing is copied; access rules still apply.</span></span>${ic('plus', 'proj-add__go')}</button>`}</section>`;
  const chats = `<section class="proj-sec" aria-labelledby="proj-chats-h"><div class="proj-sec__head"><h2 class="proj-sec__title" id="proj-chats-h">Conversations</h2>${convs.length ? `<span class="proj-sec__count num">${fmtNum(convs.length)}</span>` : ''}</div>
    ${convs.length ? `<div class="proj-chats">${convs.map(x => { const last = C().lastLine(x); return `<div class="proj-chat" data-reveal-root><a class="proj-chat__link" href="#/chat/${esc(x.id)}"><span class="proj-chat__title truncate">${esc(x.title)}</span>${last ? `<span class="proj-chat__last truncate">${esc(last)}</span>` : ''}</a><span class="proj-chat__at">${esc(rel(x.at))}</span><span class="reveal-on-hover">${iconBtn('more', `Options for ${x.title}`, { size: 'sm', menu: 'conv-menu', data: { id: x.id }, cls: 'proj-chat__more' })}</span></div>`; }).join('')}</div>`
      : `<p class="proj-empty">Conversations you start here stay in this project. You can also move one here from its ⋯ menu.</p>`}</section>`;
  return `<div class="page page--narrow proj">
    <header class="proj-head"><span class="proj-head__icon" aria-hidden="true">${ic('folder')}</span><h1 class="proj-head__title">${esc(p.name)}</h1>${iconBtn('more', 'Project options', { menu: 'proj-row', data: { id: p.id } })}</header>
    <div class="proj-ask chat-drop" data-drop="${esc(key)}">${C().composerHtml({ key, holder: c, placeholder: `New chat in ${p.name}`, lg: true })}</div>
    ${knowledge}${chats}
  </div>`;
};
AFTER.project = ({ changed }) => C().afterComposer(changed);

/* ═══════════════ Create, rename, delete ═══════════════ */
/** Name check: required, and unique among your projects so the sidebar never shows two identical folders. */
const vName = (v, id) => (!v.trim() ? 'Enter a name.' : myProjects().some(p => p.id !== id && p.name.trim().toLowerCase() === v.trim().toLowerCase()) ? 'You already have a project with this name.' : '');
/** Ask for the name only. props: id (rename) or conv (create and move that conversation into it). */
function openName(props = {}) {
  const p = props.id && byId(props.id); S.ui.projName = { name: p ? p.name : '', touched: false, busy: false }; openModal('proj-name', props);
  if (p) requestAnimationFrame(() => $('#proj-name-in')?.select());
}
M['proj-name'] = props => {
  const f = ui('projName'), err = f.touched ? vName(f.name, props.id) : '', dis = f.busy ? 'disabled' : '';
  const conv = !props.id && props.conv && convById(props.conv);
  const name = field({ id: 'proj-name-in', label: 'Name', error: err, desc: conv ? `“${esc(conv.title)}” moves into it.` : props.id ? '' : 'Only you can see your projects.', control: input({ id: 'proj-name-in', bind: 'projName.name', value: f.name, placeholder: props.id ? '' : 'e.g. Quarterly access review', autofocus: true, onEnter: 'proj-name-save', invalid: !!err, attrs: `maxlength="60" data-live ${dis}` }) });
  const cancel = btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy });
  if (props.id) return { size: 'sm', icon: 'pencil', title: 'Rename project', body: name, foot: cancel + btn('Rename', { v: 'primary', act: 'proj-name-save', loading: f.busy }) };
  return {
    size: 'sm', icon: 'folder-plus', title: 'Create project',
    desc: 'Keep related chats together, with the knowledge every new chat starts from.',
    body: name,
    foot: cancel + btn('Create project', { v: 'primary', icon: 'plus', act: 'proj-name-save', loading: f.busy }),
  };
};
A['proj-name-save'] = async () => {
  const f = ui('projName'), props = S.modal?.props || {}; if (f.busy) return;
  f.touched = true;
  if (vName(f.name, props.id)) { refreshLayer(); $('#proj-name-in')?.focus(); return; }
  const name = f.name.trim();
  if (props.id) {
    const p = byId(props.id); if (!p || p.name === name) return closeModal();
    f.busy = true; props.guard = true; refreshLayer(); await sleep(300);
    const before = p.name; p.name = name; closeModal(); save();
    toast(`Renamed to “${name}”`, { action: { label: 'Undo', run: () => { p.name = before; save(); } } });
    return;
  }
  f.busy = true; props.guard = true; refreshLayer(); await sleep(400);
  const p = { id: uid('pj'), owner: me().id, name, created: Date.now(), docs: [] };
  all().unshift(p); closeModal();
  const conv = props.conv && convById(props.conv);
  if (conv) { const before = conv.project; conv.project = p.id; save(); toast(`Moved to “${name}”`, { action: { label: 'Undo', run: () => { if (before) conv.project = before; else delete conv.project; save(); } } }); return; }
  persist(); go('/project/' + p.id);
  toast(`Created “${name}”`);
};
A['proj-new'] = () => openName();
/** Delete is reversible (its conversations stay in AI Chat, documents stay in Knowledge): it happens at once, Undo restores
    the project and its conversations. Deleting the open project goes one level up, to Projects. */
function remove(p) {
  const convs = convsIn(p), i = all().indexOf(p); if (i < 0) return;
  all().splice(i, 1); convs.forEach(c => delete c.project);
  const here = S.cur.path === '/project/' + p.id;
  persist(); if (here) go('/projects'); else refresh();
  toast(convs.length ? `Deleted “${p.name}”. Its ${plural(convs.length, 'conversation')} stay in AI Chat.` : `Deleted “${p.name}”`, { action: { label: 'Undo', run: () => { all().splice(Math.min(i, all().length), 0, p); convs.forEach(c => (c.project = p.id)); persist(); if (here) go('/project/' + p.id); else refresh(); } } });
}
/* The project page is where new chats in it start (its row on Projects opens it), so the menu only holds what the row can't do. */
MENUS['proj-row'] = el => {
  const p = byId(el.dataset.id); if (!p) return [];
  return [
    { label: 'Rename', icon: 'pencil', run: () => openName({ id: p.id }) },
    { sep: true },
    { label: 'Delete project', icon: 'trash', danger: true, run: () => remove(p) },
  ];
};

/* ═══════════════ Organize conversations ═══════════════ */
function move(conv, pid) {
  const before = conv.project; if (before === pid) return;
  if (pid) conv.project = pid; else delete conv.project;
  save();
  const p = pid && byId(pid);
  toast(p ? `Moved to “${p.name}”` : 'Removed from the project', { action: { label: 'Undo', run: () => { if (before) conv.project = before; else delete conv.project; save(); } } });
}
/** Menu items to file a conversation: other projects, a new one, or out of its project (it stays in AI Chat). */
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

X.projects = { of, byId, refs, moveItems, addDocs, list: myProjects, max: MAX_REFS, room: pid => MAX_REFS - (byId(pid)?.docs.length || 0), docIds: pid => byId(pid)?.docs || [] };
})();

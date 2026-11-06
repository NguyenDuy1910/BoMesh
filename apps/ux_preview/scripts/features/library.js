/* My library (/knowledge/library?tab=saved|recent|contributions|files|collections)
   and one collection (/knowledge/collections/:id): the personal side of
   Knowledge — saved resources, recent reads, your contributions and where they
   stand, My files and My collections (the reading lists you made). Collections
   others share with you are in Browse ("Shared with you"); saved views are in
   Browse's Views. Each tab carries its own one action (Contributions →
   Contribute, My files → Upload, My collections → New collection). Uses X.res
   (resources.js), X.ctb + DR['ctb'] (contribute.js), core/catalog.js and
   core/lifecycle.js. Prefix: lib-, col-. */
(() => {
  'use strict';

  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const mine = key => { const m = (D[key] ??= {}); return (m[me().id] ??= []); };
  const personalKb = () => visibleKbs().find(k => k.personal);
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const dot = '<span class="res-dot" aria-hidden="true">·</span>';
  const libHref = tab => '/knowledge/library?tab=' + tab;
  /** Search, sort, filters and bulk selection appear once a list is long enough to need them (core TOOLS_MIN), or while one is in use. */
  const longOr = (n, active) => n >= TOOLS_MIN || !!active;

  /* ═══════════════ My library ═══════════════ */
  const TABS = [['saved', 'Saved'], ['recent', 'Recent'], ['contributions', 'Contributions'], ['files', 'My files'], ['collections', 'My collections']];
  const SAVED_SORTS = { saved: 'Recently saved', updated: 'Recently updated', title: 'Title A–Z' };
  /** A tab's one action, at the end of its toolbar. */
  const tabBar = (start, action) => `<div class="toolbar lib-bar">${start}${action ? `<div class="toolbar__end">${action}</div>` : ''}</div>`;

  P.library = ({ query }) => {
    // The Knowledge tabs say where you are: no breadcrumb trail on top of them.
    const kb = personalKb(), ctb = myContributions();
    const counts = { saved: savedResources().length, recent: recentResources().length, contributions: ctb.length, files: kb ? docsIn(kb.id).length : 0, collections: myCollections().length };
    const shown = { files: !!kb, contributions: canContribute() || ctb.length > 0 };
    // Contributions: when something waits on you, the tab shows that number (highlighted), not the total.
    const waiting = ctb.filter(d => stageOf(d) === 'changes').length;
    const list = TABS.filter(([id]) => shown[id] ?? true).map(([id, label]) => ({ id, label, count: id === 'contributions' && waiting ? waiting : counts[id], alert: id === 'contributions' && waiting > 0 }));
    const tab = list.some(t => t.id === query.tab) ? query.tab : 'saved';
    // No header action: each tab has its own (Saved and Recent need none).
    const head = X.res.hubHeader('library');
    const body = { saved: savedTab, recent: recentTab, contributions: contributionsTab, files: filesTab, collections: collectionsTab }[tab](kb);
    return `<div class="page lib">${head}<div class="page-tabs lib-tabs">${tabs(list, tab, '/knowledge/library', { label: 'My library' })}</div>${body}</div>`;
  };
  /** ?open=<id> (inbox, reader "Track") opens that contribution once, then leaves the address clean. */
  AFTER.library = ({ query }) => {
    if (query.tab !== 'contributions' || !query.open) return;
    const id = query.open, q = { ...query }; delete q.open;
    history.replaceState(null, '', '#' + S.cur.path + '?' + new URLSearchParams(q).toString());
    S.cur.query = q;
    if (docById(id)) openDrawer('ctb', { id });
  };

  /* ── Contributions: what you shared, where it stands, what to do next ── */
  const CTB_GROUPS = [['all', 'All', null], ['changes', 'Needs your action', ['changes']], ['review', 'In review', ['analyzing', 'review']],
    ['published', 'Published', ['published', 'publishing', 'queued', 'merged', 'failed', 'update', 'stored']], ['rejected', LIFECYCLE.rejected.label, ['rejected']]];
  /** The one row action, only when the contribution waits on you. Everything else (Withdraw, Remove, Open) is in its panel. */
  const ctbAction = d => (lifecycleOf(d).key === 'changes' ? btn('Revise', { v: 'secondary', size: 'sm', icon: 'pencil', act: 'ctb-revise', data: { id: d.id } }) : '');
  function contributionsTab() {
    const uk = 'libCtb', u = ui(uk, { seg: 'all' });
    const all = myContributions();
    const group = CTB_GROUPS.find(g => g[0] === u.seg) || CTB_GROUPS[0];
    const rows = all.filter(d => (!group[2] || group[2].includes(lifecycleOf(d).key)) && matchesQ(uk, d.name, kbById(d.kb)?.name));
    const contribute = canContribute() ? btn('Contribute', { v: 'primary', size: 'sm', icon: 'upload', act: 'contribute' }) : '';
    const empty = () => emptyState({ icon: 'upload', title: 'No contributions yet', desc: 'Share a document with your team. A reviewer checks it before it’s published.', actions: btn('Contribute', { v: 'primary', icon: 'upload', act: 'contribute' }), boxed: true });
    return gate({
      loading: () => skelRows(4), empty,
      ok: () => {
        if (!all.length) return canContribute() ? empty() : '';
        const n = key => all.filter(d => CTB_GROUPS.find(g => g[0] === key)[2].includes(lifecycleOf(d).key)).length;
        const opts = CTB_GROUPS.map(([id, label]) => [id, id === 'changes' && n('changes') ? `${label} (${n('changes')})` : label]);
        const tools = longOr(all.length, u.seg !== 'all' || u.q) ? `<div class="lib-ctb-seg">${seg({ value: group[0], options: opts, act: 'lib-ctb-seg', label: 'Show' })}</div>${searchField({ uiKey: uk, placeholder: 'Search contributions' })}` : '';
        const toolbar = tabBar(tools, contribute);
        if (!rows.length) return toolbar + noMatches(uk, ['seg'], 'contributions');
        return toolbar + list(rows.map(d => item({
          lead: fileIcon(d.type), title: esc(docTitle(d)), titleExtra: lifeChip(d, 'sm'),
          desc: `<span class="lib-ctb__desc"><span class="lib-ctb__kb">${esc(kbById(d.kb)?.name || '—')}</span>${dot}<span class="truncate">${esc(X.ctb.eventLine(d))}</span></span>`,
          trail: ctbAction(d), act: 'ctb-open', data: { id: d.id }, cls: 'lib-ctb',
        })), 'lib-list');
      },
    });
  }
  A['lib-ctb-seg'] = el => { ui('libCtb').seg = el.dataset.value; refresh(); };

  /* ── Saved ── */
  function savedTab() {
    const uk = 'libSaved', u = ui(uk, { sort: 'saved', sel: {} });
    const all = savedResources();
    const toks = tokens(u.q || '');
    let rows = all.filter(d => !toks.length || scoreRes(d, toks) > 0);
    if (u.sort === 'updated') rows = [...rows].sort((a, b) => b.updated - a.updated);
    else if (u.sort === 'title') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    const empty = () => emptyState({ icon: 'bookmark', title: 'Nothing saved yet', desc: 'Save resources you come back to. They stay here.', actions: btn('Browse knowledge', { v: 'primary', href: '/knowledge' }), boxed: true });
    const ids = new Set(all.map(d => d.id)); const sel = selIds(uk).filter(id => ids.has(id));
    const tools = longOr(all.length, u.q || sel.length);
    const toolbar = tools ? `<div class="toolbar">${searchField({ uiKey: uk, placeholder: 'Search saved' })}<div class="toolbar__end">${btn(SAVED_SORTS[u.sort] || SAVED_SORTS.saved, { v: 'ghost', size: 'sm', icon: 'sort', menu: 'lib-sort', aria: `aria-label="Sort: ${esc(SAVED_SORTS[u.sort])}"` })}</div></div>` : '';
    return gate({
      loading: () => skelRows(6), empty,
      ok: () => {
        if (!all.length) return empty();
        // Short lists act per row (⋯); selecting several only helps in a long one.
        const listHtml = rows.length ? X.res.rows(rows, { q: u.q || '', select: tools ? uk : undefined }) : noMatches(uk, [], 'saved resources');
        const bar = sel.length ? bulkBar(uk, btn('Add to collection', { v: 'ghost', size: 'sm', icon: 'list-plus', act: 'res-collect', data: { ids: sel.join(',') } }) + btn('Remove from saved', { v: 'ghost', size: 'sm', icon: 'bookmark', act: 'lib-unsave' })) : '';
        return toolbar + listHtml + bar;
      },
    });
  }
  MENUS['lib-sort'] = () => [{ section: 'Sort by' }, ...Object.entries(SAVED_SORTS).map(([v, l]) => ({ label: l, checked: ui('libSaved').sort === v, run: () => { ui('libSaved').sort = v; refresh(); } }))];
  A['lib-unsave'] = () => {
    const u = ui('libSaved'), ids = selIds('libSaved'), l = mine('saved'), before = [...l];
    const n = ids.filter(id => l.includes(id)).length; if (!n) return;
    D.saved[me().id] = l.filter(id => !ids.includes(id)); u.sel = {}; persist(); refresh();
    toast(`Removed ${plural(n, 'resource')} from saved`, { action: { label: 'Undo', run: () => { D.saved[me().id] = before; persist(); refresh(); } } });
  };

  /* ── Recent ── */
  function recentTab() {
    const all = recentResources();
    const empty = () => emptyState({ icon: 'history', title: 'No recent reads', desc: 'Resources you open show up here.', actions: btn('Browse knowledge', { v: 'primary', href: '/knowledge' }), boxed: true });
    return gate({
      loading: () => skelRows(6), empty,
      ok: () => {
        if (!all.length) return empty();
        const start = new Date(); start.setHours(0, 0, 0, 0);
        const today = start.getTime(), week = today - 6 * DAY;
        const groups = [['Today', x => x.at >= today], ['This week', x => x.at < today && x.at >= week], ['Earlier', x => x.at < week]];
        const html = groups.map(([label, fn]) => {
          const items = all.filter(fn); if (!items.length) return '';
          return `<section class="lib-group"><h2 class="lib-group__title">${esc(label)}</h2>${X.res.rows(items.map(x => x.doc), { compact: true })}</section>`;
        }).join('');
        // The tab already shows how many: the toolbar only offers clearing.
        return `<div class="toolbar"><div class="toolbar__end">${btn('Clear history', { v: 'ghost', size: 'sm', icon: 'x', act: 'lib-clear-recent' })}</div></div><div class="stack gap-24">${html}</div>`;
      },
    });
  }
  A['lib-clear-recent'] = () => {
    const before = [...mine('recent')];
    D.recent[me().id] = []; persist(); refresh();
    toast('History cleared', { action: { label: 'Undo', run: () => { D.recent[me().id] = before; persist(); refresh(); } } });
  };

  /* ── My files ── */
  function filesTab(kb) {
    const uk = 'libFiles', u = ui(uk);
    const all = kb ? docsIn(kb.id).sort((a, b) => b.updated - a.updated) : [];
    const upload = btn('Upload', { v: 'primary', icon: 'upload', act: 'contribute', data: { private: '1' } });
    const empty = () => emptyState({ icon: 'upload', title: 'No files yet', desc: 'Upload notes or drafts to ask about them. Only you can see them.', actions: upload, boxed: true });
    const rows = all.filter(d => matchesQ(uk, d.name));
    return gate({
      loading: () => skelRows(4), empty,
      ok: () => {
        if (!all.length) return empty();
        // Process is the next step for a file that isn't ready (always shown); Share as knowledge is secondary (on hover, with ⋯).
        const process = d => (['pending', 'failed', 'outdated'].includes(d.status) ? btn('Process', { v: 'secondary', size: 'sm', icon: 'play', act: 'lib-process', data: { id: d.id } }) : '');
        const canShare = canContribute() && contributionTargets().length > 0;
        const share = d => (canShare ? btn('', { v: 'ghost', size: 'sm', icon: 'share', act: 'ctb-share', data: { id: d.id }, tip: 'Share as knowledge…', muted: true }) : '');
        const search = longOr(all.length, u.q) ? searchField({ uiKey: uk, placeholder: 'Search my files' }) : '';
        return tabBar(`${search}<span class="t-sm muted row gap-4 lib-private">${ic('lock', 'i-sm')}Only you can see these</span>`, btn('Upload', { v: 'primary', size: 'sm', icon: 'upload', act: 'contribute', data: { private: '1' } }))
          + (rows.length ? X.res.rows(rows, d => ({ trail: process(d), reveal: share(d), hide: ['kb'] })) : noMatches(uk, [], 'files'));
      },
    });
  }
  A['lib-process'] = el => { const d = docById(el.dataset.id); if (d && !X.processDocs([d], { msg: `Processing “${d.name}”` })) toast('This file can’t be processed', { tone: 'danger' }); };

  /* ── My collections: the reading lists you made (ones shared with you are in Browse → Shared with you) ── */
  function colItem(c) {
    const s = shareLabel(c);
    const desc = [`<span class="row gap-4">${ic(s.icon, 'i-xs')}${esc(s.label)}</span>`, plural((c.items || []).length, 'item')].join(dot);
    return item({ lead: itemIcon('list', c.featured ? 'accent' : '', 'sm'), title: esc(c.name), desc: `<span class="row gap-4 lib-col__meta">${desc}</span>`, meta: `Updated ${esc(relLow(c.updated))}`, href: '/knowledge/collections/' + c.id });
  }
  function collectionsTab() {
    const yours = myCollections();
    const empty = () => emptyState({ icon: 'list', title: 'No collections yet', desc: 'Group resources into a reading list, put them in order and share it with your team.', actions: btn('New collection', { v: 'primary', icon: 'plus', act: 'col-new' }), boxed: true });
    return gate({
      loading: () => skelRows(4), empty,
      // The tab already counts them: the toolbar only offers making another.
      ok: () => !yours.length ? empty() : tabBar('', btn('New collection', { v: 'primary', size: 'sm', icon: 'plus', act: 'col-new' })) + list(yours.map(colItem), 'lib-list'),
    });
  }

  /* ═══════════════ Collection page ═══════════════ */
  const colKey = id => 'col_' + id;
  function colUnavailable() {
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'Not available' }]);
    return `<div class="page">${emptyState({ icon: 'list', title: 'This collection isn’t available', desc: 'It may have been archived, or it isn’t shared with you.', actions: btn('Browse knowledge', { v: 'primary', href: '/knowledge' }), boxed: true })}</div>`;
  }
  /** A collection is an ordered reading list: view mode numbers the items and checks the ones you've read; Edit (one entry, for
      editors) turns the page into its editor — name and description inline, reorder, notes, remove, Add resources — with Done as the
      only primary. Every change saves as you make it (quiet toast with Undo). */
  P.collection = ({ params }) => {
    const c = collectionById(params.id);
    if (!c || !canSeeCollection(c)) return colUnavailable();
    // Yours sit in My library; a shared collection was found in Browse, so its trail is just Knowledge.
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, ...(c.owner === me().id ? [{ label: 'My library', to: libHref('collections') }] : []), { label: c.name }]);
    const edit = canEditCollection(c), u = ui(colKey(c.id), { edit: false });
    if (!edit) u.edit = false;
    const { ok, locked } = collectionItems(c);
    const s = shareLabel(c);
    const meta = `<span class="lib-col__head-meta">${chip(s.label, { icon: s.icon, size: 'sm' })}<span class="t-sm muted">${esc(c.owner === me().id ? 'By you' : 'By ' + actorName(c.owner))} · Updated ${esc(relLow(c.updated))}</span></span>`;
    // View: one primary (Ask about this collection), Edit, and ⋯ (Use in, copy, duplicate, archive). Edit mode: Done is the primary.
    const actions = u.edit
      ? btn('Add resources', { icon: 'plus', act: 'col-add' }) + btn('Done', { v: 'primary', icon: 'check', act: 'col-edit-mode', data: { id: c.id } })
      : (ok.length ? btn('Ask about this collection', { v: 'primary', icon: 'sparkles', act: 'col-ask', data: { id: c.id } }) : '')
        + (edit ? btn('Edit', { icon: 'pencil', act: 'col-edit-mode', data: { id: c.id } }) : '')
        + iconBtn('more', 'More actions', { menu: 'col-more', data: { id: c.id } });
    const head = u.edit
      ? pageHeader({ title: 'Edit collection', lead: itemIcon('list', 'accent'), desc: 'Changes save as you go.', actions })
      : pageHeader({ title: c.name, lead: itemIcon('list', 'accent'), desc: (c.desc ? esc(c.desc) + '<br>' : '') + meta, extra: X.res.demoChip(), actions });
    const details = u.edit ? `<section class="lib-edit__meta" aria-label="Collection details">
      ${field({ id: 'colm-name', label: 'Name', required: true, error: u.nameErr || '', control: input({ id: 'colm-name', value: c.name, attrs: `maxlength="60" data-change="col-meta-save" data-field="name" data-id="${esc(c.id)}"`, invalid: !!u.nameErr }) })}
      ${field({ id: 'colm-desc', label: 'Description', optional: true, control: input({ id: 'colm-desc', value: c.desc || '', placeholder: 'What it’s for and who should read it', attrs: `maxlength="200" data-change="col-meta-save" data-field="desc" data-id="${esc(c.id)}"` }) })}
      <div class="lib-edit__share"><span class="label">Who can see it</span><span class="row gap-8">${chip(s.label, { icon: s.icon, size: 'sm' })}${linkBtn('Change', { act: 'col-edit', data: { id: c.id } })}</span></div></section>` : '';
    const lockedRow = locked ? `<div class="lib-locked">${ic('lock', 'i-sm')}<span>${plural(locked, 'item')} ${locked === 1 ? 'isn’t' : 'aren’t'} shared with you</span></div>` : '';
    const empty = () => emptyState({ icon: 'list', title: 'This collection is empty', desc: edit ? 'Add resources people should read, in order.' : 'The owner hasn’t added anything yet.', actions: edit ? btn('Add resources', { v: 'primary', icon: 'plus', act: 'col-add' }) : '', boxed: true });
    const read = new Set(recentResources(200).map(x => x.doc.id));
    const body = gate({
      loading: () => skelRows(5), empty,
      ok: () => {
        if (!ok.length && !locked) return empty();
        if (u.edit) return `<div class="lib-edit">${ok.map((x, i) => editRow(c, x, i, ok.length)).join('')}</div>${lockedRow}`;
        return X.res.rows(ok.map(x => x.d), d => { const i = ok.findIndex(x => x.d === d); return { note: ok[i]?.note || '', pos: i + 1, read: read.has(d.id) }; }) + lockedRow;
      },
    });
    S.ui.colCur = c.id;
    return `<div class="page lib">${head}${details}${body}</div>`;
  };
  function editRow(c, x, i, n) {
    const d = x.d, title = docTitle(d);
    return `<div class="lib-edit__row">
      <span class="lib-edit__order"><span class="num t-sm muted">${i + 1}</span>${iconBtn('arrow-up', 'Move up', { size: 'sm', act: 'col-move', data: { id: c.id, doc: d.id, dir: -1 }, disabled: i === 0 })}${iconBtn('arrow-down', 'Move down', { size: 'sm', act: 'col-move', data: { id: c.id, doc: d.id, dir: 1 }, disabled: i === n - 1 })}</span>
      <span class="lib-edit__body">${fileIcon(d.type)}<span class="stack gap-4 grow"><span class="medium truncate">${esc(title)}</span>${input({ id: 'coln-' + d.id, value: x.note ?? '', placeholder: 'Add a note for readers', size: 'sm', onEnter: 'col-note-enter', attrs: `maxlength="160" data-change="col-note-save" data-id="${esc(c.id)}" data-doc="${esc(d.id)}" aria-label="Note for ${esc(title)}"` })}</span></span>
      ${iconBtn('trash', 'Remove from collection', { size: 'sm', act: 'col-remove', data: { id: c.id, doc: d.id } })}
    </div>`;
  }
  A['col-edit-mode'] = el => {
    const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return;
    const u = ui(colKey(c.id), { edit: false });
    u.edit = !u.edit; u.nameErr = ''; refresh();
    if (u.edit) requestAnimationFrame(() => $('#colm-name')?.focus());
  };
  /** Name and description save when the field is left (or on Enter). A name can't be emptied: the field says so and keeps the old one. */
  A['col-meta-save'] = el => {
    const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return;
    const k = el.dataset.field, v = el.value.trim(), u = ui(colKey(c.id));
    if (k === 'name' && !v) { u.nameErr = 'Enter a name.'; refresh(); requestAnimationFrame(() => $('#colm-name')?.focus()); return; }
    u.nameErr = '';
    if ((c[k] || '') === v) { refresh(); return; }
    const prev = { [k]: c[k], updated: c.updated };
    c[k] = v; c.updated = Date.now(); audit('Updated a collection', c.name); persist(); refresh();
    toast(k === 'name' ? 'Name saved' : 'Description saved', { action: { label: 'Undo', run: () => { Object.assign(c, prev); persist(); refresh(); } } });
  };
  /** A note saves when you leave its field (Enter leaves it too). */
  A['col-note-enter'] = el => el.blur();
  A['col-note-save'] = el => {
    const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return;
    const it = c.items.find(i => i.doc === el.dataset.doc); if (!it) return;
    const v = el.value.trim(), prev = it.note, prevAt = c.updated; if ((it.note || '') === v) return;
    if (v) it.note = v; else delete it.note;
    c.updated = Date.now(); audit('Edited collection notes', c.name); persist(); refresh();
    toast(v ? 'Note saved' : 'Note removed', { action: { label: 'Undo', run: () => { if (prev) it.note = prev; else delete it.note; c.updated = prevAt; persist(); refresh(); } } });
  };
  A['col-move'] = el => {
    const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return;
    const { ok } = collectionItems(c), i = ok.findIndex(x => x.d.id === el.dataset.doc), j = i + Number(el.dataset.dir);
    if (i < 0 || j < 0 || j >= ok.length) return;
    // Swap with the neighbouring readable item; references the caller can't open keep their positions.
    const a = c.items.findIndex(x => x.doc === ok[i].doc), b = c.items.findIndex(x => x.doc === ok[j].doc);
    [c.items[a], c.items[b]] = [c.items[b], c.items[a]];
    c.updated = Date.now(); persist(); refresh();
    requestAnimationFrame(() => $(`[data-act="col-move"][data-doc="${el.dataset.doc}"][data-dir="${el.dataset.dir}"]`)?.focus());
  };
  A['col-remove'] = el => {
    const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return;
    const i = c.items.findIndex(x => x.doc === el.dataset.doc); if (i < 0) return;
    const [it] = c.items.splice(i, 1), d = docById(it.doc), prev = c.updated;
    c.updated = Date.now(); audit('Removed from a collection', `${c.name}: ${d?.name || ''}`); persist(); refresh();
    toast(`Removed “${d ? docTitle(d) : 'item'}”`, { action: { label: 'Undo', run: () => { c.items.splice(i, 0, it); c.updated = prev; persist(); refresh(); } } });
  };
  A['col-ask'] = el => {
    const c = collectionById(el.dataset.id); if (!c) return;
    const ids = collectionItems(c).ok.map(x => x.d.id).join(',');
    A['chat-ask']?.({ dataset: { q: 'Summarize what these resources cover and how they relate', docs: ids, ...(collectionSpace(c) ? { space: collectionSpace(c).id } : {}) } });
  };
  /** Workflows a collection can start, with all its readable items (Work module). */
  function colUseItems(c) {
    const ids = collectionItems(c).ok.map(x => x.d.id).join(',');
    if (!hasModule('work') || !ids) return [];
    const sp = collectionSpace(c), spOk = sp && spaceRole(sp) ? sp : null;
    return [{ section: 'Use in' }, ...workflowsFor(spOk).map(w => ({ label: w.label, icon: w.icon, run: () => A['work-start']?.({ dataset: { workflow: w.id, docs: ids, ...(spOk ? { space: spOk.id } : {}) } }) })), { sep: true }];
  }
  MENUS['col-more'] = el => {
    const c = collectionById(el.dataset.id); if (!c) return [];
    const edit = canEditCollection(c), own = c.owner === me().id;
    // Editing (name, description, who can see it, items) is the header's Edit; ⋯ holds the rest.
    return [
      ...colUseItems(c),
      { label: 'Copy link', icon: 'link', run: () => copyText(location.href.split('#')[0] + '#/knowledge/collections/' + c.id, 'Link copied') },
      !own && { label: 'Duplicate to my collections', icon: 'copy', run: () => duplicate(c) },
      edit && { sep: true },
      edit && { label: 'Archive', icon: 'archive', danger: true, run: () => archive(c) },
    ].filter(Boolean);
  };
  function duplicate(c) {
    const copy = { id: uid('col'), name: `${c.name} (copy)`, desc: c.desc || '', owner: me().id, share: 'private', created: Date.now(), updated: Date.now(), items: c.items.map(i => ({ ...i })) };
    (D.collections ??= []).unshift(copy); audit('Duplicated a collection', c.name); persist();
    go('/knowledge/collections/' + copy.id); toast(`Copied to “${copy.name}”`);
  }
  function archive(c) {
    c.archived = true; audit('Archived a collection', c.name); persist(); go(c.owner === me().id ? libHref('collections') : '/knowledge');
    toast(`Archived “${c.name}”`, { action: { label: 'Undo', run: () => { c.archived = false; persist(); go('/knowledge/collections/' + c.id); } } });
  }

  /* ── Add resources ── */
  A['col-add'] = () => {
    const c = collectionById(S.ui.colCur); if (!canEditCollection(c)) return;
    S.ui.colAdd = { id: c.id, q: '', picked: [], touched: false }; openModal('col-add', {});
  };
  const pickRow = (d, on) => checkbox({ checked: on, act: 'col-add-pick', data: { id: d.id }, label: `<span class="res-opt res-opt--mark">${fileIcon(d.type, 'sm')}<span class="res-opt__text"><span class="res-opt__name">${esc(docTitle(d))}</span><span class="res-opt__meta">${esc(kindMeta(res(d).kind).label)}${dot}<span class="truncate">${esc(res(d).kb?.name || '')}</span></span></span></span>` });
  M['col-add'] = () => {
    const f = ui('colAdd'), c = collectionById(f.id); if (!c) return { title: 'Add resources', body: '', foot: btn('Close', { act: 'close-modal' }) };
    const have = new Set(c.items.map(i => i.doc)), picked = f.picked.map(docById).filter(Boolean);
    // A shared list never offers your private My files: nobody else could open them. Only a list for you alone can hold them.
    const fits = d => c.share === 'private' || !kbById(d.kb)?.personal;
    // Chosen resources stay at the top while you search for more.
    const found = catalogSearch(parseCatalogQuery({ q: f.q })).rows.map(x => x.doc).filter(d => isReaderVisible(d) && fits(d) && !have.has(d.id) && !f.picked.includes(d.id)).slice(0, 25);
    const err = f.touched && !picked.length ? 'Pick at least one resource.' : '';
    const rows = picked.map(d => pickRow(d, true)).join('') + found.map(d => pickRow(d, false)).join('');
    const none = f.q.trim() ? `No resources match “${esc(f.q.trim())}”.` : 'Everything you can open is already in this collection.';
    const n = picked.length;
    return {
      size: 'md', title: 'Add resources', icon: 'list-plus',
      desc: `Pick what belongs in “${esc(c.name)}”.`,
      body: `<div class="stack gap-12">${searchField({ bind: 'colAdd.q', live: true, id: 'cola-q', size: 'md', full: true, autofocus: true, placeholder: 'Search by title, topic or knowledge base' })}
        ${err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : ''}
        ${rows ? `<div class="option-list lib-add" role="group" aria-label="Resources">${rows}</div>` : `<p class="lib-add-none">${none}</p>`}</div>`,
      footStart: n ? `${plural(n, 'resource')} selected` : 'Documents keep their own access.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(n ? `Add ${plural(n, 'resource')}` : 'Add resources', { v: 'primary', icon: 'plus', act: 'col-add-go' }),
    };
  };
  A['col-add-pick'] = el => { const f = ui('colAdd'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; f.touched = false; refreshLayer(); };
  A['col-add-go'] = () => {
    const f = ui('colAdd'), c = collectionById(f.id); if (!canEditCollection(c)) return;
    if (!f.picked.length) { f.touched = true; refreshLayer(); $('#cola-q')?.focus(); return; }
    const add = f.picked.filter(id => !c.items.some(i => i.doc === id)).map(doc => ({ doc, added: Date.now() }));
    c.items.push(...add); c.updated = Date.now(); audit('Added to a collection', c.name); persist(); closeModal(); refresh();
    toast(`Added ${plural(add.length, 'resource')}`, { action: { label: 'Undo', run: () => { c.items = c.items.filter(i => !add.includes(i)); persist(); refresh(); } } });
  };
})();

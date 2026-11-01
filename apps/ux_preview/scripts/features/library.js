/* My library (/knowledge/library?tab=saved|recent|files|collections|views)
   and one collection (/knowledge/collections/:id): the personal side of
   Knowledge — saved resources, recent reads, My files, collections and saved
   Browse views. Uses X.res (resources.js) and core/catalog.js. Prefix: lib-, col-. */
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

  /* ═══════════════ My library ═══════════════ */
  const TABS = [['saved', 'Saved'], ['recent', 'Recent'], ['files', 'My files'], ['collections', 'Collections'], ['views', 'Saved views']];
  const SAVED_SORTS = { saved: 'Recently saved', updated: 'Recently updated', title: 'Title A–Z' };

  P.library = ({ query }) => {
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'My library' }]);
    const kb = personalKb();
    const counts = { saved: savedResources().length, recent: recentResources().length, files: kb ? docsIn(kb.id).length : 0, collections: visibleCollections().length, views: myViews().length };
    const list = TABS.filter(([id]) => id !== 'files' || kb).map(([id, label]) => ({ id, label, count: counts[id] }));
    const tab = list.some(t => t.id === query.tab) ? query.tab : 'saved';
    const head = X.res.hubHeader('library', { actions: btn('New collection', { v: 'primary', icon: 'plus', act: 'col-new' }) });
    const body = { saved: savedTab, recent: recentTab, files: filesTab, collections: collectionsTab, views: viewsTab }[tab](kb);
    return `<div class="page lib">${head}<div class="page-tabs">${tabs(list, tab, '/knowledge/library')}</div>${body}</div>`;
  };

  /* ── Saved ── */
  function savedTab() {
    const uk = 'libSaved', u = ui(uk, { sort: 'saved', sel: {} });
    const all = savedResources();
    const toks = tokens(u.q || '');
    let rows = all.filter(d => !toks.length || scoreRes(d, toks) > 0);
    if (u.sort === 'updated') rows = [...rows].sort((a, b) => b.updated - a.updated);
    else if (u.sort === 'title') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    const empty = () => emptyState({ icon: 'bookmark', title: 'Nothing saved yet', desc: 'Save resources you come back to. They stay here.', actions: btn('Browse knowledge', { v: 'primary', href: '/knowledge/browse' }), boxed: true });
    const ids = new Set(all.map(d => d.id)); const sel = selIds(uk).filter(id => ids.has(id));
    const toolbar = `<div class="toolbar">${searchField({ uiKey: uk, placeholder: 'Search saved' })}<div class="toolbar__end">${btn(SAVED_SORTS[u.sort] || SAVED_SORTS.saved, { v: 'ghost', size: 'sm', icon: 'sort', menu: 'lib-sort', aria: `aria-label="Sort: ${esc(SAVED_SORTS[u.sort])}"` })}</div></div>`;
    return gate({
      loading: () => skelRows(6), empty,
      ok: () => {
        if (!all.length) return empty();
        const listHtml = rows.length ? X.res.rows(rows, { q: u.q || '', select: uk }) : noMatches(uk, [], 'saved resources');
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
    const empty = () => emptyState({ icon: 'history', title: 'No recent reads', desc: 'Resources you open show up here.', actions: btn('Go to Discover', { v: 'primary', href: '/knowledge' }), boxed: true });
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
        return `<div class="toolbar"><span class="t-sm muted">${plural(all.length, 'resource')}</span><div class="toolbar__end">${btn('Clear history', { v: 'ghost', size: 'sm', icon: 'x', act: 'lib-clear-recent' })}</div></div><div class="stack gap-24">${html}</div>`;
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
    const uk = 'libFiles';
    const all = kb ? docsIn(kb.id).sort((a, b) => b.updated - a.updated) : [];
    const upload = btn('Upload', { v: 'primary', icon: 'upload', act: 'kb-upload', data: { kb: kb?.id || '' } });
    const empty = () => emptyState({ icon: 'upload', title: 'No files yet', desc: 'Upload notes or drafts to ask about them. Only you can see them.', actions: upload, boxed: true });
    const rows = all.filter(d => matchesQ(uk, d.name));
    return gate({
      loading: () => skelRows(4), empty,
      ok: () => {
        if (!all.length) return empty();
        const process = d => (['pending', 'failed', 'outdated'].includes(d.status) ? btn('Process', { v: 'ghost', size: 'sm', icon: 'play', act: 'lib-process', data: { id: d.id } }) : '');
        return `<div class="toolbar">${searchField({ uiKey: uk, placeholder: 'Search my files' })}<span class="t-sm muted row gap-4">${ic('lock', 'i-sm')}Only you can see these</span><div class="toolbar__end">${btn('Upload', { icon: 'upload', act: 'kb-upload', data: { kb: kb.id } })}</div></div>`
          + (rows.length ? X.res.rows(rows, d => ({ trail: process(d) })) : noMatches(uk, [], 'files'));
      },
    });
  }
  A['lib-process'] = el => { const d = docById(el.dataset.id); if (d && !X.processDocs([d], { msg: `Processing “${d.name}”` })) toast('This file can’t be processed', { tone: 'danger' }); };

  /* ── Collections ── */
  function colItem(c, { owner = false } = {}) {
    const s = shareLabel(c);
    const desc = [`<span class="row gap-4">${ic(s.icon, 'i-xs')}${esc(s.label)}</span>`, plural((c.items || []).length, 'item'), owner && esc(actorName(c.owner))].filter(Boolean).join(dot);
    return item({ lead: itemIcon('list', c.featured ? 'accent' : '', 'sm'), title: esc(c.name), desc: `<span class="row gap-4 lib-col__meta">${desc}</span>`, meta: `Updated ${esc(relLow(c.updated))}`, href: '/knowledge/collections/' + c.id });
  }
  function collectionsTab() {
    const all = visibleCollections(), yours = all.filter(c => c.owner === me().id), shared = all.filter(c => c.owner !== me().id);
    const create = btn('New collection', { v: 'primary', icon: 'plus', act: 'col-new' });
    const empty = () => emptyState({ icon: 'list', title: 'No collections yet', desc: 'Group resources into a reading list and share it with a course or team.', actions: create, boxed: true });
    return gate({
      loading: () => skelRows(4), empty,
      ok: () => {
        if (!all.length) return empty();
        const mineHtml = yours.length ? list(yours.map(c => colItem(c)), 'lib-list') : emptyState({ icon: 'list', title: 'You haven’t made a collection yet', actions: btn('New collection', { icon: 'plus', act: 'col-new' }), compact: true, boxed: true });
        return section('Yours', mineHtml) + (shared.length ? section('Shared with you', list(shared.map(c => colItem(c, { owner: true })), 'lib-list')) : '');
      },
    });
  }

  /* ── Saved views ── */
  function viewSummary(v) {
    const p = parseCatalogQuery(Object.fromEntries(new URLSearchParams(v.query || '')));
    const parts = [];
    if (p.q) parts.push(`“${p.q}”`);
    facetsOn().forEach(f => { const vals = p.filters[f.id]; if (vals?.length) parts.push(`${f.label}: ${vals.map(f.name).join(', ')}`); });
    if (p.saved) parts.push('Saved only');
    return parts.join(' · ') || 'All resources';
  }
  function viewsTab() {
    const all = myViews();
    const empty = () => emptyState({ icon: 'filter', title: 'No saved views', desc: 'In Browse, save a search and its filters to come back to it.', actions: btn('Go to Browse', { v: 'primary', href: '/knowledge/browse' }), boxed: true });
    return gate({
      loading: () => skelRows(3), empty,
      ok: () => all.length ? list(all.map(v => item({
        lead: itemIcon('filter', '', 'sm'), title: esc(v.name), desc: `<span class="truncate">${esc(viewSummary(v))}</span>`,
        meta: v.created ? `Created ${esc(relLow(v.created))}` : '', act: 'lib-view-open', data: { id: v.id },
        trail: iconBtn('more', 'View options', { size: 'sm', menu: 'lib-view', data: { id: v.id } }),
      })), 'lib-list') : empty(),
    });
  }
  const viewById = id => myViews().find(v => v.id === id);
  A['lib-view-open'] = el => { const v = viewById(el.dataset.id); if (v) go('/knowledge/browse' + (v.query ? '?' + v.query : '')); };
  MENUS['lib-view'] = el => {
    const v = viewById(el.dataset.id); if (!v) return [];
    return [
      { label: 'Open', icon: 'search', run: () => A['lib-view-open']({ dataset: { id: v.id } }) },
      { label: 'Rename', icon: 'pencil', run: () => { S.ui.libView = { id: v.id, name: v.name, touched: false }; openModal('lib-view-rename', {}); } },
      { sep: true },
      { label: 'Delete', icon: 'trash', danger: true, run: () => {
        const l = mine('views'), i = l.indexOf(v); l.splice(i, 1); persist(); refresh();
        toast(`Deleted “${v.name}”`, { action: { label: 'Undo', run: () => { mine('views').splice(i, 0, v); persist(); refresh(); } } });
      } },
    ];
  };
  M['lib-view-rename'] = () => {
    const f = ui('libView'), err = f.touched && !f.name.trim() ? 'Enter a name.' : '';
    return {
      size: 'sm', title: 'Rename view',
      body: field({ id: 'libv-name', label: 'Name', required: true, error: err, control: input({ id: 'libv-name', bind: 'libView.name', value: f.name, autofocus: true, onEnter: 'lib-view-rename-go', invalid: !!err, attrs: 'maxlength="60"' }) }),
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'lib-view-rename-go' }),
    };
  };
  A['lib-view-rename-go'] = () => {
    const f = ui('libView'), v = viewById(f.id); f.touched = true;
    if (!f.name.trim()) { refreshLayer(); $('#libv-name')?.focus(); return; }
    if (v) v.name = f.name.trim(); persist(); closeModal(); refresh(); toast('View renamed');
  };

  /* ═══════════════ Collection page ═══════════════ */
  const colKey = id => 'col_' + id;
  function colUnavailable() {
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'My library', to: libHref('collections') }, { label: 'Not available' }]);
    return `<div class="page">${emptyState({ icon: 'list', title: 'This collection isn’t available', desc: 'It may have been archived, or it isn’t shared with you.', actions: btn('Go to My library', { v: 'primary', href: libHref('collections') }), boxed: true })}</div>`;
  }
  P.collection = ({ params }) => {
    const c = collectionById(params.id);
    if (!c || !canSeeCollection(c)) return colUnavailable();
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'My library', to: libHref('collections') }, { label: c.name }]);
    const edit = canEditCollection(c), u = ui(colKey(c.id), { edit: false, notes: {} });
    if (!edit) u.edit = false;
    const { ok, locked } = collectionItems(c);
    const s = shareLabel(c);
    const use = hasModule('work') && ok.length ? btn('Use in', { iconRight: 'chevron-down', icon: 'sparkles', menu: 'col-use', data: { id: c.id } }) : '';
    const meta = `<span class="lib-col__head-meta">${chip(s.label, { icon: s.icon, size: 'sm' })}<span class="t-sm muted">${esc(c.owner === me().id ? 'By you' : 'By ' + actorName(c.owner))} · Updated ${esc(relLow(c.updated))}</span></span>`;
    const actions = (ok.length ? btn('Ask about this collection', { v: 'primary', icon: 'sparkles', act: 'col-ask', data: { id: c.id } }) : '') + use + iconBtn('more', 'More', { menu: 'col-more', data: { id: c.id } });
    const head = pageHeader({ title: c.name, lead: itemIcon('list', 'accent'), desc: (c.desc ? esc(c.desc) + '<br>' : '') + meta, extra: X.res.demoChip(), actions });
    const editBar = edit ? `<div class="toolbar"><span class="t-sm muted">${plural(ok.length, 'item')}</span><div class="toolbar__end">${u.edit ? btn('Add resources', { icon: 'plus', act: 'col-add' }) + btn('Done', { v: 'secondary', act: 'col-edit-mode', data: { id: c.id } }) : btn('Edit items', { icon: 'pencil', act: 'col-edit-mode', data: { id: c.id } })}</div></div>` : '';
    const lockedRow = locked ? `<div class="lib-locked">${ic('lock', 'i-sm')}<span>${plural(locked, 'item')} ${locked === 1 ? 'isn’t' : 'aren’t'} shared with you</span></div>` : '';
    const empty = () => emptyState({ icon: 'list', title: 'This collection is empty', desc: edit ? 'Add resources people should read, in order.' : 'The owner hasn’t added anything yet.', actions: edit ? btn('Add resources', { v: 'primary', icon: 'plus', act: 'col-add' }) : '', boxed: true });
    const body = gate({
      loading: () => skelRows(5), empty,
      ok: () => {
        if (!ok.length && !locked) return empty();
        if (u.edit) return `<div class="lib-edit">${ok.map((x, i) => editRow(c, x, i, ok.length)).join('')}</div>${lockedRow}`;
        return X.res.rows(ok.map(x => x.d), d => ({ note: ok.find(x => x.d === d)?.note || '' })) + lockedRow;
      },
    });
    S.ui.colCur = c.id;
    return `<div class="page lib">${head}${editBar}${body}</div>`;
  };
  function editRow(c, x, i, n) {
    const d = x.d, key = `${colKey(c.id)}.notes.${d.id}`, cur = ui(colKey(c.id)).notes[d.id];
    return `<div class="lib-edit__row">
      <span class="lib-edit__order"><span class="num t-sm muted">${i + 1}</span>${iconBtn('arrow-up', 'Move up', { size: 'sm', act: 'col-move', data: { id: c.id, doc: d.id, dir: -1 }, disabled: i === 0 })}${iconBtn('arrow-down', 'Move down', { size: 'sm', act: 'col-move', data: { id: c.id, doc: d.id, dir: 1 }, disabled: i === n - 1 })}</span>
      <span class="lib-edit__body">${fileIcon(d.type)}<span class="stack gap-4 grow"><span class="medium truncate">${esc(d.name)}</span>${input({ id: 'coln-' + d.id, bind: key, value: cur ?? x.note ?? '', placeholder: 'Add a note for readers', size: 'sm', onEnter: 'col-note-save', attrs: `maxlength="160" data-id="${esc(c.id)}" data-doc="${esc(d.id)}" aria-label="Note for ${esc(d.name)}"` })}</span></span>
      ${iconBtn('trash', 'Remove from collection', { size: 'sm', act: 'col-remove', data: { id: c.id, doc: d.id } })}
    </div>`;
  }
  /** Commit pending note edits (on Done / Enter). */
  function saveNotes(c) {
    const u = ui(colKey(c.id)); let n = 0;
    Object.entries(u.notes || {}).forEach(([doc, note]) => {
      const it = c.items.find(i => i.doc === doc); if (!it) return;
      const v = (note || '').trim(); if ((it.note || '') === v) return;
      if (v) it.note = v; else delete it.note; n++;
    });
    u.notes = {};
    if (n) { c.updated = Date.now(); audit('Edited collection notes', c.name); persist(); }
    return n;
  }
  A['col-edit-mode'] = el => {
    const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return;
    const u = ui(colKey(c.id), { edit: false, notes: {} });
    if (u.edit) { const n = saveNotes(c); u.edit = false; refresh(); if (n) toast(n === 1 ? 'Note saved' : `${n} notes saved`); }
    else { u.edit = true; u.notes = {}; refresh(); }
  };
  A['col-note-save'] = el => {
    const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return;
    if (saveNotes(c)) { refresh(); toast('Note saved'); }
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
    toast(`Removed “${d?.name || 'item'}”`, { action: { label: 'Undo', run: () => { c.items.splice(i, 0, it); c.updated = prev; persist(); refresh(); } } });
  };
  A['col-ask'] = el => {
    const c = collectionById(el.dataset.id); if (!c) return;
    const ids = collectionItems(c).ok.map(x => x.d.id).join(',');
    A['chat-ask']?.({ dataset: { q: 'Summarize what these resources cover and how they relate', docs: ids, ...(collectionSpace(c) ? { space: collectionSpace(c).id } : {}) } });
  };
  MENUS['col-use'] = el => {
    const c = collectionById(el.dataset.id); if (!c || !hasModule('work')) return [];
    const sp = collectionSpace(c), spOk = sp && spaceRole(sp) ? sp : null;
    const ids = collectionItems(c).ok.map(x => x.d.id).join(',');
    return [{ section: 'Start with these resources' }, ...workflowsFor(spOk).map(w => ({ label: w.label, icon: w.icon, run: () => A['work-start']?.({ dataset: { workflow: w.id, docs: ids, ...(spOk ? { space: spOk.id } : {}) } }) }))];
  };
  MENUS['col-more'] = el => {
    const c = collectionById(el.dataset.id); if (!c) return [];
    const edit = canEditCollection(c), own = c.owner === me().id;
    return [
      edit && { label: 'Edit details', icon: 'pencil', run: () => A['col-edit']({ dataset: { id: c.id } }) },
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
    c.archived = true; audit('Archived a collection', c.name); persist(); go(libHref('collections'));
    toast(`Archived “${c.name}”`, { action: { label: 'Undo', run: () => { c.archived = false; persist(); go('/knowledge/collections/' + c.id); } } });
  }

  /* ── Add resources ── */
  A['col-add'] = () => {
    const c = collectionById(S.ui.colCur); if (!canEditCollection(c)) return;
    S.ui.colAdd = { id: c.id, q: '', picked: [] }; openModal('col-add', {});
  };
  M['col-add'] = () => {
    const f = ui('colAdd'), c = collectionById(f.id); if (!c) return { title: 'Add resources', body: '', foot: btn('Close', { act: 'close-modal' }) };
    const have = new Set(c.items.map(i => i.doc));
    const found = catalogSearch(parseCatalogQuery({ q: f.q })).rows.map(x => x.doc).filter(d => isReaderVisible(d) && !have.has(d.id)).slice(0, 25);
    const rowsHtml = found.map(d => `<div class="res-pick">${checkbox({ checked: f.picked.includes(d.id), act: 'col-add-pick', data: { id: d.id }, label: `<span class="stack"><span class="medium">${esc(d.name)}</span><span class="t-xs muted">${esc(kindMeta(res(d).kind).label)} · ${esc(res(d).kb?.name || '')}</span></span>` })}</div>`).join('');
    return {
      size: 'md', title: 'Add resources', desc: esc(c.name),
      body: `${field({ id: 'cola-q', label: '', control: input({ id: 'cola-q', bind: 'colAdd.q', value: f.q, type: 'search', placeholder: 'Search the catalog', autofocus: true, attrs: 'data-live aria-label="Search the catalog"' }) })}
        <div class="res-picks mt-12 lib-add">${rowsHtml || `<p class="t-sm muted">${f.q ? 'No resources match.' : 'Nothing left to add.'}</p>`}</div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn(f.picked.length ? `Add ${plural(f.picked.length, 'resource')}` : 'Add', { v: 'primary', act: 'col-add-go', disabled: !f.picked.length }),
    };
  };
  A['col-add-pick'] = el => { const f = ui('colAdd'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; refreshLayer(); };
  A['col-add-go'] = () => {
    const f = ui('colAdd'), c = collectionById(f.id); if (!canEditCollection(c) || !f.picked.length) return;
    const add = f.picked.filter(id => !c.items.some(i => i.doc === id)).map(doc => ({ doc, added: Date.now() }));
    c.items.push(...add); c.updated = Date.now(); audit('Added to a collection', c.name); persist(); closeModal(); refresh();
    toast(`Added ${plural(add.length, 'resource')}`, { action: { label: 'Undo', run: () => { c.items = c.items.filter(i => !add.includes(i)); persist(); refresh(); } } });
  };
})();

/* Resources: the shared building blocks every Knowledge surface uses to show
   and act on a resource — type and trust chips, provenance, the list row,
   card and table row, the metadata list — and the shared actions: save,
   add to a collection, ask, use in a workflow, edit details, link to spaces,
   verify, copy link. Pages (hub.js, library.js, reader.js, knowledge.js,
   spaces.js, governance.js) compose these; none re-implements them.
   Exports: X.res.*. Actions: res-*, col-new, col-edit. Model: core/catalog.js. */
(() => {
  'use strict';

  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const canEditRes = d => !!d && canEditKb(kbById(d.kb));
  /** Spaces whose materials the caller may curate. */
  const linkableSpaces = () => (hasModule('spaces') ? (D.spaces || []).filter(s => !s.archived && canManageSpace(s)) : []);

  /* ═══════════════ Visual pieces ═══════════════ */
  const kindChip = (d, { size = 'sm' } = {}) => { const k = kindMeta(res(d).kind); return chip(k.label, { icon: k.icon, size }); };
  /** Trust chip. quiet: hide "Not verified" (lists), show it in details. */
  function trustChip(d, { size = 'sm', quiet = false } = {}) {
    const t = trustOf(d);
    if (t.state === 'personal' || (quiet && t.state === 'unverified')) return '';
    return chip(t.label, { tone: t.tone, icon: t.icon, size, tip: t.note || t.desc });
  }
  /** Index status, only for people who can fix it (editors). Readers never see pipeline states. */
  const statusChip = d => (d.status !== 'ready' && d.status !== 'outdated' && canEditRes(d) ? status('doc', d.status) : '');
  const saveBtn = (d, { size = 'sm', label = false } = {}) => {
    const on = isSaved(d.id);
    return label
      ? btn(on ? 'Saved' : 'Save', { size, icon: on ? 'bookmark-filled' : 'bookmark', act: 'res-save', data: { id: d.id }, cls: cx('res-save', on && 'is-on'), aria: `aria-pressed="${on}"` })
      : btn('', { v: 'ghost', size, icon: on ? 'bookmark-filled' : 'bookmark', tip: on ? 'Remove from saved' : 'Save', act: 'res-save', data: { id: d.id }, muted: !on, cls: cx('res-save', on && 'is-on'), aria: `aria-pressed="${on}"` });
  };
  const moreBtn = (d, size = 'sm') => iconBtn('more', 'More actions', { size, menu: 'res-more', data: { id: d.id } });
  /** "Google Drive · Academic regulations & procedures" with the source glyph. */
  function provenance(d, { kb = true } = {}) {
    const r = res(d);
    return `<span class="res-prov">${appIcon(r.source.app, 'sm')}<span class="truncate">${esc(kb ? r.kb?.name || '' : r.source.name)}</span></span>`;
  }
  const topicHref = id => catalogHref({ filters: { topic: [id] } });
  function topicChips(d, { max = 2 } = {}) {
    const t = res(d).topics.slice(0, max);
    return t.length ? `<span class="res-topics">${t.map(id => `<a class="res-topic" href="#${topicHref(id)}">${esc(topicName(id))}</a>`).join('')}</span>` : '';
  }
  /** Fictional-data marker for demo workspaces. */
  const demoChip = () => (isDemoWs() ? chip('Demo data', { size: 'sm', icon: 'info', tip: curWs().demo }) : '');
  /** Knowledge area header: title, demo marker, section tabs (Browse · My library · Knowledge bases) and the page's actions. Discovery lives on Home. */
  const HUB_TABS = [['browse', 'Browse', '/knowledge'], ['library', 'My library', '/knowledge/library'], ['bases', 'Knowledge bases', '/knowledge/bases']];
  function hubHeader(active, { actions = '', desc = '' } = {}) {
    const nav = `<nav class="tabs hub-tabs" aria-label="Knowledge sections"><div class="tabs__list">${HUB_TABS.map(([id, label, to]) => `<a class="tabs__tab" href="#${to}" ${id === active ? 'aria-current="page" aria-selected="true"' : 'aria-selected="false"'}>${esc(label)}</a>`).join('')}</div></nav>`;
    return pageHeader({ title: 'Knowledge', extra: demoChip(), desc, actions }) + `<div class="hub-nav">${nav}</div>`;
  }
  /** Knowledge header entry point: Contribute (review before publishing) for contributors; otherwise upload to My files. */
  const uploadBtn = (v = 'secondary') => (canContribute() ? btn('Contribute', { v, icon: 'upload', act: 'contribute' }) : visibleKbs().some(k => k.personal) ? btn('Upload', { v, icon: 'upload', act: 'contribute', data: { private: '1' } }) : '');

  /* ═══════════════ Row, card, table ═══════════════ */
  /** Rich list row. opts: q (highlight + snippet), act (default open), data, active, note (collection note), trail (extra HTML before save), select (uiKey for checkbox). */
  function row(d, { q = '', act = 'res-open', data, active = false, note = '', trail = '', select, compact = false } = {}) {
    const r = res(d), toks = tokens(q), k = kindMeta(r.kind);
    const snip = q ? resSnippet(d, q) : '';
    const meta = [esc(k.label), esc(r.kb?.name || ''), `Updated ${esc(rel(d.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase()))}`].filter(Boolean).join('<span class="res-dot" aria-hidden="true">·</span>');
    const desc = compact ? '' : `<span class="res-row__summary">${snip || markTokens(r.summary, toks)}</span>`;
    const sel = select ? `<span class="res-row__check">${checkbox({ checked: !!ui(select).sel?.[d.id], act: 'sel-toggle', data: { ui: select, id: d.id }, aria: 'Select ' + d.name })}</span>` : '';
    return `<div class="${cx('res-row', active && 'is-active', compact && 'res-row--compact')}" role="button" tabindex="0" data-act="${act}" ${dataAttrs({ id: d.id, ...(data || {}) })} ${active ? 'aria-current="true"' : ''}>
      ${sel}<span class="res-row__lead">${fileIcon(d.type)}</span>
      <span class="res-row__body">
        <span class="res-row__title"><span class="truncate">${markTokens(d.name, toks)}</span>${trustChip(d, { quiet: true })}${statusChip(d)}</span>
        <span class="res-row__meta">${appIcon(r.source.app, 'sm')}${meta}</span>
        ${desc}${note ? `<span class="res-row__note">${ic('note', 'i-xs')}<span>${esc(note)}</span></span>` : ''}
        ${compact ? '' : topicChips(d)}
      </span>
      <span class="res-row__trail">${trail}${saveBtn(d)}${moreBtn(d)}</span>
    </div>`;
  }
  const rows = (docs, opts) => `<div class="res-list">${docs.map(d => row(d, typeof opts === 'function' ? opts(d) : opts)).join('')}</div>`;
  function card(d, { act = 'res-open', data } = {}) {
    const r = res(d);
    return `<div class="card card--action res-card" role="button" tabindex="0" data-act="${act}" ${dataAttrs({ id: d.id, ...(data || {}) })}>
      <div class="res-card__top">${fileIcon(d.type)}<span class="grow"></span>${trustChip(d, { quiet: true })}${saveBtn(d)}</div>
      <div class="res-card__title">${esc(d.name)}</div>
      <div class="res-card__summary">${esc(r.summary)}</div>
      <div class="res-card__foot">${appIcon(r.source.app, 'sm')}<span class="truncate">${esc(kindMeta(r.kind).label)} · ${esc(r.kb?.name || '')}</span></div>
    </div>`;
  }
  const tableHead = () => `${th('Name')}${th('Type', 'table__column--hide-sm')}${th(hasModule('spaces') ? 'Space' : 'Owner', 'table__column--hide-sm')}${th('Trust')}${th('Updated')}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
  function tableRow(d, { act = 'res-open', data, active = false } = {}) {
    const r = res(d), sp = r.contexts.map(spaceById).filter(Boolean)[0];
    const where = hasModule('spaces') ? (sp ? esc(sp.code || sp.name) : '<span class="muted">—</span>') : esc(r.owner || '—');
    return `<tr class="table__row" data-act="${act}" ${dataAttrs({ id: d.id, ...(data || {}) })} tabindex="0" ${active ? 'aria-selected="true"' : ''}>
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" title="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(r.kb?.name || '')}</div></div></div></td>
      <td class="table__cell table__cell--hide-sm muted">${esc(kindMeta(r.kind).label)}</td>
      <td class="table__cell table__cell--hide-sm">${where}</td>
      <td class="table__cell">${trustChip(d) || statusChip(d) || '<span class="muted">—</span>'}</td>
      <td class="table__cell muted res-nowrap" title="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${saveBtn(d)}${moreBtn(d)}</div></td></tr>`;
  }

  /** Metadata list (About): what it is, where it lives, where it came from, who owns it, who can see it. */
  function details(d) {
    const r = res(d), t = trustOf(d), who = X.whoCanSee ? X.whoCanSee(r.kb) : { icon: 'lock', label: '' };
    const spaces = r.contexts.map(spaceById).filter(Boolean);
    return kv([
      ['Type', `<span class="row gap-6">${ic(kindMeta(r.kind).icon, 'i-sm muted')}${esc(kindMeta(r.kind).label)}</span>`],
      ['Topics', r.topics.length ? `<span class="res-topics">${r.topics.map(id => `<a class="res-topic" href="#${topicHref(id)}">${esc(topicName(id))}</a>`).join('')}</span>` : '<span class="muted">None yet</span>'],
      hasModule('spaces') && ['Spaces', spaces.length ? spaces.map(s => `<a class="link" href="#/space/${s.id}">${esc(s.code ? `${s.name} · ${s.code}` : s.name)}</a>`).join(', ') : '<span class="muted">Not linked</span>'],
      ['Owner', esc(r.owner || 'No owner')],
      ['Knowledge base', r.kb ? `<a class="link" href="#/knowledge/${r.kb.id}">${esc(r.kb.name)}</a>` : '—'],
      ['Source', `<span class="stack gap-2"><span class="row gap-6">${appIcon(r.source.app, 'sm')}${esc(r.source.name)}</span><span class="t-xs muted res-path">${esc(r.source.path)}</span></span>`],
      ['Trust', `<span class="stack gap-2">${trustChip(d) || esc(t.label)}<span class="t-xs muted">${esc(t.note || t.desc)}</span></span>`],
      ['Version', `v${r.version} · ${esc(fmtDate(d.updated))}`],
      ['Language', esc(LANGS[r.lang] || r.lang)],
      ['Who can see it', `<span class="row gap-6">${ic(who.icon, 'i-sm muted')}${esc(who.label)}</span>`],
    ]);
  }

  X.res = { kindChip, trustChip, statusChip, saveBtn, moreBtn, provenance, topicChips, topicHref, demoChip, hubHeader, uploadBtn, row, rows, card, tableHead, tableRow, details, canEditRes, linkableSpaces };

  /* ═══════════════ Actions ═══════════════ */
  A['res-open'] = el => { const { id, q } = el.dataset; go('/doc/' + id + (q ? '?q=' + encodeURIComponent(q) : '')); };
  A['res-save'] = el => {
    const d = docById(el.dataset.id); if (!d) return;
    const on = toggleSaved(d.id); refresh();
    toast(on ? `Saved “${d.name}”` : `Removed “${d.name}” from saved`, { action: { label: 'Undo', run: () => { toggleSaved(d.id); refresh(); } } });
  };
  A['res-copy-link'] = el => copyText(location.href.split('#')[0] + '#/doc/' + el.dataset.id, 'Link copied');
  /** Leave the page and continue in a conversation scoped to this resource. */
  A['res-ask'] = el => { const d = docById(el.dataset.id); if (!d) return; A['chat-ask']?.({ dataset: { q: el.dataset.q || '', kb: d.kb, doc: d.id } }); };
  A['res-verify'] = el => {
    const d = docById(el.dataset.id); if (!canEditRes(d)) return;
    const prev = d.verify ? { ...d.verify } : null;
    d.verify = { state: 'verified', by: me().name, at: Date.now(), due: Date.now() + 180 * DAY };
    audit('Verified a resource', d.name); refresh();
    toast(`Verified “${d.name}” until ${fmtDate(d.verify.due)}`, { action: { label: 'Undo', run: () => { if (prev) d.verify = prev; else delete d.verify; refresh(); } } });
  };

  /** Workflows a resource can start (Work module), scoped to its first space. */
  function useItems(d) {
    if (!hasModule('work')) return [];
    const sp = res(d).contexts.map(spaceById).find(s => s && spaceRole(s));
    return workflowsFor(sp).map(w => ({ label: w.label, icon: w.icon, run: () => A['work-start']?.({ dataset: { workflow: w.id, docs: d.id, ...(sp ? { space: sp.id } : {}) } }) }));
  }
  X.res.useItems = useItems;
  MENUS['res-use'] = el => { const d = docById(el.dataset.id); return d ? [{ section: 'Use in' }, ...useItems(d)] : []; };
  MENUS['res-more'] = el => {
    const d = docById(el.dataset.id); if (!d) return [];
    const edit = canEditRes(d), use = useItems(d), readable = isSearchable(d);
    return [
      S.cur.r.page !== 'docViewer' && { label: 'Open', icon: 'file-text', run: () => go('/doc/' + d.id) },
      { label: isSaved(d.id) ? 'Remove from saved' : 'Save', icon: isSaved(d.id) ? 'bookmark-filled' : 'bookmark', run: () => A['res-save']({ dataset: { id: d.id } }) },
      { label: 'Add to collection…', icon: 'list-plus', run: () => A['res-collect']({ dataset: { id: d.id } }) },
      readable && { label: 'Ask about it', icon: 'sparkles', run: () => A['res-ask']({ dataset: { id: d.id } }) },
      ...(use.length && readable ? [{ section: 'Use in' }, ...use] : []),
      { sep: true },
      { label: 'Copy link', icon: 'link', run: () => A['res-copy-link']({ dataset: { id: d.id } }) },
      { label: 'Download', icon: 'download', run: () => X.downloadDocument?.(d) },
      canContribute() && !kbById(d.kb)?.personal && (edit || isMine(d)) && { label: 'Submit a new version…', icon: 'upload', run: () => A['contribute']?.({ dataset: { versionOf: d.id } }) },
      canReviewKb(kbById(d.kb)) && can('knowledge.manage') && { label: 'Manage in Documents', icon: 'files', run: () => go('/documents?tab=all&q=' + encodeURIComponent(d.name.replace(/\.[^.]+$/, ''))) },
      isAdmin() && isPublishedStage(d) && !kbById(d.kb)?.personal && { label: isFeatured(d.id) ? 'Remove from Home' : 'Feature on Home', icon: 'sparkles', run: () => { const on = toggleFeatured(d.id); refresh(); toast(on ? `Featured on Home for everyone who can read it` : 'Removed from Home', { action: { label: 'Undo', run: () => { toggleFeatured(d.id); refresh(); } } }); } },
      ...(edit ? [
        { sep: true },
        { label: 'Edit details…', icon: 'pencil', run: () => A['res-edit']({ dataset: { id: d.id } }) },
        linkableSpaces().length && { label: 'Link to spaces…', icon: 'link-2', run: () => A['res-link']({ dataset: { id: d.id } }) },
        !kbById(d.kb)?.personal && { label: trustOf(d).state === 'verified' ? 'Renew verification' : 'Mark as verified', icon: 'shield-check', run: () => A['res-verify']({ dataset: { id: d.id } }) },
        { label: 'Archive', icon: 'archive', danger: true, run: () => X.archiveDocs?.([d]) },
      ].filter(Boolean) : []),
    ].filter(Boolean);
  };

  /* ── Add to collection ── */
  A['res-collect'] = el => {
    const ids = (el.dataset.ids || el.dataset.id || '').split(',').filter(Boolean); if (!ids.length) return;
    const editable = visibleCollections().filter(canEditCollection);
    S.ui.resCollect = { ids, picked: editable.filter(c => ids.every(id => c.items.some(i => i.doc === id))).map(c => c.id), name: '', creating: !editable.length };
    openModal('res-collect', {});
  };
  M['res-collect'] = () => {
    const f = ui('resCollect'), editable = visibleCollections().filter(canEditCollection), n = f.ids.length;
    const rowsHtml = editable.map(c => { const s = shareLabel(c); return `<div class="res-pick">${checkbox({ checked: f.picked.includes(c.id), act: 'res-collect-pick', data: { id: c.id }, label: `<span class="stack"><span class="medium">${esc(c.name)}</span><span class="t-xs muted row gap-4">${ic(s.icon, 'i-xs')}${esc(s.label)} · ${plural(c.items.length, 'item')}</span></span>` })}</div>`; }).join('');
    const create = f.creating
      ? field({ id: 'resc-name', label: 'New collection', control: input({ id: 'resc-name', bind: 'resCollect.name', value: f.name, placeholder: 'e.g. Midterm reading list', autofocus: true, onEnter: 'res-collect-go', attrs: 'maxlength="60"' }), desc: 'Only you can see it until you share it.' })
      : linkBtn('New collection', { act: 'res-collect-new', icon: 'plus' });
    return {
      size: 'sm', title: 'Add to collection', desc: n === 1 ? esc(docById(f.ids[0])?.name || '') : plural(n, 'resource'),
      body: `${rowsHtml ? `<div class="res-picks">${rowsHtml}</div>` : ''}<div class="${rowsHtml ? 'mt-16' : ''}">${create}</div><p class="t-xs muted mt-12">Collections point to resources; they don’t change who can open them.</p>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Done', { v: 'primary', act: 'res-collect-go' }),
    };
  };
  A['res-collect-pick'] = el => { const f = ui('resCollect'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; refreshLayer(); };
  A['res-collect-new'] = () => { ui('resCollect').creating = true; refreshLayer(); requestAnimationFrame(() => $('#resc-name')?.focus()); };
  A['res-collect-go'] = () => {
    const f = ui('resCollect'), editable = visibleCollections().filter(canEditCollection);
    const name = (f.name || '').trim();
    let created = null, added = 0, removed = 0;
    if (f.creating && name) {
      created = { id: uid('col'), name, desc: '', owner: me().id, share: 'private', created: Date.now(), updated: Date.now(), items: [] };
      (D.collections ??= []).unshift(created); f.picked.push(created.id); audit('Created a collection', name);
    }
    [...editable, ...(created ? [created] : [])].forEach(c => {
      const want = f.picked.includes(c.id);
      f.ids.forEach(id => {
        const has = c.items.some(i => i.doc === id);
        if (want && !has) { c.items.push({ doc: id, added: Date.now() }); added++; c.updated = Date.now(); }
        if (!want && has && f.ids.length === 1) { c.items = c.items.filter(i => i.doc !== id); removed++; c.updated = Date.now(); }
      });
    });
    closeModal(); refresh();
    const target = created || editable.find(c => f.picked.includes(c.id));
    if (added && target) toast(`Added to “${target.name}”${f.picked.length > 1 ? ` and ${plural(f.picked.length - 1, 'other')}` : ''}`, { action: { label: 'Open', run: () => go('/knowledge/collections/' + target.id) } });
    else if (removed) toast('Removed from the collection');
  };

  /* ── Create / edit a collection ── */
  const SHARE_OPTS = () => [['private', 'Only me', 'A personal reading list.'], ...linkableSpaces().map(s => ['space:' + s.id, s.code ? `${s.name} · ${s.code}` : s.name, `Members of this ${spaceType(s.type).label.toLowerCase()} can see it.`]), ...(isAdmin() ? [['workspace', `Everyone in ${curWs().name}`, 'Shown on Discover for everyone.']] : [])];
  /** A['col-new']({dataset:{ids?}}) creates a collection (optionally with resources); A['col-edit']({dataset:{id}}) edits one. */
  A['col-new'] = el => { S.ui.colEdit = { id: '', name: '', desc: '', share: 'private', ids: (el?.dataset?.ids || '').split(',').filter(Boolean), touched: false }; openModal('col-edit', {}); };
  A['col-edit'] = el => { const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return; S.ui.colEdit = { id: c.id, name: c.name, desc: c.desc || '', share: c.share || 'private', ids: [], touched: false }; openModal('col-edit', {}); };
  M['col-edit'] = () => {
    const f = ui('colEdit'), err = f.touched && !f.name.trim() ? 'Enter a name.' : '';
    const opts = SHARE_OPTS(); if (!opts.some(o => o[0] === f.share)) opts.push([f.share, shareLabel({ share: f.share }).label, 'Current sharing']);
    return {
      size: 'md', title: f.id ? 'Edit collection' : 'New collection', desc: f.ids.length ? plural(f.ids.length, 'resource') + ' will be added' : '',
      body: field({ id: 'col-name', label: 'Name', required: true, error: err, control: input({ id: 'col-name', bind: 'colEdit.name', value: f.name, placeholder: 'e.g. Thesis reading list', autofocus: true, onEnter: 'col-edit-go', invalid: !!err, attrs: 'maxlength="60"' }) })
        + `<div class="mt-16">${field({ id: 'col-desc', label: 'Description', optional: true, control: textarea({ id: 'col-desc', bind: 'colEdit.desc', value: f.desc, rows: 2, attrs: 'maxlength="200"' }) })}</div>`
        + `<div class="field mt-16"><span class="label">Who can see it</span>${choiceGroup({ name: 'col-share', value: f.share, act: 'col-edit-share', options: opts })}<div class="description mt-4">People still need access to a resource to open it.</div></div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn(f.id ? 'Save' : 'Create', { v: 'primary', act: 'col-edit-go' }),
    };
  };
  A['col-edit-share'] = el => { ui('colEdit').share = el.dataset.value; refreshLayer(); };
  A['col-edit-go'] = () => {
    const f = ui('colEdit'); f.touched = true;
    if (!f.name.trim()) { refreshLayer(); $('#col-name')?.focus(); return; }
    if (f.id) {
      const c = collectionById(f.id); Object.assign(c, { name: f.name.trim(), desc: f.desc.trim(), share: f.share, updated: Date.now() });
      audit('Updated a collection', c.name); closeModal(); refresh(); toast('Collection saved'); return;
    }
    const c = { id: uid('col'), name: f.name.trim(), desc: f.desc.trim(), owner: me().id, share: f.share, created: Date.now(), updated: Date.now(), items: f.ids.map(doc => ({ doc, added: Date.now() })) };
    (D.collections ??= []).unshift(c); audit('Created a collection', c.name);
    closeModal(); go('/knowledge/collections/' + c.id); toast(`Created “${c.name}”`);
  };

  /* ── Edit details (editors of the knowledge base) ── */
  A['res-edit'] = el => {
    const d = docById(el.dataset.id); if (!canEditRes(d)) return; const r = res(d);
    S.ui.resEdit = { id: d.id, name: d.name, kind: r.kind, topics: [...r.topics], owner: d.owner || '', lang: r.lang, summary: d.summary || '', touched: false };
    openModal('res-edit', {});
  };
  M['res-edit'] = () => {
    const f = ui('resEdit'), d = docById(f.id), r = res(d), err = f.touched && !f.name.trim() ? 'Enter a title.' : '';
    const kinds = Object.entries(RESOURCE_KINDS).map(([id, k]) => [id, `${k.group} · ${k.label}`]);
    const topics = topicTree().map(dm => `<div class="res-tgroup"><div class="t-label">${esc(dm.name)}</div><div class="res-tgroup__items">${dm.children.map(t => checkbox({ checked: f.topics.includes(t.id), act: 'res-edit-topic', data: { id: t.id }, label: esc(t.name) })).join('')}</div></div>`).join('');
    return {
      size: 'lg', title: 'Edit details', desc: esc(d.name),
      body: `<div class="stack gap-16">${field({ id: 'rese-name', label: 'Title', required: true, error: err, control: input({ id: 'rese-name', bind: 'resEdit.name', value: f.name, invalid: !!err, attrs: 'maxlength="160"' }) })}
        <div class="grid cols-2">${field({ id: 'rese-kind', label: 'Type', control: select({ id: 'rese-kind', bind: 'resEdit.kind', value: f.kind, options: kinds }) })}${field({ id: 'rese-lang', label: 'Language', control: select({ id: 'rese-lang', bind: 'resEdit.lang', value: f.lang, options: Object.entries(LANGS) }) })}</div>
        ${field({ id: 'rese-owner', label: 'Owner', optional: true, desc: `Leave empty to use the knowledge base owner (${esc(ownerOfKb(r.kb) || 'none')}).`, control: input({ id: 'rese-owner', bind: 'resEdit.owner', value: f.owner, placeholder: ownerOfKb(r.kb) || 'Team or office' }) })}
        ${field({ id: 'rese-sum', label: 'Summary', optional: true, desc: 'One or two sentences people see in results and previews.', control: textarea({ id: 'rese-sum', bind: 'resEdit.summary', value: f.summary, rows: 2, attrs: 'maxlength="280"' }) })}
        <div class="field"><span class="label">Topics</span><div class="res-tgroups">${topics || '<p class="t-sm muted">This workspace has no topics yet.</p>'}</div></div></div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'res-edit-go' }),
    };
  };
  A['res-edit-topic'] = el => { const f = ui('resEdit'), id = el.dataset.id; f.topics = f.topics.includes(id) ? f.topics.filter(x => x !== id) : [...f.topics, id]; refreshLayer(); };
  A['res-edit-go'] = () => {
    const f = ui('resEdit'), d = docById(f.id); f.touched = true;
    if (!f.name.trim()) { refreshLayer(); $('#rese-name')?.focus(); return; }
    Object.assign(d, { name: f.name.trim(), kind: f.kind, topics: [...f.topics], lang: f.lang, summary: f.summary.trim() || undefined, owner: f.owner.trim() || undefined });
    if (!d.summary) delete d.summary; if (!d.owner) delete d.owner;
    audit('Edited resource details', d.name); closeModal(); refresh(); toast('Details saved');
  };

  /* ── Link to spaces (space staff / admins) ── */
  A['res-link'] = el => { const d = docById(el.dataset.id); if (!d) return; S.ui.resLink = { id: d.id, picked: [...(d.contexts || [])] }; openModal('res-link', {}); };
  M['res-link'] = () => {
    const f = ui('resLink'), d = docById(f.id), home = kbById(d.kb)?.space;
    const opts = linkableSpaces().map(s => {
      const fixed = s.id === home;
      return `<div class="res-pick">${checkbox({ checked: fixed || f.picked.includes(s.id), disabled: fixed, act: 'res-link-pick', data: { id: s.id }, label: `<span class="row gap-8">${X.spaceMark ? X.spaceMark(s, 24) : ''}<span class="stack"><span class="medium">${esc(s.name)}${s.code ? ` · ${esc(s.code)}` : ''}</span><span class="t-xs muted">${fixed ? 'Its knowledge base belongs to this space' : esc(spaceType(s.type).label)}</span></span></span>` })}</div>`;
    }).join('');
    return {
      size: 'sm', title: 'Link to spaces', desc: esc(d.name),
      body: `<div class="res-picks">${opts}</div><p class="t-xs muted mt-12">It appears in each space’s materials. It stays in ${esc(kbById(d.kb)?.name || 'its knowledge base')}, and access doesn’t change.</p>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'res-link-go' }),
    };
  };
  A['res-link-pick'] = el => { const f = ui('resLink'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; refreshLayer(); };
  A['res-link-go'] = () => {
    const f = ui('resLink'), d = docById(f.id), manageable = new Set(linkableSpaces().map(s => s.id));
    const keep = (d.contexts || []).filter(id => !manageable.has(id));
    d.contexts = [...new Set([...keep, ...f.picked.filter(id => manageable.has(id))])];
    audit('Linked a resource to spaces', d.name); closeModal(); refresh();
    toast(d.contexts.length ? `Linked to ${plural(res(d).contexts.length, 'space')}` : 'Removed from spaces');
  };
})();

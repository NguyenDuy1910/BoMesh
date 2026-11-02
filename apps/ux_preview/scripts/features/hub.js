/* Knowledge: Browse (/knowledge) — the one catalog for search and filters;
   the URL holds its state, so every result set is linkable and can be saved
   as a view. Discovery (what exists, featured, recommended) lives on Home.
   Model: core/catalog.js. Pieces: X.res (resources.js).
   Actions: cat-*. Drawer: cat-filters. Modal: cat-save-view. Menu: cat-sort. */
(() => {
  'use strict';

  const PER = 20, FACET_TOP = 6;
  /** Facet groups open on first visit; the rest open when they hold a selection or the user opens them. */
  const OPEN_BY_DEFAULT = ['topic', 'space', 'kind', 'trust', 'upd'];
  const LAYOUTS = [['list', 'List', 'list'], ['table', 'Table', 'table'], ['grid', 'Grid', 'grid']];
  /** The preview panel needs room next to the rail and results; below this the reader opens directly. */
  const wide = () => ($('#frame')?.clientWidth || innerWidth) >= 1200;
  const openDoc = (id, q = '') => go('/doc/' + id + (q ? '?q=' + encodeURIComponent(q) : ''));

  /** Empty Browse (nothing readable yet, or the forced Empty state). */
  function emptyKnowledge() {
    const up = X.res.uploadBtn('primary');
    return emptyState({
      icon: 'book', title: 'No knowledge yet', boxed: true,
      desc: up ? 'Contribute files or connect a source to start the catalog.' : 'Nothing has been shared with you yet.',
      actions: up + btn('Knowledge bases', { href: '/knowledge/bases' }),
    });
  }

  /* ═══════════════ Browse ═══════════════ */
  const cui = () => ui('cat', { fold: {}, more: {}, open: {}, page: 1 });
  const cur = () => parseCatalogQuery(S.cur.query);
  /** Canonical query string for params (what a saved view stores). */
  const qsOf = p => new URLSearchParams(Object.entries(catalogQueryOf(p)).filter(([, v]) => v)).toString();
  const parseQs = s => parseCatalogQuery(Object.fromEntries(new URLSearchParams(s || '')));
  /** Identity of a result set, ignoring the layout. */
  const setKey = p => qsOf({ ...p, view: 'list' });
  /** Replace the catalog query (filters, q, sort, saved), keeping the layout unless p changes it; clears the selection. */
  const apply = (p, keepSel = false) => { cui().page = 1; setQuery({ ...catalogQueryOf(p), sel: keepSel ? S.cur.query.sel || '' : '' }); };
  const facetById = id => facetsOn().find(f => f.id === id);
  const filterLabels = p => facetsOn().flatMap(f => (p.filters[f.id] || []).map(v => f.name(v)));
  const describe = p => [p.q && `“${p.q}”`, ...filterLabels(p), p.saved && 'Saved'].filter(Boolean).join(' · ');
  const domId = s => String(s).replace(/[^\w-]/g, '_');

  /* ── Facet rail (also the body of the Filters drawer) ── */
  const optLabel = o => `<span class="cat-opt__label">${esc(o.label)}</span><span class="cat-opt__n">${fmtNum(o.count)}</span>`;
  const optBox = (f, o, pre) => `<div class="${cx('cat-opt', !o.count && 'is-zero')}">${checkbox({ id: `${pre}-${f.id}-${domId(o.value)}`, checked: o.on, act: 'cat-facet', data: { f: f.id, v: o.value }, label: optLabel(o) })}</div>`;
  function checkOpts(f, opts, pre) {
    const more = cui().more[f.id];
    const shown = more ? opts : opts.filter((o, i) => i < FACET_TOP || o.on);
    return shown.map(o => optBox(f, o, pre)).join('') + (opts.length > FACET_TOP ? `<button type="button" class="cat-more" data-act="cat-more" data-f="${f.id}">${more ? 'Show less' : `Show all ${fmtNum(opts.length)}`}</button>` : '');
  }
  function radioOpts(f, opts, pre) {
    const on = opts.find(o => o.on)?.value || '';
    const rows = [{ value: '', label: 'Any time', on: !on }, ...UPDATED_WINDOWS.map(([id]) => opts.find(o => o.value === id) || { value: id, label: f.name(id), count: 0, on: false })];
    return `<div role="radiogroup" aria-label="${esc(f.label)}">${rows.map(o => `<button type="button" role="radio" id="${pre}-${f.id}-${o.value || 'any'}" aria-checked="${o.on}" class="${cx('cat-opt cat-radio', o.count === 0 && 'is-zero')}" data-act="cat-facet" data-f="${f.id}" data-v="${esc(o.value)}"><span class="radio__control" aria-hidden="true"></span><span class="cat-opt__label">${esc(o.label)}</span>${o.count != null ? `<span class="cat-opt__n">${fmtNum(o.count)}</span>` : ''}</button>`).join('')}</div>`;
  }
  /** Topic facet as a tree: domain → topics. Domains open when they (or a topic) are selected. */
  function topicOpts(f, opts, pre) {
    const by = new Map(opts.map(o => [o.value, o])), u = cui();
    return topicTree().map(dm => {
      const kids = dm.children.map(t => by.get(t.id)).filter(Boolean);
      const d = by.get(dm.id) || (kids.length ? { value: dm.id, label: dm.name, count: 0, on: false } : null);
      if (!d) return '';
      const open = u.open[dm.id] ?? (d.on || kids.some(k => k.on));
      const twist = kids.length ? `<button type="button" class="cat-twist" data-act="cat-twist" data-id="${dm.id}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} topics in ${esc(dm.name)}">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}</button>` : '<span class="cat-twist" aria-hidden="true"></span>';
      return `<div class="cat-tree"><div class="cat-tree__row">${twist}${optBox(f, d, pre)}</div>${open && kids.length ? `<div class="cat-tree__kids">${kids.map(k => optBox(f, k, pre)).join('')}</div>` : ''}</div>`;
    }).join('');
  }
  function rail(p, r, pre) {
    const u = cui(), views = myViews(), key = setKey(p), nSaved = savedResources().length;
    const viewList = views.length
      ? `<div class="cat-views">${views.map(v => { const on = setKey(parseQs(v.query)) === key; return `<button type="button" class="${cx('cat-view', on && 'is-on')}" data-act="cat-apply-view" data-id="${esc(v.id)}" ${on ? 'aria-current="true"' : ''}>${ic('filter', 'i-sm')}<span class="truncate">${esc(v.name)}</span></button>`; }).join('')}</div>`
      : '<p class="cat-none">No saved views</p>';
    const savedOnly = `<div class="cat-opt cat-opt--saved">${checkbox({ id: `${pre}-saved`, checked: !!p.saved, act: 'cat-saved', label: `<span class="cat-opt__label">Only saved</span><span class="cat-opt__n">${fmtNum(nSaved)}</span>` })}</div>`;
    const head = `<section class="cat-group"><div class="cat-group__head"><h3 class="cat-group__title">Saved views</h3>${views.length ? linkBtn('Manage', { href: '/knowledge/library?tab=views' }) : ''}</div>${viewList}${savedOnly}</section>`;
    const groups = facetsOn().map(f => {
      const opts = r.facets[f.id] || [], nOn = (p.filters[f.id] || []).length;
      if (!opts.length && f.id !== 'upd') return '';
      const open = u.fold[f.id] ?? (OPEN_BY_DEFAULT.includes(f.id) || nOn > 0);
      const body = f.id === 'topic' ? topicOpts(f, opts, pre) : f.single ? radioOpts(f, opts, pre) : checkOpts(f, opts, pre);
      return `<section class="cat-group"><button type="button" class="cat-group__toggle" id="${pre}-fold-${f.id}" data-act="cat-fold" data-f="${f.id}" aria-expanded="${open}"><span class="cat-group__title">${esc(f.label)}</span>${nOn ? `<span class="badge badge--accent">${nOn}</span>` : ''}<span class="grow"></span>${ic(open ? 'chevron-up' : 'chevron-down', 'i-sm')}</button>${open ? `<div class="cat-opts">${body}</div>` : ''}</section>`;
    }).join('');
    return head + groups;
  }

  /* ── Toolbar, chips, results ── */
  function toolbar(p, r, query) {
    const n = activeFilterCount(p), exists = myViews().some(v => setKey(parseQs(v.query)) === setKey(p)), canSave = !!(p.q || n);
    const search = `<div class="search-field cat-search">${ic('search')}<input class="input" id="cat-q" type="search" value="${esc(query.q || '')}" placeholder="Search titles, topics and content" aria-label="Search knowledge" data-input="cat-q" autocomplete="off">${query.q ? `<span class="search-field__clear">${iconBtn('x', 'Clear search', { size: 'sm', act: 'cat-q-clear' })}</span>` : ''}</div>`;
    const save = exists ? btn('View saved', { size: 'sm', icon: 'check', disabled: true }) : btn('Save view', { size: 'sm', icon: 'bookmark', act: 'cat-save-view', disabled: !canSave });
    const ask = btn('Ask about these results', { size: 'sm', icon: 'sparkles', act: 'cat-ask', disabled: !r.total });
    const layout = `<div class="toggle-group cat-layoutsw" role="group" aria-label="Layout">${LAYOUTS.map(([id, l, icon]) => `<button type="button" aria-pressed="${id === p.view}" data-act="cat-layout" data-value="${id}" aria-label="${l}" data-tip="${l}">${ic(icon, 'i-sm')}</button>`).join('')}</div>`;
    const sort = btn(SORTS_CATALOG[r.sort], { v: 'ghost', size: 'sm', icon: 'sort', iconRight: 'chevron-down', menu: 'cat-sort', aria: 'aria-label="Sort: ' + esc(SORTS_CATALOG[r.sort]) + '"' });
    const filters = `<span class="cat-filters-btn">${btn(n ? `Filters (${n})` : 'Filters', { size: 'sm', icon: 'sliders', act: 'cat-filters', cls: n ? 'is-set' : '' })}</span>`;
    return `<div class="cat-bar">${search}<div class="cat-bar__actions">${save}${ask}</div></div>
      <div class="cat-sub">${filters}<span class="cat-count" role="status">${plural(r.total, 'result')}</span><span class="grow"></span>${sort}${layout}</div>`;
  }
  function chipsRow(p) {
    const chips = facetsOn().flatMap(f => (p.filters[f.id] || []).map(v => `<button type="button" class="cat-chip" data-act="cat-unfilter" data-f="${f.id}" data-v="${esc(v)}" aria-label="Remove filter ${esc(f.label)}: ${esc(f.name(v))}"><span class="cat-chip__k">${esc(f.label)}</span><span class="truncate">${esc(f.name(v))}</span>${ic('x', 'i-xs')}</button>`));
    if (p.saved) chips.unshift(`<button type="button" class="cat-chip" data-act="cat-unfilter" data-f="saved" aria-label="Remove filter Saved">${ic('bookmark-filled', 'i-xs')}<span>Saved</span>${ic('x', 'i-xs')}</button>`);
    return chips.length ? `<div class="cat-chips">${chips.join('')}${linkBtn('Clear all', { act: 'cat-clear' })}</div>` : '';
  }
  function results(p, r, sel) {
    const page = paginate(r.rows, 'cat', PER).map(x => x.doc), data = p.q ? { q: p.q } : undefined;
    let html;
    if (p.view === 'table') html = table({ head: X.res.tableHead(), rows: page.map(d => X.res.tableRow(d, { act: 'cat-select', data, active: d.id === sel })), label: 'Resources' });
    else if (p.view === 'grid') html = `<div class="cat-cards">${page.map(d => { const h = X.res.card(d, { act: 'cat-select', data }); return d.id === sel ? h.replace('res-card"', 'res-card is-active" aria-current="true"') : h; }).join('')}</div>`;
    else html = X.res.rows(page, d => ({ q: p.q, act: 'cat-select', data, active: d.id === sel }));
    return `<div class="cat-results">${html}</div>${r.total > PER ? pager(r.total, 'cat', PER) : ''}`;
  }
  function noMatches(p) {
    const n = activeFilterCount(p);
    return emptyState({
      icon: 'search', title: p.q ? `No results for “${p.q}”` : 'No resources match these filters', desc: n ? 'Try fewer filters or different words.' : 'Try different words.',
      actions: (n ? btn('Clear filters', { act: 'cat-clear' }) : '') + (p.q ? btn('Clear search', { act: 'cat-q-clear' }) : '') + btn('Ask the assistant', { icon: 'sparkles', act: 'cat-ask' }),
      boxed: true, compact: true,
    });
  }
  const lockedNote = () => (visibleKbs().some(k => kbRole(k) === 'none') ? `<a class="cat-locked" href="#/knowledge/bases">${ic('lock', 'i-sm')}<span>Some knowledge bases aren’t shared with you</span>${ic('arrow-right', 'i-sm')}</a>` : '');

  /* ── Preview panel (wide frames) ── */
  function preview(d, p) {
    const r = res(d), readable = isSearchable(d), use = readable ? X.res.useItems(d) : [];
    const snip = p.q ? resSnippet(d, p.q) : '';
    return `<aside class="cat-preview" aria-label="Preview">
      <div class="cat-preview__bar">${X.res.kindChip(d)}${X.res.trustChip(d)}${X.res.statusChip(d)}<span class="grow"></span>${X.res.moreBtn(d)}${iconBtn('x', 'Close preview', { size: 'sm', act: 'cat-close' })}</div>
      <div class="cat-preview__head">${fileIcon(d.type, 'lg')}<h2 class="cat-preview__title">${esc(d.name)}</h2></div>
      <div class="cat-preview__meta">${X.res.provenance(d)}<span class="res-dot" aria-hidden="true">·</span><span>Updated ${esc(rel(d.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase()))}</span></div>
      <p class="cat-preview__summary">${markTokens(r.summary, tokens(p.q))}</p>
      ${snip ? `<div class="cat-preview__snip">${ic('quote', 'i-sm')}<span>${snip}</span></div>` : ''}
      <div class="cat-preview__actions">${btn('Open', { v: 'primary', size: 'sm', icon: 'file-text', act: 'res-open', data: { id: d.id, q: p.q || undefined } })}${X.res.saveBtn(d, { label: true })}${btn('Add to collection', { size: 'sm', icon: 'list-plus', act: 'res-collect', data: { id: d.id } })}${readable ? btn('Ask', { size: 'sm', icon: 'sparkles', act: 'res-ask', data: { id: d.id, q: p.q || undefined } }) : ''}${use.length ? btn('Use in', { size: 'sm', icon: 'zap', iconRight: 'chevron-down', menu: 'res-use', data: { id: d.id } }) : ''}</div>
      <div class="cat-preview__details">${X.res.details(d)}</div>
    </aside>`;
  }

  P.catalog = ({ query }) => {
    const p = parseCatalogQuery(query), u = cui();
    const head = X.res.hubHeader('browse', { actions: X.res.uploadBtn() });
    const body = gate({
      loading: () => `<div class="cat-layout"><aside class="cat-rail" aria-busy="true">${Array.from({ length: 4 }, (_, i) => `<div class="cat-group"><span class="skeleton skeleton--line" style="width:${40 + i * 9}%"></span>${Array.from({ length: 4 }, (_, j) => `<span class="skeleton skeleton--line" style="width:${55 + ((i + j) * 13) % 35}%;height:10px"></span>`).join('')}</div>`).join('')}</aside><div class="cat-main"><span class="skeleton cat-skel-bar"></span>${skelRows(8)}</div></div>`,
      empty: emptyKnowledge,
      error: () => errorState(),
      ok: () => {
        if (!catalogPool().length) return emptyKnowledge();
        const r = catalogSearch(p), key = setKey(p);
        if (u.lastKey !== key) { u.page = 1; u.lastKey = key; }
        const sel = query.sel && wide() ? r.pool.find(d => d.id === query.sel) || null : null;
        const main = `<div class="cat-main">${toolbar(p, r, query)}${chipsRow(p)}${r.total ? results(p, r, sel?.id) : noMatches(p)}${lockedNote()}</div>`;
        return `<div class="${cx('cat-layout', sel && 'has-preview')}"><aside class="cat-rail" aria-label="Filters">${rail(p, r, 'cf')}</aside>${main}${sel ? preview(sel, p) : ''}</div>`;
      },
    });
    return `<div class="page page--wide cat">${head}${body}</div>`;
  };

  DR['cat-filters'] = () => {
    const p = cur(), r = catalogSearch(p), n = activeFilterCount(p);
    return {
      title: 'Filters', desc: n ? plural(n, 'filter') + ' applied' : '',
      body: `<div class="cat-rail cat-rail--drawer">${rail(p, r, 'cfd')}</div>`,
      footStart: n ? btn('Clear all', { v: 'ghost', act: 'cat-clear' }) : '',
      foot: btn(`Show ${plural(r.total, 'result')}`, { v: 'primary', act: 'close-drawer' }),
    };
  };

  /* ── Browse actions ── */
  A['cat-q'] = el => { cui().page = 1; setQuery({ q: el.value, sel: '' }); };
  A['cat-q-clear'] = () => { cui().page = 1; setQuery({ q: '', sel: '' }); $('#cat-q')?.focus(); };
  A['cat-facet'] = el => {
    const p = cur(), f = facetById(el.dataset.f), v = el.dataset.v || ''; if (!f) return;
    const now = p.filters[f.id] || [];
    p.filters[f.id] = f.single ? (!v || now.includes(v) ? [] : [v]) : now.includes(v) ? now.filter(x => x !== v) : [...now, v];
    apply(p, true);
  };
  A['cat-unfilter'] = el => {
    const p = cur(), f = el.dataset.f;
    if (f === 'saved') p.saved = false; else p.filters[f] = (p.filters[f] || []).filter(x => x !== el.dataset.v);
    apply(p, true);
  };
  A['cat-clear'] = () => { const p = cur(); p.filters = {}; p.saved = false; apply(p); };
  A['cat-saved'] = () => { const p = cur(); p.saved = !p.saved; apply(p, true); };
  A['cat-fold'] = el => { cui().fold[el.dataset.f] = el.getAttribute('aria-expanded') !== 'true'; refresh(); };
  A['cat-more'] = el => { const m = cui().more; m[el.dataset.f] = !m[el.dataset.f]; refresh(); };
  A['cat-twist'] = el => { cui().open[el.dataset.id] = el.getAttribute('aria-expanded') !== 'true'; refresh(); };
  A['cat-layout'] = el => setQuery({ view: el.dataset.value === 'list' ? '' : el.dataset.value });
  A['cat-filters'] = () => openDrawer('cat-filters');
  A['cat-apply-view'] = el => { const v = myViews().find(x => x.id === el.dataset.id); if (!v) return; if (S.drawer) closeDrawer(); apply(parseQs(v.query)); };
  /** Click selects (preview panel on wide frames); Enter, double-click or a narrow frame opens the reader. */
  A['cat-select'] = (el, e) => {
    const id = el.dataset.id, q = S.cur.query.q || '';
    if (e?.type === 'keydown' || !wide()) { openDoc(id, q.trim()); return; }
    if (S.cur.query.sel !== id) setQuery({ sel: id });
  };
  A['cat-close'] = () => setQuery({ sel: '' });
  MENUS['cat-sort'] = () => {
    const p = cur(), hasQ = tokens(p.q).length > 0, def = hasQ ? 'relevance' : 'updated', active = p.sort || def;
    return [{ section: 'Sort by' }, ...Object.entries(SORTS_CATALOG).filter(([k]) => k !== 'relevance' || hasQ)
      .map(([k, label]) => ({ label, checked: k === active, run: () => { cui().page = 1; setQuery({ sort: k === def ? '' : k }); } }))];
  };
  A['cat-ask'] = () => {
    const p = cur(), r = catalogSearch(p), docs = r.rows.map(x => x.doc).filter(isSearchable).slice(0, 8), labels = filterLabels(p);
    const q = p.q
      ? `What do these resources say about “${p.q}”?${labels.length ? ` (${labels.join(', ')})` : ''}`
      : `Give me an overview of these resources${labels.length ? ` (${labels.join(', ')})` : ''}: the main points, how they differ and what is most current.`;
    if (A['chat-ask']) A['chat-ask']({ dataset: { q, ...(docs.length ? { docs: docs.map(d => d.id).join(',') } : {}) } }); else go('/chat');
  };

  /* ── Save view ── */
  A['cat-save-view'] = () => {
    const p = cur(), name = (filterLabels(p).join(' · ') || p.q || 'My view').slice(0, 60);
    S.ui.catView = { name: p.q && filterLabels(p).length ? `${p.q} · ${name}`.slice(0, 60) : name, touched: false };
    openModal('cat-save-view', {});
  };
  M['cat-save-view'] = () => {
    const f = ui('catView'), err = f.touched && !f.name.trim() ? 'Enter a name.' : '';
    return {
      size: 'sm', title: 'Save view', desc: esc(describe(cur())),
      body: field({ id: 'catv-name', label: 'Name', required: true, error: err, control: input({ id: 'catv-name', bind: 'catView.name', value: f.name, autofocus: true, onEnter: 'cat-save-view-go', invalid: !!err, attrs: 'maxlength="60"' }) }),
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Save', { v: 'primary', act: 'cat-save-view-go' }),
    };
  };
  A['cat-save-view-go'] = () => {
    const f = ui('catView'); f.touched = true;
    const name = f.name.trim();
    if (!name) { refreshLayer(); $('#catv-name')?.focus(); return; }
    const v = { id: uid('vw'), name, query: qsOf(cur()), created: Date.now() };
    myViews().unshift(v); closeModal(); refresh();
    toast(`Saved view “${name}”`, { action: { label: 'Undo', run: () => { const l = myViews(), i = l.indexOf(v); if (i >= 0) l.splice(i, 1); refresh(); } } });
  };

  /* ── Keyboard, double-click, resize ── */
  const prevEsc = A['esc-page'];
  A['esc-page'] = () => { if (S.cur?.r.page === 'catalog' && S.cur.query.sel) { setQuery({ sel: '' }); return true; } return prevEsc ? prevEsc() : false; };
  document.addEventListener('dblclick', e => {
    const el = e.target.closest?.('.cat [data-act="cat-select"]');
    if (el && !e.target.closest('button,a,input,label')) openDoc(el.dataset.id, (S.cur.query.q || '').trim());
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.cur?.r.page === 'catalog' && S.cur.query.sel) refresh(); }, 150); });
})();

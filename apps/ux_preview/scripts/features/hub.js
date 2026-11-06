/* Knowledge: Browse (/knowledge) — the organization's knowledge, content first.
   One search field, topic shortcuts (the only topic control), collections shared
   with you (landing), and a grid of documents you can recognise and judge
   without opening them. Filters sit right above the results as inline buttons
   (Type · Updated · Trust · Owner, the rest under More filters), each opening a
   light popover of checkboxes with counts; results update as you tick, and the
   choices show as removable chips next to the result count. On phones one
   Filters button opens them all as a bottom sheet. Saved views live in the
   Views dropdown next to the filters (open, save, rename, delete). A document
   opens in the shared document preview overlay (preview.js), then the Reader.
   The URL holds the result set (q, filters, sort, view), so every set is
   linkable and can be saved as a view. A knowledge base is a filter here (kb=);
   a locked one offers Request access. Personal files, saved and recent reads
   live in My library. Model: core/catalog.js. Pieces: X.res (resources.js).
   Actions: cat-*. Popovers: cat-f (data-f = facet id | more | all).
   Modals: cat-save-view, cat-view-rename. Menus: cat-sort, cat-topics, cat-views. */
(() => {
  'use strict';

  const PER = 24, FACET_TOP = 6, TOPIC_PILLS = 6;
  /** Filters shown as their own buttons (the ones people narrow by most); the others sit under More filters. Topic is the pills above. */
  const INLINE = ['kind', 'upd', 'trust', 'owner'];
  const LAYOUTS = [['grid', 'Grid', 'grid'], ['list', 'List', 'list']];
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  /** Browse searches the organization's knowledge only (My files are in My library). */
  const search = p => catalogSearch(p, sharedPool());

  /** Empty Browse (nothing readable yet, or the forced Empty state). */
  function emptyKnowledge() {
    const up = X.res.uploadBtn('primary');
    return emptyState({
      icon: 'book', title: 'No knowledge yet', boxed: true,
      desc: up ? 'Contribute files or connect a source to start the catalog.' : 'Nothing has been shared with you yet.',
      actions: up + (can('knowledge.manage') ? btn('Create knowledge base', { icon: 'plus', act: 'kb-create' }) : ''),
    });
  }

  /* ═══════════════ State ═══════════════ */
  const cui = () => ui('cat', { more: {}, page: 1 });
  const cur = () => parseCatalogQuery(S.cur.query);
  /** Canonical query string for params (what a saved view stores). */
  const qsOf = p => new URLSearchParams(Object.entries(catalogQueryOf(p)).filter(([, v]) => v)).toString();
  const parseQs = s => parseCatalogQuery(Object.fromEntries(new URLSearchParams(s || '')));
  /** Identity of a result set, ignoring the layout. */
  const setKey = p => qsOf({ ...p, view: 'grid' });
  const apply = p => { cui().page = 1; setQuery(catalogQueryOf(p)); };
  const facetById = id => facetsOn().find(f => f.id === id);
  const filterLabels = p => facetsOn().flatMap(f => (p.filters[f.id] || []).map(v => f.name(v)));
  const describe = p => [p.q && `“${p.q}”`, ...filterLabels(p)].filter(Boolean).join(' · ');
  const domId = s => String(s).replace(/[^\w-]/g, '_');
  /** The one topic the shortcuts represent: a single selected domain or topic. Anything else is shown as chips. */
  const pillTopic = p => ((p.filters.topic || []).length === 1 ? p.filters.topic[0] : '');
  const isLanding = p => !p.q && !activeFilterCount(p);
  /** Filter facets (everything but topic, which the pills own): the inline ones, then the rest. */
  const filterFacets = () => facetsOn().filter(f => f.id !== 'topic');
  const inlineFacets = () => INLINE.map(facetById).filter(Boolean);
  /** More filters: the remaining facets that can still narrow the set (two or more values) or hold a selection. */
  const moreFacets = (p, r) => filterFacets().filter(f => !INLINE.includes(f.id) && ((r.facets[f.id] || []).length > 1 || (p.filters[f.id] || []).length));
  const nOn = (p, list) => list.reduce((a, f) => a + (p.filters[f.id] || []).length, 0);
  const savedView = p => myViews().find(v => setKey(parseQs(v.query)) === setKey(p));

  /* ═══════════════ Filters: inline buttons → popovers (bottom sheet on phones) ═══════════════ */
  const optLabel = o => `<span class="cat-opt__label">${esc(o.label)}</span><span class="cat-opt__n">${fmtNum(o.count)}</span>`;
  const optBox = (f, o) => `<div class="${cx('cat-opt', !o.count && 'is-zero')}">${checkbox({ id: `cf-${f.id}-${domId(o.value)}`, checked: o.on, act: 'cat-facet', data: { f: f.id, v: o.value }, label: optLabel(o) })}</div>`;
  function checkOpts(f, opts) {
    const more = cui().more[f.id];
    const shown = more ? opts : opts.filter((o, i) => i < FACET_TOP || o.on);
    return shown.map(o => optBox(f, o)).join('') + (opts.length > FACET_TOP ? `<button type="button" class="cat-more" data-act="cat-more" data-f="${f.id}">${more ? 'Show less' : `Show all ${fmtNum(opts.length)}`}</button>` : '');
  }
  function radioOpts(f, opts) {
    const on = opts.find(o => o.on)?.value || '';
    const rows = [{ value: '', label: 'Any time', on: !on }, ...UPDATED_WINDOWS.map(([id]) => opts.find(o => o.value === id) || { value: id, label: f.name(id), count: 0, on: false })];
    return `<div role="radiogroup" aria-label="${esc(f.label)}">${rows.map(o => `<button type="button" role="radio" id="cf-${f.id}-${o.value || 'any'}" aria-checked="${o.on}" class="${cx('cat-opt cat-radio', o.count === 0 && 'is-zero')}" data-act="cat-facet" data-f="${f.id}" data-v="${esc(o.value)}"><span class="radio__control" aria-hidden="true"></span><span class="cat-opt__label">${esc(o.label)}</span>${o.count != null ? `<span class="cat-opt__n">${fmtNum(o.count)}</span>` : ''}</button>`).join('')}</div>`;
  }
  const facetBody = (f, r) => { const opts = r.facets[f.id] || []; return f.single ? radioOpts(f, opts) : opts.length ? checkOpts(f, opts) : '<p class="cat-none">Nothing to filter by here yet.</p>'; };
  const group = (f, r) => `<section class="cat-group" aria-label="${esc(f.label)}"><h3 class="cat-group__title">${esc(f.label)}</h3><div class="cat-opts">${facetBody(f, r)}</div></section>`;
  /** One popover per trigger: a facet (data-f="kind"), the rest (more) or, on phones, all of them (all). The count in the footer is the
      live result count, so people see the effect of each tick without closing it. */
  const POPS = {};
  POPS['cat-f'] = el => {
    const p = cur(), r = search(p), id = el.dataset.f, count = `<span class="cat-pop__n" role="status">${plural(r.total, 'document')}</span>`;
    if (id === 'all' || id === 'more') {
      const list = id === 'all' ? [...inlineFacets(), ...moreFacets(p, r)] : moreFacets(p, r), n = nOn(p, list);
      return {
        title: id === 'all' ? 'Filters' : 'More filters',
        body: `<div class="cat-pop cat-pop--groups">${list.map(f => group(f, r)).join('')}</div>`,
        // The sheet adds its own Done; the footer says how many documents the choices leave.
        foot: (n ? btn('Clear', { v: 'ghost', size: 'sm', act: 'cat-clear-facets', data: { f: list.map(f => f.id).join(',') } }) : '') + count,
      };
    }
    const f = facetById(id); if (!f) return { title: 'Filter', body: '' };
    return {
      title: f.label,
      body: `<div class="cat-pop">${facetBody(f, r)}</div>`,
      foot: ((p.filters[f.id] || []).length ? btn('Clear', { v: 'ghost', size: 'sm', act: 'cat-clear-facets', data: { f: f.id } }) : '') + count,
    };
  };
  // Registered when the shared popover registry exists (core/overlays.js); the triggers degrade to plain buttons otherwise.
  if (typeof PO === 'object') Object.assign(PO, POPS);
  /** A filter button: "Type", "Type: Policy" or "Type · 2"; opens its popover. */
  function facetBtn(f, p) {
    const on = p.filters[f.id] || [];
    const label = on.length === 1 ? `${f.label}: ${f.name(on[0])}` : on.length ? `${f.label} · ${on.length}` : f.label;
    return popBtn(label, { f: f.id }, on.length > 0, `cat-fb cat-fb--${f.id}`);
  }
  const popBtn = (label, data, set, cls = '', icon = '') => `<button type="button" class="${cx('filter-button', set && 'is-set', cls)}" data-popover="cat-f" ${dataAttrs(data)} aria-haspopup="dialog" aria-expanded="false">${icon ? ic(icon) : ''}<span class="truncate">${esc(label)}</span>${ic('chevron-down')}</button>`;
  /** The bar right above the results: filters on the left; saved views, sort and layout on the right. */
  function filterBar(p, r) {
    const more = moreFacets(p, r), nMore = nOn(p, more), nAll = nOn(p, filterFacets());
    const inline = inlineFacets().map(f => facetBtn(f, p)).join('') + (more.length ? popBtn(nMore ? `More filters · ${nMore}` : 'More filters', { f: 'more' }, nMore > 0, 'cat-fb') : '');
    const all = popBtn(nAll ? `Filters · ${nAll}` : 'Filters', { f: 'all' }, nAll > 0, 'cat-fb-all', 'sliders');
    const v = savedView(p), saveable = !!(p.q || activeFilterCount(p));
    const views = v || saveable || myViews().length ? btn(v ? v.name : 'Views', { v: 'ghost', size: 'sm', icon: 'layers', iconRight: 'chevron-down', menu: 'cat-views', cls: cx('cat-views', v && 'is-set'), aria: `aria-label="${esc(v ? `Saved view: ${v.name}` : 'Saved views')}"` }) : '';
    const sort = btn(SORTS_CATALOG[r.sort], { v: 'ghost', size: 'sm', icon: 'sort', iconRight: 'chevron-down', menu: 'cat-sort', cls: 'cat-sort', aria: 'aria-label="Sort: ' + esc(SORTS_CATALOG[r.sort]) + '"' });
    const layout = `<span class="cat-layoutsw">${seg({ value: p.view, options: LAYOUTS, act: 'cat-layout', label: 'Layout', iconOnly: true, size: 'sm' })}</span>`;
    return `<div class="cat-bar" role="group" aria-label="Filter and sort"><div class="cat-bar__filters">${inline}</div>${all}<div class="cat-bar__end">${views}${sort}${layout}</div></div>`;
  }

  /* ═══════════════ Search and topic shortcuts ═══════════════ */
  /** One field. Typing searches documents (live); Ask AI turns the same words into a cited answer — two clearly named actions, never mixed.
      The count lives in the results header, not repeated here. */
  function searchBar(p) {
    const ask = p.q ? btn('Ask AI', { v: 'secondary', icon: 'sparkles', act: 'cat-ask', cls: 'cat-search__ask', tip: 'Get an answer with sources from these documents' }) : '';
    return `<div class="cat-search">${searchField({ act: 'cat-q', value: p.q, id: 'cat-q', size: 'lg', placeholder: 'Search documents' })}${ask}</div>`;
  }
  const pill = (label, { on, value = '', count, act = 'cat-topic' } = {}) =>
    `<button type="button" class="${cx('cat-pill', on && 'is-on')}" data-act="${act}" data-v="${esc(value)}" aria-pressed="${!!on}">${esc(label)}${count != null ? `<span class="cat-pill__n">${fmtNum(count)}</span>` : ''}</button>`;
  /** Topic shortcuts: domains as one row of pills (the first few, the rest under More); a chosen domain reveals its topics. */
  function topicBar(p, r) {
    const counts = new Map((r.facets.topic || []).map(o => [o.value, o.count]));
    const domains = topicTree().filter(dm => counts.get(dm.id));
    if (!domains.length) return '';
    const sel = pillTopic(p), selDomain = sel && (topicById(sel)?.parent || sel);
    const shown = domains.slice(0, TOPIC_PILLS), rest = domains.slice(TOPIC_PILLS);
    if (selDomain && rest.some(d => d.id === selDomain)) shown.push(rest.splice(rest.findIndex(d => d.id === selDomain), 1)[0]);
    const more = rest.length ? `<button type="button" class="cat-pill cat-pill--more" data-menu="cat-topics" aria-haspopup="menu">More${ic('chevron-down', 'i-xs')}</button>` : '';
    const top = `<div class="cat-pills" role="group" aria-label="Topics">${pill('All', { on: !sel })}${shown.map(dm => pill(dm.name, { on: dm.id === selDomain, value: dm.id })).join('')}${more}</div>`;
    const dm = selDomain && domains.find(d => d.id === selDomain);
    const kids = dm ? dm.children.filter(t => counts.get(t.id)) : [];
    const sub = kids.length > 1 ? `<div class="cat-pills cat-pills--sub" role="group" aria-label="Topics in ${esc(dm.name)}">${pill(`All ${dm.name}`, { on: sel === dm.id, value: dm.id })}${kids.map(t => pill(t.name, { on: sel === t.id, value: t.id, count: counts.get(t.id) })).join('')}</div>` : '';
    return top + sub;
  }
  MENUS['cat-topics'] = () => {
    const p = cur(), r = search(p), counts = new Map((r.facets.topic || []).map(o => [o.value, o.count]));
    return [{ section: 'More topics' }, ...topicTree().filter(dm => counts.get(dm.id)).slice(TOPIC_PILLS).map(dm => ({ label: dm.name, meta: fmtNum(counts.get(dm.id)), run: () => A['cat-topic']({ dataset: { v: dm.id } }) }))];
  };

  /* ═══════════════ Results ═══════════════ */
  /** Context every result on the page shares (one base, one topic) — said once by the filters, not on every card. */
  function sharedContext(page) {
    const one = f => page.length > 1 && new Set(page.map(f)).size === 1;
    return [one(d => d.kb) && 'kb', one(d => res(d).topics[0] || '') && 'topic'].filter(Boolean);
  }
  /** The result count with the choices that produced it: each filter a removable chip (the topic pill excepted — it shows itself),
      Clear all (which clears the topic too), and, for a filtered set without a query, Ask about these. */
  function resultsHead(p, r) {
    const pt = pillTopic(p);
    const chips = facetsOn().flatMap(f => (p.filters[f.id] || []).filter(v => !(f.id === 'topic' && v === pt)).map(v => `<button type="button" class="cat-chip" data-act="cat-unfilter" data-f="${f.id}" data-v="${esc(v)}" aria-label="Remove filter ${esc(f.label)}: ${esc(f.name(v))}"><span class="cat-chip__k">${esc(f.label)}</span><span class="truncate">${esc(f.name(v))}</span>${ic('x', 'i-xs')}</button>`));
    const clear = chips.length ? linkBtn('Clear all', { act: 'cat-clear' }) : '';
    // Ask AI lives in the search field while there is a query; without one it can still summarise a filtered set.
    const ask = !p.q && activeFilterCount(p) && r.total ? btn('Ask about these', { v: 'ghost', size: 'sm', icon: 'sparkles', act: 'cat-ask', tip: 'Get an overview with sources from these documents' }) : '';
    const title = isLanding(p) ? 'All documents' : p.q ? 'Results' : 'Documents';
    // The title already says "documents": the count is just the number (read out in full).
    return `<div class="cat-head"><h2 class="cat-head__title">${title}</h2><span class="cat-count" role="status"><span aria-hidden="true">${fmtNum(r.total)}</span><span class="sr-only">${plural(r.total, 'document')}</span></span>${chips.length ? `<div class="cat-chips">${chips.join('')}${clear}</div>` : ''}<span class="grow"></span>${ask}</div>`;
  }
  function results(p, r) {
    const page = paginate(r.rows, 'cat', PER).map(x => x.doc), data = p.q ? { q: p.q } : undefined;
    if (p.view === 'list') return `<div class="cat-results">${X.res.rows(page, () => ({ q: p.q, act: 'cat-select', data }))}</div>${r.total > PER ? pager(r.total, 'cat', PER) : ''}`;
    // Templated renditions make different documents preview the same section: those cards fall back to their type tile.
    const keys = page.map(d => X.res.previewKey(d, p.q)), seen = new Map();
    keys.forEach(k => k && seen.set(k, (seen.get(k) || 0) + 1));
    const hide = sharedContext(page);
    const cards = page.map((d, i) => X.res.card(d, { act: 'cat-select', data, q: p.q, hide, plain: seen.get(keys[i]) > 1 })).join('');
    return `<div class="cat-results"><div class="cat-cards">${cards}</div></div>${r.total > PER ? pager(r.total, 'cat', PER) : ''}`;
  }
  /** Landing only: reading lists curated for you (shared with the workspace or your spaces). Yours are in My library → My collections.
      Phones show them as one swipeable row, so the documents start near the top. */
  const COLS_SHOWN = 3;
  const sharedCollections = () => visibleCollections().filter(c => c.owner !== me().id && collectionItems(c).ok.length).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || b.updated - a.updated);
  function collectionsRow(p) {
    if (!isLanding(p) || (cui().page || 1) > 1) return '';
    const all = sharedCollections(); if (!all.length) return '';
    const open = cui().colsAll, shown = open ? all : all.slice(0, COLS_SHOWN);
    const more = all.length > COLS_SHOWN ? linkBtn(open ? 'Show less' : `Show all ${fmtNum(all.length)}`, { act: 'cat-cols-all' }) : '';
    const itemHtml = c => `<a class="cat-col" href="#/knowledge/collections/${esc(c.id)}">${itemIcon('list', c.featured ? 'accent' : '', 'sm')}<span class="cat-col__body"><span class="cat-col__title truncate">${esc(c.name)}</span><span class="cat-col__sub truncate">${plural(collectionItems(c).ok.length, 'item')} · ${esc(c.desc || shareLabel(c).label)}</span></span></a>`;
    return `<section class="cat-cols" aria-labelledby="cat-cols-h"><div class="cat-cols__head"><h2 class="cat-cols__title" id="cat-cols-h">Shared with you</h2><span class="grow"></span>${more}</div><div class="cat-cols__list">${shown.map(itemHtml).join('')}</div></section>`;
  }
  function noMatches(p) {
    // Filtered to a base the caller can't read: say so and offer Request access, never an empty result.
    const locked = (p.filters.kb || []).map(kbById).find(k => k && kbRole(k) === 'none');
    if (locked && X.kbLocked) return X.kbLocked(locked);
    const n = activeFilterCount(p);
    return emptyState({
      icon: 'search', title: p.q ? `No documents match “${p.q}”` : 'No documents match these filters',
      desc: p.q ? 'Try other words, or ask the assistant — it can answer from passages a title search misses.' : 'Try fewer filters.',
      actions: (n ? btn('Clear filters', { act: 'cat-clear' }) : '') + (p.q ? btn('Clear search', { act: 'cat-q-clear' }) + btn('Ask AI', { v: 'primary', icon: 'sparkles', act: 'cat-ask' }) : ''),
      boxed: true, compact: true,
    });
  }
  /** One quiet way in to the bases people can see but not open — unless the page already shows one of them. */
  const lockedNote = p => (visibleKbs().some(k => kbRole(k) === 'none') && !(p.filters.kb || []).some(id => kbRole(kbById(id)) === 'none') ? `<button type="button" class="cat-locked" data-act="kb-locked">${ic('lock', 'i-sm')}<span>Some knowledge bases aren’t shared with you</span>${ic('arrow-right', 'i-sm')}</button>` : '');

  function loadingBody() {
    const pills = `<div class="cat-pills" aria-hidden="true">${[44, 64, 72, 58, 66].map(w => `<span class="skeleton cat-skel-pill" style="width:${w}px"></span>`).join('')}</div>`;
    const cardSk = `<div class="doc-card" aria-hidden="true"><span class="skeleton cat-skel-media"></span><div class="doc-card__body"><span class="skeleton skeleton--line" style="width:70%"></span><span class="skeleton skeleton--line" style="width:95%;height:10px"></span><span class="skeleton skeleton--line" style="width:40%;height:10px"></span></div></div>`;
    return `<div class="cat-top" aria-busy="true" aria-label="Loading"><span class="skeleton cat-skel-search"></span>${pills}</div><div class="cat-cards">${cardSk.repeat(6)}</div>`;
  }

  P.catalog = ({ query }) => {
    const p = parseCatalogQuery(query), u = cui();
    const head = X.res.hubHeader('browse', { actions: X.res.uploadBtn() });
    const body = gate({
      loading: loadingBody,
      empty: emptyKnowledge,
      error: () => errorState(),
      ok: () => {
        if (!sharedPool().length) return emptyKnowledge();
        const r = search(p), key = setKey(p);
        if (u.lastKey !== key) { u.page = 1; u.lastKey = key; }
        return `<div class="cat-top">${searchBar(p)}${topicBar(p, r)}</div>${collectionsRow(p)}
          <section class="cat-main" aria-label="Documents">${filterBar(p, r)}${resultsHead(p, r)}${r.total ? results(p, r) : noMatches(p)}</section>${lockedNote(p)}`;
      },
    });
    return `<div class="page cat">${head}${body}</div>`;
  };

  /* ═══════════════ Actions ═══════════════ */
  A['cat-q'] = el => { cui().page = 1; setQuery({ q: el.value }); };
  A['cat-q-clear'] = () => { cui().page = 1; setQuery({ q: '' }); $('#cat-q')?.focus(); };
  /** Topic shortcut: one topic at a time; All clears it. */
  A['cat-topic'] = el => { const p = cur(), v = el.dataset.v || ''; p.filters.topic = v ? [v] : []; apply(p); };
  /** A tick in a filter popover: results update right away; the popover stays open (it re-renders with the new counts). */
  A['cat-facet'] = el => {
    const p = cur(), f = facetById(el.dataset.f), v = el.dataset.v || ''; if (!f) return;
    const now = p.filters[f.id] || [];
    p.filters[f.id] = f.single ? (!v || now.includes(v) ? [] : [v]) : now.includes(v) ? now.filter(x => x !== v) : [...now, v];
    apply(p);
  };
  A['cat-unfilter'] = el => { const p = cur(), f = el.dataset.f; p.filters[f] = (p.filters[f] || []).filter(x => x !== el.dataset.v); apply(p); };
  A['cat-clear-facets'] = el => { const p = cur(); (el.dataset.f || '').split(',').forEach(f => { p.filters[f] = []; }); apply(p); };
  /** Clear all: every filter, the topic included — the result count goes back to everything (the search words stay; they have their own ×). */
  A['cat-clear'] = () => { const p = cur(); p.filters = {}; apply(p); };
  A['cat-cols-all'] = () => { cui().colsAll = !cui().colsAll; refresh(); };
  A['cat-more'] = el => { const m = cui().more; m[el.dataset.f] = !m[el.dataset.f]; refreshLayer(); };
  A['cat-layout'] = el => setQuery({ view: el.dataset.value === 'grid' ? '' : el.dataset.value });
  /** Click, Enter or Space: the document preview overlay (preview.js), the same everywhere; double-click goes straight to the Reader. */
  A['cat-select'] = el => X.preview.open({ id: el.dataset.id, q: (S.cur.query.q || '').trim() });
  MENUS['cat-sort'] = () => {
    const p = cur(), hasQ = tokens(p.q).length > 0, def = hasQ ? 'relevance' : 'updated', active = p.sort || def;
    return [{ section: 'Sort by' }, ...Object.entries(SORTS_CATALOG).filter(([k]) => k !== 'relevance' || hasQ)
      .map(([k, label]) => ({ label, checked: k === active, run: () => { cui().page = 1; setQuery({ sort: k === def ? '' : k }); } }))];
  };
  /** Ask about these: the query (or the filtered set) becomes a cited conversation grounded in these documents. */
  A['cat-ask'] = () => {
    const p = cur(), r = search(p), docs = r.rows.map(x => x.doc).filter(isSearchable).slice(0, 8), labels = filterLabels(p);
    const q = p.q
      ? (/\?\s*$/.test(p.q) ? p.q : `What do these documents say about “${p.q}”?`) + (labels.length ? ` (${labels.join(', ')})` : '')
      : `Give me an overview of these documents${labels.length ? ` (${labels.join(', ')})` : ''}: the main points, how they differ and what is most current.`;
    if (A['chat-ask']) A['chat-ask']({ dataset: { q, ...(docs.length ? { docs: docs.map(d => d.id).join(',') } : {}) } }); else go('/chat');
  };

  /* ── Saved views: the Views dropdown next to the filters — open one, save this set, rename or delete the one you're on ── */
  const viewById = id => myViews().find(v => v.id === id);
  MENUS['cat-views'] = () => {
    const p = cur(), views = myViews(), on = savedView(p), saveable = !!(p.q || activeFilterCount(p));
    return [
      views.length && { section: 'Saved views' },
      ...views.map(v => ({ label: v.name, checked: v === on, run: () => apply(parseQs(v.query)) })),
      views.length && { sep: true },
      saveable && !on && { label: 'Save this view…', icon: 'plus', run: () => A['cat-save-view']() },
      on && { label: 'Rename…', icon: 'pencil', run: () => { S.ui.catRename = { id: on.id, name: on.name, touched: false }; openModal('cat-view-rename', {}); } },
      on && { sep: true },
      on && { label: 'Delete view', icon: 'trash', danger: true, run: () => {
        const l = myViews(), i = l.indexOf(on); l.splice(i, 1); persist(); refresh();
        toast(`Deleted “${on.name}”`, { action: { label: 'Undo', run: () => { myViews().splice(i, 0, on); persist(); refresh(); } } });
      } },
    ].filter(Boolean);
  };
  A['cat-save-view'] = () => {
    const p = cur(), name = (filterLabels(p).join(' · ') || p.q || 'My view').slice(0, 60);
    S.ui.catView = { name: p.q && filterLabels(p).length ? `${p.q} · ${name}`.slice(0, 60) : name, touched: false };
    openModal('cat-save-view', {});
  };
  M['cat-save-view'] = () => {
    const f = ui('catView'), err = f.touched && !f.name.trim() ? 'Enter a name.' : '';
    return {
      size: 'sm', title: 'Save view', icon: 'layers',
      desc: 'Come back to this search and its filters from Views.',
      body: field({ id: 'catv-name', label: 'Name', required: true, error: err, desc: `Saves ${esc(describe(cur()))}`, control: input({ id: 'catv-name', bind: 'catView.name', value: f.name, autofocus: true, onEnter: 'cat-save-view-go', invalid: !!err, attrs: 'maxlength="60" data-input="kn-revalidate" data-form="catView"' }) }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Save view', { v: 'primary', icon: 'check', act: 'cat-save-view-go' }),
    };
  };
  A['cat-save-view-go'] = () => {
    const f = ui('catView'); f.touched = true;
    const name = f.name.trim();
    if (!name) { refreshLayer(); $('#catv-name')?.focus(); return; }
    const v = { id: uid('vw'), name, query: qsOf(cur()), created: Date.now() };
    myViews().unshift(v); persist(); closeModal(); refresh();
    toast(`Saved view “${name}”`, { action: { label: 'Undo', run: () => { const l = myViews(), i = l.indexOf(v); if (i >= 0) l.splice(i, 1); persist(); refresh(); } } });
  };
  M['cat-view-rename'] = () => {
    const f = ui('catRename'), err = f.touched && !f.name.trim() ? 'Enter a name.' : '';
    return {
      size: 'sm', title: 'Rename view', icon: 'pencil',
      body: field({ id: 'catr-name', label: 'Name', required: true, error: err, control: input({ id: 'catr-name', bind: 'catRename.name', value: f.name, autofocus: true, onEnter: 'cat-view-rename-go', invalid: !!err, attrs: 'maxlength="60" data-input="kn-revalidate" data-form="catRename"' }) }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Rename', { v: 'primary', icon: 'check', act: 'cat-view-rename-go' }),
    };
  };
  A['cat-view-rename-go'] = () => {
    const f = ui('catRename'), v = viewById(f.id), name = f.name.trim(); f.touched = true;
    if (!name) { refreshLayer(); $('#catr-name')?.focus(); return; }
    if (!v || v.name === name) { closeModal(); return; }
    const prev = v.name; v.name = name; persist(); closeModal(); refresh();
    toast(`Renamed to “${name}”`, { action: { label: 'Undo', run: () => { v.name = prev; persist(); refresh(); } } });
  };
})();

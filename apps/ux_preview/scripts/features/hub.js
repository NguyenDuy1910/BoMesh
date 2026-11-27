/* Knowledge: Browse (/knowledge) — the organization's knowledge, content first.
   One search field, the first classification scheme's concepts as pills (firstScheme(): Lĩnh vực on campus, Subject
   in enterprise) and a grid of documents you can recognise and judge without opening them. Filters sit right above
   the results as inline buttons (the other classification schemes — Nghiệp vụ, Loại tài liệu, Đối tượng on campus —
   then Format · Updated · Trust · Owner, the rest under More filters), each opening a light popover of checkboxes with
   counts; results update as you tick, and the choices show as removable chips next to the result count. On phones one
   Filters button opens them all as a bottom sheet. A search is also read for the concepts it names (interpretQuery,
   conversation_loop.md "Knowledge retrieval"): what it understood shows as removable chips above the results, and documents filed
   under it rank first — a boost, never a filter. A term with several meanings offers one chip per meaning and splits
   the results into one group per meaning until one is picked. Saved views live in the Views dropdown next to the
   filters (open, save, delete); on a saved view the results heading is its name, click-to-edit to rename it. A
   document opens in the shared document preview overlay (preview.js), then the Reader.
   The URL holds the result set (q, filters, sort, view; ignore = concept ids the reader set aside, pick = the meanings
   chosen or `all`), so every set is linkable and can be saved as a view. A collection is a filter here (kb=); a locked
   one offers Request access. Personal files, saved and recent reads live in My library. Model: core/catalog.js.
   Pieces: X.res (resources.js). Exports X.cat (the query reading, for /search).
   Actions: cat-*. Popovers: cat-f (data-f = facet id | more | all).
   Menus: cat-sort, cat-pills, cat-views. */
(() => {
  'use strict';

  const PER = 24, FACET_TOP = 6, PILLS = 6, GROUP_TOP = 6;
  /** Filters shown as their own buttons after the other classification schemes (the ones people narrow by most); the rest sit
      under More filters. The first scheme is the pills above. */
  const INLINE = ['type', 'upd', 'trust', 'owner'];
  /** A concept the query names lifts every document filed under it above those that only match the words. */
  const BOOST = 1000;
  const LAYOUTS = [['grid', 'Grid', 'grid'], ['list', 'List', 'list']];
  /** Browse searches the organization's knowledge only (My files are in My library), read the way the address says. */
  const search = p => run(p, understand(p, S.cur.query));

  /** Empty Browse (nothing readable yet, or the forced Empty state). */
  function emptyKnowledge() {
    const up = X.res.uploadBtn('primary');
    return emptyState({
      icon: 'book', title: 'No knowledge yet', boxed: true,
      desc: up ? 'Documents appear here once they’re approved and processed. Contribute a file for review, or connect a source.' : 'Nothing has been shared with you yet.',
      actions: up + (can('knowledge.manage') ? btn('Create collection', { icon: 'plus', act: 'kb-create' }) : ''),
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
  const apply = p => { cui().page = 1; setQuery({ ...catalogQueryOf(p), ...(p.q !== cur().q ? { ignore: '', pick: '' } : {}) }); };
  const facetById = id => facetsOn().find(f => f.id === id);
  const filterLabels = p => facetsOn().flatMap(f => (p.filters[f.id] || []).map(v => f.name(v)));
  const domId = s => String(s).replace(/[^\w-]/g, '_');
  /** The one concept the pills represent: a single selected concept of the first scheme. Anything else is shown as chips. */
  const pillConcept = p => { const on = p.filters[firstScheme()?.id] || []; return on.length === 1 ? on[0] : ''; };
  const isLanding = p => !p.q && !activeFilterCount(p);
  /** Filter facets: everything but the first scheme, which the pills own. */
  const filterFacets = () => facetsOn().filter(f => f.id !== firstScheme()?.id);
  /** Inline buttons: the other classification schemes, then the INLINE ones. */
  const inlineFacets = () => [...filterFacets().filter(f => f.scheme), ...INLINE.map(facetById).filter(Boolean)];
  /** More filters: the remaining facets that can still narrow the set (two or more values) or hold a selection. */
  const moreFacets = (p, r) => filterFacets().filter(f => !f.scheme && !INLINE.includes(f.id) && ((r.facets[f.id] || []).length > 1 || (p.filters[f.id] || []).length));
  const nOn = (p, list) => list.reduce((a, f) => a + (p.filters[f.id] || []).length, 0);
  const savedView = p => myViews().find(v => setKey(parseQs(v.query)) === setKey(p));

  /* ═══════════════ Filters: inline buttons → popovers (bottom sheet on phones) ═══════════════ */
  /** An option's name and count. A concept (scheme facets) is content, never translated; a narrower one carries its broader path
      on a second, quieter line, and its full path as the tooltip. */
  function optLabel(f, o) {
    const up = f.scheme && conceptById(o.value)?.broader?.[0];
    const attrs = f.scheme ? ` translate="no" title="${esc(conceptPathText(o.value))}"` : '';
    return `<span class="cat-opt__label"${attrs}>${esc(o.label)}${up ? `<span class="cat-opt__in">${esc(conceptPathText(up))}</span>` : ''}</span><span class="cat-opt__n">${fmtNum(o.count)}</span>`;
  }
  const optBox = (f, o) => `<div class="${cx('cat-opt', !o.count && 'is-zero')}">${checkbox({ id: `cf-${f.id}-${domId(o.value)}`, checked: o.on, act: 'cat-facet', data: { f: f.id, v: o.value }, label: optLabel(f, o) })}</div>`;
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
  /** The bar right above the results: search and filters on the left; saved views, sort and layout on the right. */
  function filterBar(p, r) {
    const more = moreFacets(p, r), nMore = nOn(p, more), nAll = nOn(p, filterFacets());
    const inline = inlineFacets().map(f => facetBtn(f, p)).join('') + (more.length ? popBtn(nMore ? `More filters · ${nMore}` : 'More filters', { f: 'more' }, nMore > 0, 'cat-fb') : '');
    const all = popBtn(nAll ? `Filters · ${nAll}` : 'Filters', { f: 'all' }, nAll > 0, 'cat-fb-all', 'sliders');
    const v = savedView(p), saveable = !!(p.q || activeFilterCount(p));
    const views = v || saveable || myViews().length ? btn('Views', { v: 'ghost', size: 'sm', icon: 'layers', iconRight: 'chevron-down', menu: 'cat-views', cls: cx('cat-views', v && 'is-set'), aria: 'aria-label="Saved views"' }) : '';
    const sort = btn(SORTS_CATALOG[r.sort], { v: 'ghost', size: 'sm', icon: 'sort', iconRight: 'chevron-down', menu: 'cat-sort', cls: 'cat-sort', aria: 'aria-label="Sort: ' + esc(SORTS_CATALOG[r.sort]) + '"' });
    const layout = `<span class="cat-layoutsw">${seg({ value: p.view, options: LAYOUTS, act: 'cat-layout', label: 'Layout', iconOnly: true, size: 'sm' })}</span>`;
    return `<div class="cat-bar" role="group" aria-label="Search, filter and sort">${searchBar(p)}<div class="cat-bar__filters">${inline}</div>${all}<div class="cat-bar__end">${views}${sort}${layout}</div></div>`;
  }

  /* ═══════════════ Search and the first scheme's pills ═══════════════ */
  /** One compact field at the start of the filter bar — search is one more way to narrow the same results. Typing searches documents
      (live); Ask AI sits in the results header. The count lives there too. */
  function searchBar(p) {
    return `<div class="cat-search">${searchField({ act: 'cat-q', value: p.q, id: 'cat-q', placeholder: 'Search titles, concepts and content' })}</div>`;
  }
  /** One pill. With `concept` it leads with the concept's icon in its family's color and, when chosen, takes a soft wash of that
      color (conceptLook, core/catalog.js); All stays neutral. Concept names are content: never translated. */
  const pill = (label, { on, value = '', count, concept = '' } = {}) => {
    const l = concept ? conceptLook(concept) : null, name = concept ? `<span translate="no">${esc(label)}</span>` : esc(label);
    return `<button type="button" class="${cx('cat-pill', l && 'cat-pill--concept', on && 'is-on')}"${l?.style || ''} data-act="cat-pill" data-v="${esc(value)}" aria-pressed="${!!on}">${l ? `<span class="cat-pill__ic">${ic(l.icon)}</span>` : ''}${name}${count != null ? `<span class="cat-pill__n">${fmtNum(count)}</span>` : ''}</button>`;
  };
  const facetCounts = (r, id) => new Map((r.facets[id] || []).map(o => [o.value, o.count]));
  /** The first scheme's top concepts that hold results, in the scheme's order — and the chosen one's, even when it holds none now. */
  function pillTops(p, counts) {
    const s = firstScheme(), sel = pillConcept(p), selTop = sel && conceptTop(sel);
    return s ? topConcepts(s.id).filter(c => counts.get(c.id) || c.id === selTop) : [];
  }
  /** The pills: the first scheme's top concepts with their counts in one row (the first few, the rest under More); a chosen one
      reveals its narrower concepts. Counts roll up: a document filed under a narrower concept counts under its top once. */
  function conceptBar(p, r) {
    const s = firstScheme(); if (!s) return '';
    const counts = facetCounts(r, s.id), tops = pillTops(p, counts);
    if (!tops.length) return '';
    const sel = pillConcept(p), selTop = sel && conceptTop(sel);
    const shown = tops.slice(0, PILLS), rest = tops.slice(PILLS);
    if (selTop && rest.some(c => c.id === selTop)) shown.push(rest.splice(rest.findIndex(c => c.id === selTop), 1)[0]);
    const more = rest.length ? `<button type="button" class="cat-pill cat-pill--more" data-menu="cat-pills" aria-haspopup="menu">More${ic('chevron-down', 'i-xs')}</button>` : '';
    const top = `<div class="cat-pills" role="group" aria-label="${esc(s.name)}">${pill('All', { on: !sel })}${shown.map(c => pill(conceptName(c.id), { on: c.id === selTop, value: c.id, count: counts.get(c.id) || 0, concept: c.id })).join('')}${more}</div>`;
    const kids = selTop ? narrowerOf(selTop).filter(c => counts.get(c.id)) : [], lineage = sel ? conceptLineage(sel) : [];
    const sub = kids.length > 1 ? `<div class="cat-pills cat-pills--sub" role="group" aria-label="${esc(`In ${conceptName(selTop)}`)}">${pill(`All ${conceptName(selTop)}`, { on: sel === selTop, value: selTop })}${kids.map(c => pill(conceptName(c.id), { on: lineage.includes(c.id), value: c.id, count: counts.get(c.id), concept: c.id })).join('')}</div>` : '';
    return top + sub;
  }
  MENUS['cat-pills'] = () => {
    const p = cur(), s = firstScheme(), counts = facetCounts(search(p), s?.id), rest = pillTops(p, counts).slice(PILLS);
    return [{ section: s?.name || '' }, ...rest.map(c => ({ label: conceptName(c.id), meta: fmtNum(counts.get(c.id) || 0), run: () => A['cat-pill']({ dataset: { v: c.id } }) }))];
  };

  /* ═══════════════ Reading the query: the concepts it names (conversation_loop.md "Knowledge retrieval") ═══════════════ */
  const listParam = v => String(v || '').split(',').filter(Boolean);
  /** What the query names, with the reader's choices (query.ignore: concept ids set aside; query.pick: the meanings chosen — their
      schemes — or `all`, every result in one list without choosing): { chips: [{ key, scheme, ids, picked }] (one per term and
      scheme: an expansion group is one chip), ids (every concept that boosts), amb (the first term still open, with its options),
      grouped (results split by its options) }. */
  function understand(p, query = {}) {
    const out = { chips: [], ids: [], amb: null, grouped: false };
    if (!p.q) return out;
    const qi = interpretQuery(p.q), ignore = listParam(query.ignore), pick = listParam(query.pick);
    qi.concepts.filter(c => !ignore.includes(c.id)).forEach(c => {
      const scheme = conceptById(c.id)?.scheme, key = `${c.text}|${scheme}`;
      let chip = out.chips.find(x => x.key === key);
      if (!chip) out.chips.push(chip = { key, scheme, ids: [], picked: false });
      chip.ids.push(c.id);
    });
    qi.ambiguities.forEach(a => {
      const o = a.options.find(x => pick.includes(x.scheme));
      if (o) out.chips.push({ key: `${a.text}|${o.scheme}`, scheme: o.scheme, ids: o.concepts, picked: true });
      else out.amb ??= a;
    });
    out.ids = [...new Set(out.chips.flatMap(c => c.ids))];
    out.grouped = !!out.amb && !pick.includes('all');
    return out;
  }
  /** Run a query: the words, plus — when it names concepts — every document filed under them, those first under Best match whether
      or not the words match (a boost, not a filter). Filters, facet counts and the other sorts work as in catalogSearch. An open
      ambiguity boosts every meaning and, while grouped, adds `groups` (groupsOf). */
  function run(p, qi, pool = sharedPool()) {
    const sets = qi.amb ? qi.amb.options.map(o => [...qi.ids, ...o.concepts]) : qi.ids.length ? [qi.ids] : [];
    if (!sets.length) return catalogSearch(p, pool);
    const toks = tokens(p.q), text = new Map();
    pool.forEach(d => { const s = scoreRes(d, toks); if (s > 0) text.set(d.id, s); });
    const hit = new Set(pool.filter(d => sets.some(ids => matchesConcepts(d, ids))).map(d => d.id));
    const r = catalogSearch({ ...p, q: '' }, pool.filter(d => text.has(d.id) || hit.has(d.id)));
    r.rows.forEach(x => { x.score = (hit.has(x.doc.id) ? BOOST : 0) + (text.get(x.doc.id) || 0); });
    r.sort = p.sort || 'relevance';
    if (r.sort === 'relevance') r.rows.sort((a, b) => b.score - a.score || b.doc.updated - a.doc.updated);
    if (qi.grouped) r.groups = groupsOf(r.rows.map(x => x.doc), qi);
    return r;
  }
  /** One group per meaning, in the options' order, each leaving out what an earlier meaning already holds (the second “khóa luận”
      group: thesis work that isn't itself a thesis); then what only matches the words (option null). Empty groups are left out. */
  function groupsOf(docs, qi) {
    const opts = qi.amb.options, taken = new Set();
    const groups = opts.map((o, i) => {
      const own = docs.filter(d => matchesConcepts(d, [...qi.ids, ...o.concepts]) && !opts.slice(0, i).some(e => matchesConcepts(d, e.concepts)));
      own.forEach(d => taken.add(d.id));
      return { option: o, docs: own };
    }).filter(g => g.docs.length);
    const rest = docs.filter(d => !taken.has(d.id));
    return rest.length ? [...groups, { option: null, docs: rest }] : groups;
  }
  /** What the search understood, right above the results: each concept a removable chip (× searches without it); a term with
      several meanings offers one chip per meaning — picking one turns it into a chip. */
  function interpLine(qi) {
    const chips = qi.chips.map(c => {
      const s = schemeName(c.scheme), names = c.ids.map(conceptName).join(', ');
      return `<button type="button" class="cat-chip cat-chip--concept"${conceptLook(c.ids[0]).style} data-act="cat-qx" ${dataAttrs(c.picked ? { pick: c.scheme } : { ids: c.ids.join(',') })} aria-label="${esc(`Search without ${s}: ${names}`)}"><span class="cat-chip__k" translate="no">${esc(s)}:</span><span class="truncate" translate="no">${esc(names)}</span>${ic('x', 'i-xs')}</button>`;
    });
    const opts = qi.amb ? qi.amb.options.map(o => { const l = conceptLook(o.concepts[0]); return `<button type="button" class="cat-qopt"${l.style} data-act="cat-pick" data-v="${esc(o.scheme)}">${ic(l.icon, 'i-xs')}<span class="truncate" translate="no">${esc(o.label)}</span></button>`; }).join('') : '';
    if (!chips.length && !opts) return '';
    return `<div class="cat-interp" role="group" aria-label="How your search was understood">${chips.length ? `<div class="cat-interp__row"><span class="cat-interp__k">Understood as</span>${chips.join('')}</div>` : ''}${opts ? `<div class="cat-interp__row"><span class="cat-interp__k">${esc(`“${qi.amb.text}” can mean:`)}</span>${opts}</div>` : ''}</div>`;
  }
  /** The same reading, compact and read-only (/search's Documents group): the concepts as tags. */
  const understood = qi => (qi.ids.length ? `<p class="cat-interp cat-interp--compact"><span class="cat-interp__k">Understood as</span>${qi.ids.map(id => conceptTag(id)).join('')}</p>` : '');
  X.cat = { understand, run, understood };

  /* ═══════════════ Results ═══════════════ */
  /** The first-scheme concept a document's card would show first. */
  const firstConcept = d => { const s = firstScheme()?.id; return res(d).concepts.find(id => conceptById(id)?.scheme === s) || ''; };
  /** Context every result on the page shares (one base, one concept of the first scheme) — said once by the filters, not on every card. */
  function sharedContext(page) {
    const one = f => page.length > 1 && new Set(page.map(f)).size === 1;
    return [one(d => d.kb) && 'kb', one(firstConcept) && 'concept'].filter(Boolean);
  }
  /** The result count with the choices that produced it: each filter a removable chip (the pill's concept excepted — it shows itself),
      Clear all (which clears the pill too), and Ask AI about the set — the query's words, or the filtered documents. On a saved view
      the heading is the view's name, click-to-edit (Enter or leaving the field renames it, Escape cancels). */
  function resultsHead(p, r) {
    const pc = pillConcept(p), first = firstScheme()?.id, v = savedView(p), u = cui();
    const chips = facetsOn().flatMap(f => (p.filters[f.id] || []).filter(v => !(f.id === first && v === pc)).map(v => `<button type="button" class="cat-chip" data-act="cat-unfilter" data-f="${f.id}" data-v="${esc(v)}" aria-label="Remove filter ${esc(f.label)}: ${esc(f.name(v))}"><span class="cat-chip__k">${esc(f.label)}</span><span class="truncate"${f.scheme ? ' translate="no"' : ''}>${esc(f.name(v))}</span>${ic('x', 'i-xs')}</button>`));
    const clear = chips.length ? linkBtn('Clear all', { act: 'cat-clear' }) : '';
    // Search narrows the set; Ask AI turns it into a cited answer — two clearly named actions, never mixed in one control.
    const ask = (p.q || activeFilterCount(p)) && r.total ? btn(p.q ? 'Ask AI' : 'Ask about these', { v: 'ghost', size: 'sm', icon: 'sparkles', act: 'cat-ask', tip: p.q ? 'Get an answer with sources from these documents' : 'Get an overview with sources from these documents' }) : '';
    const renaming = v && u.renaming === v.id;
    const title = v ? editableTitle({ id: 'cat-view-name', tag: 'h2', cls: 'cat-head__title', value: renaming ? u.renameVal : v.name, editing: renaming, edit: 'cat-view-rename', commit: 'cat-view-rename-done', cancel: 'cat-view-rename-cancel', label: 'Rename view', maxlength: 60, data: { id: v.id } })
      : `<h2 class="cat-head__title">${isLanding(p) ? 'All documents' : p.q ? 'Results' : 'Documents'}</h2>`;
    // The title already says "documents": the count is just the number (read out in full).
    return `<div class="cat-head">${title}<span class="cat-count" role="status"><span aria-hidden="true">${fmtNum(r.total)}</span><span class="sr-only">${plural(r.total, 'document')}</span></span>${chips.length ? `<div class="cat-chips">${chips.join('')}${clear}</div>` : ''}<span class="grow"></span>${ask}</div>`;
  }
  function results(p, r) {
    if (r.groups?.some(g => g.option)) return `<div class="cat-results cat-qgroups">${groupedResults(p, r.groups)}</div>`;
    const page = paginate(r.rows, 'cat', PER).map(x => x.doc), data = p.q ? { q: p.q } : undefined;
    if (p.view === 'list') return `<div class="cat-results">${X.res.rows(page, () => ({ q: p.q, act: 'cat-select', data }))}</div>${r.total > PER ? pager(r.total, 'cat', PER) : ''}`;
    return `<div class="cat-results">${cardGrid(page, p, data)}</div>${r.total > PER ? pager(r.total, 'cat', PER) : ''}`;
  }
  /** Cards draw from the list's own data (each document's cover): no content read per card. */
  const cardGrid = (docs, p, data) => { const hide = sharedContext(docs); return `<div class="cat-cards">${docs.map(d => X.res.card(d, { act: 'cat-select', data, q: p.q, hide })).join('')}</div>`; };
  /** A term with several meanings, none picked: one section per meaning (its label, its count, its first documents; See all picks
      it), then Other matches (See all lists every result without choosing). Replaces the paged grid only while grouped. */
  function groupedResults(p, groups) {
    const data = { q: p.q };
    return groups.map(g => {
      const label = g.option ? g.option.label : 'Other matches', top = g.docs.slice(0, GROUP_TOP);
      const all = g.docs.length > GROUP_TOP ? linkBtn(`See all ${fmtNum(g.docs.length)}`, { act: 'cat-pick', data: { v: g.option?.scheme || 'all' }, icon: 'arrow-right' }) : '';
      const body = p.view === 'list' ? X.res.rows(top, () => ({ q: p.q, act: 'cat-select', data })) : cardGrid(top, p, data);
      return `<section class="cat-qgroup" aria-label="${esc(label)}"><div class="cat-qgroup__head"><h3 class="cat-qgroup__title"${g.option ? ' translate="no"' : ''}>${esc(label)}</h3><span class="cat-count">${fmtNum(g.docs.length)}</span><span class="grow"></span>${all}</div>${body}</section>`;
    }).join('');
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
  const lockedNote = p => (visibleKbs().some(k => kbRole(k) === 'none') && !(p.filters.kb || []).some(id => kbRole(kbById(id)) === 'none') ? `<button type="button" class="cat-locked" data-act="kb-locked">${ic('lock', 'i-sm')}<span>Some collections aren’t shared with you</span>${ic('arrow-right', 'i-sm')}</button>` : '');

  function loadingBody() {
    const pills = `<div class="cat-pills" aria-hidden="true">${[44, 64, 72, 58, 66].map(w => `<span class="skeleton cat-skel-pill" style="width:${w}px"></span>`).join('')}</div>`;
    const cardSk = `<div class="doc-card" aria-hidden="true"><span class="skeleton cat-skel-media"></span><div class="doc-card__body"><span class="skeleton skeleton--line" style="width:70%"></span><span class="skeleton skeleton--line" style="width:95%;height:10px"></span><span class="skeleton skeleton--line" style="width:40%;height:10px"></span></div></div>`;
    return `<div class="cat-top" aria-busy="true" aria-label="Loading">${pills}</div><div class="cat-bar" aria-hidden="true"><span class="skeleton cat-skel-search"></span></div><div class="cat-cards">${cardSk.repeat(6)}</div>`;
  }

  P.catalog = ({ query }) => {
    const p = parseCatalogQuery(query), u = cui();
    const head = X.res.hubHeader('browse', { actions: iconBtn('network', 'Knowledge map', { href: '/knowledge/map', size: 'sm' }) + X.res.uploadBtn() });
    const body = gate({
      loading: loadingBody,
      empty: emptyKnowledge,
      error: () => errorState(),
      ok: () => {
        if (!sharedPool().length) return emptyKnowledge();
        const qi = understand(p, query), r = run(p, qi), key = setKey(p);
        if (u.lastKey !== key) { u.page = 1; u.lastKey = key; }
        const pills = conceptBar(p, r);
        return `${pills ? `<div class="cat-top">${pills}</div>` : ''}
          <section class="cat-main" aria-label="Documents">${filterBar(p, r)}${interpLine(qi)}${resultsHead(p, r)}${r.total ? results(p, r) : noMatches(p)}</section>${lockedNote(p)}`;
      },
    });
    return `<div class="page page--wide cat">${head}${body}</div>`;
  };

  /* ═══════════════ Actions ═══════════════ */
  /** New words, a new reading: the chips set aside and the meanings picked belong to the old query. */
  A['cat-q'] = el => { cui().page = 1; setQuery({ q: el.value, ignore: '', pick: '' }); };
  A['cat-q-clear'] = () => { cui().page = 1; setQuery({ q: '', ignore: '', pick: '' }); $('#cat-q')?.focus(); };
  /** A pill: one concept of the first scheme at a time; All clears it. */
  A['cat-pill'] = el => { const p = cur(), s = firstScheme(), v = el.dataset.v || ''; if (!s) return; p.filters[s.id] = v ? [v] : []; apply(p); };
  /** × on an understood concept: search without it (ignore=); on a picked meaning: back to the choice (pick=). */
  A['cat-qx'] = el => {
    const q = S.cur.query; cui().page = 1;
    if (el.dataset.pick) setQuery({ pick: listParam(q.pick).filter(x => x !== el.dataset.pick).join(',') });
    else setQuery({ ignore: [...new Set([...listParam(q.ignore), ...listParam(el.dataset.ids)])].join(',') });
  };
  /** A meaning chip or a group's See all: that meaning becomes an understood concept; `all` lists every result without choosing. */
  A['cat-pick'] = el => { const v = el.dataset.v || ''; if (!v) return; cui().page = 1; setQuery({ pick: [...listParam(S.cur.query.pick).filter(x => x !== 'all' && x !== v), v].join(',') }); };
  /** A tick in a filter popover: results update right away; the popover stays open (it re-renders with the new counts). */
  A['cat-facet'] = el => {
    const p = cur(), f = facetById(el.dataset.f), v = el.dataset.v || ''; if (!f) return;
    const now = p.filters[f.id] || [];
    p.filters[f.id] = f.single ? (!v || now.includes(v) ? [] : [v]) : now.includes(v) ? now.filter(x => x !== v) : [...now, v];
    apply(p);
  };
  A['cat-unfilter'] = el => { const p = cur(), f = el.dataset.f; p.filters[f] = (p.filters[f] || []).filter(x => x !== el.dataset.v); apply(p); };
  A['cat-clear-facets'] = el => { const p = cur(); (el.dataset.f || '').split(',').forEach(f => { p.filters[f] = []; }); apply(p); };
  /** Clear all: every filter, the pill included — the result count goes back to everything (the search words stay; they have their own ×). */
  A['cat-clear'] = () => { const p = cur(); p.filters = {}; apply(p); };
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

  /* ── Saved views: the Views dropdown next to the filters — open one, save this set, delete the one you're on. The view's name is the
     results heading (click-to-edit), so saving names it right there: no dialog. ── */
  const viewById = id => myViews().find(v => v.id === id);
  MENUS['cat-views'] = () => {
    const p = cur(), views = myViews(), on = savedView(p), saveable = !!(p.q || activeFilterCount(p));
    return [
      views.length && { section: 'Saved views' },
      ...views.map(v => ({ label: v.name, checked: v === on, run: () => apply(parseQs(v.query)) })),
      views.length && (saveable && !on || on) && { sep: true },
      saveable && !on && { label: 'Save this view', icon: 'plus', run: () => A['cat-save-view']() },
      on && { label: 'Delete view', icon: 'trash', danger: true, run: () => {
        const l = myViews(), i = l.indexOf(on); l.splice(i, 1); persist(); refresh();
        toast(`Deleted “${on.name}”`, { action: { label: 'Undo', run: () => { myViews().splice(i, 0, on); persist(); refresh(); } } });
      } },
    ].filter(Boolean);
  };
  /** Save this view: saved at once under a name made from the search and filters, with that name open for editing in the heading. */
  A['cat-save-view'] = () => {
    const p = cur(), labels = filterLabels(p).join(' · ');
    const name = (p.q && labels ? `${p.q} · ${labels}` : labels || p.q || 'My view').slice(0, 60);
    const v = { id: uid('vw'), name, query: qsOf(p), created: Date.now() };
    myViews().unshift(v); Object.assign(cui(), { renaming: v.id, renameVal: name }); persist(); refresh();
    // The menu hands focus back to Views as it closes: put it in the name once that's done.
    requestAnimationFrame(() => { const i = $('#cat-view-name'); i?.focus(); i?.select(); });
    toast(`Saved view “${name}”`, { action: { label: 'Undo', run: () => { const l = myViews(), i = l.indexOf(v); if (i >= 0) l.splice(i, 1); cui().renaming = ''; persist(); refresh(); } } });
  };
  A['cat-view-rename'] = el => { const v = viewById(el.dataset.id); if (!v) return; Object.assign(cui(), { renaming: v.id, renameVal: v.name }); refresh(); };
  A['cat-view-rename-cancel'] = () => { if (!cui().renaming) return; cui().renaming = ''; refresh(); };
  /** Enter or leaving the field. Idempotent; an empty or unchanged name just closes it. */
  A['cat-view-rename-done'] = el => {
    const u = cui(), v = viewById(el.dataset.id); if (!v || u.renaming !== v.id) return;
    const name = el.value.trim(); u.renaming = '';
    if (!name || name === v.name) { refresh(); return; }
    const prev = v.name; v.name = name; persist(); refresh();
    toast(`Renamed to “${name}”`, { action: { label: 'Undo', run: () => { v.name = prev; persist(); refresh(); } } });
  };
})();

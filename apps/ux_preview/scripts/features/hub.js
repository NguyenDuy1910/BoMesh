/* Knowledge: Browse (/knowledge) — content-first discovery. One search field,
   topic shortcuts, and a grid of documents you can recognise and judge
   without opening them. Advanced filters live in a drawer and show up as
   removable chips; a document opens in a quick preview (drawer), then the
   Reader. The URL holds the result set (q, filters, sort, view), so every
   set is linkable and can be saved as a view. Model: core/catalog.js.
   Pieces: X.res (resources.js). Actions: cat-*. Drawers: cat-filters,
   cat-peek. Modal: cat-save-view. Menus: cat-sort, cat-topics. */
(() => {
  'use strict';

  const PER = 24, FACET_TOP = 6, TOPIC_PILLS = 6;
  /** Facet groups open on first visit in the Filters drawer; the rest open when they hold a selection or the user opens them. */
  const OPEN_BY_DEFAULT = ['topic', 'kind', 'trust'];
  const LAYOUTS = [['grid', 'Grid', 'grid'], ['list', 'List', 'list']];
  /** Below this width the quick preview adds a step without adding room: cards open the Reader directly. */
  const canPeek = () => ($('#frame')?.clientWidth || innerWidth) >= 760;
  const openDoc = (id, q = '') => go('/doc/' + id + (q ? '?q=' + encodeURIComponent(q) : ''));
  const bare = n => String(n || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());

  /** Empty Browse (nothing readable yet, or the forced Empty state). */
  function emptyKnowledge() {
    const up = X.res.uploadBtn('primary');
    return emptyState({
      icon: 'book', title: 'No knowledge yet', boxed: true,
      desc: up ? 'Contribute files or connect a source to start the catalog.' : 'Nothing has been shared with you yet.',
      actions: up + btn('Knowledge bases', { href: '/knowledge/bases' }),
    });
  }

  /* ═══════════════ State ═══════════════ */
  const cui = () => ui('cat', { fold: {}, more: {}, open: {}, page: 1 });
  const cur = () => parseCatalogQuery(S.cur.query);
  /** Canonical query string for params (what a saved view stores). */
  const qsOf = p => new URLSearchParams(Object.entries(catalogQueryOf(p)).filter(([, v]) => v)).toString();
  const parseQs = s => parseCatalogQuery(Object.fromEntries(new URLSearchParams(s || '')));
  /** Identity of a result set, ignoring the layout. */
  const setKey = p => qsOf({ ...p, view: 'grid' });
  const apply = p => { cui().page = 1; setQuery(catalogQueryOf(p)); };
  const facetById = id => facetsOn().find(f => f.id === id);
  const filterLabels = p => facetsOn().flatMap(f => (p.filters[f.id] || []).map(v => f.name(v)));
  const describe = p => [p.q && `“${p.q}”`, ...filterLabels(p), p.saved && 'Saved'].filter(Boolean).join(' · ');
  const domId = s => String(s).replace(/[^\w-]/g, '_');
  /** The one topic the shortcuts represent: a single selected domain or topic. Anything else is shown as chips. */
  const pillTopic = p => ((p.filters.topic || []).length === 1 ? p.filters.topic[0] : '');
  /** Filters beyond the topic shortcut — what the Filters button counts and the chips show. */
  const extraFilters = p => activeFilterCount(p) - (pillTopic(p) ? 1 : 0);
  const isLanding = p => !p.q && !activeFilterCount(p);

  /* ═══════════════ Filters drawer (progressive: only when asked for) ═══════════════ */
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
  /** Topic facet as a tree: domain → topics. Domains open when they (or a topic) are selected. */
  function topicOpts(f, opts) {
    const by = new Map(opts.map(o => [o.value, o])), u = cui();
    return topicTree().map(dm => {
      const kids = dm.children.map(t => by.get(t.id)).filter(Boolean);
      const d = by.get(dm.id) || (kids.length ? { value: dm.id, label: dm.name, count: 0, on: false } : null);
      if (!d) return '';
      const open = u.open[dm.id] ?? (d.on || kids.some(k => k.on));
      const twist = kids.length ? `<button type="button" class="cat-twist" data-act="cat-twist" data-id="${dm.id}" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} topics in ${esc(dm.name)}">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}</button>` : '<span class="cat-twist" aria-hidden="true"></span>';
      return `<div class="cat-tree"><div class="cat-tree__row">${twist}${optBox(f, d)}</div>${open && kids.length ? `<div class="cat-tree__kids">${kids.map(k => optBox(f, k)).join('')}</div>` : ''}</div>`;
    }).join('');
  }
  function filterPanel(p, r) {
    const u = cui(), views = myViews(), key = setKey(p), nSaved = savedResources().length;
    const viewList = views.length
      ? `<div class="cat-views">${views.map(v => { const on = setKey(parseQs(v.query)) === key; return `<button type="button" class="${cx('cat-view', on && 'is-on')}" data-act="cat-apply-view" data-id="${esc(v.id)}" ${on ? 'aria-current="true"' : ''}>${ic('filter', 'i-sm')}<span class="truncate">${esc(v.name)}</span></button>`; }).join('')}</div>`
      : '<p class="cat-none">Save a search or a set of filters to come back to it.</p>';
    const savedOnly = `<div class="cat-opt cat-opt--saved">${checkbox({ id: 'cf-saved', checked: !!p.saved, act: 'cat-saved', label: `<span class="cat-opt__label">Only documents I saved</span><span class="cat-opt__n">${fmtNum(nSaved)}</span>` })}</div>`;
    const head = `<section class="cat-group"><div class="cat-group__head"><h3 class="cat-group__title">Saved views</h3>${views.length ? linkBtn('Manage', { href: '/knowledge/library?tab=views' }) : ''}</div>${viewList}${savedOnly}</section>`;
    const groups = facetsOn().map(f => {
      const opts = r.facets[f.id] || [], nOn = (p.filters[f.id] || []).length;
      if (!opts.length && f.id !== 'upd') return '';
      const open = u.fold[f.id] ?? (OPEN_BY_DEFAULT.includes(f.id) || nOn > 0);
      const body = f.id === 'topic' ? topicOpts(f, opts) : f.single ? radioOpts(f, opts) : checkOpts(f, opts);
      return `<section class="cat-group"><button type="button" class="cat-group__toggle" id="cf-fold-${f.id}" data-act="cat-fold" data-f="${f.id}" aria-expanded="${open}"><span class="cat-group__title">${esc(f.label)}</span>${nOn ? `<span class="badge badge--accent">${nOn}</span>` : ''}<span class="grow"></span>${ic(open ? 'chevron-up' : 'chevron-down', 'i-sm')}</button>${open ? `<div class="cat-opts">${body}</div>` : ''}</section>`;
    }).join('');
    return `<div class="cat-rail">${head}${groups}</div>`;
  }
  DR['cat-filters'] = () => {
    const p = cur(), r = catalogSearch(p), n = activeFilterCount(p);
    return {
      title: 'Filters', desc: n ? plural(n, 'filter') + ' applied' : 'Narrow the documents by any detail',
      body: filterPanel(p, r),
      footStart: n ? btn('Clear all', { v: 'ghost', act: 'cat-clear' }) : '',
      foot: btn(`Show ${plural(r.total, 'document')}`, { v: 'primary', act: 'close-drawer' }),
    };
  };

  /* ═══════════════ Search, topic shortcuts, chips ═══════════════ */
  /** One field. Typing searches documents (live); Ask AI turns the same words into a cited answer — two clearly named actions, never mixed. */
  function searchBar(p, r) {
    const ask = p.q ? `<span class="cat-search__ask">${btn('Ask AI', { v: 'secondary', size: 'sm', icon: 'sparkles', act: 'cat-ask', tip: 'Get an answer with sources from these documents' })}</span>` : '';
    const clear = p.q ? `<span class="search-field__clear">${iconBtn('x', 'Clear search', { size: 'sm', act: 'cat-q-clear' })}</span>` : '';
    return `<div class="search-field cat-search">${ic('search')}<input class="input" id="cat-q" type="search" value="${esc(p.q)}" placeholder="Search ${fmtNum(r.pool.length)} documents" aria-label="Search documents" data-input="cat-q" autocomplete="off">${clear}${ask}</div>`;
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
    const p = cur(), r = catalogSearch(p), counts = new Map((r.facets.topic || []).map(o => [o.value, o.count]));
    return [{ section: 'More topics' }, ...topicTree().filter(dm => counts.get(dm.id)).slice(TOPIC_PILLS).map(dm => ({ label: dm.name, meta: fmtNum(counts.get(dm.id)), run: () => A['cat-topic']({ dataset: { v: dm.id } }) }))];
  };
  /** Active filters beyond the topic shortcut, each removable; Save view sits with them because it saves exactly this. */
  function chipsRow(p) {
    const pt = pillTopic(p);
    const chips = facetsOn().flatMap(f => (p.filters[f.id] || []).filter(v => !(f.id === 'topic' && v === pt)).map(v => `<button type="button" class="cat-chip" data-act="cat-unfilter" data-f="${f.id}" data-v="${esc(v)}" aria-label="Remove filter ${esc(f.label)}: ${esc(f.name(v))}"><span class="cat-chip__k">${esc(f.label)}</span><span class="truncate">${esc(f.name(v))}</span>${ic('x', 'i-xs')}</button>`));
    if (p.saved) chips.unshift(`<button type="button" class="cat-chip" data-act="cat-unfilter" data-f="saved" aria-label="Remove filter Saved">${ic('bookmark-filled', 'i-xs')}<span>Saved by me</span>${ic('x', 'i-xs')}</button>`);
    const exists = myViews().some(v => setKey(parseQs(v.query)) === setKey(p));
    const save = p.q || activeFilterCount(p) ? (exists ? `<span class="cat-saved-view">${ic('check', 'i-xs')}View saved</span>` : linkBtn('Save view', { act: 'cat-save-view', icon: 'bookmark' })) : '';
    if (!chips.length && !save) return '';
    return `<div class="cat-chips">${chips.join('')}${chips.length ? linkBtn('Clear all', { act: 'cat-clear' }) : ''}<span class="grow"></span>${save}</div>`;
  }

  /* ═══════════════ Results ═══════════════ */
  /** Context every result on the page shares (one base, one topic) — said once by the filters, not on every card. */
  function sharedContext(page) {
    const one = f => page.length > 1 && new Set(page.map(f)).size === 1;
    return [one(d => d.kb) && 'kb', one(d => res(d).topics[0] || '') && 'topic'].filter(Boolean);
  }
  function resultsHead(p, r) {
    const n = extraFilters(p);
    const filters = btn(n ? `Filters · ${n}` : 'Filters', { v: n ? 'secondary' : 'ghost', size: 'sm', icon: 'sliders', act: 'cat-filters', cls: n ? 'is-set' : '' });
    // Ask AI lives in the search field while there is a query; without one it can still summarise a filtered set.
    const ask = !p.q && activeFilterCount(p) && r.total ? btn('Ask about these', { v: 'ghost', size: 'sm', icon: 'sparkles', act: 'cat-ask', tip: 'Get an overview with sources from these documents' }) : '';
    const sort = btn(SORTS_CATALOG[r.sort], { v: 'ghost', size: 'sm', icon: 'sort', iconRight: 'chevron-down', menu: 'cat-sort', aria: 'aria-label="Sort: ' + esc(SORTS_CATALOG[r.sort]) + '"' });
    const layout = `<div class="toggle-group cat-layoutsw" role="group" aria-label="Layout">${LAYOUTS.map(([id, l, icon]) => `<button type="button" aria-pressed="${id === p.view}" data-act="cat-layout" data-value="${id}" aria-label="${l}" data-tip="${l}">${ic(icon, 'i-sm')}</button>`).join('')}</div>`;
    const title = isLanding(p) ? 'All documents' : p.q ? 'Results' : 'Documents';
    return `<div class="cat-head"><h2 class="cat-head__title">${title}</h2><span class="cat-count" role="status">${plural(r.total, 'document')}</span><span class="grow"></span>${ask}${filters}${sort}${layout}</div>`;
  }
  function results(p, r) {
    const page = paginate(r.rows, 'cat', PER).map(x => x.doc), data = p.q ? { q: p.q } : undefined;
    const html = p.view === 'list'
      ? X.res.rows(page, () => ({ q: p.q, act: 'cat-select', data }))
      : `<div class="cat-cards">${page.map(d => X.res.card(d, { act: 'cat-select', data, q: p.q, hide: sharedContext(page) })).join('')}</div>`;
    return `<div class="cat-results">${html}</div>${r.total > PER ? pager(r.total, 'cat', PER) : ''}`;
  }
  /** Landing only: up to three documents you opened recently and haven't finished with. Absent when there is no history. */
  function continueReading(p) {
    if (!isLanding(p) || (cui().page || 1) > 1) return '';
    const recent = recentResources(3).filter(x => isReaderVisible(x.doc));
    if (!recent.length) return '';
    return `<section class="cat-continue" aria-labelledby="cat-continue-h"><h2 class="cat-head__title" id="cat-continue-h">Continue reading</h2><div class="cat-continue__list">${recent.map(({ doc, at }) => `<a class="cat-continue__item" href="#/doc/${esc(doc.id)}">${fileIcon(doc.type, 'sm')}<span class="cat-continue__body"><span class="cat-continue__title truncate">${esc(bare(doc.name))}</span><span class="cat-continue__sub truncate">Opened ${esc(relLow(at))}</span></span>${ic('arrow-right', 'i-sm')}</a>`).join('')}</div></section>`;
  }
  function noMatches(p) {
    const n = activeFilterCount(p);
    return emptyState({
      icon: 'search', title: p.q ? `No documents match “${p.q}”` : 'No documents match these filters',
      desc: p.q ? 'Try other words, or ask the assistant — it can answer from passages a title search misses.' : 'Try fewer filters.',
      actions: (n ? btn('Clear filters', { act: 'cat-clear' }) : '') + (p.q ? btn('Clear search', { act: 'cat-q-clear' }) + btn('Ask AI', { v: 'primary', icon: 'sparkles', act: 'cat-ask' }) : ''),
      boxed: true, compact: true,
    });
  }
  const lockedNote = () => (visibleKbs().some(k => kbRole(k) === 'none') ? `<a class="cat-locked" href="#/knowledge/bases">${ic('lock', 'i-sm')}<span>Some knowledge bases aren’t shared with you</span>${ic('arrow-right', 'i-sm')}</a>` : '');

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
        if (!catalogPool().length) return emptyKnowledge();
        const r = catalogSearch(p), key = setKey(p);
        if (u.lastKey !== key) { u.page = 1; u.lastKey = key; }
        return `<div class="cat-top">${searchBar(p, r)}${topicBar(p, r)}</div>${chipsRow(p)}${continueReading(p)}
          <section class="cat-main" aria-label="Documents">${resultsHead(p, r)}${r.total ? results(p, r) : noMatches(p)}</section>${lockedNote()}`;
      },
    });
    return `<div class="page cat">${head}${body}</div>`;
  };

  /* ═══════════════ Quick preview (drawer) ═══════════════ */
  /** Enough to decide: what it's for, the passage that matched, the real first pages, what's inside and the details — then Open. */
  DR['cat-peek'] = ({ id, q = '' }) => {
    const d = docById(id);
    if (!d || !canOpenRes(d)) return { title: 'Document unavailable', body: emptyState({ icon: 'lock', title: 'You can’t open this document', desc: 'It was removed or isn’t shared with you.', compact: true }) };
    const r = res(d), g = X.res.glance(d), toks = tokens(q), readable = isSearchable(d), about = X.res.blurb(d), hit = q ? X.res.matchPassage(d, q) : null;
    const k = kindMeta(r.kind), t = trustOf(d);
    const href = '#/doc/' + esc(d.id) + (q ? '?q=' + encodeURIComponent(q) : '');
    const pages = g
      ? `<a class="cat-peek__pages" href="${href}" aria-label="Open ${esc(d.name)}"><div class="cat-peek__scale">${g.pages.map(pg => `<div class="${cx('doc-page', pg.cls)}">${pg.html}</div>`).join('')}</div><span class="cat-peek__more">${g.count > g.pages.length ? `${plural(g.count - g.pages.length, 'more page')} in the reader` : 'Open in the reader'}${ic('arrow-right', 'i-xs')}</span></a>`
      : `<div class="cat-peek__none">${ic('file', 'i-lg')}<p>There’s no preview for this file. Open or download it to read it.</p></div>`;
    const inside = g?.sections.length > 1 ? `<section class="cat-peek__sec"><h3 class="cat-peek__label">Inside</h3><ol class="cat-peek__toc">${g.sections.slice(0, 10).map(s => `<li>${markTokens(s.title, toks)}</li>`).join('')}</ol></section>` : '';
    const trust = t.state === 'verified' || t.state === 'review' ? `<p class="cat-peek__trust">${X.res.trustChip(d)}<span>${esc(t.note || t.desc)}</span></p>` : '';
    return {
      size: 'lg',
      lead: fileIcon(d.type),
      title: bare(d.name),
      desc: `<span class="row gap-6 wrap">${ic(k.icon, 'i-xs')}${esc(k.label)}<span class="res-dot" aria-hidden="true">·</span>${X.res.provenance(d)}<span class="res-dot" aria-hidden="true">·</span><span>Updated ${esc(relLow(d.updated))}</span></span>`,
      headActions: X.res.saveBtn(d) + X.res.moreBtn(d),
      body: `<div class="cat-peek">
        ${about ? `<p class="cat-peek__about">${markTokens(about, toks)}</p>` : ''}
        ${hit ? `<div class="cat-peek__hit">${ic('quote', 'i-sm')}<span><span class="cat-peek__loc">${esc(hit.where)}</span>${hit.html}</span></div>` : ''}
        ${trust}
        ${pages}
        ${inside}
        <details class="cat-peek__details"><summary>Details</summary>${X.res.details(d)}</details>
      </div>`,
      footStart: readable ? btn('Ask about this document', { v: 'ghost', icon: 'sparkles', act: 'res-ask', data: { id: d.id, q: q || undefined } }) : '',
      foot: btn('Add to collection', { icon: 'list-plus', act: 'res-collect', data: { id: d.id } }) + btn('Open', { v: 'primary', icon: 'arrow-right', act: 'cat-open', data: { id: d.id, q: q || undefined } }),
    };
  };

  /* ═══════════════ Actions ═══════════════ */
  A['cat-q'] = el => { cui().page = 1; setQuery({ q: el.value }); };
  A['cat-q-clear'] = () => { cui().page = 1; setQuery({ q: '' }); $('#cat-q')?.focus(); };
  /** Topic shortcut: one topic at a time (the drawer allows several); All clears it. */
  A['cat-topic'] = el => { const p = cur(), v = el.dataset.v || ''; p.filters.topic = v ? [v] : []; apply(p); };
  A['cat-facet'] = el => {
    const p = cur(), f = facetById(el.dataset.f), v = el.dataset.v || ''; if (!f) return;
    const now = p.filters[f.id] || [];
    p.filters[f.id] = f.single ? (!v || now.includes(v) ? [] : [v]) : now.includes(v) ? now.filter(x => x !== v) : [...now, v];
    apply(p);
  };
  A['cat-unfilter'] = el => {
    const p = cur(), f = el.dataset.f;
    if (f === 'saved') p.saved = false; else p.filters[f] = (p.filters[f] || []).filter(x => x !== el.dataset.v);
    apply(p);
  };
  /** Clears the advanced filters; the topic shortcut stays, since it is visible and has its own All. */
  A['cat-clear'] = () => { const p = cur(), pt = pillTopic(p); p.filters = pt ? { topic: [pt] } : {}; p.saved = false; apply(p); };
  A['cat-saved'] = () => { const p = cur(); p.saved = !p.saved; apply(p); };
  A['cat-fold'] = el => { cui().fold[el.dataset.f] = el.getAttribute('aria-expanded') !== 'true'; refreshLayer(); };
  A['cat-more'] = el => { const m = cui().more; m[el.dataset.f] = !m[el.dataset.f]; refreshLayer(); };
  A['cat-twist'] = el => { cui().open[el.dataset.id] = el.getAttribute('aria-expanded') !== 'true'; refreshLayer(); };
  A['cat-layout'] = el => setQuery({ view: el.dataset.value === 'grid' ? '' : el.dataset.value });
  A['cat-filters'] = () => openDrawer('cat-filters');
  A['cat-apply-view'] = el => { const v = myViews().find(x => x.id === el.dataset.id); if (!v) return; if (S.drawer) closeDrawer(); apply(parseQs(v.query)); };
  /** Click, Enter or Space: quick preview; a narrow frame or double-click goes straight to the Reader. */
  A['cat-select'] = el => {
    const id = el.dataset.id, q = (S.cur.query.q || '').trim();
    if (!canPeek()) { openDoc(id, q); return; }
    openDrawer('cat-peek', { id, q });
  };
  A['cat-open'] = el => { if (S.drawer) { S.drawer = null; renderLayer(); } openDoc(el.dataset.id, el.dataset.q || ''); };
  MENUS['cat-sort'] = () => {
    const p = cur(), hasQ = tokens(p.q).length > 0, def = hasQ ? 'relevance' : 'updated', active = p.sort || def;
    return [{ section: 'Sort by' }, ...Object.entries(SORTS_CATALOG).filter(([k]) => k !== 'relevance' || hasQ)
      .map(([k, label]) => ({ label, checked: k === active, run: () => { cui().page = 1; setQuery({ sort: k === def ? '' : k }); } }))];
  };
  /** Ask AI: the query (or the filtered set) becomes a cited conversation grounded in these documents. */
  A['cat-ask'] = () => {
    const p = cur(), r = catalogSearch(p), docs = r.rows.map(x => x.doc).filter(isSearchable).slice(0, 8), labels = filterLabels(p);
    const q = p.q
      ? (/\?\s*$/.test(p.q) ? p.q : `What do these documents say about “${p.q}”?`) + (labels.length ? ` (${labels.join(', ')})` : '')
      : `Give me an overview of these documents${labels.length ? ` (${labels.join(', ')})` : ''}: the main points, how they differ and what is most current.`;
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

  /* ── Double-click opens the Reader ── */
  document.addEventListener('dblclick', e => {
    const el = e.target.closest?.('.cat [data-act="cat-select"]');
    if (el && !e.target.closest('button,a,input,label')) { if (S.drawer) { S.drawer = null; renderLayer(); } openDoc(el.dataset.id, (S.cur.query.q || '').trim()); }
  });
})();

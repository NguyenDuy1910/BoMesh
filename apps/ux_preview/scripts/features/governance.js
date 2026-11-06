/* Manage → Documents: Quality and Topics tabs (rendered inside P.documentsAdmin).
   Quality keeps published documents trustworthy: re-verification cycles, missing details
   and possible duplicates. Topics is the workspace taxonomy plus the assistant's proposed
   topics (only workspace admins accept, merge or dismiss them). Scope: published documents
   in the knowledge bases the caller can edit (admins: all).
   Exports: X.gov = { quality({query}), topics({query}), qualityCount(), proposalCount() },
   X.khReview(). Actions: kh-*, gov-*. Menus: kh-review, kh-topic, kh-dup, gov-prop-more.
   Drawer: kh-dup. Models: core/catalog.js, core/lifecycle.js. */
(() => {
  'use strict';

  const SEGS = ['reverify', 'details', 'duplicates'];
  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const kbName = d => kbById(d.kb)?.name || '';
  const ownerOf = d => res(d).owner || 'the knowledge base owner';
  /** Keep a selection bucket in step with rows that still exist (rows are derived and vanish once fixed). */
  function pruneSel(u, valid) { Object.keys(u.sel || {}).forEach(id => { if (!valid.has(id)) delete u.sel[id]; }); }
  const live = () => S.pageState === 'live' && !S.navLoading;

  /* ═══════════════ Signals ═══════════════ */
  /** Published documents the caller looks after: editable, non-personal knowledge bases. */
  const scope = () => readableResources().filter(d => { const kb = kbById(d.kb); return kb && !kb.personal && canEditKb(kb); });
  const REASONS = {
    expired: { label: 'Verification expired', icon: 'clock', rank: 0 },
    never: { label: 'Never verified', icon: 'circle-dashed', rank: 1 },
  };
  /** { d, reason, note, due } when a document needs its owner to re-verify it, else null.
      A document that changed at its source is a publishing state (fix: Publish update in All documents), not a trust check. */
  function reviewItem(d) {
    if (d.status === 'outdated') return null;
    const t = trustOf(d);
    if (t.state === 'review') return { d, reason: 'expired', note: t.note, due: t.due || null };
    if (t.state === 'unverified' && d.status === 'ready' && kbById(d.kb)?.unit) return { d, reason: 'never', note: t.note, due: null };
    return null;
  }
  const reviewItems = (pool = scope()) => pool.map(reviewItem).filter(Boolean)
    .sort((a, b) => REASONS[a.reason].rank - REASONS[b.reason].rank || (a.due || 9e15) - (b.due || 9e15) || a.d.name.localeCompare(b.d.name));

  const GAPS = { topic: { label: 'No topic', icon: 'tag', noun: 'a topic' }, owner: { label: 'No owner', icon: 'user', noun: 'an owner' }, summary: { label: 'No summary', icon: 'note', noun: 'a summary' } };
  const detailItems = (pool = scope()) => pool.map(d => ({ d, gaps: metadataGaps(d) })).filter(x => x.gaps.length);

  /** Published documents per topic and per domain (distinct, over what the caller can read) and submissions in review the assistant tagged with it. */
  function topicCounts() {
    const byTopic = new Map(), byDomain = new Map(), rv = new Map(), rvDomain = new Map();
    const add = (m, id) => m.set(id, (m.get(id) || 0) + 1);
    readableResources().forEach(d => {
      const doms = new Set();
      res(d).topics.forEach(id => { add(byTopic, id); doms.add(topicById(id)?.parent || id); });
      doms.forEach(id => add(byDomain, id));
    });
    reviewQueue().forEach(d => {
      const ids = (aiOf(d).topics || []).map(t => t.id), doms = new Set(ids.map(id => topicById(id)?.parent || id));
      ids.forEach(id => add(rv, id)); doms.forEach(id => add(rvDomain, id));
    });
    return { topic: id => byTopic.get(id) || 0, domain: id => byDomain.get(id) || 0, review: id => rv.get(id) || 0, reviewDomain: id => rvDomain.get(id) || 0 };
  }

  X.khReview = () => (can('knowledge.manage') ? reviewItems() : []);
  /** What has gone stale (verification expired) plus possible duplicates. "Never verified" is backlog, not an alert. */
  const qualityCount = () => (can('knowledge.manage') ? reviewItems().filter(x => x.reason !== 'never').length + duplicateCandidates().length : 0);
  const proposalCount = () => (canManageTaxonomy() ? openProposals().length : 0);

  /* ═══════════════ Quality tab ═══════════════ */
  /** One line under the check switcher: what the check finds and what to do about it (counts live on the switcher). */
  const SEG_HINT = {
    reverify: 'Verification expired or never happened. Verify what’s still right, or ask the owner to check.',
    details: 'Documents without a topic, owner or summary are harder to find. Fill in what’s missing.',
    duplicates: 'Near-identical documents compete in answers. Compare each pair and keep one.',
  };
  function summary(pool, s, rv, dt, dp) {
    if (!pool.length) return 'You don’t look after any published documents yet.';
    if (!rv.length && !dt.length && !dp.length) return esc(`${plural(pool.length, 'published document')} across ${plural(new Set(pool.map(d => d.kb)).size, 'knowledge base')} — all verified, described and unique.`);
    return SEG_HINT[s];
  }
  function quality({ query = {} } = {}) {
    return gate({
      loading: () => skelRows(6),
      error: () => errorState({ title: 'Quality checks didn’t load' }),
      empty: () => emptyState({ icon: 'shield-check', tone: 'success', title: 'Every document is in good shape', desc: 'Nothing is due for re-verification, missing details or duplicated.', boxed: true }),
      ok: () => {
        const pool = scope(), rv = reviewItems(pool), dt = detailItems(pool), dp = duplicateCandidates();
        const counts = { reverify: rv.length, details: dt.length, duplicates: dp.length };
        const want = query.seg === 'review' ? 'reverify' : query.seg;
        const s = SEGS.includes(want) ? want : SEGS.find(k => counts[k]) || 'reverify';
        const control = seg({ value: s, act: 'gov-seg', label: 'Quality checks', options: [['reverify', `Due for re-verification · ${fmtNum(rv.length)}`], ['details', `Missing details · ${fmtNum(dt.length)}`], ['duplicates', `Possible duplicates · ${fmtNum(dp.length)}`]] });
        const body = s === 'reverify' ? tabReview(rv) : s === 'details' ? tabDetails(dt) : tabDups(dp);
        return `<div class="kh gov"><div class="gov-seg">${control}</div><p class="gov-summary">${summary(pool, s, rv, dt, dp)}</p>${body}</div>`;
      },
    });
  }
  A['gov-seg'] = el => { const v = el.dataset.value; ['khReview', 'khDetails'].forEach(k => { if (S.ui[k]) { S.ui[k].page = 1; S.ui[k].sel = {}; } }); if (S.cur?.r.page === 'documentsAdmin') setQuery({ tab: 'quality', seg: v }); else go(`/documents?tab=quality&seg=${v}`); };

  /* ── Due for re-verification ── */
  function tabReview(all) {
    const u = ui('khReview', { kb: '', reason: '', sel: {} });
    if (!all.length) return emptyState({ icon: 'shield-check', tone: 'success', title: 'Nothing is due for re-verification', desc: 'Every document you look after is verified and current.', boxed: true });
    pruneSel(u, new Set(all.map(x => x.d.id)));
    const kbOpts = [...new Map(all.map(x => [x.d.kb, kbName(x.d)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const reasonOpts = Object.entries(REASONS).filter(([k]) => all.some(x => x.reason === k)).map(([k, r]) => [k, r.label]);
    const tools = needsTools(all.length, 'khReview', ['kb', 'reason'])
      ? `${searchField({ uiKey: 'khReview', placeholder: 'Search documents' })}${kbOpts.length > 1 || u.kb ? filterButton('Knowledge base', 'khReview', 'kb', kbOpts) : ''}${reasonOpts.length > 1 || u.reason ? filterButton('Reason', 'khReview', 'reason', reasonOpts) : ''}${clearFilters('khReview', ['kb', 'reason'])}` : '';
    const toolbar = tools ? `<div class="toolbar">${tools}</div>` : '';
    let rows = all.filter(x => (!u.kb || x.d.kb === u.kb) && (!u.reason || x.reason === u.reason) && matchesQ('khReview', x.d.name, res(x.d).owner, kbName(x.d)));
    rows = applySort(rows, 'khReview', { name: x => x.d.name.toLowerCase(), due: x => x.due || 9e15 });
    if (!rows.length) return toolbar + noMatches('khReview', ['kb', 'reason'], 'documents');
    const page = paginate(rows, 'khReview', 20);
    const head = selAllCheck('khReview', page.map(x => x.d.id)) + sortHead('Document', 'name', 'khReview') + th('Reason') + th('Owner') + sortHead('Due', 'due', 'khReview') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    const bulk = bulkBar('khReview', btn('Verify selected', { v: 'ghost', size: 'sm', icon: 'shield-check', act: 'kh-verify-sel' }) + btn('Ask owners', { v: 'ghost', size: 'sm', icon: 'send', act: 'kh-ask-sel' }));
    return toolbar + table({ label: 'Due for re-verification', head, rows: page.map(reviewRow), foot: pager(rows.length, 'khReview', 20) }) + bulk;
  }
  function dueCell(x) {
    if (!x.due) return '<span class="muted">—</span>';
    const late = x.due < Date.now(), days = Math.max(1, Math.round(Math.abs(Date.now() - x.due) / DAY));
    return `<div class="stack"><span class="${late ? 'text-warning medium' : ''} res-nowrap">${esc(fmtDate(x.due))}</span><span class="cell-sub res-nowrap">${late ? `${plural(days, 'day')} overdue` : esc(relFuture(x.due))}</span></div>`;
  }
  function reviewRow(x) {
    const d = x.d, R = REASONS[x.reason];
    const req = d.reviewRequested ? chip('Requested', { size: 'sm', icon: 'send', tip: `Asked ${rel(d.reviewRequested).toLowerCase()}` }) : '';
    // Like every Documents row, the row opens the document drawer; the fix (Verify) sits on the row.
    return `<tr class="table__row" data-act="cur-doc" data-id="${esc(d.id)}" tabindex="0">
      ${selCheck('khReview', d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow kh-min"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbName(d))}</div></div></div></td>
      <td class="table__cell kh-reason">${chip(R.label, { size: 'sm', icon: R.icon, tone: x.reason === 'never' ? 'default' : 'warning', tip: x.note })}</td>
      <td class="table__cell"><div class="kh-owner"><span class="truncate">${esc(res(d).owner || '—')}</span>${req}</div></td>
      <td class="table__cell">${dueCell(x)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${btn('Verify', { v: 'secondary', size: 'sm', icon: 'shield-check', act: 'res-verify', data: { id: d.id } })}<span class="reveal-on-hover">${iconBtn('more', 'More actions', { size: 'sm', menu: 'kh-review', data: { id: d.id } })}</span></div></td></tr>`;
  }
  /** Row ⋯: the row opens the document and the fix (Verify) sits on the row. */
  MENUS['kh-review'] = el => {
    const d = docById(el.dataset.id), x = d && reviewItem(d); if (!x) return [];
    return [
      { label: d.reviewRequested ? 'Ask owner again' : 'Ask owner to review', icon: 'send', run: () => askOwners([d]) },
      { label: 'Edit details…', icon: 'pencil', run: () => A['res-edit']({ dataset: { id: d.id } }) },
    ];
  };
  function askOwners(docs) {
    docs = docs.filter(d => d && X.res.canEditRes(d)); if (!docs.length) return;
    const at = Date.now(), prev = docs.map(d => [d, d.reviewRequested]);
    const owners = [...new Set(docs.map(ownerOf))];
    docs.forEach(d => { d.reviewRequested = at; });
    audit(docs.length === 1 ? 'Asked the owner to review a document' : `Asked owners to review ${plural(docs.length, 'document')}`, docs.length === 1 ? `${docs[0].name} → ${owners[0]}` : owners.join(', '));
    ui('khReview').sel = {}; refresh();
    toast(owners.length === 1 ? `Sent to ${owners[0]}` : `Sent to ${plural(owners.length, 'owner')}`, { action: { label: 'Undo', run: () => { prev.forEach(([d, v]) => { if (v) d.reviewRequested = v; else delete d.reviewRequested; }); refresh(); } } });
  }
  const selectedReview = () => { const ids = new Set(selIds('khReview')); return reviewItems().filter(x => ids.has(x.d.id)); };
  A['kh-ask-sel'] = () => askOwners(selectedReview().map(x => x.d));
  A['kh-verify-sel'] = () => {
    const docs = selectedReview().map(x => x.d).filter(X.res.canEditRes);
    if (!docs.length) return;
    const prev = docs.map(d => [d, d.verify ? { ...d.verify } : null]), at = Date.now();
    docs.forEach(d => { d.verify = { state: 'verified', by: me().name, at, due: at + 180 * DAY }; });
    audit(docs.length === 1 ? 'Verified a document' : `Verified ${plural(docs.length, 'document')}`, docs.length === 1 ? docs[0].name : [...new Set(docs.map(kbName))].join(', '));
    ui('khReview').sel = {}; refresh();
    toast(`Verified ${plural(docs.length, 'document')} until ${fmtDate(at + 180 * DAY)}`, { action: { label: 'Undo', run: () => { prev.forEach(([d, v]) => { if (v) d.verify = v; else delete d.verify; }); refresh(); } } });
  };

  /* ── Missing details (metadata quality) ── */
  function tabDetails(all) {
    const u = ui('khDetails', { gap: '', kb: '', sel: {}, sug: {} });
    if (!all.length) return emptyState({ icon: 'check-circle', tone: 'success', title: 'Every document is described', desc: 'Documents you look after all have a topic, an owner and a summary.', boxed: true });
    pruneSel(u, new Set(all.map(x => x.d.id)));
    const counts = Object.fromEntries(Object.keys(GAPS).map(g => [g, all.filter(x => x.gaps.includes(g)).length]));
    if (u.gap && !GAPS[u.gap]) u.gap = '';
    const gapOpts = Object.keys(GAPS).filter(g => counts[g] || g === u.gap).map(g => [g, `${GAPS[g].label} · ${fmtNum(counts[g])}`]);
    const kbOpts = [...new Map(all.map(x => [x.d.kb, kbName(x.d)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const toolbar = needsTools(all.length, 'khDetails', ['gap', 'kb']) ? `<div class="toolbar">${searchField({ uiKey: 'khDetails', placeholder: 'Search documents' })}${gapOpts.length > 1 || u.gap ? filterButton('Missing', 'khDetails', 'gap', gapOpts) : ''}${kbOpts.length > 1 || u.kb ? filterButton('Knowledge base', 'khDetails', 'kb', kbOpts) : ''}${clearFilters('khDetails', ['gap', 'kb'])}</div>` : '';
    let rows = all.filter(x => (!u.gap || x.gaps.includes(u.gap)) && (!u.kb || x.d.kb === u.kb) && matchesQ('khDetails', x.d.name, kbName(x.d)));
    rows = applySort(rows, 'khDetails', { name: x => x.d.name.toLowerCase(), updated: x => x.d.updated });
    if (!rows.length) {
      if (u.q || u.kb) return toolbar + noMatches('khDetails', ['gap', 'kb'], 'documents');
      return toolbar + emptyState({ icon: 'check-circle', tone: 'success', title: `Every document has ${GAPS[u.gap]?.noun || 'its details'}`, boxed: true, compact: true });
    }
    const page = paginate(rows, 'khDetails', 20);
    const head = selAllCheck('khDetails', page.map(x => x.d.id)) + sortHead('Document', 'name', 'khDetails') + th('Missing') + sortHead('Updated', 'updated', 'khDetails', 'table__column--hide-sm') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    const bulk = bulkBar('khDetails', btn('Apply topic', { v: 'ghost', size: 'sm', icon: 'tag', iconRight: 'chevron-down', menu: 'kh-topic', data: { ids: selIds('khDetails').join(',') } }));
    return toolbar + table({ label: 'Missing details', head, rows: page.map(x => detailRow(x, u)), foot: pager(rows.length, 'khDetails', 20) }) + bulk;
  }
  function suggestionsHtml(d, sug) {
    if (!sug) return '';
    const body = sug.length
      ? `<span class="t-xs muted">Suggested</span>${sug.map(t => btn(topicName(t), { size: 'sm', v: 'secondary', icon: 'plus', act: 'kh-sug-accept', data: { id: d.id, topic: t } })).join('')}`
      : '<span class="t-xs muted">No suggestions</span>';
    return `<div class="kh-sug">${body}${iconBtn('x', 'Dismiss suggestions', { size: 'sm', act: 'kh-sug-close', data: { id: d.id } })}</div>`;
  }
  function detailRow(x, u) {
    const d = x.d, needsTopic = x.gaps.includes('topic');
    const gaps = x.gaps.map(g => chip(GAPS[g].label, { size: 'sm', icon: GAPS[g].icon, tone: g === u.gap ? 'warning' : 'default' })).join('');
    // Add topic (its menu starts with the assistant's suggestions); the pencil covers owner and summary.
    const actions = needsTopic
      ? btn('Add topic', { v: 'secondary', size: 'sm', icon: 'tag', iconRight: 'chevron-down', menu: 'kh-topic', data: { ids: d.id } }) + iconBtn('pencil', 'Edit details', { size: 'sm', act: 'res-edit', data: { id: d.id } })
      : btn('Edit details', { v: 'secondary', size: 'sm', icon: 'pencil', act: 'res-edit', data: { id: d.id } });
    return `<tr class="table__row" data-act="cur-doc" data-id="${esc(d.id)}" tabindex="0">
      ${selCheck('khDetails', d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow kh-min"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbName(d))}</div></div></div></td>
      <td class="table__cell kh-gaps"><div class="kh-chips">${gaps}</div>${needsTopic ? suggestionsHtml(d, u.sug[d.id]) : ''}</td>
      <td class="table__cell table__cell--hide-sm muted res-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${actions}</div></td></tr>`;
  }

  /** Add a topic to documents (keeps any topics they inherit from their knowledge base). */
  function applyTopic(ids, tid) {
    const docs = ids.map(docById).filter(d => d && X.res.canEditRes(d) && !res(d).topics.includes(tid));
    if (!docs.length) { toast(`Already tagged with “${topicName(tid)}”`, { tone: 'accent' }); return; }
    const prev = docs.map(d => [d, d.topics ? [...d.topics] : undefined]);
    docs.forEach(d => { d.topics = [...res(d).topics, tid]; });
    const u = ui('khDetails'); u.sel = {}; docs.forEach(d => { if (u.sug) delete u.sug[d.id]; });
    audit(docs.length === 1 ? 'Added a topic to a document' : `Added a topic to ${plural(docs.length, 'document')}`, `${topicName(tid)} → ${docs.length === 1 ? docs[0].name : plural(docs.length, 'document')}`);
    refresh();
    toast(docs.length === 1 ? `Added “${topicName(tid)}” to ${docs[0].name}` : `Added “${topicName(tid)}” to ${plural(docs.length, 'document')}`, { action: { label: 'Undo', run: () => { prev.forEach(([d, t]) => { if (t) d.topics = t; else delete d.topics; }); refresh(); } } });
  }
  MENUS['kh-topic'] = el => {
    const ids = (el.dataset.ids || '').split(',').filter(Boolean); if (!ids.length) return [];
    const tree = topicTree().filter(dm => dm.children.length);
    const suggest = ids.length === 1 && tree.length ? [{ label: 'Suggest topics', icon: 'sparkles', run: () => A['kh-suggest']({ dataset: { id: ids[0] } }) }, { sep: true }] : [];
    if (!tree.length) return [{ label: 'No topics yet', disabled: true }];
    return [...suggest, ...tree.flatMap(dm => [{ section: dm.name }, ...dm.children.map(t => ({ label: t.name, icon: 'tag', run: () => applyTopic(ids, t.id) }))])];
  };

  /** Mock tagging: topics whose words share a stem with the title or the document type. */
  function suggestTopics(d) {
    const title = tokens(d.name.replace(/\.[a-z0-9]+$/i, '')).filter(w => w.length >= 4);
    const kind = tokens(kindMeta(res(d).kind).label).filter(w => w.length >= 4);
    const hit = (w, list) => list.some(x => x.slice(0, 5) === w.slice(0, 5) || w.startsWith(x) || x.startsWith(w));
    const out = [];
    topicTree().forEach(dm => dm.children.forEach(t => {
      const words = tokens(t.name).filter(w => w.length >= 4);
      const s = words.reduce((a, w) => a + (hit(w, title) ? 2 : 0) + (hit(w, kind) ? 1 : 0), 0);
      if (s) out.push([t.id, s]);
    }));
    return out.sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
  }
  A['kh-suggest'] = el => { const d = docById(el.dataset.id); if (!d) return; ui('khDetails').sug[d.id] = suggestTopics(d); refresh(); };
  A['kh-sug-close'] = el => { delete ui('khDetails').sug[el.dataset.id]; refresh(); };
  A['kh-sug-accept'] = el => applyTopic([el.dataset.id], el.dataset.topic);

  /* ── Possible duplicates ── */
  const pairByKey = key => duplicateCandidates().find(p => p.key === key);
  function tabDups(pairs) {
    if (!pairs.length) return emptyState({ icon: 'copy', tone: 'success', title: 'No duplicates found', desc: 'Each document you look after appears once.', boxed: true });
    const head = th('Documents') + th('Reason') + th('Updated', 'table__column--hide-sm') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    return table({ label: 'Possible duplicates', head, rows: pairs.map(dupRow) });
  }
  const dupSide = (d, tag) => `<div class="kh-dup-doc">${fileIcon(d.type, 'sm')}<div class="kh-min"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${tag} · ${esc(kbName(d))}</div></div></div>`;
  function dupRow(p) {
    return `<tr class="table__row" data-act="kh-dup-open" data-key="${esc(p.key)}" tabindex="0">
      <td class="table__cell table__cell--primary"><div class="kh-dup-pair">${dupSide(p.keep, 'Newer')}${dupSide(p.dup, 'Older')}</div></td>
      <td class="table__cell kh-reason">${esc(p.reason)}</td>
      <td class="table__cell table__cell--hide-sm"><div class="kh-dup-dates"><span class="res-nowrap">${rel(p.keep.updated)}</span><span class="res-nowrap muted">${rel(p.dup.updated)}</span></div></td>
      <td class="table__cell table__cell--actions">${iconBtn('more', 'More actions', { size: 'sm', menu: 'kh-dup', data: { key: p.key } })}</td></tr>`;
  }
  /** The row opens Compare; ⋯ holds the quick decisions. */
  MENUS['kh-dup'] = el => {
    const p = pairByKey(el.dataset.key); if (!p) return [];
    return [
      { label: 'Keep newer, archive the other', icon: 'archive', disabled: !X.res.canEditRes(p.dup), run: () => merge(p.key) },
      { sep: true },
      { label: 'Not duplicates', icon: 'x-circle', run: () => dismiss(p.key) },
    ];
  };
  A['kh-dup-open'] = el => openDrawer('kh-dup', { key: el.dataset.key });

  /** Who points at a document: collections (names only when the caller can see them), saved lists and recent reads. */
  function refsOf(d) {
    const cols = (D.collections || []).filter(c => !c.archived && (c.items || []).some(i => i.doc === d.id));
    const seen = cols.filter(canSeeCollection);
    return { cols: seen, hidden: cols.length - seen.length, saved: Object.values(D.saved || {}).filter(l => l.includes(d.id)).length, recent: Object.values(D.recent || {}).filter(l => l.some(x => x.doc === d.id)).length };
  }
  function cmpCol(d, keep, newer, key) {
    const text = X.docText ? X.docText(d) : '';
    const excerpt = text.length > 420 ? text.slice(0, 420).replace(/\s+\S*$/, '') + '…' : text;
    const r = refsOf(d);
    const refs = [
      ...r.cols.map(c => `<li>${ic('list', 'i-sm muted')}<a class="link" href="#/knowledge/collections/${esc(c.id)}">${esc(c.name)}</a></li>`),
      r.hidden && `<li>${ic('lock', 'i-sm muted')}<span>${plural(r.hidden, 'private collection')}</span></li>`,
      r.saved && `<li>${ic('bookmark', 'i-sm muted')}<span>Saved by ${plural(r.saved, 'person', 'people')}</span></li>`,
      r.recent && `<li>${ic('history', 'i-sm muted')}<span>Recently opened by ${plural(r.recent, 'person', 'people')}</span></li>`,
    ].filter(Boolean);
    return `<section class="kh-cmp__col">
      <div class="kh-cmp__top">${chip(`${keep ? 'Keep' : 'Archive'} · ${newer ? 'newer' : 'older'}`, { size: 'sm', tone: keep ? 'success' : 'default', icon: keep ? 'check' : 'archive' })}<span class="grow"></span>${keep ? '' : btn('Keep this one', { v: 'ghost', size: 'sm', act: 'kh-dup-swap', data: { key } })}${btn('Open', { v: 'ghost', size: 'sm', icon: 'arrow-up-right', href: '/doc/' + d.id })}</div>
      <div class="row gap-12">${fileIcon(d.type)}<div class="grow kh-min"><div class="kh-cmp__title">${esc(d.name)}</div><div class="t-xs muted">Updated ${esc(fmtDate(d.updated))}</div></div></div>
      <div class="kh-cmp__block"><h3 class="t-label">Details</h3>${X.res.details(d)}</div>
      <div class="kh-cmp__block"><h3 class="t-label">Opening text</h3>${excerpt ? `<p class="kh-cmp__text">${esc(excerpt)}</p>` : '<p class="t-sm muted">No text yet. It hasn’t been published.</p>'}</div>
      <div class="kh-cmp__block"><h3 class="t-label">Referenced by</h3>${refs.length ? `<ul class="kh-refs">${refs.join('')}</ul>` : '<p class="t-sm muted">Nothing points to it.</p>'}</div>
    </section>`;
  }
  /** Which copy survives: the newer one unless the person picked the other in the compare drawer. */
  const sides = (p, swap) => (swap ? { keep: p.dup, dup: p.keep } : { keep: p.keep, dup: p.dup });
  DR['kh-dup'] = ({ key, swap }) => {
    const p = pairByKey(key);
    if (!p) return { title: 'Compare', body: emptyState({ icon: 'check-circle', tone: 'success', title: 'Already resolved', desc: 'This pair was merged or marked as not duplicates.', compact: true }), foot: btn('Close', { act: 'close-drawer' }) };
    const { keep, dup } = sides(p, swap), canMerge = X.res.canEditRes(dup);
    return {
      size: 'xl', title: 'Compare possible duplicates', desc: esc(p.reason),
      body: `<div class="kh-cmp">${cmpCol(keep, true, !swap, key)}${cmpCol(dup, false, !!swap, key)}</div>`,
      footStart: btn('Not duplicates', { v: 'ghost', act: 'kh-dup-dismiss', data: { key } }),
      foot: btn('Cancel', { act: 'close-drawer' }) + btn(swap ? 'Keep older, archive the newer' : 'Keep newer, archive the other', { v: 'primary', icon: 'archive', act: 'kh-dup-merge', data: { key, swap: swap ? '1' : '' }, disabled: !canMerge, tip: canMerge ? '' : `You can’t edit ${kbName(dup)}` }),
    };
  };
  A['kh-dup-swap'] = () => { if (S.drawer?.name !== 'kh-dup') return; S.drawer.props.swap = !S.drawer.props.swap; refreshLayer(); };
  A['kh-dup-merge'] = el => merge(el.dataset.key, el.dataset.swap === '1');
  A['kh-dup-dismiss'] = el => dismiss(el.dataset.key);

  /** Archive one copy and repoint collections, saved lists and recent reads to the one kept. Undo restores everything. */
  function merge(key, swap = false) {
    const p = pairByKey(key); if (!p) return;
    const { keep, dup } = sides(p, swap); if (!X.res.canEditRes(dup)) return;
    const at = Date.now();
    const cols = (D.collections || []).filter(c => (c.items || []).some(i => i.doc === dup.id)).map(c => [c, c.items.map(i => ({ ...i })), c.updated]);
    const saved = Object.entries(D.saved || {}).filter(([, l]) => l.includes(dup.id)).map(([u, l]) => [u, [...l]]);
    const recent = Object.entries(D.recent || {}).filter(([, l]) => l.some(x => x.doc === dup.id)).map(([u, l]) => [u, l.map(x => ({ ...x }))]);
    cols.forEach(([c]) => {
      const has = c.items.some(i => i.doc === keep.id);
      c.items = c.items.flatMap(i => (i.doc !== dup.id ? [i] : has ? [] : [{ ...i, doc: keep.id }]));
      c.updated = at;
    });
    saved.forEach(([u, l]) => { D.saved[u] = [...new Set(l.map(id => (id === dup.id ? keep.id : id)))]; });
    recent.forEach(([u, l]) => { const seen = new Set(); D.recent[u] = l.map(x => (x.doc === dup.id ? { ...x, doc: keep.id } : x)).filter(x => !seen.has(x.doc) && seen.add(x.doc)); });
    const prev = { archived: dup.archived, mergedInto: dup.mergedInto, contexts: keep.contexts ? [...keep.contexts] : undefined };
    dup.archived = true; dup.mergedInto = keep.id;
    if (dup.contexts?.length) keep.contexts = [...new Set([...(keep.contexts || []), ...dup.contexts])];
    audit('Merged a duplicate', `${dup.name} → ${keep.name}`);
    if (S.drawer?.name === 'kh-dup') S.drawer = null;
    refresh();
    const n = cols.length + saved.length + recent.length;
    toast(`Archived “${dup.name}”${n ? ` · ${plural(n, 'reference')} now ${n === 1 ? 'points' : 'point'} to the copy you kept` : ''}`, {
      action: {
        label: 'Undo', run: () => {
          cols.forEach(([c, items, upd]) => { c.items = items; c.updated = upd; });
          saved.forEach(([u, l]) => { D.saved[u] = l; });
          recent.forEach(([u, l]) => { D.recent[u] = l; });
          if (prev.archived) dup.archived = prev.archived; else delete dup.archived;
          if (prev.mergedInto) dup.mergedInto = prev.mergedInto; else delete dup.mergedInto;
          if (prev.contexts) keep.contexts = prev.contexts; else delete keep.contexts;
          audit('Undid a duplicate merge', dup.name); refresh(); toast('Merge undone', { tone: 'accent' });
        },
      },
    });
  }
  function dismiss(key) {
    const p = pairByKey(key); if (!p) return;
    (D.dupDismissed ??= []).push(key);
    audit('Marked documents as not duplicates', `${p.keep.name} · ${p.dup.name}`);
    if (S.drawer?.name === 'kh-dup') S.drawer = null;
    refresh();
    toast('Marked as not duplicates', { action: { label: 'Undo', run: () => { D.dupDismissed = (D.dupDismissed || []).filter(k => k !== key); refresh(); } } });
  }

  /* ═══════════════ Topics tab ═══════════════ */
  function topics() {
    return gate({
      loading: () => skelRows(6),
      error: () => errorState({ title: 'Topics didn’t load' }),
      empty: () => emptyState({ icon: 'tag', title: 'No topics yet', desc: canManageTaxonomy() ? 'Add a domain, then the topics people browse by.' : 'A workspace admin can add topics.', boxed: true }),
      ok: () => {
        const n = topicCounts();
        return `<div class="kh gov">${proposalsHtml()}${taxonomyHtml(n)}</div>`;
      },
    });
  }

  /* ── Proposed by the assistant (decided only here, by workspace admins) ── */
  /** Every open proposal. Proposals come from all open submissions (names only); document titles are listed only for documents the caller can see. */
  const visibleProposals = () => { D.docs.filter(d => !d.archived && stageOf(d) === 'review' && !d.ai).forEach(aiOf); return openProposals(); };
  const domains = () => (D.topics || []).filter(t => !t.parent && !t.archived);
  /** Working copy of a proposal: edit = '' (as suggested) | 'name' | 'domain' | 'merge'. */
  function propForm(p) {
    const all = ui('govProp', {});
    return (all[p.id] ??= { name: p.name, parent: p.parent && topicById(p.parent) && !topicById(p.parent).archived ? p.parent : '__new', dname: p.name, into: '', err: '', edit: '' });
  }
  function propDocs(p) {
    const docs = (p.docs || []).map(docById).filter(Boolean), seen = docs.filter(canSeeDoc), hidden = docs.length - seen.length;
    const link = d => {
      const href = stageOf(d) === 'review' ? `/documents?tab=review&sel=${d.id}` : `/documents?tab=all&sel=${d.id}`;
      return `<a class="gov-prop__doc link" href="#${esc(href)}"><span class="truncate">${esc(d.name)}</span></a>`;
    };
    return `<span class="gov-prop__docs"><span>${esc(`Suggested by ${plural(docs.length, 'document')}`)}${seen.length ? ':' : ''}</span>${seen.map(link).join('<span aria-hidden="true">,</span>')}${hidden && seen.length ? `<span>${esc(`+${hidden} more`)}</span>` : ''}</span>`;
  }
  /** A proposal reads as a sentence (name, in which domain, why) with Accept; editing opens only when Rename, Change domain or Merge is chosen. */
  function propCard(p) {
    const f = propForm(p), id = esc(p.id);
    const dom = f.parent !== '__new' && topicById(f.parent);
    const where = dom ? `in ${esc(dom.name)}` : `as a new domain${f.dname && f.dname !== f.name ? ` “${esc(f.dname)}”` : ''}`;
    let editor = '';
    if (f.edit === 'name') editor = field({ id: `gov-pn-${id}`, label: 'Topic name', error: f.err, control: input({ id: `gov-pn-${id}`, bind: `govProp.${p.id}.name`, value: f.name, size: 'sm', invalid: !!f.err, onEnter: 'gov-prop-accept', attrs: `maxlength="60" data-id="${id}" data-autofocus` }) });
    else if (f.edit === 'domain') editor = field({ id: `gov-pd-${id}`, label: 'Domain', error: f.err, control: select({ id: `gov-pd-${id}`, bind: `govProp.${p.id}.parent`, value: f.parent, options: [...domains().map(d => [d.id, d.name]), ['__new', 'New domain…']], change: 'gov-prop-domain', size: 'sm' }) })
      + (f.parent === '__new' ? field({ id: `gov-pdn-${id}`, label: 'New domain name', control: input({ id: `gov-pdn-${id}`, bind: `govProp.${p.id}.dname`, value: f.dname, size: 'sm', attrs: 'maxlength="60"' }) }) : '');
    else if (f.edit === 'merge') editor = field({ id: `gov-pm-${id}`, label: 'Merge into', error: f.err, control: select({ id: `gov-pm-${id}`, bind: `govProp.${p.id}.into`, value: f.into, size: 'sm', change: 'gov-prop-domain', options: [['', 'Choose a topic'], ...topicTree().flatMap(dm => dm.children.map(t => [t.id, `${dm.name} · ${t.name}`]))] }) });
    const main = f.edit === 'merge'
      ? btn('Merge', { v: 'secondary', size: 'sm', icon: 'git-compare', act: 'gov-prop-merge-go', data: { id: p.id } })
      : btn('Accept', { v: 'secondary', size: 'sm', icon: 'check', act: 'gov-prop-accept', data: { id: p.id } });
    const acts = (f.edit ? btn('Cancel', { v: 'ghost', size: 'sm', act: 'gov-prop-cancel', data: { id: p.id } }) : '') + main + iconBtn('more', 'More actions', { size: 'sm', menu: 'gov-prop-more', data: { id: p.id } });
    return `<li class="gov-prop" data-id="${id}">
      <span class="item-icon item-icon--accent item-icon--sm" aria-hidden="true">${ic('sparkles')}</span>
      <div class="gov-prop__main"><div class="gov-prop__title"><span class="medium">${esc(f.name)}</span> <span class="muted">${where}</span></div>${propDocs(p)}${editor ? `<div class="gov-prop__edit">${editor}</div>` : ''}</div>
      <div class="gov-prop__acts">${acts}</div></li>`;
  }
  function proposalsHtml() {
    const list = visibleProposals(); if (!list.length || !canManageTaxonomy()) return '';
    return section('Proposed by the assistant', `<ul class="gov-props">${list.map(propCard).join('')}</ul>`, {
      desc: 'Accepting adds the topic and tags the documents that suggested it. Submissions can be published without waiting for it.',
    });
  }
  MENUS['gov-prop-more'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return [];
    const f = propForm(p), edit = mode => () => { Object.assign(f, { edit: mode, err: '' }); refresh(); };
    return [
      { label: 'Rename…', icon: 'pencil', run: edit('name') },
      { label: 'Change domain…', icon: 'folder', run: edit('domain') },
      { label: 'Merge into…', icon: 'git-compare', run: edit('merge') },
      { sep: true },
      { label: 'Dismiss', icon: 'x', danger: true, run: () => A['gov-prop-dismiss']({ dataset: { id: p.id } }) },
    ];
  };
  A['gov-prop-cancel'] = el => { const p = proposalById(el.dataset.id); if (p) delete S.ui.govProp?.[p.id]; refresh(); };
  /** Snapshot of everything a proposal decision touches (Undo). */
  function propSnap(p) {
    return { topics: [...(D.topics || [])], p: { ...p, docs: [...(p.docs || [])] }, docs: (p.docs || []).map(docById).filter(Boolean).map(d => [d, snapDoc(d)]) };
  }
  function propUndo(p, snap, msg) {
    return { label: 'Undo', run: () => {
      D.topics = snap.topics;
      Object.keys(p).forEach(k => delete p[k]); Object.assign(p, snap.p);
      snap.docs.forEach(([d, s]) => restoreDoc(d, s));
      audit('Undid a topic decision', p.name); refresh(); toast(msg, { tone: 'accent' });
    } };
  }
  const propOf = el => { const p = proposalById(el.dataset.id || el.closest?.('[data-id]')?.dataset.id); return p && p.status === 'open' ? p : null; };
  A['gov-prop-domain'] = () => refresh();
  A['gov-prop-accept'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return;
    const f = propForm(p), name = (f.name || '').trim().replace(/\s+/g, ' ');
    const newDom = f.parent === '__new' || !topicById(f.parent), dname = (f.dname || '').trim().replace(/\s+/g, ' ') || name;
    // Errors open the editor that fixes them.
    const fail = (msg, edit = 'name') => { Object.assign(f, { err: msg, edit }); refresh(); requestAnimationFrame(() => $(`#gov-${edit === 'name' ? 'pn' : 'pd'}-${p.id}`)?.focus()); };
    if (!name) return fail('Enter a name.');
    if (!newDom && (D.topics || []).some(t => !t.archived && t.parent === f.parent && fold(t.name) === fold(name))) return fail(`${topicName(f.parent)} already has “${name}”. Merge into it instead.`);
    if (newDom && domains().some(d => fold(d.name) === fold(dname))) return fail(`A domain called “${dname}” already exists. Pick it from the list.`, 'domain');
    const snap = propSnap(p);
    let parent = newDom ? null : f.parent;
    if (newDom) { const dm = { id: uid('d'), name: dname }; D.topics.push(dm); parent = dm.id; }
    const t = acceptProposal(p, { name, parent });
    if (!t) { D.topics = snap.topics; return; }
    delete S.ui.govProp?.[p.id];
    const n = snap.docs.length;
    refresh();
    toast(`Added “${t.name}” to ${topicName(parent)}${n ? ` · ${plural(n, 'document')} tagged` : ''}`, { action: propUndo(p, snap, `“${name}” removed`) });
  };
  A['gov-prop-dismiss'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return;
    const snap = propSnap(p);
    dismissProposal(p); delete S.ui.govProp?.[p.id]; refresh();
    toast(`Dismissed “${p.name}”`, { action: propUndo(p, snap, `“${p.name}” is proposed again`) });
  };
  A['gov-prop-merge-go'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return;
    const f = propForm(p), t = topicById(f.into);
    if (!t) { f.err = 'Choose the topic to merge into.'; refresh(); return; }
    const snap = propSnap(p);
    mergeProposal(p, t.id); delete S.ui.govProp?.[p.id]; refresh();
    toast(`Merged “${p.name}” into ${t.name}${snap.docs.length ? ` · ${plural(snap.docs.length, 'document')} tagged` : ''}`, { action: propUndo(p, snap, `“${p.name}” is proposed again`) });
  };

  /* ── Taxonomy editor ── */
  function taxonomyHtml(n) {
    const u = ui('khTopics', { edit: '', name: '', err: '' }), admin = canManageTaxonomy();
    const all = D.topics || [], doms = all.filter(t => !t.parent && !t.archived);
    const add = admin ? btn('Add domain', { size: 'sm', icon: 'plus', act: 'kh-domain-add', disabled: u.edit === 'new:' }) : '';
    const desc = 'What documents are about (types like Policy say what they are)' + (admin ? '' : ' · Only workspace admins change topics.');
    const blocks = doms.map(dm => domainBlock(dm, all.filter(t => t.parent === dm.id && (admin || !t.archived)), n, u, admin));
    if (u.edit === 'new:') blocks.push(`<section class="kh-domain"><div class="kh-domain__head">${editor(u, 'Domain name')}</div></section>`);
    const body = blocks.length ? `<div class="kh-domains">${blocks.join('')}</div>`
      : emptyState({ icon: 'tag', title: 'No topics yet', desc: admin ? 'Add a domain, then the topics people browse by.' : 'A workspace admin can add topics.', actions: admin ? btn('Add domain', { v: 'primary', icon: 'plus', act: 'kh-domain-add' }) : '', boxed: true });
    return section('Topics', body, { desc, actions: add });
  }
  function editor(u, label) {
    return `<div class="kh-edit"><div class="kh-edit__row">${input({ id: 'kh-topic-name', bind: 'khTopics.name', value: u.name, size: 'sm', onEnter: 'kh-topic-save', invalid: !!u.err, attrs: `maxlength="60" aria-label="${esc(label)}"`, placeholder: label })}${btn('Save', { size: 'sm', v: 'primary', act: 'kh-topic-save' })}${btn('Cancel', { size: 'sm', v: 'ghost', act: 'kh-topic-cancel' })}</div>${u.err ? `<div class="field-error" id="kh-topic-name-err" role="alert">${ic('alert-circle')}<span>${esc(u.err)}</span></div>` : ''}</div>`;
  }
  /** "12 published · 2 in review" — published links to Browse, in review to the queue. */
  function countLinks(id, pub, rv) {
    const a = pub ? `<a class="kh-count link" href="#${catalogHref({ filters: { topic: [id] } })}">${esc(`${fmtNum(pub)} published`)}</a>` : '';
    const b = rv ? `<a class="kh-count link gov-inreview" href="#/documents?tab=review">${esc(`${fmtNum(rv)} in review`)}</a>` : '';
    return a || b ? `<span class="gov-counts">${[a, b].filter(Boolean).join('<span class="kh-count muted" aria-hidden="true">·</span>')}</span>` : '<span class="kh-count muted">Unused</span>';
  }
  function domainBlock(dm, list, n, u, admin) {
    const head = u.edit === dm.id ? editor(u, 'Domain name')
      : `<h3 class="kh-domain__name">${esc(dm.name)}</h3>${countLinks(dm.id, n.domain(dm.id), n.reviewDomain(dm.id))}<span class="grow"></span>${admin ? iconBtn('pencil', 'Rename domain', { size: 'sm', act: 'kh-topic-rename', data: { id: dm.id } }) + btn('Add topic', { size: 'sm', v: 'ghost', icon: 'plus', act: 'kh-topic-add', data: { id: dm.id } }) : ''}`;
    const rows = list.map(t => {
      if (u.edit === t.id) return `<li class="kh-topic">${editor(u, 'Topic name')}</li>`;
      const c = n.topic(t.id), r = n.review(t.id);
      if (t.archived) return `<li class="kh-topic is-archived">${ic('archive', 'i-sm muted')}<span class="grow truncate">${esc(t.name)}</span>${chip('Archived', { size: 'sm' })}${btn('Restore', { size: 'sm', v: 'ghost', act: 'kh-topic-restore', data: { id: t.id } })}</li>`;
      const used = c + r;
      const archive = used
        ? `<span class="kh-tipwrap" data-tip="${esc(`Used by ${plural(used, 'document')}. Move them to another topic first.`)}" tabindex="0">${btn('', { v: 'ghost', size: 'sm', icon: 'archive', muted: true, disabled: true, aria: 'aria-label="Archive topic"' })}</span>`
        : iconBtn('archive', 'Archive topic', { size: 'sm', act: 'kh-topic-archive', data: { id: t.id } });
      const acts = admin ? `<span class="kh-topic__acts">${iconBtn('pencil', 'Rename topic', { size: 'sm', act: 'kh-topic-rename', data: { id: t.id } })}${archive}</span>` : '';
      return `<li class="kh-topic">${ic('tag', 'i-sm muted')}<span class="grow truncate kh-topic__name">${esc(t.name)}</span>${countLinks(t.id, c, r)}${acts}</li>`;
    });
    if (u.edit === 'new:' + dm.id) rows.push(`<li class="kh-topic">${editor(u, 'Topic name')}</li>`);
    return `<section class="kh-domain"><div class="kh-domain__head">${head}</div>${rows.length ? `<ul class="kh-topics">${rows.join('')}</ul>` : '<p class="kh-domain__empty t-sm muted">No topics yet.</p>'}</section>`;
  }
  const focusEditor = () => requestAnimationFrame(() => { const el = $('#kh-topic-name'); if (el) { el.focus(); el.select?.(); } });
  function startEdit(edit, name = '') { if (!canManageTaxonomy()) return; Object.assign(ui('khTopics'), { edit, name, err: '' }); refresh(); focusEditor(); }
  A['kh-domain-add'] = () => startEdit('new:');
  A['kh-topic-add'] = el => startEdit('new:' + el.dataset.id);
  A['kh-topic-rename'] = el => { const t = topicById(el.dataset.id); if (t) startEdit(t.id, t.name); };
  A['kh-topic-cancel'] = () => { Object.assign(ui('khTopics'), { edit: '', name: '', err: '' }); refresh(); };
  A['kh-topic-save'] = () => {
    if (!canManageTaxonomy()) return;
    const u = ui('khTopics'), name = (u.name || '').trim().replace(/\s+/g, ' ');
    const isNew = u.edit.startsWith('new:'), cur = isNew ? null : topicById(u.edit);
    if (!isNew && !cur) return A['kh-topic-cancel']();
    const parent = isNew ? u.edit.slice(4) || null : cur.parent || null;
    const fail = msg => { u.err = msg; refresh(); focusEditor(); };
    if (!name) return fail('Enter a name.');
    if ((D.topics || []).some(t => !t.archived && (t.parent || null) === parent && t.id !== u.edit && fold(t.name) === fold(name))) return fail(parent ? `${topicName(parent)} already has “${name}”.` : `A domain called “${name}” already exists.`);
    Object.assign(u, { edit: '', name: '', err: '' });
    if (cur) {
      const before = cur.name; if (before === name) return refresh();
      cur.name = name; audit(parent ? 'Renamed a topic' : 'Renamed a domain', `${before} → ${name}`); refresh();
      toast(`Renamed to “${name}”`, { action: { label: 'Undo', run: () => { cur.name = before; refresh(); } } });
      return;
    }
    const t = { id: uid(parent ? 't' : 'd'), name, ...(parent ? { parent } : {}) };
    D.topics ??= [];
    const last = parent ? D.topics.map(x => x.parent === parent || x.id === parent).lastIndexOf(true) : D.topics.length - 1;
    D.topics.splice(last + 1, 0, t);
    audit(parent ? 'Added a topic' : 'Added a domain', parent ? `${name} → ${topicName(parent)}` : name); refresh();
    toast(parent ? `Added “${name}” to ${topicName(parent)}` : `Added the domain “${name}”`, { action: { label: 'Undo', run: () => { const c = topicCounts(); if (c.topic(t.id) || c.review(t.id)) t.archived = true; else D.topics = D.topics.filter(x => x !== t); refresh(); } } });
  };
  A['kh-topic-archive'] = el => {
    const t = topicById(el.dataset.id); if (!t || !canManageTaxonomy()) return;
    const c = topicCounts(); if (c.topic(t.id) || c.review(t.id)) return;
    t.archived = true; audit('Archived a topic', t.name); refresh();
    toast(`Archived “${t.name}”`, { action: { label: 'Undo', run: () => { delete t.archived; refresh(); } } });
  };
  A['kh-topic-restore'] = el => {
    const t = topicById(el.dataset.id); if (!t || !canManageTaxonomy()) return;
    delete t.archived; audit('Restored a topic', t.name); refresh(); toast(`Restored “${t.name}”`);
  };
  const prevEsc = A['esc-page'];
  A['esc-page'] = () => { if (S.cur?.r.page === 'documentsAdmin' && S.ui.khTopics?.edit) { A['kh-topic-cancel'](); return true; } return prevEsc ? prevEsc() : false; };

  X.gov = { quality, topics, qualityCount, proposalCount };
})();

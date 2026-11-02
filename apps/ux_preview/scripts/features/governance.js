/* Knowledge health (/knowledge-health) — where owners and admins keep the
   catalog trustworthy: verification cycles (Review), metadata quality
   (Details), duplicates and the topic taxonomy. Scope: resources in the
   knowledge bases the caller can edit (admins: all). Sync and indexing stay
   in Sources. Reader pages never show any of this.
   Exports: X.khealthCount(), X.khReview(). Actions: kh-*. Menus: kh-review,
   kh-topic, kh-dup. Drawer: kh-dup. Model: core/catalog.js. */
(() => {
  'use strict';

  const BASE = '/knowledge-health';
  const TABS = ['review', 'details', 'duplicates', 'topics'];
  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const kbName = d => kbById(d.kb)?.name || '';
  const ownerOf = d => res(d).owner || 'the knowledge base owner';
  /** Keep a selection bucket in step with rows that still exist (rows are derived and vanish once fixed). */
  function pruneSel(u, valid) { Object.keys(u.sel || {}).forEach(id => { if (!valid.has(id)) delete u.sel[id]; }); }

  /* ═══════════════ Signals ═══════════════ */
  /** Resources the caller looks after: editable, non-personal knowledge bases. */
  const scope = () => readableResources().filter(d => { const kb = kbById(d.kb); return kb && !kb.personal && canEditKb(kb); });

  const REASONS = {
    source: { label: 'Changed at source', icon: 'refresh', rank: 0 },
    expired: { label: 'Verification expired', icon: 'clock', rank: 1 },
    never: { label: 'Never verified', icon: 'circle-dashed', rank: 2 },
  };
  /** { d, reason, note, due } when a resource needs an owner's attention, else null. */
  function reviewItem(d) {
    const t = trustOf(d);
    if (t.state === 'review') return { d, reason: d.status === 'outdated' ? 'source' : 'expired', note: t.note, due: t.due || null };
    if (t.state === 'unverified' && d.status === 'ready' && kbById(d.kb)?.unit) return { d, reason: 'never', note: t.note, due: null };
    return null;
  }
  const reviewItems = (pool = scope()) => pool.map(reviewItem).filter(Boolean)
    .sort((a, b) => REASONS[a.reason].rank - REASONS[b.reason].rank || (a.due || 9e15) - (b.due || 9e15) || a.d.name.localeCompare(b.d.name));

  const GAPS = { topic: { label: 'No topic', icon: 'tag', noun: 'a topic' }, owner: { label: 'No owner', icon: 'user', noun: 'an owner' }, summary: { label: 'No summary', icon: 'note', noun: 'a summary' } };
  const detailItems = (pool = scope()) => pool.map(d => ({ d, gaps: metadataGaps(d) })).filter(x => x.gaps.length);

  /** Resources per topic and per domain (distinct resources), over what the caller can read. */
  function topicCounts() {
    const byTopic = new Map(), byDomain = new Map();
    readableResources().forEach(d => {
      const doms = new Set();
      res(d).topics.forEach(id => { byTopic.set(id, (byTopic.get(id) || 0) + 1); doms.add(topicById(id)?.parent || id); });
      doms.forEach(id => byDomain.set(id, (byDomain.get(id) || 0) + 1));
    });
    return { topic: id => byTopic.get(id) || 0, domain: id => byDomain.get(id) || 0 };
  }

  X.khReview = () => (can('knowledge.manage') ? reviewItems() : []);
  /** Nav badge: what has gone stale (expired or changed at the source) plus possible duplicates. "Never verified" is backlog, not an alert. */
  X.khealthCount = () => (can('knowledge.manage') ? reviewItems().filter(x => x.reason !== 'never').length + duplicateCandidates().length : 0);

  /* ═══════════════ Page ═══════════════ */
  function summary(pool, rv, dt, dp) {
    if (!pool.length) return 'You don’t look after any knowledge bases yet.';
    const kbs = new Set(pool.map(d => d.kb)).size;
    if (!rv.length && !dt.length && !dp.length) return esc(`${plural(pool.length, 'resource')} across ${plural(kbs, 'knowledge base')} — all verified, described and unique.`);
    return esc(`${plural(rv.length, 'resource')} due for review, ${fmtNum(dt.length)} missing details and ${plural(dp.length, 'possible duplicate')} across ${plural(kbs, 'knowledge base')} you look after.`);
  }

  P.khealth = ({ query }) => {
    const tab = TABS.includes(query.tab) ? query.tab : 'review';
    const live = S.pageState === 'live' && !S.navLoading;
    const pool = scope(), rv = reviewItems(pool), dt = detailItems(pool), dp = duplicateCandidates();
    const topics = (D.topics || []).filter(t => t.parent && !t.archived).length;
    const head = pageHeader({ title: 'Knowledge health', extra: X.res.demoChip(), desc: live ? summary(pool, rv, dt, dp) : '' });
    const nav = `<div class="page-tabs">${tabs([
      { id: 'review', label: 'Review', count: live ? rv.length : null },
      { id: 'details', label: 'Details', count: live ? dt.length : null },
      { id: 'duplicates', label: 'Duplicates', count: live ? dp.length : null },
      { id: 'topics', label: 'Topics', count: live ? topics : null },
    ], tab, BASE)}</div>`;
    const body = gate({
      loading: () => skelRows(6),
      error: () => errorState({ title: 'Knowledge health didn’t load' }),
      empty: () => emptyState({ icon: 'shield-check', tone: 'success', title: 'All knowledge is healthy', desc: 'Nothing is due for review, missing details or duplicated.', boxed: true }),
      ok: () => (tab === 'review' ? tabReview(rv) : tab === 'details' ? tabDetails(dt) : tab === 'duplicates' ? tabDups(dp) : tabTopics()),
    });
    return `<div class="page kh">${head}${nav}${body}</div>`;
  };

  /* ═══════════════ Review ═══════════════ */
  function tabReview(all) {
    const u = ui('khReview', { kb: '', reason: '', sel: {} });
    if (!all.length) return emptyState({ icon: 'shield-check', tone: 'success', title: 'Nothing is due for review', desc: 'Every resource you look after is verified and current.', boxed: true });
    pruneSel(u, new Set(all.map(x => x.d.id)));
    const kbOpts = [...new Map(all.map(x => [x.d.kb, kbName(x.d)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const reasonOpts = Object.entries(REASONS).filter(([k]) => all.some(x => x.reason === k)).map(([k, r]) => [k, r.label]);
    const sources = all.some(x => x.reason === 'source') && can('source.manage') ? `<div class="toolbar__end">${linkBtn('Sync status in Sources', { href: '/sources', icon: 'arrow-up-right' })}</div>` : '';
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'khReview', placeholder: 'Search resources' })}${filterButton('Knowledge base', 'khReview', 'kb', kbOpts)}${filterButton('Reason', 'khReview', 'reason', reasonOpts)}${clearFilters('khReview', ['kb', 'reason'])}${sources}</div>`;
    let rows = all.filter(x => (!u.kb || x.d.kb === u.kb) && (!u.reason || x.reason === u.reason) && matchesQ('khReview', x.d.name, res(x.d).owner, kbName(x.d)));
    rows = applySort(rows, 'khReview', { name: x => x.d.name.toLowerCase(), due: x => x.due || 9e15 });
    if (!rows.length) return toolbar + noMatches('khReview', ['kb', 'reason'], 'resources');
    const page = paginate(rows, 'khReview', 20);
    const head = selAllCheck('khReview', page.map(x => x.d.id)) + sortHead('Resource', 'name', 'khReview') + th('Reason') + th('Owner') + sortHead('Due', 'due', 'khReview') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    const bulk = bulkBar('khReview', btn('Verify selected', { v: 'ghost', size: 'sm', icon: 'shield-check', act: 'kh-verify-sel' }) + btn('Ask owners', { v: 'ghost', size: 'sm', icon: 'send', act: 'kh-ask-sel' }));
    return toolbar + table({ label: 'Due for review', head, rows: page.map(reviewRow), foot: pager(rows.length, 'khReview', 20) }) + bulk;
  }
  function dueCell(x) {
    if (!x.due) return '<span class="muted">—</span>';
    const late = x.due < Date.now(), days = Math.max(1, Math.round(Math.abs(Date.now() - x.due) / DAY));
    return `<div class="stack"><span class="${late ? 'text-warning medium' : ''} res-nowrap">${esc(fmtDate(x.due))}</span><span class="cell-sub res-nowrap">${late ? `${plural(days, 'day')} overdue` : esc(relFuture(x.due))}</span></div>`;
  }
  function primaryAction(x) {
    const d = x.d;
    if (x.reason !== 'source') return btn('Verify', { size: 'sm', icon: 'shield-check', act: 'res-verify', data: { id: d.id } });
    const ok = can('ingestion.run');
    return btn('Reprocess', { size: 'sm', icon: 'refresh', act: 'kh-reprocess', data: { id: d.id }, disabled: !ok || d.status === 'processing', tip: ok ? '' : 'Ask someone who can run syncs' });
  }
  function reviewRow(x) {
    const d = x.d, R = REASONS[x.reason];
    const req = d.reviewRequested ? chip('Requested', { size: 'sm', icon: 'send', tip: `Asked ${rel(d.reviewRequested).toLowerCase()}` }) : '';
    return `<tr class="table__row" data-act="res-open" data-id="${esc(d.id)}" tabindex="0">
      ${selCheck('khReview', d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow kh-min"><div class="cell-title truncate" title="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate" title="${esc(kbName(d))}">${esc(kbName(d))}</div></div></div></td>
      <td class="table__cell kh-reason">${chip(R.label, { size: 'sm', icon: R.icon, tone: x.reason === 'never' ? 'default' : 'warning', tip: x.note })}</td>
      <td class="table__cell"><div class="kh-owner"><span class="truncate">${esc(res(d).owner || '—')}</span>${req}</div></td>
      <td class="table__cell">${dueCell(x)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${primaryAction(x)}${iconBtn('more', 'More actions', { size: 'sm', menu: 'kh-review', data: { id: d.id } })}</div></td></tr>`;
  }
  MENUS['kh-review'] = el => {
    const d = docById(el.dataset.id), x = d && reviewItem(d); if (!x) return [];
    return [
      { label: 'Open', icon: 'file-text', run: () => go('/doc/' + d.id) },
      x.reason !== 'source' && { label: 'Mark as verified', icon: 'shield-check', run: () => A['res-verify']({ dataset: { id: d.id } }) },
      x.reason === 'source' && { label: 'Reprocess', icon: 'refresh', disabled: !can('ingestion.run') || d.status === 'processing', run: () => A['kh-reprocess']({ dataset: { id: d.id } }) },
      { label: d.reviewRequested ? 'Ask owner again' : 'Ask owner to review', icon: 'send', run: () => askOwners([d]) },
      { sep: true },
      { label: 'Edit details…', icon: 'pencil', run: () => A['res-edit']({ dataset: { id: d.id } }) },
    ].filter(Boolean);
  };
  A['kh-reprocess'] = el => {
    const d = docById(el.dataset.id); if (!d || !X.res.canEditRes(d) || !can('ingestion.run')) return;
    if (X.processDocs) X.processDocs([d], { msg: `Reprocessing ${d.name}` });
    else go('/sources');
  };
  function askOwners(docs) {
    docs = docs.filter(d => d && X.res.canEditRes(d)); if (!docs.length) return;
    const at = Date.now(), prev = docs.map(d => [d, d.reviewRequested]);
    const owners = [...new Set(docs.map(ownerOf))];
    docs.forEach(d => { d.reviewRequested = at; });
    audit(docs.length === 1 ? 'Asked the owner to review a resource' : `Asked owners to review ${plural(docs.length, 'resource')}`, docs.length === 1 ? `${docs[0].name} → ${owners[0]}` : owners.join(', '));
    ui('khReview').sel = {}; refresh();
    toast(owners.length === 1 ? `Sent to ${owners[0]}` : `Sent to ${plural(owners.length, 'owner')}`, { action: { label: 'Undo', run: () => { prev.forEach(([d, v]) => { if (v) d.reviewRequested = v; else delete d.reviewRequested; }); refresh(); } } });
  }
  const selectedReview = () => { const ids = new Set(selIds('khReview')); return reviewItems().filter(x => ids.has(x.d.id)); };
  A['kh-ask-sel'] = () => askOwners(selectedReview().map(x => x.d));
  A['kh-verify-sel'] = () => {
    const picked = selectedReview(), docs = picked.filter(x => x.reason !== 'source').map(x => x.d).filter(X.res.canEditRes);
    const skipped = picked.length - docs.length;
    if (!docs.length) { toast('Reprocess resources that changed at the source before verifying them', { tone: 'accent' }); return; }
    const prev = docs.map(d => [d, d.verify ? { ...d.verify } : null]), at = Date.now();
    docs.forEach(d => { d.verify = { state: 'verified', by: me().name, at, due: at + 180 * DAY }; });
    audit(docs.length === 1 ? 'Verified a resource' : `Verified ${plural(docs.length, 'resource')}`, docs.length === 1 ? docs[0].name : [...new Set(docs.map(kbName))].join(', '));
    ui('khReview').sel = {}; refresh();
    toast(`Verified ${plural(docs.length, 'resource')} until ${fmtDate(at + 180 * DAY)}${skipped ? ` · ${skipped} changed at the source need reprocessing first` : ''}`, { action: { label: 'Undo', run: () => { prev.forEach(([d, v]) => { if (v) d.verify = v; else delete d.verify; }); refresh(); } } });
  };

  /* ═══════════════ Details (metadata quality) ═══════════════ */
  function tabDetails(all) {
    const u = ui('khDetails', { gap: '', kb: '', sel: {}, sug: {} });
    if (!all.length) return emptyState({ icon: 'check-circle', tone: 'success', title: 'Every resource is described', desc: 'Resources you look after all have a topic, an owner and a summary.', boxed: true });
    pruneSel(u, new Set(all.map(x => x.d.id)));
    const counts = Object.fromEntries(Object.keys(GAPS).map(g => [g, all.filter(x => x.gaps.includes(g)).length]));
    if (!u.gap) u.gap = Object.keys(GAPS).find(g => counts[g]) || 'all';
    const gapOpts = [...Object.keys(GAPS).filter(g => counts[g] || g === u.gap).map(g => [g, `${GAPS[g].label} · ${fmtNum(counts[g])}`]), ['all', `All · ${fmtNum(all.length)}`]];
    const kbOpts = [...new Map(all.map(x => [x.d.kb, kbName(x.d)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const toolbar = `<div class="toolbar">${seg({ value: u.gap, options: gapOpts, act: 'kh-gap', label: 'Missing' })}${searchField({ uiKey: 'khDetails', placeholder: 'Search resources' })}${filterButton('Knowledge base', 'khDetails', 'kb', kbOpts)}${clearFilters('khDetails', ['kb'])}</div>`;
    let rows = all.filter(x => (u.gap === 'all' || x.gaps.includes(u.gap)) && (!u.kb || x.d.kb === u.kb) && matchesQ('khDetails', x.d.name, kbName(x.d)));
    rows = applySort(rows, 'khDetails', { name: x => x.d.name.toLowerCase(), updated: x => x.d.updated });
    if (!rows.length) {
      if (u.q || u.kb) return toolbar + noMatches('khDetails', ['kb'], 'resources');
      return toolbar + emptyState({ icon: 'check-circle', tone: 'success', title: `Every resource has ${GAPS[u.gap]?.noun || 'its details'}`, boxed: true, compact: true });
    }
    const page = paginate(rows, 'khDetails', 20);
    const head = selAllCheck('khDetails', page.map(x => x.d.id)) + sortHead('Resource', 'name', 'khDetails') + th('Missing') + sortHead('Updated', 'updated', 'khDetails', 'table__column--hide-sm') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
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
    const actions = needsTopic
      ? btn('Add topic', { size: 'sm', icon: 'tag', menu: 'kh-topic', data: { ids: d.id } }) + iconBtn('sparkles', 'Suggest topics', { size: 'sm', act: 'kh-suggest', data: { id: d.id } }) + iconBtn('pencil', 'Edit details', { size: 'sm', act: 'res-edit', data: { id: d.id } })
      : btn('Edit details', { size: 'sm', icon: 'pencil', act: 'res-edit', data: { id: d.id } });
    return `<tr class="table__row" data-act="res-open" data-id="${esc(d.id)}" tabindex="0">
      ${selCheck('khDetails', d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow kh-min"><div class="cell-title truncate" title="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbName(d))}</div></div></div></td>
      <td class="table__cell kh-gaps"><div class="kh-chips">${gaps}</div>${needsTopic ? suggestionsHtml(d, u.sug[d.id]) : ''}</td>
      <td class="table__cell table__cell--hide-sm muted res-nowrap" title="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${actions}</div></td></tr>`;
  }
  A['kh-gap'] = el => { const u = ui('khDetails'); u.gap = el.dataset.value; u.page = 1; u.sel = {}; refresh(); };

  /** Add a topic to resources (keeps any topics they inherit from their knowledge base). */
  function applyTopic(ids, tid) {
    const docs = ids.map(docById).filter(d => d && X.res.canEditRes(d) && !res(d).topics.includes(tid));
    if (!docs.length) { toast(`Already tagged with “${topicName(tid)}”`, { tone: 'accent' }); return; }
    const prev = docs.map(d => [d, d.topics ? [...d.topics] : undefined]);
    docs.forEach(d => { d.topics = [...res(d).topics, tid]; });
    const u = ui('khDetails'); u.sel = {}; docs.forEach(d => { if (u.sug) delete u.sug[d.id]; });
    audit(docs.length === 1 ? 'Added a topic to a resource' : `Added a topic to ${plural(docs.length, 'resource')}`, `${topicName(tid)} → ${docs.length === 1 ? docs[0].name : plural(docs.length, 'resource')}`);
    refresh();
    toast(docs.length === 1 ? `Added “${topicName(tid)}” to ${docs[0].name}` : `Added “${topicName(tid)}” to ${plural(docs.length, 'resource')}`, { action: { label: 'Undo', run: () => { prev.forEach(([d, t]) => { if (t) d.topics = t; else delete d.topics; }); refresh(); } } });
  }
  MENUS['kh-topic'] = el => {
    const ids = (el.dataset.ids || '').split(',').filter(Boolean); if (!ids.length) return [];
    const tree = topicTree().filter(dm => dm.children.length);
    if (!tree.length) return [{ label: 'No topics yet', disabled: true }];
    return tree.flatMap(dm => [{ section: dm.name }, ...dm.children.map(t => ({ label: t.name, icon: 'tag', run: () => applyTopic(ids, t.id) }))]);
  };

  /** Mock tagging: topics whose words share a stem with the title or the resource type. */
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

  /* ═══════════════ Duplicates ═══════════════ */
  const pairByKey = key => duplicateCandidates().find(p => p.key === key);
  function tabDups(pairs) {
    if (!pairs.length) return emptyState({ icon: 'copy', tone: 'success', title: 'No duplicates found', desc: 'Each resource you look after appears once.', boxed: true });
    const head = th('Resources') + th('Reason') + th('Updated', 'table__column--hide-sm') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    return table({ label: 'Possible duplicates', head, rows: pairs.map(dupRow) });
  }
  const dupSide = (d, tag) => `<div class="kh-dup-doc">${fileIcon(d.type, 'sm')}<div class="kh-min"><div class="cell-title truncate" title="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${tag} · ${esc(kbName(d))}</div></div></div>`;
  function dupRow(p) {
    return `<tr class="table__row" data-act="kh-dup-open" data-key="${esc(p.key)}" tabindex="0">
      <td class="table__cell table__cell--primary"><div class="kh-dup-pair">${dupSide(p.keep, 'Newer')}${dupSide(p.dup, 'Older')}</div></td>
      <td class="table__cell kh-reason">${esc(p.reason)}</td>
      <td class="table__cell table__cell--hide-sm"><div class="kh-dup-dates"><span class="res-nowrap">${rel(p.keep.updated)}</span><span class="res-nowrap muted">${rel(p.dup.updated)}</span></div></td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${btn('Compare', { size: 'sm', icon: 'git-compare', act: 'kh-dup-open', data: { key: p.key } })}${iconBtn('more', 'More actions', { size: 'sm', menu: 'kh-dup', data: { key: p.key } })}</div></td></tr>`;
  }
  MENUS['kh-dup'] = el => {
    const p = pairByKey(el.dataset.key); if (!p) return [];
    return [
      { label: 'Compare', icon: 'git-compare', run: () => openDrawer('kh-dup', { key: p.key }) },
      { label: 'Keep newer, archive the other', icon: 'archive', disabled: !X.res.canEditRes(p.dup), run: () => merge(p.key) },
      { sep: true },
      { label: 'Not duplicates', icon: 'x-circle', run: () => dismiss(p.key) },
    ];
  };
  A['kh-dup-open'] = el => openDrawer('kh-dup', { key: el.dataset.key });

  /** Who points at a resource: collections (names only when the caller can see them), saved lists and recent reads. */
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
      <div class="kh-cmp__block"><h3 class="t-label">Opening text</h3>${excerpt ? `<p class="kh-cmp__text">${esc(excerpt)}</p>` : '<p class="t-sm muted">No text yet. It hasn’t been processed.</p>'}</div>
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
    audit('Marked resources as not duplicates', `${p.keep.name} · ${p.dup.name}`);
    if (S.drawer?.name === 'kh-dup') S.drawer = null;
    refresh();
    toast('Marked as not duplicates', { action: { label: 'Undo', run: () => { D.dupDismissed = (D.dupDismissed || []).filter(k => k !== key); refresh(); } } });
  }

  /* ═══════════════ Topics (taxonomy) ═══════════════ */
  function tabTopics() {
    const u = ui('khTopics', { edit: '', name: '', err: '' }), admin = isAdmin(), n = topicCounts();
    const all = D.topics || [], domains = all.filter(t => !t.parent && !t.archived);
    const live = all.filter(t => t.parent && !t.archived).length;
    const toolbar = `<div class="toolbar"><span class="t-sm muted">${esc(`${plural(live, 'topic')} in ${plural(domains.length, 'domain')}`)}${admin ? '' : ' · Only workspace admins can change topics'}</span>${admin ? `<div class="toolbar__end">${btn('Add domain', { size: 'sm', icon: 'plus', act: 'kh-domain-add', disabled: u.edit === 'new:' })}</div>` : ''}</div>`;
    const blocks = domains.map(dm => domainBlock(dm, all.filter(t => t.parent === dm.id && (admin || !t.archived)), n, u, admin));
    if (u.edit === 'new:') blocks.push(`<section class="kh-domain"><div class="kh-domain__head">${editor(u, 'Domain name')}</div></section>`);
    if (!blocks.length) return toolbar + emptyState({ icon: 'tag', title: 'No topics yet', desc: admin ? 'Add a domain, then the topics people browse by.' : 'A workspace admin can add topics.', actions: admin ? btn('Add domain', { v: 'primary', icon: 'plus', act: 'kh-domain-add' }) : '', boxed: true });
    return toolbar + `<div class="kh-domains">${blocks.join('')}</div>`;
  }
  function editor(u, label) {
    return `<div class="kh-edit"><div class="kh-edit__row">${input({ id: 'kh-topic-name', bind: 'khTopics.name', value: u.name, size: 'sm', onEnter: 'kh-topic-save', invalid: !!u.err, attrs: `maxlength="60" aria-label="${esc(label)}"`, placeholder: label })}${btn('Save', { size: 'sm', v: 'primary', act: 'kh-topic-save' })}${btn('Cancel', { size: 'sm', v: 'ghost', act: 'kh-topic-cancel' })}</div>${u.err ? `<div class="field-error" id="kh-topic-name-err" role="alert">${ic('alert-circle')}<span>${esc(u.err)}</span></div>` : ''}</div>`;
  }
  const countLink = (id, count) => (count ? `<a class="kh-count link" href="#${catalogHref({ filters: { topic: [id] } })}">${plural(count, 'resource')}</a>` : '<span class="kh-count muted">Unused</span>');
  function domainBlock(dm, topics, n, u, admin) {
    const head = u.edit === dm.id ? editor(u, 'Domain name')
      : `<h3 class="kh-domain__name">${esc(dm.name)}</h3>${countLink(dm.id, n.domain(dm.id))}<span class="grow"></span>${admin ? iconBtn('pencil', 'Rename domain', { size: 'sm', act: 'kh-topic-rename', data: { id: dm.id } }) + btn('Add topic', { size: 'sm', v: 'ghost', icon: 'plus', act: 'kh-topic-add', data: { id: dm.id } }) : ''}`;
    const rows = topics.map(t => {
      if (u.edit === t.id) return `<li class="kh-topic">${editor(u, 'Topic name')}</li>`;
      const c = n.topic(t.id);
      if (t.archived) return `<li class="kh-topic is-archived">${ic('archive', 'i-sm muted')}<span class="grow truncate">${esc(t.name)}</span>${chip('Archived', { size: 'sm' })}${btn('Restore', { size: 'sm', v: 'ghost', act: 'kh-topic-restore', data: { id: t.id } })}</li>`;
      const archive = c
        ? `<span class="kh-tipwrap" data-tip="${esc(`Used by ${plural(c, 'resource')}. Move them to another topic first.`)}" tabindex="0">${btn('', { v: 'ghost', size: 'sm', icon: 'archive', muted: true, disabled: true, aria: 'aria-label="Archive topic"' })}</span>`
        : iconBtn('archive', 'Archive topic', { size: 'sm', act: 'kh-topic-archive', data: { id: t.id } });
      const acts = admin ? `<span class="kh-topic__acts">${iconBtn('pencil', 'Rename topic', { size: 'sm', act: 'kh-topic-rename', data: { id: t.id } })}${archive}</span>` : '';
      return `<li class="kh-topic">${ic('tag', 'i-sm muted')}<span class="grow truncate kh-topic__name">${esc(t.name)}</span>${countLink(t.id, c)}${acts}</li>`;
    });
    if (u.edit === 'new:' + dm.id) rows.push(`<li class="kh-topic">${editor(u, 'Topic name')}</li>`);
    return `<section class="kh-domain"><div class="kh-domain__head">${head}</div>${rows.length ? `<ul class="kh-topics">${rows.join('')}</ul>` : '<p class="kh-domain__empty t-sm muted">No topics yet.</p>'}</section>`;
  }
  const focusEditor = () => requestAnimationFrame(() => { const el = $('#kh-topic-name'); if (el) { el.focus(); el.select?.(); } });
  function startEdit(edit, name = '') { if (!isAdmin()) return; Object.assign(ui('khTopics'), { edit, name, err: '' }); refresh(); focusEditor(); }
  A['kh-domain-add'] = () => startEdit('new:');
  A['kh-topic-add'] = el => startEdit('new:' + el.dataset.id);
  A['kh-topic-rename'] = el => { const t = topicById(el.dataset.id); if (t) startEdit(t.id, t.name); };
  A['kh-topic-cancel'] = () => { Object.assign(ui('khTopics'), { edit: '', name: '', err: '' }); refresh(); };
  A['kh-topic-save'] = () => {
    if (!isAdmin()) return;
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
    toast(parent ? `Added “${name}” to ${topicName(parent)}` : `Added the domain “${name}”`, { action: { label: 'Undo', run: () => { if (topicCounts().topic(t.id)) t.archived = true; else D.topics = D.topics.filter(x => x !== t); refresh(); } } });
  };
  A['kh-topic-archive'] = el => {
    const t = topicById(el.dataset.id); if (!t || !isAdmin() || topicCounts().topic(t.id)) return;
    t.archived = true; audit('Archived a topic', t.name); refresh();
    toast(`Archived “${t.name}”`, { action: { label: 'Undo', run: () => { delete t.archived; refresh(); } } });
  };
  A['kh-topic-restore'] = el => {
    const t = topicById(el.dataset.id); if (!t || !isAdmin()) return;
    delete t.archived; audit('Restored a topic', t.name); refresh(); toast(`Restored “${t.name}”`);
  };
  const prevEsc = A['esc-page'];
  A['esc-page'] = () => { if (S.cur?.r.page === 'khealth' && S.ui.khTopics?.edit) { A['kh-topic-cancel'](); return true; } return prevEsc ? prevEsc() : false; };
})();

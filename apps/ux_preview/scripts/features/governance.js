/* Knowledge Studio → Topics → Suggestions and Documents → Quality (bodies rendered by curation.js).
   Suggestions: what the pipeline wasn't sure of and what people taught it — topics the assistant proposes (workspace
   admins decide; others see them read-only), keywords from reviewers' corrections (admins; features/masterdata.js), first
   syncs' topic groups to confirm (published, but filed with low confidence or without a topic; D.classGroups) and processed
   documents without a topic. Quality: re-verification cycles, missing owner or summary, possible duplicates.
   Scope: published documents in the collections the caller can edit (admins: all).
   Exports: X.gov = { counts(), suggestions(), suggestionCount(), queue(part) }, X.khReview().
   Actions: kh-*, cg-*. Menus: kh-review, kh-topic, kh-dup, cg-more (its Move to another topic… opens the topic list).
   Drawer: kh-dup. Models: core/catalog.js, core/lifecycle.js. */
(() => {
  'use strict';

  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const kbName = d => kbById(d.kb)?.name || '';
  const ownerOf = d => res(d).owner || 'the collection owner';
  /** Keep a selection bucket in step with rows that still exist (rows are derived and vanish once fixed). */
  function pruneSel(u, valid) { Object.keys(u.sel || {}).forEach(id => { if (!valid.has(id)) delete u.sel[id]; }); }

  /* ═══════════════ Signals ═══════════════ */
  /** Published documents the caller looks after: editable, non-personal collections. */
  const scope = () => readableResources().filter(d => { const kb = kbById(d.kb); return kb && !kb.personal && canEditKb(kb); });
  const REASONS = {
    expired: { label: 'Verification expired', icon: 'clock', rank: 0 },
    never: { label: 'Never verified', icon: 'circle-dashed', rank: 1 },
  };
  /** { d, reason, note, due } when a document needs its owner to re-verify it, else null.
      A document that changed at its source is a processing state (fix: Process the update in Documents → Issues), not a trust check. */
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
  /** Documents missing some of `kinds` (a topic is Suggestions', an owner or summary Quality's). A document that isn't
      processed hasn't been classified, so it isn't "without a topic" yet. */
  const detailItems = (pool = scope(), kinds = ['owner', 'summary']) => pool.filter(d => !kinds.includes('topic') || d.status === 'ready').map(d => ({ d, gaps: metadataGaps(d).filter(g => kinds.includes(g)) })).filter(x => x.gaps.length);

  X.khReview = () => (can('knowledge.manage') ? reviewItems() : []);

  /* ═══════════════ Topics → Suggestions and Documents → Quality ═══════════════ */
  /** One line above each Quality list: what it finds and what to do about it (counts live on its tabs). */
  const HINT = {
    reverify: 'Verification expired or never happened. Verify what’s still right, or ask the owner to check.',
    details: 'Documents without an owner or a summary are harder to trust. Fill in what’s missing.',
    duplicates: 'Near-identical documents compete in answers. Compare each pair and keep one.',
  };
  /** Items per list: documents in topic groups to confirm, documents without a topic, documents due, documents missing an
      owner or summary, duplicate pairs. */
  function counts() {
    if (!can('knowledge.manage')) return { confirm: 0, notopic: 0, reverify: 0, details: 0, duplicates: 0 };
    const pool = scope();
    return { confirm: openClassGroups().reduce((s, g) => s + g.n, 0), notopic: detailItems(pool, ['topic']).length, reverify: reviewItems(pool).length, details: detailItems(pool).length, duplicates: duplicateCandidates().length };
  }
  /** One Quality list (the page owns the tabs). */
  function queue(id) {
    const pool = scope();
    const body = id === 'reverify' ? tabReview(reviewItems(pool)) : id === 'details' ? tabDetails(detailItems(pool)) : tabDups(duplicateCandidates());
    return `<div class="kh gov"><p class="gov-summary">${esc(HINT[id])}</p>${body}</div>`;
  }
  /** Decisions about the topics themselves (workspace admins): proposed topics and keywords from corrections. */
  const topicDecisions = () => (canManageTaxonomy() ? openProposals().length + correctionSuggestions().length : 0);
  /** What Suggestions counts: topic decisions, topic groups to confirm (one each) and documents without a topic. */
  const suggestionCount = () => (can('knowledge.manage') ? topicDecisions() + openClassGroups().length + detailItems(scope(), ['topic']).length : 0);
  /** Suggestions: biggest decisions first — a topic to create files every document that mentions it, a keyword from
      corrections re-files what reviewers keep moving, a group confirms hundreds at once, then documents one by one.
      Nothing here holds anything back from people. */
  function suggestions() {
    const props = X.md?.proposals?.() || '', learn = canManageTaxonomy() ? X.md?.learn?.() || '' : '';
    const groups = openClassGroups(), loose = detailItems(scope(), ['topic']);
    if (!props && !learn && !groups.length && !loose.length) return emptyState({ icon: 'tag', tone: 'success', title: 'No suggestions', desc: 'Topics the pipeline wasn’t sure of, new topics it proposes and keywords from reviewers’ corrections show up here.', boxed: true });
    const parts = [
      props && section('New topics the assistant proposes', props, { desc: esc('Documents keep mentioning them and no topic covers them. Accepting adds the topic and tags those documents.') }),
      learn && section('Keywords from reviewers’ corrections', learn, { desc: esc('When reviewers move documents to another topic, the words their titles share are keyword candidates. Nothing changes until you add one.') }),
      groups.length && section('Topics to confirm', tabConfirm(groups), { desc: esc('Published by a first sync below the confidence threshold, or without a topic. Confirm in bulk.') }),
      loose.length && section('Without a topic', tabDetails(loose, 'khTopicless'), { desc: esc('Processed, but no topic matched well enough.') }),
    ].filter(Boolean);
    return `<div class="kh gov gov--classify">${parts.join('')}</div>`;
  }

  /* ── Due for re-verification ── */
  function tabReview(all) {
    const u = ui('khReview', { kb: '', reason: '', sel: {} });
    if (!all.length) return emptyState({ icon: 'shield-check', tone: 'success', title: 'Nothing is due for re-verification', desc: 'Every document you look after is verified and current.', boxed: true });
    pruneSel(u, new Set(all.map(x => x.d.id)));
    const kbOpts = [...new Map(all.map(x => [x.d.kb, kbName(x.d)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const reasonOpts = Object.entries(REASONS).filter(([k]) => all.some(x => x.reason === k)).map(([k, r]) => [k, r.label]);
    const tools = needsTools(all.length, 'khReview', ['kb', 'reason'])
      ? `${searchField({ uiKey: 'khReview', placeholder: 'Search documents' })}${kbOpts.length > 1 || u.kb ? filterButton('Collection', 'khReview', 'kb', kbOpts) : ''}${reasonOpts.length > 1 || u.reason ? filterButton('Reason', 'khReview', 'reason', reasonOpts) : ''}${clearFilters('khReview', ['kb', 'reason'])}` : '';
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
    // Like every Library row, the row opens the document drawer; the fix (Verify) sits on the row.
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

  /* ── Missing details: an owner or summary (Upkeep), or a topic (Classification) ── */
  function tabDetails(all, K = 'khDetails') {
    const u = ui(K, { gap: '', kb: '', sel: {} }), sug = ui('khDetails', { sug: {} }).sug ??= {};
    if (!all.length) return emptyState({ icon: 'check-circle', tone: 'success', title: 'Every document is described', desc: 'Documents you look after all have an owner and a summary.', boxed: true });
    pruneSel(u, new Set(all.map(x => x.d.id)));
    const counts = Object.fromEntries(Object.keys(GAPS).map(g => [g, all.filter(x => x.gaps.includes(g)).length]));
    if (u.gap && !GAPS[u.gap]) u.gap = '';
    const gapOpts = Object.keys(GAPS).filter(g => counts[g] || g === u.gap).map(g => [g, `${GAPS[g].label} · ${fmtNum(counts[g])}`]);
    const kbOpts = [...new Map(all.map(x => [x.d.kb, kbName(x.d)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const toolbar = needsTools(all.length, K, ['gap', 'kb']) ? `<div class="toolbar">${searchField({ uiKey: K, placeholder: 'Search documents' })}${gapOpts.length > 1 || u.gap ? filterButton('Missing', K, 'gap', gapOpts) : ''}${kbOpts.length > 1 || u.kb ? filterButton('Collection', K, 'kb', kbOpts) : ''}${clearFilters(K, ['gap', 'kb'])}</div>` : '';
    let rows = all.filter(x => (!u.gap || x.gaps.includes(u.gap)) && (!u.kb || x.d.kb === u.kb) && matchesQ(K, x.d.name, kbName(x.d)));
    rows = applySort(rows, K, { name: x => x.d.name.toLowerCase(), updated: x => x.d.updated });
    if (!rows.length) {
      if (u.q || u.kb) return toolbar + noMatches(K, ['gap', 'kb'], 'documents');
      return toolbar + emptyState({ icon: 'check-circle', tone: 'success', title: `Every document has ${GAPS[u.gap]?.noun || 'its details'}`, boxed: true, compact: true });
    }
    const page = paginate(rows, K, 20), topics = all.some(x => x.gaps.includes('topic'));
    const head = selAllCheck(K, page.map(x => x.d.id)) + sortHead('Document', 'name', K) + th('Missing') + sortHead('Updated', 'updated', K, 'table__column--hide-sm') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    const bulk = topics ? bulkBar(K, btn('Apply topic', { v: 'ghost', size: 'sm', icon: 'tag', iconRight: 'chevron-down', menu: 'kh-topic', data: { ids: selIds(K).join(',') } })) : '';
    return toolbar + table({ label: topics ? 'Without a topic' : 'Missing details', head, rows: page.map(x => detailRow(x, u, K, sug)), foot: pager(rows.length, K, 20) }) + bulk;
  }
  function suggestionsHtml(d, s) {
    if (!s) return '';
    const body = s.length
      ? `<span class="t-xs muted">Suggested</span>${s.map(t => btn(topicName(t), { size: 'sm', v: 'secondary', icon: 'plus', act: 'kh-sug-accept', data: { id: d.id, topic: t } })).join('')}`
      : '<span class="t-xs muted">No suggestions</span>';
    return `<div class="kh-sug">${body}${iconBtn('x', 'Dismiss suggestions', { size: 'sm', act: 'kh-sug-close', data: { id: d.id } })}</div>`;
  }
  function detailRow(x, u, K, sug) {
    const d = x.d, needsTopic = x.gaps.includes('topic');
    const gaps = x.gaps.map(g => chip(GAPS[g].label, { size: 'sm', icon: GAPS[g].icon, tone: g === u.gap ? 'warning' : 'default' })).join('');
    // Add topic (its menu starts with the assistant's suggestions); the pencil covers owner and summary.
    const actions = needsTopic
      ? btn('Add topic', { v: 'secondary', size: 'sm', icon: 'tag', iconRight: 'chevron-down', menu: 'kh-topic', data: { ids: d.id } }) + iconBtn('pencil', 'Edit details', { size: 'sm', act: 'res-edit', data: { id: d.id } })
      : btn('Edit details', { v: 'secondary', size: 'sm', icon: 'pencil', act: 'res-edit', data: { id: d.id } });
    return `<tr class="table__row" data-act="cur-doc" data-id="${esc(d.id)}" tabindex="0">
      ${selCheck(K, d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow kh-min"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbName(d))}</div></div></div></td>
      <td class="table__cell kh-gaps"><div class="kh-chips">${gaps}</div>${needsTopic ? suggestionsHtml(d, sug[d.id]) : ''}</td>
      <td class="table__cell table__cell--hide-sm muted res-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${actions}</div></td></tr>`;
  }

  /** Add a topic to documents (keeps any topics they inherit from their collection). A person filing a document the pipeline
      couldn't is a correction too: it's recorded for the topics (Topics → Suggestions). */
  function applyTopic(ids, tid) {
    const docs = ids.map(docById).filter(d => d && X.res.canEditRes(d) && !res(d).topics.includes(tid));
    if (!docs.length) { toast(`Already tagged with “${topicName(tid)}”`, { tone: 'accent' }); return; }
    const prev = docs.map(d => [d, d.topics ? [...d.topics] : undefined, d.classifiedBy]), corrections = (D.classCorrections || []).length;
    docs.forEach(d => {
      if (topicsByPipeline(d) || !d.topics?.length) recordCorrection(d, d.topics || [], [...res(d).topics, tid]);
      d.topics = [...res(d).topics, tid]; d.classifiedBy = 'person';
    });
    const added = (D.classCorrections || []).length - corrections;
    ['khDetails', 'khTopicless'].forEach(k => { if (S.ui[k]) S.ui[k].sel = {}; });
    docs.forEach(d => { delete ui('khDetails').sug?.[d.id]; });
    audit(docs.length === 1 ? 'Added a topic to a document' : `Added a topic to ${plural(docs.length, 'document')}`, `${topicName(tid)} → ${docs.length === 1 ? docs[0].name : plural(docs.length, 'document')}`);
    refresh();
    toast(docs.length === 1 ? `Added “${topicName(tid)}” to ${docs[0].name}` : `Added “${topicName(tid)}” to ${plural(docs.length, 'document')}`, { action: { label: 'Undo', run: () => {
      prev.forEach(([d, t, by]) => { if (t) d.topics = t; else delete d.topics; if (by) d.classifiedBy = by; else delete d.classifiedBy; });
      if (added > 0) D.classCorrections.splice(0, added);
      refresh();
    } } });
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
  A['kh-suggest'] = el => { const d = docById(el.dataset.id); if (!d) return; (ui('khDetails').sug ??= {})[d.id] = suggestTopics(d); refresh(); };
  A['kh-sug-close'] = el => { delete ui('khDetails').sug?.[el.dataset.id]; refresh(); };
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

  /** Who points at a document: reading lists (names only when the caller can see them), saved lists and recent reads. */
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
      ...r.cols.map(c => `<li>${ic('list', 'i-sm muted')}<a class="link" href="#/knowledge/lists/${esc(c.id)}">${esc(c.name)}</a></li>`),
      r.hidden && `<li>${ic('lock', 'i-sm muted')}<span>${plural(r.hidden, 'private reading list')}</span></li>`,
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

  /** Archive one copy and repoint reading lists, saved lists and recent reads to the one kept. Undo restores everything. */
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

  /* ── Topics to confirm: what a first sync published with a low-confidence topic or none, decided per group ──
     Every decision moves the run's counters (run.backfill.topics), the one source of truth Sources and the run read. */
  const groupById = id => (D.classGroups || []).find(g => g.id === id);
  const confRange = ([a, b] = []) => (a == null ? '' : `${Math.round(a * 100)}–${Math.round(b * 100)}% confidence`);
  const sampleDisclosure = g => disclosure({
    path: `cgSample.${g.id}`, title: 'Sample documents', summary: esc(`${(g.sample || []).length} of ${plural(g.n, 'document')}`),
    body: `<ul class="cg-sample">${(g.sample || []).map(name => `<li class="cg-sample__row">${fileIcon(name.split('.').pop(), 'sm')}<span class="truncate" translate="no" data-tip="${esc(name)}">${esc(name)}</span></li>`).join('')}</ul>`,
  });
  const SEP = '<span aria-hidden="true"> · </span>';
  function topicCard(g) {
    const t = topicById(g.topic), dm = t && topicById(t.parent);
    const meta = [plural(g.n, 'document'), confRange(g.conf), g.keywords?.length && `matched ${g.keywords.map(k => `“${k}”`).join(', ')}`].filter(Boolean);
    return `<section class="cg-card" aria-label="${esc(t?.name || 'Topic')}">
      <div class="cg-card__head">${itemIcon('tag', 'accent')}
        <div class="cg-card__main"><div class="cg-card__title"><span class="medium" translate="no">${esc(t?.name || 'Untitled topic')}</span>${t?.code ? `<span class="md-code md-code--domain" translate="no">${esc(t.code)}</span>` : ''}${dm ? `<span class="t-sm muted" translate="no">${esc(dm.name)}</span>` : ''}</div>
          <div class="cg-card__meta">${meta.map(x => `<span>${esc(x)}</span>`).join(SEP)}</div></div>
        <div class="cg-card__acts">${btn('Confirm topic', { v: 'secondary', size: 'sm', icon: 'check', act: 'cg-confirm', data: { id: g.id } })}${iconBtn('more', 'More actions', { size: 'sm', menu: 'cg-more', data: { id: g.id } })}</div>
      </div>${sampleDisclosure(g)}</section>`;
  }
  /** No topic matched: the assistant's proposals (an admin creates the topic and tags them in one go), then what's left. */
  function noneCard(g) {
    const admin = canManageTaxonomy(), props = g.proposals || [];
    const left = Math.max(0, g.n - props.reduce((s, p) => s + p[1], 0));
    const rows = props.map(([name, n, kws]) => `<li class="cg-prop">${itemIcon('sparkles', '', 'sm')}
      <div class="cg-prop__main"><div class="cg-prop__title"><span class="medium" translate="no">${esc(name)}</span>${SEP}<span class="muted">${esc(`${plural(n, 'document')} mention it`)}</span></div>
        <div class="cg-prop__kw" translate="no">${kws.map(k => chip(k, { size: 'sm' })).join('')}</div></div>
      ${admin ? `<div class="cg-prop__acts">${btn('Create topic & tag', { v: 'secondary', size: 'sm', icon: 'plus', act: 'cg-create', data: { id: g.id, name } })}</div>` : ''}</li>`).join('');
    const rest = left ? `<div class="cg-rest">${ic('info', 'i-sm')}<span>${esc(`${fmtNum(left)} still without a topic`)}</span>${admin
      ? `<span aria-hidden="true">—</span><a class="link" href="#${topicsHref('topics')}">add keywords to your topics</a>`
      : '<span class="muted">A workspace admin can add keywords to the topics.</span>'}</div>` : '';
    return `<section class="cg-card cg-card--none" aria-label="No topic">
      <div class="cg-card__head">${itemIcon('help', 'warning')}<div class="cg-card__main"><div class="cg-card__title"><span class="medium">No topic</span></div>
        <div class="cg-card__meta"><span>${esc(plural(g.n, 'document'))}</span>${SEP}<span>No topic matched</span></div></div></div>
      ${props.length ? `<div class="cg-props"><div class="t-label">The assistant suggests</div><ul class="cg-prop-list">${rows}</ul></div>` : ''}${rest}${sampleDisclosure(g)}</section>`;
  }
  function tabConfirm(groups) {
    if (!groups.length) return emptyState({ icon: 'tag', tone: 'success', title: 'Every topic is confirmed', desc: 'Documents from first syncs are filed where people browse them.', boxed: true });
    return `<div class="cg-list">${groups.filter(g => g.topic).map(topicCard).join('')}${groups.filter(g => !g.topic).map(noneCard).join('')}</div>`;
  }
  /** Confirm the suggested topic, or move the group to another one: the documents count as confidently filed. */
  function settleGroup(id, status, to) {
    const g = groupById(id); if (!g || g.status !== 'open' || !g.topic || !canEditKb(kbById(g.kb))) return;
    const delta = { 'topics.confirm': -g.n, 'topics.confident': g.n }, from = g.topic;
    g.status = status; if (to) g.movedTo = to; g.decided = { by: me().id, at: Date.now() };
    shiftBackfill(g.run, delta);
    audit(status === 'moved' ? 'Moved documents to another topic' : 'Confirmed a topic for documents', `${topicName(to || from)} → ${plural(g.n, 'document')}`);
    refresh();
    toast(status === 'moved' ? `Moved ${plural(g.n, 'document')} to “${topicName(to)}”` : `Confirmed “${topicName(from)}” for ${plural(g.n, 'document')}`, { action: { label: 'Undo', run: () => {
      if (g.status !== status) return;
      g.status = 'open'; delete g.movedTo; delete g.decided; shiftBackfill(g.run, delta, -1); refresh();
      toast(`${plural(g.n, 'document')} are back in Topics to confirm`, { tone: 'accent' });
    } } });
  }
  A['cg-confirm'] = el => settleGroup(el.dataset.id, 'confirmed');
  /** Every other topic, the suggested topic's domain first (like Add topic). */
  function moveItems(g) {
    const parent = topicById(g.topic)?.parent;
    const tree = topicTree().map(dm => ({ ...dm, children: dm.children.filter(c => c.id !== g.topic) })).filter(dm => dm.children.length)
      .sort((a, b) => (b.id === parent) - (a.id === parent));
    return tree.flatMap(dm => [{ section: dm.name }, ...dm.children.map(c => ({ label: c.name, icon: 'tag', run: () => settleGroup(g.id, 'moved', c.id) }))]);
  }
  MENUS['cg-more'] = el => {
    const g = groupById(el.dataset.id); if (!g || g.status !== 'open' || !g.topic) return [];
    return [
      { label: 'Move to another topic…', icon: 'folder', run: () => openMenu(el, moveItems(g), 'cg-move:' + g.id) },
      ...(canManageTaxonomy() && A['md-edit'] ? [{ label: 'Edit topic keywords…', icon: 'pencil', run: () => A['md-edit']({ dataset: { id: g.topic } }) }] : []),
    ];
  };
  /** The next free code in a domain (OPS-05 after OPS-04), as the taxonomy numbers its topics. */
  function nextTopicCode(dm) {
    if (!dm.code) return '';
    const nums = (D.topics || []).filter(t => t.parent === dm.id).map(t => +String(t.code || '').split('-')[1] || 0);
    return `${dm.code}-${String(Math.max(0, ...nums) + 1).padStart(2, '0')}`;
  }
  /** Create the proposed topic (with its keywords, so the next sync files these itself) and tag the documents that mention it. */
  A['cg-create'] = el => {
    const g = groupById(el.dataset.id), i = (g?.proposals || []).findIndex(p => p[0] === el.dataset.name);
    if (!g || g.status !== 'open' || i < 0 || !canManageTaxonomy()) return;
    const p = g.proposals[i], [name, n, keywords] = p;
    // Banking Operations is where the archive's documents belong; any domain when a workspace has no such domain.
    const dm = topicById('d-ops') || topicTree()[0]; if (!dm) return;
    const same = (D.topics || []).find(t => t.parent && !t.archived && fold(t.name) === fold(name));
    const t = same || { id: uid('t'), name, parent: dm.id, code: nextTopicCode(dm), keywords: [...keywords] };
    if (!same) (D.topics ??= []).push(t);
    const delta = { 'topics.none': -n, 'topics.confident': n };
    g.proposals.splice(i, 1); g.n -= n; shiftBackfill(g.run, delta);
    audit(same ? 'Tagged documents with a topic' : 'Created a topic and tagged documents', `${t.name}${t.code ? ` (${t.code})` : ''} → ${plural(n, 'document')}`);
    refresh();
    let undone = false;
    toast(same ? `Tagged ${plural(n, 'document')} with “${t.name}”` : `Created “${t.name}” in ${topicName(t.parent)} · ${plural(n, 'document')} tagged`, { action: { label: 'Undo', run: () => {
      if (undone) return; undone = true;
      if (!same) D.topics = D.topics.filter(x => x !== t);
      g.proposals.splice(Math.min(i, g.proposals.length), 0, p); g.n += n; shiftBackfill(g.run, delta, -1); refresh();
      toast(same ? `${plural(n, 'document')} are back in Topics to confirm` : `“${t.name}” removed`, { tone: 'accent' });
    } } });
  };
  X.gov = { counts, suggestions, suggestionCount, queue };
})();

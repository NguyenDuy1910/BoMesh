/* Knowledge Studio → Documents → All's Quality filter (bodies rendered by curation.js): re-verification cycles, missing
   details (no classification, owner or summary) and possible duplicates, each row with its fix. What the assistant left
   for people to classify is Classification › Suggestions (features/masterdata.js).
   Scope: published documents in the collections the caller can edit (admins: all).
   Exports: X.gov = { counts(), queue(part) }, X.khReview().
   Actions: kh-*. Menus: kh-review, kh-concept (Suggest concepts, then a concept per scheme), kh-dup. Drawer: kh-dup.
   Models: core/catalog.js, core/lifecycle.js. */
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
      A document that changed at its source is a processing state (fix: Process the update in Documents → Processing), not a trust check. */
  function reviewItem(d) {
    if (d.status === 'outdated') return null;
    const t = trustOf(d);
    if (t.state === 'review') return { d, reason: 'expired', note: t.note, due: t.due || null };
    if (t.state === 'unverified' && d.status === 'ready' && kbById(d.kb)?.unit) return { d, reason: 'never', note: t.note, due: null };
    return null;
  }
  const reviewItems = (pool = scope()) => pool.map(reviewItem).filter(Boolean)
    .sort((a, b) => REASONS[a.reason].rank - REASONS[b.reason].rank || (a.due || 9e15) - (b.due || 9e15) || a.d.name.localeCompare(b.d.name));

  const GAPS = { concept: { label: 'Missing classification', icon: 'tag', noun: 'its classification' }, owner: { label: 'No owner', icon: 'user', noun: 'an owner' }, summary: { label: 'No summary', icon: 'note', noun: 'a summary' } };
  /** Documents missing a classification, an owner or a summary. A document that isn't processed hasn't been classified,
      so it isn't missing a classification yet. */
  const detailItems = (pool = scope()) => pool.map(d => ({ d, gaps: metadataGaps(d).filter(g => GAPS[g] && (g !== 'concept' || d.status === 'ready')) })).filter(x => x.gaps.length);

  X.khReview = () => (can('knowledge.manage') ? reviewItems() : []);

  /* ═══════════════ Documents → All's Quality filter ═══════════════ */
  /** One line above each Quality list: what it finds and what to do about it (counts live on its pills). */
  const HINT = {
    reverify: 'Verification expired or never happened. Verify what’s still right, or ask the owner to check.',
    details: 'Documents without a classification, an owner or a summary are harder to find and trust. Fill in what’s missing.',
    duplicates: 'Near-identical documents compete in answers. Compare each pair and keep one.',
  };
  /** Items per list: documents due, documents missing details, duplicate pairs. */
  function counts() {
    if (!can('knowledge.manage')) return { reverify: 0, details: 0, duplicates: 0 };
    const pool = scope();
    return { reverify: reviewItems(pool).length, details: detailItems(pool).length, duplicates: duplicateCandidates().length };
  }
  /** One Quality list (All's Quality filter owns the pills). */
  function queue(id) {
    const pool = scope();
    const body = id === 'reverify' ? tabReview(reviewItems(pool)) : id === 'details' ? tabDetails(detailItems(pool)) : tabDups(duplicateCandidates());
    return `<div class="kh gov"><p class="gov-summary">${esc(HINT[id])}</p>${body}</div>`;
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
    let rows = all.filter(x => (!u.kb || x.d.kb === u.kb) && (!u.reason || x.reason === u.reason) && matchesQ('khReview', x.d.name));
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

  /* ── Missing details: a classification, an owner or a summary ── */
  const K = 'khDetails';
  function tabDetails(all) {
    const u = ui(K, { gap: '', kb: '', sel: {} });
    if (!all.length) return emptyState({ icon: 'check-circle', tone: 'success', title: 'Every document is described', desc: 'Documents you look after all have a classification, an owner and a summary.', boxed: true });
    pruneSel(u, new Set(all.map(x => x.d.id)));
    const counts = Object.fromEntries(Object.keys(GAPS).map(g => [g, all.filter(x => x.gaps.includes(g)).length]));
    if (u.gap && !GAPS[u.gap]) u.gap = '';
    const gapOpts = Object.keys(GAPS).filter(g => counts[g] || g === u.gap).map(g => [g, `${GAPS[g].label} · ${fmtNum(counts[g])}`]);
    const kbOpts = [...new Map(all.map(x => [x.d.kb, kbName(x.d)])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const toolbar = needsTools(all.length, K, ['gap', 'kb']) ? `<div class="toolbar">${searchField({ uiKey: K, placeholder: 'Search documents' })}${gapOpts.length > 1 || u.gap ? filterButton('Missing', K, 'gap', gapOpts) : ''}${kbOpts.length > 1 || u.kb ? filterButton('Collection', K, 'kb', kbOpts) : ''}${clearFilters(K, ['gap', 'kb'])}</div>` : '';
    let rows = all.filter(x => (!u.gap || x.gaps.includes(u.gap)) && (!u.kb || x.d.kb === u.kb) && matchesQ(K, x.d.name));
    rows = applySort(rows, K, { name: x => x.d.name.toLowerCase(), updated: x => x.d.updated });
    if (!rows.length) {
      if (u.q || u.kb) return toolbar + noMatches(K, ['gap', 'kb'], 'documents');
      return toolbar + emptyState({ icon: 'check-circle', tone: 'success', title: `Every document has ${GAPS[u.gap]?.noun || 'its details'}`, boxed: true, compact: true });
    }
    const page = paginate(rows, K, 20);
    const head = selAllCheck(K, page.map(x => x.d.id)) + sortHead('Document', 'name', K) + th('Missing') + sortHead('Updated', 'updated', K, 'table__column--hide-sm') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    // Selected documents without a classification: the assistant classifies them again (Suggest concepts), or a person
    // files them under one concept (Add concept).
    const sel = selIds(K), bulk = all.some(x => x.gaps.includes('concept')) ? bulkBar(K, btn('Add concept', { v: 'ghost', size: 'sm', icon: 'tag', iconRight: 'chevron-down', menu: 'kh-concept', data: { ids: sel.join(','), bulk: '1' } }) + btn('Suggest concepts', { v: 'ghost', size: 'sm', icon: 'sparkles', act: 'kh-suggest', data: { ids: sel.join(',') } })) : '';
    return toolbar + table({ label: 'Missing details', head, rows: page.map(x => detailRow(x, u)), foot: pager(rows.length, K, 20) }) + bulk;
  }
  function detailRow(x, u) {
    const d = x.d, needsConcept = x.gaps.includes('concept');
    const gaps = x.gaps.map(g => chip(GAPS[g].label, { size: 'sm', icon: GAPS[g].icon, tone: g === u.gap ? 'warning' : 'default' })).join('');
    // Add concept (its menu starts with Suggest concepts); the pencil covers owner and summary.
    const actions = needsConcept
      ? btn('Add concept', { v: 'secondary', size: 'sm', icon: 'tag', iconRight: 'chevron-down', menu: 'kh-concept', data: { ids: d.id } }) + iconBtn('pencil', 'Edit details', { size: 'sm', act: 'res-edit', data: { id: d.id } })
      : btn('Edit details', { v: 'secondary', size: 'sm', icon: 'pencil', act: 'res-edit', data: { id: d.id } });
    return `<tr class="table__row" data-act="cur-doc" data-id="${esc(d.id)}" tabindex="0">
      ${selCheck(K, d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow kh-min"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbName(d))}</div></div></div></td>
      <td class="table__cell kh-gaps"><div class="kh-chips">${gaps}</div></td>
      <td class="table__cell table__cell--hide-sm muted res-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${actions}</div></td></tr>`;
  }

  const editable = ids => ids.map(docById).filter(d => d && X.res.canEditRes(d));
  /** Schemes without an accepted concept on any of `docs` (each one's missing classification). */
  const missingSchemes = docs => classSchemes().filter(s => docs.some(d => !schemeConceptIds(d, s.id, { suggested: false }).length));
  /** Run a classification change on documents with one Undo (their assignments and what corrections taught). */
  function withUndo(docs, change) {
    const snaps = docs.map(d => [d, snapDoc(d)]), learned = X.learnSnap?.();
    change();
    if (S.ui[K]) S.ui[K].sel = {};
    return () => { snaps.forEach(([d, s]) => restoreDoc(d, s)); learned?.(); refresh(); };
  }
  /** File documents under a concept, in its scheme (a scheme that takes one concept swaps it; others keep theirs). A
      person filing what the pipeline chose or couldn't is a correction too: repeated ones become label proposals in
      Classification › Suggestions. */
  function applyConcept(ids, cid) {
    const c = conceptById(cid), s = c && schemeById(c.scheme); if (!s) return;
    const docs = editable(ids).filter(d => !resConcepts(d).includes(cid));
    if (!docs.length) { toast(`Already filed under “${conceptName(cid)}”`, { tone: 'accent' }); return; }
    const undo = withUndo(docs, () => docs.forEach(d => {
      const before = resConcepts(d), keep = schemeConceptIds(d, s.id, { suggested: false }), pipeline = classifiedByPipeline(d) || !before.length;
      setDocConcepts(d, [...(s.maxLabels ? keep.slice(Math.max(0, keep.length - s.maxLabels + 1)) : keep), cid], { schemes: [s.id] });
      if (pipeline) recordCorrection(d, before, resConcepts(d));
      d.classifiedBy = 'person';
    }));
    audit(docs.length === 1 ? 'Added a concept to a document' : `Added a concept to ${plural(docs.length, 'document')}`, `${conceptName(cid)} → ${docs.length === 1 ? docs[0].name : plural(docs.length, 'document')}`);
    refresh();
    toast(docs.length === 1 ? `Filed “${docs[0].name}” under “${conceptName(cid)}”` : `Filed ${plural(docs.length, 'document')} under “${conceptName(cid)}”`, { action: { label: 'Undo', run: undo } });
  }
  /** Suggest concepts: the assistant classifies the documents again (within their processing run's concepts, if it had
      some); people's concepts stay. What it isn't sure of awaits review in Classification › Suggestions; a document it
      can't file at all is left for Edit details. */
  function suggestConcepts(ids) {
    const docs = editable(ids).filter(d => d.status === 'ready'); if (!docs.length) return;
    const undo = withUndo(docs, () => docs.forEach(d => { const ctx = d.classCtx; autoClassify(d, ctx || { concepts: [], note: '' }); if (!ctx) delete d.classCtx; }));
    const left = docs.filter(d => metadataGaps(d).includes('concept')), waiting = docs.filter(d => suggestedConcepts(d).length);
    audit(docs.length === 1 ? 'Suggested concepts for a document' : `Suggested concepts for ${plural(docs.length, 'document')}`, docs.length === 1 ? docs[0].name : plural(docs.length, 'document'));
    refresh();
    const one = docs.length === 1 ? docs[0] : null;
    if (one && left.length && !waiting.length) { toast(`No concept fits “${one.name}” with confidence. Add one in Edit details.`, { tone: 'accent', action: { label: 'Edit details', run: () => A['res-edit']({ dataset: { id: one.id } }) } }); return; }
    const msg = [`Classified ${plural(docs.length, 'document')}`, waiting.length && `${fmtNum(waiting.length)} awaiting review in Classification → Suggestions`, left.length && `${fmtNum(left.length)} still missing a classification`].filter(Boolean).join(' · ');
    toast(msg, { action: { label: 'Undo', run: undo } });
  }
  A['kh-suggest'] = el => suggestConcepts((el.dataset.ids || '').split(',').filter(Boolean));
  /** Add concept: Suggest concepts first, then the concepts of each scheme the documents miss, by scheme. */
  MENUS['kh-concept'] = el => {
    const ids = (el.dataset.ids || '').split(',').filter(Boolean), docs = editable(ids); if (!docs.length) return [];
    const schemes = missingSchemes(docs).filter(s => assignableConcepts(s.id).length);
    const suggest = el.dataset.bulk ? [] : [{ label: 'Suggest concepts', icon: 'sparkles', run: () => suggestConcepts(ids) }];
    if (!schemes.length) return suggest.length ? suggest : [{ label: 'No concepts yet', disabled: true }];
    return [...suggest, ...(suggest.length ? [{ sep: true }] : []), ...schemes.flatMap(s => [{ section: s.name }, ...assignableConcepts(s.id).map(c => ({ label: conceptPathText(c.id), icon: conceptLook(c.id).icon, run: () => applyConcept(ids, c.id) }))])];
  };

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

  /** What points at a document and moves to the copy that's kept: spaces' materials, project documents, saved lists and recent reads. */
  function refsOf(d) {
    return {
      spaces: (d.contexts || []).map(spaceById).filter(Boolean),
      projects: (D.projects || []).filter(p => (p.docs || []).includes(d.id)).length,
      saved: Object.values(D.saved || {}).filter(l => l.includes(d.id)).length,
      recent: Object.values(D.recent || {}).filter(l => l.some(x => x.doc === d.id)).length,
    };
  }
  function cmpCol(d, keep, newer, key) {
    const text = X.docText ? X.docText(d) : '';
    const excerpt = text.length > 420 ? text.slice(0, 420).replace(/\s+\S*$/, '') + '…' : text;
    const r = refsOf(d);
    const refs = [
      ...r.spaces.map(s => `<li>${ic('layers', 'i-sm muted')}<a class="link" href="#/space/${esc(s.id)}">${esc(s.name)}</a></li>`),
      r.projects && `<li>${ic('folder', 'i-sm muted')}<span>In ${plural(r.projects, 'project')}</span></li>`,
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

  /** Merge: every reference to the archived copy (spaces' materials, project documents, saved lists, recent reads) moves to the one
      kept, without duplicates, and the copy is archived. Restoring the copy brings it back on its own: the references stay put. */
  function merge(key, swap = false) {
    const p = pairByKey(key); if (!p) return;
    const { keep, dup } = sides(p, swap); if (!X.res.canEditRes(dup)) return;
    const r = refsOf(dup), n = r.spaces.length + r.projects + r.saved + r.recent;
    const swapId = id => (id === dup.id ? keep.id : id);
    if (dup.contexts?.length) keep.contexts = [...new Set([...(keep.contexts || []), ...dup.contexts])];
    delete dup.contexts;
    (D.projects || []).forEach(pj => { if ((pj.docs || []).includes(dup.id)) pj.docs = [...new Set(pj.docs.map(swapId))]; });
    Object.entries(D.saved || {}).forEach(([u, l]) => { if (l.includes(dup.id)) D.saved[u] = [...new Set(l.map(swapId))]; });
    Object.entries(D.recent || {}).forEach(([u, l]) => {
      if (!l.some(x => x.doc === dup.id)) return;
      const seen = new Set(); D.recent[u] = l.map(x => ({ ...x, doc: swapId(x.doc) })).filter(x => !seen.has(x.doc) && seen.add(x.doc));
    });
    dup.archived = true;
    audit('Merged a duplicate', `${dup.name} → ${keep.name}`);
    if (S.drawer?.name === 'kh-dup') S.drawer = null;
    refresh();
    toast(`Archived “${dup.name}”${n ? ` · ${plural(n, 'reference')} now ${n === 1 ? 'points' : 'point'} to the copy you kept` : ''}`, {
      action: {
        label: 'Restore', run: () => {
          delete dup.archived;
          audit('Restored a merged duplicate', dup.name); refresh(); toast(`Restored “${dup.name}”. References stay on the copy you kept.`, { tone: 'accent' });
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

  X.gov = { counts, queue };
})();

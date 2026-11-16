/* Research work kinds — registered into WORK_KINDS (core/workspace.js) and
   rendered by the generic Work shell (features/work.js).
   review: Evidence review (sources × criteria table, every cell cited; evidence in a side panel).
   draft:  a grounded document draft with an editor, sources rail, versions and a review loop (draft → in review → approved | changes requested).
   Prefixes: rv- (review), dr- (draft). Inbox: X.workNotices(). */
(() => {
  'use strict';

  /* ═══════════════ Shared helpers ═══════════════ */
  const W = id => (D.works || []).find(w => w.id === id);
  const spOf = s => (typeof s === 'string' ? spaceById(s) : s) || null;
  const idsOf = list => (list || []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean);
  const canEditWork = w => X.work.canEdit(w);
  const saveWork = w => X.work.save(w);
  const lc = s => String(s || '').replace(/\.$/, '').replace(/^([A-Z])(?![A-Z0-9])/, m => m.toLowerCase());
  const docHref = c => `/doc/${c.doc}?q=${encodeURIComponent(c.quote || '')}${c.page ? '&page=' + c.page : ''}`;
  const audit = (action, target) => X.work.audit(action, target);
  const citeBtn = (c, n) => X.work.cite(c, n);
  function evidenceBody(d, c) {
    if (!d) return emptyState({ icon: 'file', title: 'Document not available', compact: true });
    const kb = kbById(d.kb);
    return `<div class="row gap-12">${fileIcon(d.type, 'lg')}<div class="grow" style="min-width:0"><a class="rv-ev__name truncate" href="#${docHref(c)}">${esc(d.name)}</a><div class="t-xs muted truncate">${esc(kb?.name || '')} · Page ${c.page}</div></div>${d.status !== 'ready' ? status('doc', d.status) : ''}</div>
      <blockquote class="rv-ev__quote"><mark class="evidence is-focus">${esc(c.quote)}</mark></blockquote>`;
  }

  /** Source metadata; names like "Nguyen et al. 2024 — Title.pdf" are parsed into authors and year. */
  function paper(id) {
    const d = docById(id);
    if (!d) return { id, title: 'Document not available', authors: '', year: '', short: 'Unavailable', doc: null };
    const base = d.name.replace(/\.[^.]+$/, '');
    const m = base.match(/^(.+?)\s+((?:19|20)\d\d)\s+[—–-]\s+(.+)$/);
    const authors = m ? m[1] : d.addedBy || '', year = m ? m[2] : '';
    return { id, title: m ? m[3] : base, authors, year, short: m ? `${authors} ${year}` : base, doc: d, parsed: !!m };
  }
  const paperDocs = sp => X.work.docsForSpace(sp).filter(d => d && !d.archived);

  /* ═══════════════ Evidence bank (canned "retrieval" for curated libraries) ═══════════════
     BANK[doc][key] = [finding, page, quote]. Keys come from criterion labels (critKey).
     Finx: vendor evaluations for the event streaming platform (w-review-stream). */
  const EVAL_METHOD = [2, 'We replayed 40 payment event types from production traffic at three times the 2026 Tết peak, with the same producers and consumers on every platform.'];
  const BANK = {
    'fx-eng-eval-kafka': {
      perf: ['180k msg/s at p99 42 ms.', 3, 'In our load test Confluent Cloud sustained 180,000 messages per second at a p99 latency of 42 ms.'],
      eos: ['Yes — idempotent producers and transactions.', 4, 'Idempotent producers and transactions give exactly-once delivery between Kafka topics out of the box.'],
      ops: ['Low: vendor runs brokers, upgrades and scaling.', 5, 'Brokers, upgrades and scaling are run by the vendor; our team only manages topics, ACLs and connectors.'],
      res: ['No — nearest region is Singapore.', 6, 'The nearest Confluent Cloud region is Singapore; no region is available in Vietnam.'],
      cost: ['≈ USD 1.26M over 3 years.', 7, 'The estimated three-year cost is USD 1.26 million, including support and private networking.'],
      method: ['Load test replaying 40 payment event types.', ...EVAL_METHOD],
      result: ['Best throughput and least ops work; residency open.', 8, 'Strongest on throughput and operations effort; data residency needs a cross-border transfer assessment before payment events can leave Vietnam.'],
      limit: ['Data would leave Vietnam (Decree 13 assessment).', 6, 'Payment events contain customer account numbers, so hosting them outside Vietnam needs a cross-border transfer assessment under Decree 13/2023.'],
    },
    'fx-eng-eval-pulsar': {
      perf: ['150k msg/s at p99 55 ms.', 3, 'On six bare-metal brokers in our Ho Chi Minh City data center, Pulsar sustained 150,000 messages per second at a p99 latency of 55 ms.'],
      eos: ['Partly — transactions only in Java clients.', 4, 'Exactly-once processing requires Pulsar transactions, which our client libraries support only for Java.'],
      ops: ['High: about 2.5 FTE (BookKeeper, ZooKeeper).', 5, 'Running Pulsar needs BookKeeper and ZooKeeper clusters; we estimate 2.5 full-time engineers to operate it.'],
      res: ['Yes — Finx data centers in Vietnam.', 6, 'All data stays in Finx\'s own data centers in Hanoi and Ho Chi Minh City.'],
      cost: ['≈ USD 0.94M over 3 years incl. staff.', 7, 'Hardware, monitoring licences and staff time come to an estimated USD 0.94 million over three years.'],
      method: ['Load test replaying 40 payment event types.', ...EVAL_METHOD],
      result: ['Cheapest, keeps data in Vietnam; weakest exactly-once.', 8, 'Cheapest and the only option that keeps data in Vietnam, but our Go services would not get exactly-once processing and operations effort is the highest.'],
      limit: ['Go services lack exactly-once; highest ops effort.', 4, 'Exactly-once processing requires Pulsar transactions, which our client libraries support only for Java.'],
    },
    'fx-eng-eval-msk': {
      perf: ['160k msg/s at p99 48 ms.', 3, 'A six-broker MSK cluster sustained 160,000 messages per second at a p99 latency of 48 ms.'],
      eos: ['Yes — standard Kafka transactions.', 4, 'MSK runs open-source Apache Kafka, so idempotent producers and transactions work as in any Kafka cluster.'],
      ops: ['Medium: AWS patches; we rebalance and upgrade.', 5, 'AWS patches brokers, but partition rebalancing, upgrades and capacity planning remain our responsibility.'],
      res: ['No — nearest regions Singapore and Jakarta.', 6, 'AWS has no region in Vietnam; the nearest are Singapore and Jakarta.'],
      cost: ['≈ USD 1.02M over 3 years (reserved).', 7, 'The estimated three-year cost is USD 1.02 million with reserved brokers.'],
      method: ['Load test replaying 40 payment event types.', ...EVAL_METHOD],
      result: ['Kafka semantics at lower cost; more ops work.', 8, 'A middle option: standard Kafka semantics at a lower cost than Confluent, with more operations work and the same residency question.'],
      limit: ['Data would leave Vietnam (Decree 13 assessment).', 6, 'Payment events contain customer account numbers, so hosting them outside Vietnam needs a cross-border transfer assessment under Decree 13/2023.'],
    },
    'fx-eng-adr027': {
      method: ['Ledger changes only through payment events.', 1, 'Ledger balances are updated only by consuming events from the payments topic, never by direct writes.'],
      eos: ['Requires exactly-once or idempotent consumption.', 2, 'Ledger consumers must process each event exactly once, so the streaming platform must support exactly-once delivery or idempotent consumption.'],
    },
  };
  /* Extra passages the drafts cite (not matrix criteria). */
  const PASSAGES = {
    'fx-eng-adr031': [[1, 'Every POST to a payment API must carry an Idempotency-Key header.'], [2, 'The gateway stores the first response for 24 hours and replays it for any retry with the same key.']],
  };
  const CRIT_KEYS = [
    [/residency|region|sovereign|locali[sz]ation/i, 'res'],
    [/throughput|latency|peak|scal(e|ability)/i, 'perf'],
    [/exactly.?once|semantic|guarantee|delivery/i, 'eos'],
    [/operat|effort|maintenance|support burden/i, 'ops'],
    [/method|approach|model|technique|architecture|algorithm|design/i, 'method'],
    [/data|sample|corpus/i, 'data'],
    [/result|accuracy|performance|finding|outcome|effect/i, 'result'],
    [/limit|weakness|shortcoming|caveat|threat|risk/i, 'limit'],
    [/hardware|device|edge|deploy|platform|compute/i, 'hardware'],
    [/field|real.?world|in.?situ|condition|robust|environment/i, 'field'],
    [/cost|price|budget|afford|tco/i, 'cost'],
    [/energy|power|battery/i, 'energy'],
  ];
  const critKey = label => (CRIT_KEYS.find(([re]) => re.test(label)) || [])[1] || 'other';
  /** Plausible evidence for documents outside the lab bank (e.g. a Northwind project library). */
  const GENERIC = {
    method: [['Comparative evaluation against two baselines.', 'We compare the proposed approach against two established baselines under the same conditions.'], ['Case study with a three-month pilot.', 'The approach was piloted for three months with a single team before wider rollout.'], ['Mixed methods: interviews and usage logs.', 'We combine twelve semi-structured interviews with six months of usage logs.']],
    data: [['Internal records from one organisation.', 'All data come from internal records of a single organisation over two years.'], ['Survey of 214 respondents.', 'The survey received 214 complete responses (response rate 38%).'], ['Public benchmark plus a small private set.', 'We evaluate on a public benchmark and a private set of 600 examples.']],
    result: [['Clear improvement over the baseline (+12%).', 'The proposed approach improves the primary metric by 12% over the strongest baseline.'], ['Mixed results; gains depend on context.', 'Gains were significant in two of the four settings and negligible in the others.'], ['Faster turnaround; quality unchanged.', 'Median turnaround fell from 5 days to 2 days with no measurable change in quality.']],
    limit: [['Single site; results may not generalise.', 'Because the study covers a single site, results may not generalise to other contexts.'], ['Short observation period.', 'The observation period was short, so long-term effects are unknown.'], ['Self-reported measures.', 'Most measures are self-reported and may be subject to bias.']],
  };
  const C = (doc, page, quote) => ({ doc, page, quote });
  function quoteAt(doc, page) {
    const b = BANK[doc]; const hit = b && Object.values(b).find(e => e[1] === page);
    if (hit) return C(doc, page, hit[2]);
    const p = (PASSAGES[doc] || []).find(e => e[0] === page);
    return p ? C(doc, page, p[1]) : C(doc, page, '');
  }
  /** The finding for one source × criterion: { text, cite } or { text, cite: null, none: true }. */
  function finding(docId, label) {
    const k = critKey(label), b = BANK[docId], none = { text: 'Not reported', cite: null, none: true };
    if (b) { const e = b[k]; return e ? { text: e[0], cite: C(docId, e[1], e[2]) } : none; }
    const g = GENERIC[k]; const d = docById(docId); if (!g || !d) return none;
    const h = hashOf(docId + k), [text, quote] = g[h % g.length];
    return { text, cite: C(docId, 2 + (h % Math.max(1, (d.pages || 6) - 2)), quote) };
  }
  /** "Replace finding": re-read the cited passage and restate it. */
  function restate(cell, label, docId) {
    const q = cell.cite?.quote;
    if (!q) { const f = finding(docId, label); return f.none ? { ...f, text: 'Not reported in this source.' } : f; }
    let s = q.replace(/^(we|our|in this (paper|study),?|this (paper|study))\s+/i, '').replace(/\s+/g, ' ');
    s = s.split(/;|, (?:so|which|whose|and|but|allowing|freezing|while)\b/)[0].replace(/\.$/, '');
    if (s.length > 80) { const cut = Math.max(...[', ', ' on ', ' in ', ' for ', ' from ', ' at ', ' across ', ' with '].map(b => s.lastIndexOf(b, 80))); if (cut > 30) s = s.slice(0, cut); }
    s = s.charAt(0).toUpperCase() + s.slice(1) + '.';
    if (s === cell.text) s = finding(docId, label).text;
    return { text: s, cite: cell.cite };
  }

  /* ═══════════════ Evidence review (sources × criteria) ═══════════════ */
  /* Defaults follow the space: research groups compare papers; teams and projects compare options. */
  const RESEARCH_CRITERIA = ['Method', 'Dataset', 'Result', 'Limitations'];
  const OPTION_CRITERIA = ['Cost', 'Operations effort', 'Risks'];
  const MORE_CRITERIA = ['Data residency', 'Security', 'Vendor support'];
  const criteriaFor = sp => (sp?.type === 'research' || sp?.type === 'course' ? RESEARCH_CRITERIA : OPTION_CRITERIA);
  const suggestionsFor = sp => [...new Set([...(sp?.type === 'research' || sp?.type === 'course' ? OPTION_CRITERIA : RESEARCH_CRITERIA), ...MORE_CRITERIA])];
  /** A comparison stays readable up to this many rows; the New work flow says so before generating. */
  const MAX_SOURCES = 8;
  const DEFAULT_IDS = { Method: 'method', Dataset: 'data', Result: 'result', Limitations: 'limit' };
  const critId = label => DEFAULT_IDS[label] || uid('c');
  const rvu = w => ui('rv:' + w.id, { pendingRows: {}, pendingCols: {}, synth: false, fresh: {}, sel: null, busy: false });

  function rvOptions(f) {
    const o = (f.opts ??= {}), sp = spaceById(f.space), type = sp?.type || '';
    // Until someone picks criteria themselves, they follow the chosen space.
    if (!o.critTouched && o.critFor !== type) { o.criteria = [...criteriaFor(sp)]; o.critFor = type; }
    const all = [...new Set([...criteriaFor(sp), ...suggestionsFor(sp), ...o.criteria])];
    const chips = all.map(l => `<button type="button" class="rv-chip" aria-pressed="${o.criteria.includes(l)}" data-act="rv-opt-crit" data-label="${esc(l)}">${o.criteria.includes(l) ? ic('check', 'i-sm') : ic('plus', 'i-sm')}${esc(l)}</button>`).join('');
    return field({ id: 'rv-opt-new', label: 'Compare sources on', desc: 'Each criterion becomes a column. Every cell cites the passage it comes from.', control: `<div class="rv-chips" role="group" aria-label="Criteria">${chips}</div><div class="row gap-8 mt-8">${input({ id: 'rv-opt-new', bind: 'workNew.opts.critNew', value: o.critNew || '', placeholder: 'Add your own, e.g. Time to migrate', onEnter: 'rv-opt-crit-add', size: 'sm' })}${btn('Add', { size: 'sm', act: 'rv-opt-crit-add' })}</div>` });
  }
  A['rv-opt-crit'] = el => { const o = ui('workNew').opts; const l = el.dataset.label; o.critTouched = true; o.criteria = o.criteria.includes(l) ? o.criteria.filter(x => x !== l) : [...o.criteria, l]; refresh(); };
  A['rv-opt-crit-add'] = () => {
    const o = ui('workNew').opts; const l = String(o.critNew || $('#rv-opt-new')?.value || '').trim(); if (!l) return;
    if (!o.criteria.some(x => x.toLowerCase() === l.toLowerCase())) o.criteria.push(l);
    o.critTouched = true; o.critNew = ''; refresh(); $('#rv-opt-new')?.focus();
  };

  function rvGenerate(ctx) {
    const sp = spOf(ctx.space), o = ctx.options || {};
    // Every selected source becomes a row: the New work flow already kept the pick within MAX_SOURCES.
    let papers = idsOf(ctx.sources).filter(id => docById(id));
    if (!papers.length) papers = paperDocs(sp).filter(d => /\b(19|20)\d\d\s+[—–-]/.test(d.name)).map(d => d.id).slice(0, MAX_SOURCES);
    const labels = (o.criteria?.length ? o.criteria : criteriaFor(sp));
    const criteria = labels.map(label => ({ id: critId(label), label }));
    const cells = {};
    papers.forEach(p => { cells[p] = {}; criteria.forEach(c => { cells[p][c.id] = finding(p, c.label); }); });
    return { papers, criteria, cells };
  }

  function rvRender(w, ctx) {
    const d = w.data, u = rvu(w), can = ctx.canEdit;
    d.papers ??= []; d.criteria ??= []; d.cells ??= {};
    // Seeded reviews may list sources and criteria only: read any missing cell from the evidence bank.
    d.papers.forEach(p => { const row = (d.cells[p] ??= {}); d.criteria.forEach(c => { row[c.id] ??= finding(p, c.label); }); });
    const empty = !d.papers.length || !d.criteria.length;
    // The bar holds the table's tools: add a criterion (also at the table's edge) and synthesize (until a synthesis exists, which then owns Update).
    const synth = can && !empty && !d.synthesis && !u.synth ? btn('Synthesize', { v: 'secondary', icon: 'sparkles', size: 'sm', act: 'rv-synth', data: { w: w.id } }) : '';
    const addCrit = can && !empty ? btn('Add criterion', { v: 'ghost', size: 'sm', icon: 'plus', act: 'rv-add-crit', data: { w: w.id } }) : '';
    return `<div class="rv">
      ${u.synth ? synthSkeleton() : d.synthesis ? synthCard(w, can) : ''}
      ${empty ? '' : `<div class="rv-bar"><span class="t-sm muted rv-bar__hint">Select a cell to see its evidence</span><span class="row gap-8">${addCrit}${synth}</span></div>`}
      ${!empty ? matrix(w, can, u) + cards(w, can, u) : emptyState({ icon: 'table', title: d.papers.length ? 'No criteria yet' : 'No sources yet', desc: d.papers.length ? 'Add what you want to compare, like Cost or Risks.' : 'Add documents from this space’s knowledge to compare them.', actions: can ? btn(d.papers.length ? 'Add criterion' : 'Add sources', { v: 'primary', icon: 'plus', act: d.papers.length ? 'rv-add-crit' : 'rv-add-paper', data: { w: w.id } }) : '', boxed: true })}
    </div>`;
  }
  const isSel = (u, p, c) => !!u.sel && !u.sel.cite && u.sel.p === p && u.sel.c === c;
  const cellAttrs = (w, pid, c, pp, cell, u) => `data-act="rv-cell" data-w="${w.id}" data-p="${esc(pid)}" data-c="${esc(c.id)}" aria-label="${esc(c.label)} for ${esc(pp.short)}: ${esc(cell.text)}" ${isSel(u, pid, c.id) ? 'aria-current="true"' : ''}`;
  function matrix(w, can, u) {
    const d = w.data;
    // Row and column menus are secondary: they show on hover or keyboard focus (always on touch).
    const head = `<th class="table__column rv-col rv-col--paper" scope="col">Source</th>` + d.criteria.map(c => `<th class="table__column rv-col" scope="col"><span class="rv-col__inner"><span class="truncate">${esc(c.label)}</span>${can ? iconBtn('more', `Options for ${c.label}`, { size: 'sm', menu: 'rv-col', data: { w: w.id, id: c.id }, cls: 'rv-more' }) : ''}</span></th>`).join('')
      + (can ? `<th class="table__column rv-col--add" scope="col">${iconBtn('plus', 'Add criterion', { size: 'sm', act: 'rv-add-crit', data: { w: w.id } })}</th>` : '');
    const rows = d.papers.map(pid => {
      const pp = paper(pid), pending = u.pendingRows[pid];
      const lead = `<th class="table__cell rv-paper" scope="row"><div class="rv-paper__inner"><div class="grow" style="min-width:0"><a class="rv-paper__title clamp-2" href="#/doc/${esc(pid)}">${esc(pp.title)}</a><div class="t-xs muted truncate">${esc(pp.authors)}${pp.year ? ' · ' + esc(pp.year) : ''}</div></div>${can ? iconBtn('more', `Options for ${pp.title}`, { size: 'sm', menu: 'rv-row', data: { w: w.id, id: pid }, cls: 'rv-more' }) : ''}</div></th>`;
      const cells = d.criteria.map(c => {
        if (pending || u.pendingCols[c.id]) return `<td class="table__cell rv-cell" aria-busy="true"><span class="skeleton skeleton--line" style="width:86%"></span><span class="skeleton skeleton--line mt-8" style="width:54%"></span></td>`;
        const cell = d.cells[pid]?.[c.id] || { text: '—', none: true };
        const fresh = u.fresh[c.id] || u.fresh[pid];
        return `<td class="${cx('table__cell rv-cell', cell.none && 'rv-cell--none', fresh && 'rv-cell--new', isSel(u, pid, c.id) && 'is-selected')}" role="button" tabindex="0" ${cellAttrs(w, pid, c, pp, cell, u)}><span class="rv-cell__text">${esc(cell.text)}</span>${cell.cite ? `<span class="cite" aria-hidden="true">p.${cell.cite.page}</span>` : ''}</td>`;
      }).join('');
      return `<tr class="${cx('table__row', u.fresh[pid] && 'table__row--new')}">${lead}${cells}${can ? '<td class="table__cell rv-cell--add" aria-hidden="true"></td>' : ''}</tr>`;
    });
    const addRow = can ? `<tr class="table__row rv-add-row"><th class="table__cell rv-paper" scope="row">${btn('Add sources', { v: 'ghost', size: 'sm', icon: 'plus', act: 'rv-add-paper', data: { w: w.id } })}</th><td class="table__cell" colspan="${d.criteria.length + 1}"></td></tr>` : '';
    return `<div class="table-root rv-matrix"><div class="table__scroll rv-matrix__scroll" id="rv-scroll-${w.id}" data-w="${w.id}" tabindex="0" role="region" aria-label="${esc(w.title)}"><table class="table__content rv-table"><thead class="table__head"><tr>${head}</tr></thead><tbody class="table__body">${rows.join('')}${addRow}</tbody></table></div></div>`;
  }
  /** Phones: one card per source, each criterion a row (the table is hidden by a container query). */
  function cards(w, can, u) {
    const d = w.data;
    return `<div class="rv-cards">${d.papers.map(pid => {
      const pp = paper(pid), pending = u.pendingRows[pid];
      const rows = d.criteria.map(c => {
        const cell = d.cells[pid]?.[c.id] || { text: '—', none: true };
        const text = pending || u.pendingCols[c.id] ? '<span class="skeleton skeleton--line" style="width:70%"></span>' : `${esc(cell.text)}${cell.cite ? ` <span class="cite" aria-hidden="true">p.${cell.cite.page}</span>` : ''}`;
        return `<li><button type="button" class="${cx('rv-card__row', cell.none && 'rv-cell--none', isSel(u, pid, c.id) && 'is-selected')}" ${cellAttrs(w, pid, c, pp, cell, u)}><span class="rv-card__label">${esc(c.label)}</span><span class="rv-card__text">${text}</span></button></li>`;
      }).join('');
      return `<section class="card rv-card" aria-label="${esc(pp.title)}"><div class="rv-card__head"><div class="grow" style="min-width:0"><a class="rv-paper__title clamp-2" href="#/doc/${esc(pid)}">${esc(pp.title)}</a>${pp.authors || pp.year ? `<div class="t-xs muted truncate">${esc(pp.authors)}${pp.year ? ' · ' + esc(pp.year) : ''}</div>` : ''}</div>${can ? iconBtn('more', `Options for ${pp.title}`, { size: 'sm', menu: 'rv-row', data: { w: w.id, id: pid } }) : ''}</div><ul class="rv-card__list">${rows}</ul></section>`;
    }).join('')}${can ? `<div class="row gap-8">${btn('Add sources', { size: 'sm', icon: 'plus', act: 'rv-add-paper', data: { w: w.id } })}</div>` : ''}</div>`;
  }
  function flash(w, key) { const u = rvu(w); u.fresh[key] = true; setTimeout(() => { delete u.fresh[key]; }, 1700); }
  /* The table keeps its horizontal position across re-renders (core only keeps vertical scroll). */
  document.addEventListener('scroll', e => { const t = e.target; if (t.classList?.contains('rv-matrix__scroll')) { const w = W(t.dataset.w); if (w) rvu(w).x = t.scrollLeft; } }, true);
  function rvAfter(w) { const sc = $('#rv-scroll-' + w.id), x = rvu(w).x; if (sc && x) sc.scrollLeft = x; }
  const scrollEnd = w => { rvu(w).x = 1e6; };

  /* Evidence panel: non-modal, beside the table; selecting another cell (or a synthesis citation) updates it. */
  A['rv-cell'] = el => { const w = W(el.dataset.w); if (!w) return; const u = rvu(w); u.sel = { p: el.dataset.p, c: el.dataset.c }; u.busy = false; refresh(); };
  A['rv-panel-close'] = el => { const w = W(el.dataset.w); if (!w) return; rvu(w).sel = null; refresh(); };
  function rvPanel(w, ctx) {
    const u = rvu(w), s = u.sel; if (!s) return '';
    const close = iconBtn('x', 'Close evidence', { size: 'sm', act: 'rv-panel-close', data: { w: w.id } });
    let title, body, ref = '', href, reread = '';
    if (s.cite) {
      const d = docById(s.cite.doc), kb = d && kbById(d.kb);
      title = d?.name || 'Source'; href = d && canReadKb(kb) ? docHref(s.cite) : '';
      body = `<div class="t-label mb-8">Cited passage</div>${evidenceBody(d, s.cite)}`;
      ref = `“${s.cite.quote}” — ${title}, p. ${s.cite.page}`;
    } else {
      const crit = w.data.criteria.find(c => c.id === s.c), cell = w.data.cells[s.p]?.[s.c];
      if (!crit || !cell) { u.sel = null; return ''; }
      const pp = paper(s.p);
      title = pp.title; href = cell.cite ? docHref(cell.cite) : '/doc/' + s.p;
      body = `<div class="t-label mb-8">${esc(crit.label)}</div><p class="rv-ev__finding">${u.busy ? `<span class="row gap-8 muted">${spinner()}Re-reading the passage…</span>` : esc(cell.text)}</p>${cell.replaced ? `<div class="t-xs muted mt-4">Re-read ${esc(rel(cell.replaced).toLowerCase())}</div>` : ''}`
        + (cell.cite ? `<div class="t-label mt-24 mb-8">Evidence</div>${evidenceBody(pp.doc, cell.cite)}` : `<div class="mt-24">${alertBox('default', 'No passage found', `This source doesn’t report ${esc(crit.label.toLowerCase())}. Check the document if you expected it.`)}</div>`);
      ref = cell.cite ? `“${cell.cite.quote}” — ${pp.parsed ? `${pp.authors} (${pp.year}), ` : ''}${pp.title}, p. ${cell.cite.page}` : '';
      reread = ctx.canEdit ? iconBtn('retry', 'Re-read the passage and restate the finding', { size: 'sm', act: 'rv-replace', data: { w: w.id }, disabled: u.busy }) : '';
    }
    const copy = ref ? iconBtn('copy', 'Copy citation', { size: 'sm', act: 'copy', data: { text: ref, msg: 'Citation copied' } }) : '';
    return `<aside class="split__panel rv-panel" aria-label="Evidence"><div class="panel__header"><div class="panel__title truncate">${esc(title)}</div>${reread}${copy}${close}</div>
      <div class="panel__body">${body}${href ? `<div class="mt-16">${btn('Open document', { v: 'secondary', size: 'sm', icon: 'arrow-up-right', href })}</div>` : ''}</div></aside>`;
  }
  A['rv-replace'] = async el => {
    const w = W(el.dataset.w); if (!w) return; const u = rvu(w), s = u.sel; if (!s || s.cite) return;
    u.busy = true; refresh(); await sleep(900);
    const crit = w.data.criteria.find(c => c.id === s.c), cells = w.data.cells[s.p], prev = cells?.[s.c];
    u.busy = false;
    if (!crit || !prev) { refresh(); return; }
    cells[s.c] = { ...restate(prev, crit.label, s.p), replaced: Date.now() };
    saveWork(w); refresh();
    toast('Finding restated from the passage', { action: { label: 'Undo', run: () => { cells[s.c] = prev; saveWork(w); refresh(); } } });
  };
  const prevEsc = A['esc-page'];
  A['esc-page'] = () => {
    const w = S.cur?.r.page === 'workItem' && W(S.cur.params.id);
    if (w?.kind === 'review' && rvu(w).sel) { rvu(w).sel = null; refresh(); return true; }
    return prevEsc?.() || false;
  };

  /* Add sources: search the space's documents, pick several, each row fills in as it is read. */
  const hasYear = d => /\b(19|20)\d\d\s+[—–-]/.test(d.name);
  A['rv-add-paper'] = el => { S.ui.rvAdd = { q: '', picked: [], err: '' }; openModal('rv-add-paper', { w: el.dataset.w }); };
  M['rv-add-paper'] = p => {
    const w = W(p.w); if (!w) return { title: 'Add sources', body: '' };
    const sp = spaceById(w.space), f = ui('rvAdd', { q: '', picked: [], err: '' }), q = f.q.trim().toLowerCase(), n = f.picked.length;
    const docs = paperDocs(sp).filter(d => !w.data.papers.includes(d.id)).sort((a, b) => hasYear(b) - hasYear(a));
    const shown = docs.filter(d => !q || d.name.toLowerCase().includes(q) || (kbById(d.kb)?.name || '').toLowerCase().includes(q));
    const rows = shown.map(d => {
      const pp = paper(d.id), meta = esc([pp.parsed && pp.authors, pp.year, kbById(d.kb)?.name].filter(Boolean).join(' · '));
      return checkbox({ id: 'rv-add-' + d.id, checked: f.picked.includes(d.id), act: 'rv-add-paper-pick', data: { id: d.id }, label: `<span class="rv-opt">${fileIcon(d.type, 'sm')}<span class="rv-opt__text"><span class="rv-opt__title truncate">${esc(pp.title)}</span><span class="rv-opt__meta truncate">${meta}</span></span>${d.status !== 'ready' ? status('doc', d.status) : ''}</span>` });
    }).join('');
    const room = MAX_SOURCES - w.data.papers.length;
    const picker = !docs.length ? emptyState({ icon: 'files', title: 'Every source is already in this review', desc: 'Add documents to the space’s knowledge to compare more.', compact: true })
      : rows ? `<div class="option-list rv-options mt-12" id="rv-add-list" data-keep-scroll role="group" aria-label="Documents">${rows}</div>` : `<p class="t-sm muted rv-options__empty">No documents match. Try another word.</p>`;
    return {
      title: 'Add sources', icon: 'files', size: 'md',
      desc: 'Each one is read for every criterion, and every cell cites its passage.',
      body: `${docs.length ? searchField({ id: 'rv-add-q', bind: 'rvAdd.q', value: f.q, placeholder: 'Search documents', size: 'md', full: true, live: true, autofocus: true, label: 'Search documents' }) : ''}${picker}${f.err ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : ''}`,
      footStart: n ? `${plural(n, 'source')} selected · room for ${fmtNum(Math.max(0, room))}` : docs.length ? `Room for ${plural(Math.max(0, room), 'more source')}.` : '',
      foot: btn(docs.length ? 'Cancel' : 'Close', { v: 'ghost', act: 'close-modal' }) + (docs.length ? btn(n ? `Add ${plural(n, 'source')}` : 'Add sources', { v: 'primary', icon: 'plus', act: 'rv-add-paper-go', data: { w: w.id } }) : ''),
    };
  };
  A['rv-add-paper-pick'] = el => { const f = ui('rvAdd'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; f.err = ''; refreshLayer(); };
  A['rv-add-paper-go'] = async el => {
    const w = W(el.dataset.w), f = ui('rvAdd'); if (!w) return;
    const ids = f.picked.filter(id => !w.data.papers.includes(id));
    if (!ids.length) { f.err = 'Select at least one document.'; refreshLayer(); return; }
    const room = MAX_SOURCES - w.data.papers.length;
    if (ids.length > room) { f.err = room > 0 ? `A review compares up to ${MAX_SOURCES} sources. Pick ${room} or fewer, or remove a source first.` : `This review already compares ${MAX_SOURCES} sources. Remove one first.`; refreshLayer(); return; }
    closeModal();
    const u = rvu(w); ids.forEach(id => { w.data.papers.push(id); u.pendingRows[id] = true; }); refresh();
    requestAnimationFrame(() => { const sc = $('#rv-scroll-' + w.id); sc?.closest('.rv')?.querySelector('.table__row:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    await sleep(1100);
    const added = ids.filter(id => w.data.papers.includes(id));
    if (!added.length) return;
    added.forEach(id => {
      w.data.cells[id] = Object.fromEntries(w.data.criteria.map(c => [c.id, finding(id, c.label)]));
      if (!w.sources?.includes(id)) (w.sources ??= []).push(id);
      delete u.pendingRows[id]; flash(w, id);
    });
    saveWork(w); refresh();
    toast(added.length === 1 ? `Added ${paper(added[0]).short}` : `Added ${plural(added.length, 'source')}`, { action: { label: 'Undo', run: () => added.forEach(id => removePaper(w, id, true)) } });
  };
  /** Rows and w.sources stay in step, so every count (header, Sources panel, synthesis) agrees. */
  function removePaper(w, id, quiet) {
    const i = w.data.papers.indexOf(id); if (i < 0) return;
    const cells = w.data.cells[id], si = (w.sources || []).indexOf(id);
    w.data.papers.splice(i, 1); delete w.data.cells[id]; if (si >= 0) w.sources.splice(si, 1);
    if (rvu(w).sel?.p === id) rvu(w).sel = null;
    saveWork(w); refresh();
    if (!quiet) toast(`Removed ${paper(id).short}`, { action: { label: 'Undo', run: () => { w.data.papers.splice(i, 0, id); w.data.cells[id] = cells; if (si >= 0) w.sources.splice(si, 0, id); saveWork(w); refresh(); } } });
  }
  MENUS['rv-row'] = el => {
    const w = W(el.dataset.w), id = el.dataset.id; if (!w) return [];
    return [
      { label: 'Open document', icon: 'file-text', run: () => go('/doc/' + id) },
      { label: 'Re-read this source', icon: 'retry', run: async () => { const u = rvu(w); u.pendingRows[id] = true; refresh(); await sleep(900); w.data.cells[id] = Object.fromEntries(w.data.criteria.map(c => [c.id, finding(id, c.label)])); delete u.pendingRows[id]; flash(w, id); saveWork(w); refresh(); toast('Row refreshed from the source'); } },
      { sep: true },
      { label: 'Remove source', icon: 'trash', danger: true, run: () => removePaper(w, id) },
    ];
  };

  /* Add criterion (column) */
  A['rv-add-crit'] = el => { setPath('rvCrit', { label: '', err: '' }); openModal('rv-add-crit', { w: el.dataset.w }); };
  M['rv-add-crit'] = p => {
    const w = W(p.w); const f = getPath('rvCrit') || {}; const have = new Set(w.data.criteria.map(c => c.label.toLowerCase()));
    const sugg = [...criteriaFor(spaceById(w.space)), ...suggestionsFor(spaceById(w.space))].filter(s => !have.has(s.toLowerCase()));
    return {
      title: 'Add a criterion', icon: 'list-plus', size: 'sm',
      desc: 'A new column. Each source is read for it and every cell is cited.',
      body: `${field({ id: 'rv-crit', label: 'What do you want to compare?', error: f.err, control: input({ id: 'rv-crit', bind: 'rvCrit.label', value: f.label, placeholder: 'e.g. Time to migrate', autofocus: true, onEnter: 'rv-add-crit-ok', invalid: !!f.err, attrs: 'maxlength="40"' }) })}
        ${sugg.length ? `<div class="mt-16"><div class="t-label mb-8">Suggested</div><div class="row gap-8 wrap">${sugg.map(s => `<button type="button" class="rv-chip" data-act="rv-crit-sugg" data-label="${esc(s)}">${ic('plus', 'i-sm')}${esc(s)}</button>`).join('')}</div></div>` : ''}`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Add criterion', { v: 'primary', icon: 'plus', act: 'rv-add-crit-ok' }),
    };
  };
  A['rv-crit-sugg'] = el => { setPath('rvCrit.label', el.dataset.label); A['rv-add-crit-ok'](); };
  A['rv-add-crit-ok'] = async () => {
    const w = W(S.modal?.props?.w); if (!w) return;
    const label = String(getPath('rvCrit.label') || '').trim().replace(/^./, m => m.toUpperCase());
    if (!label) { setPath('rvCrit.err', 'Name what you want to compare.'); refreshLayer(); return; }
    if (w.data.criteria.some(c => c.label.toLowerCase() === label.toLowerCase())) { setPath('rvCrit.err', 'That column is already in the matrix.'); refreshLayer(); return; }
    closeModal();
    const c = { id: uid('c'), label }, u = rvu(w);
    w.data.criteria.push(c); u.pendingCols[c.id] = true; refresh();
    scrollEnd(w); requestAnimationFrame(() => { const sc = $('#rv-scroll-' + w.id); if (sc) sc.scrollTo({ left: sc.scrollWidth, behavior: 'smooth' }); });
    await sleep(1200);
    if (!w.data.criteria.includes(c)) return;
    w.data.papers.forEach(pid => { (w.data.cells[pid] ??= {})[c.id] = finding(pid, label); });
    scrollEnd(w);
    delete u.pendingCols[c.id]; flash(w, c.id); saveWork(w); refresh();
    const found = w.data.papers.filter(pid => !w.data.cells[pid][c.id].none).length;
    toast(found ? `${label}: evidence in ${found} of ${plural(w.data.papers.length, 'source')}` : `${label}: not reported in any source`, { action: { label: 'Undo', run: () => removeCrit(w, c.id, true) } });
  };
  function removeCrit(w, id, quiet) {
    const i = w.data.criteria.findIndex(c => c.id === id); if (i < 0) return;
    const c = w.data.criteria[i]; const saved = Object.fromEntries(w.data.papers.map(p => [p, w.data.cells[p]?.[id]]));
    w.data.criteria.splice(i, 1); w.data.papers.forEach(p => { if (w.data.cells[p]) delete w.data.cells[p][id]; }); saveWork(w); refresh();
    if (!quiet) toast(`Removed ${c.label}`, { action: { label: 'Undo', run: () => { w.data.criteria.splice(i, 0, c); Object.entries(saved).forEach(([p, v]) => { if (v && w.data.cells[p]) w.data.cells[p][id] = v; }); saveWork(w); refresh(); } } });
  }
  MENUS['rv-col'] = el => {
    const w = W(el.dataset.w), id = el.dataset.id; const i = w?.data.criteria.findIndex(c => c.id === id); if (!w || i < 0) return [];
    const move = d => { const a = w.data.criteria; [a[i], a[i + d]] = [a[i + d], a[i]]; saveWork(w); refresh(); };
    return [
      { label: 'Move left', icon: 'arrow-left', disabled: i === 0, run: () => move(-1) },
      { label: 'Move right', icon: 'arrow-right', disabled: i === w.data.criteria.length - 1, run: () => move(1) },
      { sep: true },
      { label: 'Remove column', icon: 'trash', danger: true, run: () => removeCrit(w, id) },
    ];
  };

  /* Synthesis: consensus, disagreements, gaps — every sentence cited */
  const CANNED_SYNTH = {
    consensus: [
      ['All three platforms handle the load test at three times the Tết peak, between 150,000 and 180,000 messages per second.', [['fx-eng-eval-kafka', 3], ['fx-eng-eval-pulsar', 3], ['fx-eng-eval-msk', 3]]],
      ['Both Kafka options give exactly-once delivery with idempotent producers and transactions, which ADR-027’s ledger consumers need.', [['fx-eng-eval-kafka', 4], ['fx-eng-eval-msk', 4]]],
    ],
    disagreements: [
      ['Data residency: only self-hosted Pulsar keeps payment events in Vietnam; Confluent Cloud and MSK would run in Singapore.', [['fx-eng-eval-pulsar', 6], ['fx-eng-eval-kafka', 6], ['fx-eng-eval-msk', 6]]],
      ['Operations effort runs opposite to cost: Pulsar is cheapest at USD 0.94M but needs about 2.5 engineers, while Confluent costs USD 1.26M with almost no broker work.', [['fx-eng-eval-pulsar', 7], ['fx-eng-eval-pulsar', 5], ['fx-eng-eval-kafka', 7], ['fx-eng-eval-kafka', 5]]],
    ],
    gaps: [
      ['No evaluation includes the Decree 13 cross-border transfer assessment that the cloud options need.', [['fx-eng-eval-kafka', 6], ['fx-eng-eval-msk', 6]]],
      ['Pulsar’s exactly-once support for Go services is untested; the ledger consumers are written in Go.', [['fx-eng-eval-pulsar', 4]]],
    ],
  };
  function buildSynthesis(w) {
    const d = w.data, inSet = refs => refs.every(([doc]) => d.papers.includes(doc));
    const canned = k => CANNED_SYNTH[k].filter(([, refs]) => inSet(refs)).map(([text, refs]) => ({ text, cites: refs.map(([doc, pg]) => quoteAt(doc, pg)) }));
    const cellsFor = key => d.papers.map(p => { const c = d.criteria.find(x => critKey(x.label) === key); const cell = c && d.cells[p]?.[c.id]; return cell?.cite ? { p, cell, crit: c } : null; }).filter(Boolean);
    const generic = {
      consensus: () => { const m = cellsFor('method'); const any = m.length ? m : d.papers.map(p => ({ p, cell: d.cells[p]?.[d.criteria[0].id], crit: d.criteria[0] })).filter(x => x.cell?.cite); return any.length > 1 ? [{ text: `${plural(any.length, 'source')} report comparable evidence on ${any[0].crit.label.toLowerCase()}: ${any.slice(0, 3).map(x => `${paper(x.p).short} (${lc(x.cell.text)})`).join('; ')}.`, cites: any.slice(0, 3).map(x => x.cell.cite) }] : []; },
      disagreements: () => { const r = cellsFor('result'); return r.length > 1 ? [{ text: `Reported results differ: ${paper(r[0].p).short} finds ${lc(r[0].cell.text)}, while ${paper(r[1].p).short} finds ${lc(r[1].cell.text)}.`, cites: [r[0].cell.cite, r[1].cell.cite] }] : []; },
      gaps: () => cellsFor('limit').slice(0, 3).map(x => ({ text: `${paper(x.p).short}: ${lc(x.cell.text)}.`, cites: [x.cell.cite] })),
    };
    const out = {};
    ['consensus', 'disagreements', 'gaps'].forEach(k => { const c = canned(k); out[k] = c.length ? c : generic[k](); });
    return { ...out, at: Date.now(), sig: synthSig(w) };
  }
  const synthSig = w => w.data.papers.join(',') + '|' + w.data.criteria.map(c => c.id).join(',');
  A['rv-synth'] = async el => {
    const w = W(el.dataset.w); if (!w) return; const u = rvu(w);
    u.synth = true; refresh(); ($('#work-scroll') || $('#scroll'))?.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(1300);
    w.data.synthesis = buildSynthesis(w); u.synth = false; saveWork(w); refresh();
    toast('Synthesis ready');
  };
  A['rv-synth-hide'] = el => { const w = W(el.dataset.w); if (!w) return; const prev = w.data.synthesis; delete w.data.synthesis; saveWork(w); refresh(); toast('Synthesis removed', { action: { label: 'Undo', run: () => { w.data.synthesis = prev; saveWork(w); refresh(); } } }); };
  function synthSkeleton() {
    return `<div class="card rv-synth" aria-busy="true"><div class="row gap-8 muted t-sm">${spinner()}Reading every cited passage…</div><div class="rv-synth__grid">${[0, 1, 2].map(() => `<div class="stack gap-8"><span class="skeleton skeleton--line" style="width:40%"></span><span class="skeleton skeleton--line"></span><span class="skeleton skeleton--line" style="width:80%"></span><span class="skeleton skeleton--line" style="width:65%"></span></div>`).join('')}</div></div>`;
  }
  function synthCard(w, can) {
    const s = w.data.synthesis, u = rvu(w); const seen = [];
    const num = c => { let i = seen.findIndex(x => x.doc === c.doc && x.page === c.page); if (i < 0) { seen.push(c); i = seen.length - 1; } return i + 1; };
    const stale = s.sig !== synthSig(w);
    const col = (title, icon, items) => `<div class="rv-synth__col"><h3 class="rv-synth__title">${ic(icon, 'i-sm')}${title}</h3>${items.length ? `<ul class="rv-synth__list">${items.map(it => `<li>${esc(it.text)} ${it.cites.map(c => citeBtn(c, num(c))).join('')}</li>`).join('')}</ul>` : '<p class="t-sm muted">Nothing stands out in this review.</p>'}</div>`;
    const actions = can ? (stale ? btn('Update', { size: 'sm', icon: 'retry', act: 'rv-synth', data: { w: w.id } }) : '') + iconBtn('x', 'Remove synthesis', { size: 'sm', act: 'rv-synth-hide', data: { w: w.id } }) : '';
    // On phones the synthesis folds into one line so the comparison stays on the first screen.
    const toggle = `<button type="button" class="rv-synth__toggle" data-act="rv-synth-open" data-w="${w.id}" aria-expanded="${!!u.synthOpen}">${ic('chevron-down', 'disclosure__chevron')}<span class="sr-only">Show synthesis</span></button>`;
    return `<section class="${cx('card rv-synth', u.synthOpen && 'is-open')}" aria-label="Synthesis"><div class="card__header"><span class="item-icon item-icon--accent" aria-hidden="true">${ic('sparkles')}</span><div class="grow"><h2 class="card__title">Synthesis</h2><p class="card__description">${stale ? 'The review changed since this was written.' : `From ${plural(w.data.papers.length, 'source')} · ${rel(s.at)}`}</p></div><div class="row gap-4 none">${actions}${toggle}</div></div>
      <div class="rv-synth__grid">${col('Consensus', 'check-circle', s.consensus)}${col('Disagreements', 'git-compare', s.disagreements)}${col('Gaps', 'target', s.gaps)}</div></section>`;
  }
  A['rv-synth-open'] = el => { const w = W(el.dataset.w); if (!w) return; const u = rvu(w); u.synthOpen = !u.synthOpen; refresh(); };
  /** Documents read for context but not compared (e.g. an ADR the options must satisfy). */
  const contextDocs = w => (w.sources || []).filter(id => !(w.data?.papers || []).includes(id) && docById(id));

  /* Header actions + exports */
  function rvActions(w, ctx) {
    const sp = spaceById(w.space);
    const canDraft = !!w.data?.papers?.length && (w.owner === me().id || !!spaceRole(sp) || !sp);
    // CSV sits with the other downloads in ⋯.
    return canDraft ? btn('Draft from this review', { v: 'primary', icon: 'pencil', act: 'rv-draft', data: { w: w.id } }) : '';
  }
  function csvRows(w) {
    const d = w.data;
    return [['Source', 'Authors', 'Year', ...d.criteria.map(c => c.label)], ...d.papers.map(p => { const pp = paper(p); return [pp.title, pp.authors, pp.year, ...d.criteria.map(c => { const cell = d.cells[p]?.[c.id]; return !cell ? '' : cell.cite ? `${cell.text} (p. ${cell.cite.page})` : cell.text; })]; })];
  }
  function exportCsv(w) { saveCsv(withExt(w.title, '.csv'), csvRows(w), 'Review exported as CSV'); audit('Exported review', w.title); }
  A['rv-csv'] = el => { const w = W(el.dataset.w); if (w) exportCsv(w); };
  A['rv-draft'] = el => {
    const w = W(el.dataset.w); if (!w) return;
    // A decision record when the review has architecture decisions as context, else an evidence summary.
    const sources = [...new Set([...w.data.papers, ...(w.sources || [])])].filter(id => docById(id));
    const type = defaultType(spaceById(w.space), sources) === 'decision' ? 'decision' : 'litreview';
    const title = `${typeLabel(type)} — ${w.title.replace(/\s*[—–-]\s*(evidence review|evidence matrix|evaluation)$/i, '')}`;
    const opts = { type, tone: 'formal', length: 'medium', fromReview: w.id };
    X.work.create({ kind: 'draft', workflow: 'draft', title, space: w.space, sources, options: opts });
  };
  function rvExportHtml(w) {
    const rows = csvRows(w);
    const s = w.data.synthesis;
    const synth = s ? ['consensus', 'disagreements', 'gaps'].map(k => `<h3>${k[0].toUpperCase() + k.slice(1)}</h3><ul>${s[k].map(it => `<li>${esc(it.text)} (${it.cites.map(c => `${esc(paper(c.doc).short)}, p. ${c.page}`).join('; ')})</li>`).join('')}</ul>`).join('') : '';
    return `${synth ? '<h2>Synthesis</h2>' + synth : ''}<h2>Comparison</h2><table border="1" cellpadding="6" style="border-collapse:collapse"><tr>${rows[0].map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.slice(1).map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  }
  function rvExportLines(w) {
    const d = w.data; const out = [];
    d.papers.forEach(p => { const pp = paper(p); out.push('', pp.parsed ? `${pp.authors} (${pp.year}) — ${pp.title}` : pp.title); d.criteria.forEach(c => { const cell = d.cells[p]?.[c.id]; if (cell) out.push(`  ${c.label}: ${cell.text}${cell.cite ? ` (p. ${cell.cite.page})` : ''}`); }); });
    return out;
  }

  WORK_KINDS.review = {
    label: 'Evidence review', icon: 'table', noun: 'review', layout: 'wide', maxSources: MAX_SOURCES,
    options: rvOptions,
    title: ctx => { const sp = spOf(ctx?.space); return sp ? `${sp.name} — evidence review` : 'Evidence review'; },
    generate: rvGenerate,
    render: rvRender,
    panel: rvPanel,
    after: rvAfter,
    actions: rvActions,
    // A synthesis citation opens in the evidence panel, like a cell.
    onCite: (w, p) => { rvu(w).sel = { cite: { doc: p.doc, page: p.page, quote: p.quote } }; refresh(); },
    downloads: w => [{ label: 'Download as CSV', icon: 'table', run: () => exportCsv(w) }],
    // One unit: rows compared; context documents counted on their own.
    sourceLine: w => { const n = w.data?.papers?.length || 0, c = contextDocs(w).length; return `${plural(n, 'source')} compared${c ? ` · ${plural(c, 'context document')}` : ''}`; },
    sourceGroups: w => [{ title: 'Compared', ids: w.data?.papers || [] }, { title: 'Context', ids: contextDocs(w) }],
    summary: w => `${plural(w.data?.papers?.length || 0, 'source')} · ${plural(w.data?.criteria?.length || 0, 'criterion', 'criteria')}${w.data?.synthesis ? ' · synthesized' : ''}`,
    exportHtml: rvExportHtml,
    exportLines: rvExportLines,
  };

  /* ═══════════════ Draft (grounded document) ═══════════════ */
  const DRAFT_TYPES = [
    ['decision', 'Decision record', 'Context, options, decision and consequences — like an ADR.'],
    ['proposal', 'Proposal', 'Background, objectives and a plan grounded in your sources.'],
    ['litreview', 'Evidence summary', 'What your sources say, compared side by side.'],
    ['announcement', 'Announcement', 'A clear notice for a team, project or course.'],
    ['email', 'Email', 'A short message that summarises your sources.'],
  ];
  const typeLabel = t => (DRAFT_TYPES.find(x => x[0] === t) || DRAFT_TYPES[0])[1];
  const TONES = [['formal', 'Formal'], ['neutral', 'Neutral'], ['friendly', 'Friendly']];
  const LENGTHS = [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']];
  const isAdr = d => /^ADR-\d+/i.test(d?.name || '');
  const drType = w => w.data?.type || defaultType(spaceById(w.space), w.sources || []);
  function defaultType(sp, docs) {
    if (docs.some(id => isAdr(docById(id)))) return 'decision';
    if (sp?.type === 'course') return 'announcement';
    if (sp?.type === 'research' || sp?.type === 'project') return 'litreview';
    return 'email';
  }
  function drOptions(f, ctx) {
    const o = (f.opts ??= {}); const sp = spOf(ctx?.space ?? f.space);
    o.type ??= defaultType(sp, idsOf(ctx?.sources)); o.tone ??= o.type === 'announcement' || o.type === 'email' ? 'neutral' : 'formal'; o.length ??= 'medium';
    return `<div class="stack gap-16">
      ${field({ id: 'dr-opt-type', label: 'What are you writing?', control: choiceGroup({ name: 'dr-opt-type', value: o.type, options: DRAFT_TYPES, act: 'dr-opt-type', cols: 1 }) })}
      <div class="dr-optrow">${field({ id: 'dr-opt-tone', label: 'Tone', control: seg({ value: o.tone, options: TONES, act: 'dr-opt', data: { k: 'tone' }, label: 'Tone' }) })}${field({ id: 'dr-opt-len', label: 'Length', control: seg({ value: o.length, options: LENGTHS, act: 'dr-opt', data: { k: 'length' }, label: 'Length' }) })}</div>
    </div>`;
  }
  A['dr-opt-type'] = el => {
    const f = ui('workNew'); f.opts.type = el.dataset.value;
    if (!f.titleTouched) f.title = WORK_KINDS.draft.title({ space: f.space, sources: Object.keys(f.docs || {}).filter(k => f.docs[k]), options: f.opts });
    refresh();
  };
  A['dr-opt'] = el => { ui('workNew').opts[el.dataset.k] = el.dataset.value; refresh(); };

  /* Writing helpers: sentences are parts [text | [doc, page]]; refs become "[n]". */
  function writer() {
    const cites = [];
    const ref = c => { let i = cites.findIndex(x => x.doc === c.doc && x.page === c.page); if (i < 0) { cites.push(c); i = cites.length - 1; } return ` [${i + 1}]`; };
    const say = parts => parts.map(x => (typeof x === 'string' ? esc(x) : ref(Array.isArray(x) ? quoteAt(x[0], x[1]) : x))).join('');
    return { cites, ref, say };
  }
  const greet = (tone, who) => `${({ formal: 'Dear', neutral: 'Hello', friendly: 'Hi' })[tone] || 'Hello'} ${who},`;
  const signoff = tone => ({ formal: 'Yours sincerely,', neutral: 'Best regards,', friendly: 'Thanks,' })[tone] || 'Best regards,';
  /** Hand-written sentences for curated sources (Finx architecture library); other sources are summarised from the evidence bank. */
  const LIT = {
    'fx-eng-adr027': ['ADR-027 requires that ledger balances change only by consuming events from the payments topic, never by direct writes', ['fx-eng-adr027', 1], ', so every ledger consumer must process each event exactly once', ['fx-eng-adr027', 2], '.'],
    'fx-eng-adr031': ['ADR-031 makes every payment POST carry an Idempotency-Key header', ['fx-eng-adr031', 1], ', and the gateway replays the first response for 24 hours on any retry', ['fx-eng-adr031', 2], '.'],
    'fx-eng-eval-kafka': ['Confluent Cloud sustained 180,000 messages per second at a p99 of 42 ms', ['fx-eng-eval-kafka', 3], ' with the vendor running the brokers', ['fx-eng-eval-kafka', 5], ', but it has no region in Vietnam', ['fx-eng-eval-kafka', 6], '.'],
    'fx-eng-eval-pulsar': ['Self-hosted Pulsar keeps all data in Finx data centers', ['fx-eng-eval-pulsar', 6], ' at the lowest three-year cost', ['fx-eng-eval-pulsar', 7], ', but exactly-once processing works only for Java clients', ['fx-eng-eval-pulsar', 4], '.'],
    'fx-eng-eval-msk': ['Amazon MSK reached 160,000 messages per second', ['fx-eng-eval-msk', 3], ' with standard Kafka transactions', ['fx-eng-eval-msk', 4], ', while rebalancing, upgrades and capacity planning stay with us', ['fx-eng-eval-msk', 5], '.'],
  };
  /** A sentence about any source: curated sentence, else built from review cells or evidence. */
  function paperSentence(id, review) {
    if (LIT[id]) return LIT[id];
    const pp = paper(id);
    const cellBy = key => { if (review) { const c = review.data.criteria.find(x => critKey(x.label) === key); const cell = c && review.data.cells[id]?.[c.id]; if (cell?.cite) return cell; } const f = finding(id, key === 'method' ? 'Method' : key === 'result' ? 'Result' : 'Limitations'); return f.cite ? f : null; };
    const m = cellBy('method'), r = cellBy('result'), l = cellBy('limit');
    const parts = [pp.parsed ? `${pp.authors} (${pp.year})` : pp.title];
    if (m) parts.push(` — ${lc(m.text)}`, m.cite);
    if (r) parts.push(`; ${lc(r.text)}`, r.cite);
    if (l) parts.push(`. A limitation: ${lc(l.text)}`, l.cite);
    parts.push('.');
    return parts;
  }
  function relatedWork(papers, wr, { review, length = 'medium', heading = 'What the sources say' } = {}) {
    const srcs = papers.filter(p => docById(p));
    let h = `<h2>${esc(heading)}</h2>`;
    const keep = length === 'short' ? 1 : length === 'long' ? 9 : 3;
    srcs.slice(0, keep).forEach(p => (h += `<p>${wr.say(paperSentence(p, review))}</p>`));
    const lims = srcs.map(p => { const f = finding(p, 'Limitations'); return f.cite ? f : null; }).filter(Boolean).slice(0, 2);
    if (lims.length) h += `<p>${wr.say(['Across these sources, the main open questions concern ', lc(lims[0].text), lims[0].cite, ...(lims[1] ? ['; and ', lc(lims[1].text), lims[1].cite] : []), '.'])}</p>`;
    return h;
  }
  const GEN = {
    decision({ docs, o, wr, review }) {
      const adrs = docs.filter(id => isAdr(docById(id))), options = (review ? review.data.papers : docs).filter(id => !isAdr(docById(id)));
      const ledger = docs.includes('fx-eng-adr027') && !review; // the ledger-split decision; reviews decide between their options
      let h = '<h2>Status</h2><p>Proposed</p><h2>Context</h2>';
      h += adrs.length ? adrs.map(id => `<p>${wr.say(paperSentence(id, review))}</p>`).join('') : `<p>${options.slice(0, 1).map(id => wr.say(paperSentence(id, review))).join('') || 'Describe the problem this decision solves.'}</p>`;
      if (ledger) h += '<p>Today one ledger service both posts entries and serves balance queries. Peak traffic on the query side slows posting, and every deploy touches both.</p>';
      if (options.length) h += `<h2>Options considered</h2><ul>${options.slice(0, o.length === 'short' ? 2 : 4).map(id => `<li>${wr.say(paperSentence(id, review))}</li>`).join('')}</ul>`;
      h += '<h2>Decision</h2>' + (ledger
        ? `<p>${wr.say(['Split the ledger into a posting service, the only consumer of payment events', ['fx-eng-adr027', 1], ', and a balance query service with its own read model. Both keep the idempotency rules of ADR-031', ...(docs.includes('fx-eng-adr031') ? [['fx-eng-adr031', 1]] : []), '.'])}</p>`
        : `<p>We will choose the option that best meets ${review ? 'the review criteria: ' + esc(review.data.criteria.map(c => lc(c.label)).join(', ')) : 'our criteria'}. The evidence for each option is cited above; open questions are settled before the decision is accepted.</p>`);
      if (o.length !== 'short') h += ledger
        ? '<h2>Consequences</h2><ul><li>Each service can be deployed and scaled on its own.</li><li>Balance reads become eventually consistent; the delay must be monitored.</li><li>Runbooks, dashboards and on-call ownership need updating before rollout.</li></ul>'
        : '<h2>Consequences</h2><ul><li>Teams build on the chosen option from the next quarter.</li><li>Runbooks, dashboards and on-call ownership are updated before rollout.</li><li>The decision is revisited if a criterion changes, for example a new cloud region or a cost increase.</li></ul>';
      return h;
    },
    proposal({ sp, docs, o, wr, review }) {
      let h = '<h2>Background</h2>';
      h += `<p>${esc(sp?.name || 'Our team')} proposes the work below. ${docs.slice(0, 1).map(p => wr.say(paperSentence(p, review))).join('')}</p>`;
      const rest = docs.slice(1);
      if (rest.length) h += `<p>${rest.slice(0, o.length === 'short' ? 1 : 3).map(p => wr.say(paperSentence(p, review))).join(' ')}</p>`;
      if (o.length !== 'short') h += '<h3>Objectives</h3><ol><li>State the problem and how we will measure success.</li><li>Deliver the smallest useful change first.</li><li>Review results with stakeholders and decide the next step.</li></ol>';
      if (o.length === 'long') h += '<h3>Expected outcomes</h3><ul><li>A working change in production, with dashboards and a runbook.</li><li>A short write-up of what we learned.</li></ul>';
      return h;
    },
    litreview({ docs, o, wr, review }) {
      const papers = review ? review.data.papers : docs;
      return relatedWork(papers, wr, { review, length: o.length });
    },
    announcement({ sp, docs, o, wr }) {
      const ev = (D.events || []).filter(e => e.space === sp?.id && e.at > Date.now()).sort((a, b) => a.at - b.at)[0];
      const title = ev ? `${ev.title.replace(/ · .*/, '')}: what to know` : `Update for ${sp?.name || 'the team'}`;
      let h = `<h2>${esc(title)}</h2><p>${esc(greet(o.tone, 'all'))}</p>`;
      h += ev ? `<p>${esc(`${ev.title.replace(/ · .*/, '')} is on ${fmtDate(ev.at)}.`)} Here is what to focus on.</p>` : '<p>Here is what you need to know this week.</p>';
      const items = docs.slice(0, o.length === 'short' ? 2 : o.length === 'long' ? 6 : 4).map(id => {
        const d = docById(id); const b = finding(id, 'Result');
        return `<li>${b?.cite ? wr.say([`${paper(id).title}: ${lc(b.text)}`, b.cite, '.']) : esc(`Read ${d?.name.replace(/\.[^.]+$/, '') || 'the material'}.`)}</li>`;
      });
      if (items.length) h += `<ul>${items.join('')}</ul>`;
      if (o.length !== 'short') h += `<p>${o.tone === 'friendly' ? `Questions? Ask in ${sp?.name || 'the space'} — we read every one.` : `If anything is unclear, send your question to ${sp?.name || 'the team'}.`}</p>`;
      h += `<p>${esc(signoff(o.tone))}<br>${esc(me().name)}</p>`;
      return h;
    },
    email({ sp, docs, o, wr }) {
      const lead = sp?.members?.find(m => spaceType(sp.type).staff.includes(m.role) && m.user !== me().id);
      const leadName = lead ? (D.members.find(x => x.id === lead.user)?.name || 'team') : 'team';
      const first = leadName.split(' ').pop();
      let h = `<p><b>Subject:</b> ${esc(`Summary of ${plural(docs.length, 'source')} for ${sp?.name || 'the team'}`)}</p><p>${esc(greet(o.tone, first))}</p><p>Here is a short summary of what I read.</p>`;
      const pts = docs.slice(0, o.length === 'short' ? 1 : o.length === 'long' ? 4 : 2).map(id => { if (LIT[id]) return `<li>${wr.say(LIT[id])}</li>`; const f = finding(id, 'Result'); const pp = paper(id); return f.cite ? `<li>${wr.say([`${pp.short}: ${lc(f.text)}`, f.cite])}</li>` : ''; }).filter(Boolean);
      if (pts.length) h += `<ul>${pts.join('')}</ul>`;
      h += `<p>${o.tone === 'friendly' ? 'Could you take a look this week? Happy to walk through it.' : 'I would be grateful for your comments this week.'}</p><p>${esc(signoff(o.tone))}<br>${esc(me().name)}</p>`;
      return h;
    },
  };
  function drGenerate(ctx) {
    const sp = spOf(ctx.space), o = { type: 'email', tone: 'formal', length: 'medium', ...(ctx.options || {}) };
    const docs = idsOf(ctx.sources).filter(id => docById(id));
    const review = o.fromReview ? W(o.fromReview) : null;
    const wr = writer();
    const html = (GEN[o.type] || GEN.email)({ sp, docs, o, wr, review });
    return { type: o.type, tone: o.tone, length: o.length, fromReview: o.fromReview || null, html, cites: wr.cites, versions: [{ at: Date.now(), html, note: 'First draft' }] };
  }

  /* ── Editor ── */
  const dru = w => ui('dr:' + w.id, { tab: 'sources', rail: false, ask: '', busy: false, hint: '' });
  function bodyHtml(w, editable) {
    const d = w.data;
    let h = X.work.cites(d.html || '', d.cites || []);
    if (editable) h = h.replace(/<button(?=[^>]*class="cite)/g, '<button contenteditable="false"');
    return h;
  }
  /** Editor DOM → stored HTML: citation buttons back to "[n]". */
  function serialize(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('.cite').forEach(b => b.replaceWith('[' + b.textContent.trim() + ']'));
    return c.innerHTML.replace(/\s+contenteditable="false"/g, '');
  }
  const words = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\[\d+\]/g, '').split(/\s+/).filter(Boolean).length;

  /** Draft review loop: draft → in review (one reviewer from the space's staff) → approved | changes requested → in review again. */
  const EDITABLE = ['draft', 'changes'];
  const firstName = id => (actorName(id) || '').trim().split(/\s+/).pop();
  /** Who reviews a draft: the space's staff other than the author, leads first. */
  function reviewerFor(w) {
    const sp = spaceById(w.space); if (!sp) return null;
    const staff = spaceType(sp.type).staff;
    const m = (sp.members || []).filter(x => staff.includes(x.role) && x.user !== w.owner).sort((a, b) => staff.indexOf(a.role) - staff.indexOf(b.role))[0];
    return m?.user || null;
  }
  const lastReview = w => (w.reviews || []).at(-1) || null;
  /** "3 citations from 2 documents": the same words in the header and the rail. */
  function drSourceLine(w) {
    const c = w.data?.cites || [], docs = new Set(c.map(x => x.doc)).size;
    return c.length ? `${plural(c.length, 'citation')} from ${plural(docs, 'document')}` : plural((w.sources || []).length, 'source');
  }
  function reviewNote(w, ctx) {
    const r = lastReview(w), who = r && actorName(r.by), quote = r?.note ? `“${esc(r.note)}”` : '';
    if (w.status === 'in_review') {
      if (ctx.isOwner) return alertBox('accent', `${actorName(w.reviewer)} is reviewing it`, `Sent ${esc(rel(r?.at || w.updated).toLowerCase())}. Editing is paused until they approve it or ask for changes.`, '', { icon: 'clock' });
      if (w.reviewer === me().id || ctx.isReviewer) return alertBox('accent', `${actorName(w.owner)} asked you to review this`, 'Approve it, or request changes with a note. The text stays as they wrote it.', '', { icon: 'send' });
    }
    if (w.status === 'changes' && r) return alertBox('warning', ctx.isOwner ? `${who} requested changes` : `You requested changes ${rel(r.at).toLowerCase()}`, quote, '', { icon: 'message' });
    if (w.status === 'approved' && r?.note) return alertBox('success', `Note from ${who}`, quote, '', { icon: 'check-circle' });
    return '';
  }

  function drRender(w, ctx) {
    const d = w.data, can = ctx.canEdit && EDITABLE.includes(w.status), u = dru(w);
    d.cites ??= []; d.versions ??= [];
    const used = new Set([...String(d.html).matchAll(/\[(\d+)\]/g)].map(m => +m[1]));
    const tool = (label, cmd, o = {}) => `<button type="button" class="${cx('button button--ghost button--sm dr-tool', !label && 'button--icon-only')}" data-act="dr-cmd" data-cmd="${cmd}" ${o.tip ? `data-tip="${esc(o.tip)}" aria-label="${esc(o.tip)}"` : ''}>${o.icon ? ic(o.icon) : ''}${label ? `<span class="${o.cls || ''}">${esc(label)}</span>` : ''}</button>`;
    const toolbar = can ? `<div class="dr-toolbar" role="toolbar" aria-label="Formatting">${tool('Heading', 'heading')}${tool('B', 'bold', { tip: 'Bold', cls: 'strong' })}${tool('', 'bullets', { icon: 'list', tip: 'Bulleted list' })}${tool('', 'undo', { icon: 'undo', tip: 'Undo' })}<span class="grow"></span><span class="dr-saved" id="dr-saved" aria-live="polite">${ic('check', 'i-sm')}Saved</span></div>` : '';
    const type = drType(w);
    const quick = (type === 'proposal' ? ['Shorter', 'More formal', 'Add a cost breakdown'] : type === 'decision' ? ['Shorter', 'Longer', 'Add a rollout timeline'] : type === 'announcement' || type === 'email' ? ['Shorter', 'Friendlier', 'More formal'] : ['Shorter', 'Longer', 'More formal']);
    const ask = can ? `<div class="dr-ask">
        ${u.hint ? `<div class="t-xs muted mb-8">${esc(u.hint)}</div>` : ''}
        <div class="dr-ask__chips">${quick.map(q => `<button type="button" class="rv-chip" data-act="dr-ask" data-w="${w.id}" data-q="${esc(q)}" ${u.busy ? 'disabled' : ''}>${esc(q)}</button>`).join('')}</div>
        <div class="dr-ask__field">${ic('sparkles', 'dr-ask__icon')}${input({ id: 'dr-ask-' + w.id, bind: `dr:${w.id}.ask`, value: u.ask, placeholder: 'Ask for changes, e.g. add a timeline', onEnter: 'dr-ask', attrs: `data-w="${w.id}" aria-label="Ask for changes" ${u.busy ? 'disabled' : ''}`, cls: 'dr-ask__input' })}${btn('', { v: 'primary', icon: u.busy ? '' : 'arrow-up', loading: u.busy, tip: 'Revise draft', act: 'dr-ask', data: { w: w.id }, disabled: u.busy, size: 'sm' })}</div>
      </div>` : '';
    const sources = d.cites.length ? d.cites.map((c, i) => { const doc = docById(c.doc); return `<div class="${cx('dr-src', !used.has(i + 1) && 'is-unused', u.focus === i + 1 && 'is-focus')}" id="dr-src-${w.id}-${i + 1}"><div class="row gap-8"><span class="cite" aria-hidden="true">${i + 1}</span><a class="dr-src__name truncate" href="#${docHref(c)}">${esc(doc?.name || 'Document not available')}</a></div><div class="t-xs muted mt-4">Page ${c.page}${used.has(i + 1) ? '' : ' · not cited in the text'}</div>${c.quote ? `<blockquote class="dr-src__quote">${esc(c.quote)}</blockquote>` : ''}</div>`; }).join('')
      : emptyState({ icon: 'quote', title: 'No sources cited', desc: 'Ask for changes that draw on your sources.', compact: true });
    const cur = d.html, curIdx = d.versions.map(v => v.html).lastIndexOf(cur);
    const versions = d.versions.length ? [...d.versions].map((v, i) => [v, i]).reverse().map(([v, i]) => `<div class="dr-ver"><div class="grow" style="min-width:0"><div class="medium truncate">${esc(v.note || 'Version')}</div><div class="t-xs muted">${esc(rel(v.at))} · ${plural(words(v.html), 'word')}</div></div>${i === curIdx ? chip('Current', { size: 'sm', variant: 'tertiary' }) : can && v.html !== cur ? btn('Restore', { size: 'sm', v: 'ghost', act: 'dr-restore', data: { w: w.id, i } }) : ''}</div>`).join('')
      : emptyState({ icon: 'history', title: 'No versions yet', desc: 'Each revision you ask for is saved here.', compact: true });
    // Content first: the citations and versions rail opens on demand (header "N citations …", ⋯ Version history, or a citation in the text).
    return `<div class="${cx('dr', u.rail && 'has-rail')}" data-w="${w.id}">
      <div class="dr-main">
        ${reviewNote(w, ctx)}
        <div class="dr-paper">
          ${toolbar}
          <div class="dr-body" id="dr-body-${w.id}" data-w="${w.id}" ${can ? `contenteditable="true" data-input="dr-edit" role="textbox" aria-multiline="true" aria-label="Draft text" spellcheck="true"` : ''}${u.busy ? ' aria-busy="true"' : ''}>${bodyHtml(w, can)}</div>
          <div class="dr-foot t-xs muted">${plural(words(d.html), 'word')} · ${esc(typeLabel(type))}</div>
        </div>
        ${ask}
      </div>
      ${u.rail ? `<aside class="dr-rail" aria-label="Citations and versions">
        <div class="dr-rail__head">${seg({ value: u.tab, options: [['sources', 'Citations'], ['versions', 'Versions']], act: 'dr-tab', data: { w: w.id }, label: 'Citations and versions', full: true })}${iconBtn('x', 'Close panel', { size: 'sm', act: 'dr-rail', data: { w: w.id } })}</div>
        <div class="t-xs muted dr-rail__meta">${u.tab === 'versions' ? plural(d.versions.length, 'version') : esc(drSourceLine(w))}</div>
        <div class="dr-rail__list">${u.tab === 'versions' ? versions : sources}</div>
      </aside>` : ''}
    </div>`;
  }
  /** A citation in the text opens the rail on that citation (never a second panel). */
  function drCite(w, p) {
    const u = dru(w); u.rail = true; u.tab = 'sources'; u.focus = +p.n || 0; refresh();
    requestAnimationFrame(() => $(`#dr-src-${w.id}-${u.focus}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  A['dr-tab'] = el => { const w = W(el.dataset.w); if (!w) return; dru(w).tab = el.dataset.value; refresh(); };
  /** Toggle the rail; data-tab opens it on that tab (a click on the tab that is already open closes it). */
  A['dr-rail'] = el => {
    const w = W(el.dataset.w || el.dataset.id); if (!w) return; const u = dru(w), tab = el.dataset.tab || (el.dataset.id ? 'sources' : '');
    u.rail = tab && u.rail && u.tab !== tab ? true : !u.rail;
    if (tab) u.tab = tab;
    refresh();
  };

  /* Autosave: the stored HTML updates on every keystroke; persisting and the indicator are debounced. */
  let saveTimer = 0;
  A['dr-edit'] = el => {
    const w = W(el.dataset.w); if (!w) return;
    w.data.html = serialize(el);
    const ind = $('#dr-saved'); if (ind) ind.innerHTML = `${spinner('sm')}Saving…`;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveWork(w); const i = $('#dr-saved'); if (i) i.innerHTML = `${ic('check', 'i-sm')}Saved`; const f = el.closest('.dr-paper')?.querySelector('.dr-foot'); if (f) f.textContent = `${plural(words(w.data.html), 'word')} · ${typeLabel(drType(w))}`; }, 700);
  };
  // Toolbar buttons keep the caret in the editor.
  document.addEventListener('mousedown', e => { if (e.target.closest?.('.dr-tool')) e.preventDefault(); });
  A['dr-cmd'] = el => {
    const body = el.closest('.dr-paper')?.querySelector('.dr-body'); if (!body) return;
    if (!body.contains(document.getSelection()?.anchorNode)) { body.focus(); const r = document.createRange(); r.selectNodeContents(body); r.collapse(false); const s = document.getSelection(); s.removeAllRanges(); s.addRange(r); }
    const cmd = el.dataset.cmd;
    if (cmd === 'heading') { const cur = String(document.queryCommandValue('formatBlock') || '').toLowerCase(); document.execCommand('formatBlock', false, /^h[23]$/.test(cur) ? 'p' : 'h3'); }
    else if (cmd === 'bold') document.execCommand('bold');
    else if (cmd === 'bullets') document.execCommand('insertUnorderedList');
    else if (cmd === 'undo') document.execCommand('undo');
    A['dr-edit'](body);
  };

  /* Ask for changes: simulated revision → new version */
  const tmp = html => { const t = document.createElement('div'); t.innerHTML = html; return t; };
  const SENT = /(?<=[.!?](?:\s\[\d+\])*)\s+(?=[A-ZÀ-Ỵ“"])/;
  const REVISE = [
    [/short|concise|trim|cut|brief|tighten/i, 'Shorter', (w, html) => {
      const t = tmp(html);
      t.querySelectorAll('p').forEach(p => { if (/^(dear|hello|hi|thanks|best|yours)\b/i.test(p.textContent.trim()) || p.querySelector('b') && p.textContent.startsWith('Subject')) return; const s = p.innerHTML.split(SENT); if (s.length > 1) p.innerHTML = s.slice(0, Math.ceil(s.length / 2)).join(' '); });
      t.querySelectorAll('ul,ol').forEach(l => [...l.children].slice(3).forEach(li => li.remove()));
      const heads = [...t.querySelectorAll('h3')]; if (heads.length > 2) { const last = heads[heads.length - 1]; let n = last.nextElementSibling; last.remove(); while (n && !/^H[23]$/.test(n.tagName)) { const x = n.nextElementSibling; n.remove(); n = x; } }
      return t.innerHTML;
    }],
    [/formal|professional|academic/i, 'More formal', (w, html) => {
      const map = [[/\bdon['’]t\b/gi, 'do not'], [/\bcan['’]t\b/gi, 'cannot'], [/\bwon['’]t\b/gi, 'will not'], [/\bit['’]s\b/gi, 'it is'], [/\bwe['’]re\b/gi, 'we are'], [/\bI['’]m\b/g, 'I am'], [/\bHi\b/g, 'Dear'], [/\bHello\b/g, 'Dear'], [/\bThanks,/g, 'Yours sincerely,'], [/\bBest regards,/g, 'Yours sincerely,'], [/\bHappy to\b/g, 'I would be glad to'], [/\bCould you take a look this week\?/g, 'I would be grateful for your comments this week.'], [/\ba lot of\b/gi, 'considerable'], [/\bbig\b/g, 'substantial'], [/\bget\b/g, 'obtain'], [/\bshows\b/g, 'demonstrates'], [/\bshowed\b/g, 'demonstrated'], [/\bbuilt\b/g, 'developed'], [/\byet\b/g, 'however,'], [/\bQuestions\?/g, 'Should you have questions,'], [/ — the teaching team reads every one\./g, '; the teaching team will respond.']];
      return mapText(html, map);
    }],
    [/friend|casual|warm|less formal|informal/i, 'Friendlier', (w, html) => mapText(html, [[/\bDear\b/g, 'Hi'], [/\bYours sincerely,/g, 'Thanks,'], [/\bdo not\b/g, 'don’t'], [/\bcannot\b/g, 'can’t'], [/\bI would be grateful for your comments\b/g, 'Let me know what you think'], [/\bIf anything is unclear, send your question to the teaching team from the course space\./g, 'Questions? Ask in the course space — we read every one.']])],
    [/budget|cost/i, 'Cost breakdown', (w, html) => html + '<h3>Cost breakdown</h3><p>Each cost item below is linked to a planned activity and kept to the minimum needed.</p><ul><li><b>People (60%)</b> — engineering time for build and rollout.</li><li><b>Infrastructure (25%)</b> — environments, licences and monitoring.</li><li><b>Contingency (15%)</b> — held by the project owner.</li></ul>'],
    [/timeline|schedule|milestone|work ?plan|rollout/i, 'Timeline', (w, html) => html + '<h3>Timeline</h3><ul><li><b>Weeks 1–2</b> — agree scope, owners and success measures.</li><li><b>Weeks 3–6</b> — build and test in staging.</li><li><b>Weeks 7–8</b> — staged rollout with monitoring.</li><li><b>Week 9</b> — review results and close out.</li></ul>'],
    [/objective|aim|goal/i, 'Objectives', (w, html) => /<h3>Objectives<\/h3>/.test(html) ? html : html + '<h3>Objectives</h3><ol><li>State the problem in measurable terms.</li><li>Test the approach with real traffic in staging.</li><li>Share results and decisions openly.</li></ol>'],
    [/long|expand|detail|elaborate/i, 'Longer', (w, html) => {
      const wr = reuse(w); const used = new Set(w.data.cites.map(c => c.doc));
      const extra = (w.sources || []).filter(id => docById(id)).sort((a, b) => used.has(a) - used.has(b)).slice(0, 2).map(id => wr.say(paperSentence(id))).join(' ');
      return { html: html + (extra ? `<p>${extra}</p>` : '<p>Each point above draws on the selected sources; the full evidence is listed in the Sources panel.</p>'), cites: wr.cites };
    }],
  ];
  function mapText(html, map) {
    const t = tmp(html); const walk = n => n.childNodes.forEach(c => { if (c.nodeType === 3) map.forEach(([re, to]) => (c.nodeValue = c.nodeValue.replace(re, to))); else walk(c); });
    walk(t); return t.innerHTML;
  }
  /** A writer that keeps existing citation numbers. */
  function reuse(w) { const wr = writer(); wr.cites.push(...(w.data.cites || [])); return wr; }

  A['dr-ask'] = async el => {
    const w = W(el.dataset.w); if (!w || !canEditWork(w)) return; const u = dru(w);
    const q = String(el.dataset.q || u.ask || $('#dr-ask-' + w.id)?.value || '').trim(); if (!q || u.busy) return;
    const body = $('#dr-body-' + w.id); if (body) w.data.html = serialize(body);
    const rule = REVISE.find(([re]) => re.test(q));
    let note = rule?.[1], fn = rule?.[2];
    if (!rule) {
      const m = q.match(/^(?:please\s+)?add\s+(?:an?\s+|the\s+)?(.{3,60})$/i);
      if (!m) { u.hint = 'Try “shorter”, “more formal”, “friendlier”, “longer” or “add …” (a section such as a timeline).'; refresh(); $('#dr-ask-' + w.id)?.focus(); return; }
      const topic = m[1].replace(/[.!]+$/, ''); note = 'Added ' + topic;
      fn = (ww, html) => { const wr = reuse(ww); const src = (ww.sources || []).map(id => { const f = finding(id, 'Result'); return f.cite ? f : null; }).filter(Boolean)[0]; return { html: html + `<h3>${esc(topic.charAt(0).toUpperCase() + topic.slice(1))}</h3><p>${src ? wr.say([`This section addresses ${topic.toLowerCase()}. It builds on the evidence that ${lc(src.text)}`, src.cite, '.']) : `This section addresses ${esc(topic.toLowerCase())}.`}</p>`, cites: wr.cites }; };
    }
    u.busy = true; u.hint = ''; refresh();
    await sleep(1200);
    const before = w.data.html; const res = fn(w, before); const html = typeof res === 'string' ? res : res.html;
    u.busy = false; u.ask = '';
    if (html === before) { u.hint = `Nothing to change for “${q}” — the draft already reads that way.`; refresh(); return; }
    const v = (w.data.versions ??= []);
    if (!v.length || v[v.length - 1].html !== before) v.push({ at: w.updated || Date.now(), html: before, note: v.length ? 'Your edits' : 'Original draft' });
    w.data.html = html; if (res.cites) w.data.cites = res.cites;
    v.push({ at: Date.now(), html, note: note === q ? q : `${note}${note.toLowerCase() === q.toLowerCase() ? '' : ` — “${q}”`}` });
    saveWork(w); refresh();
    toast(`Revised: ${note.toLowerCase()}`, { action: { label: 'Undo', run: () => { w.data.html = before; v.push({ at: Date.now(), html: before, note: 'Undid “' + note.toLowerCase() + '”' }); saveWork(w); refresh(); } } });
  };
  A['dr-restore'] = el => {
    const w = W(el.dataset.w); const v = w?.data.versions?.[+el.dataset.i]; if (!v) return;
    const body = $('#dr-body-' + w.id); if (body) w.data.html = serialize(body);
    const list = w.data.versions;
    if (list[list.length - 1]?.html !== w.data.html) list.push({ at: Date.now(), html: w.data.html, note: 'Your edits' });
    w.data.html = v.html; list.push({ at: Date.now(), html: v.html, note: `Restored “${v.note}”` });
    saveWork(w); refresh(); toast('Version restored');
  };

  /* Review loop: the author sends, the reviewer approves or requests changes, the author hears back in Inbox. */
  function drActions(w, ctx) {
    const st = w.status;
    if (ctx.isOwner) {
      const reviewer = reviewerFor(w);
      if (EDITABLE.includes(st)) return reviewer ? btn(st === 'changes' ? 'Send for review again' : 'Send for review', { v: 'primary', icon: 'send', act: 'dr-send', data: { w: w.id } }) : '';
      if (st === 'in_review') return btn('Back to draft', { icon: 'pencil', act: 'dr-withdraw', data: { w: w.id } });
      if (st === 'approved') return btn('Reopen to edit', { icon: 'pencil', act: 'dr-reopen', data: { w: w.id } });
      return '';
    }
    // Reviewers decide: one primary, the other path secondary.
    if (ctx.isReviewer && st === 'in_review') return btn('Request changes', { v: 'secondary', icon: 'message', act: 'dr-changes', data: { w: w.id } }) + btn('Approve', { v: 'primary', icon: 'check', act: 'dr-approve', data: { w: w.id } });
    return '';
  }
  function review(w, kind, note = '', status) {
    const snap = { status: w.status, reviewer: w.reviewer, visibility: w.visibility, n: (w.reviews ??= []).length };
    w.reviews.push({ by: me().id, at: Date.now(), kind, ...(note ? { note } : {}) });
    w.status = status;
    saveWork(w); refresh();
    return () => { w.status = snap.status; w.reviewer = snap.reviewer; w.visibility = snap.visibility; w.reviews.length = snap.n; saveWork(w); refresh(); };
  }
  A['dr-send'] = el => {
    const w = W(el.dataset.w); if (!w) return; const body = $('#dr-body-' + w.id); if (body) w.data.html = serialize(body);
    const reviewer = reviewerFor(w); if (!reviewer) return;
    const prevVis = w.visibility;
    w.reviewer = reviewer; if (w.space) w.visibility = 'space';
    const undo = review(w, 'requested', '', 'in_review');
    if (prevVis !== w.visibility) audit('Shared work to space', w.title);
    audit('Sent a draft for review', `${w.title} → ${actorName(reviewer)}`);
    toast(`Sent to ${actorName(reviewer)} for review`, { action: { label: 'Undo', run: undo } });
  };
  A['dr-withdraw'] = el => { const w = W(el.dataset.w); if (!w) return; const undo = review(w, 'withdrawn', '', 'draft'); audit('Withdrew a draft from review', w.title); toast('Back to draft. You can edit it again', { action: { label: 'Undo', run: undo } }); };
  A['dr-reopen'] = el => { const w = W(el.dataset.w); if (!w) return; const undo = review(w, 'reopened', '', 'draft'); audit('Reopened an approved draft', w.title); toast('Reopened. Send it for review again when you’re done', { action: { label: 'Undo', run: undo } }); };
  A['dr-approve'] = el => {
    const w = W(el.dataset.w); if (!w || w.status !== 'in_review') return;
    const undo = review(w, 'approved', '', 'approved');
    audit('Approved a draft', w.title);
    toast(`Approved. ${firstName(w.owner)} will be notified`, { action: { label: 'Undo', run: undo } });
  };
  /* Request changes: a note is required, so the author knows what to fix. */
  A['dr-changes'] = el => { S.ui.drChanges = { text: '', err: '' }; openModal('dr-changes', { w: el.dataset.w }); };
  M['dr-changes'] = p => {
    const w = W(p.w), f = ui('drChanges', { text: '', err: '' });
    return {
      title: 'Request changes', icon: 'message', size: 'md',
      desc: `${esc(actorName(w?.owner))} sees your note and can edit the draft again.`,
      body: field({ id: 'dr-changes-text', label: 'What should change?', required: true, error: f.err, control: textarea({ id: 'dr-changes-text', bind: 'drChanges.text', value: f.text, rows: 4, placeholder: 'For example: add the rollback plan and cite the incident runbook.', invalid: !!f.err, attrs: 'data-autofocus' }) }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Request changes', { v: 'primary', icon: 'send', act: 'dr-changes-ok', data: { w: p.w } }),
    };
  };
  A['dr-changes-ok'] = el => {
    const w = W(el.dataset.w), f = ui('drChanges'); if (!w) return;
    const note = String(f.text || '').trim();
    if (!note) { f.err = 'Say what should change.'; refreshLayer(); $('#dr-changes-text')?.focus(); return; }
    closeModal();
    const undo = review(w, 'changes', note, 'changes');
    audit('Requested changes on a draft', w.title);
    toast(`Sent to ${firstName(w.owner)}`, { action: { label: 'Undo', run: undo } });
  };
  /** Inbox: reviewers hear about drafts waiting for them; authors hear the decision. Ids carry the event so read state sticks. */
  X.workNotices = () => {
    if (!hasModule('work')) return [];
    const out = [], uid_ = me().id;
    (D.works || []).filter(w => w.kind === 'draft').forEach(w => {
      const r = lastReview(w); if (!r || r.by === uid_) return;
      const id = `wrv-${w.id}-${w.reviews.length}-${uid_}`, to = '/work/' + w.id;
      if (w.status === 'in_review' && r.kind === 'requested' && w.reviewer === uid_) out.push({ id, icon: 'send', tone: 'info', title: `${actorName(w.owner)} sent a draft for your review`, body: w.title, at: r.at, to, needs: true });
      else if (w.owner === uid_ && r.kind === 'approved' && w.status === 'approved') out.push({ id, icon: 'check-circle', tone: 'ok', title: `${actorName(r.by)} approved your draft`, body: w.title, at: r.at, to });
      else if (w.owner === uid_ && r.kind === 'changes' && w.status === 'changes') out.push({ id, icon: 'message', tone: 'warn', title: `${actorName(r.by)} requested changes`, body: `${w.title} · “${r.note}”`, at: r.at, to, needs: true });
    });
    return out;
  };

  /* Exports (used by the shell's Download menu) */
  function drExportHtml(w) {
    const d = w.data;
    return `${d.html}${d.cites?.length ? `<h3>Sources</h3><ol>${d.cites.map(c => `<li>${esc(docById(c.doc)?.name || c.doc)}, p. ${c.page}${c.quote ? ` — “${esc(c.quote)}”` : ''}</li>`).join('')}</ol>` : ''}`;
  }
  function drExportLines(w) {
    const t = tmp(w.data.html || ''); const out = [];
    const wrap = s => { const r = []; let line = ''; s.split(/\s+/).forEach(x => { if ((line + ' ' + x).trim().length > 88) { r.push(line); line = x; } else line = (line + ' ' + x).trim(); }); if (line) r.push(line); return r; };
    [...t.children].forEach(n => {
      if (/^H\d$/.test(n.tagName)) out.push('', n.textContent.toUpperCase());
      else if (/^(UL|OL)$/.test(n.tagName)) [...n.children].forEach((li, i) => out.push(...wrap((n.tagName === 'OL' ? `${i + 1}. ` : '- ') + li.textContent)));
      else { n.querySelectorAll('br').forEach(b => b.replaceWith(' / ')); out.push(...wrap(n.textContent), ''); }
    });
    if (w.data.cites?.length) { out.push('', 'SOURCES'); w.data.cites.forEach((c, i) => out.push(...wrap(`[${i + 1}] ${docById(c.doc)?.name || c.doc}, p. ${c.page}`))); }
    while (out[0] === '') out.shift();
    return out;
  }

  WORK_KINDS.draft = {
    label: 'Draft', icon: 'pencil', noun: 'draft', layout: 'doc', initialStatus: 'draft',
    options: drOptions,
    title: ctx => {
      const sp = spOf(ctx?.space), o = ctx?.options || {}, docs = idsOf(ctx?.sources);
      const t = o.type || defaultType(sp, docs);
      if (t === 'decision' && docs.includes('fx-eng-adr027')) return 'ADR — Ledger service design';
      return `${typeLabel(t)}${sp ? ' — ' + sp.name : ''}`;
    },
    generate: drGenerate,
    render: drRender,
    actions: drActions,
    sourcesAct: 'dr-rail',
    onCite: drCite,
    sourceLine: drSourceLine,
    menu: w => [{ label: 'Version history', icon: 'history', run: () => { const u = dru(w); u.rail = true; u.tab = 'versions'; refresh(); } }],
    summary: w => `${typeLabel(drType(w))} · ${plural(words(w.data?.html), 'word')}`,
    exportHtml: drExportHtml,
    exportLines: drExportLines,
  };
})();

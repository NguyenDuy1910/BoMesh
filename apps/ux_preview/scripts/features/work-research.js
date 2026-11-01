/* Research work kinds — registered into WORK_KINDS (core/workspace.js) and
   rendered by the generic Work shell (features/work.js).
   review: literature review / evidence matrix (papers × criteria, every cell cited).
   draft:  a grounded document draft with an editor, sources rail, revisions and versions.
   Prefixes: rv- (review), dr- (draft). */
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

  /** Paper metadata parsed from library names like "Nguyen et al. 2024 — Title.pdf". */
  function paper(id) {
    const d = docById(id);
    if (!d) return { id, title: 'Document not available', authors: '', year: '', short: 'Unavailable', doc: null };
    const base = d.name.replace(/\.[^.]+$/, '');
    const m = base.match(/^(.+?)\s+((?:19|20)\d\d)\s+[—–-]\s+(.+)$/);
    const authors = m ? m[1] : d.addedBy || '', year = m ? m[2] : '';
    return { id, title: m ? m[3] : base, authors, year, short: m ? `${authors} ${year}` : base, doc: d, parsed: !!m };
  }
  const paperDocs = sp => X.work.docsForSpace(sp).filter(d => d && !d.archived);

  /* ═══════════════ Evidence bank (canned "retrieval" for the lab library) ═══════════════
     BANK[doc][key] = [finding, page, quote]. Keys come from criterion labels (critKey). */
  const BANK = {
    'du-ag-p1': {
      method: ['Fine-tuned MobileNetV3 (ImageNet-pretrained).', 4, 'We fine-tune a MobileNetV3-Large pretrained on ImageNet, freezing the first 10 blocks.'],
      data: ['4,800 field images, 5 rice diseases, Mekong Delta.', 5, 'The dataset contains 4,800 images of rice leaves collected in Can Tho and An Giang across five disease classes.'],
      result: ['96.2% accuracy; 21 ms per image on a phone.', 9, 'The fine-tuned model reached 96.2% accuracy with 21 ms inference on a mid-range Android phone.'],
      limit: ['Single season; no night or rain images.', 12, 'All images were taken in the dry season under daylight; performance in rain is untested.'],
      hardware: ['Runs on a mid-range Android phone (TFLite).', 8, 'All latency measurements were taken on a Snapdragon 680 phone with on-device TensorFlow Lite inference.'],
      field: ['Field images, but dry season and daylight only.', 5, 'Images were captured in farmers’ fields between 7:00 and 16:00 during the 2023 dry season.'],
      cost: ['No extra hardware: uses farmers’ own phones.', 13, 'Because inference runs on phones farmers already own, deployment requires no additional hardware cost.'],
    },
    'du-ag-p2': {
      method: ['Survey of 120 studies (2015–2022).', 2, 'We review 120 peer-reviewed studies on deep learning for crop disease detection published between 2015 and 2022.'],
      data: ['Mostly PlantVillage (lab images).', 14, '68% of the surveyed studies evaluate only on PlantVillage, whose images are taken on uniform backgrounds.'],
      result: ['Transfer learning dominates (71%).', 9, 'Transfer learning dominates recent work: 71% of the studies fine-tune ImageNet-pretrained CNNs.'],
      limit: ['Lab-to-field gap rarely measured.', 27, 'Few studies report accuracy on field images, so the lab-to-field gap remains largely unmeasured.'],
      hardware: ['Only 9% of studies test on edge devices.', 21, 'Only 9% of the surveyed studies report inference on edge devices such as phones or single-board computers.'],
      field: ['Field accuracy reported by 14% of studies.', 24, 'Only 14% of studies report accuracy on images taken under field conditions.'],
      cost: ['Deployment cost discussed in under 10%.', 29, 'Deployment cost is discussed in fewer than one in ten studies.'],
    },
    'du-ag-p3': {
      method: ['Quantized CNN on ESP32-S3 for soil moisture.', 3, 'An 8-bit quantized CNN runs on an ESP32-S3 to classify soil moisture states from capacitive sensor traces.'],
      data: ['42 days of sensor traces, 3 plots.', 5, 'Data were logged every 5 minutes for 42 days on three experimental plots.'],
      result: ['92% accuracy at 38 mW.', 8, 'The model classified soil moisture states with 92% accuracy at 38 mW average power.'],
      limit: ['Not a vision task; different sensor domain.', 10, 'Our approach targets sensor time series and does not address image-based disease detection.'],
      hardware: ['ESP32-S3 node with capacitive sensors and LoRa.', 4, 'Each node combines an ESP32-S3 microcontroller, two capacitive soil moisture sensors and a LoRa radio.'],
      field: ['Outdoor plots for 42 days, incl. heavy rain.', 6, 'The nodes ran unattended on three outdoor plots for 42 days, including six days of heavy rain.'],
      cost: ['About USD 18 per node.', 9, 'The bill of materials per node is approximately USD 18.'],
      energy: ['38 mW average; months on a small solar panel.', 8, 'Average power was 38 mW, allowing operation for several months with a small solar panel.'],
    },
    'du-ag-p4': {
      method: ['Duty-cycled LoRaWAN network with adaptive sampling.', 3, 'We propose an adaptive sampling scheme that lowers the reporting rate when the water level changes slowly.'],
      data: ['One season, 24 nodes over 6 ha of paddy.', 5, 'We deployed 24 sensor nodes across 6 hectares of paddy in Long An over one growing season.'],
      result: ['Battery life up from 4 to 11 months.', 7, 'Adaptive sampling extended the expected battery life from 4 to 11 months with no loss of event detection.'],
      limit: ['Sensing only; no on-device inference.', 8, 'The nodes only transmit raw readings; no inference is performed on the device.'],
      hardware: ['STM32L0 + SX1276 LoRa nodes, one gateway.', 4, 'Nodes use an STM32L0 microcontroller and an SX1276 LoRa transceiver; a single gateway covers the site.'],
      field: ['Flooded paddy through the monsoon; >97% delivery.', 6, 'Nodes operated through the monsoon season with packet delivery above 97%.'],
      cost: ['USD 25 per node; USD 300 gateway.', 9, 'Each node costs about USD 25; the gateway costs about USD 300.'],
      energy: ['0.9 mW average with adaptive sampling.', 7, 'Average consumption fell to 0.9 mW with adaptive sampling.'],
    },
    'du-ag-p5': {
      method: ['ViT-B/16 with field-condition augmentation.', 5, 'We train a ViT-B/16 with augmentations that simulate occlusion, glare and motion blur.'],
      data: ['PlantVillage + 3,100 field images.', 6, 'Training combines PlantVillage with 3,100 in-field images from India and Vietnam.'],
      result: ['93.4% in the field vs 99.1% in the lab.', 11, 'Accuracy drops from 99.1% on lab images to 93.4% on field images.'],
      limit: ['Too heavy for edge devices.', 14, 'The model needs 330 ms per image on a Jetson Nano, too slow for real-time use.'],
      hardware: ['Jetson Nano and desktop GPU benchmarks.', 13, 'We benchmark inference on an NVIDIA Jetson Nano and a desktop RTX 3080.'],
      field: ['Held-out field set with occlusion and glare.', 10, 'We evaluate separately on held-out field images with occlusion, glare and cluttered backgrounds.'],
      energy: ['Jetson Nano in 10 W mode.', 13, 'All edge measurements use the Jetson Nano in its 10 W power mode.'],
    },
    'du-ag-p6': {
      method: ['NIR-modified camera + NDVI/red-edge classifier.', 3, 'We convert a low-cost camera module by replacing its IR-cut filter, and classify blight from NDVI and red-edge features.'],
      data: ['1,250 leaf images, 2 blight stages, Tien Giang.', 5, '1,250 leaf images were collected in Tien Giang covering healthy leaves and two stages of bacterial leaf blight.'],
      result: ['Detects blight 4–6 days before visible symptoms.', 8, 'Multispectral features detected bacterial leaf blight 4–6 days before symptoms were visible in RGB images.'],
      limit: ['Small dataset; needs a reference panel.', 11, 'Results depend on a reference panel for illumination correction, and the dataset is small.'],
      hardware: ['Raspberry Pi 4 with a modified 12 MP camera.', 4, 'The imaging unit is a Raspberry Pi 4 with a modified 12 MP camera module.'],
      field: ['Captured in the field with a grey panel in frame.', 6, 'All images were captured in the field with a grey reference panel in frame.'],
      cost: ['About USD 60 per imaging unit.', 4, 'The complete imaging unit costs about USD 60, versus USD 3,000+ for commercial multispectral cameras.'],
    },
    'du-gr-naf': {
      method: ['Funding call: basic research, up to 24 months.', 3, 'Priority areas for 2027 include applied artificial intelligence for agriculture and the environment. Projects may last up to 24 months.'],
      cost: ['Budget cap VND 1.5 billion; equipment ≤ 30%.', 7, 'Budgets for basic research projects may not exceed VND 1.5 billion; equipment may account for at most 30% of the total.'],
      limit: ['PI needs a PhD and 2 indexed papers in 5 years.', 5, 'Applicants must hold a doctoral degree and have at least two ISI/Scopus publications in the last five years.'],
    },
  };
  /* Extra passages the drafts cite (not matrix criteria). */
  const PASSAGES = {
    'du-gr-naf': [[9, 'Proposals must include a budget justification for each cost item, linked to the planned activities.']],
    'du-gr-tpl': [[2, 'Section B.1 Background and significance (max 2 pages): state the problem, the state of the art and the gap the project addresses.']],
    'du-ag-data': [[1, 'UTE-RiceLeaf v2 contains 6,200 labelled rice leaf images from 14 farms, including 900 taken in rain.']],
    'du-ml-syl': [[2, 'The midterm (30%) covers weeks 1–7 and is closed-book; one A4 page of handwritten notes is allowed.']],
  };
  const CRIT_KEYS = [
    [/method|approach|model|technique|architecture|algorithm|design/i, 'method'],
    [/data|sample|corpus/i, 'data'],
    [/result|accuracy|performance|finding|outcome|effect/i, 'result'],
    [/limit|weakness|shortcoming|caveat|threat/i, 'limit'],
    [/hardware|device|edge|deploy|platform|compute/i, 'hardware'],
    [/field|real.?world|in.?situ|condition|robust|environment/i, 'field'],
    [/cost|price|budget|afford/i, 'cost'],
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
  /** The finding for one paper × criterion: { text, cite } or { text, cite: null, none: true }. */
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
    if (!q) { const f = finding(docId, label); return f.none ? { ...f, text: 'Not reported in this paper.' } : f; }
    let s = q.replace(/^(we|our|in this (paper|study),?|this (paper|study))\s+/i, '').replace(/\s+/g, ' ');
    s = s.split(/;|, (?:so|which|whose|and|but|allowing|freezing|while)\b/)[0].replace(/\.$/, '');
    if (s.length > 80) { const cut = Math.max(...[', ', ' on ', ' in ', ' for ', ' from ', ' at ', ' across ', ' with '].map(b => s.lastIndexOf(b, 80))); if (cut > 30) s = s.slice(0, cut); }
    s = s.charAt(0).toUpperCase() + s.slice(1) + '.';
    if (s === cell.text) s = finding(docId, label).text;
    return { text: s, cite: cell.cite };
  }

  /* ═══════════════ Review (evidence matrix) ═══════════════ */
  const DEFAULT_CRITERIA = ['Method', 'Dataset', 'Result', 'Limitations'];
  const SUGGESTED_CRITERIA = ['Hardware', 'Field conditions', 'Cost', 'Energy use'];
  const DEFAULT_IDS = { Method: 'method', Dataset: 'data', Result: 'result', Limitations: 'limit' };
  const critId = label => DEFAULT_IDS[label] || uid('c');
  const rvu = w => ui('rv:' + w.id, { pendingRows: {}, pendingCols: {}, synth: false, fresh: {} });

  function rvOptions(f) {
    const o = (f.opts ??= {}); o.criteria ??= [...DEFAULT_CRITERIA]; o.maxPapers ??= 6;
    const all = [...new Set([...DEFAULT_CRITERIA, ...SUGGESTED_CRITERIA, ...o.criteria])];
    const chips = all.map(l => `<button type="button" class="rv-chip" aria-pressed="${o.criteria.includes(l)}" data-act="rv-opt-crit" data-label="${esc(l)}">${o.criteria.includes(l) ? ic('check', 'i-sm') : ic('plus', 'i-sm')}${esc(l)}</button>`).join('');
    return `<div class="stack gap-16">
      ${field({ id: 'rv-opt-new', label: 'Compare papers on', desc: 'Each criterion becomes a column. Every cell cites the passage it comes from.', control: `<div class="rv-chips" role="group" aria-label="Criteria">${chips}</div><div class="row gap-8 mt-8">${input({ id: 'rv-opt-new', bind: 'workNew.opts.critNew', value: o.critNew || '', placeholder: 'Add your own, e.g. Sample size', onEnter: 'rv-opt-crit-add', size: 'sm' })}${btn('Add', { size: 'sm', act: 'rv-opt-crit-add' })}</div>` })}
      ${field({ id: 'rv-opt-max', label: 'Papers at most', control: seg({ value: o.maxPapers, options: [[4, '4'], [6, '6'], [8, '8']], act: 'rv-opt-max', label: 'Papers at most' }) })}
    </div>`;
  }
  A['rv-opt-crit'] = el => { const o = ui('workNew').opts; const l = el.dataset.label; o.criteria = o.criteria.includes(l) ? o.criteria.filter(x => x !== l) : [...o.criteria, l]; refresh(); };
  A['rv-opt-crit-add'] = () => {
    const o = ui('workNew').opts; const l = String(o.critNew || $('#rv-opt-new')?.value || '').trim(); if (!l) return;
    if (!o.criteria.some(x => x.toLowerCase() === l.toLowerCase())) o.criteria.push(l);
    o.critNew = ''; refresh(); $('#rv-opt-new')?.focus();
  };
  A['rv-opt-max'] = el => { ui('workNew').opts.maxPapers = +el.dataset.value; refresh(); };

  function rvGenerate(ctx) {
    const sp = spOf(ctx.space), o = ctx.options || {};
    let papers = idsOf(ctx.sources).filter(id => docById(id));
    if (!papers.length) papers = paperDocs(sp).filter(d => /\b(19|20)\d\d\s+[—–-]/.test(d.name)).map(d => d.id);
    papers = papers.slice(0, +o.maxPapers || 6);
    const labels = (o.criteria?.length ? o.criteria : DEFAULT_CRITERIA);
    const criteria = labels.map(label => ({ id: critId(label), label }));
    const cells = {};
    papers.forEach(p => { cells[p] = {}; criteria.forEach(c => { cells[p][c.id] = finding(p, c.label); }); });
    return { papers, criteria, cells, maxPapers: +o.maxPapers || 6 };
  }

  function rvRender(w, ctx) {
    const d = w.data, u = rvu(w), can = ctx.canEdit;
    d.papers ??= []; d.criteria ??= []; d.cells ??= {};
    const meta = `${plural(d.papers.length, 'paper')} · ${plural(d.criteria.length, 'criterion', 'criteria')}`;
    const tools = can ? `<div class="row gap-8 wrap">${btn('Add paper', { icon: 'plus', size: 'sm', act: 'rv-add-paper', data: { w: w.id } })}${btn('Add criterion', { icon: 'plus', size: 'sm', act: 'rv-add-crit', data: { w: w.id } })}${btn(d.synthesis ? 'Update synthesis' : 'Synthesize', { v: 'secondary', icon: 'sparkles', size: 'sm', act: 'rv-synth', data: { w: w.id }, loading: u.synth, disabled: u.synth || !d.papers.length || !d.criteria.length })}</div>` : '';
    return `<div class="rv">
      ${u.synth ? synthSkeleton() : d.synthesis ? synthCard(w, can) : ''}
      <div class="rv-bar"><span class="t-sm muted">${meta}</span>${tools}</div>
      ${d.papers.length && d.criteria.length ? matrix(w, can, u) : emptyState({ icon: 'table', title: d.papers.length ? 'No criteria yet' : 'No papers yet', desc: d.papers.length ? 'Add what you want to compare, like Method or Result.' : 'Add papers from this space’s library to compare them.', actions: can ? btn(d.papers.length ? 'Add criterion' : 'Add paper', { v: 'primary', icon: 'plus', act: d.papers.length ? 'rv-add-crit' : 'rv-add-paper', data: { w: w.id } }) : '', boxed: true })}
    </div>`;
  }
  function matrix(w, can, u) {
    const d = w.data;
    const head = `<th class="table__column rv-col rv-col--paper" scope="col">Paper</th>` + d.criteria.map(c => `<th class="table__column rv-col" scope="col"><span class="rv-col__inner"><span class="truncate">${esc(c.label)}</span>${can ? iconBtn('more', `Options for ${c.label}`, { size: 'sm', menu: 'rv-col', data: { w: w.id, id: c.id } }) : ''}</span></th>`).join('');
    const rows = d.papers.map(pid => {
      const pp = paper(pid), pending = u.pendingRows[pid];
      const lead = `<th class="table__cell rv-paper" scope="row"><div class="rv-paper__inner"><div class="grow" style="min-width:0"><a class="rv-paper__title clamp-2" href="#/doc/${esc(pid)}" title="${esc(pp.title)}">${esc(pp.title)}</a><div class="t-xs muted truncate">${esc(pp.authors)}${pp.year ? ' · ' + esc(pp.year) : ''}</div></div>${can ? iconBtn('more', `Options for ${pp.title}`, { size: 'sm', menu: 'rv-row', data: { w: w.id, id: pid } }) : ''}</div></th>`;
      const cells = d.criteria.map(c => {
        if (pending || u.pendingCols[c.id]) return `<td class="table__cell rv-cell" aria-busy="true"><span class="skeleton skeleton--line" style="width:86%"></span><span class="skeleton skeleton--line mt-8" style="width:54%"></span></td>`;
        const cell = d.cells[pid]?.[c.id] || { text: '—', none: true };
        const fresh = u.fresh[c.id] || u.fresh[pid];
        return `<td class="${cx('table__cell rv-cell', cell.none && 'rv-cell--none', fresh && 'rv-cell--new')}" role="button" tabindex="0" data-act="rv-cell" data-w="${w.id}" data-p="${esc(pid)}" data-c="${esc(c.id)}" aria-label="${esc(c.label)} for ${esc(pp.short)}: ${esc(cell.text)}"><span class="rv-cell__text">${esc(cell.text)}</span>${cell.cite ? `<span class="cite" aria-hidden="true">p.${cell.cite.page}</span>` : ''}</td>`;
      }).join('');
      return `<tr class="${cx('table__row', u.fresh[pid] && 'table__row--new')}">${lead}${cells}</tr>`;
    });
    return `<div class="table-root rv-matrix"><div class="table__scroll rv-matrix__scroll" id="rv-scroll-${w.id}" data-w="${w.id}" tabindex="0" role="region" aria-label="Evidence matrix"><table class="table__content rv-table"><thead class="table__head"><tr>${head}</tr></thead><tbody class="table__body">${rows.join('')}</tbody></table></div></div>`;
  }
  function flash(w, key) { const u = rvu(w); u.fresh[key] = true; setTimeout(() => { delete u.fresh[key]; }, 1700); }
  /* The matrix keeps its horizontal position across re-renders (core only keeps vertical scroll). */
  document.addEventListener('scroll', e => { const t = e.target; if (t.classList?.contains('rv-matrix__scroll')) { const w = W(t.dataset.w); if (w) rvu(w).x = t.scrollLeft; } }, true);
  function rvAfter(w) { const sc = $('#rv-scroll-' + w.id), x = rvu(w).x; if (sc && x) sc.scrollLeft = x; }
  const scrollEnd = w => { rvu(w).x = 1e6; };

  /* Cell evidence drawer */
  A['rv-cell'] = el => openDrawer('rv-cell', { w: el.dataset.w, p: el.dataset.p, c: el.dataset.c });
  DR['rv-cell'] = p => {
    const w = W(p.w); const crit = w?.data.criteria.find(c => c.id === p.c); const cell = w?.data.cells[p.p]?.[p.c];
    if (!w || !crit || !cell) return { title: 'Finding', body: emptyState({ icon: 'file', title: 'This cell no longer exists', compact: true }) };
    const pp = paper(p.p), can = canEditWork(w);
    const finding = `<div class="t-label mb-8">${esc(crit.label)}</div><p class="rv-ev__finding">${p.busy ? `<span class="row gap-8 muted">${spinner()}Re-reading the passage…</span>` : esc(cell.text)}</p>${cell.replaced ? `<div class="t-xs muted mt-4">Replaced by you ${rel(cell.replaced)}</div>` : ''}`;
    const evidence = cell.cite ? `<div class="t-label mt-24 mb-8">Evidence</div>${evidenceBody(pp.doc, cell.cite)}`
      : `<div class="mt-24">${alertBox('default', 'No passage found', `This paper doesn’t report ${esc(crit.label.toLowerCase())}. Check the document if you expected it.`)}</div>`;
    const ref = cell.cite ? `“${cell.cite.quote}” — ${pp.parsed ? `${pp.authors} (${pp.year}), ` : ''}${pp.title}, p. ${cell.cite.page}` : '';
    return {
      title: pp.title, desc: `${esc(pp.authors)}${pp.year ? ' · ' + esc(pp.year) : ''}`, size: 'md',
      body: finding + evidence,
      footStart: can ? btn('Wrong? Replace finding', { icon: 'retry', act: 'rv-replace', loading: p.busy, disabled: p.busy }) : '',
      foot: (cell.cite ? btn('Copy', { v: 'ghost', icon: 'copy', act: 'copy', data: { text: ref, msg: 'Citation copied' } }) : '') + btn('Open document', { v: 'primary', icon: 'arrow-up-right', href: cell.cite ? docHref(cell.cite) : '/doc/' + p.p }),
    };
  };
  A['rv-replace'] = async () => {
    const p = S.drawer?.props; const w = p && W(p.w); if (!w) return;
    p.busy = true; refreshLayer(); await sleep(900);
    const crit = w.data.criteria.find(c => c.id === p.c), cells = w.data.cells[p.p], prev = cells?.[p.c];
    if (!crit || !prev) { p.busy = false; refreshLayer(); return; }
    cells[p.c] = { ...restate(prev, crit.label, p.p), replaced: Date.now() };
    p.busy = false; saveWork(w); refresh();
    toast('Finding replaced', { action: { label: 'Undo', run: () => { cells[p.c] = prev; saveWork(w); refresh(); } } });
  };

  /* Add paper */
  A['rv-add-paper'] = el => openModal('rv-add-paper', { w: el.dataset.w });
  M['rv-add-paper'] = p => {
    const w = W(p.w); const sp = spaceById(w?.space);
    const docs = paperDocs(sp).filter(d => !w.data.papers.includes(d.id)).sort((a, b) => (/\b(19|20)\d\d\s+[—–-]/.test(b.name)) - (/\b(19|20)\d\d\s+[—–-]/.test(a.name)));
    return {
      title: 'Add a paper', desc: sp ? `From ${esc(sp.name)}’s library` : 'From your library', size: 'md',
      body: docs.length ? list(docs.map(d => { const pp = paper(d.id); return item({ lead: fileIcon(d.type), title: esc(pp.title), desc: esc([pp.parsed && pp.authors, pp.year, kbById(d.kb)?.name].filter(Boolean).join(' · ')), trail: d.status !== 'ready' ? status('doc', d.status) : ic('plus', 'muted'), act: 'rv-add-paper-pick', data: { w: w.id, id: d.id } }); }), 'list--plain')
        : emptyState({ icon: 'files', title: 'Every paper is already in the matrix', desc: 'Add papers to the space’s library to compare more.', compact: true }),
      foot: btn('Cancel', { act: 'close-modal' }),
    };
  };
  A['rv-add-paper-pick'] = async el => {
    const w = W(el.dataset.w), id = el.dataset.id; if (!w || w.data.papers.includes(id)) return;
    closeModal();
    const u = rvu(w); w.data.papers.push(id); u.pendingRows[id] = true; refresh();
    requestAnimationFrame(() => { const sc = $('#rv-scroll-' + w.id); sc?.closest('.rv')?.querySelector('.table__row:last-child')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    await sleep(1100);
    if (!w.data.papers.includes(id)) return;
    w.data.cells[id] = Object.fromEntries(w.data.criteria.map(c => [c.id, finding(id, c.label)]));
    if (!w.sources?.includes(id)) (w.sources ??= []).push(id);
    delete u.pendingRows[id]; flash(w, id); saveWork(w); refresh();
    toast(`Added ${paper(id).short}`, { action: { label: 'Undo', run: () => removePaper(w, id, true) } });
  };
  function removePaper(w, id, quiet) {
    const i = w.data.papers.indexOf(id); if (i < 0) return;
    const cells = w.data.cells[id];
    w.data.papers.splice(i, 1); delete w.data.cells[id]; saveWork(w); refresh();
    if (!quiet) toast(`Removed ${paper(id).short}`, { action: { label: 'Undo', run: () => { w.data.papers.splice(i, 0, id); w.data.cells[id] = cells; saveWork(w); refresh(); } } });
  }
  MENUS['rv-row'] = el => {
    const w = W(el.dataset.w), id = el.dataset.id; if (!w) return [];
    return [
      { label: 'Open document', icon: 'file-text', run: () => go('/doc/' + id) },
      { label: 'Re-read this paper', icon: 'retry', run: async () => { const u = rvu(w); u.pendingRows[id] = true; refresh(); await sleep(900); w.data.cells[id] = Object.fromEntries(w.data.criteria.map(c => [c.id, finding(id, c.label)])); delete u.pendingRows[id]; flash(w, id); saveWork(w); refresh(); toast('Row refreshed from the paper'); } },
      { sep: true },
      { label: 'Remove paper', icon: 'trash', danger: true, run: () => removePaper(w, id) },
    ];
  };

  /* Add criterion (column) */
  A['rv-add-crit'] = el => { setPath('rvCrit', { label: '', err: '' }); openModal('rv-add-crit', { w: el.dataset.w }); };
  M['rv-add-crit'] = p => {
    const w = W(p.w); const f = getPath('rvCrit') || {}; const have = new Set(w.data.criteria.map(c => c.label.toLowerCase()));
    const sugg = SUGGESTED_CRITERIA.filter(s => !have.has(s.toLowerCase()));
    return {
      title: 'Add a criterion', desc: 'A new column. Each paper is read for it and every cell is cited.', size: 'sm',
      body: `${field({ id: 'rv-crit', label: 'Criterion', error: f.err, control: input({ id: 'rv-crit', bind: 'rvCrit.label', value: f.label, placeholder: 'e.g. Hardware', autofocus: true, onEnter: 'rv-add-crit-ok', invalid: !!f.err }) })}
        ${sugg.length ? `<div class="row gap-8 wrap mt-12">${sugg.map(s => `<button type="button" class="rv-chip" data-act="rv-crit-sugg" data-label="${esc(s)}">${ic('plus', 'i-sm')}${esc(s)}</button>`).join('')}</div>` : ''}`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Add column', { v: 'primary', act: 'rv-add-crit-ok' }),
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
    toast(found ? `${label}: evidence in ${found} of ${plural(w.data.papers.length, 'paper')}` : `${label}: not reported in any paper`, { action: { label: 'Undo', run: () => removeCrit(w, c.id, true) } });
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
  const AGRI_SYNTH = {
    consensus: [
      ['Transfer learning from ImageNet-pretrained CNNs is the dominant approach to crop disease detection.', [['du-ag-p2', 9], ['du-ag-p1', 4]]],
      ['Accuracy on clean lab images is consistently high, around 96–99%.', [['du-ag-p1', 9], ['du-ag-p5', 11]]],
      ['Low-power edge hardware makes in-field sensing practical for months without mains power.', [['du-ag-p3', 8], ['du-ag-p4', 7]]],
    ],
    disagreements: [
      ['Field accuracy: a phone CNN keeps 96.2% on field images, while a ViT drops from 99.1% in the lab to 93.4% in the field.', [['du-ag-p1', 9], ['du-ag-p5', 11]]],
      ['Model size: ViTs cope better with occlusion and glare but need 330 ms per image on a Jetson Nano, against 21 ms for MobileNetV3 on a phone.', [['du-ag-p5', 14], ['du-ag-p1', 9]]],
      ['Imaging: RGB models detect visible symptoms, while low-cost multispectral imaging flags blight 4–6 days earlier.', [['du-ag-p6', 8], ['du-ag-p1', 9]]],
    ],
    gaps: [
      ['The lab-to-field gap is rarely measured: most studies evaluate only on PlantVillage.', [['du-ag-p2', 27], ['du-ag-p2', 14]]],
      ['No study covers rainy-season or night conditions.', [['du-ag-p1', 12]]],
      ['Multispectral detection depends on a reference panel and a small dataset; it is untested on phones.', [['du-ag-p6', 11]]],
      ['Sensor networks and vision models are studied separately; none combines on-device inference with field sensing.', [['du-ag-p3', 10], ['du-ag-p4', 8]]],
    ],
  };
  function buildSynthesis(w) {
    const d = w.data, inSet = refs => refs.every(([doc]) => d.papers.includes(doc));
    const canned = k => AGRI_SYNTH[k].filter(([, refs]) => inSet(refs)).map(([text, refs]) => ({ text, cites: refs.map(([doc, pg]) => quoteAt(doc, pg)) }));
    const cellsFor = key => d.papers.map(p => { const c = d.criteria.find(x => critKey(x.label) === key); const cell = c && d.cells[p]?.[c.id]; return cell?.cite ? { p, cell, crit: c } : null; }).filter(Boolean);
    const generic = {
      consensus: () => { const m = cellsFor('method'); const any = m.length ? m : d.papers.map(p => ({ p, cell: d.cells[p]?.[d.criteria[0].id], crit: d.criteria[0] })).filter(x => x.cell?.cite); return any.length > 1 ? [{ text: `${plural(any.length, 'paper')} report comparable evidence on ${any[0].crit.label.toLowerCase()}: ${any.slice(0, 3).map(x => `${paper(x.p).short} (${lc(x.cell.text)})`).join('; ')}.`, cites: any.slice(0, 3).map(x => x.cell.cite) }] : []; },
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
    const s = w.data.synthesis; const seen = [];
    const num = c => { let i = seen.findIndex(x => x.doc === c.doc && x.page === c.page); if (i < 0) { seen.push(c); i = seen.length - 1; } return i + 1; };
    const stale = s.sig !== synthSig(w);
    const col = (title, icon, items) => `<div class="rv-synth__col"><h3 class="rv-synth__title">${ic(icon, 'i-sm')}${title}</h3>${items.length ? `<ul class="rv-synth__list">${items.map(it => `<li>${esc(it.text)} ${it.cites.map(c => citeBtn(c, num(c))).join('')}</li>`).join('')}</ul>` : '<p class="t-sm muted">Nothing stands out in this matrix.</p>'}</div>`;
    const actions = can ? (stale ? btn('Update', { size: 'sm', icon: 'retry', act: 'rv-synth', data: { w: w.id } }) : '') + iconBtn('x', 'Remove synthesis', { size: 'sm', act: 'rv-synth-hide', data: { w: w.id } }) : '';
    return `<section class="card rv-synth" aria-label="Synthesis"><div class="card__header"><span class="item-icon item-icon--accent" aria-hidden="true">${ic('sparkles')}</span><div class="grow"><h2 class="card__title">Synthesis</h2><p class="card__description">${stale ? 'The matrix changed since this was written.' : `From ${plural(w.data.papers.length, 'paper')} · ${rel(s.at)}`}</p></div><div class="row gap-4 none">${actions}</div></div>
      <div class="rv-synth__grid">${col('Consensus', 'check-circle', s.consensus)}${col('Disagreements', 'git-compare', s.disagreements)}${col('Gaps', 'target', s.gaps)}</div></section>`;
  }

  /* Header actions + exports */
  function rvActions(w, ctx) {
    const sp = spaceById(w.space);
    const canDraft = !!w.data?.papers?.length && (w.owner === me().id || !!spaceRole(sp) || !sp);
    return btn('Export CSV', { icon: 'download', act: 'rv-csv', data: { w: w.id } }) + (canDraft ? btn('Draft related work', { v: 'primary', icon: 'pencil', act: 'rv-draft', data: { w: w.id } }) : '');
  }
  function csvRows(w) {
    const d = w.data;
    return [['Paper', 'Authors', 'Year', ...d.criteria.map(c => c.label)], ...d.papers.map(p => { const pp = paper(p); return [pp.title, pp.authors, pp.year, ...d.criteria.map(c => { const cell = d.cells[p]?.[c.id]; return !cell ? '' : cell.cite ? `${cell.text} (p. ${cell.cite.page})` : cell.text; })]; })];
  }
  A['rv-csv'] = el => { const w = W(el.dataset.w); if (!w) return; saveCsv(withExt(w.title, '.csv'), csvRows(w), 'Matrix exported as CSV'); audit('Exported review', w.title); };
  A['rv-draft'] = el => {
    const w = W(el.dataset.w); if (!w) return;
    const title = 'Related work — ' + w.title.replace(/\s*[—–-]\s*evidence matrix$/i, '');
    const opts = { type: 'litreview', tone: 'formal', length: 'medium', fromReview: w.id };
    X.work.create({ kind: 'draft', workflow: 'draft', title, space: w.space, sources: [...w.data.papers], options: opts });
  };
  function rvExportHtml(w) {
    const rows = csvRows(w);
    const s = w.data.synthesis;
    const synth = s ? ['consensus', 'disagreements', 'gaps'].map(k => `<h3>${k[0].toUpperCase() + k.slice(1)}</h3><ul>${s[k].map(it => `<li>${esc(it.text)} (${it.cites.map(c => `${esc(paper(c.doc).short)}, p. ${c.page}`).join('; ')})</li>`).join('')}</ul>`).join('') : '';
    return `${synth ? '<h2>Synthesis</h2>' + synth : ''}<h2>Evidence matrix</h2><table border="1" cellpadding="6" style="border-collapse:collapse"><tr>${rows[0].map(h => `<th>${esc(h)}</th>`).join('')}</tr>${rows.slice(1).map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
  }
  function rvExportLines(w) {
    const d = w.data; const out = [];
    d.papers.forEach(p => { const pp = paper(p); out.push('', pp.parsed ? `${pp.authors} (${pp.year}) — ${pp.title}` : pp.title); d.criteria.forEach(c => { const cell = d.cells[p]?.[c.id]; if (cell) out.push(`  ${c.label}: ${cell.text}${cell.cite ? ` (p. ${cell.cite.page})` : ''}`); }); });
    return out;
  }

  WORK_KINDS.review = {
    label: 'Literature review', icon: 'table', noun: 'review', layout: 'wide',
    options: rvOptions,
    title: ctx => { const sp = spOf(ctx?.space); return sp ? `${sp.name} — evidence matrix` : 'Evidence matrix'; },
    generate: rvGenerate,
    render: rvRender,
    after: rvAfter,
    actions: rvActions,
    summary: w => `${plural(w.data?.papers?.length || 0, 'paper')} · ${plural(w.data?.criteria?.length || 0, 'criterion', 'criteria')}${w.data?.synthesis ? ' · synthesized' : ''}`,
    exportHtml: rvExportHtml,
    exportLines: rvExportLines,
  };

  /* ═══════════════ Draft (grounded document) ═══════════════ */
  const DRAFT_TYPES = [
    ['proposal', 'Proposal section', 'Background, objectives and fit with a funding call.'],
    ['litreview', 'Literature review section', 'Related work that compares your papers.'],
    ['announcement', 'Announcement', 'A clear notice for a course or group.'],
    ['letter', 'Recommendation letter', 'Grounded in the person’s work you select.'],
    ['email', 'Email', 'A short message that summarises your sources.'],
  ];
  const typeLabel = t => (DRAFT_TYPES.find(x => x[0] === t) || DRAFT_TYPES[0])[1];
  const TONES = [['formal', 'Formal'], ['neutral', 'Neutral'], ['friendly', 'Friendly']];
  const LENGTHS = [['short', 'Short'], ['medium', 'Medium'], ['long', 'Long']];
  const isGrantDoc = d => /nafosted|grant|funding|call|proposal template/i.test(d?.name || '');
  const drType = w => w.data?.type || defaultType(spaceById(w.space), w.sources || []);
  function defaultType(sp, docs) {
    if (docs.some(id => isGrantDoc(docById(id)))) return 'proposal';
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
  /** Per-paper related-work sentences for the lab library (used by proposals and literature reviews). */
  const LIT = {
    'du-ag-p2': ['Rahman and Lee surveyed 120 studies and found that transfer learning from ImageNet-pretrained CNNs dominates the field', ['du-ag-p2', 9], ', yet 68% of them evaluate only on PlantVillage lab images', ['du-ag-p2', 14], '.'],
    'du-ag-p1': ['Nguyen et al. fine-tuned MobileNetV3 on 4,800 field images from Can Tho and An Giang and reached 96.2% accuracy at 21 ms per image on a phone', ['du-ag-p1', 9], ', although all images come from a single dry season', ['du-ag-p1', 12], '.'],
    'du-ag-p5': ['Singh et al. showed that a ViT-B/16 trained with field-condition augmentation falls from 99.1% accuracy in the lab to 93.4% in the field', ['du-ag-p5', 11], ' and needs 330 ms per image on a Jetson Nano', ['du-ag-p5', 14], '.'],
    'du-ag-p6': ['Ho et al. built a USD 60 multispectral imaging unit that detects bacterial leaf blight 4–6 days before visible symptoms', ['du-ag-p6', 8], ', but it relies on a reference panel and a small dataset', ['du-ag-p6', 11], '.'],
    'du-ag-p3': ['On the sensing side, Tran et al. ran an 8-bit quantized CNN on an ESP32-S3 at 38 mW', ['du-ag-p3', 8], ', though for soil moisture rather than images', ['du-ag-p3', 10], '.'],
    'du-ag-p4': ['Le and Pham extended LoRaWAN node battery life from 4 to 11 months with adaptive sampling', ['du-ag-p4', 7], ', but their nodes perform no on-device inference', ['du-ag-p4', 8], '.'],
  };
  const VISION = ['du-ag-p2', 'du-ag-p1', 'du-ag-p5', 'du-ag-p6'], SENSING = ['du-ag-p3', 'du-ag-p4'];
  /** A sentence about any paper: lab sentence, else built from review cells or evidence. */
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
  function relatedWork(papers, wr, { review, length = 'medium', heading = 'Related work' } = {}) {
    const vis = VISION.filter(p => papers.includes(p)), sen = SENSING.filter(p => papers.includes(p)), rest = papers.filter(p => !VISION.includes(p) && !SENSING.includes(p) && docById(p) && !isGrantDoc(docById(p)));
    let h = `<h2>${esc(heading)}</h2>`;
    const paras = [];
    if (vis.length) paras.push((vis.length > 1 ? 'Deep learning has made image-based crop disease detection accurate on curated data. ' : '') + vis.map(p => wr.say(paperSentence(p, review))).join(' '));
    if (sen.length) paras.push(sen.map(p => wr.say(paperSentence(p, review))).join(' '));
    if (rest.length) paras.push(rest.map(p => wr.say(paperSentence(p, review))).join(' '));
    const keep = length === 'short' ? 1 : length === 'long' ? 9 : 3;
    paras.slice(0, keep).forEach(p => (h += `<p>${p}</p>`));
    const gapRefs = [['du-ag-p1', 12], ['du-ag-p2', 27], ['du-ag-p4', 8]].filter(([d]) => papers.includes(d));
    if (gapRefs.length && (vis.length || sen.length)) h += `<p>${wr.say(['Taken together, these studies leave the lab-to-field gap open: no work evaluates disease detection in rainy-season conditions on low-cost hardware', ...gapRefs.slice(0, 2), '. Our work targets this gap.'])}</p>`;
    else if (rest.length) { const lims = rest.map(p => { const f = finding(p, 'Limitations'); return f.cite ? f : null; }).filter(Boolean).slice(0, 2); if (lims.length) h += `<p>${wr.say(['Across these sources, the main open questions concern ', lc(lims[0].text), lims[0].cite, ...(lims[1] ? ['; and ', lc(lims[1].text), lims[1].cite] : []), '.'])}</p>`; }
    return h;
  }
  const GEN = {
    proposal({ sp, docs, o, wr, review }) {
      const call = docs.find(id => id === 'du-gr-naf') || docs.find(id => isGrantDoc(docById(id)));
      const papers = docs.filter(id => !isGrantDoc(docById(id)));
      const agri = papers.some(p => LIT[p]);
      let h = '<h2>Background and significance</h2>';
      h += agri ? `<p>Rice diseases cost Mekong Delta farmers an estimated 10–15% of yield each season, and most detection still happens by eye, after symptoms spread. ${[papers.includes('du-ag-p2') && wr.say(LIT['du-ag-p2'])].filter(Boolean).join(' ')}</p>`
        : `<p>${esc(sp?.name || 'Our group')} works on a problem where practice has moved faster than evidence. ${papers.slice(0, 1).map(p => wr.say(paperSentence(p, review))).join('')}</p>`;
      const rest = papers.filter(p => p !== 'du-ag-p2');
      if (rest.length) h += `<p>${rest.slice(0, o.length === 'short' ? 1 : 3).map(p => wr.say(paperSentence(p, review))).join(' ')}</p>`;
      if (agri) h += `<p>${wr.say(['Field accuracy is far less studied than lab accuracy', ...(papers.includes('du-ag-p2') ? [['du-ag-p2', 27]] : papers.includes('du-ag-p1') ? [['du-ag-p1', 12]] : []), '. The proposed project closes this gap with rainy-season data, phone-based inference and low-cost multispectral imaging.'])}</p>`;
      if (o.length !== 'short') {
        h += '<h3>Objectives</h3><ol><li>Build a rice leaf dataset that covers rainy-season and low-light conditions.</li><li>Train models that keep field accuracy above 90% while running on a farmer’s phone.</li><li>Test whether low-cost multispectral imaging can flag disease before symptoms are visible.</li></ol>';
        if (call) h += `<h3>Fit with the call</h3><p>${wr.say(BANK[call] ? ['The call prioritizes applied AI for agriculture and funds projects of up to 24 months', [call, 3], '. Our 24-month plan stays within the budget cap', [call, 7], '.'] : [`The project matches the priorities of ${docById(call).name.replace(/\.[^.]+$/, '')}`, quoteAt(call, 1).quote ? [call, 1] : finding(call, 'Method').cite || [call, 1], '.'])}</p>`;
      }
      if (o.length === 'long') h += '<h3>Expected outcomes</h3><ul><li>An open dataset of field images with rainy-season coverage.</li><li>A phone app for early warning, piloted with two cooperatives.</li><li>Two journal papers and one master’s thesis.</li></ul>';
      return h;
    },
    litreview({ docs, o, wr, review }) {
      const papers = review ? review.data.papers : docs;
      return relatedWork(papers, wr, { review, length: o.length });
    },
    announcement({ sp, docs, o, wr }) {
      const ev = (D.events || []).filter(e => e.space === sp?.id && e.at > Date.now()).sort((a, b) => a.at - b.at).find(e => e.kind === 'exam') || (D.events || []).filter(e => e.space === sp?.id && e.at > Date.now()).sort((a, b) => a.at - b.at)[0];
      const title = ev ? `${ev.title.replace(/ · .*/, '')}: what to review` : `Update for ${sp?.name || 'the group'}`;
      let h = `<h2>${esc(title)}</h2><p>${esc(greet(o.tone, sp?.type === 'course' ? 'class' : 'all'))}</p>`;
      h += ev ? `<p>${esc(`${ev.title.replace(/ · .*/, '')} is on ${fmtDate(ev.at)}${ev.title.includes('·') ? ' in ' + ev.title.split('·').pop().trim() : ''}.`)} ${docs.includes('du-ml-syl') ? wr.say(['It covers weeks 1–7 and is closed-book; you may bring one A4 page of handwritten notes', ['du-ml-syl', 2], '.']) : 'Here is what to focus on.'}</p>`
        : '<p>Here is what you need to know this week.</p>';
      const items = docs.filter(id => id !== 'du-ml-syl').slice(0, o.length === 'short' ? 2 : o.length === 'long' ? 6 : 4).map(id => {
        const n = COURSE_NOTES[id]; if (n) return `<li>${wr.say([n[0], C(id, n[1], n[2]), '.'])}</li>`;
        const d = docById(id); const b = BANK[id] && finding(id, 'Result');
        return `<li>${b?.cite ? wr.say([`${paper(id).title}: ${lc(b.text)}`, b.cite, '.']) : esc(`Review ${d?.name.replace(/\.[^.]+$/, '') || 'the material'}.`)}</li>`;
      });
      if (items.length) h += `<ul>${items.join('')}</ul>`;
      if (o.length !== 'short') h += `<p>${o.tone === 'friendly' ? 'Questions? Ask in the course space — the teaching team reads every one.' : 'If anything is unclear, send your question to the teaching team from the course space.'}</p>`;
      h += `<p>${esc(signoff(o.tone))}<br>${esc(me().name)}</p>`;
      return h;
    },
    letter({ docs, o, wr }) {
      const linh = docs.includes('du-ag-p6');
      const who = linh ? 'Bùi Gia Linh' : '[Candidate name]';
      let h = `<p>${esc(o.tone === 'friendly' ? 'Dear colleagues,' : 'Dear Admissions Committee,')}</p>`;
      h += `<p>I am pleased to recommend ${esc(who)} for graduate study. I have worked with ${linh ? 'Linh' : 'the candidate'} for two years in our ${esc(docs.some(d => docById(d)?.kb === 'kb-u-agri') ? 'Smart Agriculture Lab' : 'group')}, where I supervise ${linh ? 'her' : 'their'} field work.</p>`;
      if (linh) h += `<p>${wr.say(['Linh designed a USD 60 multispectral imaging unit from off-the-shelf parts', ['du-ag-p6', 4], ' and showed that it detects bacterial leaf blight 4–6 days before symptoms are visible', ['du-ag-p6', 8], '. ', 'She was candid about its limits — a small dataset and the need for a reference panel', ['du-ag-p6', 11], ' — which is the kind of judgement I look for in a researcher.'])}</p>`;
      else { const src = docs.map(id => { const f = finding(id, 'Result'); return f.cite ? f : null; }).filter(Boolean)[0]; h += `<p>${src ? wr.say([`Their work shows real results: ${lc(src.text)}`, src.cite, '.']) : 'Their work is careful, independent and well documented.'}</p>`; }
      if (o.length !== 'short') h += `<p>${esc(who === '[Candidate name]' ? 'The candidate' : 'Linh')} works independently, communicates clearly with farmers and engineers alike, and finishes what they start.${o.length === 'long' ? ' In lab meetings they routinely help junior members debug experiments and write up results.' : ''}</p>`;
      h += `<p>I recommend ${esc(who)} without reservation.</p><p>${esc(signoff(o.tone))}<br>${esc(me().name)}<br>${esc(me().role || '')}</p>`;
      return h;
    },
    email({ sp, docs, o, wr }) {
      const pi = sp?.members?.find(m => spaceType(sp.type).staff.includes(m.role) && m.user !== me().id);
      const piName = pi ? (D.members.find(x => x.id === pi.user)?.name || 'team') : 'team';
      const first = piName.split(' ').pop();
      const call = docs.find(id => isGrantDoc(docById(id)));
      let h = `<p><b>Subject:</b> ${esc(call ? 'NAFOSTED draft — background section ready for comments' : `Summary of ${plural(docs.length, 'source')} for ${sp?.name || 'the team'}`)}</p><p>${esc(greet(o.tone, first))}</p>`;
      h += call ? `<p>${wr.say(['The background and significance section is drafted. It follows the template’s structure — problem, state of the art, gap', ...(docs.includes('du-gr-tpl') ? [['du-gr-tpl', 2]] : []), ' — and fits the call’s priority on applied AI for agriculture', [call, 3], '.'])}</p>`
        : `<p>Here is a short summary of what I read.</p>`;
      const pts = docs.filter(id => !isGrantDoc(docById(id))).slice(0, o.length === 'short' ? 1 : o.length === 'long' ? 4 : 2).map(id => { const f = finding(id, 'Result'); const pp = paper(id); return f.cite ? `<li>${wr.say([`${pp.short}: ${lc(f.text)}`, f.cite])}</li>` : ''; }).filter(Boolean);
      if (pts.length) h += `<ul>${pts.join('')}</ul>`;
      h += `<p>${o.tone === 'friendly' ? 'Could you take a look this week? Happy to walk through it at lab meeting.' : 'I would be grateful for your comments before the internal deadline.'}</p><p>${esc(signoff(o.tone))}<br>${esc(me().name)}</p>`;
      return h;
    },
  };
  const COURSE_NOTES = {
    'du-ml-w04': ['Regularization: know how λ trades variance for bias', 18, 'Increasing λ reduces variance but can increase bias; choose λ on a validation set.'],
    'du-ml-w03': ['Logistic regression: the sigmoid output and the cross-entropy loss', 12, 'Logistic regression passes wᵀx through the sigmoid and is trained by minimizing the cross-entropy loss.'],
    'du-ml-w05': ['Decision trees and random forests: why feature sampling decorrelates the trees', 27, 'Sampling a subset of features at each split decorrelates the trees, so averaging them reduces variance.'],
    'du-ml-w02': ['Gradient descent: what a too-large learning rate does', 18, 'If α is too large gradient descent can overshoot and diverge; if it is too small, convergence is slow.'],
    'du-ml-w07': ['Model evaluation: tune with cross-validation, never on the test set', 9, 'Hold out a test set once; tune hyper-parameters with k-fold cross-validation on the training data only.'],
    'du-ml-w06': ['Neural networks: forward pass and backpropagation', 14, 'Backpropagation applies the chain rule layer by layer to compute the gradient of the loss with respect to every weight.'],
    'du-ml-a1': ['Assignment 1: report RMSE on the held-out set', 2, 'Report RMSE on the held-out test set and explain your choice of features.'],
    'du-db-w05': ['SQL joins: inner vs outer joins and correlated subqueries', 12, 'An outer join keeps unmatched rows from one side and fills the missing columns with NULL.'],
    'du-db-w07': ['Normalization: decompose to BCNF and check that joins are lossless', 21, 'A decomposition to BCNF is always lossless but may not preserve all functional dependencies.'],
    'du-db-w03': ['Relational algebra: selection, projection and joins', 8, 'Selection filters rows, projection keeps columns, and a natural join matches tuples on shared attributes.'],
    'du-db-lab3': ['Lab 3: submit all join queries in one .sql file', 1, 'Submit all queries in a single .sql file named with your student ID.'],
    'du-db-syl': ['Grading: labs 20%, midterm 30%, final 50%', 1, 'Assessment: labs 20%, midterm exam 30%, final exam 50%.'],
  };
  function drGenerate(ctx) {
    const sp = spOf(ctx.space), o = { type: 'proposal', tone: 'formal', length: 'medium', ...(ctx.options || {}) };
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

  function drRender(w, ctx) {
    const d = w.data, can = ctx.canEdit, u = dru(w);
    d.cites ??= []; d.versions ??= [];
    const used = new Set([...String(d.html).matchAll(/\[(\d+)\]/g)].map(m => +m[1]));
    const tool = (label, cmd, o = {}) => `<button type="button" class="${cx('button button--ghost button--sm dr-tool', !label && 'button--icon-only')}" data-act="dr-cmd" data-cmd="${cmd}" ${o.tip ? `data-tip="${esc(o.tip)}" aria-label="${esc(o.tip)}"` : ''}>${o.icon ? ic(o.icon) : ''}${label ? `<span class="${o.cls || ''}">${esc(label)}</span>` : ''}</button>`;
    const toolbar = can ? `<div class="dr-toolbar" role="toolbar" aria-label="Formatting">${tool('Heading', 'heading')}${tool('B', 'bold', { tip: 'Bold', cls: 'strong' })}${tool('', 'bullets', { icon: 'list', tip: 'Bulleted list' })}${tool('', 'undo', { icon: 'undo', tip: 'Undo' })}<span class="grow"></span><span class="dr-saved" id="dr-saved" aria-live="polite">${ic('check', 'i-sm')}Saved</span></div>` : '';
    const review = w.reviewRequestedAt && w.status === 'ready' ? alertBox('accent', 'Ready for review', `Sent to the space’s staff ${rel(w.reviewRequestedAt)}.`, '', { icon: 'send' }) : '';
    const type = drType(w);
    const quick = (type === 'proposal' ? ['Shorter', 'More formal', 'Add budget justification'] : type === 'announcement' || type === 'email' ? ['Shorter', 'Friendlier', 'More formal'] : ['Shorter', 'Longer', 'More formal']);
    const ask = can ? `<div class="dr-ask">
        ${u.hint ? `<div class="t-xs muted mb-8">${esc(u.hint)}</div>` : ''}
        <div class="dr-ask__chips">${quick.map(q => `<button type="button" class="rv-chip" data-act="dr-ask" data-w="${w.id}" data-q="${esc(q)}" ${u.busy ? 'disabled' : ''}>${esc(q)}</button>`).join('')}</div>
        <div class="dr-ask__field">${ic('sparkles', 'dr-ask__icon')}${input({ id: 'dr-ask-' + w.id, bind: `dr:${w.id}.ask`, value: u.ask, placeholder: 'Ask for changes, e.g. add a timeline', onEnter: 'dr-ask', attrs: `data-w="${w.id}" aria-label="Ask for changes" ${u.busy ? 'disabled' : ''}`, cls: 'dr-ask__input' })}${btn('', { v: 'primary', icon: u.busy ? '' : 'arrow-up', loading: u.busy, tip: 'Revise draft', act: 'dr-ask', data: { w: w.id }, disabled: u.busy, size: 'sm' })}</div>
      </div>` : '';
    const sources = d.cites.length ? d.cites.map((c, i) => { const doc = docById(c.doc); return `<div class="${cx('dr-src', !used.has(i + 1) && 'is-unused')}"><div class="row gap-8"><span class="cite" aria-hidden="true">${i + 1}</span><a class="dr-src__name truncate" href="#${docHref(c)}">${esc(doc?.name || 'Document not available')}</a></div><div class="t-xs muted mt-4">Page ${c.page}${used.has(i + 1) ? '' : ' · not cited in the text'}</div>${c.quote ? `<blockquote class="dr-src__quote">${esc(c.quote)}</blockquote>` : ''}</div>`; }).join('')
      : emptyState({ icon: 'quote', title: 'No sources cited', desc: 'Ask for changes that draw on your sources.', compact: true });
    const cur = d.html, curIdx = d.versions.map(v => v.html).lastIndexOf(cur);
    const versions = d.versions.length ? [...d.versions].map((v, i) => [v, i]).reverse().map(([v, i]) => `<div class="dr-ver"><div class="grow" style="min-width:0"><div class="medium truncate">${esc(v.note || 'Version')}</div><div class="t-xs muted">${esc(rel(v.at))} · ${plural(words(v.html), 'word')}</div></div>${i === curIdx ? chip('Current', { size: 'sm', variant: 'tertiary' }) : can && v.html !== cur ? btn('Restore', { size: 'sm', v: 'ghost', act: 'dr-restore', data: { w: w.id, i } }) : ''}</div>`).join('')
      : emptyState({ icon: 'history', title: 'No versions yet', desc: 'Each revision you ask for is saved here.', compact: true });
    return `<div class="dr" data-w="${w.id}">
      <div class="dr-main">
        ${review}
        <div class="dr-paper">
          ${toolbar}
          <div class="dr-body" id="dr-body-${w.id}" data-w="${w.id}" ${can ? `contenteditable="true" data-input="dr-edit" role="textbox" aria-multiline="true" aria-label="Draft text" spellcheck="true"` : ''}${u.busy ? ' aria-busy="true"' : ''}>${bodyHtml(w, can)}</div>
          <div class="dr-foot t-xs muted">${plural(words(d.html), 'word')} · ${esc(typeLabel(type))}</div>
        </div>
        ${ask}
      </div>
      <aside class="${cx('dr-rail', u.rail && 'is-open')}" aria-label="Sources and versions">
        <button type="button" class="dr-rail__toggle" data-act="dr-rail" data-w="${w.id}" aria-expanded="${!!u.rail}">${ic('quote', 'i-sm')}<span class="grow">Sources and versions</span><span class="t-xs muted">${d.cites.length} · ${d.versions.length}</span>${ic('chevron-down', 'dr-rail__chev')}</button>
        <div class="dr-rail__body">
          ${seg({ value: u.tab, options: [['sources', `Sources ${d.cites.length}`], ['versions', `Versions ${d.versions.length}`]], act: 'dr-tab', data: { w: w.id }, label: 'Rail', full: true })}
          <div class="dr-rail__list">${u.tab === 'versions' ? versions : sources}</div>
        </div>
      </aside>
    </div>`;
  }
  A['dr-tab'] = el => { const w = W(el.dataset.w); if (!w) return; dru(w).tab = el.dataset.value; refresh(); };
  A['dr-rail'] = el => { const w = W(el.dataset.w); if (!w) return; const u = dru(w); u.rail = !u.rail; const r = el.closest('.dr-rail'); r?.classList.toggle('is-open', u.rail); el.setAttribute('aria-expanded', String(u.rail)); };

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
    [/budget/i, 'Budget justification', (w, html) => {
      const wr = reuse(w); const call = (w.sources || []).find(id => id === 'du-gr-naf') || (w.sources || []).find(id => isGrantDoc(docById(id)));
      const items = '<ul><li><b>Personnel (55%)</b> — two research assistants for 24 months to collect and label field images.</li><li><b>Equipment (25%)</b> — 10 phones, 4 multispectral imaging units and 6 sensor nodes.</li><li><b>Field work (12%)</b> — travel to partner farms in Can Tho, An Giang and Tien Giang across two seasons.</li><li><b>Dissemination (8%)</b> — open-access fees and a workshop for cooperatives.</li></ul>';
      const p = call === 'du-gr-naf' ? wr.say(['Each cost item is linked to a planned activity, as the call requires', ['du-gr-naf', 9], '. The total stays under the VND 1.5 billion cap, with equipment at 25% against the 30% limit', ['du-gr-naf', 7], '.']) : 'Each cost item below is linked to a planned activity and kept to the minimum needed.';
      return { html: html + `<h3>Budget justification</h3><p>${p}</p>${items}`, cites: wr.cites };
    }],
    [/timeline|schedule|milestone|work ?plan/i, 'Timeline', (w, html) => html + '<h3>Timeline</h3><ul><li><b>Months 1–6</b> — rainy-season data collection and labelling.</li><li><b>Months 7–12</b> — model training and on-phone evaluation.</li><li><b>Months 13–18</b> — multispectral pilot with two cooperatives.</li><li><b>Months 19–24</b> — analysis, papers and open dataset release.</li></ul>'],
    [/objective|aim|goal/i, 'Objectives', (w, html) => /<h3>Objectives<\/h3>/.test(html) ? html : html + '<h3>Objectives</h3><ol><li>State the problem in measurable terms.</li><li>Test the approach on real field data.</li><li>Share data and results openly.</li></ol>'],
    [/long|expand|detail|elaborate/i, 'Longer', (w, html) => {
      const wr = reuse(w); const used = new Set(w.data.cites.map(c => c.doc));
      const extra = (w.sources || []).filter(id => !isGrantDoc(docById(id))).sort((a, b) => used.has(a) - used.has(b)).slice(0, 2).map(id => wr.say(paperSentence(id))).join(' ');
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

  /* Status: draft → ready for review */
  function drActions(w, ctx) {
    if (!ctx.isOwner && !ctx.canEdit) return '';
    if (w.status === 'draft' || w.status === 'generating') return btn('Mark ready for review', { v: 'primary', icon: 'send', act: 'dr-ready', data: { w: w.id } });
    if (w.status === 'ready' && ctx.isOwner) return btn('Back to draft', { icon: 'pencil', act: 'dr-unready', data: { w: w.id } });
    return '';
  }
  A['dr-ready'] = el => {
    const w = W(el.dataset.w); if (!w) return; const body = $('#dr-body-' + w.id); if (body) w.data.html = serialize(body);
    const sp = spaceById(w.space);
    const staff = sp ? (sp.members || []).filter(m => spaceType(sp.type).staff.includes(m.role) && m.user !== me().id).map(m => D.members.find(x => x.id === m.user)?.name).filter(Boolean) : [];
    const prev = { status: w.status, at: w.reviewRequestedAt };
    w.status = 'ready'; w.reviewRequestedAt = Date.now(); w.reviewRequestedBy = me().id; if (sp && w.visibility === 'private') { prev.vis = 'private'; w.visibility = 'space'; }
    audit('Requested review', w.title); saveWork(w); refresh();
    toast(staff.length ? `Sent to ${staff.slice(0, 2).join(' and ')} for review` : 'Marked ready for review', { action: { label: 'Undo', run: () => { w.status = prev.status; w.reviewRequestedAt = prev.at; if (prev.vis) w.visibility = prev.vis; saveWork(w); refresh(); } } });
  };
  A['dr-unready'] = el => { const w = W(el.dataset.w); if (!w) return; w.status = 'draft'; delete w.reviewRequestedAt; saveWork(w); refresh(); toast('Back to draft'); };

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
      if (t === 'proposal' && docs.includes('du-gr-naf')) return 'NAFOSTED 2027 — Background & significance';
      return `${typeLabel(t)}${sp ? ' — ' + sp.name : ''}`;
    },
    generate: drGenerate,
    render: drRender,
    actions: drActions,
    summary: w => `${typeLabel(drType(w))} · ${plural(words(w.data?.html), 'word')}${w.status === 'ready' && w.reviewRequestedAt ? ' · review requested' : ''}`,
    exportHtml: drExportHtml,
    exportLines: drExportLines,
  };
})();

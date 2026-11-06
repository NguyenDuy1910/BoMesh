/* Work — artifacts made with AI workflows (study guides, quizzes, reviews,
   drafts). This file is the kind-agnostic engine: the Work list, the
   "new work" flow (what → from which materials → options → generate), the
   item page shell (title, meta, status, more menu, generating state) and the
   shared citation drawer. Each kind registers its behaviour in WORK_KINDS
   (features/work-learning.js: quiz, guide · features/work-research.js:
   review, draft). Helpers other modules use live on X.work. */
(() => {
  'use strict';

  /* Drafts used to say "ready" while waiting for a reviewer; that state is "in_review" now. */
  const works = () => { const list = (D.works ??= []); list.forEach(w => { if (w.kind === 'draft' && w.status === 'ready') w.status = 'in_review'; }); return list; };
  const workById = id => works().find(w => w.id === id);
  const kindOf = w => WORK_KINDS[w?.kind || w] || { label: 'Work', icon: 'sparkles', noun: 'work' };
  const KIND_TONE = { quiz: 'accent', guide: 'success', review: 'warning', draft: 'accent' };
  /* "ready" (generated, nothing to do) carries no chip; drafts move draft → in review → changes requested | approved. */
  STATUS.work = { generating: ['accent', 'Generating', 'soft', 1], draft: ['default', 'Draft'], in_review: ['accent', 'In review'], changes: ['warning', 'Changes requested'], approved: ['success', 'Approved', 'tertiary'], published: ['accent', 'Published'] };

  function audit(action, target) {
    D.audit?.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Work', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }

  /* ═══════════════ Permissions ═══════════════ */
  const isOwner = w => w.owner === me().id;
  /** Own work; space-shared work where I'm a member — staff-only workflows (quizzes) reach students once published. */
  function canSee(w) {
    if (!w) return false;
    if (isOwner(w)) return true;
    if (w.status === 'generating' || w.visibility !== 'space') return false;
    const sp = spaceById(w.space);
    if (!sp || !spaceRole(sp)) return false;
    if (isSpaceStaff(sp)) return true;
    return WORKFLOWS[w.workflow]?.audience !== 'staff' || w.status === 'published';
  }
  /** Owner edits; the space's staff also edit staff work shared to the space (e.g. a quiz). Someone else's draft is reviewed, never edited. */
  function canEdit(w) {
    if (!w) return false;
    if (isOwner(w)) return true;
    const sp = spaceById(w.space);
    return !!sp && w.visibility === 'space' && isSpaceStaff(sp) && WORKFLOWS[w.workflow]?.audience === 'staff';
  }
  function ctxFor(w, query = S.cur?.query || {}) {
    const sp = spaceById(w.space);
    // Reviewers: the space's staff, for someone else's draft shared with the space.
    return { query, isOwner: isOwner(w), isStaff: !!sp && isSpaceStaff(sp), isReviewer: !!sp && !isOwner(w) && w.visibility === 'space' && isSpaceStaff(sp), canEdit: canEdit(w), space: w.space, sp };
  }
  function worksVisible({ space } = {}) {
    return works().filter(w => canSee(w) && (!space || w.space === space)).sort((a, b) => b.updated - a.updated);
  }
  const myAttempt = w => (w?.data?.attempts || []).filter(a => a.user === me().id).at(-1) || null;

  /* ═══════════════ Small shared pieces ═══════════════ */
  const workIcon = kind => WORK_KINDS[kind]?.icon || 'sparkles';
  const tile = (w, size = '') => itemIcon(workIcon(w.kind), KIND_TONE[w.kind] || 'accent', size);
  const summary = w => { try { return kindOf(w).summary?.(w) || kindOf(w).label; } catch (_) { return kindOf(w).label; } };
  /** Status as the viewer needs it: students see a published quiz as To do / Done. */
  function statusChip(w) {
    if (w.kind === 'quiz' && w.status === 'published' && !canEdit(w)) {
      const a = myAttempt(w);
      if (a) return chip(`Done · ${a.score}/${a.total}`, { tone: 'success', variant: 'tertiary', dot: true });
      if (w.due && w.due < Date.now()) return chip('Closed', { dot: true });
      return chip('To do', { tone: 'warning', dot: true });
    }
    return STATUS.work[w.status] ? status('work', w.status) : '';
  }
  const spaceTag = sp => sp ? `<span class="work-space"><span class="space-dot" style="background:${esc(sp.color || 'var(--accent)')}" aria-hidden="true"></span><span class="truncate">${esc(sp.code || sp.name)}</span></span>` : '';
  /** The one work row (Work list, space Work tab). o.hideSpace inside a space; o.owner adds "by …" for work shared with you. */
  function workItem(w, o = {}) {
    const sp = !o.hideSpace && spaceById(w.space);
    return item({ lead: tile(w), title: esc(w.title), titleExtra: statusChip(w), desc: esc([summary(w), sp?.name, o.owner && !isOwner(w) && `by ${actorName(w.owner)}`].filter(Boolean).join(' · ')), meta: esc(rel(w.updated)), href: '/work/' + w.id + (o.from ? '?from=' + o.from : '') });
  }

  /* ═══════════════ Citations (shared drawer) ═══════════════ */
  function cite(c, n) {
    if (!c?.doc) return '';
    const d = docById(c.doc);
    return `<button type="button" class="cite" data-act="work-cite" ${dataAttrs({ doc: c.doc, page: c.page || 1, quote: c.quote || '', n })} aria-label="Source ${n}: ${esc(d?.name || 'document')}, page ${c.page || 1}">${n}</button>`;
  }
  /** Replace [n] markers in generated HTML with citation buttons. */
  const cites = (html, list = []) => String(html || '').replace(/\[(\d+)\]/g, (m, n) => (list[n - 1] ? cite(list[n - 1], +n) : m));
  /* Kinds with their own panel (draft rail, review evidence panel) show the citation there: one side panel at a time.
     Everywhere else a citation opens the shared document preview (preview.js) on the cited passage. */
  A['work-cite'] = el => {
    const p = { doc: el.dataset.doc, page: +el.dataset.page || 1, quote: el.dataset.quote || '', n: el.dataset.n };
    const w = S.cur?.r.page === 'workItem' && workById(S.cur.params.id), k = w && kindOf(w);
    if (k?.onCite) { k.onCite(w, p, el); return; }
    X.preview.open({ id: p.doc, page: p.page, quote: p.quote });
  };
  A['work-sources'] = el => openDrawer('work-sources', { id: el.dataset.id });
  DR['work-sources'] = p => {
    const w = workById(p.id); if (!w) return { title: 'Sources', body: '' };
    const k = kindOf(w), groups = k.sourceGroups?.(w) || [{ ids: w.sources }];
    const row = id => {
      const d = docById(id), kb = d && kbById(d.kb), ok = !!kb && canReadKb(kb);
      return item({ lead: fileIcon(d?.type || 'pdf'), title: esc(d?.name || 'Removed document'), desc: esc(kb?.name || ''), trail: ok ? ic('chevron-right', 'muted') : ic('lock', 'muted'), href: ok ? '/doc/' + id : undefined });
    };
    return {
      title: 'Sources', desc: esc(sourceLine(w)),
      body: groups.filter(g => g.ids.length).map(g => `${g.title ? `<div class="t-label mt-16 mb-8">${esc(g.title)}</div>` : ''}${list(g.ids.map(row), 'list--plain')}`).join(''),
    };
  };
  /** One count per kind, said the same way in the header and the Sources panel. */
  const sourceLine = w => kindOf(w).sourceLine?.(w) || plural((w.sources || []).length, 'source');

  /* ═══════════════ Materials ═══════════════ */
  const usable = d => d.status === 'ready' || d.status === 'outdated';
  /** Documents grouped by knowledge base: the space's materials (its bases, then documents linked from other bases), plus My files for private work. */
  function docGroups(sp, mine) {
    const kbs = sp ? (sp.kbs || []).map(kbById) : visibleKbs().filter(k => !k.personal);
    if (mine || !sp) kbs.push(...visibleKbs().filter(k => k.personal));
    const groups = [...new Set(kbs)].filter(k => k && !k.archived && canReadKb(k)).map(kb => ({ name: kb.name, docs: docsIn(kb.id) }));
    const linked = sp && X.spaceLinkedDocs ? X.spaceLinkedDocs(sp) : [];
    if (linked.length) groups.push({ name: 'Linked from other knowledge bases', docs: linked });
    return groups.filter(g => g.docs.length);
  }
  const docsForSpace = (sp, o = {}) => docGroups(sp, o.mine).flatMap(g => g.docs);
  const privateFlow = wf => WORKFLOWS[wf]?.audience === 'member';
  /** Checklist of documents for f.space (f = a view-state bucket with docs:{id:true}, q). o.max: how many the workflow can use (the counter says so). */
  function sourcePicker(f, o = {}) {
    const sp = spaceById(f.space), uiKey = o.uiKey || 'workNew';
    const groups = docGroups(sp, o.mine ?? privateFlow(f.workflow));
    if (!groups.length) return emptyState({ icon: 'files', title: 'No materials here yet', desc: sp ? `${esc(sp.name)} has no documents you can read.` : 'Add documents to a knowledge base first.', boxed: true, compact: true });
    const q = (f.q || '').trim().toLowerCase();
    const shown = groups.map(g => ({ ...g, docs: g.docs.filter(d => !q || d.name.toLowerCase().includes(q)) })).filter(g => g.docs.length);
    const pickable = shown.flatMap(g => g.docs).filter(usable);
    const on = pickable.filter(d => f.docs[d.id]).length;
    const all = groups.flatMap(g => g.docs), n = all.filter(d => f.docs[d.id]).length, over = o.max && n > o.max;
    const count = o.max ? `${n ? `${fmtNum(n)} selected` : 'None selected'} · up to ${fmtNum(o.max)}` : n ? `${fmtNum(n)} selected` : 'None selected';
    const head = `<div class="work-pick__bar">${needsTools(all.length, uiKey) ? searchField({ uiKey, placeholder: 'Search documents' }) : ''}<span class="grow"></span><span class="${cx('t-sm num', over ? 'work-pick__over' : 'muted')}" aria-live="polite">${count}</span></div>
      ${pickable.length ? `<div class="work-pick__all">${checkbox({ label: q ? 'Select all matches' : 'Select all', checked: on && on === pickable.length, indeterminate: on && on < pickable.length, act: 'work-doc-all', data: { ids: pickable.map(d => d.id).join(','), ui: uiKey } })}</div>` : ''}`;
    const body = shown.length ? shown.map(g => `<div class="work-pick__group"><div class="t-label">${esc(g.name)}</div><div class="work-pick__list">${g.docs.map(d => {
      const ok = usable(d);
      return `<div class="work-pick__doc ${f.docs[d.id] ? 'is-on' : ''}">${checkbox({ label: `<span class="work-pick__name">${fileIcon(d.type, 'sm')}<span class="truncate">${esc(d.name)}</span></span>`, checked: !!f.docs[d.id], disabled: !ok, act: 'work-doc-toggle', data: { id: d.id, ui: uiKey } })}<span class="work-pick__meta">${ok ? `${plural(d.pages, 'page')}` : status('doc', d.status)}</span></div>`;
    }).join('')}</div></div>`).join('') : `<div class="t-sm muted work-pick__none">No documents match “${esc(f.q)}”.</div>`;
    return `<div class="work-pick">${head}${body}</div>`;
  }
  A['work-doc-toggle'] = el => { const f = ui(el.dataset.ui || 'workNew'); f.docs ??= {}; f.docs[el.dataset.id] = !f.docs[el.dataset.id]; if (!f.docs[el.dataset.id]) delete f.docs[el.dataset.id]; f.err = ''; refresh(); };
  A['work-doc-all'] = el => {
    const f = ui(el.dataset.ui || 'workNew'); f.docs ??= {}; const ids = el.dataset.ids.split(',').filter(Boolean);
    const all = ids.every(id => f.docs[id]); ids.forEach(id => { if (all) delete f.docs[id]; else f.docs[id] = true; }); f.err = ''; refresh();
  };

  /* ═══════════════ Exports ═══════════════ */
  const srcNames = w => (w.sources || []).map(id => docById(id)?.name).filter(Boolean);
  function exportWord(w, html) {
    const src = srcNames(w);
    saveWord(withExt(w.title, '.doc'), w.title, html + (src.length ? `<h3>Sources</h3><ul>${src.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''));
  }
  function exportPdf(w, lines) {
    const src = srcNames(w);
    savePdf(withExt(w.title, '.pdf'), w.title, [...lines, ...(src.length ? ['', 'Sources', ...src.map(n => '- ' + n)] : [])]);
  }
  function download(w, format) {
    const k = kindOf(w);
    if (format === 'word') exportWord(w, k.exportHtml?.(w) || `<p>${esc(summary(w))}</p>`);
    else exportPdf(w, k.exportLines?.(w) || [summary(w)]);
  }
  const save = w => { w.updated = Date.now(); persist(); };

  /* ═══════════════ Generation (simulated) ═══════════════ */
  const GEN_MS = 1100;
  const running = new Set();
  const viewing = w => S.cur?.path === '/work/' + w.id;
  function create({ kind, workflow, title, space, sources = [], options = {} }) {
    const wf = WORKFLOWS[workflow];
    kind = kind || wf?.kind;
    const w = {
      id: uid('w'), kind, workflow, title: title || kindOf(kind).label, space: space || null, owner: me().id, status: 'generating',
      visibility: wf?.audience === 'staff' && space ? 'space' : 'private', created: Date.now(), updated: Date.now(), sources: [...sources], options: { ...options }, data: {}, gen: { step: 0 },
    };
    works().unshift(w);
    go('/work/' + w.id);
    runGen(w);
    return w;
  }
  function runGen(w) {
    if (running.has(w.id)) return;
    running.add(w.id); w.gen ??= { step: 0 };
    const step = () => {
      if (w.status !== 'generating' || !works().includes(w)) { running.delete(w.id); return; }
      if (w.gen.step < 2) { w.gen.step++; persist(); if (viewing(w)) refresh(); setTimeout(step, GEN_MS); return; }
      finish(w);
    };
    setTimeout(step, GEN_MS);
  }
  function finish(w) {
    const k = kindOf(w), ctx = { workflow: w.workflow, space: w.space, sources: w.sources, options: w.options || {}, title: w.title };
    try { w.data = k.generate?.(ctx) || {}; } catch (e) { console.error(e); w.data = {}; }
    const init = typeof k.initialStatus === 'function' ? k.initialStatus(ctx) : k.initialStatus;
    w.status = init || (WORKFLOWS[w.workflow]?.audience === 'staff' ? 'draft' : 'ready');
    delete w.gen; w.updated = Date.now(); running.delete(w.id);
    audit(`Created ${k.noun || 'work'}`, w.title);
    persist();
    if (viewing(w)) { refresh(); toast(w.status === 'draft' && w.kind === 'quiz' ? 'Quiz ready — review it before you publish' : `${k.label || 'Work'} ready`); }
    else toast(`“${w.title}” is ready`, { action: { label: 'Open', run: () => go('/work/' + w.id) } });
  }
  function genState(w) {
    const step = w.gen?.step || 0, n = w.sources.length;
    const steps = [`Reading ${plural(n, 'document')}`, `Drafting the ${kindOf(w).noun || 'work'}`, 'Checking every source'];
    const docs = w.sources.map(docById).filter(Boolean);
    return `<div class="card card--lg work-gen" role="status" aria-live="polite">
      <div><div class="t-heading">Working on it</div><div class="t-sm muted mt-4">You can leave this page. It keeps going and lands in Work.</div></div>
      ${progress(Math.round(((step + 0.6) / steps.length) * 100), '', 'Generating')}
      <ol class="work-gen__steps">${steps.map((s, i) => `<li class="work-gen__step ${i < step ? 'is-done' : i === step ? 'is-current' : ''}">${i < step ? ic('check-circle') : i === step ? spinner() : ic('circle-dashed')}<span>${esc(s)}</span></li>`).join('')}</ol>
      ${docs.length ? `<div class="work-gen__docs">${docs.slice(0, 6).map(d => `<span class="work-doc-pill">${fileIcon(d.type, 'sm')}<span class="truncate">${esc(d.name)}</span></span>`).join('')}${docs.length > 6 ? `<span class="work-doc-pill">+${docs.length - 6}</span>` : ''}</div>` : ''}
    </div>`;
  }

  /* ═══════════════ Start a workflow ═══════════════ */
  let wnStale = true;
  window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/work/new')) wnStale = true; });
  A['work-start'] = el => {
    const d = el?.dataset || {};
    const q = Object.fromEntries(Object.entries({ workflow: d.workflow, space: d.space, docs: d.docs, title: d.title, from: d.from }).filter(([, v]) => v));
    wnStale = true;
    const qs = new URLSearchParams(q).toString();
    go('/work/new' + (qs ? '?' + qs : ''));
  };
  MENUS['work-new'] = el => workflowsFor(spaceById(el.dataset.space)).map(f => ({ label: f.label, icon: f.icon, run: () => A['work-start']({ dataset: { workflow: f.id, space: el.dataset.space } }) }));
  function flowCards(flows, act, data = {}) {
    return `<div class="work-flows">${flows.map(f => `<button type="button" class="card card--action work-flow" data-act="${act}" ${dataAttrs({ workflow: f.id, ...data })}>${itemIcon(f.icon, 'accent')}<span class="work-flow__body"><span class="work-flow__title">${esc(f.label)}</span><span class="work-flow__desc">${esc(f.desc)}</span></span></button>`).join('')}</div>`;
  }

  /* ═══════════════ /work ═══════════════ */
  function firstRun(flows) {
    if (!flows.length) return emptyState({ icon: 'sparkles', title: 'Nothing to make here yet', desc: hasModule('spaces') ? 'Work starts from a space’s materials. Join a course, group or team to begin.' : 'Ask an admin to turn on workflows for this workspace.', actions: hasModule('spaces') ? btn('Browse spaces', { v: 'primary', href: '/spaces' }) : '', boxed: true });
    return `<div class="work-intro"><div class="t-heading">Turn your materials into finished work</div><p class="t-sm muted mt-4">Pick what you need and the documents to use. Every part cites the page it came from.</p></div>${flowCards(flows, 'work-start')}`;
  }
  /** New: one workflow is a direct button; several open a menu. */
  const newButton = (flows, space) => flows.length === 1
    ? btn(flows[0].label, { v: 'primary', icon: flows[0].icon, act: 'work-start', data: { workflow: flows[0].id, space } })
    : btn('New', { v: 'primary', icon: 'plus', iconRight: 'chevron-down', menu: 'work-new', data: { space } });
  P.work = ({ query }) => {
    const u = ui('workList');
    const flows = workflowsFor();
    const vis = worksVisible(), mine = vis.filter(isOwner), shared = vis.filter(w => !isOwner(w));
    // "Shared with me" only earns a tab once something has been shared.
    const showTabs = shared.length > 0 || query.tab === 'shared';
    const tab = showTabs && query.tab === 'shared' ? 'shared' : 'mine';
    const src = tab === 'mine' ? mine : shared;
    const head = pageHeader({ title: 'Work', actions: flows.length ? newButton(flows) : '' });
    const tabsHtml = showTabs ? `<div class="page-tabs">${tabs([{ id: 'mine', label: 'Mine', count: mine.length || '' }, { id: 'shared', label: 'Shared with me', count: shared.length || '' }], tab, '/work')}</div>` : '';
    const kindOpts = [...new Set(vis.map(w => w.kind))].map(k => [k, kindOf(k).label]);
    const spaceOpts = [...new Set(vis.map(w => w.space).filter(Boolean))].map(id => [id, spaceById(id)?.name || id]);
    const tools = needsTools(src.length, 'workList', ['kind', 'space']);
    // worksVisible() is newest first, the order people come back to work in.
    const rows = src.filter(w => matchesQ('workList', w.title, summary(w), spaceById(w.space)?.name) && (!u.kind || w.kind === u.kind) && (!u.space || w.space === u.space));
    // The tab (or the list itself) already shows how many there are; a count only helps while filtering.
    const filtering = !!u.q || !!u.kind || !!u.space;
    const toolbar = tools ? `<div class="toolbar">${searchField({ uiKey: 'workList', placeholder: 'Search work' })}${kindOpts.length > 1 ? filterButton('Type', 'workList', 'kind', kindOpts) : ''}${spaceOpts.length > 1 ? filterButton('Space', 'workList', 'space', spaceOpts) : ''}${clearFilters('workList', ['kind', 'space'])}${filtering ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'item')}</span>` : ''}</div>` : '';
    const body = gate({
      loading: () => skelRows(5),
      empty: () => firstRun(flows),
      ok: () => {
        if (!src.length) return tab === 'mine' ? firstRun(flows) : emptyState({ icon: 'users', title: 'Nothing shared with you yet', desc: 'Quizzes, guides and reviews people share to your spaces show up here.', boxed: true });
        if (!rows.length) return toolbar + noMatches('workList', ['kind', 'space'], 'work');
        return toolbar + list(rows.map(w => workItem(w, { owner: tab === 'shared' })), 'work-list');
      },
    });
    return `<div class="page">${head}${tabsHtml}${body}</div>`;
  };

  /* ═══════════════ /work/new ═══════════════ */
  /** Spaces where the caller can run this workflow. */
  const wnSpaces = wf => mySpaces().filter(sp => workflowsFor(sp).some(x => x.id === wf));
  const allowsNoSpace = wf => WORKFLOWS[wf] && !WORKFLOWS[wf].spaceTypes;
  const wnDocs = f => docsForSpace(spaceById(f.space), { mine: privateFlow(f.workflow) }).filter(d => f.docs[d.id] && usable(d));
  function wnInit(query) {
    const wf = workflowsFor().some(x => x.id === query.workflow) ? query.workflow : '';
    const f = S.ui.workNew = { workflow: wf, space: '', docs: {}, q: '', opts: query.from ? { from: query.from } : {}, title: query.title || '', titleTouched: !!query.title, step: 1, err: '' };
    if (!wf) return f;
    const spaces = wnSpaces(wf);
    f.space = spaces.some(s => s.id === query.space) ? query.space : spaces[0]?.id || '';
    const ok = new Set(docsForSpace(spaceById(f.space), { mine: privateFlow(wf) }).filter(usable).map(d => d.id));
    (query.docs || '').split(',').filter(id => ok.has(id)).forEach(id => (f.docs[id] = true));
    // Arriving with picked documents skips to options, unless the pick needs fixing first (then step 2 says why).
    f.err = Object.keys(f.docs).length ? docsError(f) : '';
    f.step = Object.keys(f.docs).length && query.space && !f.err ? 3 : 2;
    if (f.step === 3) wnDefaultTitle(f);
    return f;
  }
  const wnCtx = f => ({ workflow: f.workflow, space: f.space || null, sources: wnDocs(f).map(d => d.id), options: f.opts });
  function wnDefaultTitle(f) {
    if (f.titleTouched) return;
    const k = kindOf(WORKFLOWS[f.workflow]?.kind);
    try { f.title = k.title?.(wnCtx(f)) || WORKFLOWS[f.workflow].label; } catch (_) { f.title = WORKFLOWS[f.workflow].label; }
  }
  function stepper(f) {
    const wf = WORKFLOWS[f.workflow];
    const steps = [['Type', wf?.label || ''], ['Materials', f.step > 2 ? plural(wnDocs(f).length, 'document') : ''], ['Options', '']];
    return `<ol class="work-steps" aria-label="Steps">${steps.map(([label, meta], i) => {
      const s = i + 1, st = s < f.step ? 'is-done' : s === f.step ? 'is-current' : '';
      const inner = `<span class="work-steps__dot">${s < f.step ? ic('check') : s}</span><span class="work-steps__text"><span class="work-steps__label">${label}</span>${meta ? `<span class="work-steps__meta truncate">${esc(meta)}</span>` : ''}</span>`;
      return `<li class="work-steps__item ${st}" ${s === f.step ? 'aria-current="step"' : ''}>${s < f.step ? `<button type="button" class="work-steps__btn" data-act="wn-step" data-step="${s}">${inner}</button>` : `<span class="work-steps__btn">${inner}</span>`}</li>`;
    }).join('<li class="work-steps__line" aria-hidden="true"></li>')}</ol>`;
  }
  P.workNew = ({ query }) => {
    if (wnStale || !S.ui.workNew) { wnInit(query); wnStale = false; }
    const f = S.ui.workNew, wf = WORKFLOWS[f.workflow];
    crumbs([{ label: 'Work', to: '/work' }, { label: 'New' }]);
    const flows = workflowsFor();
    const head = pageHeader({ title: wf ? wf.label : 'New work' });
    let body = '', foot = '';
    const cancel = btn('Cancel', { v: 'ghost', act: 'wn-cancel' });
    if (f.step === 1 || !wf) {
      body = `<h2 class="work-q">What do you want to make?</h2>${flows.length ? flowCards(flows, 'wn-flow') : firstRun(flows)}`;
      foot = `<div class="work-new__foot">${cancel}</div>`;
    } else if (f.step === 2) {
      const spaces = wnSpaces(f.workflow);
      const opts = [...(allowsNoSpace(f.workflow) ? [['', 'No space — any knowledge I can read']] : []), ...spaces.map(s => [s.id, s.name + (s.code ? ` · ${s.code}` : '')])];
      const spaceField = opts.length ? field({ id: 'wn-space', label: 'Space', control: select({ id: 'wn-space', value: f.space, options: opts, change: 'wn-space' }) }) : '';
      const pick = (!opts.length) ? emptyState({ icon: 'layers', title: `No space where you can make a ${wf.label.toLowerCase()}`, desc: 'Join a space first. Its materials are what the assistant works from.', actions: btn('Browse spaces', { href: '/spaces' }), boxed: true, compact: true }) : sourcePicker(f, { max: maxFor(f) });
      body = `<h2 class="work-q">From which materials?</h2>${spaceField}<div class="field mt-16"><span class="label">Documents<span class="label__req" aria-hidden="true">*</span></span>${pick}${f.err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : ''}</div>`;
      foot = `<div class="work-new__foot">${btn('Back', { icon: 'arrow-left', act: 'wn-step', data: { step: 1 } })}<span class="grow"></span>${cancel}${opts.length ? btn('Continue', { v: 'primary', act: 'wn-next' }) : ''}</div>`;
    } else {
      const k = WORK_KINDS[wf.kind], ctx = wnCtx(f), sp = spaceById(f.space);
      let optsHtml = '';
      try { optsHtml = k?.options?.(f, ctx) || ''; } catch (e) { console.error(e); }
      const docs = wnDocs(f);
      body = `<h2 class="work-q">Set it up</h2>
        <div class="work-new__picked"><span class="t-sm">${plural(docs.length, 'document')}${sp ? ` from ${esc(sp.name)}` : ''}</span>${linkBtn('Change', { act: 'wn-step', data: { step: 2 } })}</div>
        ${k ? '' : `<div class="mb-16">${alertBox('default', `${esc(wf.label)} isn’t available yet`, 'It will be generated with default settings.')}</div>`}
        <div class="work-new__opts">${optsHtml}</div>
        ${field({ id: 'wn-title', label: 'Title', required: true, error: f.titleErr || '', control: input({ id: 'wn-title', bind: 'workNew.title', value: f.title, attrs: 'data-input="wn-title"', onEnter: 'wn-generate', invalid: !!f.titleErr }) })}`;
      foot = `<div class="work-new__foot">${btn('Back', { icon: 'arrow-left', act: 'wn-step', data: { step: 2 } })}<span class="grow"></span>${cancel}${btn('Generate', { v: 'primary', icon: 'sparkles', act: 'wn-generate' })}</div>`;
    }
    return `<div class="page page--narrow work-new">${head}${stepper(wf ? f : { ...f, step: 1 })}<div class="card card--lg work-new__card">${body}${foot}</div></div>`;
  };
  A['wn-flow'] = el => {
    const f = ui('workNew'), id = el.dataset.workflow;
    if (f.workflow !== id) {
      f.workflow = id; f.opts = f.opts?.from ? { from: f.opts.from } : {}; if (!f.titleTouched) f.title = '';
      const spaces = wnSpaces(id);
      if (!spaces.some(s => s.id === f.space)) { f.space = spaces[0]?.id || ''; f.docs = {}; }
    }
    f.step = 2; f.err = ''; refresh();
  };
  A['wn-space'] = el => { const f = ui('workNew'); f.space = el.value; f.docs = {}; f.q = ''; f.err = ''; refresh(); };
  A['wn-step'] = el => { const f = ui('workNew'); f.step = +el.dataset.step; f.err = ''; f.titleErr = ''; refresh(); };
  /** How many sources the workflow can use at once (a comparison stays readable); nothing is ever dropped silently. */
  const maxFor = f => kindOf(WORKFLOWS[f.workflow]?.kind).maxSources || 0;
  function docsError(f) {
    const n = wnDocs(f).length, max = maxFor(f);
    if (!n) return 'Pick at least one document.';
    return max && n > max ? `Pick up to ${max} sources to compare. You picked ${n}.` : '';
  }
  A['wn-next'] = () => {
    const f = ui('workNew'), err = docsError(f);
    if (err) { f.err = err; refresh(); return; }
    f.step = 3; f.err = ''; wnDefaultTitle(f); refresh();
  };
  A['wn-title'] = () => { const f = ui('workNew'); f.titleTouched = true; if (f.titleErr) { f.titleErr = ''; refresh(); } };
  A['wn-cancel'] = () => { wnStale = true; if (history.length > 1) history.back(); else go('/work'); };
  A['wn-generate'] = () => {
    const f = ui('workNew'), wf = WORKFLOWS[f.workflow]; if (!wf) return;
    const title = (f.title || '').trim();
    if (!title) { f.titleErr = 'Give it a title.'; refresh(); $('#wn-title')?.focus(); return; }
    const sources = wnDocs(f).map(d => d.id), err = docsError(f);
    if (err) { f.step = 2; f.err = err; refresh(); return; }
    wnStale = true;
    create({ kind: wf.kind, workflow: f.workflow, title, space: f.space || null, sources, options: { ...f.opts } });
  };

  /* ═══════════════ /work/:id ═══════════════ */
  const scroller = inner => `<div class="work-scroll" id="work-scroll" data-keep-scroll>${inner}</div>`;
  function header(w, k, ctx) {
    const u = ui('workItem');
    const titleHtml = u.renaming === w.id
      ? `<div class="work-rename">${input({ id: 'work-rename', bind: 'workItem.name', value: u.name, onEnter: 'work-rename-save', attrs: 'aria-label="Title"' })}${btn('Save', { v: 'primary', size: 'sm', act: 'work-rename-save' })}${btn('Cancel', { v: 'ghost', size: 'sm', act: 'work-rename-cancel' })}</div>`
      : ctx.canEdit ? `<h1 class="page-header__title work-title"><button type="button" class="work-title__btn" data-act="work-rename" data-id="${w.id}" data-tip="Rename">${esc(w.title)}${ic('pencil', 'work-title__pen')}</button></h1>` : `<h1 class="page-header__title work-title">${esc(w.title)}</h1>`;
    const sp = ctx.sp, n = (w.sources || []).length;
    const meta = [
      sp && `<a class="work-meta__space" href="#/space/${sp.id}">${spaceTag(sp)}</a>`,
      // Kinds with their own sources panel (drafts) open it; the rest list the documents in a drawer. Same words as that panel.
      n && `<button type="button" class="link-button work-meta__src" data-act="${k.sourcesAct || 'work-sources'}" data-id="${w.id}">${esc(sourceLine(w))}</button>`,
      `<span>Updated ${esc(rel(w.updated))}</span>`,
      !ctx.isOwner && `<span>by ${esc(actorName(w.owner))}</span>`,
      ctx.isOwner && w.space && `<span class="work-meta__vis">${ic(w.visibility === 'space' ? 'users' : 'lock', 'i-sm')}${w.visibility === 'space' ? 'Shared with the space' : 'Only you'}</span>`,
    ].filter(Boolean).join('<span class="work-meta__dot" aria-hidden="true">·</span>');
    let actions = '';
    if (w.status !== 'generating') { try { actions = k.actions?.(w, ctx) || ''; } catch (e) { console.error(e); } }
    const more = moreItems(w).length ? iconBtn('more', 'More', { menu: 'work-more', data: { id: w.id } }) : '';
    return `<header class="page-header work-head"><div class="page-header__lead">${tile(w)}</div><div class="page-header__body"><div class="page-header__title-row">${titleHtml}${u.renaming === w.id ? '' : statusChip(w)}</div><div class="work-meta">${meta}</div></div>${actions || more ? `<div class="page-header__actions">${actions}${more}</div>` : ''}</header>`;
  }
  P.workItem = ({ params, query }) => {
    const w = workById(params.id);
    if (!w || !canSee(w)) {
      crumbs([{ label: 'Work', to: '/work' }, { label: 'Not available' }]);
      return scroller(`<div class="page page--narrow">${emptyState({ icon: w ? 'lock' : 'search', title: w ? 'You don’t have access to this' : 'This work doesn’t exist', desc: w ? 'It’s private, or only the teaching team of its space can see it. Ask the owner to share it.' : 'It may have been deleted.', actions: btn('Back to Work', { v: 'primary', href: '/work' }) })}</div>`);
    }
    const k = kindOf(w), ctx = ctxFor(w, query), sp = ctx.sp;
    crumbs(query.from === 'space' && sp ? [{ label: sp.name, to: '/space/' + sp.id }, { label: 'Work', to: `/space/${sp.id}?tab=work` }, { label: w.title }] : [{ label: 'Work', to: '/work' }, { label: w.title }]);
    let body;
    if (w.status === 'generating') { runGen(w); body = genState(w); }
    else {
      try { body = k.render ? k.render(w, ctx) : emptyState({ icon: 'sparkles', title: 'This can’t be shown here yet', desc: `${esc(k.label)} needs a newer version of BoMesh.`, boxed: true }); }
      catch (e) { console.error(e); body = errorState({ title: 'This didn’t load', desc: String(e.message || e) }); }
    }
    const layout = k.layout === 'wide' ? 'page--wide work-page--wide' : k.layout === 'doc' ? 'page--wide work-page--doc' : 'work-page';
    // A kind's side panel (the review's evidence) sits beside the page, non-modal, so the work stays usable while it's open.
    let panel = '';
    if (w.status !== 'generating') { try { panel = k.panel?.(w, ctx) || ''; } catch (e) { console.error(e); } }
    return `<div class="split work-split"><div class="split__main">${scroller(`<div class="page ${layout}">${header(w, k, ctx)}${body}</div>`)}</div>${panel}</div>`;
  };
  AFTER.workItem = ({ params }) => {
    const w = workById(params.id);
    if (w && w.status !== 'generating' && canSee(w)) { try { kindOf(w).after?.(w, ctxFor(w)); } catch (e) { console.error(e); } }
  };

  /* Rename */
  A['work-rename'] = el => { const w = workById(el.dataset.id || S.cur.params.id); if (!w || !canEdit(w)) return; const u = ui('workItem'); u.renaming = w.id; u.name = w.title; refresh(); requestAnimationFrame(() => $('#work-rename')?.select()); };
  A['work-rename-cancel'] = () => { ui('workItem').renaming = null; refresh(); };
  A['work-rename-save'] = () => {
    const u = ui('workItem'), w = workById(u.renaming); if (!w) return;
    const name = (u.name || '').trim();
    if (!name) { toast('Give it a title.', { tone: 'danger' }); return; }
    const prev = w.title; u.renaming = null;
    if (name === prev) { refresh(); return; }
    const evs = (D.events || []).filter(e => e.work === w.id), prevEv = evs.map(e => e.title);
    w.title = name; save(w); evs.forEach(e => (e.title = `${name.split(' — ')[0]} closes`)); refresh();
    toast('Renamed', { action: { label: 'Undo', run: () => { w.title = prev; evs.forEach((e, i) => (e.title = prevEv[i])); save(w); refresh(); } } });
  };
  const prevEsc = A['esc-page'];
  A['esc-page'] = () => { if (S.ui.workItem?.renaming && S.cur?.r.page === 'workItem') { A['work-rename-cancel'](); return true; } return prevEsc?.() || false; };

  /* More menu */
  function moreItems(w) {
    const k = kindOf(w), ctx = ctxFor(w), gen = w.status === 'generating', sp = ctx.sp, items = [];
    if (!gen) { try { items.push(...(k.menu?.(w, ctx) || [])); } catch (e) { console.error(e); } }
    if (!gen && ctx.canEdit) items.push({ label: 'Duplicate', icon: 'copy', run: () => duplicate(w) });
    if (!gen && k.canDownload?.(w, ctx) !== false) {
      items.push({ label: 'Download as Word', icon: 'file-text', run: () => download(w, 'word') }, { label: 'Download as PDF', icon: 'download', run: () => download(w, 'pdf') });
      try { items.push(...(k.downloads?.(w, ctx) || [])); } catch (e) { console.error(e); }
    }
    if (!gen && ctx.isOwner && sp && w.status !== 'published') items.push(w.visibility === 'space' ? { label: 'Make private', icon: 'lock', run: () => setVisibility(w, 'private') } : { label: `Share to ${sp.name}`, icon: 'share', run: () => setVisibility(w, 'space') });
    if (ctx.isOwner) items.push(...(items.length ? [{ sep: true }] : []), { label: 'Delete', icon: 'trash', danger: true, run: () => remove(w) });
    return items;
  }
  MENUS['work-more'] = el => { const w = workById(el.dataset.id); return w ? moreItems(w) : []; };
  function duplicate(w) {
    const c = clone(w);
    Object.assign(c, { id: uid('w'), title: `${w.title} (copy)`, owner: me().id, status: ['published', 'in_review', 'changes', 'approved'].includes(w.status) ? 'draft' : w.status, visibility: 'private', created: Date.now(), updated: Date.now() });
    delete c.published; delete c.due; delete c.reviews;
    if (c.data?.attempts) c.data.attempts = [];
    if (c.data?.stats) c.data.stats = { attempts: 0, avg: 0, byQuestion: [] };
    works().unshift(c); audit('Duplicated work', w.title); go('/work/' + c.id);
    toast('Duplicated — this copy is private', { action: { label: 'Undo', run: () => { const i = works().indexOf(c); if (i >= 0) works().splice(i, 1); go('/work/' + w.id); } } });
  }
  function setVisibility(w, v) {
    const prev = w.visibility; w.visibility = v; save(w); audit(v === 'space' ? 'Shared work to space' : 'Made work private', w.title); refresh();
    toast(v === 'space' ? `Shared to ${spaceById(w.space)?.name || 'the space'}` : 'Now only you can see it', { action: { label: 'Undo', run: () => { w.visibility = prev; save(w); refresh(); } } });
  }
  /** Unpublished work goes at once (Undo brings it back); published work takes students' results with it, so that asks first. */
  function remove(w) {
    const run = () => {
      const i = works().indexOf(w); if (i < 0) return;
      works().splice(i, 1);
      const evs = (D.events || []).filter(e => e.work === w.id);
      if (evs.length) D.events = D.events.filter(e => e.work !== w.id);
      audit('Deleted work', w.title);
      go('/work');
      toast(`Deleted “${w.title}”`, { action: { label: 'Undo', run: () => { works().splice(Math.min(i, works().length), 0, w); if (evs.length) (D.events ??= []).push(...evs); refresh(); toast('Restored'); } } });
    };
    if (w.status !== 'published') { run(); return; }
    confirmAction({ title: `Delete “${w.title}”?`, body: 'Students lose access and their results are deleted.', confirm: 'Delete', danger: true, onConfirm: run });
  }

  /* ═══════════════ Exports ═══════════════ */
  X.workItem = workItem;
  X.worksVisible = worksVisible;
  X.workIcon = workIcon;
  X.work = { create, cite, cites, sourcePicker, docsForSpace, save, exportWord, exportPdf, download, canEdit, canSee, ctxFor, myAttempt, statusChip, tile, byId: workById, audit, newButton, sourceLine };
})();

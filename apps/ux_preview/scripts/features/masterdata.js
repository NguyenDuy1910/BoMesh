/* Knowledge Studio → Topics (/studio?tab=topics&view=topics, workspace admins only): what documents are about — domains →
   topics — and how processing classifies documents with them.
   Two panes: a tree (search, domains with their topics and document counts, archived ones last; keyboard navigable) and
   the selected node's detail (?node=<topic or domain id> | __new).
   A topic carries its business description, guidance for the assistant, keywords and synonyms, optional rules on where
   a file comes from, example documents, how its documents spread over the collections, and a box to test
   classification. The pipeline classifies each document once, with all of it (core/lifecycle.js topicMatches; the model
   prompt is document_profile.md, shown under ⋯ → Show the classification prompt); the same topics are Browse's pills and
   filters. Edits are a draft per node with one savebar (Save / Discard); saving re-classifies the submissions in review
   and re-checks the published documents the pipeline tagged — without indexing again, since topics live in the index's
   metadata (Undo). Topics people chose stay.
   The feedback loop: reviewers' corrections (D.classCorrections) become keyword candidates (Topics → Suggestions);
   nothing changes the rules until an admin adds them. The auto-tag threshold (D.classPolicy) sits in the summary bar.
   Topics the assistant proposes and keywords from corrections are decided in Topics → Suggestions (X.md.proposals(),
   X.md.learn(); governance.js renders that view).
   One workspace, one rule set: an admin imports it from a spreadsheet (code, name, parent_code, description, keywords,
   synonyms, guidance — missing columns are left as they are) and exports it. Rules and examples live only here.
   Phones: the tree first; a node opens as a full view with Back.
   Exports: X.md = { tab({query}), proposals(), learn() }. Actions: md-* (md-edit opens a topic here from other
   screens), tx-*. Modal: md-import. Drawer: md-prompt. Menus: md-more, md-prop-more, tx-add, tx-more. */
(() => {
  'use strict';

  const BASE = '/studio';
  const NEW = '__new', ARCHIVED = '__archived';
  const COLS = ['code', 'name', 'parent_code', 'description', 'keywords', 'synonyms', 'guidance'];
  const ALL_COLS = { description: true, keywords: true, synonyms: true, guidance: true };
  const live = t => t && !t.archived;
  const domains = () => (D.topics || []).filter(t => !t.parent && live(t));
  const leaves = () => (D.topics || []).filter(t => t.parent && live(t));
  const kidsOf = id => leaves().filter(t => t.parent === id);
  const audit = (action, target) => lifeAudit(action, target);
  const clean = s => String(s ?? '').trim().replace(/\s+/g, ' ');
  /** Multi-line text (guidance): each line cleaned, line breaks kept. */
  const cleanBlock = s => String(s ?? '').replace(/\r\n?/g, '\n').split('\n').map(clean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const splitKw = s => [...new Set(String(s ?? '').split(/[,;|\n]+/).map(clean).filter(Boolean))];
  const kwEq = (a = [], b = []) => a.length === b.length && a.every((k, i) => fold(k) === fold(b[i]));
  const DOT = '<span class="muted" aria-hidden="true"> · </span>';

  /* ═══════════════ Codes ═══════════════ */
  /** Every topic carries a stable code (the spreadsheet key). Topics made here or accepted from a proposal get the next free one. */
  function domainCode(name) {
    const base = (String(name).match(/[A-Za-z]/g) || ['X']).join('').toUpperCase().slice(0, 3).padEnd(3, 'X');
    let code = base, n = 2;
    while ((D.topics || []).some(t => !t.parent && t.code === code)) code = base.slice(0, 2) + n++;
    return code;
  }
  function nextCode(parentId) {
    const dm = topicById(parentId); if (!dm) return '';
    const nums = (D.topics || []).filter(t => t.parent === parentId).map(t => +String(t.code || '').split('-')[1] || 0);
    return `${dm.code}-${String(Math.max(0, ...nums) + 1).padStart(2, '0')}`;
  }
  function ensureCodes() {
    (D.topics || []).filter(t => !t.parent && !t.code).forEach(t => { t.code = domainCode(t.name); });
    (D.topics || []).filter(t => t.parent && !t.code).forEach(t => { t.code = nextCode(t.parent); });
  }
  const codeOf = id => topicById(id)?.code || '';

  /* ═══════════════ Counts ═══════════════ */
  /** Published documents per topic and per domain (over what the caller can read) and submissions in review tagged with it. */
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
  const usedBy = (t, n = topicCounts()) => (t.parent ? n.topic(t.id) + n.review(t.id) : n.domain(t.id) + n.reviewDomain(t.id) + kidsOf(t.id).length);
  /** Published documents the caller can read, per collection, tagged with any of `ids` (a topic, or a domain and its topics). */
  function perKb(ids) {
    const set = new Set(ids), m = new Map();
    readableResources().forEach(d => { if (res(d).topics.some(id => set.has(id))) m.set(d.kb, (m.get(d.kb) || 0) + 1); });
    return [...m].map(([kb, n]) => ({ kb: kbById(kb), n })).filter(x => x.kb).sort((a, b) => b.n - a.n);
  }
  /** Documents a first sync published with low confidence for these topics (Topics → Suggestions). */
  const toConfirm = ids => openClassGroups().filter(g => ids.includes(g.topic)).reduce((a, g) => a + g.n, 0);

  /* ═══════════════ Drafts (one per node; one savebar) ═══════════════ */
  const DRAFTS = () => ui('txDraft', {});
  const valuesOf = t => ({
    name: t.name || '', code: t.code || '', parent: t.parent || '', desc: t.desc || '', guidance: t.guidance || '',
    keywords: [...topicKeywords(t)], synonyms: [...topicSynonyms(t)], rules: (t.rules || []).map(r => ({ field: r.field, op: r.op, value: r.value })), examples: [...(t.examples || [])],
  });
  const valuesKey = f => JSON.stringify([f.name, f.code, f.parent, f.desc, f.guidance, f.keywords, f.synonyms, f.rules.map(r => [r.field, r.op, r.value]), f.examples]);
  /** The node's working copy. An untouched draft follows the topic when it changes elsewhere (import, Undo, a proposal merged into it). */
  function draftOf(key) {
    const all = DRAFTS(), t = topicById(key);
    if (key === NEW || !t) return all[key];
    const now = valuesKey(valuesOf(t)), f = all[key];
    if (!f || (valuesKey(f) === f.base && f.base !== now)) all[key] = { ...valuesOf(t), base: now, ident: false, keywordsIn: '', synonymsIn: '', exQ: '', exOpen: false, err: {}, tried: false };
    return all[key];
  }
  function isDirty(key) {
    const f = DRAFTS()[key]; if (!f) return false;
    if (key === NEW) return true;
    const t = topicById(key);
    return !!t && valuesKey(f) !== valuesKey(valuesOf(t));
  }
  /** Start adding a domain or a topic: an empty draft opens in the detail pane, its name field focused. */
  function startNew({ kind = 'topic', parent = '' } = {}) {
    if (!canManageTaxonomy()) return;
    const isDomain = kind === 'domain', par = isDomain ? '' : parent || domains()[0]?.id || '';
    DRAFTS()[NEW] = { domain: isDomain, name: '', code: isDomain ? '' : nextCode(par), parent: par, desc: '', guidance: '', keywords: [], synonyms: [], rules: [], examples: [], ident: true, keywordsIn: '', synonymsIn: '', exQ: '', exOpen: false, err: {}, tried: false };
    if (par) delete TREE().closed[par];
    showNode(NEW);
    requestAnimationFrame(() => $('#tx-name')?.focus());
  }

  /* ═══════════════ Tab ═══════════════ */
  function tab({ query = {} } = {}) {
    if (!canManageTaxonomy()) return emptyState({ icon: 'lock', title: 'Only workspace admins change the topics', boxed: true });
    const empty = () => `<div class="tx">${summaryBar()}${emptyState({ icon: 'database', title: 'No topics yet', desc: 'Import your topics from a spreadsheet (Import, above), or add the first domain here.', actions: btn('Add domain', { v: 'secondary', icon: 'plus', act: 'tx-add', data: { kind: 'domain' } }), boxed: true })}</div>`;
    return gate({
      loading: () => skelRows(6),
      error: () => errorState({ title: 'The topics didn’t load' }),
      empty,
      ok: () => {
        ensureCodes();
        const picked = query.node || '', bare = query.show === 'bare';
        if (!domains().length && !DRAFTS()[NEW]) return empty();
        const n = topicCounts(), id = resolveNode(picked || (bare ? leaves().find(isBare)?.id || '' : ''));
        return `<div class="${cx('tx', picked && 'tx--picked')}">${summaryBar(bare)}<div class="tx-panes">${treePane(id, n, bare)}<div class="tx-main" id="tx-main">${detail(id, n)}</div></div></div>`;
      },
    });
  }
  /** ?node= when it exists; else the first domain. */
  function resolveNode(id) {
    if (id === NEW) return DRAFTS()[NEW] ? NEW : domains()[0]?.id || '';
    if (id && topicById(id)) return id;
    return domains()[0]?.id || '';
  }

  /** A topic the pipeline can only match by name: no keywords and no synonyms. Filling these in is the rules' main upkeep. */
  const isBare = t => !topicKeywords(t).length && !topicSynonyms(t).length;
  /** Of the published documents the pipeline tagged, how many it was at least `v` sure of. */
  function thresholdEffect(v) {
    const tagged = reclassifiable().filter(d => d.topics?.length);
    return { n: tagged.filter(d => topicConfidence(d, d.topics[0]) >= v).length, of: tagged.length };
  }
  /** One quiet line above both panes: what the rules hold and where they came from, and how sure the pipeline must be to
      tag by itself; Export, Template and the prompt under ⋯. Topics without keywords are a toggle that narrows the tree to
      them (?show=bare), so the fix is one click away. */
  function summaryBar(bareOn = false) {
    const tops = leaves(), kws = tops.reduce((a, t) => a + topicKeywords(t).length, 0), bare = tops.filter(isBare).length;
    const last = (D.masterImports || [])[0];
    const counts = `<span class="medium">${esc(`${plural(domains().length, 'domain')} · ${plural(tops.length, 'topic')} · ${plural(kws, 'keyword')}`)}</span>`;
    const source = last ? `${DOT}<span>${esc(`Last imported ${rel(last.at)} by ${actorName(last.by)}`)}</span>${DOT}<span translate="no">${esc(last.file)}</span>` : `${DOT}<span>Not imported yet</span>`;
    const hint = bare || bareOn ? `${DOT}<button type="button" class="tx-sum__warn" data-act="tx-bare" aria-pressed="${bareOn}" data-tip="${esc(bareOn ? 'Show every topic' : 'The pipeline matches them by name only. Show just these.')}">${esc(`${plural(bare, 'topic')} without keywords`)}</button>` : '';
    const v = classThreshold(), fx = thresholdEffect(v);
    const tip = fx.of ? `Below it, a document is published without a topic and waits in Topics → Suggestions. At ${Math.round(v * 100)}%, ${fmtNum(fx.n)} of the ${fmtNum(fx.of)} documents the pipeline tagged would have cleared it.` : 'Below it, a document is published without a topic and waits in Topics → Suggestions.';
    const thr = `<label class="tx-sum__thr" data-tip="${esc(tip)}"><span>Auto-tag at</span>${select({ id: 'md-thr', value: v, options: CLASS_THRESHOLDS.map(x => [x, `${Math.round(x * 100)}% sure`]), change: 'md-threshold', size: 'sm', label: 'How sure the pipeline must be to tag a document by itself' })}</label>`;
    return `<div class="tx-sum"><p class="tx-sum__text">${counts}${source}${hint}</p>${thr}${iconBtn('more', 'More actions for topics', { size: 'sm', menu: 'md-more' })}</div>`;
  }
  A['tx-bare'] = () => setQuery({ show: S.cur.query.show === 'bare' ? '' : 'bare' });
  /** The threshold applies to documents classified from now on; documents already tagged keep their topics. */
  A['md-threshold'] = el => {
    if (!canManageTaxonomy()) return;
    const prev = D.classPolicy ? { ...D.classPolicy } : null, v = +el.value;
    D.classPolicy = { ...(D.classPolicy || {}), threshold: v };
    audit('Changed the auto-tag threshold', `${Math.round(v * 100)}%`); refresh();
    toast(`The pipeline tags by itself at ${Math.round(v * 100)}% sure · applies to new documents`, { action: { label: 'Undo', run: () => { if (prev) D.classPolicy = prev; else delete D.classPolicy; refresh(); } } });
  };
  MENUS['md-more'] = () => [
    { label: 'Show the classification prompt', icon: 'code', run: () => openDrawer('md-prompt', {}) },
    { sep: true },
    { label: 'Export topics', icon: 'download', run: exportCsv },
    { label: 'Download template', icon: 'table', run: templateCsv },
  ];

  /* ═══════════════ Tree ═══════════════ */
  const TREE = () => ui('txTree', { q: '', closed: {}, archived: false });
  const termsOf = t => [t.name, t.code, ...topicKeywords(t), ...topicSynonyms(t)];
  function treeItem({ id, level, expanded, inner, group = '', cls = '' }, sel, focusId) {
    return `<li role="treeitem" id="tx-n-${esc(id)}" class="${cx('tx-item', cls)}" aria-level="${level}" aria-selected="${id === sel}" ${expanded != null ? `aria-expanded="${expanded}"` : ''} tabindex="${id === focusId ? 0 : -1}" data-id="${esc(id)}">`
      + `<div class="${cx('tx-row', id === sel && 'is-selected')}" data-act="tx-node" data-id="${esc(id)}">${inner}</div>${group}</li>`;
  }
  function treePane(sel, n, bare = false) {
    const u = TREE(), q = fold(u.q || '').trim(), drafts = DRAFTS();
    const hit = t => (!q || termsOf(t).some(s => fold(s).includes(q))) && (!bare || isBare(t));
    // A topic with no words to recognise it by carries a warning dot (its fix: add keywords in its detail).
    const warn = t => (isBare(t) ? `<span class="tx-row__warn" role="img" aria-label="${esc('No keywords')}" data-tip="${esc('No keywords')}"></span>` : '');
    const dot = id => (drafts[id] && isDirty(id) ? `<span class="tx-row__dot" role="img" aria-label="${esc('Unsaved changes')}" data-tip="${esc('Unsaved changes')}"></span>` : '');
    const chev = (id, open) => `<span class="tx-row__chev" data-act="tx-toggle" data-id="${esc(id)}" aria-hidden="true">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}</span>`;
    const count = (v, cls = '') => `<span class="${cx('tx-row__count', cls)}">${v ? fmtNum(v) : ''}</span>`;
    const newDraft = drafts[NEW];
    const newItem = level => ({ id: NEW, level, inner: `<span class="tx-row__code">${esc(clean(newDraft.code) || '—')}</span><span class="tx-row__name">${esc(clean(newDraft.name) || (newDraft.domain ? 'New domain' : 'New topic'))}</span>${dot(NEW)}`, cls: 'is-new' });
    // Flat model first, so roving focus can fall back to the first item when the selection is hidden.
    const items = [];
    domains().forEach(dm => {
      const all = kidsOf(dm.id), domHit = !bare && hit(dm), kids = domHit ? all : all.filter(hit);
      const draftHere = newDraft && !newDraft.domain && newDraft.parent === dm.id;
      if ((q || bare) && !domHit && !kids.length) return;
      const open = q || bare ? true : !u.closed[dm.id];
      const children = open ? [...kids.map(t => ({ id: t.id, level: 2, inner: `<span class="tx-row__code">${esc(t.code || '')}</span><span class="tx-row__name" translate="no">${esc(t.name)}</span>${warn(t)}${dot(t.id)}${count(n.topic(t.id))}` })), ...(draftHere ? [newItem(2)] : [])] : [];
      items.push({ id: dm.id, level: 1, expanded: open, inner: `${chev(dm.id, open)}<span class="md-code md-code--domain">${esc(dm.code || '')}</span><span class="tx-row__name tx-row__name--domain" translate="no">${esc(dm.name)}</span>${dot(dm.id)}${count(n.domain(dm.id))}`, children });
    });
    if (newDraft?.domain) items.push(newItem(1));
    const archived = (D.topics || []).filter(t => t.archived);
    if (archived.length && !q) {
      const children = u.archived ? archived.map(t => ({ id: t.id, level: 2, inner: `<span class="tx-row__code">${esc(t.code || '')}</span><span class="tx-row__name" translate="no">${esc(t.name)}</span>` })) : [];
      items.push({ id: ARCHIVED, level: 1, expanded: !!u.archived, inner: `${chev(ARCHIVED, u.archived)}${ic('archive', 'i-sm tx-row__icon')}<span class="tx-row__name muted">${esc(`Archived (${archived.length})`)}</span>`, children, cls: 'tx-item--archived' });
    }
    const flat = items.flatMap(x => [x.id, ...(x.children || []).map(c => c.id)]);
    const focusId = flat.includes(sel) ? sel : flat[0];
    const html = items.map(x => treeItem({ ...x, group: x.children?.length ? `<ul role="group" class="tx-group">${x.children.map(c => treeItem(c, sel, focusId)).join('')}</ul>` : '' }, sel, focusId)).join('');
    const tools = `<div class="tx-side__tools">${searchField({ uiKey: 'txTree', placeholder: 'Search topics and keywords', full: true, id: 'tx-q', label: 'Search the taxonomy' })}${iconBtn('plus', 'Add domain or topic', { menu: 'tx-add' })}</div>`;
    const body = html ? `<ul role="tree" class="tx-tree" aria-label="${esc('Domains and topics')}">${html}</ul>` : `<p class="tx-side__empty">${esc(`No topics match “${u.q}”.`)}</p>`;
    return `<div class="tx-side" id="tx-side" data-keep-scroll>${tools}${body}</div>`;
  }
  /** The domain new topics go into: the selected domain, the selected topic's domain, else the first. */
  function currentDomain() {
    const t = topicById(S.cur?.query.node);
    return (t && !t.archived && (t.parent ? topicById(t.parent) : t)) || domains()[0];
  }
  MENUS['tx-add'] = () => {
    if (!canManageTaxonomy()) return [];
    const dm = currentDomain();
    return [
      ...(dm ? [{ label: `Add topic to ${dm.name}`, icon: 'tag', run: () => startNew({ kind: 'topic', parent: dm.id }) }] : []),
      { label: 'Add domain', icon: 'folder-plus', run: () => startNew({ kind: 'domain' }) },
    ];
  };
  A['tx-add'] = el => startNew({ kind: el.dataset.kind, parent: el.dataset.parent });
  function selectNode(id) {
    if (id === ARCHIVED) { toggleNode(ARCHIVED); return; }
    showNode(id);
  }
  /** Select a node and bring its detail's top into view (phones show one pane at a time: always at its top). */
  function showNode(id) {
    setQuery({ node: id });
    const sc = $('#scroll'), panes = $('#app .tx-panes'); if (!sc || !panes) return;
    const top = Math.max(0, panes.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12);
    if (sc.scrollTop > top || !$('#tx-side')?.offsetParent) sc.scrollTop = top;
  }
  function toggleNode(id, close) {
    const u = TREE();
    if (id === ARCHIVED) u.archived = close == null ? !u.archived : !close;
    else u.closed[id] = close == null ? !u.closed[id] : close;
    refresh();
  }
  A['tx-node'] = el => selectNode(el.dataset.id);
  A['tx-toggle'] = el => toggleNode(el.dataset.id);
  A['tx-back'] = () => { const prev = S.cur?.query.node; setQuery({ node: '' }); requestAnimationFrame(() => $(`#tx-n-${CSS.escape(prev || '')}`)?.focus()); };
  /** Other screens open a topic here (e.g. Topics → Suggestions → Edit topic keywords). */
  A['md-edit'] = el => go(topicsHref('topics', { node: el.dataset.id }));
  /** Tree keyboard: ↑↓ Home End move, → opens or enters a domain, ← closes it or goes to the parent, Enter/Space selects. */
  document.addEventListener('keydown', e => {
    const it = e.target.closest?.('.tx-tree [role="treeitem"]'); if (!it || e.target !== it || e.metaKey || e.ctrlKey || e.altKey) return;
    const items = Array.from(document.querySelectorAll('.tx-tree [role="treeitem"]')), i = items.indexOf(it), id = it.dataset.id, exp = it.getAttribute('aria-expanded');
    const focus = el => { if (!el) return; items.forEach(x => { x.tabIndex = -1; }); el.tabIndex = 0; el.focus(); };
    switch (e.key) {
      case 'ArrowDown': focus(items[i + 1]); break;
      case 'ArrowUp': focus(items[i - 1]); break;
      case 'Home': focus(items[0]); break;
      case 'End': focus(items.at(-1)); break;
      case 'ArrowRight': if (exp === 'false') toggleNode(id, false); else if (exp === 'true') focus(items[i + 1]); break;
      case 'ArrowLeft': if (exp === 'true') toggleNode(id, true); else focus(it.parentElement.closest('[role="treeitem"]')); break;
      case 'Enter': case ' ': selectNode(id); break;
      default: return;
    }
    e.preventDefault();
  });

  /* ═══════════════ Detail ═══════════════ */
  const back = () => `<div class="tx-back">${btn('All topics', { v: 'ghost', size: 'sm', icon: 'arrow-left', act: 'tx-back' })}</div>`;
  const sec = (title, body, { desc = '', aside = '', id = '', optional = false } = {}) => `<section class="tx-sec" ${id ? `aria-labelledby="${id}"` : ''}><div class="tx-sec__head"><h3 class="tx-sec__title" ${id ? `id="${id}"` : ''}>${esc(title)}${optional ? '<span class="label__opt">(optional)</span>' : ''}</h3>${aside}</div>${desc ? `<p class="tx-sec__desc">${desc}</p>` : ''}${body}</section>`;
  function detail(id, n) {
    if (id === NEW) return editorDetail(null, n);
    const t = topicById(id);
    if (!t) return `<div class="tx-detail">${back()}${emptyState({ icon: 'tag', title: 'Pick a topic', desc: 'Choose a domain or topic in the list to see and edit it.', compact: true })}</div>`;
    return t.archived ? archivedDetail(t) : editorDetail(t, n);
  }

  /** "12 published · 2 in review" — published links to Browse, in review to Documents → Review. */
  function countLinks(id, pub, rv) {
    const a = pub ? `<a class="link" href="#${catalogHref({ filters: { topic: [id] } })}">${esc(`${fmtNum(pub)} published`)}</a>` : '<span>Not used yet</span>';
    const b = rv ? `${DOT}<a class="link tx-review" href="#${docsHref('review')}">${esc(`${fmtNum(rv)} in review`)}</a>` : '';
    return a + b;
  }
  function headHtml(t, f, n, isDomain) {
    if (!t) {
      const title = isDomain ? 'New domain' : 'New topic';
      const meta = isDomain ? '<span>Domains group topics on Home and in Browse.</span>' : `<span>A topic people browse by and the assistant classifies with.</span>`;
      return `<header class="tx-head"><div class="tx-head__main"><h2 class="tx-head__title">${esc(title)}</h2><p class="tx-head__meta">${meta}</p></div></header>`;
    }
    const where = isDomain ? `<span>${esc(plural(kidsOf(t.id).length, 'topic'))}</span>` : `<button type="button" class="tx-head__domain link" data-act="tx-node" data-id="${esc(t.parent)}" translate="no">${esc(topicName(t.parent))}</button>`;
    const counts = isDomain ? countLinks(t.id, n.domain(t.id), n.reviewDomain(t.id)) : countLinks(t.id, n.topic(t.id), n.review(t.id));
    return `<header class="tx-head"><div class="tx-head__main"><div class="tx-head__title-row"><span class="md-code md-code--domain">${esc(t.code || '')}</span><h2 class="tx-head__title" translate="no">${esc(t.name)}</h2></div>
      <p class="tx-head__meta">${where}${DOT}${counts}</p></div><div class="tx-head__acts">${iconBtn('more', `More actions for ${t.name}`, { menu: 'tx-more', data: { id: t.id } })}</div></header>`;
  }
  /** Name, code (and domain) — shown when adding, or after ⋯ → Edit name and code. */
  function identHtml(key, f, isDomain) {
    const e = f.tried ? f.err : {};
    return `<div class="tx-ident">
      ${field({ id: 'tx-name', label: 'Name', required: true, error: e.name, control: input({ id: 'tx-name', bind: `txDraft.${key}.name`, value: f.name, invalid: !!e.name, attrs: `maxlength="60" data-input="tx-input" data-id="${key}" data-test` }) })}
      ${field({ id: 'tx-code', label: 'Code', required: !(key === NEW), desc: key === NEW ? 'Leave as is to use the next free code.' : 'The key in your spreadsheet. Stays the same when you rename.', error: e.code, control: input({ id: 'tx-code', bind: `txDraft.${key}.code`, value: f.code, invalid: !!e.code, placeholder: isDomain ? 'e.g. OPS' : '', attrs: `maxlength="16" autocapitalize="characters" spellcheck="false" data-input="tx-input" data-id="${key}"` }) })}
      ${isDomain ? '' : field({ id: 'tx-parent', label: 'Domain', error: e.parent, control: select({ id: 'tx-parent', bind: `txDraft.${key}.parent`, value: f.parent, options: domains().map(d => [d.id, d.name]), change: 'tx-parent', attrs: `data-id="${key}"` }) })}
    </div>`;
  }
  function editorDetail(t, n) {
    const key = t ? t.id : NEW, f = draftOf(key); if (!f) return '';
    const isDomain = t ? !t.parent : f.domain, isNew = !t, dirty = isDirty(key);
    const parts = [
      headHtml(t, f, n, isDomain),
      isNew || f.ident ? identHtml(key, f, isDomain) : '',
      // A topic's job is to recognise documents, so its words lead; the description (for people) and guidance follow.
      ...(isDomain ? [descSec(key, f, isDomain), isNew ? '' : domainTopicsSec(t, n)]
        : [termsSec(key, f), descSec(key, f, isDomain), guideSec(key, f), rulesSec(key, f), examplesSec(key, f, t)]),
      isNew ? '' : distSec(t, isDomain, n),
      isNew || isDomain ? '' : testSec(t, f, dirty),
    ];
    const nErr = f.tried ? Object.keys(f.err || {}).length : 0;
    const recheck = !isDomain && dirty ? reclassifiable().length : 0;
    const bar = dirty ? `<div class="savebar" role="region" aria-label="${esc('Unsaved changes')}"><span class="savebar__text">${esc(isNew ? (isDomain ? 'New domain' : 'New topic') : 'Unsaved changes')}${nErr ? esc(` · ${plural(nErr, 'field')} to fix`) : recheck ? `<span class="savebar__hint">${esc(` · saving re-checks ${plural(recheck, 'document')} the pipeline tagged`)}</span>` : ''}</span>${btn('Discard', { v: 'ghost', act: 'tx-discard', data: { id: key } })}${btn(isNew ? (isDomain ? 'Add domain' : 'Add topic') : 'Save', { v: 'primary', icon: isNew ? 'plus' : 'check', act: 'tx-save', data: { id: key } })}</div>` : '';
    return `<div class="tx-detail">${back()}${parts.join('')}${bar}</div>`;
  }

  function descSec(key, f, isDomain) {
    return sec('Description', textarea({ id: 'tx-desc', bind: `txDraft.${key}.desc`, value: f.desc, rows: 2, placeholder: isDomain ? 'What this domain groups, in a sentence' : 'What this topic covers, in your business’s words', attrs: `maxlength="300" aria-labelledby="tx-desc-h" data-input="tx-input" data-id="${key}"` }),
      { id: 'tx-desc-h', desc: esc(isDomain ? 'Shown on Home’s topic cards.' : 'For people choosing a topic.') });
  }
  function guideSec(key, f) {
    return sec('Guidance for the assistant', textarea({ id: 'tx-guide', bind: `txDraft.${key}.guidance`, value: f.guidance, rows: 3, placeholder: 'Use for…\nNot for…', attrs: `maxlength="600" aria-labelledby="tx-guide-h" data-input="tx-input" data-id="${key}"` }),
      { id: 'tx-guide-h', desc: esc('When to use it, and what belongs elsewhere.') });
  }
  /** Keywords and synonyms as chips with an input that adds on Enter or comma; synonyms are marked. */
  function chipEditor(key, f, list, { label, placeholder, syn }) {
    const chips = f[list].map((k, i) => `<span class="${cx('tx-chip', syn && 'tx-chip--syn')}"><span class="tx-chip__text" translate="no">${esc(k)}</span><button type="button" class="tx-chip__x" data-act="tx-chip-rm" data-id="${key}" data-list="${list}" data-i="${i}" aria-label="${esc(`Remove ${k}`)}">${ic('x', 'i-xs')}</button></span>`).join('');
    const inp = input({ id: `tx-${list}-in`, bind: `txDraft.${key}.${list}In`, value: f[`${list}In`] || '', placeholder, size: 'sm', onEnter: 'tx-chip-add', cls: 'tx-chips__input', attrs: `data-id="${key}" data-list="${list}" data-input="tx-chip-type" aria-label="${esc(label)}" spellcheck="false"` });
    return `<div class="tx-terms__group"><label class="tx-terms__label" for="tx-${list}-in">${esc(label)}</label><div class="tx-chips">${chips}${inp}</div></div>`;
  }
  function termsSec(key, f) {
    return sec('Keywords & synonyms', `<div class="tx-terms">${chipEditor(key, f, 'keywords', { label: 'Keywords', placeholder: 'Add a keyword, then Enter' })}${chipEditor(key, f, 'synonyms', { label: 'Synonyms', placeholder: 'Add a synonym, then Enter', syn: true })}</div>`,
      { desc: esc('Words in a title or note that mean a document belongs here.') });
  }
  const sourceOptions = () => [['upload', 'Uploaded files'], ...D.sources.map(s => [s.id, s.name])];
  function rulesSec(key, f) {
    const rows = f.rules.map((r, i) => {
      const value = r.field === 'source'
        ? select({ id: `tx-rv-${i}`, bind: `txDraft.${key}.rules.${i}.value`, value: r.value, options: [['', 'Choose a source'], ...sourceOptions()], change: 'tx-redraw', size: 'sm', label: 'Source', cls: 'tx-rule__value', attrs: `data-id="${key}"` })
        : input({ id: `tx-rv-${i}`, bind: `txDraft.${key}.rules.${i}.value`, value: r.value, size: 'sm', cls: 'tx-rule__value', placeholder: r.field === 'path' ? 'e.g. Chargebacks' : 'e.g. pdf', attrs: `aria-label="${esc('Value')}" spellcheck="false" data-input="tx-input" data-id="${key}" data-test` });
      const ops = r.field === 'source' ? [['is', 'is']] : Object.entries(RULE_OPS);
      return `<li class="tx-rule"><span class="tx-rule__word">When</span>${select({ id: `tx-rf-${i}`, bind: `txDraft.${key}.rules.${i}.field`, value: r.field, options: Object.entries(RULE_FIELDS), change: 'tx-rule-field', size: 'sm', label: 'What to check', attrs: `data-id="${key}" data-i="${i}"` })}${select({ id: `tx-ro-${i}`, bind: `txDraft.${key}.rules.${i}.op`, value: r.op, options: ops, change: 'tx-redraw', size: 'sm', label: 'Condition' })}${value}<span class="tx-rule__word">${ic('arrow-right', 'i-xs')}<span>file it here</span></span>${iconBtn('x', 'Remove rule', { size: 'sm', act: 'tx-rule-rm', data: { id: key, i } })}</li>`;
    }).join('');
    return sec('Rules', `${rows ? `<ul class="tx-rules">${rows}</ul>` : ''}${btn('Add rule', { v: 'ghost', size: 'sm', icon: 'plus', act: 'tx-rule-add', data: { id: key } })}`,
      { optional: true, desc: esc('A matching source or folder settles the topic.') });
  }
  /** Published documents the caller can read that could be examples: by title when searching, else the most-read ones already tagged here. */
  function exampleCandidates(f, t) {
    const q = fold(f.exQ || '').trim(), pool = readableResources().filter(d => !f.examples.includes(d.id) && !kbById(d.kb)?.personal);
    const tagged = d => !!t && res(d).topics.includes(t.id);
    if (q) return pool.filter(d => fold(d.name).includes(q)).sort((a, b) => tagged(b) - tagged(a) || (b.views || 0) - (a.views || 0)).slice(0, 5);
    return pool.filter(tagged).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  }
  function examplesSec(key, f, t) {
    const docs = f.examples.map(docById).filter(Boolean);
    const chips = docs.map(d => (canSeeDoc(d)
      ? `<span class="tx-chip tx-chip--doc">${fileIcon(d.type, 'sm')}<a class="tx-chip__text link" href="#/doc/${esc(d.id)}" translate="no">${esc(docTitle(d))}</a><button type="button" class="tx-chip__x" data-act="tx-ex-rm" data-id="${key}" data-doc="${esc(d.id)}" aria-label="${esc(`Remove ${docTitle(d)}`)}">${ic('x', 'i-xs')}</button></span>`
      : `<span class="tx-chip tx-chip--doc"><span class="tx-chip__text muted">A document you can’t open</span><button type="button" class="tx-chip__x" data-act="tx-ex-rm" data-id="${key}" data-doc="${esc(d.id)}" aria-label="${esc('Remove')}">${ic('x', 'i-xs')}</button></span>`)).join('');
    const open = f.exOpen || !docs.length;
    let picker = '';
    if (open) {
      const cands = exampleCandidates(f, t);
      const list = cands.length ? `<ul class="tx-picks" aria-label="${esc(f.exQ ? 'Matching documents' : 'Suggested documents')}">${cands.map(d => `<li><button type="button" class="tx-pick" data-act="tx-ex-add" data-id="${key}" data-doc="${esc(d.id)}">${fileIcon(d.type, 'sm')}<span class="tx-pick__name truncate" translate="no">${esc(docTitle(d))}</span><span class="tx-pick__meta truncate" translate="no">${esc(kbById(d.kb)?.name || '')}</span>${ic('plus', 'i-sm')}</button></li>`).join('')}</ul>`
        : `<p class="tx-sec__empty">${esc(f.exQ ? 'No published document matches.' : 'Search for a published document that represents this topic.')}</p>`;
      picker = `<div class="tx-expick">${searchField({ bind: `txDraft.${key}.exQ`, act: 'tx-ex-q', value: f.exQ || '', placeholder: 'Find a published document', id: 'tx-ex-q', label: 'Find a published document', full: true })}${!f.exQ && cands.length ? `<div class="tx-picks__label">${esc('Suggested: already tagged with this topic')}</div>` : ''}${list}</div>`;
    }
    const add = !open ? btn('Add example', { v: 'ghost', size: 'sm', icon: 'plus', act: 'tx-ex-open', data: { id: key } }) : '';
    return sec('Examples', `${docs.length ? `<div class="tx-chips tx-chips--docs">${chips}</div>` : ''}${picker}${add}`,
      { desc: esc('Two or three documents that clearly belong here.') });
  }
  function distSec(t, isDomain, n) {
    const ids = isDomain ? [t.id, ...kidsOf(t.id).map(x => x.id)] : [t.id];
    const rows = perKb(ids), max = rows[0]?.n || 1, total = rows.reduce((a, r) => a + r.n, 0);
    const list = rows.length ? `<ul class="tx-dist">${rows.map(({ kb, n: c }) => `<li class="tx-dist__row"><a class="tx-dist__name link truncate" href="#${catalogHref({ filters: { topic: [t.id], kb: [kb.id] } })}" translate="no">${esc(kb.name)}</a><span class="tx-dist__bar" aria-hidden="true"><span style="width:${Math.max(3, Math.round(c / max * 100))}%"></span></span><span class="tx-dist__n">${fmtNum(c)}</span></li>`).join('')}</ul>`
      : `<p class="tx-sec__empty">${esc('No published documents yet.')}</p>`;
    const confirm = toConfirm(ids), rv = isDomain ? n.reviewDomain(t.id) : n.review(t.id);
    const pending = [
      confirm && `<a class="link" href="#${topicsHref('suggestions')}">${esc(`${fmtNum(confirm)} to confirm from a first sync`)}</a>`,
      rv && `<a class="link" href="#${docsHref('review')}">${esc(`${fmtNum(rv)} in review`)}</a>`,
    ].filter(Boolean);
    return sec('Distribution', list + (pending.length ? `<p class="tx-dist__pending">${ic('clock', 'i-sm')}<span>${pending.join(DOT)}</span></p>` : ''),
      { aside: `<span class="tx-sec__meta">${esc(`${plural(total, 'published document')} · ${plural(rows.length, 'collection')}`)}</span>` });
  }
  function domainTopicsSec(dm, n) {
    const kids = kidsOf(dm.id);
    const rows = kids.map(t => {
      const kw = topicKeywords(t).length + topicSynonyms(t).length;
      return `<li><button type="button" class="tx-trow" data-act="tx-node" data-id="${esc(t.id)}"><span class="tx-row__code">${esc(t.code || '')}</span><span class="tx-trow__name truncate" translate="no">${esc(t.name)}</span><span class="${cx('tx-trow__kw', !kw && 'is-warn')}">${esc(kw ? plural(kw, 'keyword') : 'No keywords')}</span><span class="tx-trow__n">${esc(`${fmtNum(n.topic(t.id))} published`)}</span>${ic('chevron-right', 'i-sm muted')}</button></li>`;
    }).join('');
    return sec('Topics', kids.length ? `<ul class="tx-trows">${rows}</ul>` : `<p class="tx-sec__empty">${esc('No topics yet.')}</p>`,
      { aside: btn('Add topic', { v: 'ghost', size: 'sm', icon: 'plus', act: 'tx-add', data: { kind: 'topic', parent: dm.id } }) });
  }

  /* ── Test classification: a title (or path) against the taxonomy, with this topic's unsaved changes ── */
  const TEST = () => ui('txTest', { q: '', src: '', ran: null });
  /** Run topicMatches with the draft applied to the topic, then put the topic back. */
  function withDraft(t, f, fn) {
    if (!f) return fn();
    const keep = Object.fromEntries(['name', 'keywords', 'synonyms', 'rules', 'examples'].map(k => [k, t[k]]));
    Object.assign(t, { name: clean(f.name) || t.name, keywords: f.keywords, synonyms: f.synonyms, rules: f.rules, examples: f.examples });
    try { return fn(); } finally { Object.assign(t, keep); }
  }
  function runTest(t, f, { q, src }) {
    const raw = clean(q), parts = raw.split(/\s*[/\\]\s*/).filter(Boolean), name = parts.at(-1) || raw;
    const doc = { id: '__tx-test', name, path: parts.length > 1 ? raw : '', type: (name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || '').toLowerCase(), source: src || '' };
    const kb = src ? kbById(srcById(src)?.kb) : null;
    return withDraft(t, f, () => topicMatches(name, kb, similarDocs(doc), doc));
  }
  function testSec(t, f, dirty) {
    const u = TEST(), ran = u.ran?.node === t.id ? u.ran : null;
    const form = `<div class="tx-test__form">${input({ id: 'tx-test-q', bind: 'txTest.q', value: u.q, placeholder: 'A title, e.g. Refund procedure 2027.pdf', size: 'sm', onEnter: 'tx-test', cls: 'tx-test__q', attrs: `aria-label="${esc('Document title or path')}" spellcheck="false" data-id="${esc(t.id)}"` })}${select({ id: 'tx-test-src', bind: 'txTest.src', value: u.src, options: [['', 'Any source'], ...sourceOptions()], size: 'sm', label: 'Source', cls: 'tx-test__src' })}${btn('Test', { v: 'secondary', size: 'sm', act: 'tx-test', data: { id: t.id } })}</div>`;
    const hint = `<span>${esc('Try a title, or a path (Folder / File.pdf) for folder rules.')}</span>${dirty ? ` <span>${esc('Uses your unsaved changes.')}</span>` : ''}`;
    let out = '';
    if (ran) {
      const res = runTest(t, f, ran), rank = res.findIndex(x => x.id === t.id);
      const verdict = rank === 0 ? `<p class="tx-test__verdict is-ok">${ic('check-circle', 'i-sm')}<span>${esc('This topic comes first.')}</span></p>`
        : rank > 0 ? `<p class="tx-test__verdict">${ic('info', 'i-sm')}<span>${esc(`This topic comes ${rank + 1}${rank === 1 ? 'nd' : 'rd'}.`)}</span></p>`
          : `<p class="tx-test__verdict is-warn">${ic('alert-circle', 'i-sm')}<span>${esc('This topic isn’t among the matches. Add a keyword, synonym or rule this title would hit.')}</span></p>`;
      const strength = s => (s >= 1.2 ? chip('Strong', { size: 'sm', tone: 'success' }) : s >= 0.5 ? chip('Possible', { size: 'sm', tone: 'accent' }) : chip('Weak', { size: 'sm' }));
      const rows = res.map((x, i) => {
        const tp = topicById(x.id), ev = topicEvidence(x.why);
        return `<li class="${cx('tx-result', x.id === t.id && 'is-self')}"><span class="tx-result__rank">${i + 1}</span><div class="tx-result__main"><div class="tx-result__name"><span class="medium" translate="no">${esc(tp?.name || '')}</span>${DOT}<span class="muted" translate="no">${esc(topicName(tp?.parent))}</span></div>${ev.length ? `<div class="tx-result__why">${ev.map(s => `<span>${esc(s)}</span>`).join(DOT)}</div>` : ''}</div>${strength(x.score)}</li>`;
      }).join('');
      out = `<div class="tx-test__out" aria-live="polite">${verdict}${res.length ? `<ol class="tx-results">${rows}</ol>` : `<p class="tx-sec__empty">${esc('Nothing in the taxonomy matched. The document would wait for a person to pick its topic.')}</p>`}</div>`;
    }
    return sec('Test classification', `<div class="tx-test">${form}${out}</div>`, { desc: hint });
  }
  A['tx-test'] = el => {
    const u = TEST(), id = el.dataset.id || S.cur?.query.node;
    if (!clean(u.q)) { $('#tx-test-q')?.focus(); return; }
    u.ran = { node: id, q: u.q, src: u.src }; refresh();
  };

  /* ── Proposed by the assistant (decided only here) ── */
  /** Proposals come from all open submissions (names only); document titles are listed only for documents the caller can see. */
  const visibleProposals = () => { D.docs.filter(d => !d.archived && stageOf(d) === 'review' && !d.ai).forEach(aiOf); return openProposals(); };
  /** Topics the assistant proposes, for Topics → Suggestions: workspace admins decide them; others see them read-only. */
  function proposals() {
    const props = visibleProposals();
    return props.length ? `<ul class="md-props">${props.map(propCard).join('')}</ul>` : '';
  }
  function propForm(p) {
    const all = ui('mdProp', {});
    return (all[p.id] ??= { name: p.name, parent: p.parent && live(topicById(p.parent)) ? p.parent : '__new', dname: p.name, into: '', err: '', edit: '' });
  }
  function propDocs(p) {
    const docs = (p.docs || []).map(docById).filter(Boolean), seen = docs.filter(canSeeDoc), hidden = docs.length - seen.length;
    const link = d => `<a class="md-prop__doc link" href="#${esc(stageOf(d) === 'review' ? docsHref('review', { sel: d.id }) : '/doc/' + d.id)}"><span class="truncate">${esc(d.name)}</span></a>`;
    return `<span class="md-prop__docs"><span>${esc(`Suggested by ${plural(docs.length, 'document')}`)}${seen.length ? ':' : ''}</span>${seen.map(link).join('<span aria-hidden="true">,</span>')}${hidden && seen.length ? `<span>${esc(`+${hidden} more`)}</span>` : ''}</span>`;
  }
  /** A proposal reads as a sentence (name, in which domain, why) with Accept; editing opens only when Rename, Change domain or Merge is chosen. */
  function propCard(p) {
    const f = propForm(p), id = esc(p.id), dom = f.parent !== '__new' && topicById(f.parent);
    const where = dom ? `in ${esc(dom.name)}` : `as a new domain${f.dname && f.dname !== f.name ? ` “${esc(f.dname)}”` : ''}`;
    let editor = '';
    if (f.edit === 'name') editor = field({ id: `md-pn-${id}`, label: 'Topic name', error: f.err, control: input({ id: `md-pn-${id}`, bind: `mdProp.${p.id}.name`, value: f.name, size: 'sm', invalid: !!f.err, onEnter: 'md-prop-accept', attrs: `maxlength="60" data-id="${id}" data-autofocus` }) });
    else if (f.edit === 'domain') editor = field({ id: `md-pd-${id}`, label: 'Domain', error: f.err, control: select({ id: `md-pd-${id}`, bind: `mdProp.${p.id}.parent`, value: f.parent, options: [...domains().map(d => [d.id, d.name]), ['__new', 'New domain…']], change: 'md-redraw', size: 'sm' }) })
      + (f.parent === '__new' ? field({ id: `md-pdn-${id}`, label: 'New domain name', control: input({ id: `md-pdn-${id}`, bind: `mdProp.${p.id}.dname`, value: f.dname, size: 'sm', attrs: 'maxlength="60"' }) }) : '');
    else if (f.edit === 'merge') editor = field({ id: `md-pm-${id}`, label: 'Merge into', error: f.err, control: select({ id: `md-pm-${id}`, bind: `mdProp.${p.id}.into`, value: f.into, size: 'sm', change: 'md-redraw', options: [['', 'Choose a topic'], ...topicTree().flatMap(dm => dm.children.map(t => [t.id, `${dm.name} · ${t.name}`]))] }) });
    const main = f.edit === 'merge' ? btn('Merge', { v: 'secondary', size: 'sm', icon: 'git-compare', act: 'md-prop-merge', data: { id: p.id } }) : btn('Accept', { v: 'secondary', size: 'sm', icon: 'check', act: 'md-prop-accept', data: { id: p.id } });
    const acts = !canManageTaxonomy() ? '<span class="t-xs muted">A workspace admin decides</span>'
      : (f.edit ? btn('Cancel', { v: 'ghost', size: 'sm', act: 'md-prop-cancel', data: { id: p.id } }) : '') + main + iconBtn('more', 'More actions', { size: 'sm', menu: 'md-prop-more', data: { id: p.id } });
    return `<li class="md-prop" data-id="${id}">${itemIcon('sparkles', 'accent', 'sm')}
      <div class="md-prop__main"><div class="md-prop__title"><span class="medium" translate="no">${esc(f.name)}</span> <span class="muted">${where}</span></div>${propDocs(p)}${editor ? `<div class="md-prop__edit">${editor}</div>` : ''}</div>
      <div class="md-prop__acts">${acts}</div></li>`;
  }

  /* ── Keywords from corrections: what reviewers' topic changes suggest (core/lifecycle.js correctionSuggestions) ── */
  function learn() {
    const list = correctionSuggestions();
    return list.length ? `<ul class="md-learns">${list.map(learnCard).join('')}</ul>` : '';
  }
  /** Whole sentences per line (each translates as a unit); the topic opens from Open topic. */
  function learnCard(s) {
    const t = topicById(s.topic), n = s.corrections.length;
    const from = s.from.length ? `${n === 1 ? 'The pipeline had filed it under' : 'The pipeline had filed them under'} ${s.from.map(topicName).join(', ')}.` : n === 1 ? 'The pipeline had found no topic for it.' : 'The pipeline had found no topic for them.';
    const docs = s.corrections.slice(0, 3).map(c => { const d = docById(c.doc); return d && canSeeDoc(d) ? `<a class="link" href="#/doc/${esc(d.id)}" translate="no">${esc(docTitle(d))}</a>` : `<span translate="no">${esc(c.title)}</span>`; });
    const more = n > 3 ? ` <span class="muted">${esc(`+${n - 3} more`)}</span>` : '';
    const kws = s.phrases.length
      ? `<div class="md-learn__row"><span class="t-label">${esc('Add as a keyword')}</span><div class="md-learn__chips">${s.phrases.map(p => `<button type="button" class="chip chip--soft chip--accent md-learn__kw" data-act="md-learn-kw" data-id="${esc(s.topic)}" data-kw="${esc(p.text)}" data-tip="${esc(`In ${p.n} of these titles`)}">${ic('plus', 'i-xs')}<span translate="no">${esc(p.text)}</span></button>`).join('')}</div></div>`
      : `<p class="md-learn__note">${esc(n === 1 ? 'One correction isn’t a pattern yet. Add the document as an example, or wait for more.' : 'Their titles share no new word. Add them as examples instead.')}</p>`;
    const misled = s.misled.map(m => `<p class="md-learn__why">${ic('info', 'i-sm')}<span>${esc(`Misled by “${m.text}”, a keyword of ${topicName(m.elsewhere)}.`)}</span></p>`).join('');
    return `<li class="md-learn">
      <div class="md-learn__title medium">${esc(`Reviewers moved ${plural(n, 'document')} to ${t?.name || ''}`)}</div>
      <p class="md-learn__note">${esc(from)}</p>
      <div class="md-learn__docs">${docs.join('<span aria-hidden="true">, </span>')}${more}</div>
      ${kws}${misled}
      <div class="md-learn__acts">${btn('Open topic', { v: 'ghost', size: 'sm', icon: 'tag', act: 'md-edit', data: { id: s.topic } })}${btn('Add as examples', { v: 'ghost', size: 'sm', icon: 'file-plus', act: 'md-learn-ex', data: { id: s.topic } })}${btn('Dismiss', { v: 'ghost', size: 'sm', act: 'md-learn-dismiss', data: { id: s.topic } })}</div></li>`;
  }
  const learnOf = id => correctionSuggestions().find(s => s.topic === id);
  /** After a rule change (`before`: the topics as they were): re-classify submissions in review and re-check the published
      documents the pipeline tagged (no re-indexing: topics live in the index's metadata). Says what happened, with one Undo
      for all of it. */
  function applyRuleChange(msg, before, undoRules, again = reclassifyOpen()) {
    let rc = null, first = '';
    const undo = { label: 'Undo', run: () => { rc?.revert(); undoRules(); if (again) reclassifyOpen(); refresh(); } };
    rc = reclassifyPublished(before, () => {
      if (!rc.checked) return;
      const changed = rc.changed.length;
      dismissToast(first);
      toast(`${msg} · ${plural(rc.checked, 'document')} re-checked, ${changed ? `${plural(changed, 'document')} changed topic` : 'none changed topic'}. No re-indexing needed.`, { action: undo });
    });
    refresh();
    first = toast(rc.checked ? `${msg} · re-checking ${plural(rc.checked, 'published document')}…` : `${msg}${again ? ` · ${plural(again, 'submission')} classified again` : ''}`, { action: undo });
  }
  /** Add a phrase reviewers' corrections share as a keyword of the topic they moved documents to. */
  A['md-learn-kw'] = el => {
    const s = learnOf(el.dataset.id), t = topicById(el.dataset.id), kw = el.dataset.kw; if (!s || !t || !kw || !canManageTaxonomy()) return;
    const snap = snapTopics(), used = s.corrections.filter(c => fold(c.title).includes(fold(kw)));
    t.keywords = [...topicKeywords(t), kw];
    used.forEach(c => { c.status = 'used'; });
    audit('Added a keyword from corrections', `${kw} → ${t.name}`);
    applyRuleChange(`Added “${kw}” to ${t.name}`, snap, () => { D.topics = snap; used.forEach(c => { c.status = 'open'; }); });
  };
  /** Add the corrected documents as examples of the topic (at most five examples). */
  A['md-learn-ex'] = el => {
    const s = learnOf(el.dataset.id), t = topicById(el.dataset.id); if (!s || !t || !canManageTaxonomy()) return;
    const ids = s.corrections.map(c => c.doc).filter(id => docById(id) && isPublishedStage(docById(id)) && !(t.examples || []).includes(id));
    if (!ids.length) { toast('These documents aren’t published yet. Approve them first.', { tone: 'accent' }); return; }
    const snap = snapTopics(), add = ids.slice(0, Math.max(0, 5 - (t.examples || []).length));
    if (!add.length) { toast(`${t.name} already has five examples`, { tone: 'accent' }); return; }
    t.examples = [...(t.examples || []), ...add];
    const used = s.corrections.filter(c => add.includes(c.doc)); used.forEach(c => { c.status = 'used'; });
    audit('Added examples from corrections', `${plural(add.length, 'document')} → ${t.name}`);
    applyRuleChange(`Added ${plural(add.length, 'example')} to ${t.name}`, snap, () => { D.topics = snap; used.forEach(c => { c.status = 'open'; }); });
  };
  A['md-learn-dismiss'] = el => {
    const s = learnOf(el.dataset.id); if (!s || !canManageTaxonomy()) return;
    s.corrections.forEach(c => { c.status = 'dismissed'; }); refresh();
    toast(`Dismissed ${plural(s.corrections.length, 'correction')}`, { action: { label: 'Undo', run: () => { s.corrections.forEach(c => { c.status = 'open'; }); refresh(); } } });
  };
  const propOf = el => { const p = proposalById(el.dataset.id || el.closest?.('[data-id]')?.dataset.id); return p && p.status === 'open' ? p : null; };
  MENUS['md-prop-more'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return [];
    const f = propForm(p), edit = mode => () => { Object.assign(f, { edit: mode, err: '' }); refresh(); };
    return [
      { label: 'Rename…', icon: 'pencil', run: edit('name') },
      { label: 'Change domain…', icon: 'folder', run: edit('domain') },
      { label: 'Merge into…', icon: 'git-compare', run: edit('merge') },
      { sep: true },
      { label: 'Dismiss', icon: 'x', danger: true, run: () => A['md-prop-dismiss']({ dataset: { id: p.id } }) },
    ];
  };
  A['md-redraw'] = () => refresh();
  A['md-prop-cancel'] = el => { const p = proposalById(el.dataset.id); if (p) delete S.ui.mdProp?.[p.id]; refresh(); };
  /** Snapshot of everything a taxonomy change touches (Undo). */
  const snapTopics = () => JSON.parse(JSON.stringify(D.topics || []));
  function propSnap(p) { return { topics: snapTopics(), p: { ...p, docs: [...(p.docs || [])] }, docs: (p.docs || []).map(docById).filter(Boolean).map(d => [d, snapDoc(d)]) }; }
  function propUndo(p, snap, msg) {
    return { label: 'Undo', run: () => {
      D.topics = snap.topics;
      Object.keys(p).forEach(k => delete p[k]); Object.assign(p, snap.p);
      snap.docs.forEach(([d, s]) => restoreDoc(d, s));
      audit('Undid a topic decision', p.name); refresh(); toast(msg, { tone: 'accent' });
    } };
  }
  A['md-prop-accept'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return;
    const f = propForm(p), name = clean(f.name);
    const newDom = f.parent === '__new' || !topicById(f.parent), dname = clean(f.dname) || name;
    // Errors open the editor that fixes them.
    const fail = (msg, edit = 'name') => { Object.assign(f, { err: msg, edit }); refresh(); requestAnimationFrame(() => $(`#md-${edit === 'name' ? 'pn' : 'pd'}-${p.id}`)?.focus()); };
    if (!name) return fail('Enter a name.');
    if (!newDom && leaves().some(t => t.parent === f.parent && fold(t.name) === fold(name))) return fail(`${topicName(f.parent)} already has “${name}”. Merge into it instead.`);
    if (newDom && domains().some(d => fold(d.name) === fold(dname))) return fail(`A domain called “${dname}” already exists. Pick it from the list.`, 'domain');
    const snap = propSnap(p);
    let parent = newDom ? null : f.parent;
    if (newDom) { const dm = { id: uid('d'), name: dname, code: domainCode(dname) }; D.topics.push(dm); parent = dm.id; }
    const t = acceptProposal(p, { name, parent });
    if (!t) { D.topics = snap.topics; return; }
    t.code = nextCode(parent); t.keywords = proposalKeywords(name);
    delete S.ui.mdProp?.[p.id];
    refresh();
    toast(`Added “${t.name}” to ${topicName(parent)}${snap.docs.length ? ` · ${plural(snap.docs.length, 'document')} tagged` : ''}`, { action: propUndo(p, snap, `“${name}” removed`) });
  };
  A['md-prop-dismiss'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return;
    const snap = propSnap(p);
    dismissProposal(p); delete S.ui.mdProp?.[p.id]; refresh();
    toast(`Dismissed “${p.name}”`, { action: propUndo(p, snap, `“${p.name}” is proposed again`) });
  };
  A['md-prop-merge'] = el => {
    const p = propOf(el); if (!p || !canManageTaxonomy()) return;
    const f = propForm(p), t = topicById(f.into);
    if (!t) { f.err = 'Choose the topic to merge into.'; refresh(); return; }
    const snap = propSnap(p);
    mergeProposal(p, t.id);
    // The proposal's name becomes a synonym of the topic it joins, so the next document like it is classified there.
    if (![...topicKeywords(t), ...topicSynonyms(t)].some(k => fold(k) === fold(p.name))) t.synonyms = [...topicSynonyms(t), p.name.toLowerCase()];
    delete S.ui.mdProp?.[p.id]; refresh();
    toast(`Merged “${p.name}” into ${t.name}${snap.docs.length ? ` · ${plural(snap.docs.length, 'document')} tagged` : ''}`, { action: propUndo(p, snap, `“${p.name}” is proposed again`) });
  };
  /** Starter keywords for a topic accepted from a proposal: the phrases that raised it (PROPOSAL_RULES). */
  const PROPOSAL_KW = { 'open banking': ['open banking', 'open api', 'account aggregation'], 'ai governance': ['ai governance', 'genai', 'llm', 'model risk'], internships: ['internship', 'intern'], sustainability: ['sustainability', 'esg', 'carbon'], 'hybrid work': ['hybrid work', 'return to office'] };
  const proposalKeywords = name => PROPOSAL_KW[fold(name)] || [name.toLowerCase()];

  /* ── Archived ── */
  function archivedDetail(t) {
    const head = `<header class="tx-head"><div class="tx-head__main"><div class="tx-head__title-row"><span class="md-code md-code--domain">${esc(t.code || '')}</span><h2 class="tx-head__title" translate="no">${esc(t.name)}</h2>${chip('Archived', { size: 'sm' })}</div>
      <p class="tx-head__meta">${t.parent ? `<span translate="no">${esc(topicName(t.parent))}</span>${DOT}` : ''}<span>${esc('Hidden from Browse and from classification. Documents keep it until they’re retagged.')}</span></p></div><div class="tx-head__acts">${btn('Restore', { v: 'secondary', size: 'sm', icon: 'undo', act: 'tx-restore', data: { id: t.id } })}</div></header>`;
    const desc = t.desc ? sec('Description', `<p class="tx-text">${esc(t.desc)}</p>`) : '';
    return `<div class="tx-detail">${back()}${head}${desc}</div>`;
  }
  A['tx-restore'] = el => {
    const t = topicById(el.dataset.id); if (!t || !canManageTaxonomy()) return;
    const dm = t.parent && topicById(t.parent);
    if (dm?.archived) { toast(`Restore ${dm.name} first: its domain is archived.`, { tone: 'accent' }); return; }
    delete t.archived; audit('Restored a topic', t.name); refresh();
    toast(`Restored “${t.name}”`, { action: { label: 'Undo', run: () => { t.archived = true; refresh(); } } });
  };

  /* ═══════════════ Edit actions ═══════════════ */
  const draftFor = el => { const key = el.dataset.id; return key && DRAFTS()[key] ? [key, DRAFTS()[key]] : [key, null]; };
  /** Repaint only when something visible depends on the keystroke (savebar, the tree's unsaved dot, errors, test results). */
  A['tx-input'] = el => {
    const [key, f] = draftFor(el); if (!f) return;
    const shown = !!$('#app .tx-detail .savebar');
    if (isDirty(key) !== shown || f.tried || (el.dataset.test != null && TEST().ran)) refresh();
  };
  A['tx-redraw'] = () => refresh();
  A['tx-parent'] = el => { const [key, f] = draftFor(el); if (f && key === NEW) f.code = nextCode(f.parent); refresh(); };
  function addTerms(f, list) {
    const other = list === 'keywords' ? 'synonyms' : 'keywords';
    const have = [...f[list], ...f[other]].map(fold), add = splitKw(f[`${list}In`]).filter(k => !have.includes(fold(k)));
    f[list] = [...f[list], ...add]; f[`${list}In`] = '';
    return add.length;
  }
  A['tx-chip-add'] = el => { const [, f] = draftFor(el); if (!f) return; addTerms(f, el.dataset.list); refresh(); $(`#tx-${el.dataset.list}-in`)?.focus(); };
  A['tx-chip-type'] = el => { if (/[,;]/.test(el.value)) A['tx-chip-add'](el); };
  A['tx-chip-rm'] = el => { const [, f] = draftFor(el); if (!f) return; f[el.dataset.list].splice(+el.dataset.i, 1); refresh(); $(`#tx-${el.dataset.list}-in`)?.focus(); };
  A['tx-rule-add'] = el => { const [, f] = draftFor(el); if (!f) return; f.rules.push({ field: 'path', op: 'contains', value: '' }); refresh(); $(`#tx-rv-${f.rules.length - 1}`)?.focus(); };
  A['tx-rule-rm'] = el => { const [, f] = draftFor(el); if (!f) return; f.rules.splice(+el.dataset.i, 1); refresh(); };
  A['tx-rule-field'] = el => {
    const [, f] = draftFor(el), r = f?.rules[+el.dataset.i]; if (!r) return;
    Object.assign(r, { value: '' }, r.field === 'source' ? { op: 'is' } : {});
    refresh(); $(`#tx-rv-${el.dataset.i}`)?.focus();
  };
  A['tx-ex-q'] = () => refresh();
  A['tx-ex-open'] = el => { const [, f] = draftFor(el); if (!f) return; f.exOpen = true; refresh(); $('#tx-ex-q')?.focus(); };
  A['tx-ex-add'] = el => { const [, f] = draftFor(el); if (!f || f.examples.includes(el.dataset.doc)) return; f.examples.push(el.dataset.doc); f.exQ = ''; refresh(); $('#tx-ex-q')?.focus(); };
  A['tx-ex-rm'] = el => { const [, f] = draftFor(el); if (!f) return; f.examples = f.examples.filter(id => id !== el.dataset.doc); refresh(); };
  A['tx-discard'] = el => {
    const [key, f] = draftFor(el); if (!f) return;
    delete DRAFTS()[key];
    if (key === NEW) setQuery({ node: f.parent || '' }); else refresh();
  };
  function validate(f, t, isDomain) {
    const err = {}, name = clean(f.name);
    let code = clean(f.code).toUpperCase();
    if (!t && !code && name) code = isDomain ? domainCode(name) : nextCode(f.parent);
    if (!name) err.name = 'Enter a name.';
    else if ((D.topics || []).some(x => live(x) && x.id !== t?.id && (isDomain ? !x.parent : x.parent === f.parent) && fold(x.name) === fold(name))) err.name = isDomain ? `A domain called “${name}” already exists.` : `${topicName(f.parent)} already has “${name}”.`;
    if (!code) err.code = 'Enter a code.';
    else if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(code)) err.code = 'Use letters, numbers, dots and dashes.';
    else if ((D.topics || []).some(x => x.id !== t?.id && x.code === code)) err.code = `${code} is already used by “${(D.topics || []).find(x => x.code === code).name}”.`;
    if (!isDomain && !topicById(f.parent)) err.parent = 'Choose a domain.';
    return { err, name, code };
  }
  A['tx-save'] = el => {
    const [key, f] = draftFor(el); if (!f || !canManageTaxonomy()) return;
    const t = key === NEW ? null : topicById(key), isDomain = t ? !t.parent : f.domain;
    // Words still in the chip inputs count: nobody expects Save to drop what they typed.
    if (!isDomain) { addTerms(f, 'keywords'); addTerms(f, 'synonyms'); }
    const { err, name, code } = validate(f, t, isDomain); f.err = err; f.tried = true;
    if (Object.keys(err).length) { f.ident = true; refresh(); $(err.name ? '#tx-name' : '#tx-code')?.focus(); return; }
    const snap = snapTopics(), desc = clean(f.desc) || undefined;
    const rules = f.rules.filter(r => clean(r.value)).map(r => ({ field: r.field, op: r.field === 'source' ? 'is' : r.op, value: clean(r.value) }));
    const extra = isDomain ? {} : { parent: f.parent, keywords: [...f.keywords], synonyms: f.synonyms.length ? [...f.synonyms] : undefined, guidance: cleanBlock(f.guidance) || undefined, rules: rules.length ? rules : undefined, examples: f.examples.length ? [...f.examples] : undefined };
    let target = t;
    if (t) {
      const moved = !isDomain && t.parent !== f.parent;
      Object.assign(t, { name, code, desc }, extra);
      audit(isDomain ? 'Edited a domain' : 'Edited a topic', `${code} ${name}${moved ? ` → ${topicName(f.parent)}` : ''}`);
    } else {
      target = JSON.parse(JSON.stringify({ id: uid(isDomain ? 'd' : 't'), name, code, desc, ...extra }));
      const at = isDomain ? D.topics.length - 1 : D.topics.map(x => x.parent === f.parent || x.id === f.parent).lastIndexOf(true);
      D.topics.splice(at + 1, 0, target);
      audit(isDomain ? 'Added a domain' : 'Added a topic', isDomain ? `${code} ${name}` : `${code} ${name} → ${topicName(f.parent)}`);
    }
    delete DRAFTS()[key];
    if (!t) showNode(target.id);
    const label = `${t ? 'Saved' : 'Added'} “${name}”`;
    const undoRules = () => { D.topics = snap; audit('Undid a change to the topics', name); if (!t) setQuery({ node: f.parent || '' }); };
    if (!isDomain) { applyRuleChange(label, snap, undoRules); return; }
    if (t) refresh();
    toast(label, { action: { label: 'Undo', run: () => { undoRules(); refresh(); } } });
  };
  MENUS['tx-more'] = el => {
    const t = topicById(el.dataset.id); if (!t || !canManageTaxonomy()) return [];
    const f = draftOf(t.id);
    return [
      { label: t.parent ? 'Edit name, code and domain…' : 'Edit name and code…', icon: 'pencil', run: () => { f.ident = true; refresh(); $('#tx-name')?.focus(); } },
      { sep: true },
      { label: 'Archive', icon: 'archive', danger: true, run: () => archive(t) },
    ];
  };
  /** Archive acts at once with Undo; while documents or topics still use it, it says what to do first instead. */
  function archive(t) {
    const used = usedBy(t);
    if (used) { toast(t.parent ? `Documents use “${t.name}”. Retag them first, then archive it.` : `“${t.name}” still has topics or documents. Move or archive them first.`, { tone: 'accent' }); return; }
    t.archived = true; delete DRAFTS()[t.id];
    audit(t.parent ? 'Archived a topic' : 'Archived a domain', t.name);
    setQuery({ node: t.parent || '' });
    toast(`Archived “${t.name}”`, { action: { label: 'Undo', run: () => { delete t.archived; setQuery({ node: t.id }); } } });
  }

  /* ═══════════════ Import · export ═══════════════ */
  const rowsOfTopics = () => {
    ensureCodes();
    return domains().flatMap(dm => [[dm.code, dm.name, '', dm.desc || '', '', '', ''], ...kidsOf(dm.id).map(t => [t.code, t.name, dm.code, t.desc || '', topicKeywords(t).join('; '), topicSynonyms(t).join('; '), t.guidance || ''])]);
  };
  const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  function exportCsv() {
    const rows = rowsOfTopics();
    saveCsv(`${slug(curWs().name)}-taxonomy.csv`, [COLS, ...rows], `Exported ${plural(rows.length, 'row')}`);
    audit('Exported the taxonomy', curWs().name);
  }
  function templateCsv() {
    saveCsv('taxonomy-template.csv', [COLS, ['OPS', 'Banking Operations', '', 'Cut-off times, settlement and disputes.', '', '', ''], ['OPS-01', 'Cards & disputes', 'OPS', 'Chargebacks and cardholder disputes.', 'chargeback; dispute; card scheme', 'cardholder dispute; reason code', 'Use for card disputes and chargebacks.\nNot for merchant fees.']], 'Template downloaded');
  }

  /** A deterministic sample spreadsheet built from the current taxonomy: every row, keywords added to a few topics,
      the topics the assistant has been proposing, one row whose domain doesn't exist and one duplicated code.
      The last unused topic is left out, so Replace has something to archive. */
  function sampleRows() {
    ensureCodes();
    const rows = rowsOfTopics(), n = topicCounts();
    const unused = [...leaves()].reverse().find(t => !n.topic(t.id) && !n.review(t.id));
    const out = rows.filter(r => r[0] !== unused?.code);
    // Richer keywords for the four topics that have the fewest: the words of their own name.
    const kwCount = r => r[4].split(';').map(clean).filter(Boolean).length;
    out.filter(r => r[2]).sort((a, b) => kwCount(a) - kwCount(b)).slice(0, 4).forEach(r => {
      const extra = r[1].toLowerCase().split(/\s*(?:&|,|\band\b)\s*/).filter(w => w.length > 3);
      r[4] = [...new Set([...r[4].split(';').map(clean).filter(Boolean), ...extra])].join('; ');
    });
    // New topics: themes documents keep raising.
    PROPOSAL_RULES.forEach(([, name, parents]) => {
      if ((D.topics || []).some(t => live(t) && fold(t.name) === fold(name))) return;
      const dom = domains().find(d => parents.some(p => fold(p) === fold(d.name)));
      // A theme with no fitting domain points at one that doesn't exist yet: the row the check step skips (once).
      if (!dom) { if (!out.some(r => r[2] === 'ESG')) out.push(['ESG-01', name, 'ESG', '', proposalKeywords(name).join('; '), '', '']); return; }
      out.push([`${dom.code}-${String(90 + out.filter(r => r[2] === dom.code && /-9\d$/.test(r[0])).length).padStart(2, '0')}`, name, dom.code, '', proposalKeywords(name).join('; '), '', '']);
    });
    const first = out.find(r => r[2]);
    if (first) out.push([first[0], `${first[1]} (old)`, first[2], '', '', '', '']);
    return out;
  }

  /** Read a CSV the browser picked (code, name, parent_code, description, keywords, synonyms, guidance; header names in any
      order; only code and name are required). `has` says which optional columns the file carries: the others stay as they are. */
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const body = rows.filter(r => r.some(x => clean(x)));
    if (!body.length) return { error: 'The file is empty.' };
    const head = body[0].map(h => fold(h).replace(/^\ufeff/, '').replace(/[^a-z]+/g, '_').replace(/^_|_$/g, ''));
    const ALIAS = { parent_code: ['parent', 'domain', 'domain_code'], synonyms: ['synonym'], guidance: ['guidance_for_the_assistant', 'assistant_guidance'] };
    const at = k => head.findIndex(h => h === k || (ALIAS[k] || []).includes(h));
    const idx = COLS.map(at);
    if (idx[0] < 0 || idx[1] < 0) return { error: 'The first row must name the columns: code, name, parent_code, description, keywords, synonyms, guidance.' };
    const has = { description: idx[3] >= 0, keywords: idx[4] >= 0, synonyms: idx[5] >= 0, guidance: idx[6] >= 0 };
    return { has, rows: body.slice(1).map(r => idx.map((i, c) => (i < 0 ? '' : COLS[c] === 'guidance' ? cleanBlock(r[i]) : clean(r[i])))) };
  }

  /** Compare spreadsheet rows with the taxonomy: { added[], updated[], same, archived[], kept[], errors[] }.
      Each change: { code, name, parent (code), desc, keywords, synonyms, guidance, row (1-based, header = 1), t (existing topic), what[] }.
      Columns the file doesn't have (`has`) are neither compared nor applied. */
  function diff(rows, mode, has = ALL_COLS) {
    ensureCodes();
    const byCode = new Map((D.topics || []).filter(t => t.code).map(t => [t.code, t]));
    const fileDomains = new Set(rows.filter(r => r[0] && r[1] && !r[2]).map(r => r[0].toUpperCase()));
    const seen = new Set(), out = { added: [], updated: [], same: 0, archived: [], kept: [], errors: [] };
    const listDelta = (what, before, after, noun) => {
      if (kwEq(before, after)) return;
      const plus = after.filter(k => !before.some(x => fold(x) === fold(k))).length, minus = before.filter(k => !after.some(x => fold(x) === fold(k))).length;
      if (plus) what.push(`${plural(plus, noun)} added`);
      if (minus) what.push(`${plural(minus, noun)} removed`);
      if (!plus && !minus) what.push(`${noun}s`);
    };
    rows.forEach((r, i) => {
      const [rawCode, name, rawParent, desc, kw, syn, guidance] = r, code = rawCode.toUpperCase(), parent = rawParent.toUpperCase(), row = i + 2;
      const fail = text => out.errors.push({ row, code: code || '—', text });
      if (!code) return fail('No code.');
      if (!name) return fail('No name.');
      if (seen.has(code)) return fail(`Code ${code} appears more than once. Only the first row is used.`);
      seen.add(code);
      if (parent && !fileDomains.has(parent) && !(byCode.get(parent) && !byCode.get(parent).parent)) return fail(`Domain ${parent} isn’t in the file or the taxonomy.`);
      const c = { code, name, parent, desc, keywords: splitKw(kw), synonyms: splitKw(syn), guidance: guidance || '', row }, t = byCode.get(code);
      if (!t) { out.added.push(c); return; }
      const what = [];
      if (t.name !== name) what.push(`renamed from “${t.name}”`);
      if (parent && codeOf(t.parent) !== parent) what.push(`moved to ${parent}`);
      if (has.description && (t.desc || '') !== desc) what.push('description');
      if (parent && has.keywords) listDelta(what, topicKeywords(t), c.keywords, 'keyword');
      if (parent && has.synonyms) listDelta(what, topicSynonyms(t), c.synonyms, 'synonym');
      if (parent && has.guidance && (t.guidance || '') !== c.guidance) what.push('guidance');
      if (t.archived) what.push('restored');
      if (what.length) out.updated.push({ ...c, t, what }); else out.same++;
    });
    if (mode === 'replace') {
      const n = topicCounts();
      (D.topics || []).filter(t => live(t) && t.code && !seen.has(t.code)).forEach(t => (usedBy(t, n) ? out.kept : out.archived).push(t));
    }
    return out;
  }
  const changeCount = x => x.added.length + x.updated.length + x.archived.length;

  /* ── Import dialog: choose a file → check the changes → import (Undo) ── */
  const IMP = () => ui('mdImport');
  A['md-import'] = () => {
    if (!canManageTaxonomy()) return;
    S.ui.mdImport = { step: 'file', mode: 'merge', file: null, rows: null, has: ALL_COLS, err: '', preview: false };
    openModal('md-import', {});
  };
  const sampleName = () => `${slug(curWs().name)}-taxonomy-2026-11.xlsx`;
  function readFile(file) {
    const f = IMP(), ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['csv', 'tsv', 'txt', 'xlsx', 'xls'].includes(ext)) { f.err = 'Choose a CSV or Excel file.'; refreshLayer(); return; }
    f.err = '';
    if (ext === 'xlsx' || ext === 'xls') {
      // The prototype can't read Excel in the browser: it shows the sample sheet instead, and says so.
      Object.assign(f, { file: { name: file.name, size: file.size || 18e3 }, rows: sampleRows(), has: ALL_COLS, preview: true, step: 'check' }); refreshLayer(); return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const p = parseCsv(String(reader.result || ''));
      if (p.error) { f.err = p.error; refreshLayer(); return; }
      if (!p.rows.length) { f.err = 'The file has a header but no rows.'; refreshLayer(); return; }
      Object.assign(f, { file: { name: file.name, size: file.size }, rows: p.rows, has: p.has, preview: false, step: 'check' }); refreshLayer();
    };
    reader.readAsText(file);
  }
  A['md-browse'] = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.hidden = true; inp.accept = '.csv,.tsv,.txt,.xlsx,.xls';
    inp.addEventListener('change', () => { if (inp.files?.[0]) readFile(inp.files[0]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  };
  A['md-sample'] = () => { Object.assign(IMP(), { file: { name: sampleName(), size: 21e3 }, rows: sampleRows(), has: ALL_COLS, preview: true, step: 'check', err: '' }); refreshLayer(); };
  A['md-mode'] = el => { IMP().mode = el.dataset.value; refreshLayer(); };
  A['md-back'] = () => { Object.assign(IMP(), { step: 'file', file: null, rows: null }); refreshLayer(); };
  document.addEventListener('dragover', e => { const z = e.target.closest?.('#md-drop'); if (!z) return; e.preventDefault(); z.classList.add('is-drag'); });
  document.addEventListener('dragleave', e => { const z = e.target.closest?.('#md-drop'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('is-drag'); });
  document.addEventListener('drop', e => { const z = e.target.closest?.('#md-drop'); if (!z) return; e.preventDefault(); const file = e.dataTransfer?.files?.[0]; if (file) readFile(file); });

  const MODES = [
    ['merge', 'Add and update', 'New codes are added and matching codes are updated. Nothing is removed.', 'plus'],
    ['replace', 'Replace', 'Also archives topics that aren’t in the file. Topics documents still use are kept.', 'refresh'],
  ];
  function changeList(title, items, line, tone, limit = 6) {
    if (!items.length) return '';
    const more = items.length - limit;
    return `<section class="md-chg"><h3 class="md-chg__title">${chip(fmtNum(items.length), { size: 'sm', tone })}<span>${esc(title)}</span></h3>
      <ul class="md-chg__list">${items.slice(0, limit).map(line).join('')}${more > 0 ? `<li class="muted">${esc(`+${fmtNum(more)} more`)}</li>` : ''}</ul></section>`;
  }
  const parentName = code => (D.topics || []).find(t => t.code === code)?.name || IMP().rows?.find(r => r[0].toUpperCase() === code)?.[1] || code;
  M['md-import'] = () => {
    const f = IMP();
    if (f.step === 'file') {
      const drop = `<button type="button" class="ctb-drop" id="md-drop" data-act="md-browse" aria-describedby="md-drop-hint"><span class="ctb-drop__icon">${ic('table', 'i-lg')}</span><span class="medium">Drop a spreadsheet here or <span class="text-accent">browse</span></span><span class="description" id="md-drop-hint">CSV or Excel · columns code, name, parent_code, description, keywords, synonyms, guidance</span></button>`;
      const err = f.err ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : '';
      const helpers = `<div class="ctb-samples"><span class="t-xs muted">Try it with</span>${btn(sampleName(), { size: 'sm', v: 'tertiary', icon: 'file', act: 'md-sample' })}<span class="grow"></span>${linkBtn('Download template', { act: 'md-template', icon: 'download' })}</div>`;
      return {
        size: 'md', icon: 'database', title: 'Import taxonomy', desc: `Update the domains, topics, keywords and synonyms ${esc(curWs().name)} classifies documents with. You check every change before it’s applied.`,
        body: drop + err + helpers + `<div class="field mt-16"><span class="label">How to apply it</span>${choiceGroup({ name: 'md-mode', value: f.mode, options: MODES, act: 'md-mode', cols: 2 })}</div>`,
        footStart: '<span class="t-xs muted">Nothing changes until you import.</span>',
        foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }),
      };
    }
    const x = diff(f.rows, f.mode, f.has), total = changeCount(x), open = reviewQueue().length;
    const resolved = openProposals().filter(p => x.added.some(c => fold(c.name) === fold(p.name)));
    const file = `<div class="md-file">${fileIcon(f.file.name.split('.').pop(), 'sm')}<div class="grow md-min"><div class="medium truncate" translate="no">${esc(f.file.name)}</div><div class="t-xs muted">${esc(`${plural(f.rows.length, 'row')} · ${fmtSize(f.file.size)}`)}</div></div>${f.preview ? chip('Sample data', { size: 'sm', icon: 'info', tip: 'The prototype can’t read Excel files, so it shows a sample sheet built from this workspace. CSV files are read for real.' }) : ''}${btn('Choose another file', { v: 'ghost', size: 'sm', act: 'md-back' })}</div>`;
    // Interface words and workspace names sit in separate nodes, so the interface language never rewrites a topic name.
    const name = s => `<span class="medium" translate="no">${esc(s)}</span>`, note = s => `<span class="muted">${esc(s)}</span>`;
    const errs = x.errors.length ? alertBox('warning', `${plural(x.errors.length, 'row')} will be skipped`, `<ul class="md-errs">${x.errors.map(e => `<li><span class="md-code">${esc(`Row ${e.row}`)}</span> <span translate="no">${esc(e.code)}</span>${DOT}<span>${esc(e.text)}</span></li>`).join('')}</ul>`) : '';
    const lists = changeList('New', x.added, c => `<li><span class="md-code">${esc(c.code)}</span>${name(c.name)}${c.parent ? `${DOT}<span class="muted" translate="no">${esc(parentName(c.parent))}</span>` : `${DOT}${note('new domain')}`}</li>`, 'success')
      + changeList('Updated', x.updated, c => `<li><span class="md-code">${esc(c.code)}</span>${name(c.name)}${DOT}${c.what.map(note).join('<span class="muted" aria-hidden="true">, </span>')}</li>`, 'accent')
      + changeList('Archived', x.archived, t => `<li><span class="md-code">${esc(t.code)}</span>${name(t.name)}${DOT}${note('not in the file, unused')}</li>`, 'default')
      + changeList('Kept although not in the file', x.kept, t => `<li><span class="md-code">${esc(t.code)}</span>${name(t.name)}${DOT}${note('documents use it')}</li>`, 'default', 4);
    const none = !total ? emptyState({ icon: 'check-circle', tone: 'success', title: 'Nothing to change', desc: 'The file matches the taxonomy.', compact: true }) : '';
    const missing = ['synonyms', 'guidance'].filter(k => !f.has?.[k]);
    const effects = total ? `<div class="md-effects">${ic('sparkles', 'i-sm')}<div>${[
      open && `${plural(open, 'submission')} in review will be classified again.`,
      resolved.length && `${resolved.map(p => `“${p.name}”`).join(', ')} ${resolved.length === 1 ? 'was proposed by the assistant and' : 'were proposed by the assistant and'} will be covered.`,
      'Published documents keep their topics. Rules and examples stay as they are.',
      missing.length && `The file has no ${missing.join(' or ')} column: those stay as they are.`,
    ].filter(Boolean).map(s => `<p>${esc(s)}</p>`).join('')}</div></div>` : '';
    return {
      size: 'lg', icon: 'database', title: 'Check the changes', desc: `${x.same ? `${plural(x.same, 'row')} unchanged. ` : ''}Import applies the changes below${f.mode === 'replace' ? ' and archives unused topics missing from the file' : ''}.`,
      body: `<div class="stack gap-16">${file}${errs}${none}${lists}${effects}</div>`,
      footStart: btn('Back', { v: 'ghost', icon: 'arrow-left', act: 'md-back' }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(total ? `Import ${plural(total, 'change')}` : 'Close', { v: 'primary', icon: total ? 'upload' : '', act: total ? 'md-apply' : 'close-modal' }),
    };
  };
  A['md-template'] = () => templateCsv();
  A['md-apply'] = () => {
    const f = IMP(); if (!f?.rows || !canManageTaxonomy()) return;
    const has = f.has || ALL_COLS, x = diff(f.rows, f.mode, has); if (!changeCount(x)) return;
    const snap = { topics: snapTopics(), imports: [...(D.masterImports || [])], props: JSON.parse(JSON.stringify(D.topicProposals || [])), docs: D.docs.filter(d => stageOf(d) === 'review').map(d => [d, snapDoc(d)]) };
    const idOf = new Map((D.topics || []).filter(t => t.code).map(t => [t.code, t.id]));
    const topicFields = (c, upd) => ({
      ...(has.keywords || !upd ? { keywords: c.keywords } : {}),
      ...(has.synonyms ? { synonyms: c.synonyms.length ? c.synonyms : undefined } : {}),
      ...(has.guidance ? { guidance: c.guidance || undefined } : {}),
    });
    // Domains first, so new topics can point at them.
    [...x.added].sort((a, b) => !!a.parent - !!b.parent).forEach(c => {
      const t = JSON.parse(JSON.stringify({ id: uid(c.parent ? 't' : 'd'), name: c.name, code: c.code, desc: c.desc || undefined, ...(c.parent ? { parent: idOf.get(c.parent), ...topicFields(c, false) } : {}) }));
      D.topics.push(t); idOf.set(c.code, t.id);
    });
    x.updated.forEach(c => {
      Object.assign(c.t, { name: c.name }, has.description ? { desc: c.desc || undefined } : {}, c.parent ? { parent: idOf.get(c.parent), ...topicFields(c, true) } : {});
      delete c.t.archived;
    });
    x.archived.forEach(t => { t.archived = true; });
    // Open submissions are classified with the new taxonomy first; then the proposals the file now covers fold into
    // the imported topic and tag the documents that raised them.
    const again = reclassifyOpen();
    openProposals().forEach(p => { const c = x.added.find(a => fold(a.name) === fold(p.name)); if (c) mergeProposal(p, idOf.get(c.code)); });
    const counts = { added: x.added.length, updated: x.updated.length, archived: x.archived.length };
    (D.masterImports ??= []).unshift({ id: uid('mdi'), file: f.file.name, by: me().id, at: Date.now(), mode: f.mode, counts });
    audit('Imported topics', `${f.file.name} · ${counts.added} added, ${counts.updated} updated, ${counts.archived} archived`);
    closeModal();
    applyRuleChange(`Imported ${plural(changeCount(x), 'change')}`, snap.topics, () => {
      D.topics = snap.topics; D.masterImports = snap.imports; D.topicProposals = snap.props; snap.docs.forEach(([d, s]) => restoreDoc(d, s));
      audit('Undid an import of topics', f.file.name);
    }, again);
  };

  /* ═══════════════ The classification prompt (document_profile.md, compiled) ═══════════════ */
  /** What the pipeline's Classify step sends the model, built from the rules as they are now: instructions, the
      taxonomy, the document's slot and the output schema. Prompts are code (backend prompts/ directory); this shows the
      admin exactly what their rules turn into. */
  const xmlEsc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function compiledPrompt() {
    ensureCodes();
    const used = new Set(D.docs.map(d => res(d).kind)), kinds = Object.keys(RESOURCE_KINDS).filter(k => used.has(k) || k === 'reference').join(', ');
    const thr = Math.round(classThreshold() * 100);
    const tag = (k, v) => (v ? `      <${k}>${xmlEsc(v)}</${k}>\n` : '');
    const tax = domains().map(dm => `  <domain code="${xmlEsc(dm.code)}" name="${xmlEsc(dm.name)}">\n${kidsOf(dm.id).map(t => `    <topic code="${xmlEsc(t.code)}" name="${xmlEsc(t.name)}">\n${tag('description', t.desc)}${tag('guidance', (t.guidance || '').replace(/\n/g, ' '))}${tag('keywords', topicKeywords(t).join('; '))}${tag('synonyms', topicSynonyms(t).join('; '))}${tag('examples', (t.examples || []).map(docById).filter(Boolean).map(d => d.name).join('; '))}    </topic>`).join('\n')}\n  </domain>`).join('\n');
    return `You classify one document for ${curWs().name}. You see it once, when it is read; your answer is stored with it.

Instructions:
- type: one of ${kinds}.
- summary: two sentences in the document's own language, saying what it is for.
- topics: at most two topics from <taxonomy>, by code, each with a confidence from 0 to 1. Choose a topic only when the document is mainly about it. Follow each topic's guidance. Below ${thr}% the document is published without a topic and a person files it.
- proposed_topic: when no topic fits and the document's subject is a theme of its own, a short name for it; otherwise null.
- risks: any of personal_data, confidential, outdated, with the passage that shows it.
Answer with JSON only.

<taxonomy>
${tax}
</taxonomy>

<document title="{title}" path="{path}" source="{source}" collection="{collection}">
{first pages, up to 6,000 tokens}
</document>

Output schema:
{
  "type": "procedure",
  "summary": "…",
  "topics": [{ "code": "OPS-01", "confidence": 0.86 }],
  "proposed_topic": null,
  "risks": [{ "type": "personal_data", "quote": "…" }]
}`;
  }
  const PROFILE_BLOCK = `<document_profile>
type: {type}
summary: {summary}
</document_profile>`;
  DR['md-prompt'] = () => {
    const text = compiledPrompt(), tokens = Math.ceil(text.length / 4);
    const rules = leaves().flatMap(t => (t.rules || []).map(r => `<li><span translate="no">${esc(ruleText(r))}</span> ${ic('arrow-right', 'i-xs')} <span class="md-code">${esc(t.code)}</span> <span translate="no">${esc(t.name)}</span></li>`));
    const code = (s, label) => `<pre class="md-prompt__code" tabindex="0" aria-label="${esc(label)}" translate="no"><code>${esc(s)}</code></pre>`;
    return {
      size: 'xl', title: 'Classification prompt', lead: itemIcon('code', 'accent'),
      desc: `document_profile.md, built from these rules. Sent once per document, about ${fmtNum(tokens)} tokens.`,
      body: `<div class="md-prompt stack gap-16">
        ${sec('Rules checked first', rules.length ? `<ul class="md-prompt__rules">${rules.join('')}</ul>` : `<p class="tx-sec__empty">${esc('No topic has a rule.')}</p>`, { desc: esc('A matching source or folder settles the topic without asking the model.') })}
        ${sec('Prompt', code(text, 'Classification prompt'))}
        ${sec('What reaches each passage', code(PROFILE_BLOCK, 'Document profile block'), { desc: esc('contextual_rag.md puts the type and summary before every passage it describes. Topics stay in the index’s metadata, so changing them needs no re-indexing.') })}
      </div>`,
      foot: btn('Close', { v: 'ghost', act: 'close-drawer' }) + btn('Copy prompt', { v: 'primary', icon: 'copy', act: 'md-prompt-copy' }),
    };
  };
  A['md-prompt-copy'] = () => copyText(compiledPrompt(), 'Prompt copied');

  X.md = { tab, proposals, learn };
})();

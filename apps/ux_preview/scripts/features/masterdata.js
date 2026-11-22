/* Knowledge Studio → Topics (/studio?tab=topics&view=topics, workspace admins only): what documents are about — domains →
   topics — and how processing classifies documents with them.
   Two panes: a tree (search, one New menu, domains with their topics and document counts, archived ones last; keyboard
   navigable; one aligned row grid: chevron · icon · name · trailing count) and the selected node's detail (?node=<topic or domain id>).
   New domains and topics are made in small dialogs (name, domain, a few keywords); everything else is edited in the detail,
   where "Fine-tune classification" (guidance, examples, rules) stays collapsed behind a one-line summary.
   A topic carries its keywords (one list: the contract's keywords and synonyms count the same, so people see one list;
   new words become keywords, existing synonyms stay synonyms), its description (people see it when they choose a topic,
   the assistant reads it), guidance and example documents for the assistant, optional rules (documents in a collection,
   or from a source, always get it: a hit settles the topic without asking the model), how its documents spread over the
   collections, and a box to test classification. The pipeline classifies each document once, with all of it (core/lifecycle.js topicMatches; the model
   prompt is document_profile.md, shown under the page's ⋯ → Show the classification prompt); the same topics are Browse's pills and
   filters. Edits are a draft per node with one savebar (Save / Discard); saving re-classifies the submissions in review
   and re-checks the published documents the pipeline tagged — without indexing again, since topics live in the index's
   metadata (Undo). Topics people chose stay.
   The feedback loop: reviewers' corrections (D.classCorrections) become keyword candidates (Topics → Suggestions);
   nothing changes the rules until an admin adds them. There's no confidence threshold: the assistant picks topics itself.
   Topics the assistant proposes and keywords from corrections are decided in Topics → Suggestions (X.md.proposals(),
   X.md.learn(); governance.js renders that view).
   One workspace, one rule set: an admin imports it from a spreadsheet named the way people name topics (domain, topic,
   description, keywords, synonyms, guidance, and the topic's resource name from an export — no codes; missing columns are
   left as they are) and exports it. Topic IDs are internal: generated, never shown. Rules and examples live only here.
   Phones: the tree first; a node opens as a full view with Back.
   Exports: X.md = { tab({query}), headerActions(), proposals(), learn() }. Actions: md-* (md-edit opens a topic here from other
   screens), tx-*. Modals: md-import, tx-new. Drawer: md-prompt. Menus: md-more, md-prop-more, tx-add, tx-domain. */
(() => {
  'use strict';

  const BASE = '/studio';
  const ARCHIVED = '__archived';
  /** Spreadsheet columns: `domain` and `topic` are display names; `name` (last) is the resource name an export writes. */
  const COLS = ['domain', 'topic', 'description', 'keywords', 'synonyms', 'guidance', 'name'];
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
  /** Documents a first sync published with these topics, waiting for people to confirm them (Topics → Suggestions). */
  const toConfirm = ids => openClassGroups().filter(g => ids.includes(g.topic)).reduce((a, g) => a + g.n, 0);

  /* ═══════════════ Drafts (one per node; one savebar) ═══════════════ */
  const DRAFTS = () => ui('txDraft', {});
  const valuesOf = t => ({
    name: t.name || '', parent: t.parent || '', desc: t.desc || '', guidance: t.guidance || '',
    keywords: [...topicKeywords(t)], synonyms: [...topicSynonyms(t)], rules: (t.rules || []).map(r => ({ field: r.field, value: r.value })), examples: [...(t.examples || [])],
  });
  const valuesKey = f => JSON.stringify([f.name, f.parent, f.desc, f.guidance, f.keywords, f.synonyms, f.rules.map(r => [r.field, r.value]), f.examples]);
  /** The node's working copy. An untouched draft follows the topic when it changes elsewhere (import, Undo, a proposal merged into it). */
  function draftOf(key) {
    const all = DRAFTS(), t = topicById(key);
    if (!t) return all[key];
    const now = valuesKey(valuesOf(t)), f = all[key];
    if (!f || (valuesKey(f) === f.base && f.base !== now)) all[key] = { ...valuesOf(t), base: now, keywordsIn: '', exQ: '', exOpen: false, err: {}, tried: false };
    return all[key];
  }
  function isDirty(key) {
    const f = DRAFTS()[key]; if (!f) return false;
    const t = topicById(key);
    return !!t && valuesKey(f) !== valuesKey(valuesOf(t));
  }
  /* ═══════════════ New domain / New topic (small dialogs) ═══════════════ */
  const NEWF = () => ui('txNew');
  /** Open the dialog; a new topic goes into `parent`, else the domain in context. With no domain yet, a domain comes first. */
  function openNew(kind = 'topic', parent = '') {
    if (!canManageTaxonomy()) return;
    const k = kind === 'topic' && !domains().length ? 'domain' : kind;
    S.ui.txNew = { kind: k, name: '', desc: '', parent: parent || currentDomain()?.id || '', keywords: [], synonyms: [], keywordsIn: '', tried: false };
    openModal('tx-new', {});
  }
  M['tx-new'] = () => {
    const f = NEWF(), isDomain = f.kind === 'domain', err = f.tried ? validate(f, null, isDomain).err : {};
    const name = field({ id: 'tx-new-name', label: 'Name', required: true, error: err.name, control: input({ id: 'tx-new-name', bind: 'txNew.name', value: f.name, autofocus: true, onEnter: 'tx-create', invalid: !!err.name, placeholder: isDomain ? 'e.g. Human resources' : 'e.g. Leave policy', attrs: 'maxlength="60" data-input="tx-new-input"' }) });
    if (isDomain) {
      return {
        size: 'sm', icon: 'folder-plus', title: 'New domain',
        body: name + field({ id: 'tx-new-desc', label: 'Description', optional: true, desc: 'Shown on Home’s domain cards', control: input({ id: 'tx-new-desc', bind: 'txNew.desc', value: f.desc, onEnter: 'tx-create', attrs: 'maxlength="300"' }) }),
        foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Create domain', { v: 'primary', icon: 'plus', act: 'tx-create' }),
      };
    }
    const chips = f.keywords.map((k, i) => `<span class="tx-chip"><span class="tx-chip__text" translate="no">${esc(k)}</span><button type="button" class="tx-chip__x" data-act="tx-new-kw-rm" data-i="${i}" aria-label="${esc(`Remove ${k}`)}">${ic('x', 'i-xs')}</button></span>`).join('');
    const kwIn = input({ id: 'tx-new-kw', bind: 'txNew.keywordsIn', value: f.keywordsIn, placeholder: 'Add a keyword, then Enter', size: 'sm', onEnter: 'tx-new-kw-add', cls: 'tx-chips__input', attrs: 'data-input="tx-new-kw-type" aria-describedby="tx-new-kw-desc" spellcheck="false"' });
    const kw = `<div class="field"><label class="label" for="tx-new-kw">${esc('Keywords')}<span class="label__opt">(optional)</span></label><div class="tx-chips">${chips}${kwIn}</div><p class="description" id="tx-new-kw-desc">${esc('Words in a title that mean a document belongs here. You can add more later.')}</p></div>`;
    return {
      size: 'sm', icon: 'tag', title: 'New topic',
      body: name + field({ id: 'tx-new-parent', label: 'Domain', required: true, error: err.parent, control: select({ id: 'tx-new-parent', bind: 'txNew.parent', value: f.parent, options: domains().map(d => [d.id, d.name]) }) }) + kw,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Create topic', { v: 'primary', icon: 'plus', act: 'tx-create' }),
    };
  };
  /** Enter (or a comma) turns the typed words into chips; Enter on an empty keyword field creates the topic. */
  A['tx-new-kw-add'] = () => { const f = NEWF(); if (!clean(f.keywordsIn)) { A['tx-create'](); return; } addTerms(f, 'keywords'); refreshLayer(); $('#tx-new-kw')?.focus(); };
  A['tx-new-kw-type'] = el => { if (/[,;]/.test(el.value)) A['tx-new-kw-add'](); };
  A['tx-new-kw-rm'] = el => { NEWF().keywords.splice(+el.dataset.i, 1); refreshLayer(); $('#tx-new-kw')?.focus(); };
  /** After a failed Create, the name's message follows what is typed. */
  A['tx-new-input'] = () => {
    const f = NEWF(); if (!f?.tried) return;
    const now = validate(f, null, f.kind === 'domain').err.name || '', shown = $('#layer .field-error')?.textContent.trim() || '';
    if (now === shown) return;
    const pos = $('#tx-new-name')?.selectionStart;
    refreshLayer();
    const el = $('#tx-new-name'); el?.focus(); if (el && pos != null) el.setSelectionRange(pos, pos);
  };
  A['tx-create'] = () => {
    const f = NEWF(); if (!f || !canManageTaxonomy()) return;
    const isDomain = f.kind === 'domain';
    if (!isDomain) addTerms(f, 'keywords');
    f.tried = true;
    const { err, name } = validate(f, null, isDomain);
    if (Object.keys(err).length) { refreshLayer(); $(err.name ? '#tx-new-name' : '#tx-new-parent')?.focus(); return; }
    const snap = snapTopics();
    const t = JSON.parse(JSON.stringify(isDomain ? { id: uid('d'), name, desc: clean(f.desc) || undefined } : { id: uid('t'), name, parent: f.parent, keywords: [...f.keywords] }));
    const at = isDomain ? D.topics.length - 1 : D.topics.map(x => x.parent === f.parent || x.id === f.parent).lastIndexOf(true);
    D.topics.splice(at + 1, 0, t);
    audit(isDomain ? 'Added a domain' : 'Added a topic', isDomain ? name : `${name} → ${topicName(f.parent)}`);
    closeModal();
    if (!isDomain) TREE().closed[f.parent] = false;
    showNode(t.id);
    const msg = `Created ${name}`;
    const undo = () => { D.topics = snap; audit('Undid a change to the topics', name); setQuery({ node: isDomain ? '' : f.parent }); };
    if (isDomain) toast(msg, { action: { label: 'Undo', run: () => { undo(); refresh(); } } });
    else applyRuleChange(msg, snap, undo);
  };

  /* ═══════════════ Tab ═══════════════ */
  function tab({ query = {} } = {}) {
    if (!canManageTaxonomy()) return emptyState({ icon: 'lock', title: 'Only workspace admins change the topics', boxed: true });
    const empty = () => `<div class="tx">${emptyState({ icon: 'database', title: 'No topics yet', desc: 'Import your topics from a spreadsheet, or start with a domain.', actions: btn('Import', { v: 'primary', icon: 'upload', act: 'md-import' }) + btn('New domain', { v: 'secondary', icon: 'folder-plus', act: 'tx-new', data: { kind: 'domain' } }), boxed: true })}</div>`;
    return gate({
      loading: () => skelRows(6),
      error: () => errorState({ title: 'The topics didn’t load' }),
      empty,
      ok: () => {
        const picked = query.node || '', bare = query.show === 'bare';
        if (!domains().length) return empty();
        const n = topicCounts(), id = resolveNode(picked || (bare ? leaves().find(isBare)?.id || '' : ''));
        return `<div class="${cx('tx', picked && 'tx--picked')}">${summaryBar(bare)}<div class="tx-panes">${treePane(id, n, bare)}<div class="tx-main" id="tx-main">${detail(id, n)}</div></div></div>`;
      },
    });
  }
  /** ?node= when it exists; else the first domain. */
  function resolveNode(id) {
    if (id && topicById(id)) return id;
    return domains()[0]?.id || '';
  }

  /** A topic the pipeline can only match by name: no keywords and no synonyms. Filling these in is the rules' main upkeep. */
  const isBare = t => !topicKeywords(t).length && !topicSynonyms(t).length;
  /** One quiet line above both panes: what the topics hold and, once there was one, who imported them last and when (the
      audit log's last ImportTopics). Topics without keywords are a toggle that narrows the tree to them (?show=bare), so
      the fix is one click away. */
  function summaryBar(bareOn = false) {
    const tops = leaves(), kws = tops.reduce((a, t) => a + topicKeywords(t).length + topicSynonyms(t).length, 0), bare = tops.filter(isBare).length;
    const last = (D.masterImports || [])[0];
    const counts = `<span class="medium">${esc(`${plural(domains().length, 'domain')} · ${plural(tops.length, 'topic')} · ${plural(kws, 'keyword')}`)}</span>`;
    const source = last ? `${DOT}<span>${esc(`Last imported ${rel(last.at)} by ${actorName(last.by)}`)}</span>` : '';
    const hint = bare || bareOn ? `${DOT}<button type="button" class="tx-sum__warn" data-act="tx-bare" aria-pressed="${bareOn}" data-tip="${esc(bareOn ? 'Show every topic' : 'The pipeline matches them by name only. Show just these.')}">${esc(`${plural(bare, 'topic')} without keywords`)}</button>` : '';
    return `<div class="tx-sum"><p class="tx-sum__text">${counts}${source}${hint}</p></div>`;
  }
  /** The page header's actions on Topics → All: ⋯ (the classification prompt, export, template) and Import. With no
      topics yet the empty state carries Import, so the header stays empty. */
  function headerActions() {
    if (!canManageTaxonomy() || !domains().length) return '';
    return iconBtn('more', 'More actions for topics', { menu: 'md-more' }) + btn('Import', { v: 'secondary', icon: 'upload', act: 'md-import' });
  }
  A['tx-bare'] = () => setQuery({ show: S.cur.query.show === 'bare' ? '' : 'bare' });
  MENUS['md-more'] = () => [
    { label: 'Show the classification prompt', icon: 'code', run: () => openDrawer('md-prompt', {}) },
    { sep: true },
    { label: 'Export topics', icon: 'download', run: exportCsv },
    { label: 'Download template', icon: 'table', run: templateCsv },
  ];

  /* ═══════════════ Tree ═══════════════ */
  const TREE = () => ui('txTree', { q: '', closed: {}, archived: false });
  const termsOf = t => [t.name, ...topicKeywords(t), ...topicSynonyms(t)];
  function treeItem({ id, level, expanded, inner, group = '', cls = '' }, sel, focusId) {
    return `<li role="treeitem" id="tx-n-${esc(id)}" class="${cx('tx-item', cls)}" aria-level="${level}" aria-selected="${id === sel}" ${expanded != null ? `aria-expanded="${expanded}"` : ''} tabindex="${id === focusId ? 0 : -1}" data-id="${esc(id)}">`
      + `<div class="${cx('tx-row', id === sel && 'is-selected')}" data-act="tx-node" data-id="${esc(id)}">${inner}</div>${group}</li>`;
  }
  /** One grid for every row: [chevron 16] [icon 16] [name] [trailing]. Topics keep an empty chevron slot and indent by
      chevron + gap, so their icon sits under the domain's name. */
  function treePane(sel, n, bare = false) {
    const u = TREE(), q = fold(u.q || '').trim(), drafts = DRAFTS();
    // Domains start closed, except the selection's: a long taxonomy scans as its domains first.
    const selT = topicById(sel), selDom = selT ? (selT.parent || selT.id) : '';
    const isClosed = id => (id in u.closed ? u.closed[id] : id !== selDom);
    const hit = t => (!q || termsOf(t).some(s => fold(s).includes(q))) && (!bare || isBare(t));
    const NOKW = 'No keywords — add some so documents can be matched';
    // A topic with no words to recognise it by carries a warning ring (its fix: add keywords in its detail).
    const warn = t => (isBare(t) ? `<span class="tx-row__warn" role="img" aria-label="${esc(NOKW)}" data-tip="${esc(NOKW)}"></span>` : '');
    const dot = id => (drafts[id] && isDirty(id) ? `<span class="tx-row__dot" role="img" aria-label="${esc('Unsaved changes')}" data-tip="${esc('Unsaved changes')}"></span>` : '');
    const chev = (id, open) => `<span class="tx-row__chev" data-act="tx-toggle" data-id="${esc(id)}" aria-hidden="true">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}</span>`;
    const noChev = '<span class="tx-row__chev tx-row__chev--none" aria-hidden="true"></span>';
    const count = v => `<span class="tx-row__count">${v ? fmtNum(v) : ''}</span>`;
    const name = (s, cls = '') => `<span class="${cx('tx-row__name', cls)}" translate="no" title="${esc(s)}">${esc(s)}</span>`;
    const trail = s => `<span class="tx-row__trail">${s}</span>`;
    const addBtn = dm => `<button type="button" class="tx-row__add" tabindex="-1" data-act="tx-new" data-kind="topic" data-parent="${esc(dm.id)}" aria-label="${esc(`Add topic to ${dm.name}`)}" data-tip="${esc(`Add topic to ${dm.name}`)}">${ic('plus', 'i-sm')}</button>`;
    const topicRow = t => noChev + ic('tag', 'i-sm tx-row__icon tx-row__icon--topic') + name(t.name) + trail(`${warn(t)}${dot(t.id)}${count(n.topic(t.id))}`);
    // Flat model first, so roving focus can fall back to the first item when the selection is hidden.
    const items = [];
    domains().forEach(dm => {
      const all = kidsOf(dm.id), domHit = !bare && hit(dm), kids = domHit ? all : all.filter(hit);
      if ((q || bare) && !domHit && !kids.length) return;
      const open = q || bare ? true : !isClosed(dm.id);
      const children = open ? kids.map(t => ({ id: t.id, level: 2, inner: topicRow(t) })) : [];
      items.push({ id: dm.id, level: 1, expanded: open, inner: chev(dm.id, open) + ic(open ? 'folder-open' : 'folder', 'i-sm tx-row__icon') + name(dm.name, 'tx-row__name--domain') + trail(`${dot(dm.id)}${count(n.domain(dm.id))}${addBtn(dm)}`), children });
    });
    const archived = (D.topics || []).filter(t => t.archived);
    if (archived.length && !q) {
      const children = u.archived ? archived.map(t => ({ id: t.id, level: 2, inner: noChev + ic(t.parent ? 'tag' : 'folder', 'i-sm tx-row__icon tx-row__icon--topic') + name(t.name) + trail('') })) : [];
      items.push({ id: ARCHIVED, level: 1, expanded: !!u.archived, inner: `${chev(ARCHIVED, u.archived)}${ic('archive', 'i-sm tx-row__icon')}<span class="tx-row__name muted">${esc(`Archived (${archived.length})`)}</span>${trail('')}`, children, cls: 'tx-item--archived' });
    }
    const flat = items.flatMap(x => [x.id, ...(x.children || []).map(c => c.id)]);
    const focusId = flat.includes(sel) ? sel : flat[0];
    const html = items.map(x => treeItem({ ...x, group: x.children?.length ? `<ul role="group" class="tx-group">${x.children.map(c => treeItem(c, sel, focusId)).join('')}</ul>` : '' }, sel, focusId)).join('');
    const tools = `<div class="tx-side__tools">${searchField({ uiKey: 'txTree', placeholder: 'Search topics', full: true, id: 'tx-q', label: 'Search topics and keywords' })}${iconBtn('plus', 'New', { menu: 'tx-add' })}</div>`;
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
    return [
      ...(domains().length ? [{ label: 'New topic', icon: 'tag', run: () => openNew('topic') }] : []),
      { label: 'New domain', icon: 'folder-plus', run: () => openNew('domain') },
    ];
  };
  A['tx-new'] = el => openNew(el.dataset.kind, el.dataset.parent);
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
    else {
      const t = topicById(S.cur?.query.node), selDom = t ? (t.parent || t.id) : '';
      const wasClosed = id in u.closed ? u.closed[id] : id !== selDom;
      u.closed[id] = close == null ? !wasClosed : close;
    }
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
  const sec = (title, body, { desc = '', aside = '', id = '' } = {}) => `<section class="tx-sec" ${id ? `aria-labelledby="${id}"` : ''}><div class="tx-sec__head"><h3 class="tx-sec__title" ${id ? `id="${id}"` : ''}>${esc(title)}</h3>${aside}</div>${desc ? `<p class="tx-sec__desc">${desc}</p>` : ''}${body}</section>`;
  function detail(id, n) {
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
  /** The header is where a node's identity is changed, in place: the name is click-to-edit (its pencil), a topic's domain
      is a menu that moves it, Archive is one icon. Each applies at once with Undo — no form, no savebar. */
  function headHtml(t, f, n, isDomain) {
    const where = isDomain ? `<span>${esc(plural(kidsOf(t.id).length, 'topic'))}</span>`
      : `<button type="button" class="tx-head__domain" data-menu="tx-domain" data-id="${esc(t.id)}" aria-haspopup="menu" aria-expanded="false" data-tip="${esc('Move to another domain')}" translate="no">${esc(topicName(t.parent))}${ic('chevron-down', 'i-xs')}</button>`;
    const counts = isDomain ? countLinks(t.id, n.domain(t.id), n.reviewDomain(t.id)) : countLinks(t.id, n.topic(t.id), n.review(t.id));
    const title = editableTitle({ id: 'tx-name', value: f.renaming ? f.renameVal : t.name, editing: !!f.renaming, edit: 'tx-rename', commit: 'tx-rename-done', cancel: 'tx-rename-cancel', cls: 'tx-head__title', label: isDomain ? 'Rename domain' : 'Rename topic', maxlength: 60, error: f.renaming ? f.renameErr : '', data: { id: t.id } });
    return `<header class="tx-head"><div class="tx-head__main">${title}
      <p class="tx-head__meta">${where}${DOT}${counts}</p></div><div class="tx-head__acts">${iconBtn('archive', isDomain ? 'Archive domain' : 'Archive topic', { act: 'tx-archive', data: { id: t.id } })}</div></header>`;
  }
  function editorDetail(t, n) {
    const key = t.id, f = draftOf(key); if (!f) return '';
    const isDomain = !t.parent, dirty = isDirty(key);
    const parts = [
      headHtml(t, f, n, isDomain),
      // A topic's job is to recognise documents, so its words lead; what fine-tunes classification waits behind one disclosure.
      ...(isDomain ? [descSec(key, f, isDomain), domainTopicsSec(t, n)]
        : [termsSec(key, f), descSec(key, f, isDomain), advSec(key, f, t), distSec(t, isDomain, n), testSec(t, f, dirty)]),
    ];
    const nErr = f.tried ? Object.keys(f.err || {}).length : 0;
    const recheck = !isDomain && dirty ? reclassifiable().length : 0;
    const bar = dirty ? `<div class="savebar" role="region" aria-label="${esc('Unsaved changes')}"><span class="savebar__text">${esc('Unsaved changes')}${nErr ? esc(` · ${plural(nErr, 'field')} to fix`) : recheck ? `<span class="savebar__hint">${esc(` · saving re-checks ${plural(recheck, 'document')} the pipeline tagged`)}</span>` : ''}</span>${btn('Discard', { v: 'ghost', act: 'tx-discard', data: { id: key } })}${btn('Save', { v: 'primary', icon: 'check', act: 'tx-save', data: { id: key } })}</div>` : '';
    return `<div class="tx-detail">${back()}${parts.join('')}${bar}</div>`;
  }
  /** "Fine-tune classification (optional)": guidance and examples the assistant reads, and rules that skip it — collapsed
      (per session); closed, it says what's set. */
  const ADV = () => ui('txAdv', { open: false });
  function advSec(key, f, t) {
    const open = !!ADV().open, nr = f.rules.length, ne = f.examples.length;
    const parts = [clean(f.guidance) && 'Guidance', ne && plural(ne, 'example'), nr && plural(nr, 'rule')].filter(Boolean);
    const summary = open ? '' : `<span class="tx-adv__sum">${(parts.length ? parts : ['Not set']).map(s => `<span>${esc(s)}</span>`).join(DOT)}</span>`;
    const head = `<h3 class="tx-adv__h"><button type="button" class="tx-adv__toggle" data-act="tx-adv" aria-expanded="${open}" aria-controls="tx-adv-body">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm tx-adv__chev')}<span class="tx-adv__title">${esc('Fine-tune classification')}<span class="label__opt">(optional)</span></span>${summary}</button></h3>`;
    return `<section class="${cx('tx-adv', open && 'is-open')}">${head}${open ? `<div class="tx-adv__body" id="tx-adv-body">${guideSec(key, f)}${examplesSec(key, f, t)}${rulesSec(key, f)}</div>` : ''}</section>`;
  }
  A['tx-adv'] = () => { const u = ADV(); u.open = !u.open; refresh(); };

  function descSec(key, f, isDomain) {
    return sec('Description', textarea({ id: 'tx-desc', bind: `txDraft.${key}.desc`, value: f.desc, rows: 2, placeholder: isDomain ? 'What this domain groups, in a sentence' : 'What this topic covers, in your business’s words', attrs: `maxlength="300" aria-labelledby="tx-desc-h" data-input="tx-input" data-id="${key}"` }),
      { id: 'tx-desc-h', desc: esc(isDomain ? 'Shown on Home’s domain cards.' : 'People see it when they choose a topic; the assistant reads it when it classifies.') });
  }
  function guideSec(key, f) {
    return sec('Guidance', textarea({ id: 'tx-guide', bind: `txDraft.${key}.guidance`, value: f.guidance, rows: 3, placeholder: 'Use for…\nNot for…', attrs: `maxlength="600" aria-labelledby="tx-guide-h" data-input="tx-input" data-id="${key}"` }),
      { id: 'tx-guide-h', desc: esc('When the assistant should use this topic, and what belongs elsewhere.') });
  }
  /** One chip list: keywords and synonyms count the same, so people keep one list of words. Each chip remembers its
      list (an import or a merged proposal may have set synonyms); new words are keywords. */
  function termsSec(key, f) {
    const chip = (list, k, i) => `<span class="tx-chip"><span class="tx-chip__text" translate="no">${esc(k)}</span><button type="button" class="tx-chip__x" data-act="tx-chip-rm" data-id="${key}" data-list="${list}" data-i="${i}" aria-label="${esc(`Remove ${k}`)}">${ic('x', 'i-xs')}</button></span>`;
    const chips = [...f.keywords.map((k, i) => chip('keywords', k, i)), ...f.synonyms.map((k, i) => chip('synonyms', k, i))].join('');
    const inp = input({ id: 'tx-keywords-in', bind: `txDraft.${key}.keywordsIn`, value: f.keywordsIn || '', placeholder: 'Add a keyword, then Enter', size: 'sm', onEnter: 'tx-chip-add', cls: 'tx-chips__input', attrs: `data-id="${key}" data-list="keywords" data-input="tx-chip-type" aria-labelledby="tx-kw-h" spellcheck="false"` });
    return sec('Keywords', `<div class="tx-chips">${chips}${inp}</div>`,
      { id: 'tx-kw-h', desc: esc('Words in a title or text that mean a document belongs here, including other names people use for it.') });
  }
  const sourceOptions = () => D.sources.map(s => [s.id, s.name]);
  /** Collections and the folders inside them (a rule on one covers everything under it). */
  const collectionOptions = () => visibleKbs().filter(k => !k.personal).flatMap(kb => [[kb.id, kb.name],
    ...(D.folders || []).filter(x => x.kb === kb.id).map(x => [x.id, [kb.name, ...folderPath(x.id).map(p => p.name)].join(' / ')]).sort((a, b) => a[1].localeCompare(b[1]))]);
  function rulesSec(key, f) {
    const rows = f.rules.map((r, i) => {
      const src = r.field === 'source';
      const value = select({ id: `tx-rv-${i}`, bind: `txDraft.${key}.rules.${i}.value`, value: r.value, options: src ? [['', 'Choose a source'], ...sourceOptions()] : [['', 'Choose a collection'], ...collectionOptions()], change: 'tx-redraw', size: 'sm', label: src ? 'Source' : 'Collection', cls: 'tx-rule__value', attrs: `data-id="${key}"` });
      return `<li class="tx-rule"><span class="tx-rule__word">${esc(src ? 'Documents from' : 'Documents in')}</span>${value}<span class="tx-rule__word">${ic('arrow-right', 'i-xs')}<span>file it here</span></span>${iconBtn('x', 'Remove rule', { size: 'sm', act: 'tx-rule-rm', data: { id: key, i } })}</li>`;
    }).join('');
    const add = field => btn(field === 'source' ? 'Documents from a source' : 'Documents in a collection', { v: 'ghost', size: 'sm', icon: 'plus', act: 'tx-rule-add', data: { id: key, field } });
    return sec('Always file here', `${rows ? `<ul class="tx-rules">${rows}</ul>` : ''}<div class="tx-rules__add">${add('collection')}${add('source')}</div>`,
      { desc: esc('Documents in a collection or from a source you pick always get this topic. The assistant isn’t asked.') });
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
      { desc: esc('Two or three documents that clearly belong here. The assistant compares new documents with them.') });
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
      return `<li><button type="button" class="tx-trow" data-act="tx-node" data-id="${esc(t.id)}"><span class="tx-trow__name truncate" translate="no">${esc(t.name)}</span><span class="${cx('tx-trow__kw', !kw && 'is-warn')}">${esc(kw ? plural(kw, 'keyword') : 'No keywords')}</span><span class="tx-trow__n">${esc(`${fmtNum(n.topic(t.id))} published`)}</span>${ic('chevron-right', 'i-sm muted')}</button></li>`;
    }).join('');
    return sec('Topics', kids.length ? `<ul class="tx-trows">${rows}</ul>` : `<p class="tx-sec__empty">${esc('No topics yet.')}</p>`,
      { aside: btn('Add topic', { v: 'ghost', size: 'sm', icon: 'plus', act: 'tx-new', data: { kind: 'topic', parent: dm.id } }) });
  }

  /* ── Test classification: a title (and optionally where it lives or comes from) against the taxonomy, with this topic's unsaved changes ── */
  const TEST = () => ui('txTest', { q: '', coll: '', src: '', ran: null });
  /** Run topicMatches with the draft applied to the topic, then put the topic back. */
  function withDraft(t, f, fn) {
    if (!f) return fn();
    const keep = Object.fromEntries(['name', 'keywords', 'synonyms', 'rules', 'examples'].map(k => [k, t[k]]));
    Object.assign(t, { name: clean(f.name) || t.name, keywords: f.keywords, synonyms: f.synonyms, rules: f.rules, examples: f.examples });
    try { return fn(); } finally { Object.assign(t, keep); }
  }
  function runTest(t, f, { q, coll, src }) {
    const name = clean(q), fo = folderById(coll), kbId = fo ? fo.kb : coll || (src ? srcById(src)?.kb : '') || '';
    const doc = { id: '__tx-test', name, kb: kbId, folder: fo ? fo.id : null, source: src || null };
    return withDraft(t, f, () => topicMatches(name, kbById(kbId), similarDocs(doc), doc));
  }
  function testSec(t, f, dirty) {
    const u = TEST(), ran = u.ran?.node === t.id ? u.ran : null;
    const form = `<div class="tx-test__form">${input({ id: 'tx-test-q', bind: 'txTest.q', value: u.q, placeholder: 'A title, e.g. Refund procedure 2027.pdf', size: 'sm', onEnter: 'tx-test', cls: 'tx-test__q', attrs: `aria-label="${esc('Document title')}" spellcheck="false" data-id="${esc(t.id)}"` })}${select({ id: 'tx-test-coll', bind: 'txTest.coll', value: u.coll, options: [['', 'Any collection'], ...collectionOptions()], size: 'sm', label: 'Collection', cls: 'tx-test__src' })}${select({ id: 'tx-test-src', bind: 'txTest.src', value: u.src, options: [['', 'Any source'], ...sourceOptions()], size: 'sm', label: 'Source', cls: 'tx-test__src' })}${btn('Test', { v: 'secondary', size: 'sm', act: 'tx-test', data: { id: t.id } })}</div>`;
    const hint = `<span>${esc('Try a title. Pick a collection or source to check rules.')}</span>${dirty ? ` <span>${esc('Uses your unsaved changes.')}</span>` : ''}`;
    let out = '';
    if (ran) {
      const res = runTest(t, f, ran), rank = res.findIndex(x => x.id === t.id);
      const verdict = rank === 0 ? `<p class="tx-test__verdict is-ok">${ic('check-circle', 'i-sm')}<span>${esc('This topic comes first.')}</span></p>`
        : rank > 0 ? `<p class="tx-test__verdict">${ic('info', 'i-sm')}<span>${esc(`This topic comes ${rank + 1}${rank === 1 ? 'nd' : 'rd'}.`)}</span></p>`
          : `<p class="tx-test__verdict is-warn">${ic('alert-circle', 'i-sm')}<span>${esc('This topic isn’t among the matches. Add a keyword, synonym or rule this title would hit.')}</span></p>`;
      const label = x => (x.why.rule ? chip('Rule', { size: 'sm', tone: 'accent' }) : chip('Assistant', { size: 'sm' }));
      const rows = res.map((x, i) => {
        const tp = topicById(x.id), ev = topicEvidence(x.why);
        return `<li class="${cx('tx-result', x.id === t.id && 'is-self')}"><span class="tx-result__rank">${i + 1}</span><div class="tx-result__main"><div class="tx-result__name"><span class="medium" translate="no">${esc(tp?.name || '')}</span>${DOT}<span class="muted" translate="no">${esc(topicName(tp?.parent))}</span></div>${ev.length ? `<div class="tx-result__why">${ev.map(s => `<span>${esc(s)}</span>`).join(DOT)}</div>` : ''}</div>${label(x)}</li>`;
      }).join('');
      out = `<div class="tx-test__out" aria-live="polite">${verdict}${res.length ? `<ol class="tx-results">${rows}</ol>` : `<p class="tx-sec__empty">${esc('Nothing in the taxonomy matched. The document would wait for a person to pick its topic.')}</p>`}</div>`;
    }
    return sec('Test classification', `<div class="tx-test">${form}${out}</div>`, { desc: hint });
  }
  A['tx-test'] = el => {
    const u = TEST(), id = el.dataset.id || S.cur?.query.node;
    if (!clean(u.q)) { $('#tx-test-q')?.focus(); return; }
    u.ran = { node: id, q: u.q, coll: u.coll, src: u.src }; refresh();
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
    // "in the {domain} domain": a whole phrase, so Vietnamese gets it right ("in {0}" is too short a pattern to translate).
    const where = dom ? `in the ${esc(dom.name)} domain` : `as a new domain${f.dname && f.dname !== f.name ? ` “${esc(f.dname)}”` : ''}`;
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
    if (newDom) { const dm = { id: uid('d'), name: dname }; D.topics.push(dm); parent = dm.id; }
    const t = acceptProposal(p, { name, parent });
    if (!t) { D.topics = snap.topics; return; }
    t.keywords = proposalKeywords(name);
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
    const head = `<header class="tx-head"><div class="tx-head__main"><div class="tx-head__title-row"><h2 class="tx-head__title" translate="no">${esc(t.name)}</h2>${chip('Archived', { size: 'sm' })}</div>
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
  function addTerms(f, list) {
    const other = list === 'keywords' ? 'synonyms' : 'keywords';
    const have = [...f[list], ...f[other]].map(fold), add = splitKw(f[`${list}In`]).filter(k => !have.includes(fold(k)));
    f[list] = [...f[list], ...add]; f[`${list}In`] = '';
    return add.length;
  }
  A['tx-chip-add'] = el => { const [, f] = draftFor(el); if (!f) return; addTerms(f, 'keywords'); refresh(); $('#tx-keywords-in')?.focus(); };
  A['tx-chip-type'] = el => { if (/[,;]/.test(el.value)) A['tx-chip-add'](el); };
  A['tx-chip-rm'] = el => { const [, f] = draftFor(el); if (!f) return; f[el.dataset.list].splice(+el.dataset.i, 1); refresh(); $('#tx-keywords-in')?.focus(); };
  A['tx-rule-add'] = el => { const [, f] = draftFor(el); if (!f) return; f.rules.push({ field: el.dataset.field === 'source' ? 'source' : 'collection', value: '' }); refresh(); $(`#tx-rv-${f.rules.length - 1}`)?.focus(); };
  A['tx-rule-rm'] = el => { const [, f] = draftFor(el); if (!f) return; f.rules.splice(+el.dataset.i, 1); refresh(); };
  A['tx-ex-q'] = () => refresh();
  A['tx-ex-open'] = el => { const [, f] = draftFor(el); if (!f) return; f.exOpen = true; refresh(); $('#tx-ex-q')?.focus(); };
  A['tx-ex-add'] = el => { const [, f] = draftFor(el); if (!f || f.examples.includes(el.dataset.doc)) return; f.examples.push(el.dataset.doc); f.exQ = ''; refresh(); $('#tx-ex-q')?.focus(); };
  A['tx-ex-rm'] = el => { const [, f] = draftFor(el); if (!f) return; f.examples = f.examples.filter(id => id !== el.dataset.doc); refresh(); };
  A['tx-discard'] = el => {
    const [key, f] = draftFor(el); if (!f) return;
    delete DRAFTS()[key]; refresh();
  };
  function validate(f, t, isDomain) {
    const err = {}, name = clean(f.name);
    if (!name) err.name = 'Enter a name.';
    else if ((D.topics || []).some(x => live(x) && x.id !== t?.id && (isDomain ? !x.parent : x.parent === f.parent) && fold(x.name) === fold(name))) err.name = isDomain ? `A domain called “${name}” already exists.` : `${topicName(f.parent)} already has “${name}”.`;
    if (!isDomain && !topicById(f.parent)) err.parent = 'Choose a domain.';
    return { err, name };
  }
  A['tx-save'] = el => {
    const [key, f] = draftFor(el); if (!f || !canManageTaxonomy()) return;
    const t = topicById(key); if (!t) return;
    const isDomain = !t.parent;
    // Words still in the chip inputs count: nobody expects Save to drop what they typed.
    if (!isDomain) addTerms(f, 'keywords');
    const { err, name } = validate(f, t, isDomain); f.err = err; f.tried = true;
    // Name and domain change in the header at once; a clash that appeared since (an import, another tab) reopens the name there.
    if (Object.keys(err).length) { f.renaming = true; f.renameVal = f.name; f.renameErr = err.name || err.parent; refresh(); return; }
    const snap = snapTopics(), desc = clean(f.desc) || undefined;
    const rules = f.rules.filter(r => clean(r.value)).map(r => ({ field: r.field, value: clean(r.value) }));
    const extra = isDomain ? {} : { parent: f.parent, keywords: [...f.keywords], synonyms: f.synonyms.length ? [...f.synonyms] : undefined, guidance: cleanBlock(f.guidance) || undefined, rules: rules.length ? rules : undefined, examples: f.examples.length ? [...f.examples] : undefined };
    const moved = !isDomain && t.parent !== f.parent;
    Object.assign(t, { name, desc }, extra);
    audit(isDomain ? 'Edited a domain' : 'Edited a topic', `${name}${moved ? ` → ${topicName(f.parent)}` : ''}`);
    delete DRAFTS()[key];
    const label = `Saved “${name}”`;
    const undoRules = () => { D.topics = snap; audit('Undid a change to the topics', name); };
    if (!isDomain) { applyRuleChange(label, snap, undoRules); return; }
    refresh();
    toast(label, { action: { label: 'Undo', run: () => { undoRules(); refresh(); } } });
  };
  /* ── Identity in the header: rename (click-to-edit title), move to another domain (menu), archive (icon) ── */
  /** Apply a name or domain change at once, with Undo. A draft with other unsaved edits keeps them and follows the change;
      an untouched one is dropped so it rebuilds from the topic. Topics re-check what the pipeline tagged (the name and
      the domain's candidates are signals); domains only toast. */
  function changeIdentity(t, patch, msg) {
    const snap = snapTopics(), f = DRAFTS()[t.id], keep = !!f && isDirty(t.id), before = { name: t.name, parent: t.parent };
    Object.assign(t, patch);
    if (keep) Object.assign(f, patch); else delete DRAFTS()[t.id];
    audit(patch.parent ? 'Moved a topic' : t.parent ? 'Renamed a topic' : 'Renamed a domain', patch.parent ? `${t.name} → ${topicName(patch.parent)}` : `${before.name} → ${t.name}`);
    const undoRules = () => {
      D.topics = snap; audit('Undid a change to the topics', before.name);
      const g = DRAFTS()[t.id]; if (keep && g) Object.assign(g, Object.fromEntries(Object.keys(patch).map(k => [k, before[k]]))); else delete DRAFTS()[t.id];
    };
    if (t.parent) { applyRuleChange(msg, snap, undoRules); return; }
    refresh();
    toast(msg, { action: { label: 'Undo', run: () => { undoRules(); refresh(); } } });
  }
  A['tx-rename'] = el => {
    const t = topicById(el.dataset.id), f = t && draftOf(t.id); if (!f || !canManageTaxonomy()) return;
    Object.assign(f, { renaming: true, renameVal: t.name, renameErr: '' }); refresh();
  };
  A['tx-rename-cancel'] = el => { const f = DRAFTS()[el.dataset.id]; if (!f?.renaming) return; Object.assign(f, { renaming: false, renameErr: '' }); refresh(); };
  /** Enter or leaving the name. Idempotent (Enter re-renders, then the field loses focus). An empty or unchanged name just closes. */
  A['tx-rename-done'] = el => {
    const t = topicById(el.dataset.id), f = t && DRAFTS()[t.id]; if (!f?.renaming) return;
    const name = clean(el.value);
    if (!name || name === t.name) { Object.assign(f, { renaming: false, renameErr: '' }); refresh(); return; }
    const { err } = validate({ name, parent: t.parent || '' }, t, !t.parent);
    if (err.name) { Object.assign(f, { renameVal: el.value, renameErr: err.name }); refresh(); return; }
    Object.assign(f, { renaming: false, renameErr: '' });
    changeIdentity(t, { name }, `Renamed to “${name}”`);
  };
  /** The topic's domain in the header: every active domain, the current one checked; picking another moves the topic. */
  MENUS['tx-domain'] = el => {
    const t = topicById(el.dataset.id); if (!t || !canManageTaxonomy()) return [];
    return [{ section: 'Move to domain' }, ...domains().map(d => ({ label: d.name, icon: 'folder', checked: d.id === t.parent, run: () => {
      if (d.id === t.parent) return;
      const { err } = validate({ name: t.name, parent: d.id }, t, false);
      if (err.name) { toast(err.name, { tone: 'accent' }); return; }
      changeIdentity(t, { parent: d.id }, `Moved “${t.name}” to ${d.name}`);
    } }))];
  };
  A['tx-archive'] = el => { const t = topicById(el.dataset.id); if (t && canManageTaxonomy()) archive(t); };
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
  /** A topic's resource name: what an export writes in `name`, so a file re-imported later can rename or move it. */
  const resourceName = t => `workspaces/${curWs().id}/topics/${t.id}`;
  const rowsOfTopics = () => domains().flatMap(dm => [
    [dm.name, '', dm.desc || '', '', '', '', resourceName(dm)],
    ...kidsOf(dm.id).map(t => [dm.name, t.name, t.desc || '', topicKeywords(t).join('; '), topicSynonyms(t).join('; '), t.guidance || '', resourceName(t)]),
  ]);
  const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  function exportCsv() {
    const rows = rowsOfTopics();
    saveCsv(`${slug(curWs().name)}-taxonomy.csv`, [COLS, ...rows], `Exported ${plural(rows.length, 'row')}`);
    audit('Exported the taxonomy', curWs().name);
  }
  /** Names only: `name` is for files exported from here, so the template leaves it out. */
  function templateCsv() {
    saveCsv('taxonomy-template.csv', [COLS.slice(0, -1),
      ['Banking Operations', '', 'Cut-off times, settlement and disputes.', '', '', ''],
      ['Banking Operations', 'Cards & disputes', 'Chargebacks and cardholder disputes.', 'chargeback; dispute; card scheme', 'cardholder dispute; reason code', 'Use for card disputes and chargebacks.\nNot for merchant fees.']], 'Template downloaded');
  }

  /** A deterministic sample spreadsheet built from the current taxonomy and filled in the way people do (names, no `name`
      values): every row, keywords added to a few topics, the topics the assistant has been proposing (a theme no domain
      fits gets a new one) and one topic listed twice. The last unused topic is left out, so Replace has something to archive. */
  function sampleRows() {
    const n = topicCounts(), unused = [...leaves()].reverse().find(t => !n.topic(t.id) && !n.review(t.id));
    const out = rowsOfTopics().filter(r => !unused || r[6] !== resourceName(unused)).map(r => [...r.slice(0, 6), '']);
    // Richer keywords for the four topics that have the fewest: the words of their own name.
    const kwCount = r => splitKw(r[3]).length;
    out.filter(r => r[1]).sort((a, b) => kwCount(a) - kwCount(b)).slice(0, 4).forEach(r => {
      const extra = r[1].toLowerCase().split(/\s*(?:&|,|\band\b)\s*/).filter(w => w.length > 3);
      r[3] = [...new Set([...splitKw(r[3]), ...extra])].join('; ');
    });
    // New topics: themes documents keep raising.
    PROPOSAL_RULES.forEach(([, name, parents]) => {
      if ((D.topics || []).some(t => live(t) && fold(t.name) === fold(name))) return;
      const dom = domains().find(d => parents.some(p => fold(p) === fold(d.name)));
      out.push([dom ? dom.name : 'Sustainability & ESG', name, '', proposalKeywords(name).join('; '), '', '', '']);
    });
    const first = out.find(r => r[1]);
    if (first) out.push([first[0], first[1], '', '', '', '', '']);
    return out;
  }

  /** Read a CSV the browser picked (domain, topic, description, keywords, synonyms, guidance, name; header names in any
      order; only domain is required). `has` says which optional columns the file carries: the others stay as they are. */
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
    const ALIAS = { domain: ['domain_name'], topic: ['topic_name'], synonyms: ['synonym'], guidance: ['guidance_for_the_assistant', 'assistant_guidance'] };
    const at = k => head.findIndex(h => h === k || (ALIAS[k] || []).includes(h));
    const idx = COLS.map(at);
    if (idx[0] < 0) return { error: 'The first row must name the columns: domain, topic, description, keywords, synonyms, guidance.' };
    const has = { description: idx[2] >= 0, keywords: idx[3] >= 0, synonyms: idx[4] >= 0, guidance: idx[5] >= 0 };
    return { has, rows: body.slice(1).map(r => idx.map((i, c) => (i < 0 ? '' : COLS[c] === 'guidance' ? cleanBlock(r[i]) : clean(r[i])))) };
  }

  /** How rows match names: case- and space-insensitive; accents count (“Học phí” isn't “Hoc phi”). */
  const nameKey = s => clean(s).normalize('NFC').toLowerCase();
  /** Compare spreadsheet rows with the taxonomy: { added[], updated[], same, archived[], kept[], errors[] }.
      A change: { domain (true for a domain row), name, desc, keywords, synonyms, guidance, row (1-based, header = 1), and
      for a topic where (its domain's name), parent (an existing domain's id) or fresh (the change creating its domain);
      t (the matched topic or domain), what[] }. A row's `name` (from an export) matches that topic or domain itself;
      otherwise a domain matches by name among the active domains and a topic among its domain's active topics; no match
      creates one. Columns the file doesn't have (`has`) are neither compared nor applied. */
  function diff(rows, mode, has = ALL_COLS) {
    const prefix = `workspaces/${curWs().id}/topics/`;
    const out = { added: [], updated: [], same: 0, archived: [], kept: [], errors: [] };
    const matched = new Set(), done = new Set(), fresh = new Map();
    const named = s => { const t = s.startsWith(prefix) ? topicById(s.slice(prefix.length)) : null; return live(t) ? t : null; };
    // A domain a row renames through `name` answers to its new name too, so its topics' rows still find it.
    const renamed = new Map();
    rows.forEach(r => { const d = !r[1] && r[0] && r[6] ? named(r[6]) : null; if (d && !d.parent) renamed.set(nameKey(r[0]), d); });
    /** The domain a row names: { d } (existing), { k, fresh } (new in this file; fresh once a row created it) or { error }. */
    const domainOf = s => {
      const k = nameKey(s);
      if (renamed.has(k)) return { d: renamed.get(k) };
      const hits = domains().filter(d => nameKey(d.name) === k);
      if (hits.length > 1) return { error: `More than one domain is called “${s}”.` };
      return hits.length ? { d: hits[0] } : { k, fresh: fresh.get(k) };
    };
    const listDelta = (what, before, after, noun) => {
      if (kwEq(before, after)) return;
      const plus = after.filter(k => !before.some(x => fold(x) === fold(k))).length, minus = before.filter(k => !after.some(x => fold(x) === fold(k))).length;
      if (plus) what.push(`${plural(plus, noun)} added`);
      if (minus) what.push(`${plural(minus, noun)} removed`);
      if (!plus && !minus) what.push(`${noun}s`);
    };
    rows.forEach((r, i) => {
      const [domain, topic, desc, kw, syn, guidance, name] = r, row = i + 2;
      const fail = text => out.errors.push({ row, label: topic ? (domain ? `${domain} › ${topic}` : topic) : domain, text });
      if (!domain) return fail('No domain.');
      const keywords = splitKw(kw), synonyms = splitKw(syn);
      if (!topic && (keywords.length || synonyms.length || guidance)) return fail('Keywords, synonyms and guidance go on topic rows, not on a domain’s row.');
      if (domain.length > 255 || topic.length > 255) return fail('A name is longer than 255 characters.');
      if (keywords.length > 50 || synonyms.length > 50) return fail('More than 50 keywords or synonyms.');
      if ([...keywords, ...synonyms].some(k => k.length > 100)) return fail('A keyword or synonym is longer than 100 characters.');
      if (guidance.length > 2000) return fail('The guidance is longer than 2,000 characters.');
      let t = null;
      if (name) {
        t = named(name);
        if (!t) return fail('Its name column points at no topic in use (unknown or archived).');
        if (!t.parent !== !topic) return fail(topic ? 'Its name column points at a domain, not a topic.' : 'Its name column points at a topic, not a domain.');
      }
      if (!topic) {
        // A domain's own row: its description and, with `name`, its new name.
        const at = t ? { d: t } : domainOf(domain);
        if (at.error) return fail(at.error);
        const d = at.d, key = d ? d.id : `new:${at.k}`;
        if (done.has(key)) return fail(`“${domain}” is listed more than once. Only the first row is used.`);
        done.add(key);
        if (!d) {
          if (at.fresh) { at.fresh.desc = desc; return; } // its topics' rows created it already
          const c = { domain: true, name: domain, desc, row };
          fresh.set(at.k, c); out.added.push(c); return;
        }
        matched.add(d.id);
        const what = [];
        if (d.name !== domain) what.push(`renamed from “${d.name}”`);
        if (has.description && (d.desc || '') !== desc) what.push('description');
        if (what.length) out.updated.push({ domain: true, name: domain, desc, row, t: d, what }); else out.same++;
        return;
      }
      const at = domainOf(domain);
      if (at.error) return fail(at.error);
      const d = at.d;
      if (!t && d) {
        const hits = kidsOf(d.id).filter(x => nameKey(x.name) === nameKey(topic));
        if (hits.length > 1) return fail(`${d.name} has more than one topic called “${topic}”.`);
        t = hits[0] || null;
      }
      const key = t ? t.id : `${d ? d.id : `new:${at.k}`}\n${nameKey(topic)}`;
      if (done.has(key)) return fail(`“${topic}” is listed more than once in ${domain}. Only the first row is used.`);
      done.add(key);
      if (d) matched.add(d.id);
      else if (!at.fresh) { at.fresh = { domain: true, name: domain, desc: '', row }; fresh.set(at.k, at.fresh); out.added.push(at.fresh); } // named only by its topics
      const c = { domain: false, name: topic, where: d ? d.name : at.fresh.name, parent: d?.id, fresh: d ? null : at.fresh, desc, keywords, synonyms, guidance: guidance || '', row };
      if (!t) { out.added.push(c); return; }
      matched.add(t.id);
      const what = [];
      if (t.name !== topic) what.push(`renamed from “${t.name}”`);
      if (t.parent !== d?.id) what.push(`moved to ${c.where}`);
      if (has.description && (t.desc || '') !== desc) what.push('description');
      if (has.keywords) listDelta(what, topicKeywords(t), keywords, 'keyword');
      if (has.synonyms) listDelta(what, topicSynonyms(t), synonyms, 'synonym');
      if (has.guidance && (t.guidance || '') !== c.guidance) what.push('guidance');
      if (what.length) out.updated.push({ ...c, t, what }); else out.same++;
    });
    if (mode === 'replace') {
      const n = topicCounts();
      (D.topics || []).filter(t => live(t) && !matched.has(t.id)).forEach(t => (usedBy(t, n) ? out.kept : out.archived).push(t));
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
    ['merge', 'Add and update', 'Topics are matched by name within their domain: new ones are added, matching ones updated. Nothing is removed.', 'plus'],
    ['replace', 'Replace', 'Also archives topics that aren’t in the file. Topics documents still use are kept.', 'refresh'],
  ];
  function changeList(title, items, line, tone, limit = 6) {
    if (!items.length) return '';
    const more = items.length - limit;
    return `<section class="md-chg"><h3 class="md-chg__title">${chip(fmtNum(items.length), { size: 'sm', tone })}<span>${esc(title)}</span></h3>
      <ul class="md-chg__list">${items.slice(0, limit).map(line).join('')}${more > 0 ? `<li class="muted">${esc(`+${fmtNum(more)} more`)}</li>` : ''}</ul></section>`;
  }
  /** “Domain › Topic” (or just the domain), names kept apart from interface words so translation never rewrites them. */
  const pathHtml = (dom, topic = '') => (topic ? `<span><span class="muted" translate="no">${esc(dom)}</span><span class="muted" aria-hidden="true"> › </span><span class="medium" translate="no">${esc(topic)}</span></span>` : `<span class="medium" translate="no">${esc(dom)}</span>`);
  M['md-import'] = () => {
    const f = IMP();
    if (f.step === 'file') {
      const drop = `<button type="button" class="ctb-drop" id="md-drop" data-act="md-browse" aria-describedby="md-drop-hint"><span class="ctb-drop__icon">${ic('table', 'i-lg')}</span><span class="medium">Drop a spreadsheet here or <span class="text-accent">browse</span></span><span class="description" id="md-drop-hint">CSV or Excel · columns domain, topic, description, keywords, synonyms, guidance</span></button>`;
      const err = f.err ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : '';
      const helpers = `<div class="ctb-samples"><span class="t-xs muted">Try it with</span>${btn(sampleName(), { size: 'sm', v: 'tertiary', icon: 'file', act: 'md-sample' })}<span class="grow"></span>${linkBtn('Download template', { act: 'md-template', icon: 'download' })}</div>`;
      return {
        size: 'md', icon: 'database', title: 'Import taxonomy', desc: `Update the domains, topics, keywords and synonyms ${esc(curWs().name)} classifies documents with. Rows match them by name, and you check every change before it’s applied.`,
        body: drop + err + helpers + `<div class="field mt-16"><span class="label">How to apply it</span>${choiceGroup({ name: 'md-mode', value: f.mode, options: MODES, act: 'md-mode', cols: 2 })}</div>`,
        footStart: '<span class="t-xs muted">Nothing changes until you import.</span>',
        foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }),
      };
    }
    const x = diff(f.rows, f.mode, f.has), total = changeCount(x), open = reviewQueue().length;
    const resolved = openProposals().filter(p => x.added.some(c => !c.domain && fold(c.name) === fold(p.name)));
    const file = `<div class="md-file">${fileIcon(f.file.name.split('.').pop(), 'sm')}<div class="grow md-min"><div class="medium truncate" translate="no">${esc(f.file.name)}</div><div class="t-xs muted">${esc(`${plural(f.rows.length, 'row')} · ${fmtSize(f.file.size)}`)}</div></div>${f.preview ? chip('Sample data', { size: 'sm', icon: 'info', tip: 'The prototype can’t read Excel files, so it shows a sample sheet built from this workspace. CSV files are read for real.' }) : ''}${btn('Choose another file', { v: 'ghost', size: 'sm', act: 'md-back' })}</div>`;
    // Interface words and workspace names sit in separate nodes, so the interface language never rewrites a topic name.
    const note = s => `<span class="muted">${esc(s)}</span>`, notes = list => `<span>${list.map(note).join('<span class="muted">, </span>')}</span>`;
    const nodePath = t => (t.parent ? pathHtml(topicName(t.parent), t.name) : pathHtml(t.name));
    const errs = x.errors.length ? alertBox('warning', `${plural(x.errors.length, 'row')} will be skipped`, `<ul class="md-errs">${x.errors.map(e => `<li><span class="md-errs__row">${esc(`Row ${e.row}`)}</span>${e.label ? ` <span translate="no">${esc(e.label)}</span>${DOT}` : ' '}<span>${esc(e.text)}</span></li>`).join('')}</ul>`) : '';
    const lists = changeList('New', x.added, c => `<li>${c.domain ? `${pathHtml(c.name)}${DOT}${note('new domain')}` : pathHtml(c.where, c.name)}</li>`, 'success')
      + changeList('Updated', x.updated, c => `<li>${c.domain ? pathHtml(c.name) : pathHtml(c.where, c.name)}${DOT}${notes(c.what)}</li>`, 'accent')
      + changeList('Archived', x.archived, t => `<li>${nodePath(t)}${DOT}${note('not in the file, unused')}</li>`, 'default')
      + changeList('Kept although not in the file', x.kept, t => `<li>${nodePath(t)}${DOT}${note(t.parent ? 'documents use it' : 'still has topics or documents')}</li>`, 'default', 4);
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
    const topicFields = (c, upd) => ({
      ...(has.keywords || !upd ? { keywords: c.keywords } : {}),
      ...(has.synonyms ? { synonyms: c.synonyms.length ? c.synonyms : undefined } : {}),
      ...(has.guidance ? { guidance: c.guidance || undefined } : {}),
    });
    // New domains first, so new and moved topics can point at them. IDs are generated; nobody sees them.
    const add = (c, fields) => { c.id = uid(c.domain ? 'd' : 't'); D.topics.push(JSON.parse(JSON.stringify({ id: c.id, name: c.name, desc: c.desc || undefined, ...fields }))); };
    x.added.filter(c => c.domain).forEach(c => add(c, {}));
    x.added.filter(c => !c.domain).forEach(c => add(c, { parent: c.parent || c.fresh.id, ...topicFields(c, false) }));
    x.updated.forEach(c => Object.assign(c.t, { name: c.name }, has.description ? { desc: c.desc || undefined } : {}, c.domain ? {} : { parent: c.parent || c.fresh.id, ...topicFields(c, true) }));
    x.archived.forEach(t => { t.archived = true; });
    // Open submissions are classified with the new taxonomy first; then the proposals the file now covers fold into
    // the imported topic and tag the documents that raised them.
    const again = reclassifyOpen();
    openProposals().forEach(p => { const c = x.added.find(a => !a.domain && fold(a.name) === fold(p.name)); if (c) mergeProposal(p, c.id); });
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
  /** What the pipeline's Classify step sends the model, built from the rules as they are now (backend
      prompts/document_profile*.md): the part every document of a run shares — instructions, the run note and the
      taxonomy, grouped by domain with short labels T1…Tn (topic IDs never reach the model) — which providers cache,
      then one document's part: keyword matches, title and excerpt. The model answers with labels and names. */
  const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim() || '-';
  const list = a => (a || []).map(s => String(s).trim()).filter(Boolean).join('; ') || '-';
  function promptParts() {
    let n = 0;
    const tax = [...domains()].sort((a, b) => a.name.localeCompare(b.name)).map(dm => [`## Domain: ${dm.name}`,
      ...kidsOf(dm.id).sort((a, b) => a.name.localeCompare(b.name)).map(t => [`T${++n}`, flat(t.name), flat(t.desc), list(topicKeywords(t)), list(topicSynonyms(t)), flat(t.guidance), list((t.examples || []).map(docById).filter(Boolean).map(d => d.name))].join(' | '))].join('\n')).join('\n\n');
    const shared = `<document_profile_instructions>
  Classify one document under every topic of the taxonomy that it is about, and summarize it.
  - Start with the topic that best describes what it is mainly about, then add every other topic that is also a real
    subject of it, in the same domain or another, without a limit. A subject it only mentions is not one of its topics.
  - Prefer the most specific topic; follow each topic's guidance. Keyword matches are hints, not answers.
  - Choose none when no topic fits: a wrong topic is worse than a missing one.
  - Summary: one or two factual sentences in the document's own language: what kind of document it is and what it covers.
  Answer with one JSON object:
  {"topics": [{"label": "T12", "name": "…", "evidence": "…"}], "summary": "…"}
</document_profile_instructions>

<run_note>{the run's note for the assistant}</run_note>
<taxonomy>
${tax}
</taxonomy>`;
    const each = `<keyword_matches>
{topics whose name, keywords or synonyms the document dwells on}
</keyword_matches>
<document_title>{title}</document_title>
<document>
{metadata and leading excerpts, up to 12,000 characters}
</document>`;
    return { shared, each };
  }
  const PROFILE_BLOCK = `<document_profile>
summary: {summary}
</document_profile>`;
  DR['md-prompt'] = () => {
    const { shared, each } = promptParts(), tokens = s => Math.ceil(s.length / 4);
    const rules = leaves().flatMap(t => (t.rules || []).map(r => `<li><span translate="no">${esc(ruleText(r))}</span> ${ic('arrow-right', 'i-xs')} <span class="medium" translate="no">${esc(t.name)}</span></li>`));
    const code = (s, label) => `<pre class="md-prompt__code" tabindex="0" aria-label="${esc(label)}" translate="no"><code>${esc(s)}</code></pre>`;
    return {
      size: 'xl', title: 'Classification prompt', lead: itemIcon('code', 'accent'),
      desc: `document_profile.md, built from these rules: about ${fmtNum(tokens(shared))} tokens shared by every document, cached by the model provider, and about ${fmtNum(tokens(each) + 3000)} for each document.`,
      body: `<div class="md-prompt stack gap-16">
        ${sec('Rules checked first', rules.length ? `<ul class="md-prompt__rules">${rules.join('')}</ul>` : `<p class="tx-sec__empty">${esc('No topic has a rule.')}</p>`, { desc: esc('A matching collection or source settles the topic without asking the model.') })}
        ${sec('Shared by every document', code(shared, 'Shared prompt'), { desc: esc('The same for every document of a run, so the provider serves it from cache.') })}
        ${sec('Each document', code(each, 'Document prompt'))}
        ${sec('What reaches each passage', code(PROFILE_BLOCK, 'Document profile block'), { desc: esc('contextual_rag.md puts the summary before every passage it describes. Topics stay in the index’s metadata, so changing them needs no re-indexing.') })}
      </div>`,
      foot: btn('Close', { v: 'ghost', act: 'close-drawer' }) + btn('Copy prompt', { v: 'primary', icon: 'copy', act: 'md-prompt-copy' }),
    };
  };
  A['md-prompt-copy'] = () => { const { shared, each } = promptParts(); copyText(`${shared}\n\n${each}`, 'Prompt copied'); };

  X.md = { tab, headerActions, proposals, learn };
})();

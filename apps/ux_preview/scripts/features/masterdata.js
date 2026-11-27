/* Knowledge Studio → Classification (/studio?tab=taxonomy): the workspace's concept schemes (docs/KNOWLEDGE_STUDIO.md "Classification").
   One tab per classification scheme (Lĩnh vực · Nghiệp vụ · Loại tài liệu · Đối tượng on campus; one Subject scheme in
   enterprise workspaces) and Suggestions — the only tab with a count. Authority lists (org units, programs) are no tabs:
   they open from a scheme's ⋯ → Reference lists, with a way back.
   A scheme's tab (view = scheme id): a header (name, description, published version, a quiet “Duplicate labels (n)” link
   when labels collide, the single primary “Publish (k changes)” while the working copy has unpublished edits, and ⋯) over
   two panes: the tree (search over every label, a poly-hierarchy — a concept with several broader concepts sits under each,
   marked “Also under …” under the others — drafts badged, retired concepts last behind “Retired (n)”, document counts that
   include narrower concepts; keyboard navigable) and the selected concept (?node=): preferred name (click to rename),
   definition, scope note, labels (alternative and hidden, each with its language), relations (broader, related), mappings,
   recognition patterns (document types only), the rules that file documents here, icon and color (top concepts).
   Every edit changes the working copy at once — people see new names everywhere — and is listed on the scheme
   (noteChange) until Publish, with Undo. Machines (classification, query interpretation) take it when it's published:
   the Publish dialog checks it (blocking problems link to their concept, warnings), says what it will do to documents
   (merges remapped, documents classified again) and lists the changes. A concept's ⋯: merge into another, split into
   several, retire, or delete a draft that was never published. The scheme's ⋯: export SKOS (Turtle), version history,
   import CSV (scheme, notation, broader, pref_vi, pref_en, alt, hidden, definition, scope_note), reference lists, and how
   the assistant classifies (the prompt every document shares, the rules, a box to test a title).
   ?conflicts=1: labels two concepts of the scheme share (remove or move one) and labels shared with other schemes (valid:
   a search reads them from the rest of the question).
   Suggestions (view = suggestions), filtered by scheme: labels awaiting review (grouped by concept, plus first syncs'
   batches and the scheme's “Not classified” pool), new concept proposals (accepting adds a draft to the tree) and labels
   learned from reviewers' edits. People who aren't workspace admins see every view read-only.
   Phones: the tree first; a concept opens as a full view with Back.
   Exports: X.md = { tab({query}), headerActions(query), openConcept(id) }. Actions: md-edit (dataset.id = a concept: its
   scheme's tab with it selected), tx-*. Modals: tx-new, tx-replace, tx-move-label, tx-publish, tx-accept, tx-import.
   Drawers: tx-versions, tx-prompt. Menus: tx-scheme-more, tx-concept-more. Popover: tx-icon. */
(() => {
  'use strict';

  const RETIRED = '__retired';
  const DOT = '<span class="muted" aria-hidden="true"> · </span>';
  const clean = s => String(s ?? '').trim().replace(/\s+/g, ' ');
  const nameKey = s => clean(s).normalize('NFC').toLowerCase();
  const audit = (action, target) => lifeAudit(action, target);
  const admin = () => canManageTaxonomy();
  const isClass = s => !!s && s.purpose !== 'authority';
  const uniq = a => [...new Set(a)];
  const otherLang = l => (l === 'vi' ? 'en' : 'vi');
  const LANG_OPTIONS = [['vi', 'vi'], ['en', 'en']];
  /** What a working-copy change is called in lists (Publish, Version history). */
  const KIND = { added: 'Added', relabeled: 'Labels changed', redefined: 'Definition changed', moved: 'Moved', deprecated: 'Retired', merged: 'Merged', split: 'Split', thresholds: 'Thresholds changed' };
  const MATCH = [['exact', 'Exact match'], ['close', 'Close match'], ['broad', 'Broad match'], ['narrow', 'Narrow match']];
  const LABEL_KIND = { pref: 'Preferred', alt: 'Alternative', hidden: 'Hidden' };

  /* ═══════════════ Concepts within one scheme ═══════════════ */
  /** Broader concepts in the concept's own scheme (a program's broader org unit belongs to another list). */
  const parentsIn = c => (c?.broader || []).filter(b => conceptById(b)?.scheme === c.scheme);
  const kidsIn = (sid, id) => conceptsOf(sid).filter(c => parentsIn(c).includes(id));
  const rootsOf = sid => conceptsOf(sid).filter(c => !parentsIn(c).length);
  const retiredOf = sid => (D.concepts || []).filter(c => c.scheme === sid && conceptState(c) === 'deprecated');
  /** Related concepts, both ways (stored once per pair). */
  const relatedOf = c => uniq([...(c.related || []), ...(D.concepts || []).filter(o => (o.related || []).includes(c.id)).map(o => o.id)]).filter(conceptById);
  /** Levels from the top through the longest same-scheme path (a top concept is 1). */
  function depthOf(c, seen = new Set()) {
    if (!c || seen.has(c.id)) return 0;
    seen.add(c.id);
    const ps = parentsIn(c).map(conceptById).filter(Boolean);
    return 1 + (ps.length ? Math.max(...ps.map(p => depthOf(p, new Set(seen)))) : 0);
  }
  /** Does following broader concepts lead back to it? */
  function inCycle(c) {
    const seen = new Set(), q = [...(c.broader || [])];
    while (q.length) { const b = q.pop(); if (b === c.id) return true; if (seen.has(b)) continue; seen.add(b); q.push(...(conceptById(b)?.broader || [])); }
    return false;
  }
  const prefIn = (c, lang) => c?.pref?.[lang] || conceptName(c?.id);
  /** A name another concept of the scheme already has as its preferred label. */
  function nameClash(sid, name, except = '') {
    const k = normLabel(name);
    return conceptsOf(sid).some(c => c.id !== except && Object.values(c.pref || {}).some(p => normLabel(p) === k)) ? `${schemeName(sid)} already has “${name}”.` : '';
  }
  /** The authority concepts a document names (issuer, applicability). */
  const authorityIds = d => { const x = issuanceOf(d); return x ? [x.issuer, ...x.units, ...x.programs].filter(Boolean) : []; };
  /** Published documents the caller can read per concept of a scheme, narrower concepts included, each document once. */
  function docCounts(sid) {
    const s = schemeById(sid), m = new Map();
    readableResources().forEach(d => {
      const ids = (isClass(s) ? resConcepts(d) : authorityIds(d)).filter(id => conceptById(id)?.scheme === sid);
      new Set(ids.flatMap(conceptLineage)).forEach(id => m.set(id, (m.get(id) || 0) + 1));
    });
    return id => m.get(id) || 0;
  }

  /* ═══════════════ Working copy: edits, unpublished changes, Undo ═══════════════ */
  /** List an edit on its scheme. A draft is one change (“Added”) however often it's edited; the same kind of edit to the same
      concept is listed once. */
  function note(sid, kind, id, text = '') {
    const s = schemeById(sid); if (!s) return;
    const list = s.changes || [];
    if (!['deprecated', 'merged', 'split'].includes(kind) && list.some(x => x.concept === id && x.kind === 'added')) return;
    s.changes = list.filter(x => !(x.concept === id && x.kind === kind));
    noteChange(sid, kind, id, text);
  }
  const snapTax = () => ({ concepts: clone(D.concepts || []), changes: Object.fromEntries((D.schemes || []).map(s => [s.id, clone(s.changes || [])])) });
  function restoreTax(snap) { D.concepts = snap.concepts; (D.schemes || []).forEach(s => { if (snap.changes[s.id]) s.changes = snap.changes[s.id]; }); }
  const undoTax = (snap, extra = null) => ({ label: 'Undo', run: () => { restoreTax(snap); extra?.(); audit('Undid a change to the classification', ''); refresh(); } });
  const AUDIT = { added: 'Added a concept', relabeled: 'Changed a concept’s labels', redefined: 'Edited a concept', moved: 'Moved a concept', deprecated: 'Retired a concept', merged: 'Merged a concept', split: 'Split a concept' };
  /** Apply one edit to a concept: change it, list it on its scheme (kind), toast with Undo. */
  function apply(c, kind, text, msg, mutate) {
    if (!admin() || !c) return;
    const snap = snapTax();
    mutate(c);
    if (kind) note(c.scheme, kind, c.id, text);
    audit(AUDIT[kind] || 'Edited a concept', `${schemeName(c.scheme)} · ${conceptName(c.id)}`);
    refresh();
    toast(msg, { action: undoTax(snap) });
  }

  /* ═══════════════ Tab ═══════════════ */
  const viewOf = q => (q.view === 'suggestions' || schemeById(q.view) ? q.view : firstScheme()?.id || 'suggestions');
  function tab({ query = {} } = {}) {
    const none = () => emptyState({ icon: 'layers', title: 'No classification schemes yet', desc: 'Schemes come with the workspace template.', boxed: true });
    return gate({
      loading: () => skelRows(6),
      error: () => errorState({ title: 'The classification didn’t load' }),
      empty: none,
      ok: () => {
        if (!classSchemes().length) return none();
        const view = viewOf(query), s = schemeById(view);
        if (view === 'suggestions') return tabsRow(view) + suggestionsView();
        if (!isClass(s)) return `<div class="tx-ref">${btn('Back to classification', { v: 'ghost', size: 'sm', icon: 'arrow-left', href: taxonomyHref() })}</div>${schemeView(s, query)}`;
        return tabsRow(s.id) + (query.conflicts ? conflictsView(s) : schemeView(s, query));
      },
    });
  }
  /** The page's top row carries no actions: a scheme's Publish and ⋯ belong to its own header, under the tabs. */
  const headerActions = () => '';
  /** One tab per classification scheme, then Suggestions with the only count. Scheme names are content. */
  function tabsRow(view) {
    const n = suggestionCount();
    const tab = (id, inner) => `<a class="tabs__tab" href="#${taxonomyHref(id)}"${id === view ? ' aria-current="page"' : ''}>${inner}</a>`;
    const items = classSchemes().map(s => tab(s.id, `<span translate="no">${esc(s.name)}</span>`)).join('')
      + tab('suggestions', `${esc('Suggestions')}${n ? `<span class="tabs__count">${fmtNum(n)}</span>` : ''}`);
    return contextBar(`<nav class="tabs tabs--secondary" aria-label="${esc('Classification schemes')}" data-overflow><div class="tabs__list">${items}</div></nav>`);
  }

  /* ═══════════════ Scheme view: header + tree + detail ═══════════════ */
  function resolveNode(s, id) {
    const c = conceptById(id);
    if (c && c.scheme === s.id) return c.id;
    return rootsOf(s.id)[0]?.id || '';
  }
  function schemeView(s, query) {
    const count = docCounts(s.id), id = resolveNode(s, query.node);
    return `<div class="${cx('tx', query.node && 'tx--picked')}">${schemeHead(s)}<div class="tx-panes">${treePane(s, id, count)}<div class="tx-main" id="tx-main">${detail(s, conceptById(id), count)}</div></div></div>`;
  }
  function schemeHead(s) {
    const k = pendingChanges(s.id).length, dup = dupCount(s.id);
    const meta = [
      `<span>${esc(s.version ? `Version ${s.version}` : 'Not published yet')}</span>`,
      k && !admin() ? `<span>${esc(`${plural(k, 'unpublished change')}`)}</span>` : '',
      dup ? `<a class="link" href="#${taxonomyHref(s.id, { conflicts: 1 })}">${esc(`Duplicate labels (${fmtNum(dup)})`)}</a>` : '',
    ].filter(Boolean).join(DOT);
    const pub = admin() && k ? btn(`Publish (${fmtNum(k)} ${k === 1 ? 'change' : 'changes'})`, { v: 'primary', icon: 'upload', act: 'tx-publish', data: { scheme: s.id } }) : '';
    return `<header class="tx-scheme"><div class="tx-scheme__main"><h2 class="tx-scheme__name" translate="no">${esc(s.name)}</h2>${s.desc ? `<p class="tx-scheme__desc" translate="no">${esc(s.desc)}</p>` : ''}<p class="tx-scheme__meta">${meta}</p></div>
      <div class="tx-scheme__acts">${pub}${iconBtn('more', 'More actions for this scheme', { menu: 'tx-scheme-more', data: { scheme: s.id } })}</div></header>`;
  }
  MENUS['tx-scheme-more'] = el => {
    const s = schemeById(el.dataset.scheme); if (!s) return [];
    const refs = authoritySchemes().filter(a => a.id !== s.id);
    return [
      ...(admin() ? [{ label: 'Import CSV', icon: 'upload', run: () => openImport(s.id) }] : []),
      { label: 'Export SKOS', icon: 'download', run: () => exportSkos(s) },
      { label: 'Version history', icon: 'history', run: () => openDrawer('tx-versions', { scheme: s.id }) },
      { label: 'See how the assistant classifies', icon: 'bot', run: () => openDrawer('tx-prompt', {}) },
      ...(refs.length ? [{ section: 'Reference lists' }, ...refs.map(a => ({ label: a.name, icon: schemeIcon(a.id), run: () => go(taxonomyHref(a.id)) }))] : []),
    ];
  };

  /* ═══════════════ Tree ═══════════════ */
  const TREE = sid => ui(`txTree-${sid}`, { q: '', closed: {}, retired: false });
  /** One grid for every row: [chevron 16] [icon 20] [name] [trailing]. A top concept's icon sits on a tile in its color; a
      narrower one's icon is drawn in that color. Small schemes start open; larger ones open along the selection. */
  function treePane(s, sel, count) {
    const u = TREE(s.id), q = fold(normLabel(u.q || ''));
    const live = conceptsOf(s.id), changed = new Set(pendingChanges(s.id).map(x => x.concept));
    let show = null;
    if (q) {
      show = new Set();
      live.filter(c => conceptLabels(c).some(l => fold(normLabel(l.text)).includes(q))).forEach(c => { show.add(c.id); ancestorsOf(c.id).forEach(a => show.add(a)); });
    }
    const along = new Set(sel ? ancestorsOf(sel) : []), small = live.length <= 30;
    const isOpen = id => (q ? true : id in u.closed ? !u.closed[id] : small || along.has(id));
    const chev = (id, open) => `<span class="tx-row__chev" data-act="tx-toggle" data-id="${esc(id)}" aria-hidden="true">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}</span>`;
    const noChev = '<span class="tx-row__chev tx-row__chev--none" aria-hidden="true"></span>';
    const glyph = (c, top) => { const l = conceptLook(c.id); return top ? `<span class="tx-row__tile"${l.style}>${ic(l.icon)}</span>` : `<span class="tx-row__glyph"${l.style}>${ic(l.icon, 'i-sm')}</span>`; };
    const name = (c, also) => `<span class="tx-row__label"><span class="tx-row__name" translate="no" title="${esc(conceptName(c.id))}">${esc(conceptName(c.id))}</span>${also.length ? `<span class="tx-row__also" title="${esc(`Also under ${also.map(conceptName).join(', ')}`)}">${esc(`Also under ${also.map(conceptName).join(', ')}`)}</span>` : ''}</span>`;
    const trail = (c, level) => {
      const st = conceptState(c), n = count(c.id);
      const badge = st === 'draft' ? `<span class="tx-row__badge">${esc('Draft')}</span>` : st === 'deprecated' ? `<span class="tx-row__badge">${esc('Retired')}</span>` : '';
      const dot = st === 'published' && changed.has(c.id) ? `<span class="tx-row__dot" role="img" aria-label="${esc('Unpublished changes')}" data-tip="${esc('Unpublished changes')}"></span>` : '';
      const add = admin() && st !== 'deprecated' && level < (s.maxDepth || 9) ? `<button type="button" class="tx-row__add" tabindex="-1" data-act="tx-new" data-scheme="${esc(s.id)}" data-broader="${esc(c.id)}" aria-label="${esc(`Add a concept under ${conceptName(c.id)}`)}" data-tip="${esc(`Add a concept under ${conceptName(c.id)}`)}">${ic('plus', 'i-sm')}</button>` : '';
      return `<span class="tx-row__trail">${badge}${dot}<span class="tx-row__count">${n ? fmtNum(n) : ''}</span>${add}</span>`;
    };
    function build(c, level, path, parent) {
      if ((show && !show.has(c.id)) || path.includes(c.id)) return null;
      const kids = kidsIn(s.id, c.id), open = kids.length ? isOpen(c.id) : null, ps = parentsIn(c);
      // Under a parent that isn't its first, a concept names where else it sits.
      const also = parent && ps[0] !== parent ? ps.filter(p => p !== parent) : [];
      const next = [...path, c.id];
      return {
        key: next.join('~'), id: c.id, level, expanded: open,
        inner: (kids.length ? chev(c.id, open) : noChev) + glyph(c, !ps.length) + name(c, also) + trail(c, level),
        children: open ? kids.map(k => build(k, level + 1, next, c.id)).filter(Boolean) : [],
      };
    }
    const items = rootsOf(s.id).map(c => build(c, 1, [], '')).filter(Boolean);
    const retired = retiredOf(s.id);
    if (retired.length && !q) {
      const children = u.retired ? retired.map(c => ({ key: `${RETIRED}~${c.id}`, id: c.id, level: 2, cls: 'tx-item--retired', inner: noChev + glyph(c, false) + name(c, []) + trail(c, 99), children: [] })) : [];
      items.push({ key: RETIRED, id: RETIRED, level: 1, expanded: !!u.retired, cls: 'tx-item--retired-group', inner: `${chev(RETIRED, u.retired)}${ic('archive', 'i-sm tx-row__icon')}<span class="tx-row__name muted">${esc(`Retired (${fmtNum(retired.length)})`)}</span><span class="tx-row__trail"></span>`, children });
    }
    const flat = []; const walk = list => list.forEach(x => { flat.push(x); walk(x.children); }); walk(items);
    const focusKey = (flat.find(x => x.id === sel) || flat[0])?.key;
    const li = x => `<li role="treeitem" id="tx-n-${esc(x.key)}" class="${cx('tx-item', x.cls)}" aria-level="${x.level}" aria-selected="${x.id === sel}" ${x.expanded != null ? `aria-expanded="${x.expanded}"` : ''} tabindex="${x.key === focusKey ? 0 : -1}" data-id="${esc(x.id)}">`
      + `<div class="${cx('tx-row', x.id === sel && 'is-selected')}" data-act="tx-node" data-id="${esc(x.id)}">${x.inner}</div>${x.children.length ? `<ul role="group" class="tx-group">${x.children.map(li).join('')}</ul>` : ''}</li>`;
    const tools = `<div class="tx-side__tools">${searchField({ uiKey: `txTree-${s.id}`, placeholder: 'Search labels', full: true, id: 'tx-q', label: 'Search concepts by any label' })}${admin() ? iconBtn('plus', 'New concept', { act: 'tx-new', data: { scheme: s.id } }) : ''}</div>`;
    const body = items.length ? `<ul role="tree" class="tx-tree" aria-label="${esc(s.name)}">${items.map(li).join('')}</ul>`
      : `<p class="tx-side__empty">${esc(q ? `No concept has the label “${u.q}”.` : 'No concepts yet.')}</p>`;
    return `<div class="tx-side" id="tx-side" data-keep-scroll>${tools}${body}</div>`;
  }
  const curScheme = () => schemeById(viewOf(S.cur?.query || {}));
  function selectNode(id) { if (id === RETIRED) toggleNode(RETIRED); else showNode(id); }
  /** Select a concept and bring the detail's top into view (phones show one pane at a time). */
  function showNode(id) {
    setQuery({ node: id, conflicts: '' });
    const sc = $('#scroll'), panes = $('#app .tx-panes'); if (!sc || !panes) return;
    const top = Math.max(0, panes.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 12);
    if (sc.scrollTop > top || !$('#tx-side')?.offsetParent) sc.scrollTop = top;
  }
  function toggleNode(id, close) {
    const s = curScheme(); if (!s) return;
    const u = TREE(s.id);
    if (id === RETIRED) u.retired = close == null ? !u.retired : !close;
    else {
      const open = !!$(`.tx-tree [role="treeitem"][data-id="${CSS.escape(id)}"][aria-expanded="true"]`);
      u.closed[id] = close == null ? open : close;
    }
    refresh();
  }
  A['tx-node'] = el => selectNode(el.dataset.id);
  A['tx-toggle'] = el => toggleNode(el.dataset.id);
  A['tx-back'] = () => { const prev = S.cur?.query.node; setQuery({ node: '' }); requestAnimationFrame(() => $(`.tx-tree [role="treeitem"][data-id="${CSS.escape(prev || '')}"]`)?.focus()); };
  /** Other screens open a concept here: its scheme's tab with it selected. */
  function openConcept(id) { const c = conceptById(id); if (c) go(taxonomyHref(c.scheme, { node: c.id })); }
  A['md-edit'] = el => openConcept(el.dataset.id);
  /** Tree keyboard: ↑↓ Home End move, → opens or enters, ← closes or goes to the parent, Enter/Space selects. */
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
  const back = () => `<div class="tx-back">${btn('All concepts', { v: 'ghost', size: 'sm', icon: 'arrow-left', act: 'tx-back' })}</div>`;
  const sec = (title, body, { desc = '', aside = '', id = '' } = {}) => `<section class="tx-sec" ${id ? `aria-labelledby="${id}"` : ''}><div class="tx-sec__head"><h3 class="tx-sec__title" ${id ? `id="${id}"` : ''}>${esc(title)}</h3>${aside}</div>${desc ? `<p class="tx-sec__desc">${desc}</p>` : ''}${body}</section>`;
  const emptyLine = text => `<p class="tx-sec__empty">${esc(text)}</p>`;
  function detail(s, c, count) {
    if (!c) return `<div class="tx-detail">${back()}${emptyState({ icon: 'tag', title: 'Pick a concept', desc: admin() ? 'Choose a concept in the list, or add the first one.' : 'Choose a concept in the list to see it.', compact: true, actions: admin() && !conceptsOf(s.id).length ? btn('New concept', { v: 'secondary', icon: 'plus', act: 'tx-new', data: { scheme: s.id } }) : '' })}</div>`;
    const ro = !admin() || conceptState(c) === 'deprecated';
    return `<div class="tx-detail">${back()}${head(s, c, count, ro)}${conceptState(c) === 'deprecated' ? retiredNote(c) : ''}
      ${textSec(c, 'definition', ro)}${textSec(c, 'scope', ro)}${labelsSec(s, c, ro)}${relationsSec(s, c, ro)}${mappingsSec(c, ro)}
      ${s.id === 'document-type' ? patternsSec(c, ro) : ''}${rulesSec(c)}${!ro && !parentsIn(c).length ? colorSec(c) : ''}</div>`;
  }

  /* ── Header: icon, preferred name (click to rename), where it sits, documents, notation, ⋯ ── */
  const REN = () => ui('txRename', { id: '', val: '', err: '' });
  function head(s, c, count, ro) {
    const l = conceptLook(c.id), lang = schemeLang(s.id), f = REN(), editing = !ro && f.id === c.id;
    const title = ro ? `<h2 class="tx-head__title" translate="no">${esc(conceptName(c.id))}</h2>`
      : editableTitle({ id: 'tx-name', value: editing ? f.val : prefIn(c, lang), editing, edit: 'tx-rename', commit: 'tx-rename-done', cancel: 'tx-rename-cancel', cls: 'tx-head__title', label: 'Rename concept', maxlength: 120, error: editing ? f.err : '', data: { id: c.id } });
    const icon = ro ? `<span class="item-icon item-icon--tone"${l.style} aria-hidden="true">${ic(l.icon)}</span>` : iconButton(c.id, l.icon, l.color);
    const st = conceptState(c), ps = parentsIn(c), n = count(c.id);
    const badge = st === 'draft' ? chip('Draft', { size: 'sm', tone: 'accent', tip: 'Not used for classification until you publish the scheme' }) : st === 'deprecated' ? chip('Retired', { size: 'sm' }) : '';
    const where = ps.length ? `<span translate="no">${esc(conceptPathText(ps[0]))}</span>` : `<span>${esc('Top concept')}</span>`;
    const docs = n && isClass(s) ? `<a class="link" href="#${conceptHref(c.id)}">${esc(plural(n, 'document'))}</a>` : `<span>${esc(n ? plural(n, 'document') : 'No documents yet')}</span>`;
    const notation = `<span class="tx-notation" translate="no" data-tip="${esc('Notation: its ID in exports and the API. It never changes.')}">${esc(c.notation)}</span>`;
    const more = admin() && st !== 'deprecated' ? iconBtn('more', 'More actions for this concept', { menu: 'tx-concept-more', data: { id: c.id } }) : '';
    return `<header class="tx-head">${icon}<div class="tx-head__main"><div class="tx-head__title-row">${title}${badge}</div>
      <p class="tx-head__meta">${where}${DOT}${docs}${DOT}${notation}</p></div><div class="tx-head__acts">${more}</div></header>`;
  }
  A['tx-rename'] = el => { const c = conceptById(el.dataset.id); if (!c || !admin()) return; Object.assign(REN(), { id: c.id, val: prefIn(c, schemeLang(c.scheme)), err: '' }); refresh(); };
  A['tx-rename-cancel'] = () => { Object.assign(REN(), { id: '', err: '' }); refresh(); };
  /** Enter or leaving the name. An empty or unchanged name just closes; a name another concept of the scheme has stays open with why. */
  A['tx-rename-done'] = el => {
    const f = REN(), c = conceptById(el.dataset.id); if (!c || f.id !== c.id) return;
    const lang = schemeLang(c.scheme), name = clean(el.value);
    if (!name || name === prefIn(c, lang)) { Object.assign(f, { id: '', err: '' }); refresh(); return; }
    const err = nameClash(c.scheme, name, c.id);
    if (err) { Object.assign(f, { val: el.value, err }); refresh(); return; }
    Object.assign(f, { id: '', err: '' });
    apply(c, 'relabeled', name, `Renamed to “${name}”`, x => { x.pref = { ...(x.pref || {}), [lang]: name }; });
  };

  /* ── Look: icon (header tile → popover grid) and a top concept's color; display only, so no change to publish ── */
  function iconButton(id, icon, color) {
    return `<button type="button" class="tx-icon-btn item-icon item-icon--tone" style="--tone:${esc(color)}" data-popover="tx-icon" data-id="${esc(id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc('Change icon')}" data-tip="${esc('Change icon')}">${ic(icon)}</button>`;
  }
  PO['tx-icon'] = el => {
    const c = conceptById(el.dataset.id); if (!c) return null;
    const cur = c.icon || (parentsIn(c).length ? '' : schemeIcon(c.scheme));
    const items = CONCEPT_ICONS.map(([name, label]) => `<button type="button" class="tx-icons__item" aria-pressed="${name === cur}" aria-label="${esc(label)}" data-tip="${esc(label)}" data-act="tx-icon-pick" data-id="${esc(c.id)}" data-value="${name}">${ic(name)}</button>`).join('');
    const reset = parentsIn(c).length && c.icon ? btn('Use the broader concept’s icon', { v: 'ghost', size: 'sm', icon: 'undo', act: 'tx-icon-pick', data: { id: c.id, value: '' } }) : '';
    return { title: 'Icon', width: 272, body: `<div class="tx-icons" role="group" aria-label="${esc('Icon')}">${items}</div>`, foot: reset };
  };
  function changeLook(c, patch, msg) {
    const snap = snapTax();
    Object.assign(c, patch); if (!patch.icon && 'icon' in patch) delete c.icon;
    audit('Edited a concept', conceptName(c.id));
    refresh();
    toast(msg, { action: undoTax(snap) });
  }
  A['tx-icon-pick'] = el => {
    const c = conceptById(el.dataset.id), icon = el.dataset.value;
    closePopover(true);
    if (c && admin() && (c.icon || '') !== icon) changeLook(c, { icon: icon || undefined }, icon ? 'Icon changed' : 'Uses the broader concept’s icon');
  };
  A['tx-color'] = el => { const c = conceptById(el.dataset.id), color = el.dataset.value; if (c && admin() && (c.color || '').toLowerCase() !== color) changeLook(c, { color }, 'Color changed'); };
  const colorSec = c => sec('Color', swatchPicker({ value: (c.color || '').toLowerCase(), options: DOMAIN_COLORS.map(([v, l]) => [v, l, v]), act: 'tx-color', data: { id: c.id }, label: 'Concept color' }),
    { desc: esc('Concepts under it use it too: in this list, on document tags and in Browse.') });

  /* ── Retired: what replaced it; an unpublished retirement can be taken back ── */
  function retiredNote(c) {
    const by = (c.replacedBy || []).filter(conceptById);
    const pending = pendingChanges(c.scheme).some(x => x.concept === c.id && ['deprecated', 'merged', 'split'].includes(x.kind));
    const text = by.length ? `<span>${esc('Replaced by')}</span> ${by.map(id => `<a class="link" href="#${taxonomyHref(c.scheme, { node: id })}" translate="no">${esc(conceptName(id))}</a>`).join(', ')}.` : `<span>${esc('Retired without a replacement.')}</span>`;
    const when = pending ? ` <span>${esc('Takes effect when you publish.')}</span>` : '';
    return alertBox('default', '', text + when, pending && admin() ? btn('Restore', { icon: 'undo', act: 'tx-restore', data: { id: c.id } }) : '', { icon: 'archive' });
  }
  A['tx-restore'] = el => {
    const c = conceptById(el.dataset.id); if (!c || !admin()) return;
    const snap = snapTax(), s = schemeById(c.scheme);
    c.state = 'published'; c.replacedBy = [];
    s.changes = (s.changes || []).filter(x => !(x.concept === c.id && ['deprecated', 'merged', 'split'].includes(x.kind)));
    audit('Restored a concept', conceptName(c.id)); refresh();
    toast(`Restored “${conceptName(c.id)}”`, { action: undoTax(snap) });
  };

  /* ── Definition and scope note: applied when the person leaves the field ── */
  const TEXTS = {
    definition: { title: 'Definition', id: 'tx-def', rows: 3, kind: 'definition', desc: 'What it means. People see it when they pick a concept; the assistant reads it. Needed to publish.', placeholder: 'What this concept covers, in a sentence or two' },
    scope: { title: 'Scope', id: 'tx-scope', rows: 2, kind: 'scope note', desc: 'Where its edges are, for borderline documents.', placeholder: 'Includes … / Excludes …' },
  };
  function textSec(c, key, ro) {
    const t = TEXTS[key], v = c[key] || '';
    if (ro) return sec(t.title, v ? `<p class="tx-text" translate="no">${esc(v)}</p>` : emptyLine('Not set'));
    return sec(t.title, textarea({ id: t.id, value: v, rows: t.rows, placeholder: t.placeholder, attrs: `maxlength="1000" aria-labelledby="${t.id}-h" data-blur="tx-text" data-id="${esc(c.id)}" data-key="${key}"` }), { id: `${t.id}-h`, desc: esc(t.desc) });
  }
  A['tx-text'] = el => {
    const c = conceptById(el.dataset.id), key = el.dataset.key, v = String(el.value || '').trim();
    if (!c || !TEXTS[key] || (c[key] || '') === v) return;
    apply(c, 'redefined', '', key === 'scope' ? 'Scope note updated' : 'Definition updated', x => { x[key] = v; });
  };

  /* ── Labels: preferred per language, alternative and hidden chips with their language ── */
  const LBL = id => { if (S.ui.txLbl?.id !== id) S.ui.txLbl = { id }; return S.ui.txLbl; };
  function labelsSec(s, c, ro) {
    const lang = schemeLang(s.id), other = otherLang(lang), f = LBL(c.id);
    const chip = (kind, l, removable) => `<span class="tx-chip"><span class="tx-chip__lang" translate="no">${esc(l)}</span><span class="tx-chip__text" translate="no">${esc(kind === 'pref' ? c.pref[l] : '')}</span>${removable ? `<button type="button" class="tx-chip__x" data-act="tx-label-rm" data-id="${esc(c.id)}" data-kind="pref" data-lang="${l}" aria-label="${esc(`Remove ${c.pref[l]}`)}">${ic('x', 'i-xs')}</button>` : ''}</span>`;
    const listChip = (kind, [l, text], i) => `<span class="tx-chip"><span class="tx-chip__lang" translate="no">${esc(l)}</span><span class="tx-chip__text" translate="no">${esc(text)}</span>${ro ? '' : `<button type="button" class="tx-chip__x" data-act="tx-label-rm" data-id="${esc(c.id)}" data-kind="${kind}" data-i="${i}" aria-label="${esc(`Remove ${text}`)}">${ic('x', 'i-xs')}</button>`}</span>`;
    const adder = (kind, placeholder, withLang) => (ro ? '' : `<span class="tx-add">${input({ id: `tx-${kind}-in`, bind: `txLbl.${kind}`, value: f[kind] || '', placeholder, size: 'sm', onEnter: 'tx-label-add', cls: 'tx-add__input', attrs: `data-id="${esc(c.id)}" data-kind="${kind}" aria-label="${esc(placeholder)}" spellcheck="false" maxlength="255"` })}${withLang ? select({ id: `tx-${kind}-lang`, bind: `txLbl.${kind}Lang`, value: f[`${kind}Lang`] || lang, options: LANG_OPTIONS, size: 'sm', label: 'Language', cls: 'tx-add__lang' }) : ''}${iconBtn('plus', 'Add', { size: 'sm', act: 'tx-label-add', data: { id: c.id, kind } })}</span>`);
    const langs = Object.keys(c.pref || {});
    const pref = [lang, ...langs.filter(l => l !== lang)].filter(l => c.pref?.[l]).map(l => chip('pref', l, !ro && l !== lang)).join('') + (c.pref?.[other] ? '' : adder('pref', other === 'en' ? 'English name' : 'Vietnamese name', false));
    const row = (label, desc, body) => `<div class="tx-labels__row"><div class="tx-labels__kind"><span class="medium">${esc(label)}</span><span class="tx-labels__hint">${esc(desc)}</span></div><div class="tx-labels__chips">${body}</div></div>`;
    const alt = (c.alt || []).map((x, i) => listChip('alt', x, i)).join(''), hidden = (c.hidden || []).map((x, i) => listChip('hidden', x, i)).join('');
    return sec('Labels', `<div class="tx-labels">${row('Preferred', 'Its name, one per language', pref)}${row('Alternative', 'Other names people use', alt + adder('alt', 'Add a label', true) || `<span class="muted">${esc('None')}</span>`)}${row('Hidden', 'Misspellings and abbreviations: found, never shown', hidden + adder('hidden', 'Add a hidden label', true) || `<span class="muted">${esc('None')}</span>`)}</div>`,
      { desc: esc('Classification and search recognise a concept by every one of its labels.') });
  }
  A['tx-label-add'] = el => {
    const c = conceptById(el.dataset.id), kind = el.dataset.kind; if (!c || !admin()) return;
    const f = LBL(c.id), text = clean(f[kind]), lang = kind === 'pref' ? otherLang(schemeLang(c.scheme)) : f[`${kind}Lang`] || schemeLang(c.scheme);
    if (!text) { $(`#tx-${kind}-in`)?.focus(); return; }
    if (conceptLabels(c).some(l => l.lang === lang && normLabel(l.text) === normLabel(text))) { toast(`“${text}” is already a label of ${conceptName(c.id)}`, { tone: 'accent' }); return; }
    f[kind] = '';
    apply(c, 'relabeled', text, `Added “${text}”`, x => { if (kind === 'pref') x.pref = { ...(x.pref || {}), [lang]: text }; else (x[kind] ||= []).push([lang, text]); });
    requestAnimationFrame(() => $(`#tx-${kind === 'pref' ? 'alt' : kind}-in`)?.focus());
  };
  A['tx-label-rm'] = el => {
    const c = conceptById(el.dataset.id), kind = el.dataset.kind; if (!c) return;
    const text = kind === 'pref' ? c.pref?.[el.dataset.lang] : c[kind]?.[+el.dataset.i]?.[1];
    if (!text) return;
    apply(c, 'relabeled', '', `Removed “${text}”`, x => { if (kind === 'pref') { x.pref = { ...x.pref }; delete x.pref[el.dataset.lang]; } else x[kind] = x[kind].filter((_, i) => i !== +el.dataset.i); });
  };

  /* ── Relations: broader (several) and related ── */
  function relationsSec(s, c, ro) {
    const desc = new Set(descendantsOf(c.id)), anc = new Set(ancestorsOf(c.id)), rel = relatedOf(c);
    const chipOf = (id, kind) => { const o = conceptById(id), cross = o && o.scheme !== c.scheme; return `<span class="tx-chip"><span class="tx-chip__text" translate="no"><a class="link" href="#${taxonomyHref(o?.scheme, { node: id })}">${esc(conceptName(id))}</a>${cross ? `<span class="muted"> · ${esc(schemeName(o.scheme))}</span>` : ''}</span>${ro ? '' : `<button type="button" class="tx-chip__x" data-act="tx-rel-rm" data-id="${esc(c.id)}" data-rel="${kind}" data-target="${esc(id)}" aria-label="${esc(`Remove ${conceptName(id)}`)}">${ic('x', 'i-xs')}</button>`}</span>`; };
    const pick = (kind, cands, label) => (ro || !cands.length ? '' : select({ id: `tx-${kind}-add`, value: '', options: [['', label], ...cands.map(o => [o.id, conceptPathText(o.id)])], change: 'tx-rel-add', size: 'sm', label, cls: 'tx-add__pick', attrs: `data-id="${esc(c.id)}" data-rel="${kind}"` }));
    const broaderC = conceptsOf(s.id).filter(o => o.id !== c.id && !desc.has(o.id) && !(c.broader || []).includes(o.id));
    const relatedC = conceptsOf(s.id).filter(o => o.id !== c.id && !desc.has(o.id) && !anc.has(o.id) && !rel.includes(o.id));
    const broader = (c.broader || []).filter(conceptById).map(id => chipOf(id, 'broader')).join('');
    const related = rel.map(id => chipOf(id, 'related')).join('');
    const row = (label, desc2, body) => `<div class="tx-labels__row"><div class="tx-labels__kind"><span class="medium">${esc(label)}</span><span class="tx-labels__hint">${esc(desc2)}</span></div><div class="tx-labels__chips">${body}</div></div>`;
    return sec('Relations', `<div class="tx-labels">${row('Broader', 'It sits under each of these', (broader || `<span class="muted">${esc('None: a top concept')}</span>`) + pick('broader', broaderC, 'Add a broader concept…'))}${row('Related', 'Close in meaning, neither above nor below', (related || (ro ? `<span class="muted">${esc('None')}</span>` : '')) + pick('related', relatedC, 'Add a related concept…'))}</div>`);
  }
  A['tx-rel-add'] = el => {
    const c = conceptById(el.dataset.id), to = el.value, kind = el.dataset.rel; if (!c || !conceptById(to)) return;
    if (kind === 'broader') apply(c, 'moved', conceptName(to), `Now also under ${conceptName(to)}`, x => { x.broader = uniq([...(x.broader || []), to]); });
    else apply(c, 'redefined', '', `Related to ${conceptName(to)}`, x => { x.related = uniq([...(x.related || []), to]); });
  };
  A['tx-rel-rm'] = el => {
    const c = conceptById(el.dataset.id), to = el.dataset.target, kind = el.dataset.rel; if (!c) return;
    if (kind === 'broader') apply(c, 'moved', (c.broader || []).filter(b => b !== to).map(conceptName).join(', '), `No longer under ${conceptName(to)}`, x => { x.broader = (x.broader || []).filter(b => b !== to); });
    else apply(c, 'redefined', '', `No longer related to ${conceptName(to)}`, x => { x.related = (x.related || []).filter(r => r !== to); const o = conceptById(to); if (o) o.related = (o.related || []).filter(r => r !== x.id); });
  };

  /* ── Mappings: system · code · label · match ── */
  const MAP = id => { if (S.ui.txMap?.id !== id) S.ui.txMap = { id, open: false, system: '', code: '', label: '', match: 'exact', err: '' }; return S.ui.txMap; };
  function mappingsSec(c, ro) {
    const f = MAP(c.id), maps = c.mappings || [];
    const rows = maps.map(([system, code, label, match], i) => `<li class="tx-map"><span class="tx-map__sys" translate="no">${esc(system)}</span><span class="tx-map__code" translate="no">${esc(code)}</span><span class="tx-map__label" translate="no">${esc(label || '')}</span>${chip(MATCH.find(m => m[0] === match)?.[1] || match, { size: 'sm' })}${ro ? '' : iconBtn('x', 'Remove mapping', { size: 'sm', act: 'tx-map-rm', data: { id: c.id, i } })}</li>`).join('');
    const form = !ro && f.open ? `<div class="tx-map-form">${input({ id: 'tx-map-sys', bind: 'txMap.system', value: f.system, placeholder: 'System, e.g. moet-program', size: 'sm', attrs: `aria-label="${esc('System')}" spellcheck="false" data-autofocus` })}${input({ id: 'tx-map-code', bind: 'txMap.code', value: f.code, placeholder: 'Code', size: 'sm', onEnter: 'tx-map-add', attrs: `aria-label="${esc('Code')}" spellcheck="false" data-id="${esc(c.id)}"` })}${input({ id: 'tx-map-label', bind: 'txMap.label', value: f.label, placeholder: 'Label (optional)', size: 'sm', onEnter: 'tx-map-add', attrs: `aria-label="${esc('Label')}" data-id="${esc(c.id)}"` })}${select({ id: 'tx-map-match', bind: 'txMap.match', value: f.match, options: MATCH, size: 'sm', label: 'Match' })}${btn('Add', { v: 'secondary', size: 'sm', act: 'tx-map-add', data: { id: c.id } })}${btn('Cancel', { v: 'ghost', size: 'sm', act: 'tx-map-cancel' })}</div>${f.err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : ''}` : '';
    const add = !ro && !f.open ? btn('Add mapping', { v: 'ghost', size: 'sm', icon: 'plus', act: 'tx-map-open' }) : '';
    return sec('Mappings', `${rows ? `<ul class="tx-maps">${rows}</ul>` : ro ? emptyLine('None') : ''}${form}${add}`, { desc: esc('The same idea in an outside list, such as a ministry code.') });
  }
  A['tx-map-open'] = () => { S.ui.txMap.open = true; refresh(); };
  A['tx-map-cancel'] = () => { Object.assign(S.ui.txMap, { open: false, err: '' }); refresh(); };
  A['tx-map-add'] = el => {
    const c = conceptById(el.dataset.id), f = S.ui.txMap; if (!c || !f) return;
    const system = clean(f.system).toLowerCase(), code = clean(f.code), label = clean(f.label);
    f.err = !system || !code ? 'Enter a system and a code.' : (c.mappings || []).some(m => m[0] === system && m[1] === code) ? 'It already has this mapping.' : '';
    if (f.err) { refresh(); return; }
    Object.assign(f, { open: false, system: '', code: '', label: '' });
    apply(c, 'redefined', '', `Mapped to ${system} ${code}`, x => { x.mappings = [...(x.mappings || []), [system, code, label, f.match || 'exact']]; });
  };
  A['tx-map-rm'] = el => { const c = conceptById(el.dataset.id); if (c) apply(c, 'redefined', '', 'Mapping removed', x => { x.mappings = x.mappings.filter((_, i) => i !== +el.dataset.i); }); };

  /* ── Recognition patterns (document types): regular expressions over the title and number ── */
  const PAT = id => { if (S.ui.txPat?.id !== id) S.ui.txPat = { id, v: '', err: '' }; return S.ui.txPat; };
  function patternsSec(c, ro) {
    const f = PAT(c.id), pats = c.patterns || [];
    const chips = pats.map((p, i) => `<span class="tx-chip tx-chip--code"><code class="tx-chip__text">${esc(p)}</code>${ro ? '' : `<button type="button" class="tx-chip__x" data-act="tx-pat-rm" data-id="${esc(c.id)}" data-i="${i}" aria-label="${esc(`Remove ${p}`)}">${ic('x', 'i-xs')}</button>`}</span>`).join('');
    const add = ro || pats.length >= 20 ? '' : `<span class="tx-add">${input({ id: 'tx-pat-in', bind: 'txPat.v', value: f.v, placeholder: 'e.g. /QĐ- or ^QUY CHẾ', size: 'sm', onEnter: 'tx-pat-add', cls: 'tx-add__input tx-add__input--code', invalid: !!f.err, attrs: `data-id="${esc(c.id)}" aria-label="${esc('Add a pattern')}" spellcheck="false" maxlength="200"` })}${iconBtn('plus', 'Add', { size: 'sm', act: 'tx-pat-add', data: { id: c.id } })}</span>`;
    const err = f.err ? `<div class="field-error" id="tx-pat-in-err" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : '';
    return sec('Recognition patterns', `<div class="tx-labels__chips">${chips || (ro ? `<span class="muted">${esc('None')}</span>` : '')}${add}</div>${err}`,
      { desc: esc('A title or document number that matches one of these is this type, without asking the assistant.') });
  }
  A['tx-pat-add'] = el => {
    const c = conceptById(el.dataset.id), f = S.ui.txPat; if (!c || !f) return;
    const v = String(f.v || '').trim(); if (!v) return;
    let ok = true; try { new RegExp(v, 'iu'); } catch { ok = false; }
    f.err = !ok ? 'This isn’t a valid pattern.' : (c.patterns || []).includes(v) ? 'It already has this pattern.' : '';
    if (f.err) { refresh(); requestAnimationFrame(() => $('#tx-pat-in')?.focus()); return; }
    f.v = '';
    apply(c, 'redefined', '', `Added pattern ${v}`, x => { x.patterns = [...(x.patterns || []), v]; });
  };
  A['tx-pat-rm'] = el => { const c = conceptById(el.dataset.id); if (c) apply(c, 'redefined', '', 'Pattern removed', x => { x.patterns = x.patterns.filter((_, i) => i !== +el.dataset.i); }); };

  /* ── Rules that file documents here (read-only: they belong to collections and sources) ── */
  function rulesSec(c) {
    const rules = rulesFor(c.id); if (!rules.length) return '';
    const li = r => `<li class="tx-rulex"><span class="tx-rulex__eff">${esc(r.effect === 'implies' ? 'Always' : 'More likely')}</span><span>${esc(ruleText(r))}</span></li>`;
    return sec('Rules', `<ul class="tx-rulexs">${rules.map(li).join('')}</ul>`, { desc: esc('“Always” settles it without asking the assistant; “More likely” only tips the balance.') });
  }

  /* ═══════════════ New concept · concept ⋯ (merge, split, retire, delete draft) ═══════════════ */
  const NEWF = () => ui('txNew');
  function openNew(sid, broader = '') {
    if (!admin() || !schemeById(sid)) return;
    S.ui.txNew = { scheme: sid, name: '', broader, definition: '', tried: false };
    openModal('tx-new', {});
  }
  A['tx-new'] = el => openNew(el.dataset.scheme || curScheme()?.id, el.dataset.broader || '');
  const newErr = f => { const name = clean(f.name); return !name ? 'Enter a name.' : nameClash(f.scheme, name); };
  M['tx-new'] = () => {
    const f = NEWF(), s = schemeById(f.scheme), err = f.tried ? newErr(f) : '';
    const parents = conceptsOf(s.id).filter(c => depthOf(c) < (s.maxDepth || 9)).map(c => [c.id, conceptPathText(c.id)]);
    return {
      size: 'sm', icon: 'plus', title: 'New concept', desc: esc(`A draft in ${s.name}. Documents are classified with it once you publish.`),
      body: field({ id: 'tx-new-name', label: 'Name', required: true, error: err, control: input({ id: 'tx-new-name', bind: 'txNew.name', value: f.name, autofocus: true, onEnter: 'tx-create', invalid: !!err, attrs: 'maxlength="120"' }) })
        + field({ id: 'tx-new-broader', label: 'Under', control: select({ id: 'tx-new-broader', bind: 'txNew.broader', value: f.broader, options: [['', 'Nothing: a top concept'], ...parents] }) })
        + field({ id: 'tx-new-def', label: 'Definition', optional: true, desc: esc('Needed before you publish.'), control: textarea({ id: 'tx-new-def', bind: 'txNew.definition', value: f.definition, rows: 2, attrs: 'maxlength="1000"' }) }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Create draft', { v: 'primary', icon: 'plus', act: 'tx-create' }),
    };
  };
  A['tx-create'] = () => {
    const f = NEWF(); if (!f || !admin()) return;
    f.tried = true;
    if (newErr(f)) { refreshLayer(); $('#tx-new-name')?.focus(); return; }
    const s = schemeById(f.scheme), name = clean(f.name), lang = schemeLang(s.id), snap = snapTax(), top = !f.broader;
    const c = { id: uid('c'), scheme: s.id, notation: newNotation(s.id, name), pref: { [lang]: name }, alt: [], hidden: [], definition: String(f.definition || '').trim(), scope: '', examples: [],
      broader: top ? [] : [f.broader], related: [], mappings: [], patterns: [], state: 'draft', replacedBy: [],
      ...(top ? { color: freeDomainColor(rootsOf(s.id).map(x => x.color)), icon: schemeIcon(s.id) } : {}) };
    D.concepts = [...(D.concepts || []), c];
    noteChange(s.id, 'added', c.id, name);
    audit('Added a concept', `${s.name} · ${name}`);
    closeModal();
    if (f.broader) TREE(s.id).closed[f.broader] = false;
    showNode(c.id);
    toast(`Created “${name}” as a draft`, { action: undoTax(snap, () => setQuery({ node: f.broader || '' })) });
  };

  MENUS['tx-concept-more'] = el => {
    const c = conceptById(el.dataset.id); if (!c || !admin() || conceptState(c) === 'deprecated') return [];
    const s = schemeById(c.scheme), under = depthOf(c) < (s?.maxDepth || 9) ? [{ label: 'Add a concept under it', icon: 'plus', run: () => openNew(c.scheme, c.id) }] : [];
    if (conceptState(c) === 'draft') return [...under, { sep: true }, { label: 'Delete draft', icon: 'trash', danger: true, run: () => deleteDraft(c) }];
    return [...under,
      { label: 'Merge into…', icon: 'git-compare', run: () => openReplace(c, 'merge') },
      { label: 'Split…', icon: 'list-tree', run: () => openReplace(c, 'split') },
      { sep: true },
      { label: 'Retire', icon: 'archive', danger: true, run: () => retire(c) }];
  };
  function retire(c) {
    const n = kidsIn(c.scheme, c.id).length;
    apply(c, 'deprecated', '', n ? `Retired “${conceptName(c.id)}” · move its ${plural(n, 'narrower concept')} before you publish` : `Retired “${conceptName(c.id)}” · takes effect when you publish`, x => { x.state = 'deprecated'; x.replacedBy = []; });
  }
  /** A draft was never published: it goes for good (its notation stays reserved in the backend); concepts under it move up. */
  function deleteDraft(c) {
    if (!admin()) return;
    const snap = snapTax(), s = schemeById(c.scheme), up = parentsIn(c)[0] || '', name = conceptName(c.id);
    D.concepts = D.concepts.filter(x => x.id !== c.id).map(x => ({ ...x, broader: (x.broader || []).filter(b => b !== c.id), related: (x.related || []).filter(r => r !== c.id) }));
    s.changes = (s.changes || []).filter(x => x.concept !== c.id);
    audit('Deleted a draft concept', `${s.name} · ${name}`);
    setQuery({ node: up });
    toast(`Deleted “${name}”`, { action: undoTax(snap, () => setQuery({ node: c.id })) });
  }
  /* Merge into one concept, or split into several: the concept is retired and replaced; its documents follow on publish. */
  const REP = () => ui('txRep');
  function openReplace(c, mode) { S.ui.txRep = { id: c.id, mode, into: '', picks: {}, keep: true, err: '' }; openModal('tx-replace', {}); }
  M['tx-replace'] = () => {
    const f = REP(), c = conceptById(f.id); if (!c) return { title: 'Missing concept', body: '' };
    const desc = new Set(descendantsOf(c.id)), cands = conceptsOf(c.scheme).filter(o => o.id !== c.id && !desc.has(o.id));
    const name = conceptName(c.id), merge = f.mode === 'merge';
    const err = f.err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : '';
    const body = merge
      ? field({ id: 'tx-rep-into', label: 'Merge into', control: select({ id: 'tx-rep-into', bind: 'txRep.into', value: f.into, options: [['', 'Choose a concept'], ...cands.map(o => [o.id, conceptPathText(o.id)])] }) }) + err
        + checkbox({ checked: f.keep, act: 'tx-rep-keep', label: esc('Keep its name as an alternative label there') })
      : `<div class="field"><span class="label">${esc('Split into')}</span><ul class="tx-picklist" aria-label="${esc('Split into')}">${cands.map(o => `<li>${checkbox({ checked: !!f.picks[o.id], act: 'tx-rep-pick', data: { id: o.id }, label: `<span translate="no">${esc(conceptPathText(o.id))}</span>` })}</li>`).join('')}</ul>${err}<p class="description">${esc('Pick two or more. Add the new concepts first if they don’t exist yet.')}</p></div>`;
    return {
      size: 'md', icon: merge ? 'git-compare' : 'list-tree', title: merge ? `Merge “${name}”` : `Split “${name}”`,
      desc: esc(merge ? 'It’s retired and its documents move to the concept you pick when you publish. No document is classified again.' : 'It’s retired, and when you publish its documents are classified again among the concepts you pick.'),
      body: `<div class="stack gap-12">${body}</div>`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(merge ? 'Merge' : 'Split', { v: 'primary', act: 'tx-rep-go' }),
    };
  };
  A['tx-rep-keep'] = () => { REP().keep = !REP().keep; refreshLayer(); };
  A['tx-rep-pick'] = el => { const f = REP(); f.picks[el.dataset.id] = !f.picks[el.dataset.id]; f.err = ''; refreshLayer(); };
  A['tx-rep-go'] = () => {
    const f = REP(), c = conceptById(f.id); if (!c || !admin()) return;
    const targets = f.mode === 'merge' ? [f.into].filter(conceptById) : Object.keys(f.picks).filter(id => f.picks[id] && conceptById(id));
    f.err = f.mode === 'merge' ? (targets.length ? '' : 'Choose the concept to merge into.') : targets.length < 2 ? 'Pick at least two concepts.' : '';
    if (f.err) { refreshLayer(); return; }
    const snap = snapTax(), name = conceptName(c.id), names = targets.map(conceptName).join(', '), lang = schemeLang(c.scheme);
    c.state = 'deprecated'; c.replacedBy = targets;
    note(c.scheme, f.mode === 'merge' ? 'merged' : 'split', c.id, names);
    if (f.mode === 'merge' && f.keep) {
      const t = conceptById(targets[0]);
      if (!conceptLabels(t).some(l => normLabel(l.text) === normLabel(name))) { t.alt = [...(t.alt || []), [lang, name]]; note(t.scheme, 'relabeled', t.id, name); }
    }
    audit(f.mode === 'merge' ? 'Merged a concept' : 'Split a concept', `${name} → ${names}`);
    closeModal(); refresh();
    toast(f.mode === 'merge' ? `Merged “${name}” into ${names} · takes effect when you publish` : `Split “${name}” into ${names} · takes effect when you publish`, { action: undoTax(snap) });
  };

  /* ═══════════════ Publish ═══════════════ */
  /** What publishing would refuse (errors) and flag (warnings) — the validator's view of the working copy. */
  function checkScheme(s) {
    const live = conceptsOf(s.id), changed = new Set(pendingChanges(s.id).map(x => x.concept)), errors = [], warnings = [];
    const err = (id, text) => errors.push({ id, text });
    live.forEach(c => {
      if ((conceptState(c) === 'draft' || changed.has(c.id)) && !clean(c.definition)) err(c.id, 'has no definition');
      if (inCycle(c)) err(c.id, 'is its own ancestor: its broader concepts lead back to it');
      else { const d = depthOf(c); if (s.maxDepth && d > s.maxDepth) err(c.id, `is ${d} levels deep (${s.name} allows ${s.maxDepth})`); }
      (c.broader || []).filter(b => conceptState(conceptById(b)) === 'deprecated').forEach(b => err(c.id, `is under ${conceptName(b)}, which is retired`));
      relatedOf(c).forEach(r => { if (c.id < r && (ancestorsOf(c.id).includes(r) || ancestorsOf(r).includes(c.id))) err(c.id, `is related to ${conceptName(r)}, which is above or below it`); });
    });
    retiredOf(s.id).forEach(c => { if ((c.replacedBy || []).some(t => !conceptById(t) || conceptState(conceptById(t)) === 'deprecated')) err(c.id, 'is replaced by a concept that is retired or missing'); });
    const dups = labelGroups(s.id).length;
    if (dups) warnings.push({ text: `${plural(dups, 'label')} shared by two or more concepts`, act: 'conflicts' });
    const noScope = live.filter(c => (conceptState(c) === 'draft' || changed.has(c.id)) && !clean(c.scope));
    if (noScope.length) warnings.push({ text: 'No scope note:', names: noScope.map(c => conceptName(c.id)).join(', ') });
    const tops = rootsOf(s.id).length;
    if (tops > 20) warnings.push({ text: `${fmtNum(tops)} top concepts; 8–20 are easier to browse` });
    return { errors, warnings };
  }
  /** What publishing does to documents: merges remap assignments (no model); splits, new concepts under a parent and retired
      concepts without a replacement classify that scheme again for the documents concerned (people's choices stay). */
  function impactOf(s) {
    const ch = pendingChanges(s.id);
    const merged = uniq(ch.filter(x => x.kind === 'merged').map(x => x.concept)).filter(id => { const c = conceptById(id); return conceptState(c) === 'deprecated' && (c.replacedBy || []).length === 1; });
    const remapDocs = D.docs.filter(d => (d.concepts || []).some(a => a.state !== 'rejected' && merged.includes(a.id)));
    const split = uniq(ch.filter(x => x.kind === 'split').map(x => x.concept));
    const retired = uniq(ch.filter(x => x.kind === 'deprecated').map(x => x.concept)).filter(id => conceptState(conceptById(id)) === 'deprecated');
    const parents = uniq(conceptsOf(s.id).filter(c => conceptState(c) === 'draft').flatMap(parentsIn));
    const thresholds = ch.some(x => x.kind === 'thresholds');
    const watch = new Set([...split, ...retired, ...parents]);
    const affected = reclassifiable(s.id).filter(d => thresholds || (d.concepts || []).some(a => a.state !== 'rejected' && watch.has(a.id)));
    // The version's reclassification.rerank: a split's documents choose among its targets; a parent's documents among the
    // children it has once the drafts are published (they keep the parent when none fits). Retired concepts and new
    // thresholds classify the whole scheme again.
    const rerank = thresholds ? [] : [
      ...split.map(id => ({ concept: id, among: conceptById(id)?.replacedBy || [], required: true })),
      ...parents.map(id => ({ concept: id, among: kidsIn(s.id, id).map(c => c.id) })),
    ];
    const open = D.docs.filter(d => !d.archived && stageOf(d) === 'review' && d.ai?.status === 'done').length;
    return { merged, remapDocs, affected, rerank, open };
  }
  A['tx-publish'] = el => { const s = schemeById(el.dataset.scheme); if (!s || !admin() || !pendingChanges(s.id).length) return; S.ui.txPub = { note: '' }; openModal('tx-publish', { scheme: s.id }); };
  M['tx-publish'] = ({ scheme }) => {
    const s = schemeById(scheme); if (!s) return { title: 'Missing scheme', body: '' };
    const chk = checkScheme(s), imp = impactOf(s), ch = pendingChanges(s.id), v = (s.version || 0) + 1;
    const issue = x => `<li><button type="button" class="link" data-act="tx-pub-go" data-id="${esc(x.id)}" translate="no">${esc(conceptName(x.id))}</button> <span>${esc(x.text)}</span></li>`;
    const errors = chk.errors.length ? alertBox('danger', chk.errors.length === 1 ? 'Fix this before publishing' : `Fix these ${fmtNum(chk.errors.length)} problems before publishing`, `<ul class="tx-issues">${chk.errors.map(issue).join('')}</ul>`) : '';
    const warn = x => `<li><span>${esc(x.text)}</span>${x.names ? ` <span translate="no">${esc(x.names)}</span>` : ''}${x.act === 'conflicts' ? ` <button type="button" class="link" data-act="tx-pub-conflicts" data-scheme="${esc(s.id)}">${esc('View')}</button>` : ''}</li>`;
    const warnings = chk.warnings.length ? alertBox('warning', 'Worth a look', `<ul class="tx-issues">${chk.warnings.map(warn).join('')}</ul>`) : '';
    const remapped = imp.remapDocs.length, again = imp.affected.length;
    const effects = [
      remapped && `${fmtNum(remapped)} assignments remapped`,
      again && `${fmtNum(again)} documents will be classified again`,
      imp.open && `${plural(imp.open, 'submission')} in review classified again`,
      !remapped && !again && 'No document is classified again: names, labels and definitions apply as they are.',
    ].filter(Boolean);
    const impact = `<div class="tx-impact">${ic('sparkles', 'i-sm')}<ul>${effects.map(t => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
    const changeRow = x => `<li class="tx-change">${chip(KIND[x.kind] || x.kind, { size: 'sm', tone: ['deprecated', 'merged', 'split'].includes(x.kind) ? 'warning' : x.kind === 'added' ? 'success' : 'default' })}<span class="medium truncate" translate="no">${esc(conceptName(x.concept))}</span>${x.text ? `<span class="muted truncate" translate="no">${esc(x.text)}</span>` : ''}</li>`;
    const list = `<section class="tx-changes"><h3 class="tx-changes__title">${esc(`Changes (${fmtNum(ch.length)})`)}</h3><ul class="tx-changes__list">${ch.map(changeRow).join('')}</ul></section>`;
    const noteField = field({ id: 'tx-pub-note', label: 'Note', optional: true, control: input({ id: 'tx-pub-note', bind: 'txPub.note', value: S.ui.txPub?.note || '', placeholder: 'What changed and why', attrs: 'maxlength="200"' }) });
    const blocked = chk.errors.length > 0;
    return {
      size: 'lg', icon: 'upload', title: `Publish ${s.name}`, desc: esc(`Version ${v}. Classification and search start using it at once.`),
      body: `<div class="stack gap-16">${errors}${warnings}${impact}${list}${noteField}</div>`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(`Publish version ${v}`, { v: 'primary', icon: 'upload', act: 'tx-publish-go', disabled: blocked, tip: blocked ? 'Fix the problems above first' : '' }),
    };
  };
  A['tx-pub-go'] = el => { const c = conceptById(el.dataset.id); closeModal(); if (c) go(taxonomyHref(c.scheme, { node: c.id })); };
  A['tx-pub-conflicts'] = el => { closeModal(); go(taxonomyHref(el.dataset.scheme, { conflicts: 1 })); };
  A['tx-publish-go'] = () => {
    const s = schemeById(S.modal?.props?.scheme); if (!s || !admin()) return;
    if (checkScheme(s).errors.length) return;
    const imp = impactOf(s), changes = clone(pendingChanges(s.id)), v = (s.version || 0) + 1;
    const snap = { tax: snapTax(), version: s.version, versions: clone(s.versions || []), docs: imp.remapDocs.map(d => [d, snapDoc(d)]) };
    conceptsOf(s.id).filter(c => conceptState(c) === 'draft').forEach(c => { c.state = 'published'; });
    imp.merged.forEach(id => remapConcept(id, conceptById(id).replacedBy[0]));
    s.versions = [{ v, at: Date.now(), by: me().id, note: clean(S.ui.txPub?.note), changes: changes.length, list: changes }, ...(s.versions || [])];
    s.version = v; s.changes = [];
    closeModal();
    let rc = null, first = '';
    const undo = { label: 'Undo', run: () => {
      rc?.revert(); restoreTax(snap.tax); s.version = snap.version; s.versions = snap.versions;
      snap.docs.forEach(([d, x]) => restoreDoc(d, x)); reclassifyOpen();
      audit('Undid publishing a scheme', `${s.name} · ${v}`); refresh();
    } };
    const done = `Published ${s.name} version ${v}`;
    if (imp.affected.length) rc = reclassifyScheme(s.id, imp.affected, () => { dismissToast(first); toast(`${done} · ${plural(rc.checked, 'document')} classified again, ${plural(rc.changed.length, 'document')} changed`, { action: undo }); }, { rerank: imp.rerank });
    reclassifyOpen();
    audit('Published a scheme', `${s.name} · ${v}`);
    refresh();
    first = toast(rc ? `${done} · classifying ${plural(rc.checked, 'document')} again…` : imp.remapDocs.length ? `${done} · ${fmtNum(imp.remapDocs.length)} assignments remapped` : done, { action: undo });
  };

  /* ═══════════════ Version history ═══════════════ */
  DR['tx-versions'] = ({ scheme }) => {
    const s = schemeById(scheme); if (!s) return { title: 'Missing scheme', body: '' };
    const pend = pendingChanges(s.id);
    const changeLi = x => `<li class="tx-change">${chip(KIND[x.kind] || x.kind, { size: 'sm' })}<span class="truncate" translate="no">${esc(conceptName(x.concept))}</span>${x.text ? `<span class="muted truncate" translate="no">${esc(x.text)}</span>` : ''}</li>`;
    const unpub = pend.length ? `<li class="tx-ver tx-ver--draft"><div class="tx-ver__head"><span class="medium">${esc('Working copy')}</span>${chip(`${plural(pend.length, 'unpublished change')}`, { size: 'sm', tone: 'accent' })}</div><ul class="tx-changes__list">${pend.map(changeLi).join('')}</ul></li>` : '';
    const vers = [...(s.versions || [])].sort((a, b) => b.v - a.v).map(x => {
      const n = Array.isArray(x.changes) ? x.changes.length : x.changes || 0, list = Array.isArray(x.list) ? x.list : Array.isArray(x.changes) ? x.changes : [];
      return `<li class="tx-ver"><div class="tx-ver__head"><span class="medium">${esc(`Version ${x.v}`)}</span>${x.v === s.version ? chip('Current', { size: 'sm', tone: 'success' }) : ''}</div>
        <div class="tx-ver__meta">${esc(fmtDate(x.at))}${DOT}<span translate="no">${esc(actorName(x.by))}</span>${DOT}${esc(plural(n, 'change'))}</div>${x.note ? `<p class="tx-ver__note" translate="no">${esc(x.note)}</p>` : ''}${list.length ? `<ul class="tx-changes__list">${list.map(changeLi).join('')}</ul>` : ''}</li>`;
    }).join('');
    return {
      size: 'md', title: 'Version history', lead: itemIcon('history', 'accent'), desc: `<span translate="no">${esc(s.name)}</span>`,
      body: unpub || vers ? `<ul class="tx-vers">${unpub}${vers}</ul>` : emptyState({ icon: 'history', title: 'Not published yet', compact: true }),
      foot: btn('Close', { v: 'ghost', act: 'close-drawer' }),
    };
  };

  /* ═══════════════ Duplicate labels (?conflicts=1) ═══════════════ */
  /** Labels (normalized) that two or more concepts of a scheme share: [{ key, ls: [{ c, kind, lang, text }] }]. */
  function labelGroups(sid) {
    const m = new Map();
    conceptsOf(sid).forEach(c => conceptLabels(c).forEach(l => { const k = normLabel(l.text); if (k) (m.get(k) || m.set(k, []).get(k)).push({ c, ...l }); }));
    return [...m].map(([key, ls]) => ({ key, ls })).filter(g => new Set(g.ls.map(x => x.c.id)).size > 1);
  }
  /** Labels of this scheme that concepts of other classification schemes also have: [{ key, text, here: [ids], there: [ids] }]. */
  function crossGroups(sid) {
    if (!isClass(schemeById(sid))) return [];
    const idx = new Map();
    classSchemes().forEach(s => conceptsOf(s.id).forEach(c => conceptLabels(c).forEach(l => { const k = normLabel(l.text); if (k) (idx.get(k) || idx.set(k, []).get(k)).push({ c, text: l.text }); })));
    return [...idx].map(([key, ls]) => ({ key, text: ls.find(x => x.c.scheme === sid)?.text || ls[0].text, here: uniq(ls.filter(x => x.c.scheme === sid).map(x => x.c.id)), there: uniq(ls.filter(x => x.c.scheme !== sid).map(x => x.c.id)) }))
      .filter(g => g.here.length && g.there.length);
  }
  const dupCount = sid => labelGroups(sid).length + crossGroups(sid).length;
  function conflictsView(s) {
    const groups = labelGroups(s.id), cross = crossGroups(s.id);
    const backLink = `<div class="tx-ref">${btn(`Back to ${s.name}`, { v: 'ghost', size: 'sm', icon: 'arrow-left', href: taxonomyHref(s.id) })}</div>`;
    const tag = id => conceptTag(id, { href: taxonomyHref(conceptById(id).scheme, { node: id }) });
    const row = x => {
      const acts = !admin() ? '' : x.kind === 'pref' ? btn('Rename', { v: 'ghost', size: 'sm', icon: 'pencil', href: taxonomyHref(s.id, { node: x.c.id }) })
        : btn('Remove label', { v: 'ghost', size: 'sm', act: 'tx-label-drop', data: { id: x.c.id, kind: x.kind, lang: x.lang, text: x.text } }) + btn('Move label to…', { v: 'ghost', size: 'sm', act: 'tx-label-move', data: { id: x.c.id, kind: x.kind, lang: x.lang, text: x.text } });
      return `<li class="tx-dup__row">${tag(x.c.id)}<span class="tx-dup__kind">${esc(LABEL_KIND[x.kind])}</span><span class="tx-chip__lang" translate="no">${esc(x.lang)}</span><span class="tx-dup__acts">${acts}</span></li>`;
    };
    const inScheme = groups.length ? `<ul class="tx-dups">${groups.map(g => `<li class="tx-dup tx-dup--warn"><div class="tx-dup__label">${ic('alert', 'i-sm')}<span class="medium" translate="no">“${esc(g.ls[0].text)}”</span></div><ul class="tx-dup__rows">${g.ls.map(row).join('')}</ul></li>`).join('')}</ul>`
      : emptyState({ icon: 'check-circle', tone: 'success', title: 'No shared labels in this scheme', compact: true });
    const across = cross.length ? `<ul class="tx-dups">${cross.map(g => `<li class="tx-dup"><div class="tx-dup__label"><span class="medium" translate="no">“${esc(g.text)}”</span></div><div class="tx-dup__tags">${[...g.here, ...g.there].map(id => `<span class="tx-dup__where"><span class="muted" translate="no">${esc(schemeName(conceptById(id).scheme))}</span>${tag(id)}</span>`).join('')}</div></li>`).join('')}</ul>`
      : emptyState({ icon: 'check-circle', tone: 'success', title: 'No label shared with another scheme', compact: true });
    return `${backLink}<div class="tx-conf"><header class="tx-scheme"><div class="tx-scheme__main"><h2 class="tx-scheme__name">${esc('Duplicate labels')}</h2><p class="tx-scheme__desc" translate="no">${esc(s.name)}</p></div></header>
      ${section('In this scheme', inScheme, { desc: esc('Two concepts with the same label split documents and searches between them. Keep it on one.') })}
      ${isClass(s) ? section('Across schemes', across, { desc: esc('Allowed: a search reads the rest of the question to tell which one it means, and groups the results by meaning when it can’t.') }) : ''}</div>`;
  }
  /** Take a label off a concept (or move it to another): both change the working copy. */
  function dropLabel(c, kind, lang, text) { c[kind] = (c[kind] || []).filter(([l, t]) => !(l === lang && t === text)); }
  A['tx-label-drop'] = el => {
    const { id, kind, lang, text } = el.dataset, c = conceptById(id); if (!c || !['alt', 'hidden'].includes(kind)) return;
    apply(c, 'relabeled', '', `Removed “${text}” from ${conceptName(c.id)}`, x => dropLabel(x, kind, lang, text));
  };
  A['tx-label-move'] = el => { const { id, kind, lang, text } = el.dataset; S.ui.txMove = { id, kind, lang, text, to: '', err: '' }; openModal('tx-move-label', {}); };
  M['tx-move-label'] = () => {
    const f = S.ui.txMove, c = conceptById(f?.id); if (!c) return { title: 'Missing concept', body: '' };
    const k = normLabel(f.text), cands = conceptsOf(c.scheme).filter(o => o.id !== c.id && !conceptLabels(o).some(l => normLabel(l.text) === k));
    return {
      size: 'sm', icon: 'tag', title: `Move “${f.text}”`, desc: `<span>${esc('From')}</span> <span translate="no">${esc(conceptName(c.id))}</span>`,
      body: field({ id: 'tx-move-to', label: 'Move to', error: f.err, control: select({ id: 'tx-move-to', bind: 'txMove.to', value: f.to, options: [['', 'Choose a concept'], ...cands.map(o => [o.id, conceptPathText(o.id)])] }) }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Move label', { v: 'primary', act: 'tx-move-go' }),
    };
  };
  A['tx-move-go'] = () => {
    const f = S.ui.txMove, c = conceptById(f?.id), t = conceptById(f?.to); if (!c || !admin()) return;
    if (!t) { f.err = 'Choose a concept.'; refreshLayer(); return; }
    const snap = snapTax();
    dropLabel(c, f.kind, f.lang, f.text); t[f.kind] = [...(t[f.kind] || []), [f.lang, f.text]];
    note(c.scheme, 'relabeled', c.id, ''); note(t.scheme, 'relabeled', t.id, f.text);
    audit('Moved a label', `${f.text}: ${conceptName(c.id)} → ${conceptName(t.id)}`);
    closeModal(); refresh();
    toast(`Moved “${f.text}” to ${conceptName(t.id)}`, { action: undoTax(snap) });
  };

  /* ═══════════════ Suggestions ═══════════════ */
  const SUG = () => ui('txSug', { scheme: '', open: {}, done: {} });
  const ORIGIN = { cluster: ['Grouped from unclassified documents', 'layers'], correction: ['From reviewers’ corrections', 'pencil'], member: ['Suggested by a member', 'user'] };
  const decides = () => (admin() ? '' : `<span class="t-xs muted">${esc('A workspace admin decides')}</span>`);
  function suggestionsView() {
    const u = SUG(); if (u.scheme && !schemeById(u.scheme)) u.scheme = '';
    const filter = classSchemes().length > 1 ? `<div class="tx-sug__filter">${seg({ value: u.scheme, act: 'tx-sug-scheme', label: 'Scheme', size: 'sm', options: [['', 'All'], ...classSchemes().map(s => [s.id, s.name])] })}</div>` : '';
    return `<div class="tx-sug">${filter}${reviewSec(u.scheme)}${proposalsSec(u.scheme)}${learnedSec(u.scheme)}</div>`;
  }
  A['tx-sug-scheme'] = el => { SUG().scheme = el.dataset.value; refresh(); };
  const schemeNote = sid => (SUG().scheme ? '' : `<span class="muted" translate="no">${esc(schemeName(sid))}</span>`);
  const sample = (titles, n = titles.length) => `<span class="tx-sug__sample">${titles.slice(0, 3).map(t => `<span translate="no">${esc(bareName(t))}</span>`).join('<span aria-hidden="true">, </span>')}${n > 3 ? ` <span>${esc(`+${fmtNum(n - 3)} more`)}</span>` : ''}</span>`;

  /* (1) Labels awaiting review: suggested assignments by concept, first syncs' batches, the pool per scheme */
  function reviewSec(sid) {
    const groups = pendingByConcept(sid), batches = openAssignmentBatches(sid).filter(b => b.concept && conceptById(b.concept));
    const pools = classSchemes().filter(s => !sid || s.id === sid).filter(s => unclassifiedPool(s.id).length || openAssignmentBatches(s.id).some(b => !b.concept));
    const body = groups.length || batches.length || pools.length
      ? `<ul class="tx-cards">${groups.map(pendingCard).join('')}${batches.map(batchCard).join('')}${pools.map(poolCard).join('')}</ul>`
      : emptyState({ icon: 'check-circle', tone: 'success', title: 'Nothing awaiting review', desc: 'Labels the assistant wasn’t sure of, and documents it couldn’t classify, show up here.', compact: true });
    return section('Labels awaiting review', body, { desc: esc('The assistant suggested these labels but wasn’t sure enough to apply them.') });
  }
  function pendingCard(g) {
    const u = SUG(), open = !!u.open[g.concept], n = g.docs.length, c = conceptById(g.concept), ps = parentsIn(c);
    const acts = (admin() ? btn('Accept all', { v: 'secondary', size: 'sm', icon: 'check', act: 'tx-sug-accept', data: { id: g.concept } }) : '') + btn(open ? 'Hide' : 'View', { v: 'ghost', size: 'sm', iconRight: open ? 'chevron-up' : 'chevron-down', act: 'tx-sug-view', data: { id: g.concept } });
    const docRow = d => {
      const a = (d.concepts || []).find(x => x.id === g.concept && x.state === 'suggested');
      const ops = admin() ? iconBtn('check', 'Accept', { size: 'sm', act: 'tx-sug-doc', data: { id: g.concept, doc: d.id, op: 'accept' } }) + iconBtn('x', 'Reject', { size: 'sm', act: 'tx-sug-doc', data: { id: g.concept, doc: d.id, op: 'reject' } }) : '';
      return `<li class="tx-sug-doc">${fileIcon(d.type, 'sm')}<a class="link truncate" href="#/doc/${esc(d.id)}" translate="no">${esc(docTitle(d))}</a>${a?.conf ? `<span class="tx-sug-doc__conf" data-tip="${esc('How sure the assistant was')}">${Math.round(a.conf * 100)}%</span>` : ''}<span class="tx-sug-doc__ops">${ops}</span></li>`;
    };
    const list = open ? `<ul class="tx-sug-docs">${g.docs.map(docRow).join('')}</ul>${admin() ? `<div class="tx-sug__more">${btn('Reject all', { v: 'ghost', size: 'sm', act: 'tx-sug-reject', data: { id: g.concept } })}</div>` : ''}` : '';
    return `<li class="tx-card"><div class="tx-card__head"><div class="tx-card__main"><div class="tx-card__title">${conceptTag(g.concept, { href: taxonomyHref(g.scheme, { node: g.concept }) })}${ps.length ? `<span class="muted truncate" translate="no">${esc(conceptPathText(ps[0]))}</span>` : ''}${schemeNote(g.scheme)}</div>
      <div class="tx-card__meta"><span>${esc(plural(n, 'document'))}</span>${DOT}${sample(g.docs.map(d => d.name), n)}</div></div><div class="tx-card__acts">${acts}</div></div>${list}</li>`;
  }
  A['tx-sug-view'] = el => { const u = SUG(); u.open[el.dataset.id] = !u.open[el.dataset.id]; refresh(); };
  /** Accept or reject suggestions (all of a concept's, or one document's) with Undo. */
  function decideSuggested(id, docs, accept) {
    if (!admin()) return;
    const snaps = docs.map(d => [d, snapDoc(d)]);
    const n = accept ? confirmAssignments(id, docs) : rejectAssignments(id, docs);
    if (!n) return;
    refresh();
    toast(accept ? `Accepted “${conceptName(id)}” for ${plural(n, 'document')}` : `Rejected “${conceptName(id)}” for ${plural(n, 'document')}`, { action: { label: 'Undo', run: () => { snaps.forEach(([d, x]) => restoreDoc(d, x)); refresh(); } } });
  }
  const groupDocs = id => pendingByConcept().find(g => g.concept === id)?.docs || [];
  A['tx-sug-accept'] = el => decideSuggested(el.dataset.id, groupDocs(el.dataset.id), true);
  A['tx-sug-reject'] = el => decideSuggested(el.dataset.id, groupDocs(el.dataset.id), false);
  A['tx-sug-doc'] = el => { const d = docById(el.dataset.doc); if (d) decideSuggested(el.dataset.id, [d], el.dataset.op === 'accept'); };

  /** A first sync's suggestions kept as counts: accept them all, or (the pool's) file them under a concept. Every decision
      moves the run's counters (run.backfill.concepts). */
  function batchCard(b) {
    const acts = admin() ? btn('Accept all', { v: 'secondary', size: 'sm', icon: 'check', act: 'tx-batch-accept', data: { id: b.id } }) : decides();
    return `<li class="tx-card"><div class="tx-card__head"><div class="tx-card__main"><div class="tx-card__title">${conceptTag(b.concept, { href: taxonomyHref(b.scheme, { node: b.concept }) })}${schemeNote(b.scheme)}</div>
      <div class="tx-card__meta"><span>${esc(`${plural(b.n, 'document')} from a first sync`)}</span>${DOT}${sample(b.sample || [], b.n)}</div></div><div class="tx-card__acts">${acts}</div></div></li>`;
  }
  const batchById = id => (D.assignmentBatches || []).find(b => b.id === id);
  function settleBatch(b, concept = b.concept) {
    if (!admin() || !b || b.state !== 'open' || !conceptById(concept)) return;
    const wasPool = !b.concept, delta = { [wasPool ? 'concepts.none' : 'concepts.confirm']: -b.n, 'concepts.filed': b.n };
    b.state = 'done'; b.concept = concept; b.decided = { by: me().id, at: Date.now() };
    shiftBackfill(b.run, delta);
    audit('Confirmed concepts for documents', `${conceptName(concept)} · ${plural(b.n, 'document')}`);
    refresh();
    toast(`Filed ${plural(b.n, 'document')} under “${conceptName(concept)}”`, { action: { label: 'Undo', run: () => {
      if (b.state !== 'done') return;
      b.state = 'open'; if (wasPool) b.concept = null; delete b.decided; shiftBackfill(b.run, delta, -1); refresh();
    } } });
  }
  A['tx-batch-accept'] = el => settleBatch(batchById(el.dataset.id));
  A['tx-batch-file'] = el => { if (el.value) settleBatch(batchById(el.dataset.id), el.value); };

  /** Not classified: what a scheme couldn't file with confidence. Filing one is a person's choice (and a correction the
      label learning reads). */
  function poolCard(s) {
    const docs = unclassifiedPool(s.id), batches = openAssignmentBatches(s.id).filter(b => !b.concept);
    const opts = [['', 'File under…'], ...assignableConcepts(s.id).map(c => [c.id, conceptPathText(c.id)])];
    const pick = (data, label) => (admin() ? select({ id: `tx-pool-${Object.values(data).join('-')}`, value: '', options: opts, size: 'sm', label, cls: 'tx-add__pick', change: data.doc ? 'tx-pool-file' : 'tx-batch-file', attrs: dataAttrs(data) }) : '');
    const rows = [
      ...batches.map(b => `<li class="tx-sug-doc tx-sug-doc--batch">${ic('files', 'i-sm muted')}<span class="tx-sug-doc__text"><span>${esc(`${plural(b.n, 'document')} from a first sync`)}</span>${sample(b.sample || [], b.n)}</span><span class="tx-sug-doc__ops">${pick({ id: b.id }, 'File these documents under')}</span></li>`),
      ...docs.slice(0, 20).map(d => `<li class="tx-sug-doc">${fileIcon(d.type, 'sm')}<a class="link truncate" href="#/doc/${esc(d.id)}" translate="no">${esc(docTitle(d))}</a><span class="tx-sug-doc__ops">${pick({ doc: d.id, scheme: s.id }, `File ${docTitle(d)} under`)}</span></li>`),
    ].join('');
    const total = docs.length + batches.reduce((a, b) => a + b.n, 0);
    return `<li class="tx-card tx-card--pool"><div class="tx-card__head"><div class="tx-card__main"><div class="tx-card__title"><span class="medium">${esc('Not classified')}</span><span class="muted" translate="no">${esc(s.name)}</span></div>
      <div class="tx-card__meta"><span>${esc(plural(total, 'document'))}</span>${admin() ? '' : `${DOT}${decides()}`}</div></div></div><ul class="tx-sug-docs">${rows}</ul>${docs.length > 20 ? `<p class="tx-sug__more muted">${esc(`+${fmtNum(docs.length - 20)} more`)}</p>` : ''}</li>`;
  }
  A['tx-pool-file'] = el => {
    const d = docById(el.dataset.doc), sid = el.dataset.scheme, id = el.value; if (!d || !conceptById(id) || !admin()) return;
    const snap = snapDoc(d), nCorr = (D.reviewCorrections || []).length, props = clone(D.conceptProposals || []);
    setDocConcepts(d, [...schemeConceptIds(d, sid, { suggested: false }), id], { schemes: [sid] });
    d.classifiedBy = 'person';
    recordCorrection(d, [], [id]);
    audit('Filed a document under a concept', `${conceptName(id)} → ${d.name}`);
    refresh();
    toast(`Filed “${docTitle(d)}” under “${conceptName(id)}”`, { action: { label: 'Undo', run: () => {
      restoreDoc(d, snap); D.reviewCorrections.splice(0, (D.reviewCorrections || []).length - nCorr); D.conceptProposals = props; refresh();
    } } });
  };

  /* (2) New concept proposals: from clustering the pool, repeated corrections or members */
  function proposalsSec(sid) {
    const u = SUG(), props = openProposals({ scheme: sid, kind: 'concept' });
    const done = Object.entries(u.done).map(([pid, cid]) => [proposalById(pid), conceptById(cid)]).filter(([p, c]) => p && c && conceptState(c) === 'draft' && (!sid || p.scheme === sid));
    const doneRow = ([p, c]) => `<li class="tx-card tx-card--done"><div class="tx-card__head">${ic('check-circle', 'i-sm tx-card__ok')}<div class="tx-card__main"><div class="tx-card__title"><span class="medium" translate="no">${esc(conceptName(c.id))}</span><span>${esc('is a draft now')}</span>${schemeNote(c.scheme)}</div></div><div class="tx-card__acts">${btn('Open draft', { v: 'ghost', size: 'sm', iconRight: 'arrow-right', href: taxonomyHref(c.scheme, { node: c.id }) })}</div></div></li>`;
    const body = props.length || done.length ? `<ul class="tx-cards">${done.map(doneRow).join('')}${props.map(proposalCard).join('')}</ul>`
      : emptyState({ icon: 'lightbulb', title: 'No new concepts proposed', desc: 'When unclassified documents form a group, or reviewers keep making the same correction, a concept is proposed here.', compact: true });
    return section('New concept proposals', body, { desc: esc('Accepting adds a draft to the tree; documents are classified with it once you publish.') });
  }
  function proposalCard(p) {
    const docs = (p.docs || []).map(docById).filter(d => d && canSeeDoc(d)), n = p.n || (p.docs || []).length, [origin, icon] = ORIGIN[p.origin] || ORIGIN.member;
    const where = p.broader && conceptById(p.broader) ? `<span class="muted">${esc('under')}</span> <span class="muted" translate="no">${esc(conceptPathText(p.broader))}</span>` : '';
    const acts = admin() ? btn('Accept', { v: 'secondary', size: 'sm', icon: 'check', act: 'tx-prop-accept', data: { id: p.id } }) + btn('Reject', { v: 'ghost', size: 'sm', act: 'tx-prop-reject', data: { id: p.id } }) : decides();
    return `<li class="tx-card"><div class="tx-card__head">${itemIcon(icon, 'accent', 'sm')}<div class="tx-card__main"><div class="tx-card__title"><span class="medium" translate="no">${esc(p.name)}</span>${where}${schemeNote(p.scheme)}</div>
      ${p.definition ? `<p class="tx-card__text" translate="no">${esc(p.definition)}</p>` : ''}<div class="tx-card__meta"><span>${esc(origin)}</span>${n ? `${DOT}<span>${esc(plural(n, 'document'))}</span>` : ''}${docs.length ? `${DOT}${sample(docs.map(d => d.name), docs.length)}` : ''}</div></div><div class="tx-card__acts">${acts}</div></div></li>`;
  }
  /** Undo for a proposal decision: the proposal, the concepts and the scheme's changes as they were. */
  const propUndo = (p, snap) => { const was = clone(p); return undoTax(snap, () => { Object.keys(p).forEach(k => delete p[k]); Object.assign(p, was); delete SUG().done[p.id]; }); };
  A['tx-prop-accept'] = el => {
    const p = proposalById(el.dataset.id); if (!p || p.state !== 'open' || !admin()) return;
    S.ui.txAccept = { id: p.id, name: p.name, broader: conceptById(p.broader) ? p.broader : '', definition: p.definition || '', err: '' };
    openModal('tx-accept', {});
  };
  M['tx-accept'] = () => {
    const f = S.ui.txAccept, p = proposalById(f?.id); if (!p) return { title: 'Missing proposal', body: '' };
    const s = schemeById(p.scheme), parents = conceptsOf(s.id).filter(c => depthOf(c) < (s.maxDepth || 9)).map(c => [c.id, conceptPathText(c.id)]);
    return {
      size: 'sm', icon: 'lightbulb', title: 'Accept the proposal', desc: esc(`It becomes a draft in ${s.name}.`),
      body: field({ id: 'tx-acc-name', label: 'Name', required: true, error: f.err, control: input({ id: 'tx-acc-name', bind: 'txAccept.name', value: f.name, autofocus: true, onEnter: 'tx-accept-go', invalid: !!f.err, attrs: 'maxlength="120"' }) })
        + field({ id: 'tx-acc-broader', label: 'Under', control: select({ id: 'tx-acc-broader', bind: 'txAccept.broader', value: f.broader, options: [['', 'Nothing: a top concept'], ...parents] }) })
        + field({ id: 'tx-acc-def', label: 'Definition', optional: true, control: textarea({ id: 'tx-acc-def', bind: 'txAccept.definition', value: f.definition, rows: 2, attrs: 'maxlength="1000"' }) }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Add draft', { v: 'primary', icon: 'plus', act: 'tx-accept-go' }),
    };
  };
  A['tx-accept-go'] = () => {
    const f = S.ui.txAccept, p = proposalById(f?.id); if (!p || !admin()) return;
    const name = clean(f.name);
    f.err = !name ? 'Enter a name.' : nameClash(p.scheme, name);
    if (f.err) { refreshLayer(); $('#tx-acc-name')?.focus(); return; }
    const snap = snapTax(), undo = propUndo(p, snap);
    const c = acceptProposal(p, { name, broader: f.broader || null, definition: String(f.definition || '').trim() });
    if (!c) return;
    if (!parentsIn(c).length) Object.assign(c, { color: freeDomainColor(rootsOf(c.scheme).map(x => x.color)), icon: schemeIcon(c.scheme) });
    SUG().done[p.id] = c.id;
    closeModal(); refresh();
    toast(`Added “${name}” as a draft in ${schemeName(c.scheme)}`, { action: undo });
  };
  A['tx-prop-reject'] = el => {
    const p = proposalById(el.dataset.id); if (!p || p.state !== 'open' || !admin()) return;
    const undo = propUndo(p, snapTax());
    rejectProposal(p); refresh();
    toast(`Rejected “${p.name}”`, { action: undo });
  };

  /* (3) Learned from edits: labels reviewers' corrections share */
  function learnedSec(sid) {
    const props = openProposals({ scheme: sid, kind: 'label' }).filter(p => conceptById(p.target));
    const row = p => {
      const docs = (p.docs || []).map(docById).filter(d => d && canSeeDoc(d)), n = (p.docs || []).length;
      const acts = admin() ? btn('Accept', { v: 'secondary', size: 'sm', icon: 'plus', act: 'tx-learn-accept', data: { id: p.id } }) + btn('Dismiss', { v: 'ghost', size: 'sm', act: 'tx-learn-dismiss', data: { id: p.id } }) : decides();
      return `<li class="tx-card"><div class="tx-card__head">${itemIcon('sparkles', 'accent', 'sm')}<div class="tx-card__main"><div class="tx-card__title"><span>${esc(`Add “${p.name}” to ${conceptName(p.target)}`)}</span>${p.labelKind === 'hidden' ? `<span class="muted">${esc('as a hidden label')}</span>` : ''}${schemeNote(p.scheme)}</div>
        <div class="tx-card__meta"><span>${esc(`Shared by ${plural(n, 'corrected document')}`)}</span>${docs.length ? `${DOT}${sample(docs.map(d => d.name), docs.length)}` : ''}</div></div><div class="tx-card__acts">${acts}</div></div></li>`;
    };
    const body = props.length ? `<ul class="tx-cards">${props.map(row).join('')}</ul>`
      : emptyState({ icon: 'sparkles', title: 'Nothing learned yet', desc: 'When reviewers move documents to a concept and their titles share words, those words are suggested as labels.', compact: true });
    return section('Learned from edits', body, { desc: esc('Adding a label helps the assistant file the next document like these. Nothing changes until you accept.') });
  }
  A['tx-learn-accept'] = el => {
    const p = proposalById(el.dataset.id); if (!p || p.state !== 'open' || !admin()) return;
    const undo = propUndo(p, snapTax()), c = acceptProposal(p);
    if (!c) return;
    refresh();
    toast(`Added “${p.name}” to ${conceptName(c.id)}`, { action: undo });
  };
  A['tx-learn-dismiss'] = el => {
    const p = proposalById(el.dataset.id); if (!p || p.state !== 'open' || !admin()) return;
    const undo = propUndo(p, snapTax());
    rejectProposal(p); refresh();
    toast(`Dismissed “${p.name}”`, { action: undo });
  };

  /* ═══════════════ Export SKOS (Turtle) ═══════════════ */
  const ttl = s => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
  const slug = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  function skosOf(s) {
    const base = `https://bomesh.example/${slug(curWs().name)}/schemes/`, iri = c => (c.scheme === s.id ? `:${c.notation}` : `<${base}${c.scheme}/${c.notation}>`);
    const lang = schemeLang(s.id), all = (D.concepts || []).filter(c => c.scheme === s.id && conceptState(c) !== 'draft');
    const label = (p, list) => (list.length ? [`  ${p} ${list.map(([l, t]) => `${ttl(t)}@${l}`).join(', ')}`] : []);
    const refs = (p, ids) => { const cs = ids.map(conceptById).filter(Boolean); return cs.length ? [`  ${p} ${cs.map(iri).join(', ')}`] : []; };
    const concept = c => [`${iri(c)} a skos:Concept`,
      `  skos:inScheme :scheme`, `  skos:notation ${ttl(c.notation)}`,
      ...label('skos:prefLabel', Object.entries(c.pref || {})), ...label('skos:altLabel', c.alt || []), ...label('skos:hiddenLabel', c.hidden || []),
      ...(c.definition ? [`  skos:definition ${ttl(c.definition)}@${lang}`] : []), ...(c.scope ? [`  skos:scopeNote ${ttl(c.scope)}@${lang}`] : []),
      ...refs('skos:broader', c.broader || []), ...refs('skos:related', c.related || []),
      ...(!parentsIn(c).length && conceptState(c) !== 'deprecated' ? ['  skos:topConceptOf :scheme'] : []),
      ...MATCH.flatMap(([m]) => { const ms = (c.mappings || []).filter(x => x[3] === m); return ms.length ? [`  skos:${m}Match ${ms.map(x => `<urn:${encodeURIComponent(x[0])}:${encodeURIComponent(x[1])}>`).join(', ')}`] : []; }),
      ...(conceptState(c) === 'deprecated' ? ['  owl:deprecated true', ...refs('dct:isReplacedBy', c.replacedBy || [])] : []),
    ].join(' ;\n') + ' .';
    const head = [`@prefix skos: <http://www.w3.org/2004/02/skos/core#> .`, `@prefix dct: <http://purl.org/dc/terms/> .`, `@prefix owl: <http://www.w3.org/2002/07/owl#> .`, `@prefix : <${base}${s.id}/> .`, ''].join('\n');
    const scheme = [':scheme a skos:ConceptScheme', `  skos:prefLabel ${ttl(s.name)}@${lang}`, ...(s.desc ? [`  dct:description ${ttl(s.desc)}@${lang}`] : []), ...(s.version ? [`  owl:versionInfo ${ttl(String(s.version))}`] : []),
      ...refs('skos:hasTopConcept', rootsOf(s.id).filter(c => conceptState(c) === 'published').map(c => c.id))].join(' ;\n') + ' .';
    return `${head}\n${scheme}\n\n${all.map(concept).join('\n\n')}\n`;
  }
  function exportSkos(s) {
    saveLocalFile(`${slug(curWs().name)}-${s.id}.ttl`, skosOf(s), 'text/turtle;charset=utf-8', `Exported ${s.name} as SKOS`);
    audit('Exported a scheme', s.name);
  }

  /* ═══════════════ Import CSV ═══════════════ */
  const COLS = ['scheme', 'notation', 'broader', 'pref_vi', 'pref_en', 'alt', 'hidden', 'definition', 'scope_note'];
  const NOTATION_RE = /^[a-z][a-z0-9-]{0,62}$/;
  const IMP = () => ui('txImport');
  function openImport(sid) {
    if (!admin()) return;
    S.ui.txImport = { scheme: sid, step: 'file', file: null, rows: null, has: {}, err: '', preview: false };
    openModal('tx-import', {});
  }
  /** A CSV the browser read: header names in any order; `scheme` and a name or notation are required. */
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
    const idx = COLS.map(k => head.indexOf(k));
    if (idx[0] < 0 || (idx[1] < 0 && idx[3] < 0 && idx[4] < 0)) return { error: `The first row must name the columns: ${COLS.join(', ')}.` };
    const has = Object.fromEntries(COLS.map((k, i) => [k, idx[i] >= 0]));
    return { has, rows: body.slice(1).map(r => Object.fromEntries(COLS.map((k, i) => [k, idx[i] < 0 ? '' : ['definition', 'scope_note'].includes(k) ? String(r[idx[i]] ?? '').trim() : clean(r[idx[i]])]))) };
  }
  const listCell = v => String(v || '').split(/[;|\n]+/).map(clean).filter(Boolean);
  /** “vi:học bổng; en:scholarship; miễn học phí” → [[lang, text]] (no prefix: the scheme's language). */
  const termsCell = (v, lang) => listCell(v).map(t => { const m = /^(vi|en):\s*(.+)$/i.exec(t); return m ? [m[1].toLowerCase(), clean(m[2])] : [lang, t]; });
  const sameTerms = (a = [], b = []) => JSON.stringify(a.map(([l, t]) => `${l}:${normLabel(t)}`).sort()) === JSON.stringify(b.map(([l, t]) => `${l}:${normLabel(t)}`).sort());
  /** Compare rows with the working copy: { added, updated, same, errors }. A row matches a concept by scheme + notation;
      without a notation it's new (one is made from its name). `broader` lists notations of the same scheme, including
      concepts this file adds. Columns the file doesn't have are neither compared nor applied. */
  function planImport(rows, has) {
    const out = { added: [], updated: [], same: 0, errors: [] }, seen = new Set(), reserved = new Map();
    const schemeOf = v => (D.schemes || []).find(s => s.id === clean(v).toLowerCase() || nameKey(s.name) === nameKey(v));
    const plan = [];
    rows.forEach((r, i) => {
      const row = i + 2, fail = text => out.errors.push({ row, label: r.notation || r.pref_vi || r.pref_en || '', text });
      if (!r.scheme) return fail('No scheme.');
      const s = schemeOf(r.scheme); if (!s) return fail(`No scheme is called “${r.scheme}”.`);
      const lang = schemeLang(s.id);
      let notation = clean(r.notation).toLowerCase();
      if (notation && !NOTATION_RE.test(notation)) return fail('A notation uses lower-case letters, digits and hyphens, and starts with a letter.');
      const c = notation ? (D.concepts || []).find(x => x.scheme === s.id && x.notation === notation) : null;
      if (c && conceptState(c) === 'deprecated') return fail('This notation belongs to a retired concept. Notations are never reused.');
      const pref = { ...(r.pref_vi ? { vi: r.pref_vi } : {}), ...(r.pref_en ? { en: r.pref_en } : {}) };
      if (!c && !Object.keys(pref).length) return fail('A new concept needs a name in pref_vi or pref_en.');
      if (!notation) { const taken = reserved.get(s.id) || reserved.set(s.id, new Set()).get(s.id), base = newNotation(s.id, pref[lang] || Object.values(pref)[0]); let n = base, k = 2; while (taken.has(n)) n = `${base}-${k++}`; notation = n; }
      const key = `${s.id}\n${notation}`;
      if (seen.has(key)) return fail('Listed more than once. Only the first row is used.');
      seen.add(key); (reserved.get(s.id) || reserved.set(s.id, new Set()).get(s.id)).add(notation);
      plan.push({ row, s, notation, c, pref, alt: termsCell(r.alt, lang), hidden: termsCell(r.hidden, lang), definition: r.definition, scope: r.scope_note, broaderN: listCell(r.broader).map(x => x.toLowerCase()) });
    });
    const known = (sid, n) => (D.concepts || []).find(x => x.scheme === sid && x.notation === n && conceptState(x) !== 'deprecated') || plan.find(p => p.s.id === sid && p.notation === n && !p.c);
    plan.forEach(p => {
      const missing = p.broaderN.filter(n => !known(p.s.id, n) || n === p.notation);
      if (missing.length) { out.errors.push({ row: p.row, label: p.notation, text: `No concept “${missing.join(', ')}” to sit under in ${p.s.name}.` }); return; }
      p.broaderRefs = p.broaderN;
      if (!p.c) { out.added.push(p); return; }
      const c = p.c, what = [];
      if (Object.entries(p.pref).some(([l, t]) => c.pref?.[l] !== t)) what.push('name');
      if ((has.alt && !sameTerms(c.alt, p.alt)) || (has.hidden && !sameTerms(c.hidden, p.hidden))) what.push('labels');
      if (has.definition && (c.definition || '') !== p.definition) what.push('definition');
      if (has.scope_note && (c.scope || '') !== p.scope) what.push('scope note');
      const now = (c.broader || []).filter(b => conceptById(b)?.scheme === c.scheme).map(b => conceptById(b).notation).sort().join();
      if (has.broader && now !== [...p.broaderN].sort().join()) what.push('broader');
      if (what.length) out.updated.push({ ...p, what }); else out.same++;
    });
    return out;
  }
  const changeCount = x => x.added.length + x.updated.length;
  const csvRow = (s, c) => [s.id, c.notation, parentsIn(c).map(b => conceptById(b).notation).join('; '), c.pref?.vi || '', c.pref?.en || '', (c.alt || []).map(([l, t]) => `${l}:${t}`).join('; '), (c.hidden || []).map(([l, t]) => `${l}:${t}`).join('; '), c.definition || '', c.scope || ''];
  /** A sample built from the scheme as it is, filled in the way people do: a definition rewritten, a label added, two new
      concepts and one row pointing at a parent that doesn't exist. */
  function sampleRows(sid) {
    const s = schemeById(sid), lang = schemeLang(sid), rows = conceptsOf(sid).map(c => Object.fromEntries(COLS.map((k, i) => [k, csvRow(s, c)[i]])));
    const leaf = rows.find(r => r.broader), top = rows.find(r => !r.broader);
    if (leaf) leaf.alt = [leaf.alt, `${lang}:${lang === 'vi' ? 'mẫu nhập' : 'sample import'}`].filter(Boolean).join('; ');
    if (rows[1]) rows[1].definition = `${rows[1].definition || ''} ${lang === 'vi' ? '(Đã cập nhật từ tệp nhập.)' : '(Updated from the import file.)'}`.trim();
    const name = (vi, en) => (lang === 'vi' ? { pref_vi: vi, pref_en: en } : { pref_vi: '', pref_en: en });
    rows.push({ scheme: sid, notation: '', broader: top?.notation || '', ...name('Khái niệm mẫu', 'Sample concept'), alt: '', hidden: '', definition: lang === 'vi' ? 'Khái niệm mẫu thêm từ tệp nhập.' : 'A sample concept added from the import file.', scope_note: '' });
    rows.push({ scheme: sid, notation: '', broader: top?.notation || '', ...name('Khái niệm mẫu thứ hai', 'Second sample concept'), alt: '', hidden: '', definition: '', scope_note: '' });
    rows.push({ scheme: sid, notation: '', broader: 'missing-parent', ...name('Khái niệm lạc chỗ', 'Misplaced concept'), alt: '', hidden: '', definition: '', scope_note: '' });
    return rows;
  }
  const allCols = () => Object.fromEntries(COLS.map(k => [k, true]));
  function readFile(file) {
    const f = IMP(), ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['csv', 'tsv', 'txt', 'xlsx', 'xls'].includes(ext)) { f.err = 'Choose a CSV or Excel file.'; refreshLayer(); return; }
    f.err = '';
    if (ext === 'xlsx' || ext === 'xls') { Object.assign(f, { file: { name: file.name, size: file.size || 18e3 }, rows: sampleRows(f.scheme), has: allCols(), preview: true, step: 'check' }); refreshLayer(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const p = parseCsv(String(reader.result || ''));
      if (p.error) { f.err = p.error; refreshLayer(); return; }
      if (!p.rows.length) { f.err = 'The file has a header but no rows.'; refreshLayer(); return; }
      Object.assign(f, { file: { name: file.name, size: file.size }, rows: p.rows, has: p.has, preview: false, step: 'check' }); refreshLayer();
    };
    reader.readAsText(file);
  }
  const sampleName = sid => `${slug(curWs().name)}-${sid}.csv`;
  A['tx-imp-browse'] = () => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.hidden = true; inp.accept = '.csv,.tsv,.txt,.xlsx,.xls';
    inp.addEventListener('change', () => { if (inp.files?.[0]) readFile(inp.files[0]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  };
  A['tx-imp-sample'] = () => { const f = IMP(); Object.assign(f, { file: { name: sampleName(f.scheme), size: 9e3 }, rows: sampleRows(f.scheme), has: allCols(), preview: true, step: 'check', err: '' }); refreshLayer(); };
  A['tx-imp-back'] = () => { Object.assign(IMP(), { step: 'file', file: null, rows: null }); refreshLayer(); };
  A['tx-imp-template'] = () => {
    const s = schemeById(IMP().scheme), c = rootsOf(s.id)[0];
    saveCsv('classification-template.csv', [COLS, ...(c ? [csvRow(s, c)] : [])], 'Template downloaded');
  };
  document.addEventListener('dragover', e => { const z = e.target.closest?.('#tx-drop'); if (!z) return; e.preventDefault(); z.classList.add('is-drag'); });
  document.addEventListener('dragleave', e => { const z = e.target.closest?.('#tx-drop'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('is-drag'); });
  document.addEventListener('drop', e => { const z = e.target.closest?.('#tx-drop'); if (!z) return; e.preventDefault(); const file = e.dataTransfer?.files?.[0]; if (file) readFile(file); });
  function changeList(title, items, line, tone, limit = 8) {
    if (!items.length) return '';
    const more = items.length - limit;
    return `<section class="tx-changes"><h3 class="tx-changes__title">${chip(fmtNum(items.length), { size: 'sm', tone })}<span>${esc(title)}</span></h3>
      <ul class="tx-changes__list">${items.slice(0, limit).map(line).join('')}${more > 0 ? `<li class="tx-change muted">${esc(`+${fmtNum(more)} more`)}</li>` : ''}</ul></section>`;
  }
  M['tx-import'] = () => {
    const f = IMP(), s = schemeById(f.scheme);
    if (f.step === 'file') {
      const drop = `<button type="button" class="ctb-drop" id="tx-drop" data-act="tx-imp-browse" aria-describedby="tx-drop-hint"><span class="ctb-drop__icon">${ic('table', 'i-lg')}</span><span class="medium">${esc('Drop a spreadsheet here or browse')}</span><span class="description" id="tx-drop-hint">${esc(`CSV or Excel · columns ${COLS.join(', ')}`)}</span></button>`;
      const err = f.err ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : '';
      const helpers = `<div class="ctb-samples"><span class="t-xs muted">${esc('Try it with')}</span>${btn(sampleName(f.scheme), { size: 'sm', v: 'tertiary', icon: 'file', act: 'tx-imp-sample' })}<span class="grow"></span>${linkBtn('Download template', { act: 'tx-imp-template', icon: 'download' })}</div>`;
      return {
        size: 'md', icon: 'upload', title: 'Import CSV', desc: esc('Rows match concepts by scheme and notation; a row without a notation adds a concept. Alt and hidden labels are separated by “;” and may start with their language, like “en:scholarship”.'),
        body: drop + err + helpers, footStart: `<span class="t-xs muted">${esc('Nothing changes until you import.')}</span>`, foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }),
      };
    }
    const x = planImport(f.rows, f.has), total = changeCount(x);
    const file = `<div class="tx-file">${fileIcon(f.file.name.split('.').pop(), 'sm')}<div class="grow tx-min"><div class="medium truncate" translate="no">${esc(f.file.name)}</div><div class="t-xs muted">${esc(`${plural(f.rows.length, 'row')} · ${fmtSize(f.file.size)}`)}</div></div>${f.preview ? chip('Sample data', { size: 'sm', icon: 'info', tip: 'The prototype can’t read Excel files, so it shows a sample built from this scheme. CSV files are read for real.' }) : ''}${btn('Choose another file', { v: 'ghost', size: 'sm', act: 'tx-imp-back' })}</div>`;
    const errs = x.errors.length ? alertBox('warning', `${plural(x.errors.length, 'row')} will be skipped`, `<ul class="tx-issues">${x.errors.map(e => `<li><span class="tx-issues__row">${esc(`Row ${e.row}`)}</span> ${e.label ? `<span translate="no">${esc(e.label)}</span>${DOT}` : ''}<span>${esc(e.text)}</span></li>`).join('')}</ul>`) : '';
    const name = p => `<span class="medium truncate" translate="no">${esc(p.pref[schemeLang(p.s.id)] || Object.values(p.pref)[0] || conceptName(p.c?.id))}</span><span class="muted truncate" translate="no">${esc(p.s.name)}</span>`;
    const lists = changeList('New drafts', x.added, p => `<li class="tx-change">${name(p)}</li>`, 'success')
      + changeList('Updated', x.updated, p => `<li class="tx-change">${name(p)}<span class="muted">${esc(p.what.join(', '))}</span></li>`, 'accent');
    const none = !total ? emptyState({ icon: 'check-circle', tone: 'success', title: 'Nothing to change', desc: 'The file matches the working copy.', compact: true }) : '';
    const effects = total ? `<div class="tx-impact">${ic('sparkles', 'i-sm')}<ul><li>${esc('Changes go to the working copy. Classification uses them once you publish each scheme.')}</li></ul></div>` : '';
    return {
      size: 'lg', icon: 'upload', title: 'Check the changes', desc: esc(x.same ? `${plural(x.same, 'row')} unchanged.` : `Importing into ${s.name}.`),
      body: `<div class="stack gap-16">${file}${errs}${none}${lists}${effects}</div>`,
      footStart: btn('Back', { v: 'ghost', icon: 'arrow-left', act: 'tx-imp-back' }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(total ? `Import ${plural(total, 'change')}` : 'Close', { v: 'primary', icon: total ? 'upload' : '', act: total ? 'tx-imp-apply' : 'close-modal' }),
    };
  };
  A['tx-imp-apply'] = () => {
    const f = IMP(); if (!f?.rows || !admin()) return;
    const x = planImport(f.rows, f.has); if (!changeCount(x)) return;
    const snap = snapTax(), has = f.has;
    // New concepts first, so broader notations can point at them.
    const created = x.added.map(p => {
      const lang = schemeLang(p.s.id), c = { id: uid('c'), scheme: p.s.id, notation: p.notation, pref: p.pref, alt: p.alt, hidden: p.hidden, definition: p.definition || '', scope: p.scope || '', examples: [], broader: [], related: [], mappings: [], patterns: [], state: 'draft', replacedBy: [] };
      if (!Object.keys(c.pref).length) c.pref = { [lang]: p.notation };
      return [p, c];
    });
    D.concepts = [...(D.concepts || []), ...created.map(([, c]) => c)];
    const byNotation = (sid, n) => (D.concepts || []).find(c => c.scheme === sid && c.notation === n && conceptState(c) !== 'deprecated');
    created.forEach(([p, c]) => {
      c.broader = p.broaderRefs.map(n => byNotation(p.s.id, n)?.id).filter(Boolean);
      if (!c.broader.length) Object.assign(c, { color: freeDomainColor(rootsOf(p.s.id).map(o => o.color)), icon: schemeIcon(p.s.id) });
      noteChange(p.s.id, 'added', c.id, conceptName(c.id));
    });
    x.updated.forEach(p => {
      const c = p.c;
      if (p.what.includes('name')) { c.pref = { ...(c.pref || {}), ...p.pref }; note(c.scheme, 'relabeled', c.id, conceptName(c.id)); }
      if (p.what.includes('labels')) { if (has.alt) c.alt = p.alt; if (has.hidden) c.hidden = p.hidden; note(c.scheme, 'relabeled', c.id, ''); }
      if (p.what.includes('definition') || p.what.includes('scope note')) { if (has.definition) c.definition = p.definition; if (has.scope_note) c.scope = p.scope; note(c.scheme, 'redefined', c.id, ''); }
      if (p.what.includes('broader')) { const cross = (c.broader || []).filter(b => conceptById(b)?.scheme !== c.scheme); c.broader = [...p.broaderRefs.map(n => byNotation(c.scheme, n)?.id).filter(Boolean), ...cross]; note(c.scheme, 'moved', c.id, c.broader.map(conceptName).join(', ')); }
    });
    audit('Imported concepts', `${f.file.name} · ${x.added.length} added, ${x.updated.length} updated`);
    closeModal(); refresh();
    toast(`Imported ${plural(changeCount(x), 'change')} · publish to use them`, { action: undoTax(snap) });
  };

  /* ═══════════════ How the assistant classifies (prompt drawer) ═══════════════ */
  /** What the CLASSIFYING step sends the model in its one call per document: the part every document shares (instructions
      and every published classification scheme, its limits and its concepts with short codes — concept IDs never reach
      the model), which providers cache, then one document's part. Rules and patterns settle what they can first. */
  const PREFIX = { domain: 'D', function: 'F', 'document-type': 'T', audience: 'A', subject: 'S' };
  const flat = s => String(s ?? '').replace(/\s+/g, ' ').trim() || '-';
  const POLICY = { always: 'Always asks the assistant', fallback: 'Asks the assistant only when rules aren’t sure', never: 'Never asks the assistant' };
  const pct = v => `${Math.round((v ?? 0) * 100)}%`;
  function promptParts() {
    const schemes = classSchemes().filter(s => s.version && s.llm !== 'never');
    const block = (s, i) => {
      let n = 0; const p = PREFIX[s.id] || `S${i + 1}-`;
      const lines = conceptsOf(s.id).filter(c => conceptState(c) === 'published').map(c => [`${p}${++n}`, conceptPathText(c.id), flat(c.definition), flat(c.scope), conceptLabels(c).filter(l => l.kind !== 'pref').map(l => l.text).join('; ') || '-'].join(' | '));
      return `<scheme code="${s.id}" name="${s.name}" min="${s.minLabels || 0}" max="${s.maxLabels ?? 'any'}" primary="${s.hasPrimary ? 'yes' : 'no'}" top_concepts="${s.assignTop === false ? 'no' : 'yes'}" sections="${s.sections ? 'yes' : 'no'}">\n${lines.join('\n')}\n</scheme>`;
    };
    const shared = `<classification_instructions>
  Classify one document along every scheme below, in one answer, and read its issuing details.
  - For each scheme choose the concepts the document is about, most specific first, within the scheme's min and max.
    When the scheme has a primary, the first concept is the one it is mainly about.
  - Concepts already settled by rules are given; don't weigh those schemes again.
  - Prefer the candidates offered for the document; choose another concept only with clear evidence.
  - Give each concept a confidence from 0 to 1 and quote the words that show it. Choose none rather than a wrong one.
  - Issuing details: number, dates, issuing unit and who it applies to, as written in the document.
  Answer with one JSON object:
  {"concepts": [{"code": "F3", "primary": true, "confidence": 0.91, "evidence": "…"}],
   "issuance": {"number": "…", "issued": "YYYY-MM-DD", "effective": "YYYY-MM-DD", "issuer": "…", "applies_to": "…"}, "summary": "…"}
</classification_instructions>

<run_note>{the run's note for the assistant}</run_note>
${schemes.map(block).join('\n\n')}`;
    const each = `<settled>
{schemes settled by rules and recognition patterns, with their concepts}
</settled>
<candidates>
{per scheme: concepts whose labels the document uses or that similar documents carry, with scores}
</candidates>
<document_title>{title}</document_title>
<document>
{metadata and leading excerpts, up to 12,000 characters}
</document>`;
    return { shared, each };
  }
  const TRY = () => ui('txTry', { q: '', ran: '' });
  DR['tx-prompt'] = () => {
    const { shared, each } = promptParts(), tokens = s => Math.ceil(s.length / 4);
    const code = (s, label) => `<pre class="tx-code" tabindex="0" aria-label="${esc(label)}" translate="no"><code>${esc(s)}</code></pre>`;
    const schemes = classSchemes().map(s => `<li class="tx-pol"><div class="tx-pol__head"><span class="medium" translate="no">${esc(s.name)}</span><span class="muted">${esc(s.version ? `Version ${s.version}` : 'Not published yet')}</span></div>
      <div class="tx-pol__meta"><span>${esc(POLICY[s.llm] || POLICY.always)}</span>${DOT}<span>${esc(`Applied from ${pct(s.auto ?? 0.85)}, suggested from ${pct(s.review ?? 0.5)}`)}</span>${DOT}<span>${esc(s.maxLabels == null ? 'Any number of labels' : `Up to ${plural(s.maxLabels, 'label')}`)}</span>${s.hasPrimary ? `${DOT}<span>${esc('One primary')}</span>` : ''}</div></li>`).join('');
    const rules = (D.conceptRules || []).filter(r => conceptById(r.then)).map(r => `<li><span>${esc(ruleText(r))}</span> ${ic('arrow-right', 'i-xs')} <span class="medium" translate="no">${esc(conceptName(r.then))}</span><span class="muted">${esc(r.effect === 'implies' ? 'always' : 'more likely')}</span></li>`);
    const u = TRY();
    let out = '';
    if (u.ran) {
      const r = classifyDoc({ id: '__tx-try', name: u.ran, kb: null, folder: null, source: null }, null, u.ran);
      const rows = classSchemes().map(s => {
        const mine = r.assignments.filter(a => conceptById(a.id)?.scheme === s.id);
        const tags = mine.map(a => `<span class="tx-try__hit">${conceptTag(a.id, { suggested: a.state === 'suggested' })}<span class="muted">${pct(a.conf)}</span></span>`).join('');
        return `<li class="tx-try__row"><span class="tx-try__scheme" translate="no">${esc(s.name)}</span><span class="tx-try__tags">${tags || `<span class="muted">${esc(r.uncertain.includes(s.id) ? 'Not classified' : '—')}</span>`}</span></li>`;
      }).join('');
      out = `<ul class="tx-try__out" aria-live="polite">${rows}</ul>`;
    }
    const tryBox = `<div class="tx-try"><div class="tx-try__form">${input({ id: 'tx-try-q', bind: 'txTry.q', value: u.q, placeholder: 'A title, e.g. Quyết định ban hành quy chế đào tạo.pdf', size: 'sm', onEnter: 'tx-try', cls: 'grow', attrs: `aria-label="${esc('Document title')}" spellcheck="false"` })}${btn('Test', { v: 'secondary', size: 'sm', act: 'tx-try' })}</div>${out}</div>`;
    return {
      size: 'xl', title: 'How the assistant classifies', lead: itemIcon('bot', 'accent'),
      desc: esc(`One call per document reads every published scheme: about ${fmtNum(tokens(shared))} tokens shared by every document and cached by the model provider, and about ${fmtNum(tokens(each) + 3000)} for each document.`),
      body: `<div class="stack gap-16">
        ${sec('Schemes', `<ul class="tx-pols">${schemes}</ul>`, { desc: esc('A label at or above the first share is applied; between the two it waits in Suggestions; below, the document stays not classified.') })}
        ${sec('Rules checked first', rules.length ? `<ul class="tx-rulexs">${rules.join('')}</ul>` : emptyLine('No rules yet.'), { desc: esc('“Always” settles a scheme without asking the assistant; “more likely” adds a weighted candidate.') })}
        ${sec('Test classification', tryBox, { desc: esc('Try a title against the schemes as they are now.') })}
        ${sec('Shared by every document', code(shared, 'Shared prompt'), { desc: esc('The same for every document of a run, so the provider serves it from cache.') })}
        ${sec('Each document', code(each, 'Document prompt'))}
      </div>`,
      foot: btn('Close', { v: 'ghost', act: 'close-drawer' }) + btn('Copy prompt', { v: 'primary', icon: 'copy', act: 'tx-prompt-copy' }),
    };
  };
  A['tx-try'] = () => { const u = TRY(); if (!clean(u.q)) { $('#tx-try-q')?.focus(); return; } u.ran = clean(u.q); refreshLayer(); };
  A['tx-prompt-copy'] = () => { const { shared, each } = promptParts(); copyText(`${shared}\n\n${each}`, 'Prompt copied'); };

  X.md = { tab, headerActions, openConcept };
})();

/* My library sections (/knowledge/library?tab=saved|files) and My contributions (/contributions): the personal side of
   Knowledge — Saved and My files, each listed in the sidebar under Knowledge; and, under Your work, what you contributed and
   where it stands. Recent reads are Your work → Recent (recent.js); saved views are in Browse's Views. Each section's one
   action sits in its header, like My contributions' Contribute (My files → Upload). Uses X.res (resources.js), X.ctb +
   DR['ctb'] (contribute.js), core/catalog.js and core/lifecycle.js. Prefix: lib-. */
(() => {
  'use strict';

  const mine = key => { const m = (D[key] ??= {}); return (m[me().id] ??= []); };
  const personalKb = () => visibleKbs().find(k => k.personal);
  const dot = '<span class="res-dot" aria-hidden="true">·</span>';
  /** Search, sort, filters and bulk selection appear once a list is long enough to need them (core TOOLS_MIN), or while one is in use. */
  const longOr = (n, active) => n >= TOOLS_MIN || !!active;

  /* ═══════════════ My library sections ═══════════════ */
  const SAVED_SORTS = { saved: 'Recently saved', updated: 'Recently updated', title: 'Title A–Z' };
  /** A section's toolbar (its tools); the section's action is in the header. */
  const tabBar = start => `<div class="toolbar lib-bar">${start}</div>`;
  P.library = ({ query }) => {
    const kb = personalKb(), tab = X.res.libraryTab(query);
    // Each section is its own page (the sidebar lists it under Knowledge); its one action sits in the header, once there is
    // something listed (an empty section's empty state carries it instead).
    const has = tab === 'files' && !!kb && docsIn(kb.id).length > 0 && S.pageState !== 'empty';
    const action = has ? btn('Upload', { v: 'primary', icon: 'upload', act: 'contribute', data: { private: '1' } }) : '';
    const head = X.res.hubHeader(tab, { actions: action });
    const body = { saved: savedTab, files: filesTab }[tab](kb);
    return `<div class="page page--wide lib">${head}${body}</div>`;
  };

  /* ═══════════════ My contributions: what you shared, where it stands, what to do next ═══════════════ */
  const CTB_GROUPS = [['all', 'All', null], ['changes', 'Needs your action', ['changes']], ['review', 'In review', ['analyzing', 'review']],
    ['published', 'Published', ['published', 'publishing', 'queued', 'versioned', 'failed', 'update', 'stored']], ['rejected', LIFECYCLE.rejected.label, ['rejected']]];
  /** The one row action, only when the contribution waits on you. Everything else (Withdraw, Remove, Open) is in its panel. */
  const ctbAction = d => (lifecycleOf(d).key === 'changes' ? btn('Revise', { v: 'secondary', size: 'sm', icon: 'pencil', act: 'ctb-revise', data: { id: d.id } }) : '');
  P.contributions = () => {
    const uk = 'libCtb', u = ui(uk, { seg: 'all' });
    const all = myContributions();
    const group = CTB_GROUPS.find(g => g[0] === u.seg) || CTB_GROUPS[0];
    const inGroup = (d, g) => !g[2] || g[2].includes(lifecycleOf(d).key);
    const rows = all.filter(d => inGroup(d, group) && matchesQ(uk, d.name, kbById(d.kb)?.name));
    const contribute = canContribute() ? btn('Contribute', { v: 'primary', icon: 'upload', act: 'contribute' }) : '';
    const empty = () => emptyState({ icon: 'upload', title: 'No contributions yet', desc: canContribute() ? 'Share a document with your team. You check what the assistant suggests, then a reviewer publishes it.' : 'Documents you share with your team show up here, with where they stand.', boxed: true });
    const head = pageHeader({ title: 'My contributions', actions: contribute });
    const body = gate({
      loading: () => skelRows(4), empty,
      ok: () => {
        if (!all.length) return empty();
        // One filter per state a contribution can be in (counts only where there is something); search earns its place on a long list.
        const n = g => all.filter(d => inGroup(d, g)).length;
        const opts = CTB_GROUPS.map(g => [g[0], g[2] && n(g) ? `${g[1]} · ${fmtNum(n(g))}` : g[1]]);
        const seg_ = `<div class="lib-ctb-seg">${seg({ value: group[0], options: opts, act: 'lib-ctb-seg', label: 'Show' })}</div>`;
        const search = longOr(all.length, u.q) ? searchField({ uiKey: uk, placeholder: 'Search contributions' }) : '';
        const toolbar = seg_ || search ? `<div class="toolbar lib-bar">${seg_}${search}</div>` : '';
        if (!rows.length) return toolbar + noMatches(uk, ['seg'], 'contributions');
        return toolbar + list(rows.map(d => item({
          lead: fileIcon(d.type), title: esc(docTitle(d)), titleExtra: lifeChip(d, 'sm'),
          desc: `<span class="lib-ctb__desc"><span class="lib-ctb__kb">${esc(kbById(d.kb)?.name || '—')}</span>${dot}<span class="truncate">${esc(X.ctb.eventLine(d))}</span></span>`,
          trail: ctbAction(d), act: 'ctb-open', data: { id: d.id }, cls: 'lib-ctb',
        })), 'lib-list');
      },
    });
    return `<div class="page page--wide lib">${head}${body}</div>`;
  };
  /** ?open=<id> (Home, Inbox, the Reader's Track, the submit toast) opens that contribution once, then leaves the address clean. */
  AFTER.contributions = ({ query }) => {
    if (!query.open) return;
    const id = query.open, q = { ...query }; delete q.open;
    const qs = new URLSearchParams(q).toString();
    history.replaceState(null, '', '#' + S.cur.path + (qs ? '?' + qs : ''));
    S.cur.query = q;
    const d = docById(id);
    if (d && canSeeDoc(d)) openDrawer('ctb', { id }); else toast('This contribution isn’t available', { tone: 'danger' });
  };
  A['lib-ctb-seg'] = el => { ui('libCtb').seg = el.dataset.value; refresh(); };

  /* ── Saved ── */
  function savedTab() {
    const uk = 'libSaved', u = ui(uk, { sort: 'saved', sel: {} });
    const all = savedResources();
    const toks = tokens(u.q || '');
    let rows = all.filter(d => !toks.length || scoreRes(d, toks) > 0);
    if (u.sort === 'updated') rows = [...rows].sort((a, b) => b.updated - a.updated);
    else if (u.sort === 'title') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    const empty = () => emptyState({ icon: 'bookmark', title: 'Nothing saved yet', desc: 'Save resources you come back to. They stay here.', actions: btn('Browse knowledge', { v: 'primary', href: '/knowledge' }), boxed: true });
    const ids = new Set(all.map(d => d.id)); const sel = selIds(uk).filter(id => ids.has(id));
    const tools = longOr(all.length, u.q || sel.length);
    const toolbar = tools ? `<div class="toolbar">${searchField({ uiKey: uk, placeholder: 'Search saved' })}<div class="toolbar__end">${btn(SAVED_SORTS[u.sort] || SAVED_SORTS.saved, { v: 'ghost', size: 'sm', icon: 'sort', menu: 'lib-sort', aria: `aria-label="Sort: ${esc(SAVED_SORTS[u.sort])}"` })}</div></div>` : '';
    return gate({
      loading: () => skelRows(6), empty,
      ok: () => {
        if (!all.length) return empty();
        // Short lists act per row (⋯); selecting several only helps in a long one.
        const listHtml = rows.length ? X.res.rows(rows, { q: u.q || '', select: tools ? uk : undefined }) : noMatches(uk, [], 'saved resources');
        const bar = sel.length ? bulkBar(uk, btn('Remove from saved', { v: 'ghost', size: 'sm', icon: 'bookmark', act: 'lib-unsave' })) : '';
        return toolbar + listHtml + bar;
      },
    });
  }
  MENUS['lib-sort'] = () => [{ section: 'Sort by' }, ...Object.entries(SAVED_SORTS).map(([v, l]) => ({ label: l, checked: ui('libSaved').sort === v, run: () => { ui('libSaved').sort = v; refresh(); } }))];
  A['lib-unsave'] = () => {
    const u = ui('libSaved'), ids = selIds('libSaved'), l = mine('saved'), before = [...l];
    const n = ids.filter(id => l.includes(id)).length; if (!n) return;
    D.saved[me().id] = l.filter(id => !ids.includes(id)); u.sel = {}; persist(); refresh();
    toast(`Removed ${plural(n, 'resource')} from saved`, { action: { label: 'Undo', run: () => { D.saved[me().id] = before; persist(); refresh(); } } });
  };

  /* ── My files ── */
  function filesTab(kb) {
    const uk = 'libFiles', u = ui(uk);
    const all = kb ? docsIn(kb.id).sort((a, b) => b.updated - a.updated) : [];
    const upload = btn('Upload', { v: 'primary', icon: 'upload', act: 'contribute', data: { private: '1' } });
    const empty = () => emptyState({ icon: 'upload', title: 'No files yet', desc: 'Upload notes or drafts to ask about them. Only you can see them.', actions: upload, boxed: true });
    const rows = all.filter(d => matchesQ(uk, d.name));
    return gate({
      loading: () => skelRows(4), empty,
      ok: () => {
        if (!all.length) return empty();
        // Process is the next step for a file that isn't ready (always shown); Share as knowledge is secondary (on hover, with ⋯).
        const process = d => (['pending', 'failed', 'outdated'].includes(d.status) ? btn('Process', { v: 'secondary', size: 'sm', icon: 'play', act: 'lib-process', data: { id: d.id } }) : '');
        const canShare = canContribute() && contributionTargets().length > 0;
        const share = d => (canShare ? btn('', { v: 'ghost', size: 'sm', icon: 'share', act: 'ctb-share', data: { id: d.id }, tip: 'Share as knowledge…', muted: true }) : '');
        const search = longOr(all.length, u.q) ? searchField({ uiKey: uk, placeholder: 'Search my files' }) : '';
        return tabBar(`${search}<span class="t-sm muted row gap-4 lib-private">${ic('lock', 'i-sm')}Only you can see these</span>`)
          + (rows.length ? X.res.rows(rows, d => ({ trail: process(d), reveal: share(d), hide: ['kb'] })) : noMatches(uk, [], 'files'));
      },
    });
  }
  A['lib-process'] = el => { const d = docById(el.dataset.id); if (d && !X.processDocs([d], { msg: `Processing “${d.name}”` })) toast('This file can’t be processed', { tone: 'danger' }); };
})();

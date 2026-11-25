/* Document preview — one quick-reading overlay for every place a document is referenced: chat citations and source chips,
   Browse cards and rows, search results, My library, Related, spaces' materials, Work review cells and drafts, request
   checks. Content first: it opens in Content View (content.js) — the document's extracted blocks, the cited ones highlighted
   by ref and scrolled into view, "Show earlier part / Show later part" to read around them. The reading bar steps through
   the cited blocks (document by document). One primary action — Open full document, at the same block. Secondary: the
   Content | Original toggle (the Original is the native preview, loaded only when chosen, marked only for PDFs); Ask and
   Download live in ⋯. Editing, sharing and versions live in the Reader.

   X.preview.open({ cites?: [Citation], n?, from?, id?, q? }) — X.openCitation (content.js) is how citations get here.
   A['doc-preview'] reads data-id / data-q / data-cite (X.cite.data) from the clicked element. Prefix: pv-. */
(() => {
  'use strict';

  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const dot = '<span class="res-dot" aria-hidden="true">·</span>';
  /** The preview window: about a quarter before the cited block, enough after it to read on; paging adds as much again. */
  const WINDOW = 16;
  const pv = () => S.ui.docPrev;
  /** What the preview shows now: the citation in focus (and its document), a search's best match, or a document from the top. */
  function current() {
    const p = pv(); if (!p) return null;
    if (p.cites) { const c = p.cites[Math.max(0, Math.min(p.i, p.cites.length - 1))]; return { id: c.item, cite: c, match: p.match || '' }; }
    return { id: p.id, cite: null, match: '' };
  }
  /** The Reader address for what's in view, so Open full document lands on the same block. */
  function fullHref(c, mode) {
    const p = pv(), x = c.cite;
    const q = { anchor: x?.refs?.[0] || '', v: x && !c.match ? x.revision : '', sv: x && !c.match ? x.structureVersion : '', q: c.match, from: p?.from || '', view: mode === 'original' ? 'original' : '' };
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    return '/doc/' + c.id + (qs ? '?' + qs : '');
  }

  /** Documents whose content (or Original) was fetched this session open at once; the first time shows the quote and a skeleton
      (GetItemContent, ~380 ms here) or the cover (the Original). */
  const fetched = new Set(), originals = new Set();
  function fetchFor(st, set, flag) {
    const id = current()?.id; if (!id || set.has(id)) return;
    set.add(id); st[flag] = true;
    setTimeout(() => { if (pv() === st && st[flag]) { st[flag] = false; st.scroll = true; refreshLayer(); } }, 380);
  }
  function open(p) {
    let cites = (p.cites || []).filter(c => c?.item);
    let match = '';
    if (!cites.length && p.id && (p.q || '').trim()) {
      // A search opens on its best-matching block (SearchItems' ContentReference).
      const d = docById(p.id), hit = d && X.cite.best(d, p.q);
      if (hit) { cites = [X.cite.fromChunk(d, hit)]; match = p.q.trim(); }
    }
    // Step through the cited blocks document by document, in the order the answer first cites each document.
    const order = [...new Set(cites.map(c => c.item))];
    cites = cites.map((c, k) => ({ c, k })).sort((a, b) => order.indexOf(a.c.item) - order.indexOf(b.c.item) || a.k - b.k).map(x => x.c);
    const i = Math.max(0, cites.findIndex(c => c.n != null && +c.n === +p.n));
    S.ui.docPrev = { id: p.id || cites[0]?.item, cites: cites.length ? cites : null, i, match, from: p.from || '', mode: 'content', range: null, scroll: true, loading: false, origLoading: false, keep: null };
    // A document drawer underneath (older entry points) would only compete with the preview.
    if (S.drawer) { S.drawer = null; renderLayer(); }
    fetchFor(S.ui.docPrev, fetched, 'loading');
    openModal('doc-preview', {});
  }
  X.preview = { open };

  /** The window for the focused citation (or the document's start), kept across re-renders and widened by paging. */
  function windowFor(p, d, c) {
    if (!p.range) {
      const w = X.content.get(d, { revision: c?.revision, version: c?.structureVersion, anchor: c?.refs?.[0], size: WINDOW });
      p.range = w.error ? { start: 0, end: WINDOW } : { start: w.startIndex, end: w.startIndex + w.nodes.length };
    }
    return X.content.get(d, { revision: c?.revision, version: c?.structureVersion, start: p.range.start, size: p.range.end - p.range.start });
  }

  M['doc-preview'] = () => {
    const p = pv(), cur = current(), d = cur && docById(cur.id), c = cur?.cite;
    if (!d || !canOpenRes(d)) {
      // A citation still shows its quote, so the claim can be checked even when the document itself isn't shared with you.
      const kb = d && kbById(d.kb), ask = kb && kbRole(kb) === 'none';
      return {
        size: 'md', icon: 'lock', tone: 'default', title: d ? bareName(d.name) : 'Document unavailable',
        desc: d ? 'This document isn’t shared with you.' : 'It was removed, or it isn’t shared with you.',
        body: c?.quote ? `${X.cite.quoteCard(c)}${ask ? `<p class="pv-quote__note">Ask the owners of ${esc(kb.name)} for access to read the whole document.</p>` : ''}` : '',
        footStart: ask ? btn('Request access', { v: 'ghost', icon: 'lock', act: 'kb-request', data: { kb: kb.id } }) : '',
        foot: btn('Close', { v: 'primary', act: 'close-modal' }),
      };
    }
    const r = res(d), t = trustOf(d), original = p.mode === 'original', m = X.docModel(d);
    const trust = t.state === 'verified' || t.state === 'review' ? X.res.trustChip(d) : '';
    const desc = `<span class="pv-meta">${r.kb && !r.kb.personal ? `<span translate="no">${esc(r.kb.name)}</span>` + dot : ''}Updated ${esc(relLow(d.updated))}${trust ? `<span class="pv-meta__trust">${trust}</span>` : ''}</span>`;

    /* Reading bar: what's highlighted and how to step through it; the Content | Original toggle at its end. */
    const list = p.cites || [], n = list.length;
    let label = '';
    if (c && cur.match) label = `<span class="pv-bar__label">${ic('search', 'i-sm')}<span class="truncate">Best match for “${esc(cur.match)}”</span></span>`;
    else if (c) {
      const unmarked = original && !m.pagesShown ? '<span class="pv-bar__hint">Not marked in the original</span>' : '';
      label = `<span class="pv-bar__label">${ic('quote', 'i-sm')}<span>Cited passage</span>${X.cite.where(c) ? `<span class="pv-bar__where truncate"><span aria-hidden="true">· </span>${X.cite.whereHtml(c)}</span>` : ''}</span>${unmarked}`;
    }
    const steps = n > 1 && !cur.match ? `<span class="pv-bar__count num">Passage ${p.i + 1} of ${n}</span>${iconBtn('chevron-up', 'Previous passage', { size: 'sm', act: 'pv-step', data: { d: -1 }, disabled: p.i === 0 })}${iconBtn('chevron-down', 'Next passage', { size: 'sm', act: 'pv-step', data: { d: 1 }, disabled: p.i >= n - 1 })}` : '';
    const bar = `<div class="pv-bar">${label}<span class="grow"></span>${steps}<span class="pv-bar__mode">${X.content.toggle(p.mode, 'pv-mode')}</span></div>`;

    let body;
    if (original) {
      // The file itself as its own app shows it (GetItemPreview), loaded only now: the cover first, then the pages.
      const fmt = X.docFormat(d);
      body = `<div class="pv-doc pv-doc--${fmt}">${p.origLoading || S.pageState === 'loading' ? X.rdr.coverPages(d) : X.rdr.fileView(d, { bar: false })}</div>`;
    } else if (p.loading || S.pageState === 'loading') {
      // The citation already says what was cited: the quote shows at once, the blocks follow.
      body = `<div class="cv">${X.cite.quoteCard(c)}${X.content.skeleton()}</div>`;
    } else {
      const w = windowFor(p, d, c);
      if (w.error) {
        const actions = [
          w.error === 'CONTENT_VERSION_UNAVAILABLE' && isSearchable(d) ? btn('Read the current version', { v: 'secondary', icon: 'file-text', act: 'pv-current' }) : '',
          w.error !== 'NOT_FOUND' ? btn('View the original', { v: w.error === 'CONTENT_VERSION_UNAVAILABLE' && isSearchable(d) ? 'ghost' : 'secondary', icon: 'file', act: 'pv-mode', data: { value: 'original' } }) : '',
        ].join('');
        body = `<div class="cv">${X.cite.quoteCard(c)}${X.content.state(w.error, { actions })}</div>`;
      } else {
        const cited = new Set(list.filter(x => x.item === d.id && !cur.match).flatMap(x => x.refs || []));
        (c?.refs || []).forEach(ref => cited.add(ref));
        body = X.content.pane(w, { cited, focus: c?.refs?.[0] || '', earlier: 'pv-earlier', later: 'pv-later' });
      }
    }
    return {
      size: 'preview',
      icon: fileIcon(d.type),
      tone: 'default',
      title: bareName(d.name),
      desc,
      head: bar,
      body,
      foot: iconBtn('more', 'More actions', { menu: 'pv-more', data: { id: d.id } }) + btn('Open full document', { v: 'primary', icon: 'arrow-up-right', act: 'pv-open' }),
      after: root => settle(root, d, c, m),
    };
  };

  /** After a render: keep the reader's place when a part was added above, otherwise bring the focused block (or, in a PDF's
      Original, the cited passage on its page) into view — on open, on a step and on a toggle only. */
  function settle(root, d, c, m) {
    const p = pv(), scroller = root?.querySelector('.modal__body'); if (!p || !scroller) return;
    if (p.keep) {
      const el = scroller.querySelector(`[data-ref="${CSS.escape(p.keep.ref)}"]`);
      if (el) scroller.scrollTop += el.getBoundingClientRect().top - p.keep.top;
      p.keep = null; return;
    }
    if (p.mode === 'original' && !p.origLoading && c && m.pagesShown) {
      const body = root.querySelector('.pv-doc'), marks = c.quote ? X.rdr.markQuote(body, c.quote) : [];
      marks[0]?.classList.add('is-focus');
      if (p.scroll) { p.scroll = false; X.content.reveal(scroller, marks[0] || body.querySelector(`[data-page="${CSS.escape(String(c.pageNumber || ''))}"]`)); }
      return;
    }
    if (!p.scroll || p.loading || p.origLoading) return;
    p.scroll = false;
    const focus = p.mode === 'content' && c?.refs?.[0] && scroller.querySelector(`.cv-doc [data-ref="${CSS.escape(c.refs[0])}"]`);
    if (focus) X.content.reveal(scroller, focus); else scroller.scrollTop = 0;
  }

  A['pv-step'] = el => {
    const p = pv(); if (!p?.cites) return;
    const i = p.i + +el.dataset.d; if (!p.cites[i]) return;
    p.i = i; p.range = null; p.scroll = true;
    fetchFor(p, p.mode === 'original' ? originals : fetched, p.mode === 'original' ? 'origLoading' : 'loading');
    refreshLayer();
  };
  /** Content | Original. The Original is fetched the first time it's chosen for a document. */
  A['pv-mode'] = el => {
    const p = pv(), mode = el.dataset.value === 'original' ? 'original' : 'content'; if (!p || p.mode === mode) return;
    p.mode = mode; p.scroll = true;
    if (mode === 'original') fetchFor(p, originals, 'origLoading');
    refreshLayer();
  };
  /** Page the window: the part before (keeping the reader's place) or after the blocks in view. */
  A['pv-earlier'] = () => {
    const p = pv(); if (!p?.range) return;
    const first = $('#layer .cv-doc > [data-ref]');
    if (first) p.keep = { ref: first.dataset.ref, top: first.getBoundingClientRect().top };
    p.range.start = Math.max(0, p.range.start - WINDOW); refreshLayer();
  };
  A['pv-later'] = () => { const p = pv(); if (!p?.range) return; p.range.end += WINDOW; refreshLayer(); };
  /** The cited content version is gone: read the document as it is now (no highlight — the refs belonged to the old version). */
  A['pv-current'] = () => {
    const p = pv(), cur = current(); if (!p || !cur) return;
    S.ui.docPrev = { ...p, cites: null, id: cur.id, range: null, scroll: true }; refreshLayer();
  };
  A['pv-open'] = () => { const c = current(); if (!c) return; const mode = pv().mode; closeModal(); go(fullHref(c, mode)); };
  MENUS['pv-more'] = el => {
    const d = docById(el.dataset.id); if (!d) return [];
    return [
      isSearchable(d) && { label: 'Ask about this document', icon: 'sparkles', run: () => { closeModal(); go('/doc/' + d.id + '?ask=1'); } },
      { label: 'Download', icon: 'download', run: () => X.downloadDocument?.(d) },
    ].filter(Boolean);
  };
  /** Generic entry point: any element with data-act="doc-preview" data-id="…" (optionally data-q, or data-cite for a citation). */
  A['doc-preview'] = el => {
    const s = el.dataset, c = s.cite && X.cite.parse(s.cite);
    if (c) X.openCitation(c); else open({ id: s.id, q: s.q });
  };
})();

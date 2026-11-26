/* Document preview — one quick-reading overlay for every place a document is referenced: chat citations and source chips,
   Browse cards and rows, search results, My library, Related, spaces' materials, Work review cells and drafts, request
   checks. It shows the document's Original — the one rendering of a document (reader.js) — of the cited revision, with the
   cited passages marked where indexing located them: boxes over the PDF pages, tinted cells in the grid, the quote in a text
   view (backend document_viewer.md "Citations open in the Original"). The reading bar says what is marked and steps through
   the citations (document by document); a passage that can't be marked there shows its quote above the file. One primary
   action — Open full document, at the same passage. Ask and Download live in ⋯. Editing, sharing and versions live in the
   Reader.

   X.preview.open({ cites?: [Citation], n?, from?, id?, q? }) — X.openCitation (content.js) is how citations get here.
   A['doc-preview'] reads data-id / data-q / data-cite (X.cite.data) from the clicked element. Prefix: pv-. */
(() => {
  'use strict';

  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const dot = '<span class="res-dot" aria-hidden="true">·</span>';
  const pv = () => S.ui.docPrev;
  /** What the preview shows now: the citation in focus (and its document), a search's best match, or a document from the top. */
  function current() {
    const p = pv(); if (!p) return null;
    if (p.cites) { const c = p.cites[Math.max(0, Math.min(p.i, p.cites.length - 1))]; return { id: c.item, cite: c, match: p.match || '' }; }
    return { id: p.id, cite: null, match: '' };
  }
  /** The Reader address for what's in view, so Open full document lands on the same passage of the same revision. */
  function fullHref(c) {
    const p = pv(), x = c.cite;
    const q = { anchor: x?.refs?.[0] || '', v: x && !c.match ? x.revision : '', from: p?.from || '' };
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    return '/doc/' + c.id + (qs ? '?' + qs : '');
  }

  /** Documents whose Original was fetched this session open at once; the first time shows the cover (GetItemPreview, ~380 ms here). */
  const fetched = new Set();
  function fetchFor(st) {
    const id = current()?.id; if (!id || fetched.has(id)) return;
    fetched.add(id); st.loading = true;
    setTimeout(() => { if (pv() === st && st.loading) { st.loading = false; st.scroll = true; refreshLayer(); } }, 380);
  }
  function open(p) {
    let cites = (p.cites || []).filter(c => c?.item);
    let match = '';
    if (!cites.length && p.id && (p.q || '').trim()) {
      // A search opens on its best-matching passage (SearchItems' ContentReference), marked like a citation.
      const d = docById(p.id), hit = d && X.cite.best(d, p.q);
      if (hit) { cites = [X.cite.fromChunk(d, hit)]; match = p.q.trim(); }
    }
    // Step through the cited passages document by document, in the order the answer first cites each document.
    const order = [...new Set(cites.map(c => c.item))];
    cites = cites.map((c, k) => ({ c, k })).sort((a, b) => order.indexOf(a.c.item) - order.indexOf(b.c.item) || a.k - b.k).map(x => x.c);
    const i = Math.max(0, cites.findIndex(c => c.n != null && +c.n === +p.n));
    S.ui.docPrev = { id: p.id || cites[0]?.item, cites: cites.length ? cites : null, i, match, from: p.from || '', scroll: true, loading: false };
    // A document drawer underneath (older entry points) would only compete with the preview.
    if (S.drawer) { S.drawer = null; renderLayer(); }
    fetchFor(S.ui.docPrev);
    openModal('doc-preview', {});
  }
  X.preview = { open };

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
    const r = res(d), t = trustOf(d);
    const trust = t.state === 'verified' || t.state === 'review' ? X.res.trustChip(d) : '';
    const desc = `<span class="pv-meta">${r.kb && !r.kb.personal ? `<span translate="no">${esc(r.kb.name)}</span>` + dot : ''}Updated ${esc(relLow(d.updated))}${trust ? `<span class="pv-meta__trust">${trust}</span>` : ''}</span>`;

    /* Reading bar: what's marked and how to step through it. */
    const n = p.cites?.length || 0;
    let label = '';
    if (c && cur.match) label = `<span class="pv-bar__label">${ic('search', 'i-sm')}<span class="truncate">Best match for “${esc(cur.match)}”</span></span>`;
    else if (c) label = `<span class="pv-bar__label">${ic('quote', 'i-sm')}<span>Cited passage</span>${X.cite.where(c) ? `<span class="pv-bar__where truncate"><span aria-hidden="true">· </span>${X.cite.whereHtml(c)}</span>` : ''}</span>`;
    const steps = n > 1 && !cur.match ? `<span class="pv-bar__count num">Passage ${p.i + 1} of ${n}</span>${iconBtn('chevron-up', 'Previous passage', { size: 'sm', act: 'pv-step', data: { d: -1 }, disabled: p.i === 0 })}${iconBtn('chevron-down', 'Next passage', { size: 'sm', act: 'pv-step', data: { d: 1 }, disabled: p.i >= n - 1 })}` : '';
    const bar = label ? `<div class="pv-bar">${label}<span class="grow"></span>${steps}</div>` : '';

    // The file itself as its own app shows it (GetItemPreview of the cited revision): the cover first, then the pages.
    const body = `<div class="pv-doc doc-fixed pv-doc--${X.docFormat(d)}">${p.loading || S.pageState === 'loading' ? X.rdr.coverPages(d) : X.rdr.fileView(d, { bar: false })}</div>`;
    return {
      size: 'preview',
      icon: fileIcon(d.type),
      tone: 'default',
      title: bareName(d.name),
      desc,
      head: bar,
      body,
      foot: iconBtn('more', 'More actions', { menu: 'pv-more', data: { id: d.id } }) + btn('Open full document', { v: 'primary', icon: 'arrow-up-right', act: 'pv-open' }),
      after: root => settle(root, d),
    };
  };

  /** After a render: fit the pages, mark this document's citations (the one in focus stronger) — or show the quote when it can't be
      marked — and bring it into view on open and on a step. */
  function settle(root, d) {
    const p = pv(), scroller = root?.querySelector('.modal__body'), body = root?.querySelector('.pv-doc'); if (!p || !scroller || !body) return;
    X.rdr.fit(body);
    if (p.loading || S.pageState === 'loading') return;
    const c = current()?.cite;
    let el = null;
    if (c) {
      const mine = p.cites.filter(x => x.item === d.id);
      el = X.rdr.mark(body.querySelector('.doc-viewer'), d, mine, mine.indexOf(c));
      if (!el) { body.insertAdjacentHTML('afterbegin', `<div class="doc-unmarked">${X.cite.quoteCard(c)}</div>`); el = body.firstElementChild; }
    }
    if (!p.scroll) return;
    p.scroll = false;
    if (el) X.rdr.bring(scroller, el); else scroller.scrollTop = 0;
  }

  A['pv-step'] = el => {
    const p = pv(); if (!p?.cites) return;
    const i = p.i + +el.dataset.d; if (!p.cites[i]) return;
    p.i = i; p.scroll = true;
    fetchFor(p);
    refreshLayer();
  };
  /** Open full document: the Reader at the same passage (pinned, so a table row stays the row that was cited). */
  A['pv-open'] = () => { const c = current(); if (!c) return; if (c.cite) X.rdr.pin(c.cite); closeModal(); go(fullHref(c)); };
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

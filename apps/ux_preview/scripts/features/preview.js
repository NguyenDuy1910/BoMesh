/* Document preview — one quick-reading overlay for every place a document is referenced: Browse cards and rows,
   search results, My library and collection lists, Related, spaces' materials, chat citations, work and request
   citations. Preview first, open full later: the document's own pages (native format) scroll inside a centered
   dialog (a near-full-screen sheet on phones) over the page the person came from; the cited passage or the
   matching words are highlighted and scrolled into view. One primary action — Open full document — and one
   optional secondary — Ask about this document. Editing, sharing, collections and versions live in the Reader.

   X.preview.open({ id, q?, page?, quote?, from?, cites?: [{ doc, page, quote, n }], i? })
   A['doc-preview'] reads data-id / data-q / data-page / data-quote from the clicked element. Prefix: pv-. */
(() => {
  'use strict';

  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const dot = '<span class="res-dot" aria-hidden="true">·</span>';
  const pv = () => S.ui.docPrev;
  /** What the preview shows now: one passage of a citation list, or the single document it was opened with. */
  function current() {
    const p = pv(); if (!p) return null;
    const list = p.cites || [];
    if (list.length) { const c = list[Math.max(0, Math.min(p.i, list.length - 1))]; return { id: c.doc, quote: c.quote || '', page: c.page || '', q: '', from: p.from }; }
    return { id: p.id, quote: p.quote || '', page: p.page || '', q: p.q || '', from: p.from };
  }
  /** The Reader address for the passage in view, so Open full document lands on the same highlight. */
  function fullHref(c) {
    const q = c.quote || c.q;
    const qs = new URLSearchParams(Object.entries({ q, page: c.quote ? c.page : '', from: c.from || '' }).filter(([, v]) => v)).toString();
    return '/doc/' + c.id + (qs ? '?' + qs : '');
  }

  function open(p) {
    const cites = p.cites || [];
    S.ui.docPrev = { id: p.id, q: (p.q || '').trim(), page: p.page || '', quote: p.quote || '', from: p.from || '', cites: cites.length ? cites : null, i: Math.max(0, cites.findIndex(c => c.n === p.n)), hit: 0, scroll: true };
    // A document drawer underneath (older entry points) would only compete with the preview.
    if (S.drawer) { S.drawer = null; renderLayer(); }
    openModal('doc-preview', {});
  }
  X.preview = { open };

  M['doc-preview'] = () => {
    const p = pv(), c = current(), d = c && docById(c.id);
    if (!d || !canOpenRes(d)) {
      // A citation still shows its quote, so the claim can be checked even when the document itself isn't shared with you.
      const kb = d && kbById(d.kb);
      return {
        size: 'md', icon: 'lock', tone: 'default', title: d ? bareName(d.name) : 'Document unavailable',
        desc: d ? 'This document isn’t shared with you.' : 'It was removed, or it isn’t shared with you.',
        body: c?.quote ? `<blockquote class="pv-quote"><mark class="evidence is-focus">${esc(c.quote)}</mark></blockquote>${kb && kbRole(kb) === 'none' ? `<p class="pv-quote__note">Ask the owners of ${esc(kb.name)} for access to read the whole document.</p>` : ''}` : '',
        footStart: kb && kbRole(kb) === 'none' ? btn('Request access', { v: 'ghost', icon: 'lock', act: 'kb-request', data: { kb: kb.id } }) : '',
        foot: btn('Close', { v: 'primary', act: 'close-modal' }),
      };
    }
    const r = res(d), t = trustOf(d), k = kindMeta(r.kind), readable = isSearchable(d);
    const trust = t.state === 'verified' || t.state === 'review' ? X.res.trustChip(d) : '';
    const desc = `<span class="pv-meta">${esc(k.label)}${r.kb && !r.kb.personal ? dot + esc(r.kb.name) : ''}${dot}Updated ${esc(relLow(d.updated))}${trust ? `<span class="pv-meta__trust">${trust}</span>` : ''}</span>`;

    // The reading bar: what's highlighted and how to step through it. Citations step passage by passage (they may span documents);
    // a search steps through its matches (counted once the pages are marked, see after()).
    const list = p.cites || [], n = list.length;
    let bar = '';
    if (c.quote) {
      const where = c.page ? `Cited passage · page ${c.page}` : 'Cited passage';
      const step = n > 1 ? `<span class="pv-bar__count num">Passage ${p.i + 1} of ${n}</span>${iconBtn('chevron-up', 'Previous passage', { size: 'sm', act: 'pv-step', data: { d: -1 }, disabled: p.i === 0 })}${iconBtn('chevron-down', 'Next passage', { size: 'sm', act: 'pv-step', data: { d: 1 }, disabled: p.i >= n - 1 })}` : '';
      bar = `<div class="pv-bar"><span class="pv-bar__label">${ic('quote', 'i-sm')}<span class="truncate">${esc(where)}</span></span><span class="grow"></span>${step}</div>`;
    } else if (c.q && readable) {
      bar = `<div class="pv-bar"><span class="pv-bar__label">${ic('search', 'i-sm')}<span class="truncate">Matches for “${esc(c.q)}”</span></span><span class="grow"></span><span class="pv-bar__count num" id="pv-hits" aria-live="polite"></span>${iconBtn('chevron-up', 'Previous match', { size: 'sm', act: 'pv-hit', data: { d: -1 }, cls: 'pv-hitnav' })}${iconBtn('chevron-down', 'Next match', { size: 'sm', act: 'pv-hit', data: { d: 1 }, cls: 'pv-hitnav' })}</div>`;
    }

    let body;
    if (readable && X.rdr?.viewer) {
      const m = X.docModel(d);
      if (c.quote) X.rdr.injectQuote(m, c.quote, c.page);
      body = `<div class="pv-doc pv-doc--${m.format}">${X.rdr.viewer(m, { bar: false })}</div>`;
    } else {
      const about = X.res.blurb?.(d) || '';
      body = `<div class="pv-none">${fileIcon(d.type, 'lg')}<p class="pv-none__title">There’s no preview for this file yet</p>${about ? `<p class="pv-none__about">${esc(about)}</p>` : ''}<p class="pv-none__hint">Open it to read or download it.</p></div>`;
    }
    return {
      size: 'preview',
      icon: fileIcon(d.type),
      tone: 'default',
      title: bareName(d.name),
      desc,
      head: bar,
      body,
      footStart: readable ? btn('Ask about this document', { v: 'ghost', icon: 'sparkles', act: 'pv-ask', cls: 'pv-ask', aria: 'aria-label="Ask about this document"' }) : '',
      foot: btn('Open full document', { v: 'primary', icon: 'arrow-up-right', act: 'pv-open' }),
      after: root => highlight(root, d, c),
    };
  };

  /** Mark the passage (or the query's words) in the rendered pages and bring the focused one into view — on open and on every step only,
      so re-renders keep the reader's own scroll position. */
  function highlight(root, d, c) {
    const p = pv(), body = root?.querySelector('.pv-doc'); if (!p || !body || !X.rdr?.markHits) return;
    const scroller = root.querySelector('.modal__body');
    let needles = [];
    if (c.quote) needles = [c.quote];
    else if (c.q) needles = X.rdr.needles(d, { q: c.q }, { text: X.docText?.(d) || '' }).map(n => n.text);
    const marks = needles.length ? X.rdr.markHits(body, needles) : [];
    if (marks.length) p.hit = ((p.hit % marks.length) + marks.length) % marks.length;
    const count = $('#pv-hits', root);
    if (count) {
      count.textContent = marks.length ? `${p.hit + 1} of ${marks.length}` : 'No matches on these pages';
      $$('.pv-hitnav', root).forEach(b => { b.disabled = marks.length < 2; });
    }
    let target = null;
    if (marks.length) { const f = marks[p.hit]; f.classList.add('is-focus'); target = f; }
    else if (c.page) target = body.querySelector(`[data-page="${CSS.escape(String(c.page))}"]`);
    if (p.scroll && scroller) {
      p.scroll = false;
      if (target) {
        const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: 'instant' });
      } else scroller.scrollTop = 0;
    }
  }

  A['pv-step'] = el => { const p = pv(); if (!p?.cites) return; const i = p.i + +el.dataset.d; if (!p.cites[i]) return; p.i = i; p.hit = 0; p.scroll = true; refreshLayer(); };
  A['pv-hit'] = el => { const p = pv(); if (!p) return; p.hit += +el.dataset.d; p.scroll = true; refreshLayer(); };
  A['pv-open'] = () => { const c = current(); if (!c) return; closeModal(); go(fullHref(c)); };
  A['pv-ask'] = () => { const c = current(); if (!c) return; closeModal(); go('/doc/' + c.id + '?ask=1'); };
  /** Generic entry point: any element with data-act="doc-preview" data-id="…" (optionally data-q, data-page, data-quote). */
  A['doc-preview'] = el => { const s = el.dataset; open({ id: s.id || s.doc, q: s.q, page: s.page, quote: s.quote }); };
})();

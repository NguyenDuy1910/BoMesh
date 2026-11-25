/* Content View — the content-first way to read a document and check a citation (rag_review/doc_arch
   UNIFIED_DOCUMENT_DESIGN.md §8.1 and §10; backend contract §3). A citation already carries what to show at once —
   quote, location, refs — so it appears with no request; the Structured Document projection follows (GetItemContent: a
   window of ContentNodes around the cited block) and one DocumentRenderer draws it, the cited blocks highlighted by ref,
   never by matching text. The Original ("Bản gốc") stays the existing native preview: a toggle, loaded only when asked
   for, and marked only where its pages are the parsed ones (PDF).

   Citation (mock data = API Citation / ContentReference): { item, revision, structureVersion, refs, quote, location,
   pageNumber? }. The seed writes what an author knows — { item, pageNumber, quote } — and X.cite.resolve fills the rest
   from the document's index the way ingestion does: refs, location, revision, structureVersion, and pageNumber only when
   the parsed bytes are the ones the Original shows.

   X.cite:    resolve(c) · data(c) · parse(str) · where(c) · whereHtml(c) · fromChunk(doc, chunk) · best(doc, q) · quoteCard(c)
   X.content: get(doc, { revision, version, anchor, start, size, view }) → ItemContent | { error } · nodesHtml(nodes, marks)
              · pane(content, o) · state(error, o) · toggle(mode, act) · skeleton()
   X.openCitation(cites, { n, from }) — the one way every surface opens a citation (the shared preview, preview.js).
   Prefix: cv-. */
(() => {
  'use strict';

  /* ═══════════════ Citations ═══════════════ */
  const docOf = c => (c?.item ? docById(c.item) : null);
  /** The indexed block a quote was read from: the chunk holding it, else the one holding its first words, else the closest one. */
  function chunkFor(m, quote) {
    const q = fold(quote || '').replace(/\s+/g, ' ').trim();
    if (!q) return null;
    const hit = m.chunks.find(ch => fold(ch.text).includes(q) || fold(ch.quote).includes(q))
      || m.chunks.find(ch => fold(ch.text).includes(q.slice(0, 60)));
    return hit || best(m, quote);
  }
  function best(m, text) {
    const toks = tokens(text || ''); let top = null, n = 0;
    m.chunks.forEach(ch => { const low = fold(ch.text), k = toks.filter(t => low.includes(t)).length; if (k > n) { top = ch; n = k; } });
    return top;
  }
  /** Fill a seed citation in place from its document's index; a citation that already has its target is left as it is. */
  function resolve(c) {
    if (!c?.item || (c.refs?.length && c.structureVersion && c.revision)) return c;
    const d = docOf(c); if (!d) return c;
    const m = X.docModel(d), ch = chunkFor(m, c.quote) || m.chunks[0];
    if (!ch) return c;
    c.revision ??= m.revision;
    c.structureVersion ??= m.structureVersion;
    c.refs = [...ch.refs];
    c.location = ch.location;
    if (!c.quote) c.quote = ch.quote;
    if (m.pagesShown) c.pageNumber = ch.page; else delete c.pageNumber;
    return c;
  }
  /** A citation made from one of the document's own chunks (Ask in the reader, search hits, answers built from a document). */
  function fromChunk(doc, ch) {
    const m = X.docModel(doc);
    return { item: doc.id, revision: m.revision, structureVersion: m.structureVersion, refs: [...ch.refs], quote: ch.quote, location: ch.location, ...(m.pagesShown ? { pageNumber: ch.page } : {}) };
  }
  const slim = c => ({ item: c.item, revision: c.revision, structureVersion: c.structureVersion, refs: c.refs, quote: c.quote, location: c.location, ...(c.pageNumber ? { pageNumber: c.pageNumber } : {}) });
  /** Where the cited passage is, as plain text (attributes, exports): "Per diem · page 4". */
  const where = c => [c?.location, c?.pageNumber ? `page ${c.pageNumber}` : ''].filter(Boolean).join(' · ');
  /** Same, as HTML: the location is the document's own words (never translated), the page is interface copy. */
  const whereHtml = c => [c?.location ? `<span translate="no">${esc(c.location)}</span>` : '', c?.pageNumber ? `<span>page ${c.pageNumber}</span>` : ''].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  /** The quote itself, shown before anything loads — and all that's left when the document or its cited version can't be read. */
  const quoteCard = c => (c?.quote ? `<figure class="cv-quote"><blockquote translate="no">${esc(c.quote)}</blockquote>${where(c) ? `<figcaption>${whereHtml(c)}</figcaption>` : ''}</figure>` : '');
  X.cite = {
    resolve,
    fromChunk,
    /** The best chunk of a document for a query (the search hit's ContentReference), or null. */
    best: (doc, q) => (doc && isSearchable(doc) && tokens(q || '').length ? best(X.docModel(doc), q) : null),
    /** A citation as a data-attribute value, and back (buttons can't hold objects). */
    data: c => JSON.stringify(slim(resolve(c))),
    parse: s => { try { const c = JSON.parse(s || 'null'); return c?.item ? c : null; } catch (_) { return null; } },
    where: c => where(resolve(c)),
    whereHtml: c => whereHtml(resolve(c)),
    quoteCard,
    /** The Reader at the cited block (the same version it was read from). */
    href: (c, from = '') => {
      resolve(c);
      const q = new URLSearchParams(Object.entries({ anchor: c.refs?.[0], v: c.revision, sv: c.structureVersion, from }).filter(([, v]) => v)).toString();
      return '/doc/' + c.item + (q ? '?' + q : '');
    },
  };
  /** Every surface opens a citation the same way: the shared preview in Content View, at the cited block. */
  X.openCitation = (cites, { n, from } = {}) => {
    const list = (Array.isArray(cites) ? cites : [cites]).filter(c => c?.item).map(resolve);
    if (list.length) X.preview.open({ cites: list, n, from });
  };

  /* ═══════════════ GetItemContent (mock) ═══════════════ */
  const PAGE_SIZE = 40;
  const project = (n, pages) => {
    const { page, children, ...rest } = n, out = { ...rest };
    if (children) out.children = children.map(c => project(c, pages));
    if (pages && page) out.pageNumber = page;
    return out;
  };
  /** Index of the top-level node holding a ref (a list item lives inside its list). */
  const unitIndex = (m, ref) => m.nodes.findIndex(n => n.id === ref || n.children?.some(c => c.id === ref));
  /** ItemContent { name, revision, structureVersion, totalNodes, startIndex, nodes, previousPageToken?, nextPageToken? } or
      { error }: CONTENT_NOT_PROCESSED · CONTENT_VERSION_UNAVAILABLE · UNSUPPORTED · NOT_FOUND · INVALID_ARGUMENT.
      Page tokens are start indexes here. With an anchor the window starts size/4 blocks before the anchor's block. */
  function get(doc, { revision, version, anchor, start, size = PAGE_SIZE, view = 'FULL' } = {}) {
    if (!doc || doc.archived) return { error: 'NOT_FOUND' };
    if (UNPROCESSABLE.includes(String(doc.type || '').toLowerCase()) || doc.status === 'unsupported') return { error: 'UNSUPPORTED' };
    if (!version && !isSearchable(doc)) return { error: 'CONTENT_NOT_PROCESSED' };
    const m = X.docModel(doc), rev = +revision || m.revision;
    if (rev > m.revision) return { error: 'NOT_FOUND' };
    const fp = X.docFingerprint(doc, rev);
    if (version && version !== fp) return { error: 'CONTENT_VERSION_UNAVAILABLE' };
    const base = { name: `workspaces/${S.ws}/items/${doc.id}/content`, revision: rev, structureVersion: fp, totalNodes: m.nodes.length };
    if (view === 'OUTLINE') return { ...base, startIndex: 0, nodes: m.nodes.filter(n => n.kind === 'HEADING').map(n => project(n, m.pagesShown)) };
    let from = Math.max(0, +start || 0);
    if (anchor) { const i = unitIndex(m, anchor); if (i < 0) return { error: 'INVALID_ARGUMENT' }; from = Math.max(0, i - Math.floor(size / 4)); }
    from = Math.min(from, Math.max(0, m.nodes.length - 1));
    const to = Math.min(m.nodes.length, from + size);
    return { ...base, startIndex: from, nodes: m.nodes.slice(from, to).map(n => project(n, m.pagesShown)), ...(from > 0 ? { previousPageToken: String(Math.max(0, from - size)) } : {}), ...(to < m.nodes.length ? { nextPageToken: String(to) } : {}) };
  }

  /* ═══════════════ DocumentRenderer ═══════════════
     Heading · Paragraph (runs) · List · Table (row/col spans) · Code · Formula · Picture (lazy <img>). Every block carries its
     ref (data-ref); `marks.cited` (refs) get the evidence tint, `marks.focus` the strong one. Text is escaped; links are http(s). */
  const runs = n => X.runsHtml(n.runs);
  function nodesHtml(nodes, marks = {}) {
    const cited = marks.cited || new Set(), focus = marks.focus || '';
    const cls = (base, id) => cx(base, 'cv-block', cited.has(id) && 'is-cited', focus === id && 'is-focus');
    const attrs = n => `data-ref="${esc(n.id)}"${n.pageNumber ? ` data-page="${n.pageNumber}"` : ''}`;
    const one = n => {
      switch (n.kind) {
        case 'HEADING': { const h = `h${Math.min(6, (n.level || 1) + 1)}`; return `<${h} class="${cls('cv-h cv-h--' + (n.level || 1), n.id)}" ${attrs(n)}>${runs(n)}</${h}>`; }
        case 'LIST': { const tag = n.ordered ? 'ol' : 'ul'; return `<${tag} class="${cls('cv-list', n.id)}" ${attrs(n)}>${(n.children || []).map(c => `<li class="${cls('cv-li', c.id)}" ${attrs(c)}>${runs(c)}</li>`).join('')}</${tag}>`; }
        case 'TABLE': {
          const head = n.rows?.[0]?.cells.every(c => c.header) ? n.rows[0] : null, body = head ? n.rows.slice(1) : n.rows || [];
          const cell = (c, tag) => `<${tag}${c.rowSpan ? ` rowspan="${c.rowSpan}"` : ''}${c.colSpan ? ` colspan="${c.colSpan}"` : ''}>${esc(c.text)}</${tag}>`;
          const more = n.totalRows > (n.rows || []).length ? `<p class="cv-table__more">Showing ${n.rows.length} of ${n.totalRows} rows</p>` : '';
          const cap = [n.sheet, n.caption].filter(Boolean).map(esc).join(' · ');
          return `<figure class="${cls('cv-table', n.id)}" ${attrs(n)}><div class="cv-table__scroll"><table>${head ? `<thead><tr>${head.cells.map(c => cell(c, 'th')).join('')}</tr></thead>` : ''}<tbody>${body.map(r => `<tr>${r.cells.map(c => cell(c, c.header ? 'th' : 'td')).join('')}</tr>`).join('')}</tbody></table></div>${cap ? `<figcaption>${cap}</figcaption>` : ''}${more}</figure>`;
        }
        case 'CODE': return `<pre class="${cls('cv-code', n.id)}" ${attrs(n)}${n.language ? ` data-lang="${esc(n.language)}"` : ''}><code>${runs(n)}</code></pre>`;
        case 'FORMULA': return `<div class="${cls('cv-formula', n.id)}" ${attrs(n)}>${runs(n)}</div>`;
        case 'PICTURE': {
          const im = n.image && /^(https?:|data:image\/)/.test(n.image.uri) ? n.image : null;
          return `<figure class="${cls('cv-picture', n.id)}" ${attrs(n)}>${im ? `<img src="${esc(im.uri)}" alt="${esc(n.caption || '')}" width="${im.widthPixels}" height="${im.heightPixels}" loading="lazy" decoding="async">` : ''}${n.caption ? `<figcaption>${esc(n.caption)}</figcaption>` : ''}</figure>`;
        }
        default: return `<p class="${cls('cv-p', n.id)}" ${attrs(n)}>${runs(n)}</p>`;
      }
    };
    return nodes.map(one).join('');
  }

  /* ═══════════════ Shared pieces of the view (preview and reader) ═══════════════ */
  /** The body: a quiet note on what this is, the window of blocks, and paging to the parts before and after it. */
  function pane(content, { cited, focus, earlier, later }) {
    const end = content.startIndex + content.nodes.length;
    return `<div class="cv">
      <p class="cv-note">${ic('info', 'i-xs')}<span>Extracted content — the layout may differ from the original</span></p>
      ${content.startIndex > 0 ? `<div class="cv-more">${btn('Show earlier part', { v: 'ghost', size: 'sm', icon: 'chevron-up', act: earlier })}</div>` : ''}
      <article class="cv-doc" translate="no">${nodesHtml(content.nodes, { cited, focus })}</article>
      ${end < content.totalNodes ? `<div class="cv-more">${btn('Show later part', { v: 'ghost', size: 'sm', icon: 'chevron-down', act: later })}</div>` : ''}
    </div>`;
  }
  const STATES = {
    CONTENT_NOT_PROCESSED: { icon: 'clock', title: 'Not processed yet', desc: 'Its content can be read here once it’s processed. You can open the original file now.' },
    CONTENT_VERSION_UNAVAILABLE: { icon: 'history', title: 'The cited content version is no longer available', desc: 'The document was processed again after it was cited. The quote above is what was cited.' },
    UNSUPPORTED: { icon: 'file', title: 'This file type can’t be shown as content', desc: 'Open the original, or download it to open it in its own app.' },
    NOT_FOUND: { icon: 'file', title: 'This document isn’t available', desc: 'It may have been archived or removed.' },
    INVALID_ARGUMENT: { icon: 'file', title: 'The cited passage isn’t in this document', desc: 'Read the document from the start, or open the original.' },
  };
  /** A state instead of the blocks (the quote, when there is one, stays above it). `actions`: buttons for the way on. */
  const state = (error, { actions = '' } = {}) => {
    const s = STATES[error] || STATES.NOT_FOUND;
    return `<div class="cv-state">${emptyState({ icon: s.icon, title: s.title, desc: s.desc, actions, compact: true })}</div>`;
  };
  /** Loading: the blocks' shape while the window arrives. */
  const skeleton = () => `<div class="cv-doc cv-doc--busy" aria-busy="true" aria-label="Loading"><span class="skeleton skeleton--title" style="width:45%"></span>${[94, 88, 97, 72, 0, 90, 84, 61].map(w => (w ? `<span class="skeleton skeleton--line" style="width:${w}%"></span>` : '<span class="cv-gap"></span>')).join('')}</div>`;
  /** Content (default) | Original: the Original is the file as its own app shows it, loaded only when chosen. */
  const toggle = (mode, act) => seg({ value: mode, options: [['content', 'Content', 'file-text'], ['original', 'Original', 'file']], act, size: 'sm', label: 'View as' });
  /** Scroll a block into view inside `scroller` (a third from the top), without moving the page around it. */
  function reveal(scroller, el, smooth = false) {
    if (!scroller || !el) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: smooth ? 'smooth' : 'instant' });
  }
  X.content = { get, unitIndex: (doc, ref) => unitIndex(X.docModel(doc), ref), nodesHtml, pane, state, skeleton, toggle, reveal, PAGE_SIZE };
})();

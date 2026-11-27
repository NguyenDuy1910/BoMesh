/* Citations and the Content View of artifact revisions.

   A citation (a search hit, a found source) is evidence: it opens the document's Original — the one rendering of a document
   (reader.js) — with the cited passage marked where indexing located it (backend document_viewer.md "Citations open in the
   Original"). It already carries what to show at once — quote and location — so the reading bar and the quote appear with no
   request; the Original of the cited revision follows (GetItemPreview ?revision=), its `highlights` marked.

   Citation (mock data = API Citation / ContentReference): { item, revision, structureVersion, refs, quote, location,
   highlights }. Highlight: { pageNumber, boxes: [{ left, top, right, bottom }] } (fractions of a PDF page from its top-left
   corner; no boxes = the page only) or { sheet, cellRange } (A1 notation from the sheet's A1). A text representation gets
   none: its viewer marks the quote. The seed writes what an author knows — { item, highlights: [{ pageNumber }], quote }, the
   page — and X.cite.resolve fills the rest from the document's index the way ingestion does: refs, location, revision,
   structureVersion and the highlights (X.rdr.locate measures the block's box on its page, once per document version).

   The Content View (GetItemContent → one DocumentRenderer) reads only an artifact revision — a Word, PDF or slide file the
   assistant made (chat-files.js); knowledge documents are read in their Original.

   X.cite:    resolve(c) · data(c) · parse(str) · where(c) · whereHtml(c) · fromChunk(doc, chunk) · highlightsOf(doc, chunk)
              · best(doc, q) · quoteCard(c) · href(c, from)
   X.content: pane(content) · reveal(scroller, el, smooth)
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
  /** Where a chunk is in the document's Original, as indexing records it: one highlight per page with a box per block (`at.box`,
      or `at.boxes` for rows read as one passage), its cells in the sheet, or nothing for a text view (the viewer marks the
      quote) and for a block that wasn't found. */
  function highlightsOf(doc, ch) {
    const m = X.docModel(doc);
    if (m.marks === 'cells') return ch?.at?.sheet ? [{ sheet: ch.at.sheet, cellRange: ch.at.cellRange }] : [];
    if (m.marks !== 'boxes') return [];
    const located = X.rdr.locate(doc), pages = new Map();
    (ch?.at?.boxes || [ch?.at?.box]).map(k => located[k]).filter(Boolean).forEach(({ pageNumber, box }) => {
      if (!pages.has(pageNumber)) pages.set(pageNumber, []);
      pages.get(pageNumber).push(box);
    });
    return [...pages].map(([pageNumber, boxes]) => ({ pageNumber, boxes }));
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
    c.highlights = highlightsOf(d, ch);
    return c;
  }
  /** A citation made from one of the document's own chunks (Ask in the reader, search hits, answers built from a document). */
  function fromChunk(doc, ch) {
    const m = X.docModel(doc);
    return { item: doc.id, revision: m.revision, structureVersion: m.structureVersion, refs: [...ch.refs], quote: ch.quote, location: ch.location, highlights: highlightsOf(doc, ch) };
  }
  const slim = c => ({ item: c.item, revision: c.revision, structureVersion: c.structureVersion, refs: c.refs, quote: c.quote, location: c.location, highlights: c.highlights || [] });
  /** The page the passage starts on: the first highlight with a page (a sheet range or a text view has none). */
  const pageOf = c => (c?.highlights || []).find(h => h.pageNumber)?.pageNumber || 0;
  /** Where the cited passage is, as plain text (attributes, exports): "Per diem · page 4". */
  const where = c => [c?.location, pageOf(c) ? `page ${pageOf(c)}` : ''].filter(Boolean).join(' · ');
  /** Same, as HTML: the location is the document's own words (never translated), the page is interface copy. */
  const whereHtml = c => [c?.location ? `<span translate="no">${esc(c.location)}</span>` : '', pageOf(c) ? `<span>page ${pageOf(c)}</span>` : ''].filter(Boolean).join('<span aria-hidden="true"> · </span>');
  /** The quote itself: shown when the passage can't be marked on the Original, and all that's left when the document can't be read. */
  const quoteCard = c => (c?.quote ? `<figure class="cv-quote"><blockquote translate="no">${esc(c.quote)}</blockquote>${where(c) ? `<figcaption>${whereHtml(c)}</figcaption>` : ''}</figure>` : '');
  X.cite = {
    resolve,
    fromChunk,
    highlightsOf,
    /** The best chunk of a document for a query (the search hit's ContentReference), or null. */
    best: (doc, q) => (doc && isSearchable(doc) && tokens(q || '').length ? best(X.docModel(doc), q) : null),
    /** A citation as a data-attribute value, and back (buttons can't hold objects). */
    data: c => JSON.stringify(slim(resolve(c))),
    parse: s => { try { const c = JSON.parse(s || 'null'); return c?.item ? c : null; } catch (_) { return null; } },
    where: c => where(resolve(c)),
    whereHtml: c => whereHtml(resolve(c)),
    quoteCard,
    /** The Reader at the cited passage, on the revision it was read from. */
    href: (c, from = '') => {
      resolve(c);
      const q = new URLSearchParams(Object.entries({ anchor: c.refs?.[0], v: c.revision, from }).filter(([, v]) => v)).toString();
      return '/doc/' + c.item + (q ? '?' + q : '');
    },
  };
  /** Every surface opens a citation the same way: the shared preview, on the Original with the passage marked. */
  X.openCitation = (cites, { n, from } = {}) => {
    const list = (Array.isArray(cites) ? cites : [cites]).filter(c => c?.item).map(resolve);
    if (list.length) X.preview.open({ cites: list, n, from });
  };

  /* ═══════════════ DocumentRenderer (artifact revisions) ═══════════════
     Heading · Paragraph (runs) · List · Table (row/col spans) · Code · Formula · Picture (lazy <img>). Every block carries its
     ref (data-ref). Text is escaped; links are http(s). */
  const runs = n => X.runsHtml(n.runs);
  function nodesHtml(nodes) {
    const one = n => {
      switch (n.kind) {
        case 'HEADING': { const h = `h${Math.min(6, (n.level || 1) + 1)}`; return `<${h} class="cv-block cv-h cv-h--${n.level || 1}" data-ref="${esc(n.id)}">${runs(n)}</${h}>`; }
        case 'LIST': { const tag = n.ordered ? 'ol' : 'ul'; return `<${tag} class="cv-block cv-list" data-ref="${esc(n.id)}">${(n.children || []).map(c => `<li class="cv-block cv-li" data-ref="${esc(c.id)}">${runs(c)}</li>`).join('')}</${tag}>`; }
        case 'TABLE': {
          const head = n.rows?.[0]?.cells.every(c => c.header) ? n.rows[0] : null, body = head ? n.rows.slice(1) : n.rows || [];
          const cell = (c, tag) => `<${tag}${c.rowSpan ? ` rowspan="${c.rowSpan}"` : ''}${c.colSpan ? ` colspan="${c.colSpan}"` : ''}>${esc(c.text)}</${tag}>`;
          const more = n.totalRows > (n.rows || []).length ? `<p class="cv-table__more">Showing ${n.rows.length} of ${n.totalRows} rows</p>` : '';
          const cap = [n.sheet, n.caption].filter(Boolean).map(esc).join(' · ');
          return `<figure class="cv-block cv-table" data-ref="${esc(n.id)}"><div class="cv-table__scroll"><table>${head ? `<thead><tr>${head.cells.map(c => cell(c, 'th')).join('')}</tr></thead>` : ''}<tbody>${body.map(r => `<tr>${r.cells.map(c => cell(c, c.header ? 'th' : 'td')).join('')}</tr>`).join('')}</tbody></table></div>${cap ? `<figcaption>${cap}</figcaption>` : ''}${more}</figure>`;
        }
        case 'CODE': return `<pre class="cv-block cv-code" data-ref="${esc(n.id)}"${n.language ? ` data-lang="${esc(n.language)}"` : ''}><code>${runs(n)}</code></pre>`;
        case 'FORMULA': return `<div class="cv-block cv-formula" data-ref="${esc(n.id)}">${runs(n)}</div>`;
        case 'PICTURE': {
          const im = n.image && /^(https?:|data:image\/)/.test(n.image.uri) ? n.image : null;
          return `<figure class="cv-block cv-picture" data-ref="${esc(n.id)}">${im ? `<img src="${esc(im.uri)}" alt="${esc(n.caption || '')}" width="${im.widthPixels}" height="${im.heightPixels}" loading="lazy" decoding="async">` : ''}${n.caption ? `<figcaption>${esc(n.caption)}</figcaption>` : ''}</figure>`;
        }
        default: return `<p class="cv-block cv-p" data-ref="${esc(n.id)}">${runs(n)}</p>`;
      }
    };
    return nodes.map(one).join('');
  }
  /** An artifact revision's Structured Document: a quiet note on what this is, then its blocks. */
  const pane = content => `<div class="cv">
      <p class="cv-note">${ic('info', 'i-xs')}<span>Extracted content — the layout may differ from the original</span></p>
      <article class="cv-doc" translate="no">${nodesHtml(content.nodes)}</article>
    </div>`;
  /** Scroll an element into view inside `scroller` (a third from the top), without moving the page around it. */
  function reveal(scroller, el, smooth = false) {
    if (!scroller || !el) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo({ top: Math.max(0, top - scroller.clientHeight / 3), behavior: smooth ? 'smooth' : 'instant' });
  }
  X.content = { pane, reveal };
})();

/* Resources: the shared building blocks every Knowledge surface uses to show
   and act on a resource — trust chips, provenance, the list row (Save and ⋯
   revealed on hover/focus, always on touch), the document card (content
   preview, or a format tile when previews would repeat; Home, Browse grid),
   the metadata list — and the shared actions: save, ask (always the Reader's
   Ask panel: /doc/:id?ask=1), use in a workflow, edit details, link to
   spaces, verify, copy link. The ⋯ menu never repeats what its surface shows
   and holds at most 8 entries. Pages (home.js, hub.js, library.js,
   reader.js, knowledge.js, spaces.js, governance.js) compose these; none
   re-implements them. Titles: docTitle(d), type: typeMeta(d) (catalog.js).
   Exports: X.res.*. Actions: res-*. Model: core/catalog.js. */
(() => {
  'use strict';

  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const canEditRes = d => !!d && canEditKb(kbById(d.kb));
  /** Spaces whose materials the caller may curate. */
  const linkableSpaces = () => (hasModule('spaces') ? (D.spaces || []).filter(s => !s.archived && canManageSpace(s)) : []);

  /* ═══════════════ Visual pieces ═══════════════ */
  /** Trust chip. quiet: hide "Not verified" (lists), show it in details. */
  function trustChip(d, { size = 'sm', quiet = false } = {}) {
    const t = trustOf(d);
    if (t.state === 'personal' || (quiet && t.state === 'unverified')) return '';
    return chip(t.label, { tone: t.tone, icon: t.icon, size, tip: t.note || t.desc });
  }
  /** Index status, only for people who can fix it (editors). Readers never see pipeline states. */
  const statusChip = d => (d.status !== 'ready' && d.status !== 'outdated' && canEditRes(d) ? status('doc', d.status) : '');
  /** Save toggle. Your own private files already live in My library, so they have none (saving would only make a second copy). */
  const saveBtn = (d, { size = 'sm', label = false } = {}) => {
    if (kbById(d.kb)?.personal) return '';
    const on = isSaved(d.id);
    return label
      ? btn(on ? 'Saved' : 'Save', { size, icon: on ? 'bookmark-filled' : 'bookmark', act: 'res-save', data: { id: d.id }, cls: cx('res-save', on && 'is-on'), aria: `aria-pressed="${on}"` })
      : btn('', { v: 'ghost', size, icon: on ? 'bookmark-filled' : 'bookmark', tip: on ? 'Remove from saved' : 'Save', act: 'res-save', data: { id: d.id }, muted: !on, cls: cx('res-save', on && 'is-on'), aria: `aria-pressed="${on}"` });
  };
  /** ⋯ for a resource. ctx names the surface ('peek'), so the menu leaves out what that surface already shows. */
  const moreBtn = (d, size = 'sm', ctx = '') => iconBtn('more', 'More actions', { size, menu: 'res-more', data: { id: d.id, ...(ctx ? { ctx } : {}) } });
  /** "Google Drive · Academic regulations & procedures" with the source glyph (none for uploads: it would only say "a file"). */
  function provenance(d, { kb = true } = {}) {
    const r = res(d), glyph = r.source.app && r.source.app !== 'upload' ? appIcon(r.source.app, 'sm') : '';
    return `<span class="res-prov">${glyph}<span class="truncate">${esc(kb ? r.kb?.name || '' : r.source.name)}</span></span>`;
  }
  /** A document's accepted concepts in reading order: the first classification scheme's (its primary first), then the other
      schemes' in their tab order. */
  function conceptOrder(d) {
    const pos = new Map(classSchemes().map((s, i) => [s.id, i])), prim = new Set(docAssignments(d).filter(a => a.primary).map(a => a.id));
    const at = id => pos.get(conceptById(id)?.scheme) ?? pos.size;
    return resConcepts(d).map((id, i) => ({ id, i })).sort((a, b) => at(a.id) - at(b.id) || prim.has(b.id) - prim.has(a.id) || a.i - b.i).map(x => x.id);
  }
  /** A row's concepts: at most `max` tags, each a link to Browse filtered to it, the rest as +n with their names in its tooltip. */
  function conceptChips(d, { max = 2 } = {}) {
    const ids = conceptOrder(d), rest = ids.slice(max);
    if (!ids.length) return '';
    return `<span class="res-concepts">${ids.slice(0, max).map(id => conceptTag(id, { href: conceptHref(id) })).join('')}${rest.length ? `<span class="res-concepts__more" title="${esc(rest.map(conceptName).join(', '))}" translate="no">+${rest.length}</span>` : ''}</span>`;
  }
  /** A card's concepts: the first as a tag (plain, since the whole card is the control), the rest as +n with their names in its
      tooltip — a narrow card can't show two tags without cutting both. */
  function cardTags(ids) {
    const more = ids.length - 1;
    return `<div class="doc-card__tags">${conceptTag(ids[0])}${more > 0 ? `<span class="doc-card__more" title="${esc(ids.slice(1).map(conceptName).join(', '))}" translate="no">+${more}</span>` : ''}</div>`;
  }
  /** Fictional-data marker for demo workspaces. */
  const demoChip = () => (isDemoWs() ? chip('Demo data', { size: 'sm', icon: 'info', tip: curWs().demo }) : '');
  /** Knowledge's personal sections. Browse is Knowledge itself; Saved · My files are pages of their own that the sidebar lists as
      sub-rows of Knowledge while you're in it (core/shell.js navItem) — no tab bar on the page. Managing collections lives in Manage. */
  function librarySections() {
    const kb = visibleKbs().find(k => k.personal);
    return [
      { id: 'saved', label: 'Saved', to: '/knowledge/library?tab=saved' },
      kb && { id: 'files', label: 'My files', to: '/knowledge/library?tab=files' },
    ].filter(Boolean);
  }
  /** The library section a query asks for (an unknown or unavailable one falls back to Saved). */
  const libraryTab = query => (librarySections().some(t => t.id === query?.tab) ? query.tab : 'saved');
  /** Sidebar sub-rows; the current one is the section you're on. */
  function libraryNav() {
    const here = S.cur?.r.page === 'library' ? libraryTab(S.cur.query) : '';
    return librarySections().map(t => ({ ...t, current: t.id === here }));
  }
  /** Knowledge page header: Browse is titled Knowledge, a library section by its name (the top row holds it). */
  function hubHeader(active, { actions = '' } = {}) {
    const title = librarySections().find(t => t.id === active)?.label || 'Knowledge';
    return pageHeader({ title, extra: demoChip(), actions });
  }
  /** Knowledge header entry point: Contribute (review before publishing) for contributors; otherwise upload to My files. */
  const uploadBtn = (v = 'secondary') => (canContribute() ? btn('Contribute', { v, icon: 'upload', act: 'contribute' }) : visibleKbs().some(k => k.personal) ? btn('Upload', { v, icon: 'upload', act: 'contribute', data: { private: '1' } }) : '');

  /* ═══════════════ Row, card, table ═══════════════ */
  /** Rich list row. opts: q (highlight + snippet), act (default open), data, active, trail (always-visible next step, e.g. Revise or
      Process), reveal (secondary actions shown with Save and ⋯ on hover/focus), select (uiKey for checkbox), hide (['kb']: context every
      row in the list shares — My files — so it isn't repeated on each row). The file icon names the type. Save and ⋯ appear on hover
      or keyboard focus (always on touch); a saved bookmark stays visible. */
  function row(d, { q = '', act = 'res-open', data, active = false, trail = '', reveal = '', select, compact = false, hide = [] } = {}) {
    const r = res(d), toks = tokens(q);
    // The best matching passage of the document's own text (never its running header: a title-only match shows the summary instead);
    // the raw text excerpt only when the document has no indexed chunks.
    const snip = !q ? '' : chunksOf(d).length ? matchPassage(d, q)?.html || '' : resSnippet(d, q);
    const meta = [!hide.includes('kb') && esc(r.kb?.name || ''), `Updated ${esc(rel(d.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase()))}`].filter(Boolean).join('<span class="res-dot" aria-hidden="true">·</span>');
    // The source glyph says where a document comes from; for an upload it adds nothing, so it's left out.
    const src = r.source.app && r.source.app !== 'upload' ? appIcon(r.source.app, 'sm') : '';
    const about = compact ? '' : snip || markTokens(blurb(d), toks);
    const desc = about ? `<span class="res-row__summary" translate="no">${about}</span>` : '';
    const title = docTitle(d);
    const sel = select ? `<span class="res-row__check">${checkbox({ checked: !!ui(select).sel?.[d.id], act: 'sel-toggle', data: { ui: select, id: d.id }, aria: 'Select ' + title })}</span>` : '';
    return `<div class="${cx('res-row', active && 'is-active', compact && 'res-row--compact')}" role="button" tabindex="0" data-act="${act}" ${dataAttrs({ id: d.id, ...(data || {}) })} ${active ? 'aria-current="true"' : ''}>
      ${sel}<span class="res-row__lead">${fileIcon(d.type)}</span>
      <span class="res-row__body">
        <span class="res-row__title"><span class="truncate" translate="no">${markTokens(title, toks)}</span>${trustChip(d, { quiet: true })}${statusChip(d)}</span>
        <span class="res-row__meta">${src}${meta}</span>
        ${desc}
        ${compact ? '' : conceptChips(d)}
      </span>
      <span class="res-row__trail">${trail}<span class="reveal-on-hover">${reveal}${saveBtn(d)}${moreBtn(d)}</span></span>
    </div>`;
  }
  const rows = (docs, opts) => `<div class="res-list">${docs.map(d => row(d, typeof opts === 'function' ? opts(d) : opts)).join('')}</div>`;

  /* ═══════════════ Document card + cover ═══════════════ */
  const TYPE_TONE = { pdf: 'danger', word: 'accent', spreadsheet: 'success', presentation: 'warning' };
  /** The document's indexed chunks (what SearchItems matches a query against). Empty without a processed Structured Document. */
  const chunksOf = d => (X.docModel && isSearchable(d) ? X.docModel(d).chunks : []);
  const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);

  /* Cover (mock of DocumentFacet.cover): what the first page looks like, made by the ingestion worker as soon as the content arrives —
     before and without processing — and made again when the current version changes. { kind: PAGE | SLIDE | SHEET | TEXT | IMAGE,
     image?, title, lines, cells }. `image` stands in for the small WebP (≤ 480 px wide): the first page's own HTML drawn small. PDFs and
     pictures always have one; Office files only when they carry an embedded thumbnail (most decks, here every other one) — else their
     first slide's, page's or sheet's text. Null: nothing to show (archives, unknown formats) → the format's typed tile. Never a page count. */
  const COVER_KIND = { pdf: 'PAGE', word: 'PAGE', presentation: 'SLIDE', spreadsheet: 'SHEET', markdown: 'TEXT', html: 'TEXT', plain_text: 'TEXT', data: 'TEXT', image: 'IMAGE' };
  const coverCache = new Map();
  const textOf = n => n.textContent.replace(/\s+/g, ' ').trim();
  function cover(d) {
    const kind = COVER_KIND[docType(d)];
    if (!kind) return null;
    if (kind === 'IMAGE') return { kind, title: bareName(d.name), image: { hue: hashOf(d.id) % 360 }, lines: [], cells: [] };
    if (!X.docModel) return null;
    const key = [S.ws, d.id, d.updated, d.name].join('|');
    if (!coverCache.has(key)) coverCache.set(key, makeCover(d, kind));
    return coverCache.get(key);
  }
  function makeCover(d, kind) {
    const first = X.docModel(d)?.pages?.[0]; if (!first) return null;
    const el = document.createElement('div');
    el.innerHTML = first.html;
    el.querySelectorAll('.doc-foot, .doc-run, .doc-sub, .doc-sheet__tabs').forEach(n => n.remove());
    const head = el.querySelector('h2, h3'), title = head ? clip(textOf(head), 200) : '';
    if (docType(d) === 'pdf' || (kind === 'SLIDE' && hashOf(d.id) % 2 === 0)) {
      return { kind, title, image: { cls: first.cls || '', html: first.html.replace(/\sid="[^"]*"/g, '') }, lines: [], cells: [] };
    }
    if (kind === 'SHEET') {
      const grid = el.querySelector('.doc-sheet') ? [...el.querySelectorAll('.doc-sheet tbody tr')] : [...el.querySelectorAll('table tr')];
      const cells = grid.slice(0, 6).map(tr => [...tr.children].filter(c => !c.classList.contains('doc-sheet__rn')).slice(0, 5).map(c => clip(textOf(c), 40)));
      if (cells.length) return { kind, title, lines: [], cells };
    }
    const lines = [...el.querySelectorAll('h3, p, li')].filter(n => n !== head).map(textOf).filter(Boolean).slice(0, 8).map(s => clip(s, 160));
    return { kind: kind === 'SHEET' ? 'PAGE' : kind, title, lines, cells: [] };
  }
  /** One cover in its format's shape, in the card's fixed 16:9 frame (nothing shifts as images arrive). PAGE and TEXT: a portrait paper,
      top-aligned, fading at the bottom; SLIDE: a 16:9 slide; SHEET: a mini grid with column letters and row numbers; IMAGE: the picture,
      cropped to fill. The image wins over the text when both exist. */
  function coverHtml(c) {
    const L = 'ABCDE';
    const page = c.image ? `<div class="doc-cover__img"><div class="doc-cover__render"><div class="${cx('doc-page', c.image.cls)}">${c.image.html}</div></div></div>`
      : `<div class="doc-cover__text">${c.title ? `<p class="doc-cover__title">${esc(c.title)}</p>` : ''}${c.lines.map(l => `<p>${esc(l)}</p>`).join('')}</div>`;
    if (c.kind === 'IMAGE') return `<div class="doc-thumb doc-thumb--image" aria-hidden="true" inert><span class="doc-cover__pic" style="--hue:${c.image.hue}"></span></div>`;
    if (c.kind === 'SLIDE') return `<div class="doc-thumb doc-thumb--slide" aria-hidden="true" inert translate="no"><div class="doc-cover__slide">${c.image ? page : `<div class="doc-cover__text">${c.title ? `<p class="doc-cover__title">${esc(c.title)}</p>` : ''}${c.lines.length ? `<ul>${c.lines.slice(0, 4).map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}</div>`}</div></div>`;
    if (c.kind === 'SHEET' && !c.image) {
      const cols = Math.max(...c.cells.map(r => r.length));
      return `<div class="doc-thumb doc-thumb--sheet" aria-hidden="true" inert translate="no"><table class="doc-cover__grid"><thead><tr><th></th>${L.slice(0, cols).split('').map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${c.cells.map((r, i) => `<tr><th>${i + 1}</th>${Array.from({ length: cols }, (_, j) => `<td>${esc(r[j] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return `<div class="${cx('doc-thumb doc-thumb--page', c.kind === 'TEXT' && 'doc-thumb--text')}" aria-hidden="true" inert translate="no"><div class="doc-cover__paper">${page}</div></div>`;
  }
  /** Card preview, from the list's own data — no content read per card. The cover image; else, when searching, the matching passage
      (SearchItems returns it); else the cover's text; else (no cover yet, or nothing to show) a tinted typed tile. Decorative: the card's
      text says the same for assistive tech. */
  function preview(d, { q = '' } = {}) {
    const c = cover(d), toks = tokens(q);
    if (c?.image) return coverHtml(c);
    const hit = toks.length ? matchPassage(d, q) : null;
    if (hit) return `<div class="doc-thumb doc-thumb--focus" aria-hidden="true" inert><div class="doc-focus"><div class="doc-focus__head"><span class="doc-focus__title"${hit.heading ? ' translate="no"' : ''}>${esc(hit.heading || typeMeta(d).label)}</span>${hit.where ? `<span class="doc-focus__page">${esc(hit.where)}</span>` : ''}</div><p translate="no">${hit.html}</p></div></div>`;
    if (c) return coverHtml(c);
    // No cover: the format's tile on its tone; the card's head names the type and title right below.
    const tone = TYPE_TONE[docType(d)] || 'default';
    return `<div class="doc-thumb doc-thumb--blank doc-thumb--${tone}" aria-hidden="true">${fileIcon(d.type, 'lg')}</div>`;
  }
  /** The chunk that best matches a query (SearchItems' ContentReference): { where: location · page, html } — clipped around its first
      matching word, so the match is always in view. */
  function matchPassage(d, q) {
    const toks = tokens(q), hit = toks.length && X.cite?.best(d, q);
    if (!hit) return null;
    const low = fold(hit.text), at = Math.min(...toks.map(t => low.indexOf(t)).filter(i => i >= 0));
    const from = at > 100 ? hit.text.lastIndexOf(' ', at - 60) + 1 : 0;
    const text = (from > 0 ? '…' : '') + clip(hit.text.slice(from), 220);
    const page = X.cite.highlightsOf(d, hit).find(h => h.pageNumber)?.pageNumber;
    return { where: page ? `Page ${page}` : '', heading: hit.location, html: markTokens(text, toks) };
  }
  /** One line on what a document is for: its summary. Never a generated "Guide in …" filler. */
  const blurb = d => d.summary || '';
  /** Trust only where it changes a decision: a quiet Verified mark, a Review due chip; nothing for unverified or personal files. */
  function trustMark(d) {
    const t = trustOf(d);
    if (t.state === 'verified') return `<span class="doc-card__ok" data-tip="${esc(t.note)}">${ic('shield-check', 'i-sm')}<span class="sr-only">Verified</span></span>`;
    return t.state === 'review' ? chip(t.label, { tone: t.tone, icon: t.icon, size: 'sm', tip: t.note }) : '';
  }
  /** Document card (Knowledge grid): a compact tile to recognise a document and judge it without opening it — the top of its first
      page, its file icon and title, one line on what it is for, its concepts as colored tags, then how fresh (where it lives when it
      is filed under nothing); indexing and trust only when they matter. Save and ⋯ appear on hover/focus (always on touch).
      opts: act + data (what selecting the card does, e.g. a quick preview), q (highlight, matching passage when there is no cover image),
      hide (['kb', 'concept']: context every card in the set shares, so it isn't repeated). */
  function card(d, { act, data, q = '', hide = [] }) {
    const r = res(d), toks = tokens(q);
    const concepts = hide.includes('concept') ? [] : conceptOrder(d);
    const where = !concepts.length && !hide.includes('kb') ? r.kb?.name || '' : '';
    const about = blurb(d);
    const meta = where ? esc(where) : '';
    return `<article class="doc-card" role="button" tabindex="0" data-act="${act}" ${dataAttrs({ id: d.id, ...(data || {}) })}>
      <div class="doc-card__media">${preview(d, { q })}
        <div class="doc-card__actions">${saveBtn(d)}${moreBtn(d)}</div></div>
      <div class="doc-card__body">
        <div class="doc-card__head">${fileIcon(d.type, 'sm')}<h3 class="doc-card__title" translate="no">${markTokens(docTitle(d), toks)}</h3></div>
        ${about ? `<p class="doc-card__about" translate="no">${markTokens(about, toks)}</p>` : ''}
        ${concepts.length ? cardTags(concepts) : ''}
        <div class="doc-card__meta">${meta ? `<span class="doc-card__where truncate">${meta}</span>` : ''}<span class="doc-card__when" data-tip="Updated ${esc(fmtDate(d.updated))}">${esc(rel(d.updated))}</span>${statusChip(d)}${trustMark(d)}</div>
      </div>
    </article>`;
  }

  /** One row per classification scheme, in tab order: [scheme name, its concepts]. Accepted ones link to Browse; the classifier's
      suggestions are marked “Awaiting review”; a scheme the classifier left in its pool says “Not classified”, an empty one “—”.
      `editable` (the viewer edits the document): an empty or unclassified scheme offers Add (Edit details). `compact` leaves out
      schemes with nothing to show and draws plain tags. */
  function schemeRows(d, { editable = false, compact = false } = {}) {
    return assignmentsByScheme(d).map(({ scheme, items, uncertain }) => {
      const tags = items.map(a => conceptTag(a.id, { href: compact || a.state === 'suggested' ? '' : conceptHref(a.id), suggested: a.state === 'suggested' })).join('');
      if (tags) return [scheme.name, `<span class="res-concepts">${tags}</span>`];
      if (compact && !uncertain) return null;
      const add = editable && canEditRes(d) ? linkBtn('Add', { act: 'res-edit', data: { id: d.id } }) : '';
      return [scheme.name, `<span class="row gap-8"><span class="muted">${esc(uncertain ? 'Not classified' : '—')}</span>${add}</span>`];
    }).filter(Boolean);
  }
  /** A document's concepts grouped by classification scheme (Studio's document drawer, review): a description list, '' when
      there is nothing to show. Options: see schemeRows. */
  const conceptsByScheme = (d, opts) => { const rows = schemeRows(d, opts); return rows.length ? kv(rows) : ''; };
  /** “Document facts” (an issued document's issuance and applicability): number, issued and effective dates, issuing unit, who it
      applies to and what it replaces. Empty rows are left out; '' when there are none. Replaced documents the viewer can't open
      aren't named; references nobody could match to a document show as written. */
  function issuance(d) {
    const x = issuanceOf(d); if (!x) return '';
    const who = applicabilityText(d);
    const replaced = [
      ...x.supersedes.filter(canOpenRes).map(o => `<a class="link" href="#/doc/${esc(o.id)}" translate="no">${esc(docTitle(o))}</a>`),
      ...x.unresolved.filter(Boolean).map(t => `<span translate="no">${esc(t)}</span>`),
    ];
    const rows = [
      x.number && ['Number', `<span translate="no">${esc(x.number)}</span>`],
      x.issued && ['Issued', esc(fmtDate(x.issued))],
      x.effective && ['Effective', esc(fmtDate(x.effective))],
      x.issuer && conceptById(x.issuer) && ['Issued by', `<span translate="no">${esc(conceptName(x.issuer))}</span>`],
      who && ['Applies to', x.level === 'institution' ? esc(who) : `<span translate="no">${esc(who)}</span>`],
      replaced.length && ['Supersedes', `<span class="stack gap-2">${replaced.join('')}</span>`],
    ].filter(Boolean);
    return rows.length ? `<section class="res-facts" aria-label="${esc('Document facts')}"><h4 class="res-facts__title">${esc('Document facts')}</h4>${kv(rows)}</section>` : '';
  }

  /** Metadata list (About): what it is and what it's filed under, where it lives, where it came from, who owns it, who can see it;
      then its Document facts when it is an issued document. */
  function details(d) {
    const r = res(d), t = trustOf(d), who = X.whoCanSee && r.kb ? X.whoCanSee(r.kb, docFolder(d)) : { icon: 'lock', label: '' };
    const path = folderPath(docFolder(d)).map(f => f.name);
    const spaces = r.contexts.map(spaceById).filter(Boolean);
    return kv([
      ['Type', `<span class="row gap-6">${ic(typeMeta(d).icon, 'i-sm muted')}${esc(typeMeta(d).label)}</span>`],
      ...schemeRows(d),
      hasModule('spaces') && ['Spaces', spaces.length ? spaces.map(s => `<a class="link" href="#/space/${s.id}">${esc(s.code ? `${s.name} · ${s.code}` : s.name)}</a>`).join(', ') : '<span class="muted">Not linked</span>'],
      ['Owner', esc(r.owner || 'No owner')],
      ['Collection', r.kb ? `<span class="stack gap-2"><a class="link" href="#${kbHref(r.kb)}">${esc(r.kb.name)}</a>${path.length ? `<span class="t-xs muted" translate="no">${esc(path.join(' › '))}</span>` : ''}</span>` : '—'],
      ['Source', `<span class="stack gap-2"><span class="row gap-6">${appIcon(r.source.app, 'sm')}${esc(r.source.name)}</span><span class="t-xs muted res-path">${esc(r.source.path)}</span></span>`],
      ['Trust', `<span class="stack gap-2">${trustChip(d) || esc(t.label)}<span class="t-xs muted">${esc(t.note || t.desc)}</span></span>`],
      ['Version', `v${r.version} · ${esc(fmtDate(d.updated))}`],
      ['Language', esc(LANGS[r.lang] || r.lang)],
      ['Who can see it', `<span class="stack gap-2"><span class="row gap-6">${ic(who.icon, 'i-sm muted')}${esc(who.label)}</span>${who.via ? `<span class="t-xs muted">${esc(`Set on the folder ${who.via.name}, not the collection`)}</span>` : ''}</span>`],
    ]) + issuance(d);
  }

  X.res = { trustChip, statusChip, saveBtn, moreBtn, provenance, conceptOrder, conceptChips, schemeRows, conceptsByScheme, issuance, demoChip, hubHeader, libraryNav, libraryTab, uploadBtn, row, rows, card, cover, coverHtml, thumb: preview, blurb, matchPassage, details, canEditRes, linkableSpaces };

  /* ═══════════════ Actions ═══════════════ */
  /** Knowledge dialogs validate on submit, then clear the error as soon as the field is filled (data-input="kn-revalidate"
      data-form="<S.ui key>"). Re-renders only when the error goes away, so typing (and Vietnamese IME composition) isn't interrupted. */
  A['kn-revalidate'] = el => { const f = S.ui[el.dataset.form]; if (f?.touched && el.value.trim()) { f.touched = false; refreshLayer(); } };
  /** A document row anywhere (library, search, Related, spaces' materials): preview first, open full later (preview.js). */
  A['res-open'] = el => { const { id, q } = el.dataset; X.preview.open({ id, q }); };
  A['res-save'] = el => {
    const d = docById(el.dataset.id); if (!d) return;
    const on = toggleSaved(d.id); refresh();
    toast(on ? `Saved “${docTitle(d)}”` : `Removed “${docTitle(d)}” from saved`, { action: { label: 'Undo', run: () => { toggleSaved(d.id); refresh(); } } });
  };
  /** Copy link: a share of the document to the workspace (/s/{share}); it grants nothing (features/shares.js). */
  A['res-copy-link'] = el => X.shares.copyShare('doc', el.dataset.id);
  /** Ask about one document: always the Reader with its Ask panel open (/doc/:id?ask=1), never a new conversation. */
  A['res-ask'] = el => { const d = docById(el.dataset.id); if (!d) return; if (S.drawer) { S.drawer = null; renderLayer(); } go('/doc/' + d.id + '?ask=1' + (el.dataset.q ? '&q=' + encodeURIComponent(el.dataset.q) : '')); };
  A['res-verify'] = el => {
    const d = docById(el.dataset.id); if (!canEditRes(d)) return;
    const prev = d.verify ? { ...d.verify } : null;
    d.verify = { state: 'verified', by: me().name, at: Date.now(), due: Date.now() + 180 * DAY };
    audit('Verified a resource', d.name); refresh();
    toast(`Verified “${docTitle(d)}” until ${fmtDate(d.verify.due)}`, { action: { label: 'Undo', run: () => { if (prev) d.verify = prev; else delete d.verify; refresh(); } } });
  };

  /** Workflows a resource can start (Work module), scoped to its first space. */
  function useItems(d) {
    if (!hasModule('work')) return [];
    const sp = res(d).contexts.map(spaceById).find(s => s && spaceRole(s));
    return workflowsFor(sp).map(w => ({ label: w.label, icon: w.icon, run: () => A['work-start']?.({ dataset: { workflow: w.id, docs: d.id, ...(sp ? { space: sp.id } : {}) } }) }));
  }
  X.res.useItems = useItems;
  MENUS['res-use'] = el => { const d = docById(el.dataset.id); return d ? [{ section: 'Use in' }, ...useItems(d)] : []; };
  /** A resource's ⋯: never repeats what the surface already shows (Open is the row or card itself; Save is its bookmark; the Reader and
      the quick preview show Ask), at most 8 entries, grouped — reading, Use in, then Manage (editors), Archive last. When Manage would
      push the menu past 8 it becomes one "Manage…" entry that opens its own menu. */
  const MENU_MAX = 8;
  const nItems = l => l.filter(x => x && !x.sep && !x.section).length;
  MENUS['res-more'] = el => {
    const d = docById(el.dataset.id); if (!d) return [];
    const kb = kbById(d.kb), personal = !!kb?.personal, edit = canEditRes(d), readable = isSearchable(d);
    const reader = S.cur.r.page === 'docViewer' && S.cur.params?.id === d.id;
    const askShown = reader || el.dataset.ctx === 'peek';
    const reading = [
      !askShown && readable && { label: 'Ask about this document', icon: 'sparkles', run: () => A['res-ask']({ dataset: { id: d.id } }) },
      { label: 'Copy link', icon: 'link', run: () => A['res-copy-link']({ dataset: { id: d.id } }) },
      { label: 'Download', icon: 'download', run: () => X.downloadDocument?.(d) },
      ...(reader ? X.rdr?.panels?.(d, el) || [] : []),
    ].filter(Boolean);
    const use = readable ? useItems(d) : [];
    const head = [...reading, ...(use.length ? [{ section: 'Use in' }, ...use] : [])];
    const manage = [
      edit && { label: 'Edit details…', icon: 'pencil', run: () => A['res-edit']({ dataset: { id: d.id } }) },
      edit && linkableSpaces().length && { label: 'Link to spaces…', icon: 'link-2', run: () => A['res-link']({ dataset: { id: d.id } }) },
      edit && !personal && { label: trustOf(d).state === 'verified' ? 'Renew verification' : 'Mark as verified', icon: 'shield-check', run: () => A['res-verify']({ dataset: { id: d.id } }) },
      // A new file only for uploads: synced documents are updated at their source (Publish update).
      canContribute() && !personal && (edit || isMine(d)) && res(d).source.key === 'upload' && { label: 'Submit a new version…', icon: 'upload', run: () => A['contribute']?.({ dataset: { versionOf: d.id } }) },
      canReviewKb(kb) && can('knowledge.manage') && { label: 'Open in Documents', icon: 'library', run: () => go(docsHref('all', { q: docTitle(d) })) },
    ].filter(Boolean);
    const archive = edit ? [{ sep: true }, { label: 'Archive', icon: 'archive', danger: true, run: () => X.archiveDocs?.([d]) }] : [];
    if (!manage.length) return [...head, ...archive];
    const section = [{ section: 'Manage' }, ...manage, ...archive];
    if (nItems(head) + nItems(section) <= MENU_MAX) return [...head, ...section];
    return [...head, { sep: true }, { label: 'Manage…', icon: 'settings', run: () => openMenu(el, section, 'res-manage:' + d.id) }];
  };

  /* ── Edit details (editors of the collection) ── */
  /** A date input's value (the local day, YYYY-MM-DD) ↔ ms. */
  const toDay = ms => { if (!ms) return ''; const t = new Date(ms); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
  const fromDay = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null; };
  /** What Edit details may change on a document (Undo restores these). */
  const EDIT_KEYS = ['name', 'concepts', 'uncertain', 'issuance', 'applicability', 'lang', 'summary', 'owner', 'classifiedBy'];
  /** Document facts are offered where documents are issued by units (the workspace has authority schemes), or when a document
      already carries them. */
  const factsOffered = d => authoritySchemes().length > 0 || !!issuanceOf(d);
  A['res-edit'] = el => {
    const d = docById(el.dataset.id); if (!canEditRes(d)) return; const r = res(d), x = issuanceOf(d);
    // Per classification scheme: what it's filed under, then what awaits review (both editable; suggestions stay marked).
    const concepts = Object.fromEntries(classSchemes().map(s => [s.id, schemeConceptIds(d, s.id)]));
    const attention = !r.concepts.length || assignmentsByScheme(d).some(g => g.uncertain || g.items.some(a => a.state === 'suggested'));
    // People edit the title; the file keeps its extension, and so its type (the format badge already says PDF/MD).
    S.ui.resEdit = {
      id: d.id, name: docTitle(d), owner: d.owner || '', lang: r.lang, summary: d.summary || '', touched: false, busy: false, more: false,
      concepts, start: clone(concepts), suggested: suggestedConcepts(d), showConcepts: attention, showFacts: false,
      number: x?.number || '', issued: toDay(x?.issued), effective: toDay(x?.effective), issuer: x?.issuer || '',
      level: x?.level || '', units: [...(x?.units || [])], programs: [...(x?.programs || [])], cohorts: (x?.cohorts || []).join(', '),
      supersedes: (d.issuance?.supersedes || []).filter(docById),
    };
    openModal('res-edit', {});
  };
  /** One picker per classification scheme, labelled with the scheme's name. */
  function conceptFields(f, d) {
    return classSchemes().map(s => {
      const ids = f.concepts[s.id] || [], pool = (d.uncertain || []).includes(s.id) && !ids.length;
      return `<div class="res-scheme"><span class="res-scheme__label" translate="no">${esc(s.name)}</span>${conceptPicker({ id: 'rese-c-' + s.id, ids, act: 'res-edit-concept', data: { scheme: s.id }, scheme: s.id, label: s.name, suggested: f.suggested, empty: pool ? 'Not classified' : '' })}</div>`;
    }).join('');
  }
  /** Number, dates, issuing unit (when the workspace lists units), who it applies to (level, then the units, programs or
      cohorts that level names) and the documents it replaces. */
  function factFields(f, d, dis) {
    const orgs = schemeById('org-unit') ? conceptsOf('org-unit') : [], progs = schemeById('program') ? conceptsOf('program') : [];
    const group = (label, body) => `<div class="field"><span class="label">${esc(label)}</span>${body}</div>`;
    const dates = `<div class="grid cols-2 res-more">
      ${field({ id: 'rese-num', label: 'Number', control: input({ id: 'rese-num', bind: 'resEdit.number', value: f.number, placeholder: 'e.g. 123/QĐ-ĐHCNKT-ĐT', attrs: `maxlength="128" ${dis}` }) })}
      ${orgs.length ? field({ id: 'rese-issuer', label: 'Issued by', control: select({ id: 'rese-issuer', bind: 'resEdit.issuer', value: f.issuer, options: [['', 'Not set'], ...orgs.map(c => [c.id, conceptPathText(c.id)])], change: 'res-edit-refresh', attrs: dis }) }) : ''}
      ${field({ id: 'rese-issued', label: 'Issued', control: input({ id: 'rese-issued', type: 'date', bind: 'resEdit.issued', value: f.issued, attrs: dis }) })}
      ${field({ id: 'rese-eff', label: 'Effective', control: input({ id: 'rese-eff', type: 'date', bind: 'resEdit.effective', value: f.effective, attrs: dis }) })}</div>`;
    const levels = [['', 'Not set'], ['institution', APPLICABILITY.institution], ...(orgs.length ? [['unit', APPLICABILITY.unit]] : []), ...(progs.length ? [['program', APPLICABILITY.program], ['cohort', APPLICABILITY.cohort]] : [])];
    const named = f.level === 'unit' && orgs.length ? conceptPicker({ id: 'rese-units', ids: f.units, act: 'res-edit-unit', scheme: 'org-unit', label: APPLICABILITY.unit, quiet: true })
      : ['program', 'cohort'].includes(f.level) && progs.length ? conceptPicker({ id: 'rese-programs', ids: f.programs, act: 'res-edit-program', scheme: 'program', label: APPLICABILITY.program, quiet: true }) : '';
    const cohorts = f.level === 'cohort' ? input({ id: 'rese-cohorts', bind: 'resEdit.cohorts', value: f.cohorts, placeholder: 'Entry years, e.g. 2022, 2023', attrs: `maxlength="60" aria-label="${esc('Cohorts')}" ${dis}` }) : '';
    const applies = orgs.length || progs.length ? group('Applies to', `<div class="stack gap-8">${select({ id: 'rese-level', bind: 'resEdit.level', value: f.level, options: levels, change: 'res-edit-refresh', label: 'Applies to', attrs: dis })}${named}${cohorts}</div>`) : '';
    const sups = f.supersedes.map(docById).filter(Boolean);
    const pool = readableResources().filter(o => o.id !== d.id && !f.supersedes.includes(o.id) && !kbById(o.kb)?.personal && (o.kb === d.kb || o.issuance)).sort((a, b) => docTitle(a).localeCompare(docTitle(b)));
    const list = sups.length ? `<ul class="res-sups">${sups.map(o => `<li class="res-sup">${fileIcon(o.type, 'sm')}<span class="grow truncate" translate="no">${esc(docTitle(o))}</span>${iconBtn('x', `Remove ${docTitle(o)}`, { size: 'sm', act: 'res-edit-sup-remove', data: { doc: o.id } })}</li>`).join('')}</ul>` : '';
    const add = pool.length ? select({ id: 'rese-sup', value: '', options: [['', 'Add a document it replaces…'], ...pool.map(o => [o.id, docTitle(o)])], change: 'res-edit-sup-add', size: 'sm', cls: 'res-sup__add', label: 'Add a document it replaces', attrs: dis }) : '';
    const supersedes = list || add ? group('Supersedes', `<div class="stack gap-8">${list}${add}</div>`) : '';
    return `<div class="kn-form res-facts-form">${dates}${applies}${supersedes}</div>`;
  }
  M['res-edit'] = () => {
    const f = ui('resEdit'), d = docById(f.id), r = res(d), err = f.touched && !f.name.trim() ? 'Enter a title.' : '', dis = f.busy ? 'disabled' : '';
    const names = classSchemes().flatMap(s => f.concepts[s.id] || []).map(conceptName);
    const conceptSum = names.length ? `<span translate="no">${esc(names.slice(0, 2).join(', '))}</span>${names.length > 2 ? ` +${names.length - 2}` : ''}` : esc('None yet');
    const classification = classSchemes().length ? disclosure({ path: 'resEdit.showConcepts', icon: 'tag', title: 'Classification', summary: conceptSum, body: `<div class="res-schemes">${conceptFields(f, d)}</div>` }) : '';
    const factSum = [f.number && `<span translate="no">${esc(f.number)}</span>`, fromDay(f.issued) && esc(fmtDate(fromDay(f.issued)))].filter(Boolean).join(' · ') || esc('None yet');
    const facts = factsOffered(d) ? disclosure({ path: 'resEdit.showFacts', icon: 'file-text', title: 'Document facts', summary: factSum, body: factFields(f, d, dis) }) : '';
    const kbOwner = ownerOfKb(r.kb) || '';
    const moreSum = esc([LANGS[f.lang] || f.lang, f.owner.trim() || kbOwner].filter(Boolean).join(' · '));
    return {
      size: 'lg', title: 'Edit details', icon: 'pencil',
      desc: 'What people see in search results, previews and the reader.',
      body: `<div class="kn-form">${field({ id: 'rese-name', label: 'Title', required: true, error: err, control: input({ id: 'rese-name', bind: 'resEdit.name', value: f.name, autofocus: true, onEnter: 'res-edit-go', invalid: !!err, attrs: `maxlength="160" data-input="kn-revalidate" data-form="resEdit" ${dis}` }) })}
        ${field({ id: 'rese-sum', label: 'Summary', optional: true, desc: 'One or two sentences shown in results and previews.', control: textarea({ id: 'rese-sum', bind: 'resEdit.summary', value: f.summary, rows: 2, attrs: `maxlength="280" ${dis}` }) })}
        <div class="stack gap-8">${classification}${facts}
        ${disclosure({ path: 'resEdit.more', icon: 'sliders', title: 'Language and owner', summary: moreSum, body: `<div class="grid cols-2 res-more">${field({ id: 'rese-lang', label: 'Language', control: select({ id: 'rese-lang', bind: 'resEdit.lang', value: f.lang, options: Object.entries(LANGS), change: 'res-edit-refresh', attrs: dis }) })}${field({ id: 'rese-owner', label: 'Owner', optional: true, desc: kbOwner ? `Empty uses the collection owner, ${esc(kbOwner)}.` : '', control: input({ id: 'rese-owner', bind: 'resEdit.owner', value: f.owner, placeholder: kbOwner || 'Space or office', onEnter: 'res-edit-go', attrs: dis }) })}</div>` })}</div></div>`,
      footStart: 'Changes show for everyone right away.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Save changes', { v: 'primary', icon: 'check', act: 'res-edit-go', loading: f.busy }),
    };
  };
  A['res-edit-refresh'] = () => refreshLayer();
  const refocus = id => { refreshLayer(); requestAnimationFrame(() => $('#' + id)?.focus()); };
  /** A scheme that holds one concept (maxLabels 1) swaps it; a full one swaps its last. */
  A['res-edit-concept-add'] = el => {
    const f = ui('resEdit'), s = schemeById(el.dataset.scheme), id = el.value; if (!s || !conceptById(id)) return;
    const ids = f.concepts[s.id] || []; if (ids.includes(id)) return;
    f.concepts[s.id] = s.maxLabels && ids.length >= s.maxLabels ? [...ids.slice(0, s.maxLabels - 1), id] : [...ids, id];
    f.suggested = f.suggested.filter(c => c !== id);
    refocus('rese-c-' + s.id);
  };
  A['res-edit-concept-remove'] = el => { const f = ui('resEdit'), s = el.dataset.scheme; f.concepts[s] = (f.concepts[s] || []).filter(x => x !== el.dataset.concept); refocus('rese-c-' + s); };
  A['res-edit-unit-add'] = el => { const f = ui('resEdit'); if (conceptById(el.value) && !f.units.includes(el.value)) f.units.push(el.value); refocus('rese-units'); };
  A['res-edit-unit-remove'] = el => { const f = ui('resEdit'); f.units = f.units.filter(x => x !== el.dataset.concept); refocus('rese-units'); };
  A['res-edit-program-add'] = el => { const f = ui('resEdit'); if (conceptById(el.value) && !f.programs.includes(el.value)) f.programs.push(el.value); refocus('rese-programs'); };
  A['res-edit-program-remove'] = el => { const f = ui('resEdit'); f.programs = f.programs.filter(x => x !== el.dataset.concept); refocus('rese-programs'); };
  A['res-edit-sup-add'] = el => { const f = ui('resEdit'); if (docById(el.value) && !f.supersedes.includes(el.value)) f.supersedes.push(el.value); refocus('rese-sup'); };
  A['res-edit-sup-remove'] = el => { const f = ui('resEdit'); f.supersedes = f.supersedes.filter(x => x !== el.dataset.doc); refocus('rese-sup'); };
  /** The form's Document facts onto the document: issuance keeps what the form doesn't show (references nobody matched yet);
      applicability keeps only what its level names. Empty facts are removed. */
  function writeFacts(d, f) {
    const iss = { ...(d.issuance || {}), number: f.number.trim(), issued: fromDay(f.issued), effective: fromDay(f.effective), issuer: conceptById(f.issuer) ? f.issuer : '', supersedes: [...f.supersedes] };
    Object.keys(iss).forEach(k => { const v = iss[k]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) delete iss[k]; });
    if (Object.keys(iss).length) d.issuance = iss; else delete d.issuance;
    const level = f.level;
    if (!level) { delete d.applicability; return; }
    const cohorts = level === 'cohort' ? [...new Set(f.cohorts.split(/\D+/).filter(Boolean).map(Number).filter(y => y >= 1900 && y <= 2100))] : [];
    d.applicability = { ...(d.applicability || {}), level, units: level === 'unit' ? [...f.units] : [], programs: ['program', 'cohort'].includes(level) ? [...f.programs] : [], cohorts };
  }
  A['res-edit-go'] = async () => {
    const f = ui('resEdit'), d = docById(f.id); if (f.busy || !d) return;
    f.touched = true;
    if (!f.name.trim()) { refreshLayer(); $('#rese-name')?.focus(); return; }
    const prev = Object.fromEntries(EDIT_KEYS.map(k => [k, d[k] === undefined ? undefined : clone(d[k])]));
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(400);
    const ext = d.name.slice(docTitle(d).length);
    // Only the schemes the editor changed are set — what they kept there becomes theirs; the others stay as they were,
    // suggestions still awaiting review.
    const changed = classSchemes().map(s => s.id).filter(s => String(f.start[s] || []) !== String(f.concepts[s] || []));
    const before = docAssignments(d).map(a => a.id), machine = classifiedByPipeline(d), proposals = clone(D.conceptProposals || []);
    let c = null;
    if (changed.length) {
      setDocConcepts(d, changed.flatMap(s => f.concepts[s] || []), { schemes: changed });
      // A person changing concepts the pipeline chose is a correction classification learns from (Classification › Suggestions).
      if (machine) c = recordCorrection(d, before, docAssignments(d).map(a => a.id));
      d.classifiedBy = 'person';
    }
    Object.assign(d, { name: f.name.trim() + ext, lang: f.lang, summary: f.summary.trim() || undefined, owner: f.owner.trim() || undefined });
    if (!d.summary) delete d.summary; if (!d.owner) delete d.owner;
    if (factsOffered(d)) writeFacts(d, f);
    audit('Edited resource details', d.name); closeModal(); refresh();
    toast('Details saved', { action: { label: 'Undo', run: () => {
      EDIT_KEYS.forEach(k => { if (prev[k] === undefined) delete d[k]; else d[k] = prev[k]; });
      if (c) { D.reviewCorrections = (D.reviewCorrections || []).filter(x => x !== c); D.conceptProposals = proposals; }
      refresh();
    } } });
  };

  /* ── Link to spaces (space staff / admins) ── */
  A['res-link'] = el => { const d = docById(el.dataset.id); if (!d) return; S.ui.resLink = { id: d.id, picked: [...(d.contexts || [])] }; openModal('res-link', {}); };
  M['res-link'] = () => {
    const f = ui('resLink'), d = docById(f.id), spaces = linkableSpaces();
    const rows = spaces.map(s => checkbox({ checked: f.picked.includes(s.id), act: 'res-link-pick', data: { id: s.id }, label: `<span class="res-opt res-opt--mark">${X.spaceMark ? X.spaceMark(s, 28) : ''}<span class="res-opt__text"><span class="res-opt__name">${esc(s.name)}${s.code ? ` · ${esc(s.code)}` : ''}</span><span class="res-opt__meta">${esc(spaceType(s.type).label)}</span></span></span>` })).join('');
    const n = spaces.filter(s => f.picked.includes(s.id)).length;
    return {
      size: 'sm', title: 'Link to spaces', icon: 'link-2',
      desc: `Show “${esc(docTitle(d))}” in each space’s materials. Access doesn’t change.`,
      body: `<div class="option-list" role="group" aria-label="Spaces">${rows}</div>`,
      footStart: n ? `Shown in ${plural(n, 'space')}` : 'Not in any space yet',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Save links', { v: 'primary', icon: 'check', act: 'res-link-go' }),
    };
  };
  A['res-link-pick'] = el => { const f = ui('resLink'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; refreshLayer(); };
  A['res-link-go'] = () => {
    const f = ui('resLink'), d = docById(f.id), manageable = new Set(linkableSpaces().map(s => s.id)), prev = d.contexts ? [...d.contexts] : undefined;
    const keep = (d.contexts || []).filter(id => !manageable.has(id));
    d.contexts = [...new Set([...keep, ...f.picked.filter(id => manageable.has(id))])];
    if (String(prev || []) === String(d.contexts)) { if (!prev) delete d.contexts; closeModal(); return; }
    audit('Linked a resource to spaces', d.name); closeModal(); refresh();
    toast(res(d).contexts.length ? `Linked to ${plural(res(d).contexts.length, 'space')}` : 'Removed from spaces', { action: { label: 'Undo', run: () => { if (prev) d.contexts = prev; else delete d.contexts; refresh(); } } });
  };
})();

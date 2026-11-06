/* Resources: the shared building blocks every Knowledge surface uses to show
   and act on a resource — type and trust chips, provenance, the list row
   (Save and ⋯ revealed on hover/focus, always on touch), the document card
   (content preview, or a type tile when previews would repeat; Home, Browse
   grid), the metadata list — and the shared actions: save, add to a
   collection, ask (always the Reader's Ask panel: /doc/:id?ask=1), use in a
   workflow, edit details, link to spaces, verify, copy link. The ⋯ menu never
   repeats what its surface shows and holds at most 8 entries. Pages (home.js,
   hub.js, library.js, reader.js, knowledge.js, spaces.js, governance.js)
   compose these; none re-implements them. Titles: docTitle(d) (catalog.js).
   Exports: X.res.*. Actions: res-*, col-new, col-edit. Model: core/catalog.js. */
(() => {
  'use strict';

  function audit(action, target) {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Knowledge', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const canEditRes = d => !!d && canEditKb(kbById(d.kb));
  /** Spaces whose materials the caller may curate. */
  const linkableSpaces = () => (hasModule('spaces') ? (D.spaces || []).filter(s => !s.archived && canManageSpace(s)) : []);

  /* ═══════════════ Visual pieces ═══════════════ */
  const kindChip = (d, { size = 'sm' } = {}) => { const k = kindMeta(res(d).kind); return chip(k.label, { icon: k.icon, size }); };
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
  const topicHref = id => catalogHref({ filters: { topic: [id] } });
  function topicChips(d, { max = 2 } = {}) {
    const t = res(d).topics.slice(0, max);
    return t.length ? `<span class="res-topics">${t.map(id => `<a class="res-topic" href="#${topicHref(id)}">${esc(topicName(id))}</a>`).join('')}</span>` : '';
  }
  /** Fictional-data marker for demo workspaces. */
  const demoChip = () => (isDemoWs() ? chip('Demo data', { size: 'sm', icon: 'info', tip: curWs().demo }) : '');
  /** Knowledge area header: title, demo marker, section tabs (Browse · My library) and the page's actions. Managing knowledge bases lives in Manage. */
  const HUB_TABS = [['browse', 'Browse', '/knowledge'], ['library', 'My library', '/knowledge/library']];
  function hubHeader(active, { actions = '', desc = '' } = {}) {
    const nav = `<nav class="tabs hub-tabs" aria-label="Knowledge sections" data-overflow><div class="tabs__list">${HUB_TABS.map(([id, label, to]) => `<a class="tabs__tab" href="#${to}" ${id === active ? 'aria-current="page"' : ''}>${esc(label)}</a>`).join('')}</div></nav>`;
    return pageHeader({ title: 'Knowledge', extra: demoChip(), desc, actions }) + `<div class="hub-nav">${nav}</div>`;
  }
  /** Knowledge header entry point: Contribute (review before publishing) for contributors; otherwise upload to My files. */
  const uploadBtn = (v = 'secondary') => (canContribute() ? btn('Contribute', { v, icon: 'upload', act: 'contribute' }) : visibleKbs().some(k => k.personal) ? btn('Upload', { v, icon: 'upload', act: 'contribute', data: { private: '1' } }) : '');

  /* ═══════════════ Row, card, table ═══════════════ */
  /** Rich list row. opts: q (highlight + snippet), act (default open), data, active, note (collection note), trail (always-visible next step,
      e.g. Revise or Process), reveal (secondary actions shown with Save and ⋯ on hover/focus), select (uiKey for checkbox), pos (position
      in an ordered list), read (already opened: a quiet check), hide (['kb']: context every row in the list shares — a knowledge base's
      own page, My files — so it isn't repeated on each row). Save and ⋯ appear on hover or keyboard focus (always on touch); a saved
      bookmark stays visible. */
  function row(d, { q = '', act = 'res-open', data, active = false, note = '', trail = '', reveal = '', select, compact = false, hide = [], pos, read = false } = {}) {
    const r = res(d), toks = tokens(q), k = kindMeta(r.kind);
    const snip = q ? resSnippet(d, q) : '';
    const meta = [esc(k.label), !hide.includes('kb') && esc(r.kb?.name || ''), `Updated ${esc(rel(d.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase()))}`].filter(Boolean).join('<span class="res-dot" aria-hidden="true">·</span>');
    // The source glyph says where a document comes from; for an upload it adds nothing, so it's left out.
    const src = r.source.app && r.source.app !== 'upload' ? appIcon(r.source.app, 'sm') : '';
    const about = compact ? '' : snip || markTokens(blurb(d), toks);
    const desc = about ? `<span class="res-row__summary">${about}</span>` : '';
    const title = docTitle(d);
    const sel = select ? `<span class="res-row__check">${checkbox({ checked: !!ui(select).sel?.[d.id], act: 'sel-toggle', data: { ui: select, id: d.id }, aria: 'Select ' + title })}</span>` : '';
    const done = read ? `<span class="res-row__read">${ic('check', 'i-xs')}Read</span>` : '';
    return `<div class="${cx('res-row', active && 'is-active', compact && 'res-row--compact')}" role="button" tabindex="0" data-act="${act}" ${dataAttrs({ id: d.id, ...(data || {}) })} ${active ? 'aria-current="true"' : ''}>
      ${sel}${pos != null ? `<span class="res-row__pos num"><span class="sr-only">Item </span>${pos}</span>` : ''}<span class="res-row__lead">${fileIcon(d.type)}</span>
      <span class="res-row__body">
        <span class="res-row__title"><span class="truncate">${markTokens(title, toks)}</span>${trustChip(d, { quiet: true })}${statusChip(d)}${done}</span>
        <span class="res-row__meta">${src}${meta}</span>
        ${desc}${note ? `<span class="res-row__note">${ic('note', 'i-xs')}<span>${esc(note)}</span></span>` : ''}
        ${compact ? '' : topicChips(d)}
      </span>
      <span class="res-row__trail">${trail}<span class="reveal-on-hover">${reveal}${saveBtn(d)}${moreBtn(d)}</span></span>
    </div>`;
  }
  const rows = (docs, opts) => `<div class="res-list">${docs.map(d => row(d, typeof opts === 'function' ? opts(d) : opts)).join('')}</div>`;

  /* ═══════════════ Document card + preview ═══════════════ */
  const FMT_TONE = { pdf: 'danger', word: 'accent', sheet: 'success', slides: 'warning' };
  const DOT = '<span class="res-dot" aria-hidden="true">·</span>';
  const glanceCache = new Map();
  /** What the rendition holds, cached per version: the first pages (ids dropped so previews can share them), length ("6 pages"),
      layout (sheet, slides, text), its sections with their passages, and the opening paragraph. Null without a readable rendition. */
  function glance(d) {
    if (!X.docModel || !isSearchable(d)) return null;
    const key = [S.ws, d.id, d.updated, d.status, d.name].join('|');
    if (!glanceCache.has(key)) {
      const m = X.docModel(d), first = m?.pages?.[0];
      const layout = /doc-page--sheet/.test(first?.cls) ? 'sheet' : /doc-page--slide/.test(first?.cls) ? 'slides' : 'text';
      const blocks = m?.blocks || [], sections = [];
      blocks.forEach(b => { let s = sections.find(x => x.title === b.heading); if (!s) sections.push(s = { title: b.heading, page: b.page, blocks: [] }); s.blocks.push(b); });
      glanceCache.set(key, first ? {
        layout, sections, blocks,
        pages: m.pages.slice(0, 2).map(p => ({ cls: p.cls || '', html: p.html.replace(/\sid="[^"]*"/g, '') })),
        count: m.pages.length,
        // Length as the file's own app would put it: pages, slides, a spreadsheet — or just the format for web-like files.
        extent: ({ sheet: 'Spreadsheet', slide: plural(m.count || m.pages.length, 'slide'), markdown: 'Markdown', web: 'Web page', text: 'Plain text', email: 'Email' })[m.format] || plural(m.count || m.pages.length, 'page'),
        opening: blocks.find(b => b.kind === 'p' && b.text)?.text || '',
      } : null);
    }
    return glanceCache.get(key);
  }
  /** Sections people open each kind of document for — steps in a procedure, decisions in notes, findings in a report, rules in a policy.
      Matched against the document's own section titles; a preview never invents content. */
  const KEY_SECTION = {
    procedure: /step|how|process|checklist/i, guide: /step|how|getting started|key/i, handbook: /how|key|work/i, playbook: /key|play|talk|step|pitch|how/i,
    form: /step|checklist|require/i, notes: /decision|action|outcome|next/i, report: /finding|result|recommend|conclusion|key|summary/i,
    policy: /rule|require|limit|approv|eligib|entitle|allowance|pay/i, spec: /endpoint|event|schema|object|decision|error|limit|auth|retention|component|code/i,
    contract: /term|obligation|fee|payment|termination/i, calendar: /date|deadline|schedule/i,
  };
  const INTRO = /^(overview|purpose|welcome|introduction|summary|about|context|background|parties)$/i;
  /** The best block for a query (most query words, earliest first). */
  function matchBlock(g, toks) {
    let best = null, bestN = 0;
    g.blocks.forEach(b => { const low = fold(b.text), n = toks.filter(t => low.includes(t)).length; if (n > bestN) { best = b; bestN = n; } });
    return best;
  }
  /** The section a preview shows: where the search matches (unless the title already explains the match); else the one this kind of
      document is opened for (concrete, structured), skipping the introduction the summary already covers; else the first. */
  function focusSection(d, g, toks) {
    const titleHit = toks.length && toks.every(t => fold(d.name).includes(t));
    const hit = toks.length && !titleHit ? matchBlock(g, toks) : null;
    if (hit) return { section: g.sections.find(s => s.title === hit.heading), hit };
    const re = KEY_SECTION[res(d).kind];
    const score = (s, i) => (re?.test(s.title) ? 4 : 0) + (s.blocks.some(b => b.kind === 'li' || b.kind === 'row') ? 2 : 0) + (s.blocks.some(b => /\d/.test(b.text)) ? 1 : 0) - (INTRO.test(s.title) && g.sections.length > 1 ? 3 : 0) - i * 0.01;
    return { section: g.sections.map((s, i) => [s, score(s, i)]).sort((a, b) => b[1] - a[1])[0]?.[0] };
  }
  const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);
  /** What a text preview would show (section + its first passage), so a page of cards can tell when two previews would look the same
      (templated renditions) and fall back to the type tile. '' when the preview is a real page (sheets, slides) or a tile anyway. */
  function previewKey(d, q = '') {
    const g = glance(d); if (!g || g.layout !== 'text' || !g.sections.length) return '';
    const s = focusSection(d, g, tokens(q)).section; if (!s) return '';
    const b = s.blocks.find(x => x.kind === 'li' || x.kind === 'row') || s.blocks[0];
    return fold(s.title) + '|' + fold(b?.text || '').slice(0, 80);
  }
  /** Card preview. Sheets and slides show their first page (a grid, a slide); text documents show their most useful section at a readable size,
      with the query highlighted when searching; no rendition, or plain (the section would look like another card's) → a tinted type tile.
      Decorative: the card's text says the same for assistive tech. */
  function preview(d, { q = '', plain = false } = {}) {
    const g = plain ? null : glance(d), toks = tokens(q);
    if (g && g.layout !== 'text') {
      const p = g.pages[0];
      return `<div class="${cx('doc-thumb', g.layout === 'slides' && 'doc-thumb--slide')}" aria-hidden="true" inert><div class="doc-thumb__page"><div class="${cx('doc-page', p.cls)}">${p.html}</div></div></div>`;
    }
    const f = g?.sections.length ? focusSection(d, g, toks) : null;
    if (f?.section) {
      const s = f.section, items = s.blocks.filter(b => b.kind === 'li' || b.kind === 'row'), paras = s.blocks.filter(b => b.kind === 'p');
      const from = f.hit ? Math.max(0, items.indexOf(f.hit)) : 0, shown = items.slice(from, from + 4);
      const cells = b => b.text.split(' · ').map(x => { const i = x.indexOf(': '); return i > 0 && i < 40 ? [x.slice(0, i), x.slice(i + 2)] : ['', x]; });
      const body = items.length < 2 || (f.hit && !items.includes(f.hit))
        ? `<p>${markTokens(clip((f.hit || paras[0] || s.blocks[0]).text, 240), toks)}</p>`
        : shown.every(b => b.kind === 'row')
          ? `<table><thead><tr>${cells(shown[0]).map(([h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${shown.map(b => `<tr>${cells(b).map(([, v]) => `<td>${markTokens(clip(v, 60), toks)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
          : `<ul>${shown.map(b => `<li>${markTokens(clip(b.text, 110), toks)}</li>`).join('')}</ul>`;
      return `<div class="doc-thumb doc-thumb--focus" aria-hidden="true" inert><div class="doc-focus"><div class="doc-focus__head"><span class="doc-focus__title">${esc(s.title)}</span>${g.count > 1 ? `<span class="doc-focus__page">p. ${esc(String(f.hit?.page || s.page))}</span>` : ''}</div>${body}</div></div>`;
    }
    // The tile names the format and kind only: the card's title and summary sit right below it.
    const k = kindMeta(res(d).kind), tone = FMT_TONE[formatOf(d)[0]] || 'default';
    return `<div class="doc-thumb doc-thumb--blank doc-thumb--${tone}" aria-hidden="true">${fileIcon(d.type, 'lg')}<span class="doc-thumb__kind">${ic(k.icon, 'i-xs')}${esc(k.label)}</span></div>`;
  }
  /** The passage that best matches a query: { where: "Page 2 · Approvals", html }. */
  function matchPassage(d, q) {
    const toks = tokens(q), g = glance(d);
    const b = toks.length && g ? matchBlock(g, toks) : null;
    return b ? { where: [g.layout !== 'sheet' && `Page ${b.page}`, b.heading].filter(Boolean).join(' · '), html: markTokens(clip(b.text, 220), toks) } : null;
  }
  /** One line on what a document is for: its summary, else its opening paragraph. Never a generated "Guide in …" filler. */
  const blurb = d => d.summary || glance(d)?.opening || '';
  /** Trust only where it changes a decision: a quiet Verified mark, a Review due chip; nothing for unverified or personal files. */
  function trustMark(d) {
    const t = trustOf(d);
    if (t.state === 'verified') return `<span class="doc-card__ok" data-tip="${esc(t.note)}">${ic('shield-check', 'i-sm')}<span class="sr-only">Verified</span></span>`;
    return t.state === 'review' ? chip(t.label, { tone: t.tone, icon: t.icon, size: 'sm', tip: t.note }) : '';
  }
  /** Document card (Knowledge grid): recognise a document and judge it without opening it. A content preview, the title, one line on
      what it is for, its type and where it lives, and trust only when it matters. Save and ⋯ appear on hover/focus (always on touch).
      opts: act + data (what selecting the card does, e.g. a quick preview), q (preview the matching section, highlight),
      hide (['kb', 'topic']: context every card in the set shares, so it isn't repeated), plain (type tile instead of a section preview). */
  function card(d, { act, data, q = '', hide = [], plain = false }) {
    const r = res(d), g = glance(d), toks = tokens(q), k = kindMeta(r.kind), topic = r.topics[0];
    const where = !hide.includes('topic') && topic ? topicName(topic) : !hide.includes('kb') ? r.kb?.name || '' : '';
    const about = blurb(d);
    return `<article class="doc-card" role="button" tabindex="0" data-act="${act}" ${dataAttrs({ id: d.id, ...(data || {}) })}>
      <div class="doc-card__media">${preview(d, { q, plain })}${g ? `${plain ? '' : `<span class="doc-card__type">${fileIcon(d.type, 'sm')}</span>`}<span class="doc-card__extent">${esc(g.extent)}</span>` : ''}
        <div class="doc-card__actions">${saveBtn(d)}${moreBtn(d)}</div></div>
      <div class="doc-card__body">
        <h3 class="doc-card__title">${markTokens(docTitle(d), toks)}</h3>
        ${about ? `<p class="doc-card__about">${markTokens(about, toks)}</p>` : ''}
        <div class="doc-card__meta"><span class="doc-card__kind">${ic(k.icon, 'i-xs')}<span class="truncate">${esc(k.label)}${where ? DOT + esc(where) : ''}</span></span>${statusChip(d)}${trustMark(d)}</div>
      </div>
    </article>`;
  }

  /** Metadata list (About): what it is, where it lives, where it came from, who owns it, who can see it. */
  function details(d) {
    const r = res(d), t = trustOf(d), who = X.whoCanSee ? X.whoCanSee(r.kb) : { icon: 'lock', label: '' };
    const spaces = r.contexts.map(spaceById).filter(Boolean);
    return kv([
      ['Type', `<span class="row gap-6">${ic(kindMeta(r.kind).icon, 'i-sm muted')}${esc(kindMeta(r.kind).label)}</span>`],
      ['Topics', r.topics.length ? `<span class="res-topics">${r.topics.map(id => `<a class="res-topic" href="#${topicHref(id)}">${esc(topicName(id))}</a>`).join('')}</span>` : '<span class="muted">None yet</span>'],
      hasModule('spaces') && ['Spaces', spaces.length ? spaces.map(s => `<a class="link" href="#/space/${s.id}">${esc(s.code ? `${s.name} · ${s.code}` : s.name)}</a>`).join(', ') : '<span class="muted">Not linked</span>'],
      ['Owner', esc(r.owner || 'No owner')],
      ['Knowledge base', r.kb ? `<a class="link" href="#${kbHref(r.kb)}">${esc(r.kb.name)}</a>` : '—'],
      ['Source', `<span class="stack gap-2"><span class="row gap-6">${appIcon(r.source.app, 'sm')}${esc(r.source.name)}</span><span class="t-xs muted res-path">${esc(r.source.path)}</span></span>`],
      ['Trust', `<span class="stack gap-2">${trustChip(d) || esc(t.label)}<span class="t-xs muted">${esc(t.note || t.desc)}</span></span>`],
      ['Version', `v${r.version} · ${esc(fmtDate(d.updated))}`],
      ['Language', esc(LANGS[r.lang] || r.lang)],
      ['Who can see it', `<span class="row gap-6">${ic(who.icon, 'i-sm muted')}${esc(who.label)}</span>`],
    ]);
  }

  X.res = { kindChip, trustChip, statusChip, saveBtn, moreBtn, provenance, topicChips, topicHref, demoChip, hubHeader, uploadBtn, row, rows, card, previewKey, glance, blurb, matchPassage, details, canEditRes, linkableSpaces };

  /* ═══════════════ Actions ═══════════════ */
  /** Knowledge dialogs validate on submit, then clear the error as soon as the field is filled (data-input="kn-revalidate"
      data-form="<S.ui key>"). Re-renders only when the error goes away, so typing (and Vietnamese IME composition) isn't interrupted. */
  A['kn-revalidate'] = el => { const f = S.ui[el.dataset.form]; if (f?.touched && el.value.trim()) { f.touched = false; refreshLayer(); } };
  /** A document row anywhere (library, collections, search, Related, spaces' materials): preview first, open full later (preview.js). */
  A['res-open'] = el => { const { id, q } = el.dataset; X.preview.open({ id, q }); };
  A['res-save'] = el => {
    const d = docById(el.dataset.id); if (!d) return;
    const on = toggleSaved(d.id); refresh();
    toast(on ? `Saved “${docTitle(d)}”` : `Removed “${docTitle(d)}” from saved`, { action: { label: 'Undo', run: () => { toggleSaved(d.id); refresh(); } } });
  };
  A['res-copy-link'] = el => copyText(location.href.split('#')[0] + '#/doc/' + el.dataset.id, 'Link copied');
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
      { label: 'Add to collection…', icon: 'list-plus', run: () => A['res-collect']({ dataset: { id: d.id } }) },
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
      isAdmin() && isPublishedStage(d) && !personal && { label: isFeatured(d.id) ? 'Remove from Home' : 'Feature on Home', icon: 'home', run: () => { const on = toggleFeatured(d.id); refresh(); toast(on ? 'Featured on Home for everyone who can read it' : 'Removed from Home', { action: { label: 'Undo', run: () => { toggleFeatured(d.id); refresh(); } } }); } },
      canReviewKb(kb) && can('knowledge.manage') && { label: 'Manage in Documents', icon: 'files', run: () => go('/documents?tab=all&q=' + encodeURIComponent(docTitle(d))) },
    ].filter(Boolean);
    const archive = edit ? [{ sep: true }, { label: 'Archive', icon: 'archive', danger: true, run: () => X.archiveDocs?.([d]) }] : [];
    if (!manage.length) return [...head, ...archive];
    const section = [{ section: 'Manage' }, ...manage, ...archive];
    if (nItems(head) + nItems(section) <= MENU_MAX) return [...head, ...section];
    return [...head, { sep: true }, { label: 'Manage…', icon: 'settings', run: () => openMenu(el, section, 'res-manage:' + d.id) }];
  };

  /* ── Add to collection ── */
  A['res-collect'] = el => {
    const ids = (el.dataset.ids || el.dataset.id || '').split(',').filter(Boolean); if (!ids.length) return;
    const editable = visibleCollections().filter(canEditCollection);
    const had = editable.filter(c => ids.every(id => c.items.some(i => i.doc === id))).map(c => c.id);
    S.ui.resCollect = { ids, had, picked: [...had], name: '', creating: !editable.length, touched: false };
    openModal('res-collect', {});
  };
  /** What saving does: collections that gain the resources (a new one counts) and, for one resource, the ones that lose it. */
  const collectDelta = f => ({ add: f.picked.filter(id => !f.had.includes(id)).length + (f.creating && f.name.trim() ? 1 : 0), drop: f.ids.length === 1 ? f.had.filter(id => !f.picked.includes(id)).length : 0 });
  M['res-collect'] = () => {
    const f = ui('resCollect'), editable = visibleCollections().filter(canEditCollection), n = f.ids.length, { add, drop } = collectDelta(f);
    const err = f.touched && !add && !drop ? (f.creating ? 'Name the new collection.' : 'Pick a collection or create a new one.') : '';
    const rows = editable.map(c => { const s = shareLabel(c); return checkbox({ checked: f.picked.includes(c.id), act: 'res-collect-pick', data: { id: c.id }, label: `<span class="res-opt"><span class="res-opt__name">${esc(c.name)}</span><span class="res-opt__meta">${ic(s.icon, 'i-xs')}<span class="truncate">${esc(s.label)}</span>${DOT}${plural(c.items.length, 'item')}</span></span>` }); }).join('');
    const create = f.creating
      ? field({ id: 'resc-name', label: rows ? 'New collection' : 'Name your first collection', error: err, desc: 'Only you can see it until you share it.', control: input({ id: 'resc-name', bind: 'resCollect.name', value: f.name, placeholder: 'e.g. On-call reading list', autofocus: true, onEnter: 'res-collect-go', invalid: !!err, attrs: 'maxlength="60" data-input="kn-revalidate" data-form="resCollect"' }) })
      : `${err ? `<div class="field-error mb-8" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : ''}${btn('New collection', { v: 'ghost', size: 'sm', icon: 'plus', act: 'res-collect-new', cls: 'res-newcol' })}`;
    const what = n === 1 ? `“${esc(docTitle(docById(f.ids[0])))}”` : plural(n, 'resource');
    const label = drop ? 'Save changes' : f.creating ? 'Create and add' : add > 1 ? `Add to ${add} collections` : 'Add to collection';
    return {
      size: 'md', title: 'Add to collection', icon: 'list-plus',
      desc: `Group ${what} with related reading.`,
      body: `<div class="stack gap-12">${rows ? `<div class="option-list" role="group" aria-label="Collections">${rows}</div>` : ''}<div>${create}</div></div>`,
      footStart: 'Documents keep their own access.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(label, { v: 'primary', icon: drop ? 'check' : 'plus', act: 'res-collect-go' }),
    };
  };
  A['res-collect-pick'] = el => { const f = ui('resCollect'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; f.touched = false; refreshLayer(); };
  A['res-collect-new'] = () => { const f = ui('resCollect'); f.creating = true; f.touched = false; refreshLayer(); requestAnimationFrame(() => $('#resc-name')?.focus()); };
  A['res-collect-go'] = () => {
    const f = ui('resCollect'), editable = visibleCollections().filter(canEditCollection), { add, drop } = collectDelta(f);
    if (!add && !drop) {
      // Nothing to change: already where it belongs, or nothing chosen yet.
      if (f.had.length && !f.creating) { closeModal(); return; }
      f.touched = true; refreshLayer(); $(f.creating ? '#resc-name' : '.option-list input')?.focus(); return;
    }
    const name = (f.name || '').trim(), before = new Map(editable.map(c => [c, { items: [...c.items], updated: c.updated }]));
    let created = null, added = 0, removed = 0;
    if (f.creating && name) {
      created = { id: uid('col'), name, desc: '', owner: me().id, share: 'private', created: Date.now(), updated: Date.now(), items: [] };
      (D.collections ??= []).unshift(created); f.picked.push(created.id); audit('Created a collection', name);
    }
    [...editable, ...(created ? [created] : [])].forEach(c => {
      const want = f.picked.includes(c.id);
      f.ids.forEach(id => {
        const has = c.items.some(i => i.doc === id);
        if (want && !has) { c.items.push({ doc: id, added: Date.now() }); added++; c.updated = Date.now(); }
        if (!want && has && f.ids.length === 1) { c.items = c.items.filter(i => i.doc !== id); removed++; c.updated = Date.now(); }
      });
    });
    closeModal(); refresh();
    const gained = [...(created ? [created] : []), ...editable.filter(c => f.picked.includes(c.id) && !f.had.includes(c.id))];
    const undo = () => { before.forEach((s, c) => { c.items = s.items; c.updated = s.updated; }); if (created) D.collections = D.collections.filter(c => c !== created); persist(); refresh(); };
    if (added && gained.length) toast(`Added to “${gained[0].name}”${gained.length > 1 ? ` and ${plural(gained.length - 1, 'other')}` : ''}`, { action: { label: 'Open', run: () => go('/knowledge/collections/' + gained[0].id) } });
    else if (removed) toast(removed === 1 ? 'Removed from the collection' : `Removed from ${plural(removed, 'collection')}`, { action: { label: 'Undo', run: undo } });
  };

  /* ── Create / edit a collection ── */
  /** Who can see a collection: only you, the members of one space you run, or everyone (admins). A space the collection is already
      shared with stays selectable even if you no longer run it. */
  function colScopes(f) {
    const cur = f.share.startsWith('space:') ? spaceById(f.share.slice(6)) : null, mine = linkableSpaces();
    const spaces = cur && !mine.includes(cur) ? [cur, ...mine] : mine;
    const spName = s => (s.code ? `${s.name} · ${s.code}` : s.name);
    const opts = [
      ['private', 'Only me', 'A personal reading list.', 'lock'],
      spaces.length && ['space', 'A space', spaces.length === 1 ? `Members of ${esc(spName(spaces[0]))}.` : 'Its members can see it.', 'layers'],
      (isAdmin() || f.share === 'workspace') && ['workspace', 'Everyone', `Anyone in ${esc(curWs().name)}.`, 'globe'],
    ].filter(Boolean);
    return { opts, spaces, spName };
  }
  function colEditState(c, ids = []) {
    const share = c?.share || 'private', sp = share.startsWith('space:') ? share.slice(6) : linkableSpaces()[0]?.id || '';
    return { id: c?.id || '', name: c?.name || '', desc: c?.desc || '', share, scope: share === 'workspace' ? 'workspace' : share.startsWith('space:') ? 'space' : 'private', space: sp, ids, touched: false, busy: false };
  }
  /** A['col-new']({dataset:{ids?}}) creates a collection (optionally with resources); A['col-edit']({dataset:{id}}) edits one. */
  A['col-new'] = el => { S.ui.colEdit = colEditState(null, (el?.dataset?.ids || '').split(',').filter(Boolean)); openModal('col-edit', {}); };
  A['col-edit'] = el => { const c = collectionById(el.dataset.id); if (!canEditCollection(c)) return; S.ui.colEdit = colEditState(c); openModal('col-edit', {}); };
  M['col-edit'] = () => {
    const f = ui('colEdit'), err = f.touched && !f.name.trim() ? 'Enter a name.' : '', dis = f.busy ? 'disabled' : '';
    const { opts, spaces, spName } = colScopes(f);
    const spacePick = f.scope === 'space' && spaces.length > 1
      ? `<div class="col-space">${field({ id: 'col-space', label: 'Which space?', control: select({ id: 'col-space', bind: 'colEdit.space', value: f.space, options: spaces.map(s => [s.id, spName(s)]), attrs: dis }) })}</div>` : '';
    const who = opts.length > 1
      ? `<div class="field col-scope"><span class="label" id="col-scope-l">Who can see it</span>${choiceGroup({ name: 'col-scope', value: f.scope, act: 'col-edit-scope', options: opts, cols: opts.length })}${spacePick}</div>`
      : `<p class="col-only">${ic('lock', 'i-sm')}<span>Only you can see it.</span></p>`;
    const n = f.ids.length;
    return {
      size: 'md', title: f.id ? 'Edit collection' : 'New collection', icon: f.id ? 'pencil' : 'list',
      desc: f.id ? 'Change its name, description or who can see it.' : n ? `A reading list that starts with ${plural(n, 'resource')}.` : 'A reading list you can order, annotate and share.',
      body: `<div class="kn-form">${field({ id: 'col-name', label: 'Name', required: true, error: err, control: input({ id: 'col-name', bind: 'colEdit.name', value: f.name, placeholder: 'e.g. On-call reading list', autofocus: true, onEnter: 'col-edit-go', invalid: !!err, attrs: `maxlength="60" data-input="kn-revalidate" data-form="colEdit" ${dis}` }) })}
        ${field({ id: 'col-desc', label: 'Description', optional: true, control: textarea({ id: 'col-desc', bind: 'colEdit.desc', value: f.desc, rows: 2, placeholder: 'What it’s for and who should read it', attrs: `maxlength="200" ${dis}` }) })}
        ${who}</div>`,
      footStart: 'Documents keep their own access.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn(f.id ? 'Save changes' : 'Create collection', { v: 'primary', icon: f.id ? 'check' : 'plus', act: 'col-edit-go', loading: f.busy }),
    };
  };
  A['col-edit-scope'] = el => { ui('colEdit').scope = el.dataset.value; refreshLayer(); };
  A['col-edit-go'] = async () => {
    const f = ui('colEdit'); if (f.busy) return;
    f.touched = true;
    if (!f.name.trim()) { refreshLayer(); $('#col-name')?.focus(); return; }
    const { spaces } = colScopes(f);
    const share = f.scope === 'space' ? 'space:' + (spaces.some(s => s.id === f.space) ? f.space : spaces[0]?.id) : f.scope === 'workspace' ? 'workspace' : 'private';
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(400);
    if (f.id) {
      const c = collectionById(f.id), prev = { name: c.name, desc: c.desc, share: c.share, updated: c.updated };
      Object.assign(c, { name: f.name.trim(), desc: f.desc.trim(), share, updated: Date.now() });
      audit('Updated a collection', c.name); closeModal(); refresh();
      toast('Collection saved', { action: { label: 'Undo', run: () => { Object.assign(c, prev); persist(); refresh(); } } }); return;
    }
    const c = { id: uid('col'), name: f.name.trim(), desc: f.desc.trim(), owner: me().id, share, created: Date.now(), updated: Date.now(), items: f.ids.map(doc => ({ doc, added: Date.now() })) };
    (D.collections ??= []).unshift(c); audit('Created a collection', c.name);
    closeModal(); go('/knowledge/collections/' + c.id); toast(c.items.length ? `Created “${c.name}”` : `Created “${c.name}”. Add resources to start the list.`);
  };

  /* ── Edit details (editors of the knowledge base) ── */
  A['res-edit'] = el => {
    const d = docById(el.dataset.id); if (!canEditRes(d)) return; const r = res(d);
    // People edit the title; the file keeps its extension (the format badge already says PDF/MD).
    S.ui.resEdit = { id: d.id, name: docTitle(d), kind: r.kind, topics: [...r.topics], owner: d.owner || '', lang: r.lang, summary: d.summary || '', touched: false, busy: false, showTopics: !r.topics.length, more: false };
    openModal('res-edit', {});
  };
  M['res-edit'] = () => {
    const f = ui('resEdit'), d = docById(f.id), r = res(d), err = f.touched && !f.name.trim() ? 'Enter a title.' : '', dis = f.busy ? 'disabled' : '';
    const kinds = Object.entries(RESOURCE_KINDS).map(([id, k]) => [id, `${k.group} · ${k.label}`]);
    const tree = topicTree();
    const topics = tree.map(dm => `<div class="res-tgroup"><div class="res-tgroup__title">${esc(dm.name)}</div><div class="res-tgroup__items">${dm.children.map(t => checkbox({ checked: f.topics.includes(t.id), act: 'res-edit-topic', data: { id: t.id }, label: esc(t.name), disabled: f.busy })).join('')}</div></div>`).join('');
    const names = f.topics.map(topicName);
    const topicSum = names.length ? esc(names.slice(0, 2).join(', ')) + (names.length > 2 ? ` +${names.length - 2}` : '') : 'None yet';
    const kbOwner = ownerOfKb(r.kb) || '';
    const moreSum = esc([LANGS[f.lang] || f.lang, f.owner.trim() || kbOwner].filter(Boolean).join(' · '));
    return {
      size: 'lg', title: 'Edit details', icon: 'pencil',
      desc: 'What people see in search results, previews and the reader.',
      body: `<div class="kn-form">${field({ id: 'rese-name', label: 'Title', required: true, error: err, control: input({ id: 'rese-name', bind: 'resEdit.name', value: f.name, autofocus: true, onEnter: 'res-edit-go', invalid: !!err, attrs: `maxlength="160" data-input="kn-revalidate" data-form="resEdit" ${dis}` }) })}
        ${field({ id: 'rese-kind', label: 'Type', control: select({ id: 'rese-kind', bind: 'resEdit.kind', value: f.kind, options: kinds, attrs: dis }) })}
        ${field({ id: 'rese-sum', label: 'Summary', optional: true, desc: 'One or two sentences shown in results and previews.', control: textarea({ id: 'rese-sum', bind: 'resEdit.summary', value: f.summary, rows: 2, attrs: `maxlength="280" ${dis}` }) })}
        <div class="stack gap-8">${tree.length ? disclosure({ path: 'resEdit.showTopics', icon: 'tag', title: 'Topics', summary: topicSum, body: `<div class="res-tgroups">${topics}</div>` }) : '<p class="t-sm muted">This workspace has no topics yet.</p>'}
        ${disclosure({ path: 'resEdit.more', icon: 'sliders', title: 'Language and owner', summary: moreSum, body: `<div class="grid cols-2 res-more">${field({ id: 'rese-lang', label: 'Language', control: select({ id: 'rese-lang', bind: 'resEdit.lang', value: f.lang, options: Object.entries(LANGS), change: 'res-edit-refresh', attrs: dis }) })}${field({ id: 'rese-owner', label: 'Owner', optional: true, desc: kbOwner ? `Empty uses the knowledge base owner, ${esc(kbOwner)}.` : '', control: input({ id: 'rese-owner', bind: 'resEdit.owner', value: f.owner, placeholder: kbOwner || 'Team or office', onEnter: 'res-edit-go', attrs: dis }) })}</div>` })}</div></div>`,
      footStart: 'Changes show for everyone right away.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Save changes', { v: 'primary', icon: 'check', act: 'res-edit-go', loading: f.busy }),
    };
  };
  A['res-edit-refresh'] = () => refreshLayer();
  A['res-edit-topic'] = el => { const f = ui('resEdit'), id = el.dataset.id; f.topics = f.topics.includes(id) ? f.topics.filter(x => x !== id) : [...f.topics, id]; refreshLayer(); };
  A['res-edit-go'] = async () => {
    const f = ui('resEdit'), d = docById(f.id); if (f.busy || !d) return;
    f.touched = true;
    if (!f.name.trim()) { refreshLayer(); $('#rese-name')?.focus(); return; }
    const keys = ['name', 'kind', 'topics', 'lang', 'summary', 'owner'], prev = Object.fromEntries(keys.map(k => [k, Array.isArray(d[k]) ? [...d[k]] : d[k]]));
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(400);
    const ext = d.name.slice(docTitle(d).length);
    Object.assign(d, { name: f.name.trim() + ext, kind: f.kind, topics: [...f.topics], lang: f.lang, summary: f.summary.trim() || undefined, owner: f.owner.trim() || undefined });
    if (!d.summary) delete d.summary; if (!d.owner) delete d.owner;
    audit('Edited resource details', d.name); closeModal(); refresh();
    toast('Details saved', { action: { label: 'Undo', run: () => { keys.forEach(k => { if (prev[k] === undefined) delete d[k]; else d[k] = prev[k]; }); refresh(); } } });
  };

  /* ── Link to spaces (space staff / admins) ── */
  A['res-link'] = el => { const d = docById(el.dataset.id); if (!d) return; S.ui.resLink = { id: d.id, picked: [...(d.contexts || [])] }; openModal('res-link', {}); };
  M['res-link'] = () => {
    const f = ui('resLink'), d = docById(f.id), home = kbById(d.kb)?.space, spaces = linkableSpaces();
    const rows = spaces.map(s => {
      const fixed = s.id === home;
      return checkbox({ checked: fixed || f.picked.includes(s.id), disabled: fixed, act: 'res-link-pick', data: { id: s.id }, label: `<span class="res-opt res-opt--mark">${X.spaceMark ? X.spaceMark(s, 28) : ''}<span class="res-opt__text"><span class="res-opt__name">${esc(s.name)}${s.code ? ` · ${esc(s.code)}` : ''}</span><span class="res-opt__meta">${fixed ? 'Always: its knowledge base belongs here' : esc(spaceType(s.type).label)}</span></span></span>` });
    }).join('');
    const n = spaces.filter(s => s.id === home || f.picked.includes(s.id)).length;
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

/* Reader — the universal resource reader (/doc/:id?q&page&from&v&ask).
   Content first: one header row carries Ask (primary), Save and ⋯ (on phones it
   shrinks to title + icons and slides away while reading down); the outline and
   the page canvas (cited-passage and search highlights) show by default, and one
   side panel opens on demand with Tabs Ask · About · Related: Ask answers in
   place from the document's own passages and cites them (the header's Ask, the
   selection toolbar, and ?ask=1 — "Ask about this document" from anywhere);
   About holds details and versions (⋯ → About this document); Related lists
   resources, collections, conversations. ?v= shows an older version: the header
   and trust follow it, Ask and Save stay with the current one. Back appears only
   when the breadcrumb doesn't lead where the reader came from.
   Documents that aren't published (submissions, changes requested, declined,
   unpublished) open as a preview for their contributor and the base's reviewers
   only: lifecycle, who can see it, Track / Revise / Review — no Ask, save or collect.
   Rendition model: X.docModel (documents.js). Shared pieces: X.res (resources.js), X.ctb (contribute.js).
   Prefix: rdr-. */
(() => {
  'use strict';

  const RAIL_MIN = 1024, OUTLINE_MIN = 760;
  const frameW = () => $('#frame')?.clientWidth || innerWidth;
  /** Content first: the side panel (Ask · About · Related) opens on demand and closes when another document opens. The outline is
      the only other panel: open by default for longer documents (outline: null = automatic), and never alongside the side panel. */
  const rdrUi = () => ui('rdr', { outline: null, rail: false, tab: 'ask', hit: 0, hitKey: '', doc: '' });
  const railOpen = u => !!u.rail;
  /** A new document starts with the panel closed. */
  const forDoc = (u, id) => { if (u.doc !== id) Object.assign(u, { doc: id, rail: false, tab: 'ask' }); return u; };
  /** Ask thread per document (transient view state). */
  const askUi = id => ui('rdrAsk-' + id, { q: '', thread: [] });
  const dot = '<span class="res-dot" aria-hidden="true">·</span>';
  const clip = (s, n = 240) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);
  const firstSentence = s => clip(String(s).split(/(?<=[.!?])\s+(?=[A-ZĐ“"(\d])/)[0] || String(s));

  /* Where "Back" goes: the page the reader was opened from (captured before the router renders). */
  let origin = '';
  window.addEventListener('hashchange', e => {
    const from = decodeURI((e.oldURL || '').split('#')[1] || ''), to = decodeURI(location.hash.slice(1));
    if (to.startsWith('/doc/') && from && !from.startsWith('/doc/')) origin = from;
  }, true);
  /** Back only where the breadcrumb doesn't already lead: from a conversation ("Back to conversation"), Home, search, My library, a
      collection or a space. From Browse the breadcrumb's Knowledge is the way back, so Back would only repeat it. */
  function backBtn(conv) {
    if (conv) return iconBtn('arrow-left', 'Back to conversation', { href: '/chat/' + conv.id, cls: 'rdr-back' });
    if (!origin || /^\/knowledge(\?|$)/.test(origin)) return '';
    return iconBtn('arrow-left', 'Back', { act: 'rdr-back', cls: 'rdr-back' });
  }
  /** Phones: the header slides away while reading down and comes back on the way up (HeroUI Navbar shouldHideOnScroll). */
  let headHidden = false;

  /* ═══════════════ Highlights ═══════════════ */
  /** What to highlight. Citations (?page, ?from, long quotes) match as phrases; a plain search (?q only) matches its words. */
  function needles(doc, query, m) {
    const q = (query.q || '').trim(), conv = query.from ? convById(query.from) : null, out = [];
    const cited = !!(query.page || conv || q.length >= 40);
    if (q) {
      if (cited || fold(m.text).includes(fold(q))) out.push({ text: q, page: query.page, cite: cited });
      else tokens(q).filter(t => t.length >= 3).forEach(t => out.push({ text: t, word: true }));
    }
    (conv?.messages || []).forEach(msg => (msg.citations || []).filter(c => c.doc === doc.id).forEach(c => {
      if (!out.some(o => fold(o.text) === fold(c.quote))) out.push({ text: c.quote, page: c.page, cite: true });
    }));
    return out;
  }
  /** Put a cited quote on its page when the rendition doesn't contain it verbatim. */
  function injectQuote(m, quote, pageNo) {
    if (fold(m.text).includes(fold(quote))) return;
    m.text += ' ' + quote;
    let target = m.pages.find(p => p.no === +pageNo);
    if (!target) {
      const id = 'dh-' + m.outline.length; m.outline.push({ id, title: 'Details', page: +pageNo });
      const sheet = m.pages[0]?.cls === 'doc-page--sheet';
      target = { no: +pageNo || (m.pages.at(-1)?.no || 0) + 1, cls: sheet ? '' : (m.pages[0]?.cls || ''), html: `<h3 id="${id}">Details</h3>` };
      m.pages.push(target); m.pages.sort((a, b) => a.no - b.no);
    }
    const tag = `<p>${esc(quote)}</p>`;
    if (target.cls === 'doc-page--sheet') target.html = target.html.replace('<div class="doc-sheet__tabs">', `<div class="doc-sheet__notes"><p class="doc-note">${esc(quote)}</p></div><div class="doc-sheet__tabs">`);
    else { const i = target.html.indexOf('</h3>'); target.html = i >= 0 ? target.html.slice(0, i + 5) + tag + target.html.slice(i + 5) : target.html + tag; }
  }
  const countIn = (text, needle) => { let n = 0, i = 0; const t = fold(text), nd = fold(needle); if (!nd) return 0; while ((i = t.indexOf(nd, i)) !== -1) { n++; i += nd.length; } return n; };
  /* Applied to text nodes after render (accent-insensitive), so markup is never broken. */
  function markHits(root, list) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const nds = list.map(fold).filter(Boolean);
    nodes.forEach(n => {
      if (n.parentElement?.closest('.doc-run, .doc-foot, .doc-viewer__bar, .doc-fx, .doc-mail, .rdr-banners')) return;
      const text = n.nodeValue, low = fold(text); let ranges = [];
      if (low.length !== text.length) return;
      nds.forEach(nd => { let i = 0; while ((i = low.indexOf(nd, i)) !== -1) { ranges.push([i, i + nd.length]); i += nd.length; } });
      if (!ranges.length) return;
      ranges.sort((a, b) => a[0] - b[0]); ranges = ranges.filter((r, i) => !i || r[0] >= ranges[i - 1][1]);
      const frag = document.createDocumentFragment(); let at = 0;
      ranges.forEach(([s, e]) => { if (s > at) frag.append(text.slice(at, s)); const mk = document.createElement('mark'); mk.className = 'evidence'; mk.textContent = text.slice(s, e); frag.append(mk); at = e; });
      if (at < text.length) frag.append(text.slice(at));
      n.replaceWith(frag);
    });
    return $$('mark.evidence', root);
  }

  /* ═══════════════ Ask: answers grounded in the document's passages ═══════════════ */
  const PROMPTS = {
    policy: ['What are the deadlines?', 'Who does this apply to?', 'What do I need to do?', 'Summarize this'],
    procedure: ['What do I need to do?', 'What are the deadlines?', 'Summarize this'],
    form: ['What do I need to do?', 'Summarize this'],
    calendar: ['What are the key dates?', 'Summarize this'],
    announcement: ['What do I need to do?', 'What are the deadlines?', 'Summarize this'],
    guide: ['What are the key steps?', 'What are the deadlines?', 'Summarize this'],
    lecture: ['Explain the key idea simply', 'Give me 3 practice questions', 'Summarize this'],
    syllabus: ['How is the course assessed?', 'What are the learning outcomes?', 'Summarize this'],
    lab: ['What do I need to prepare?', 'What are the safety rules?', 'Summarize this'],
    paper: ['What’s the method and main result?', 'What are the limitations?', 'Summarize this'],
    dataset: ['What’s in the dataset?', 'How can I use it?', 'Summarize this'],
    default: ['Summarize this', 'What do I need to do?'],
  };
  Object.assign(PROMPTS, { handbook: PROMPTS.guide, thesis: PROMPTS.paper, report: PROMPTS.paper, protocol: PROMPTS.procedure, exam: PROMPTS.lecture, assignment: PROMPTS.procedure });
  const promptsFor = doc => PROMPTS[res(doc).kind] || PROMPTS.default;

  const stem = w => { let s = w.length > 4 ? w.replace(/(ations?|ments?|ings?|als?|ies|ied|es|ed|s|y)$/, '') : w; if (s.length < 4) s = w.replace(/s$/, ''); return s; };
  const TIME_G = /\b(week \d+|weeks \d+|\d+ (working )?days?|within|no later than|before|by the end|deadline|until|closes?|opens?|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\/\d{1,2})\b|tuần \d+|trước (ngày|cuối)/gi;
  const STRONG_TIME = /no later than|deadline|within \d|by the end|before|until|closes|trước/i;
  const WHO_RE = /appl(y|ies) to|eligib|who can|enrolled|full-time|all (students|employees|staff|undergraduate)/i;
  const ACT_RE = /\b(must|should|need to|submit|send|request|pay|register|complete|bring|book|arrive)\b|mang theo|có mặt|nộp|đăng ký|báo cho|hoàn thành/i;
  const INTENT = { time: new Set(['deadlin', 'date', 'due', 'time', 'key', 'when']), who: new Set(['appl', 'eligibl']) };
  const timeScore = text => { const n = (String(text).match(TIME_G) || []).length; return n ? 0.5 + Math.min(n, 3) * 0.2 + (STRONG_TIME.test(text) ? 0.5 : 0) : 0; };

  /** Passages with page and heading; memoized per document version. */
  let memo = { key: '', m: null };
  function docModel(doc) {
    const key = [S.ws, doc.id, doc.updated, doc.status, doc.name].join('|');
    if (memo.key !== key) memo = { key, m: X.docModel(doc) };
    return memo.m;
  }
  const cite = (b, n) => ({ n, page: b.page, heading: b.heading, text: b.text, quote: b.quote, kind: b.kind });
  /** Table rows read as one passage: "Final exam 40%, Midterm exam 20%". */
  const rowValues = b => b.text.split(' · ').map(p => p.split(': ').slice(1).join(': ')).join(' ');
  function mergeRows(picks, blocks) {
    const out = [];
    picks.forEach(b => {
      if (b.kind !== 'row') { if (!out.includes(b)) out.push(b); return; }
      if (out.some(x => x.kind === 'row' && x.page === b.page && x.heading === b.heading)) return;
      const rows = blocks.filter(x => x.kind === 'row' && x.page === b.page && x.heading === b.heading);
      out.push({ ...b, text: rows.map(rowValues).join(', '), quote: rows[0].quote });
    });
    return out;
  }
  /** A cited answer: a short lead (from the first passage unless given) and the passages as numbered quotes. leadFrom marks the quote the
      lead was taken from, so it isn't shown twice. */
  const result = (mode, picks, lead) => {
    const cites = picks.map((b, i) => cite(b, i + 1)), first = cites.find(c => c.kind !== 'row') || cites[0];
    return { mode, lead: lead || (first.kind === 'row' ? `${first.heading}: ${first.text}.` : firstSentence(first.text)), leadCite: first.n, leadFrom: lead ? 0 : first.n, quotes: cites.map(c => c.n), cites };
  };

  /** Mock answer engine: intent → passages → a short lead plus cited bullets, or an honest miss. */
  function answer(doc, q) {
    const m = docModel(doc), blocks = m.blocks.filter(b => b.text.trim()), r = res(doc);
    if (!blocks.length) return { none: true };
    const sections = m.outline.map(o => ({ ...o, blocks: blocks.filter(b => b.heading === o.title) })).filter(s => s.blocks.length);
    const passage = q.match(/^Explain this passage:\s*“([\s\S]+)”$/);
    if (passage) {
      const sel = fold(passage[1].replace(/…$/, '')).slice(0, 60);
      const i = blocks.findIndex(b => fold(b.text).includes(sel) || sel.includes(fold(b.text).slice(0, 40)));
      if (i >= 0) {
        const b = blocks[i], next = blocks[i + 1] && blocks[i + 1].heading === b.heading ? blocks[i + 1] : null;
        return result('explain', [b, ...(next ? [next] : [])], `This is from “${b.heading}” on page ${b.page}. The key point: ${b.kind === 'row' ? rowValues(b) : firstSentence(b.text)}`);
      }
      q = passage[1];
    }
    if (/summar|overview|tl;?dr|main points|what is this( about)?\??$/i.test(q)) {
      const picks = sections.length ? sections.slice(0, 5).map(s => s.blocks[0]) : blocks.slice(0, 3);
      const cites = picks.map((b, i) => cite(b, i + 1));
      return { mode: 'summary', lead: r.summary, list: cites.map(c => ({ text: (sections.length ? `${c.heading}: ` : '') + (c.kind === 'row' ? rowValues(c) : firstSentence(c.text)), n: c.n })), cites };
    }
    if (/practice|quiz|test me|self-check|exam questions/i.test(q)) {
      const self = sections.find(s => /self-check|questions/i.test(s.title));
      const T = [h => `Explain “${h}” in your own words.`, h => `What is the most important rule or idea in “${h}”, and why?`, h => `Give an example that applies “${h}”.`];
      const items = self ? self.blocks.slice(0, 3).map(b => ({ text: b.text, b }))
        : sections.filter(s => !/^(contact|questions|where to get help|references?|purpose|overview)$/i.test(s.title)).slice(0, 3).map((s, i) => ({ text: T[i](s.title), b: s.blocks[0] }));
      if (!items.length) return { none: true };
      const cites = items.map((x, i) => cite(x.b, i + 1));
      return { mode: 'practice', lead: `Here are ${items.length} practice questions from this document:`, list: items.map((x, i) => ({ text: x.text, n: i + 1 })), ordered: true, cites };
    }
    if (/explain|key idea|simply|in simple/i.test(q)) {
      const s = [/key idea/i, /overview|purpose|abstract|description|introduction/i].map(re => sections.find(x => re.test(x.title))).find(Boolean) || sections[0];
      if (s) {
        const after = sections[sections.indexOf(s) + 1];
        const picks = mergeRows([...s.blocks.slice(0, 2), ...(after ? [after.blocks[0]] : [])], blocks);
        const res0 = result('explain', picks);
        return { ...res0, lead: `In short: ${res0.lead}` };
      }
    }
    if (/what do i (need|have) to do|next steps|what should i do|action/i.test(q)) {
      const ranked = blocks.map((b, i) => ({ b, i, s: (ACT_RE.test(b.text) ? 1 : 0) + (b.kind === 'li' ? 0.6 : 0) + (/\b(must|need to|should)\b/i.test(b.text) ? 0.4 : 0) }))
        .filter(x => x.s >= 1).sort((a, c) => c.s - a.s || a.i - c.i).slice(0, 3).sort((a, c) => a.i - c.i).map(x => x.b);
      if (ranked.length) {
        const cites = ranked.map((b, i) => cite(b, i + 1));
        return { mode: 'action', lead: 'Here’s what this document asks you to do:', list: cites.map(c => ({ text: firstSentence(c.text), n: c.n })), cites };
      }
    }
    // Retrieval: rare query words count more (idf), headings mark the section, intent boosts dates or audience.
    const time = /\b(when|deadlines?|due|dates?|how long|by when)\b/i.test(q), who = /\bwho\b|appl(y|ies) to|eligib/i.test(q);
    const toks = [...new Set(tokens(q).map(stem))].filter(t => !(time && INTENT.time.has(t)) && !(who && INTENT.who.has(t)));
    const need = Math.max(1, Math.ceil(toks.length * 0.5));
    const folded = blocks.map(b => [fold(b.text), fold(b.heading)]);
    const idf = Object.fromEntries(toks.map(t => [t, Math.log(1 + blocks.length / Math.max(1, folded.filter(([x, h]) => x.includes(t) || h.includes(t)).length))]));
    const scored = blocks.map((b, i) => {
      const [text, head] = folded[i]; let hits = 0, s = 0;
      toks.forEach(t => { const inT = text.includes(t), inH = head.includes(t); if (inT || inH) hits++; s += idf[t] * ((inT ? 1 : 0) + (inH ? 0.8 : 0)); });
      if (doc.summary && b.text === doc.summary) s *= 0.6;
      const boost = (time ? timeScore(b.text) : 0) + (who && (WHO_RE.test(b.text) || /scope|who|eligib/i.test(b.heading)) ? 1.2 : 0);
      return { b, i, hits, s: s + boost, boost };
    });
    let qual = toks.length ? scored.filter(x => x.hits >= need) : [];
    if (time || who) { const boosted = qual.filter(x => x.boost > 0); qual = boosted.length ? boosted : qual.length ? qual : scored.filter(x => x.boost > 0); }
    if (!qual.length) return { none: true };
    qual.sort((a, c) => c.s - a.s || a.i - c.i);
    const best = qual[0].s;
    return result('answer', mergeRows(qual.filter(x => x.s >= best * 0.6).slice(0, 3).map(x => x.b), blocks));
  }

  const citeBtn = c => `<button type="button" class="rdr-cite" data-act="rdr-cite" data-q="${esc(c.quote)}" data-page="${c.page}" data-tip="Page ${c.page}${c.heading ? ' · ' + esc(c.heading) : ''}" aria-label="Show passage ${c.n} on page ${c.page}">${c.n}</button>`;
  function answerHtml(t) {
    const a = t.a;
    if (a.none) return `<div class="rdr-a"><p class="rdr-a__lead">This document doesn’t cover that.</p><div class="rdr-a__actions">${btn('Search all knowledge', { size: 'sm', icon: 'search', act: 'rdr-ask-all', data: { q: t.q } })}</div></div>`;
    const byN = n => a.cites.find(c => c.n === n);
    const list = a.list?.length ? `<${a.ordered ? 'ol' : 'ul'} class="rdr-a__list">${a.list.map(x => `<li>${esc(x.text)} ${citeBtn(byN(x.n))}</li>`).join('')}</${a.ordered ? 'ol' : 'ul'}>` : '';
    // The lead already says what its passage says (with its marker): that passage isn't repeated as a quote card.
    const lead = fold(a.lead);
    const said = c => c.n === a.leadFrom || lead.includes(fold(firstSentence(c.text)).slice(0, 60));
    const shown = (a.quotes || []).map(byN).filter(c => c && !said(c));
    const quotes = shown.length ? `<div class="rdr-quotes">${shown.map(c => `<button type="button" class="rdr-quote" data-act="rdr-cite" data-q="${esc(c.quote)}" data-page="${c.page}"><span class="rdr-quote__n">${c.n}</span><span class="rdr-quote__body"><span class="rdr-quote__text">“${esc(clip(c.text, 280))}”</span><span class="rdr-quote__meta">Page ${c.page}${c.heading ? ' · ' + esc(c.heading) : ''}</span></span></button>`).join('')}</div>` : '';
    return `<div class="rdr-a"><p class="rdr-a__lead">${esc(a.lead)}${a.leadCite ? ' ' + citeBtn(byN(a.leadCite)) : ''}</p>${list}${quotes}</div>`;
  }
  function askPane(doc) {
    const a = askUi(doc.id);
    if (!a.thread.length) return `<div class="rdr-ask-empty"><div class="rdr-ask-empty__title">Try asking</div>
      <div class="rdr-prompts">${promptsFor(doc).map(p => `<button type="button" class="rdr-prompt" data-act="rdr-ask-prompt" data-q="${esc(p)}"><span>${esc(p)}</span>${ic('arrow-right', 'i-xs')}</button>`).join('')}</div></div>`;
    const done = !a.thread.some(t => t.pending);
    return `<div class="rdr-thread" aria-live="polite">${a.thread.map(t => `<div class="rdr-turn"><div class="rdr-q">${esc(t.q)}</div>${t.pending
      ? `<div class="rdr-typing" role="status"><span class="rdr-dots" aria-hidden="true"><i></i><i></i><i></i></span>Reading the document…</div>`
      : answerHtml(t)}</div>`).join('')}
      ${done ? `<div class="rdr-ask-foot">${btn('Continue in chat', { size: 'sm', icon: 'message', act: 'rdr-ask-chat' })}${btn('Clear', { size: 'sm', v: 'ghost', act: 'rdr-ask-clear' })}</div>` : ''}</div>`;
  }
  let stick = false;
  function ask(doc, q) {
    q = String(q || '').trim(); if (!q || !doc) return;
    const a = askUi(doc.id), u = rdrUi(); if (a.thread.some(t => t.pending)) return;
    const turn = { q, pending: true }; a.thread.push(turn); a.q = '';
    u.rail = true; u.tab = 'ask'; stick = true; refresh();
    setTimeout(() => { turn.a = answer(doc, q); turn.pending = false; stick = true; if (S.cur?.r.page === 'docViewer') refresh(); }, 600);
  }

  /* ═══════════════ Rail panes ═══════════════ */
  const railSec = (title, body, extra = '') => `<section class="rdr-sec"><div class="rdr-sec__head"><h3 class="rdr-sec__title">${esc(title)}</h3>${extra}</div>${body}</section>`;
  function aboutPane(doc, query) {
    const r = res(doc), kb = r.kb, edit = X.res.canEditRes(doc), owner = kbRole(kb) === 'owner' && !kb.personal;
    const acts = [
      r.source.url && btn('Copy source link', { v: 'ghost', size: 'sm', icon: 'link', act: 'rdr-copy-source', data: { id: doc.id } }),
      owner && btn('Manage access', { v: 'ghost', size: 'sm', icon: 'lock', href: kbManageHref(kb, 'access') }),
    ].filter(Boolean).join('');
    const viewing = +query.v || r.version;
    const versions = [...r.versions].sort((a, b) => b.v - a.v).map(v => {
      const cur = v.v === r.version, on = v.v === viewing;
      const trail = cur ? chip('Current', { size: 'sm', tone: on ? 'accent' : 'default' }) : on ? chip('Viewing', { size: 'sm', tone: 'accent' }) : linkBtn('View', { act: 'rdr-version', data: { v: v.v } });
      return `<li class="${cx('rdr-ver', on && 'is-on')}"><span class="rdr-ver__v num">v${v.v}</span><span class="rdr-ver__body"><span class="rdr-ver__note">${esc(v.note || 'Updated')}</span><span class="rdr-ver__meta">${esc(fmtDate(v.at))}${v.by ? ' · ' + esc(v.by) : ''}</span></span><span class="rdr-ver__trail">${trail}</span></li>`;
    }).join('');
    return railSec('Details', X.res.details(doc), edit ? btn('Edit', { v: 'ghost', size: 'sm', icon: 'pencil', act: 'res-edit', data: { id: doc.id }, aria: 'aria-label="Edit details"' }) : '') + (acts ? `<div class="rdr-acts">${acts}</div>` : '') + railSec('Version history', `<ol class="rdr-vers">${versions}</ol>`);
  }
  function relatedPane(doc) {
    const related = relatedResources(doc, 6);
    const cols = visibleCollections().filter(c => (c.items || []).some(i => i.doc === doc.id));
    const convs = citingConvs(doc);
    const none = t => `<p class="rdr-none">${esc(t)}</p>`;
    return railSec('Related resources', related.length ? X.res.rows(related, { compact: true }) : none('Nothing related yet.'))
      + railSec('Collections that include it', cols.length ? list(cols.map(c => { const s = shareLabel(c); return item({ lead: itemIcon('list', '', 'sm'), title: esc(c.name), desc: `<span class="row gap-4">${ic(s.icon, 'i-xs')}${esc(s.label)}</span>`, href: '/knowledge/collections/' + c.id }); }), 'list--plain rdr-list') : none('Not in any collection you can see.'), btn('', { v: 'ghost', size: 'sm', icon: 'list-plus', tip: 'Add to collection', act: 'res-collect', data: { id: doc.id } }))
      + railSec('Cited in your conversations', convs.length ? list(convs.slice(0, 6).map(c => item({ lead: itemIcon('message', '', 'sm'), title: esc(c.title || 'Conversation'), desc: esc(rel(c.at)), href: '/chat/' + c.id })), 'list--plain rdr-list') : none('Not cited in your conversations yet.'));
  }

  /* ═══════════════ States ═══════════════ */
  function notReady(doc, kb, edit) {
    const box = (icon, title, desc, actions = '', tone = '') => `<div class="doc-state">${emptyState({ icon, title, desc, actions, tone })}</div>`;
    const fix = edit ? X.docFix(doc, { v: 'primary' }) : '';
    switch (doc.status) {
      case 'processing': return box('loader', 'Getting this document ready', 'It will be readable and searchable in a few minutes.');
      case 'pending': return box('clock', 'Waiting to be processed', 'This document isn’t readable yet.', fix);
      case 'unsupported': return box('file', 'This file can’t be previewed', 'Images and some file types can’t be read or searched. Download it to view.', btn('Download', { icon: 'download', act: 'doc-dl', data: { id: doc.id } }));
      default: return box('alert-circle', 'This document couldn’t be read', esc(doc.error || 'The file couldn’t be opened.') + (edit ? '' : ` Ask an owner of ${esc(kb.name)} to fix it.`), fix, 'danger');
    }
  }
  const unavailable = (title, desc, actions) => `<div class="rdr-msg">${emptyState({ icon: 'lock', title, desc, actions, boxed: true })}</div>`;
  function noAccess(doc, kb) {
    const role = kbRole(kb);
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'Not available' }]);
    if (role === null) return unavailable('This document isn’t available', 'It may have been removed, or it isn’t shared with you.', btn('Go to Browse', { v: 'primary', href: '/knowledge' }));
    const pending = D.requests.find(r => r.kb === kb.id && r.user === me().id && r.status === 'pending');
    return unavailable('You don’t have access to this document', `It’s in ${esc(kb.name)}, which is restricted.`, pending ? chip('Access requested', { tone: 'warning', icon: 'clock' }) : btn('Request access', { v: 'primary', icon: 'lock', act: 'kb-request', data: { kb: kb.id } }));
  }
  /* ═══════════════ Native viewer ═══════════════
     The document opens the way its own app shows it (format from X.docFormat): PDF and Word pages with their print chrome,
     a slide deck, a spreadsheet with a formula bar and sheet tabs, or a continuous Markdown / web page / plain text / email.
     Paged formats get a slim viewer bar: where you are and zoom — nothing the header already says. */
  const PAGED = ['pdf', 'docx', 'slide'];
  const ZOOMS = [0.75, 0.9, 1, 1.15, 1.3, 1.5];
  const countNoun = m => (m.format === 'slide' ? 'slide' : PAGED.includes(m.format) ? 'page' : '');
  function viewerHtml(m, u, { bar: withBar = true } = {}) {
    const f = m.format;
    if (f === 'sheet') {
      const hdr = /<tr class="doc-sheet__hdr"><td[^>]*>1<\/td><td>([\s\S]*?)<\/td>/.exec(m.pages[0]?.html || '')?.[1] || '';
      return `<div class="doc-viewer doc-viewer--sheet"><div class="doc-fx" role="group" aria-label="Formula bar"><span class="doc-fx__ref" id="doc-cell-ref">A1</span><span class="doc-fx__fn" aria-hidden="true">fx</span><span class="doc-fx__val" id="doc-cell-val" translate="no">${hdr}</span></div>${m.pages.map(p => `<div class="${cx('doc-page', p.cls)}" data-page="${p.no}" translate="no">${p.html}</div>`).join('')}</div>`;
    }
    if (!PAGED.includes(f)) return `<article class="doc-viewer doc-viewer--flow doc-viewer--${f}" translate="no">${m.pages.map(p => `<section class="${cx('doc-page', p.cls)}" data-page="${p.no}">${p.html}</section>`).join('')}</article>`;
    const zoom = ZOOMS.includes(u.zoom) ? u.zoom : 1, zi = ZOOMS.indexOf(zoom), noun = countNoun(m);
    let pages = '', prev = 0;
    m.pages.forEach((p, i) => {
      const n = f === 'slide' ? i + 1 : p.no;
      if (f !== 'slide' && p.no > prev + 1) pages += `<div class="doc-gap">${p.no - 1 === prev + 1 ? `Page ${prev + 1}` : `Pages ${prev + 1}–${p.no - 1}`}</div>`;
      pages += `<div class="${cx('doc-page', p.cls)}" data-page="${p.no}" data-n="${n}">${p.html}</div>`;
      prev = p.no;
    });
    if (f !== 'slide' && m.count > prev) pages += `<div class="doc-gap">${prev + 1 === m.count ? `Page ${m.count}` : `Pages ${prev + 1}–${m.count}`}</div>`;
    const label = noun === 'slide' ? 'Slide' : 'Page';
    const bar = `<div class="doc-viewer__bar"><span class="doc-viewer__where num" id="doc-page-n" data-label="${label}" data-count="${m.count}" data-n="1" aria-live="polite">${label} 1 of ${m.count}</span>
      <div class="doc-viewer__zoom" role="group" aria-label="Zoom">${iconBtn('minus', 'Zoom out', { size: 'sm', act: 'rdr-zoom', data: { dir: -1 }, disabled: zi <= 0 })}<button type="button" class="doc-viewer__pct num" data-act="rdr-zoom" data-dir="0" data-tip="Reset zoom">${Math.round(zoom * 100)}%</button>${iconBtn('plus', 'Zoom in', { size: 'sm', act: 'rdr-zoom', data: { dir: 1 }, disabled: zi >= ZOOMS.length - 1 })}</div></div>`;
    return `<div class="doc-viewer doc-viewer--${f}">${withBar ? bar : ''}<div class="doc-viewer__pages" style="--doc-zoom:${zoom}" translate="no">${pages}</div></div>`;
  }
  const skelPage = () => `<div class="doc-page" aria-busy="true" aria-label="Loading"><div class="stack gap-12"><span class="skeleton skeleton--title" style="width:55%"></span>${[92, 86, 95, 70, 0, 40, 90, 84, 60].map(w => w ? `<span class="skeleton skeleton--line" style="width:${w}%"></span>` : '<span style="height:12px"></span>').join('')}</div></div>`;
  const railSkel = () => `<div class="stack gap-12">${[80, 64, 92, 50].map(w => `<span class="skeleton skeleton--line" style="width:${w}%"></span>`).join('')}</div>`;
  function notAvailable() {
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'Not available' }]);
    return `<div class="rdr-msg">${emptyState({ icon: 'file', title: 'This document isn’t available', desc: 'It may have been archived or removed.', actions: btn('Go to Browse', { v: 'primary', href: '/knowledge' }), boxed: true })}</div>`;
  }

  /* ═══════════════ Submissions: seen only by the contributor and the base's reviewers ═══════════════ */
  /** Not published (in review, changes requested, not approved, unpublished, merged): a preview with its
      lifecycle and who can see it. No Ask, no saving or collecting — it isn't knowledge yet. */
  function submissionView(doc, kb, query) {
    const u = forDoc(rdrUi(), doc.id), l = lifecycleOf(doc), st = stageOf(doc), sub = doc.submission || {}, mine = isMine(doc);
    const reviewer = canReviewKb(kb) && can('knowledge.manage');
    const track = X.ctb?.href(doc.id) || '/knowledge/library?tab=contributions';
    crumbs(mine || !reviewer
      ? [{ label: 'Knowledge', to: '/knowledge' }, { label: 'My library', to: '/knowledge/library?tab=contributions' }, { label: docTitle(doc) }]
      : [{ label: 'Documents', to: '/documents?tab=review' }, { label: docTitle(doc) }]);
    const preview = !['zip', 'png', 'jpg', 'jpeg'].includes(doc.type);
    const m = preview ? docModel(doc) : null;
    const open = railOpen(u), k = kindMeta(res(doc).kind);
    const back = backBtn(null);
    const meta = [esc(k.label), esc(kb.name), esc(mine ? 'Contributed by you' : `Contributed by ${contributorName(doc)}`), sub.at && `<span>Submitted ${esc(rel(sub.at).replace(/^(Just now|Yesterday)$/, s => s.toLowerCase()))}</span>`].filter(Boolean).join(dot);
    // One primary: Review (reviewers) or Revise (the contributor, when changes were asked for — it opens the same place as Track).
    const main = reviewer && st === 'review' ? btn('Review', { v: 'primary', icon: 'check-check', href: `/documents?tab=review&sel=${doc.id}` })
      : mine && st === 'changes' ? btn('Revise', { v: 'primary', icon: 'pencil', href: track })
        : '';
    const trackBtn = mine && !(st === 'changes') ? btn('Track', { v: main ? 'secondary' : 'primary', icon: 'history', href: track }) : '';
    const actions = main + trackBtn + iconBtn('more', 'More actions', { menu: 'rdr-sub-more', data: { id: doc.id } });
    const head = `<header class="rdr-head">
      <div class="rdr-head__row">${back}${fileIcon(doc.type, 'lg')}<div class="rdr-head__main"><div class="rdr-head__title-row"><h1 class="rdr-head__title">${esc(docTitle(doc))}</h1>${lifeChip(doc)}${X.res.demoChip()}</div><div class="rdr-head__meta">${meta}</div></div>
        <div class="rdr-head__actions">${actions}</div></div></header>`;

    /* Banner: why only some people can see it, and what happens next */
    const lastOf = kind => [...(sub.events || [])].reverse().find(e => e.kind === kind);
    const byName = e => (e?.by === me().id ? 'You' : e?.by ? actorName(e.by) : 'A reviewer');
    const quote = e => (e?.text ? `<blockquote class="rdr-sub-quote">${esc(e.text)}</blockquote>` : '');
    const audience = `Only ${mine ? 'you' : esc(contributorName(doc))} and the reviewers of ${esc(kb.name)} can see it.`;
    let banner;
    if (st === 'review') banner = alertBox('accent', l.key === 'analyzing' ? 'In review · the assistant is reading it' : 'In review', `${audience} It isn’t searchable yet.`, '', { icon: 'eye-off' });
    else if (st === 'changes') { const e = lastOf('changes'); banner = alertBox('warning', `${byName(e)} asked for changes`, quote(e) + `${audience} It isn’t searchable yet.`); }
    else if (st === 'rejected') { const e = lastOf('rejected'); banner = alertBox('danger', LIFECYCLE.rejected.label, quote(e) + `It won’t be published. ${audience}`); }
    else if (st === 'unpublished') { const e = lastOf('unpublished'); banner = alertBox('default', 'Unpublished', quote(e) + `${byName(e)} removed it from search and answers. ${audience}`, '', { icon: 'eye-off' }); }
    else if (st === 'merged') { const o = docById(doc.mergedInto); banner = alertBox('success', 'Published as a new version', o ? `It replaced the earlier version of “${esc(docTitle(o))}”. This is the file as it was submitted.` : 'It replaced the earlier version.', o && canOpenRes(o) ? btn('Open current version', { size: 'sm', href: '/doc/' + o.id }) : ''); }
    else banner = alertBox('default', l.label, `${esc(l.desc)} ${audience}`);

    const canvas = gate({
      ok: () => (m ? viewerHtml(m, u) : `<div class="doc-state">${emptyState({ icon: 'file', title: 'This file can’t be previewed', desc: 'Download it to view.', actions: btn('Download', { icon: 'download', act: 'doc-dl', data: { id: doc.id } }) })}</div>`),
      loading: skelPage,
      empty: () => `<div class="doc-state">${emptyState({ icon: 'file', title: 'Nothing to show', desc: 'This document has no readable content yet.' })}</div>`,
      error: () => errorState({ title: 'This document didn’t load' }),
    });
    const orig = sub.versionOf ? docById(sub.versionOf) : null;
    const about = () => `<section class="rdr-sec">${kv([
      ['Status', lifeChip(doc, 'sm')],
      ['Knowledge base', esc(kb.name)],
      ['Contributed by', esc(mine ? 'You' : contributorName(doc))],
      sub.at && ['Submitted', esc(fmtDateTime(sub.at))],
      orig && ['New version of', canOpenRes(orig) ? `<a class="link" href="#/doc/${orig.id}">${esc(orig.name)}</a>` : esc(orig.name)],
      ['File', `${esc((doc.type || 'file').toUpperCase())} · ${fmtSize(doc.size || 0)}`],
    ])}</section>` + railSec('History', X.ctb ? X.ctb.timeline(doc, { compact: true }) : '');
    const railBody = gate({ ok: about, empty: about, loading: railSkel, error: () => errorState({ boxed: false }) });
    const rail = open ? `<aside class="rdr-rail" aria-labelledby="rdr-rail-title"><div class="rdr-rail__head"><h2 class="rdr-rail__title" id="rdr-rail-title">About this contribution</h2>${iconBtn('x', 'Close panel', { size: 'sm', act: 'rdr-rail' })}</div>
      <div class="rdr-rail__body" id="rdr-rail-body" data-keep-scroll>${railBody}</div></aside><div class="rdr-scrim" data-act="rdr-rail" aria-hidden="true"></div>` : '';
    return `<div class="rdr rdr--sub">${head}<div class="${cx('rdr-body', open && 'has-rail')}"><div class="rdr-canvas" id="rdr-scroll" data-keep-scroll><div class="rdr-banners">${banner}</div>${canvas}</div>${rail}</div></div>`;
  }

  /* ═══════════════ Page ═══════════════ */
  let lastNeedles = [], shownOutline = false;
  P.docViewer = ({ params, query }) => {
    lastNeedles = [];
    const doc = docById(params.id), kb = doc && kbById(doc.kb);
    if (!doc || doc.archived || !kb || kb.archived) return notAvailable();
    if (!canOpenRes(doc)) {
      if (canSeeDoc(doc)) return submissionView(doc, kb, query);
      // Submissions and unpublished documents don't exist for anyone else: no title, no base.
      if (!isPublishedStage(doc)) return notAvailable();
    }
    if (!canReadKb(kb)) return noAccess(doc, kb);
    const u = forDoc(rdrUi(), doc.id), r = res(doc), edit = canEditKb(kb), readable = isSearchable(doc);
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: kb.name, to: kbHref(kb) }, { label: docTitle(doc) }]);
    const m = readable ? X.docModel(doc) : null;
    const ns = m ? needles(doc, query, m) : [];
    ns.forEach(n => n.cite && n.text.length >= 40 && injectQuote(m, n.text, n.page));
    lastNeedles = ns.map(n => n.text);
    const total = m ? ns.reduce((a, n) => a + countIn(m.text, n.text), 0) : 0;
    const hitKey = S.cur.full; if (u.hitKey !== hitKey) { u.hitKey = hitKey; u.hit = 0; }
    const conv = query.from ? convById(query.from) : null;
    const isSheet = m?.format === 'sheet';
    const hasOutline = readable && !isSheet && m.outline.length > 1;
    // An older version (?v=): the header, trust and Ask follow it — Ask and Save work on the current version only.
    const vq = +query.v, ver = vq && vq !== r.version ? r.versions.find(x => x.v === vq) : null;
    const askable = readable && !ver;
    // ?ask=1 (Ask about this document from anywhere): open the Ask panel once; AFTER drops the flag from the address.
    if (query.ask && askable) { u.rail = true; u.tab = 'ask'; }
    if (!askable && u.tab === 'ask') u.tab = 'about';
    const open = railOpen(u);
    const k = kindMeta(r.kind);

    /* Header: one row — (Back) · title · trust · Ask, Save, ⋯. The meta says what it is, who owns it and when it changed; the base is in
       the breadcrumb, the version in About and the page count in the viewer bar. On phones it collapses to title + icons and hides on scroll. */
    const back = backBtn(conv);
    const when = ver
      ? `<span>Version ${ver.v} · ${esc(fmtDate(ver.at))}</span>`
      : `<span data-tip="${esc(fmtDateTime(doc.updated))}">Updated ${esc(rel(doc.updated).replace(/^(Just now|Yesterday)$/, s => s.toLowerCase()))}</span>`;
    const meta = [esc(k.label), r.owner && `by ${esc(r.owner)}`, when].filter(Boolean).join(dot);
    const asking = open && u.tab === 'ask';
    const actions = [
      askable ? btn('Ask', { v: 'primary', icon: 'sparkles', act: 'rdr-ask-open', cls: 'rdr-ask-btn', aria: `aria-pressed="${asking}" aria-label="Ask about this document"` }) : '',
      ver ? '' : X.res.saveBtn(doc, { label: true, size: 'md' }),
      X.res.moreBtn(doc, 'md'),
    ].join('');
    const trust = ver ? chip('Older version', { size: 'sm', icon: 'history', tip: `Current: v${r.version}, ${fmtDate(doc.updated)}` }) : X.res.trustChip(doc);
    const firstCite = ns[0]?.cite;
    const qText = (query.q || '').trim();
    const hits = ns.length && readable ? `<div class="rdr-hits" role="status">${ic(firstCite ? 'quote' : 'search', 'i-sm')}<span class="grow truncate">${total
      ? (firstCite ? `Cited passage${total > 1 ? ` <span class="num" id="rdr-hit-n">${u.hit + 1}</span> of <span class="num" id="rdr-hit-total">${total}</span>` : ''}` : `<span class="num" id="rdr-hit-n">${u.hit + 1}</span> of <span class="num" id="rdr-hit-total">${total}</span> for “${esc(qText)}”`)
      : `No matches for “${esc(qText || ns[0].text)}”`}</span>${total > 1 ? iconBtn('chevron-up', 'Previous', { size: 'sm', act: 'rdr-hit', data: { dir: -1 } }) + iconBtn('chevron-down', 'Next', { size: 'sm', act: 'rdr-hit', data: { dir: 1 } }) : ''}${iconBtn('x', 'Clear highlights', { size: 'sm', act: 'rdr-clear' })}</div>` : '';
    const head = `<header class="rdr-head" id="rdr-head">
      <div class="rdr-head__row">${back}${fileIcon(doc.type, 'lg')}<div class="rdr-head__main"><div class="rdr-head__title-row"><h1 class="rdr-head__title">${esc(docTitle(doc))}</h1>${trust}${X.res.statusChip(doc)}${X.res.demoChip()}</div><div class="rdr-head__meta">${meta}</div></div>
        <div class="rdr-head__actions">${actions}</div></div>${hits}</header>`;

    /* Banners: only when they change what the reader should do */
    const t = trustOf(doc), canEdit = X.res.canEditRes(doc);
    const trustBanner = t.state === 'review' ? alertBox('warning', doc.status === 'outdated' ? 'Changed at the source' : 'Review due', esc(t.note || t.desc) + (canEdit ? '' : ` Check with ${esc(r.owner || 'the owner')} before relying on it.`),
      canEdit ? btn('Mark as verified', { size: 'sm', icon: 'shield-check', act: 'res-verify', data: { id: doc.id } }) + (doc.status === 'outdated' ? X.docFix(doc, { size: 'sm' }) : '') : '') : '';
    const verBanner = ver ? alertBox('accent', `You’re viewing version ${ver.v} from ${fmtDate(ver.at)}`, esc([ver.note, 'Ask and Save work on the current version.'].filter(Boolean).join(' · ')), btn('View current', { size: 'sm', act: 'rdr-version', data: { v: '' } }), { icon: 'history' }) : '';
    const banners = trustBanner || verBanner ? `<div class="rdr-banners">${verBanner}${trustBanner}</div>` : '';

    /* Canvas */
    const canvas = gate({
      ok: () => (readable ? viewerHtml(m, u) : notReady(doc, kb, edit)),
      loading: skelPage,
      empty: () => `<div class="doc-state">${emptyState({ icon: 'file', title: 'Nothing to show', desc: 'This document has no readable content yet.' })}</div>`,
      error: () => errorState({ title: 'This document didn’t load' }),
    });

    /* Outline: open by default for longer documents; it gives way to the side panel (one extra panel at a time). */
    const outlineOpen = shownOutline = hasOutline && !open && (u.outline ?? m.outline.length >= 4);
    const outline = !hasOutline ? '' : outlineOpen
      ? `<nav class="rdr-outline" aria-label="Outline"><div class="rdr-outline__head"><span class="t-label">${m.format === 'slide' ? 'Slides' : 'On this page'}</span>${iconBtn('chevron-left', 'Hide outline', { size: 'sm', act: 'rdr-outline' })}</div>${m.outline.map((o, i) => `<button type="button" class="${cx('rdr-outline__link', !i && 'is-on')}" data-act="rdr-jump" data-h="${o.id}">${esc(o.title)}</button>`).join('')}</nav>`
      : `<nav class="rdr-outline rdr-outline--closed" aria-label="Outline">${iconBtn('list', 'Show outline', { size: 'sm', act: 'rdr-outline' })}</nav>`;

    /* Side panel: closed by default; once open, Tabs switch between Ask · About · Related (Ask from the header, About from ⋯). */
    const paneTabs = [askable && { id: 'ask', label: 'Ask' }, { id: 'about', label: 'About' }, { id: 'related', label: 'Related' }].filter(Boolean);
    const paneBody = () => (u.tab === 'ask' ? askPane(doc) : u.tab === 'related' ? relatedPane(doc) : aboutPane(doc, query));
    const railBody = gate({ ok: paneBody, empty: paneBody, loading: railSkel, error: () => errorState({ boxed: false }) });
    const composer = u.tab === 'ask' && askable ? `<div class="rdr-composer">${input({ id: 'rdr-ask-q', bind: `rdrAsk-${doc.id}.q`, value: askUi(doc.id).q, placeholder: 'Ask about this document', onEnter: 'rdr-ask-send', attrs: 'aria-label="Ask about this document"' })}${btn('', { v: 'primary', icon: 'send', tip: 'Ask', act: 'rdr-ask-send', loading: askUi(doc.id).thread.some(x => x.pending) })}</div>` : '';
    const rail = open ? `<aside class="rdr-rail" aria-label="Document panel"><div class="rdr-rail__head">${tabs(paneTabs, u.tab, '', { act: 'rdr-tab' })}${iconBtn('x', 'Close panel', { size: 'sm', act: 'rdr-rail' })}</div>
      <div class="rdr-rail__body" id="rdr-rail-body" data-keep-scroll>${railBody}</div>${composer}</aside><div class="rdr-scrim" data-act="rdr-rail" aria-hidden="true"></div>` : '';

    return `<div class="${cx('rdr', headHidden && 'is-collapsed')}">${head}<div class="${cx('rdr-body', open && 'has-rail')}">${outline}<div class="rdr-canvas" id="rdr-scroll" data-keep-scroll>${banners}${canvas}</div>${rail}</div></div>`;
  };

  let lastScrolled = '';
  AFTER.docViewer = ({ params, changed }) => {
    const doc = docById(params.id);
    if (changed && doc && canOpenRes(doc)) trackRecent(doc.id);
    if (stick) { stick = false; const rb = $('#rdr-rail-body'); if (rb) rb.scrollTop = rb.scrollHeight; }
    const sc = $('#rdr-scroll'); if (!sc) return;
    if (changed) lastScrolled = '';
    const u = rdrUi();
    if (lastNeedles.length) {
      const marks = markHits(sc, lastNeedles);
      if (marks.length) {
        u.hit = ((u.hit % marks.length) + marks.length) % marks.length;
        marks[u.hit].classList.add('is-focus');
        const n = $('#rdr-hit-n'); if (n) n.textContent = u.hit + 1;
        const tot = $('#rdr-hit-total'); if (tot) tot.textContent = marks.length;
        const key = S.cur.full + '|' + u.hit;
        if (lastScrolled !== key) {
          lastScrolled = key;
          requestAnimationFrame(() => { const mk = $('#rdr-scroll mark.is-focus'); if (!mk) return; sc.scrollTo({ top: sc.scrollTop + mk.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 3, behavior: changed ? 'auto' : 'smooth' }); });
        }
      }
    }
    const links = $$('.rdr-outline__link[data-h]');
    const track = () => { const top = sc.getBoundingClientRect().top + sc.clientHeight / 3; let on = 0; links.forEach((a, i) => { const h = document.getElementById(a.dataset.h); if (h && h.getBoundingClientRect().top <= top) on = i; }); links.forEach((a, i) => a.classList.toggle('is-on', i === on)); };
    // Viewer bar: the page (or slide) in view, like the file's own app.
    const pages = $$('.doc-viewer__pages .doc-page[data-n]', sc), where = $('#doc-page-n');
    const trackPage = () => { const top = sc.getBoundingClientRect().top + sc.clientHeight / 3; let n = pages[0]?.dataset.n || 1; pages.forEach(p => { if (p.getBoundingClientRect().top <= top) n = p.dataset.n; }); if (where && where.dataset.n !== String(n)) { where.dataset.n = n; where.textContent = `${where.dataset.label} ${n} of ${where.dataset.count}`; } };
    // Header collapse (applies on phones only, in CSS): hide after reading down past the first lines, show again when scrolling up.
    const rd = $('.rdr'), hd = $('#rdr-head');
    if (changed) { headHidden = false; rd?.classList.remove('is-collapsed'); }
    if (rd && hd) rd.style.setProperty('--rdr-head-h', hd.offsetHeight + 'px');
    let lastTop = sc.scrollTop;
    const collapse = () => {
      const t = sc.scrollTop, dy = t - lastTop; lastTop = t;
      const want = t <= 48 ? false : dy > 4 ? true : dy < -4 ? false : headHidden;
      if (want !== headHidden) { headHidden = want; rd?.classList.toggle('is-collapsed', want); }
    };
    sc.onscroll = () => { collapse(); if (links.length) track(); if (pages.length) trackPage(); };
    if (links.length) track(); if (pages.length) trackPage();
    // ?ask=1 opened the Ask panel (P.docViewer); keep the address clean and put the cursor in the question box.
    if (S.cur.query.ask) {
      const q = { ...S.cur.query }; delete q.ask; const qs = new URLSearchParams(q).toString();
      history.replaceState(null, '', '#' + S.cur.path + (qs ? '?' + qs : ''));
      S.cur.query = q;
      requestAnimationFrame(() => $('#rdr-ask-q')?.focus());
    }
  };
  A['rdr-zoom'] = el => {
    const d = curDoc(); if (!d) return;
    const u = forDoc(rdrUi(), d.id), i = ZOOMS.indexOf(ZOOMS.includes(u.zoom) ? u.zoom : 1), dir = +el.dataset.dir;
    u.zoom = dir ? ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + dir))] : 1; refresh();
  };
  /* Spreadsheets: selecting a cell shows its reference and value in the formula bar, as in the file's own app. */
  document.addEventListener('click', e => {
    const td = e.target.closest?.('.doc-viewer--sheet .doc-sheet td'); if (!td || td.classList.contains('doc-sheet__rn')) return;
    const tr = td.parentElement, col = [...tr.children].indexOf(td) - 1, row = tr.querySelector('.doc-sheet__rn')?.textContent || '';
    $$('.doc-viewer--sheet td.is-sel').forEach(x => x.classList.remove('is-sel')); td.classList.add('is-sel');
    const ref = $('#doc-cell-ref'), val = $('#doc-cell-val');
    if (ref) ref.textContent = 'ABCDEFGHIJ'[col] + row; if (val) val.textContent = td.textContent;
  });

  /* ═══════════════ Actions ═══════════════ */
  const curDoc = () => docById(S.cur?.params?.id);
  const jump = id => { const sc = $('#rdr-scroll'), h = document.getElementById(id); if (!sc || !h) return; sc.scrollTo({ top: sc.scrollTop + h.getBoundingClientRect().top - sc.getBoundingClientRect().top - 24, behavior: 'smooth' }); };
  A['rdr-back'] = () => go(origin || '/knowledge');
  A['rdr-hit'] = el => { rdrUi().hit += +el.dataset.dir; refresh(); };
  A['rdr-clear'] = () => setQuery({ q: '', page: '' });
  A['rdr-outline'] = () => { const u = rdrUi(); u.outline = !shownOutline; if (u.outline) u.rail = false; refresh(); };
  A['rdr-jump'] = el => jump(el.dataset.h);
  A['rdr-rail'] = () => { const u = rdrUi(); u.rail = !railOpen(u); refresh(); };
  /** Open the side panel on one view: Ask from the header, About and Related from ⋯. */
  function openPane(tab) {
    const u = rdrUi(); u.rail = true; u.tab = tab; refresh();
    const rb = $('#rdr-rail-body'); if (rb) rb.scrollTop = tab === 'ask' ? rb.scrollHeight : 0;
  }
  A['rdr-version'] = el => setQuery({ v: el.dataset.v || '' });
  A['rdr-copy-source'] = el => { const d = docById(el.dataset.id); if (d) copyText(res(d).source.url, 'Source link copied'); };
  /** The header's Ask: opens the Ask panel (focused), or closes it when it's already showing. */
  A['rdr-ask-open'] = () => {
    const u = rdrUi(); if (railOpen(u) && u.tab === 'ask') { u.rail = false; refresh(); return; }
    openPane('ask'); requestAnimationFrame(() => $('#rdr-ask-q')?.focus());
  };
  A['rdr-ask-prompt'] = el => ask(curDoc(), el.dataset.q);
  A['rdr-ask-send'] = () => { const d = curDoc(); if (!d) return; const v = $('#rdr-ask-q')?.value ?? askUi(d.id).q; ask(d, v); requestAnimationFrame(() => $('#rdr-ask-q')?.focus()); };
  A['rdr-ask-clear'] = () => { const d = curDoc(); if (d) { S.ui['rdrAsk-' + d.id] = { q: '', thread: [] }; refresh(); } };
  A['rdr-ask-all'] = el => A['chat-ask']?.({ dataset: { q: el.dataset.q || '' } });
  A['rdr-ask-chat'] = () => { const d = curDoc(); if (!d) return; const last = askUi(d.id).thread.at(-1); A['chat-ask']?.({ dataset: { q: last?.q || '', doc: d.id, kb: d.kb } }); };
  /** A citation in the rail: highlight and scroll to that passage (closes the overlay rail on narrow screens). */
  A['rdr-cite'] = el => { if (frameW() < RAIL_MIN) rdrUi().rail = false; setQuery({ q: el.dataset.q, page: el.dataset.page || '' }); };
  A['rdr-tab'] = el => openPane(el.dataset.value);
  /** Reader entries in the document's ⋯ menu (resources.js): About opens the side panel (its tabs lead to Ask and Related); on narrow
      screens, where the outline column is hidden, Contents opens the document's sections as their own menu. */
  X.rdr = {
    panels: (d, el) => {
      const m = frameW() <= OUTLINE_MIN && isSearchable(d) ? X.docModel(d) : null;
      const contents = m && m.format !== 'sheet' && m.outline.length > 1
        ? { label: 'Contents…', icon: 'list', run: () => openMenu(el, [{ section: m.format === 'slide' ? 'Slides' : 'On this page' }, ...m.outline.map(o => ({ label: o.title, run: () => jump(o.id) }))], 'rdr-contents:' + d.id) }
        : null;
      return [{ label: 'About this document', icon: 'info', run: () => openPane('about') }, contents].filter(Boolean);
    },
    /** The document preview overlay (preview.js) renders the same native pages and highlights the same way. */
    viewer: (m, opts) => viewerHtml(m, {}, opts),
    needles: (doc, query, m) => needles(doc, query, m),
    injectQuote: (m, quote, page) => injectQuote(m, quote, page),
    markHits: (root, list) => markHits(root, list),
  };
  /** Submission preview ⋯: its details and history, and the file. */
  MENUS['rdr-sub-more'] = el => {
    const d = docById(el.dataset.id); if (!d) return [];
    const open = railOpen(rdrUi());
    return [
      { label: open ? 'Hide details and history' : 'Details and history', icon: 'info', run: () => A['rdr-rail']() },
      { label: 'Download', icon: 'download', run: () => X.downloadDocument?.(d) },
    ];
  };

  /* ── Selection toolbar: ask about a passage (in the rail) or copy it ── */
  const hideSel = () => $('#doc-sel')?.remove();
  document.addEventListener('mouseup', e => {
    if (e.target.closest?.('#doc-sel')) return;
    setTimeout(() => {
      hideSel(); if (S.cur?.r.page !== 'docViewer') return;
      const sel = getSelection(), txt = sel && String(sel).trim();
      if (!txt || txt.length < 12 || txt.length > 800) return;
      const node = sel.anchorNode?.parentElement; if (!node?.closest('.doc-page')) return;
      const r = sel.getRangeAt(0).getBoundingClientRect(), fr = $('#frame').getBoundingClientRect();
      const el = document.createElement('div'); el.id = 'doc-sel'; el.className = 'doc-sel'; el.setAttribute('role', 'toolbar'); el.setAttribute('aria-label', 'Selection actions');
      // Same verb as the header: Ask answers in the side panel, here. Not on an older version (Ask works on the current one).
      const d = curDoc(), older = d && +S.cur.query.v && +S.cur.query.v !== res(d).version;
      el.innerHTML = (d && isSearchable(d) && !older ? btn('Ask', { v: 'ghost', size: 'sm', icon: 'sparkles', act: 'rdr-sel-ask', aria: 'aria-label="Ask about this passage"' }) : '') + btn('Copy', { v: 'ghost', size: 'sm', icon: 'copy', act: 'rdr-sel-copy' });
      el.dataset.text = txt; $('#frame').appendChild(el);
      const w = el.offsetWidth;
      el.style.left = Math.max(8, Math.min(fr.width - w - 8, r.left - fr.left + r.width / 2 - w / 2)) + 'px';
      el.style.top = Math.max(8, r.top - fr.top - 44) + 'px';
    }, 0);
  });
  document.addEventListener('scroll', e => { if (!e.target.closest?.('#doc-sel')) hideSel(); }, true);
  window.addEventListener('hashchange', hideSel);
  A['rdr-sel-ask'] = () => {
    const t = $('#doc-sel')?.dataset.text || ''; hideSel();
    ask(curDoc(), `Explain this passage: “${clip(t.replace(/\s+/g, ' '))}”`);
  };
  A['rdr-sel-copy'] = async () => { const t = $('#doc-sel')?.dataset.text || ''; if (await copyText(t)) hideSel(); };
  const prevEsc = A['esc-page'];
  A['esc-page'] = () => {
    if ($('#doc-sel')) { hideSel(); return true; }
    if (S.cur?.r.page === 'docViewer' && frameW() < RAIL_MIN && railOpen(rdrUi())) { rdrUi().rail = false; refresh(); return true; }
    return prevEsc ? prevEsc() : false;
  };
})();

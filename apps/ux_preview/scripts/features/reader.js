/* Reader — the universal resource reader (/doc/:id?q&page&from&v).
   Header (trust, provenance, actions), outline, the page canvas with cited-
   passage and search highlights, and a right rail: Ask (answers in place from
   the document's own passages and cites them), About (details, versions,
   provenance) and Related (resources, collections, conversations).
   Rendition model: X.docModel (documents.js). Shared pieces: X.res (resources.js).
   Prefix: rdr-. */
(() => {
  'use strict';

  const RAIL_MIN = 1024;
  const frameW = () => $('#frame')?.clientWidth || innerWidth;
  const rdrUi = () => ui('rdr', { outline: true, rail: null, tab: 'ask', hit: 0, hitKey: '' });
  const railOpen = u => u.rail ?? frameW() >= RAIL_MIN;
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
      if (n.parentElement?.closest('.doc-demo')) return;
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
  const result = (mode, picks, lead) => {
    const cites = picks.map((b, i) => cite(b, i + 1)), first = cites.find(c => c.kind !== 'row') || cites[0];
    return { mode, lead: lead || (first.kind === 'row' ? `${first.heading}: ${first.text}.` : firstSentence(first.text)), leadCite: first.n, quotes: cites.map(c => c.n), cites };
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
    const quotes = a.quotes?.length ? `<div class="rdr-quotes">${a.quotes.map(byN).map(c => `<button type="button" class="rdr-quote" data-act="rdr-cite" data-q="${esc(c.quote)}" data-page="${c.page}"><span class="rdr-quote__n">${c.n}</span><span class="rdr-quote__body"><span class="rdr-quote__text">“${esc(clip(c.text, 280))}”</span><span class="rdr-quote__meta">Page ${c.page}${c.heading ? ' · ' + esc(c.heading) : ''}</span></span></button>`).join('')}</div>` : '';
    return `<div class="rdr-a"><p class="rdr-a__lead">${esc(a.lead)}${a.leadCite ? ' ' + citeBtn(byN(a.leadCite)) : ''}</p>${list}${quotes}</div>`;
  }
  function askPane(doc) {
    const a = askUi(doc.id);
    if (!a.thread.length) return `<div class="rdr-ask-empty"><div class="rdr-ask-empty__title">${ic('sparkles', 'i-sm')}Ask about this document</div>
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
      r.source.url && btn('Copy source link', { size: 'sm', icon: 'link', act: 'rdr-copy-source', data: { id: doc.id } }),
      edit && btn('Edit details', { size: 'sm', icon: 'pencil', act: 'res-edit', data: { id: doc.id } }),
      edit && X.res.linkableSpaces().length && btn('Link to spaces', { size: 'sm', icon: 'link-2', act: 'res-link', data: { id: doc.id } }),
      owner && btn('Manage access', { size: 'sm', icon: 'lock', href: `/knowledge/${kb.id}?tab=access` }),
    ].filter(Boolean).join('');
    const viewing = +query.v || r.version;
    const versions = [...r.versions].sort((a, b) => b.v - a.v).map(v => {
      const cur = v.v === r.version, on = v.v === viewing;
      const trail = cur ? chip('Current', { size: 'sm', tone: on ? 'accent' : 'default' }) : on ? chip('Viewing', { size: 'sm', tone: 'accent' }) : linkBtn('View', { act: 'rdr-version', data: { v: v.v } });
      return `<li class="${cx('rdr-ver', on && 'is-on')}"><span class="rdr-ver__v num">v${v.v}</span><span class="rdr-ver__body"><span class="rdr-ver__note">${esc(v.note || 'Updated')}</span><span class="rdr-ver__meta">${esc(fmtDate(v.at))}${v.by ? ' · ' + esc(v.by) : ''}</span></span><span class="rdr-ver__trail">${trail}</span></li>`;
    }).join('');
    return railSec('Details', X.res.details(doc)) + (acts ? `<div class="rdr-acts">${acts}</div>` : '') + railSec('Version history', `<ol class="rdr-vers">${versions}</ol>`);
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
    if (role === null) return unavailable('This document isn’t available', 'It may have been removed, or it isn’t shared with you.', btn('Go to Browse', { v: 'primary', href: '/knowledge/browse' }));
    const pending = D.requests.find(r => r.kb === kb.id && r.user === me().id && r.status === 'pending');
    return unavailable('You don’t have access to this document', `It’s in ${esc(kb.name)}, which is restricted.`, pending ? chip('Access requested', { tone: 'warning', icon: 'clock' }) : btn('Request access', { v: 'primary', icon: 'lock', act: 'kb-request', data: { kb: kb.id } }));
  }

  /* ═══════════════ Page ═══════════════ */
  let lastNeedles = [];
  P.docViewer = ({ params, query }) => {
    lastNeedles = [];
    const doc = docById(params.id), kb = doc && kbById(doc.kb);
    if (!doc || doc.archived || !kb || kb.archived) {
      crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'Not available' }]);
      return `<div class="rdr-msg">${emptyState({ icon: 'file', title: 'This document isn’t available', desc: 'It may have been archived or removed.', actions: btn('Go to Browse', { v: 'primary', href: '/knowledge/browse' }), boxed: true })}</div>`;
    }
    if (!canReadKb(kb)) return noAccess(doc, kb);
    const u = rdrUi(), r = res(doc), edit = canEditKb(kb), readable = isSearchable(doc);
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: kb.name, to: '/knowledge/' + kb.id }, { label: doc.name }]);
    const m = readable ? X.docModel(doc) : null;
    const ns = m ? needles(doc, query, m) : [];
    ns.forEach(n => n.cite && n.text.length >= 40 && injectQuote(m, n.text, n.page));
    lastNeedles = ns.map(n => n.text);
    const total = m ? ns.reduce((a, n) => a + countIn(m.text, n.text), 0) : 0;
    const hitKey = S.cur.full; if (u.hitKey !== hitKey) { u.hitKey = hitKey; u.hit = 0; }
    const conv = query.from ? convById(query.from) : null;
    const isSheet = !!m?.pages.some(p => p.cls === 'doc-page--sheet');
    const pageCount = Math.max(doc.pages || 1, ...(m?.pages.map(p => p.no) || [1]));
    const hasOutline = readable && !isSheet && m.outline.length > 1;
    const open = railOpen(u);
    if (!readable && u.tab === 'ask') u.tab = 'about';
    const k = kindMeta(r.kind);

    /* Header */
    const back = conv
      ? `<a class="link-button rdr-back" href="#/chat/${conv.id}">${ic('arrow-left', 'i-sm')}Back to conversation</a>`
      : `<button type="button" class="link-button rdr-back" data-act="rdr-back">${ic('arrow-left', 'i-sm')}Back</button>`;
    const meta = [esc(k.label), esc(kb.name), r.owner && esc(r.owner), `<span title="${esc(fmtDateTime(doc.updated))}">Updated ${esc(rel(doc.updated).replace(/^(Just now|Yesterday)$/, s => s.toLowerCase()))}</span>`, `v${r.version}`, readable && !isSheet && plural(pageCount, 'page')].filter(Boolean).join(dot);
    const useIt = readable && X.res.useItems(doc).length;
    const actions = [
      readable ? btn('Ask', { v: 'primary', icon: 'sparkles', act: 'rdr-ask-open', cls: 'rdr-ask-btn' }) : '',
      `<span class="rdr-wrap rdr-wide">${X.res.saveBtn(doc, { label: true, size: 'md' })}</span>`,
      btn('Add to collection', { icon: 'list-plus', act: 'res-collect', data: { id: doc.id }, tip: 'Add to collection', cls: 'rdr-wide rdr-squeeze' }),
      useIt ? btn('Use in…', { icon: 'zap', iconRight: 'chevron-down', menu: 'res-use', data: { id: doc.id }, tip: 'Use in a workflow', cls: 'rdr-wide rdr-squeeze' }) : '',
      iconBtn('download', 'Download', { act: 'doc-dl', data: { id: doc.id }, cls: 'rdr-wide' }),
      hasOutline ? iconBtn('list', 'Outline', { menu: 'rdr-outline', data: { id: doc.id }, cls: 'rdr-outline-btn' }) : '',
      iconBtn('panel-right', open ? 'Hide panel' : 'Show panel', { act: 'rdr-rail', aria: `aria-pressed="${open}"` }),
      X.res.moreBtn(doc, 'md'),
    ].join('');
    const firstCite = ns[0]?.cite;
    const qText = (query.q || '').trim();
    const hits = ns.length && readable ? `<div class="rdr-hits" role="status">${ic(firstCite ? 'quote' : 'search', 'i-sm')}<span class="grow truncate">${total
      ? (firstCite ? `Cited passage${total > 1 ? ` <span class="num" id="rdr-hit-n">${u.hit + 1}</span> of <span class="num" id="rdr-hit-total">${total}</span>` : ''}` : `<span class="num" id="rdr-hit-n">${u.hit + 1}</span> of <span class="num" id="rdr-hit-total">${total}</span> for “${esc(qText)}”`)
      : `No matches for “${esc(qText || ns[0].text)}”`}</span>${total > 1 ? iconBtn('chevron-up', 'Previous', { size: 'sm', act: 'rdr-hit', data: { dir: -1 } }) + iconBtn('chevron-down', 'Next', { size: 'sm', act: 'rdr-hit', data: { dir: 1 } }) : ''}${iconBtn('x', 'Clear highlights', { size: 'sm', act: 'rdr-clear' })}</div>` : '';
    const head = `<header class="rdr-head">${back}
      <div class="rdr-head__row">${fileIcon(doc.type, 'lg')}<div class="rdr-head__main"><div class="rdr-head__title-row"><h1 class="rdr-head__title" title="${esc(doc.name)}">${esc(doc.name)}</h1>${X.res.trustChip(doc)}${X.res.statusChip(doc)}${X.res.demoChip()}</div><div class="rdr-head__meta">${meta}</div></div>
        <div class="rdr-head__actions">${actions}</div></div>${hits}</header>`;

    /* Banners: only when they change what the reader should do */
    const t = trustOf(doc), canEdit = X.res.canEditRes(doc);
    const trustBanner = t.state === 'review' ? alertBox('warning', doc.status === 'outdated' ? 'Changed at the source' : 'Review due', esc(t.note || t.desc) + (canEdit ? '' : ` Check with ${esc(r.owner || 'the owner')} before relying on it.`),
      canEdit ? btn('Mark as verified', { size: 'sm', icon: 'shield-check', act: 'res-verify', data: { id: doc.id } }) + (doc.status === 'outdated' ? X.docFix(doc, { size: 'sm' }) : '') : '') : '';
    const vq = +query.v, ver = vq && vq !== r.version ? r.versions.find(x => x.v === vq) : null;
    const verBanner = ver ? alertBox('accent', `You’re viewing version ${ver.v} from ${fmtDate(ver.at)}`, esc(ver.note || ''), btn('View current', { size: 'sm', act: 'rdr-version', data: { v: '' } }), { icon: 'history' }) : '';
    const banners = trustBanner || verBanner ? `<div class="rdr-banners">${verBanner}${trustBanner}</div>` : '';

    /* Canvas */
    const pagesHtml = () => {
      if (isSheet) return m.pages.map(p => `<div class="${cx('doc-page', p.cls)}">${p.html}</div>`).join('');
      let h = '', prev = 0;
      m.pages.forEach(p => { if (p.no > prev + 1) h += `<div class="doc-gap">${p.no - 1 === prev + 1 ? `Page ${prev + 1}` : `Pages ${prev + 1}–${p.no - 1}`}</div>`; h += `<div class="${cx('doc-page', p.cls)}" data-page="${p.no}">${p.html}</div><div class="doc-page-no">Page ${p.no} of ${pageCount}</div>`; prev = p.no; });
      if (pageCount > prev) h += `<div class="doc-gap">${prev + 1 === pageCount ? `Page ${pageCount}` : `Pages ${prev + 1}–${pageCount}`}</div>`;
      return h;
    };
    const skel = () => `<div class="doc-page" aria-busy="true" aria-label="Loading"><div class="stack gap-12"><span class="skeleton skeleton--title" style="width:55%"></span>${[92, 86, 95, 70, 0, 40, 90, 84, 60].map(w => w ? `<span class="skeleton skeleton--line" style="width:${w}%"></span>` : '<span style="height:12px"></span>').join('')}</div></div>`;
    const canvas = gate({
      ok: () => (readable ? pagesHtml() : notReady(doc, kb, edit)),
      loading: skel,
      empty: () => `<div class="doc-state">${emptyState({ icon: 'file', title: 'Nothing to show', desc: 'This document has no readable content yet.' })}</div>`,
      error: () => errorState({ title: 'This document didn’t load' }),
    });

    /* Outline */
    const outline = !hasOutline ? '' : u.outline
      ? `<nav class="rdr-outline" aria-label="Outline"><div class="rdr-outline__head"><span class="t-label">On this page</span>${iconBtn('chevron-left', 'Hide outline', { size: 'sm', act: 'rdr-outline' })}</div>${m.outline.map((o, i) => `<button type="button" class="${cx('rdr-outline__link', !i && 'is-on')}" data-act="rdr-jump" data-h="${o.id}">${esc(o.title)}</button>`).join('')}</nav>`
      : `<nav class="rdr-outline rdr-outline--closed" aria-label="Outline">${iconBtn('list', 'Show outline', { size: 'sm', act: 'rdr-outline' })}</nav>`;

    /* Rail */
    const tabItems = [readable && { id: 'ask', label: 'Ask' }, { id: 'about', label: 'About' }, { id: 'related', label: 'Related' }].filter(Boolean);
    const paneBody = () => (u.tab === 'ask' ? askPane(doc) : u.tab === 'related' ? relatedPane(doc) : aboutPane(doc, query));
    const railBody = gate({ ok: paneBody, empty: paneBody, loading: () => `<div class="stack gap-12">${[80, 64, 92, 50].map(w => `<span class="skeleton skeleton--line" style="width:${w}%"></span>`).join('')}</div>`, error: () => errorState({ boxed: false }) });
    const composer = u.tab === 'ask' && readable ? `<div class="rdr-composer">${input({ id: 'rdr-ask-q', bind: `rdrAsk-${doc.id}.q`, value: askUi(doc.id).q, placeholder: 'Ask about this document', onEnter: 'rdr-ask-send' })}${btn('', { v: 'primary', icon: 'send', tip: 'Ask', act: 'rdr-ask-send', disabled: askUi(doc.id).thread.some(x => x.pending) })}</div>` : '';
    const rail = open ? `<aside class="rdr-rail" aria-label="Document panel"><div class="rdr-rail__head">${tabs(tabItems, u.tab, '', { act: 'rdr-tab' })}${iconBtn('x', 'Close panel', { size: 'sm', act: 'rdr-rail' })}</div>
      <div class="rdr-rail__body" id="rdr-rail-body" data-keep-scroll>${railBody}</div>${composer}</aside><div class="rdr-scrim" data-act="rdr-rail" aria-hidden="true"></div>` : '';

    return `<div class="rdr">${head}<div class="${cx('rdr-body', open && 'has-rail')}">${outline}<div class="rdr-canvas" id="rdr-scroll" data-keep-scroll>${banners}${canvas}</div>${rail}</div></div>`;
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
    sc.onscroll = links.length ? track : null; if (links.length) track();
  };

  /* ═══════════════ Actions ═══════════════ */
  const curDoc = () => docById(S.cur?.params?.id);
  const jump = id => { const sc = $('#rdr-scroll'), h = document.getElementById(id); if (!sc || !h) return; sc.scrollTo({ top: sc.scrollTop + h.getBoundingClientRect().top - sc.getBoundingClientRect().top - 24, behavior: 'smooth' }); };
  A['rdr-back'] = () => go(origin || '/knowledge/browse');
  A['rdr-hit'] = el => { rdrUi().hit += +el.dataset.dir; refresh(); };
  A['rdr-clear'] = () => setQuery({ q: '', page: '' });
  A['rdr-outline'] = () => { const u = rdrUi(); u.outline = !u.outline; refresh(); };
  A['rdr-jump'] = el => jump(el.dataset.h);
  A['rdr-rail'] = () => { const u = rdrUi(); u.rail = !railOpen(u); refresh(); };
  A['rdr-tab'] = el => { const u = rdrUi(); if (u.tab === el.dataset.value) return; u.tab = el.dataset.value; refresh(); const rb = $('#rdr-rail-body'); if (rb) rb.scrollTop = u.tab === 'ask' ? rb.scrollHeight : 0; };
  A['rdr-version'] = el => setQuery({ v: el.dataset.v || '' });
  A['rdr-copy-source'] = el => { const d = docById(el.dataset.id); if (d) copyText(res(d).source.url, 'Source link copied'); };
  A['rdr-ask-open'] = () => { const u = rdrUi(); u.rail = true; u.tab = 'ask'; refresh(); requestAnimationFrame(() => $('#rdr-ask-q')?.focus()); };
  A['rdr-ask-prompt'] = el => ask(curDoc(), el.dataset.q);
  A['rdr-ask-send'] = () => { const d = curDoc(); if (!d) return; const v = $('#rdr-ask-q')?.value ?? askUi(d.id).q; ask(d, v); requestAnimationFrame(() => $('#rdr-ask-q')?.focus()); };
  A['rdr-ask-clear'] = () => { const d = curDoc(); if (d) { S.ui['rdrAsk-' + d.id] = { q: '', thread: [] }; refresh(); } };
  A['rdr-ask-all'] = el => A['chat-ask']?.({ dataset: { q: el.dataset.q || '' } });
  A['rdr-ask-chat'] = () => { const d = curDoc(); if (!d) return; const last = askUi(d.id).thread.at(-1); A['chat-ask']?.({ dataset: { q: last?.q || '', doc: d.id, kb: d.kb } }); };
  /** A citation in the rail: highlight and scroll to that passage (closes the overlay rail on narrow screens). */
  A['rdr-cite'] = el => { if (frameW() < RAIL_MIN) rdrUi().rail = false; setQuery({ q: el.dataset.q, page: el.dataset.page || '' }); };
  MENUS['rdr-outline'] = el => {
    const d = docById(el.dataset.id); if (!d || !isSearchable(d)) return [];
    return [{ section: 'On this page' }, ...X.docModel(d).outline.map(o => ({ label: o.title, icon: 'chevron-right', run: () => jump(o.id) }))];
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
      el.innerHTML = btn('Ask about this', { v: 'ghost', size: 'sm', icon: 'sparkles', act: 'rdr-sel-ask' }) + btn('Copy', { v: 'ghost', size: 'sm', icon: 'copy', act: 'rdr-sel-copy' });
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

/* Home (/home): the intent-driven entry to the workspace. One box to ask a
   question or find a document (typing shows the two actions, matching
   documents and your earlier questions), then — only when there's something
   to show — where you left off, what changed that's worth knowing, a few
   documents to read, and topic shortcuts into Knowledge. Home points into
   Knowledge, Inbox and Conversations; it doesn't reproduce them.
   Shared: X.upNext({space?, limit?, queue?}), X.upNextList(items, {empty?, space?}).
   Menus: home-featured, home-scope. Prefix: home-. */
(() => {
  'use strict';

  const WAITING = ['submitted', 'in_review'];
  const DUE_KINDS = ['deadline', 'quiz', 'queue'];
  const KIND_ICON = { deadline: 'clock', quiz: 'check-circle', exam: 'file-text', meeting: 'users', reply: 'message', queue: 'inbox' };

  /* ── Time ── */
  const dayStart = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayDiff = ts => Math.round((dayStart(ts) - dayStart(NOW)) / DAY);
  /** Relative, human wording for an up-next item: "Due tomorrow, 9:00 PM", "In 3 days", "Overdue · Oct 30". */
  function when(it) {
    if (it.kind === 'reply') return { text: 'Needs your reply', tone: 'soon' };
    const due = DUE_KINDS.includes(it.kind), prefix = it.kind === 'queue' ? 'Oldest due' : 'Due', d = dayDiff(it.at);
    if (it.at < NOW) return { text: due ? `${it.kind === 'queue' ? 'Oldest overdue' : 'Overdue'} · ${fmtDate(it.at)}` : fmtDate(it.at), tone: due ? 'danger' : '' };
    const day = d <= 0 ? `today, ${fmtTime(it.at)}` : d === 1 ? `tomorrow, ${fmtTime(it.at)}` : d < 7 ? `in ${d} days` : fmtDate(it.at);
    return { text: due ? `${prefix} ${day}` : day[0].toUpperCase() + day.slice(1), tone: due && d <= 1 ? 'soon' : '' };
  }

  /* ── Up next ── */
  const typeOf = r => (D.requestTypes || []).find(t => t.id === r.type);
  function attempted(w) {
    if (X.work?.myAttempt) return !!X.work.myAttempt(w);
    const id = me().id; return (w.data?.attempts || []).some(a => a?.user === id);
  }
  function eventVisible(e) {
    const sp = e.space && spaceById(e.space);
    if (e.space && (!sp || sp.archived)) return false;
    if (e.audience === 'all') return true;
    if (e.audience === 'staff') return isSpaceStaff(sp);
    return !!spaceRole(sp);
  }
  /** The one action for an event; null = nothing left to do (e.g. quiz already taken). */
  function eventAction(e, sp) {
    const w = e.work && hasModule('work') && (D.works || []).find(x => x.id === e.work);
    if (w) {
      if (w.kind === 'quiz' && w.owner !== me().id && !isSpaceStaff(sp)) return attempted(w) ? null : { label: 'Take quiz', href: '/work/' + w.id, strong: true };
      return { label: w.owner !== me().id ? 'Open' : w.status === 'published' ? 'Results' : 'Continue', href: '/work/' + w.id };
    }
    if (e.requestType && hasModule('requests')) {
      if (isSpaceStaff(sp)) return { label: 'Review queue', href: `/space/${sp.id}?tab=queue` };
      if (me().profile) return { label: 'Start request', act: 'home-request', data: { type: e.requestType } };
    }
    const doc = e.doc && docById(e.doc);
    if (doc && canReadKb(kbById(doc.kb))) return { label: 'Open', href: '/doc/' + doc.id };
    return sp ? { label: 'Open', href: '/space/' + sp.id } : undefined;
  }
  /** What's coming up for the caller: visible events plus quizzes to take, requests waiting on them and (staff) their queues. */
  X.upNext = ({ space, limit = 6, queue = true } = {}) => {
    const out = [], inScope = id => !space || id === space, eventWorks = new Set();
    (D.events || []).forEach(e => {
      if (!inScope(e.space) || !eventVisible(e) || e.at < NOW - 2 * DAY) return;
      if (e.work) eventWorks.add(e.work);
      const sp = spaceById(e.space), action = eventAction(e, sp);
      if (action === null) return;
      out.push({ id: e.id, title: e.title, at: e.at, space: e.space, kind: e.kind, action });
    });
    if (hasModule('work')) (D.works || []).forEach(w => {
      const sp = spaceById(w.space);
      if (w.kind !== 'quiz' || w.status !== 'published' || w.visibility !== 'space' || eventWorks.has(w.id) || !inScope(w.space)) return;
      if (!sp || sp.archived || !spaceRole(sp) || isSpaceStaff(sp) || w.owner === me().id || attempted(w)) return;
      out.push({ id: 'quiz-' + w.id, title: w.title, at: w.due || w.published || w.updated, space: w.space, kind: 'quiz', action: { label: 'Take quiz', href: '/work/' + w.id, strong: true } });
    });
    if (hasModule('requests')) {
      (D.svcRequests || []).filter(r => r.requester === me().id && r.status === 'needs_info' && inScope(r.space)).forEach(r =>
        out.push({ id: 'req-' + r.id, title: typeOf(r)?.name || 'Request', at: r.updated, space: r.space, kind: 'reply', action: { label: 'Reply', href: '/requests/' + r.id, strong: true } }));
      if (queue) (D.spaces || []).filter(sp => !sp.archived && inScope(sp.id) && isSpaceStaff(sp)).forEach(sp => {
        const open = (D.svcRequests || []).filter(r => r.space === sp.id && WAITING.includes(r.status));
        if (!open.length) return;
        const oldest = open.reduce((a, b) => ((a.due || a.created) <= (b.due || b.created) ? a : b));
        const questions = open.every(r => typeOf(r)?.question);
        out.push({ id: 'queue-' + sp.id, title: `${plural(open.length, questions ? 'question' : 'request')} waiting`, at: oldest.due || oldest.created, space: sp.id, kind: 'queue', action: { label: 'Review queue', href: `/space/${sp.id}?tab=queue` } });
      });
    }
    return out.sort((a, b) => (b.kind === 'reply') - (a.kind === 'reply') || a.at - b.at).slice(0, limit);
  };
  /** List of up-next items, each with one action. Pass {space} to drop the space name (inside a space page). */
  X.upNextList = (items, { empty, space } = {}) => {
    if (!items.length) return empty ?? emptyState({ icon: 'calendar', title: 'You’re all caught up', desc: 'Deadlines, quizzes and requests that need you show up here.', compact: true, boxed: true });
    return list(items.map(it => {
      const w = when(it), sp = !space && it.space && spaceById(it.space), a = it.action;
      const desc = `<span class="${cx('home-when', w.tone && 'home-when--' + w.tone)}" title="${esc(fmtDateTime(it.at))}">${esc(w.text)}</span>${sp ? ` · ${esc(sp.name)}` : ''}`;
      const trail = a ? btn(a.label, { v: a.strong ? 'secondary' : 'tertiary', size: 'sm', href: a.href, act: a.act, data: a.data }) : '';
      return item({ lead: itemIcon(KIND_ICON[it.kind] || 'calendar', w.tone === 'danger' ? 'danger' : w.tone === 'soon' ? 'warning' : '', 'sm'), title: esc(it.title), desc, trail });
    }), 'home-upnext');
  };

  /* ═══════════════ Document helpers ═══════════════ */
  const bare = n => String(n || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  /** "ADR-027" for coded titles ("ADR-027 — Event-driven ledger updates"), else the title, shortened. */
  function shortName(d) {
    const n = bare(d.name), code = n.match(/^([A-Z][A-Z0-9]*-?\d+[A-Z0-9-]*)\s+[—–-]\s+/);
    if (code) return code[1];
    return n.length > 42 ? n.slice(0, 40).trimEnd() + '…' : n;
  }
  const isVerified = d => trustOf(d).state === 'verified';
  const isShared = d => !kbById(d.kb)?.personal;
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const okMark = d => (isVerified(d) ? `<span class="home-ok" data-tip="${esc(trustOf(d).note)}">${ic('shield-check', 'i-xs')}<span class="sr-only">Verified</span></span>` : '');

  /* ═══════════════ Signals (deterministic, permission-filtered) ═══════════════ */
  /** Published, readable, shared documents: the only pool Home draws from. */
  const publishedPool = () => catalogPool().filter(isShared);
  const readableBases = () => visibleKbs().filter(k => !k.personal && canReadKb(k));
  const starters = () => (D.assistant?.roleStarters?.[S.persona] || D.assistant?.starters || []).filter(s => s?.prompt).map(s => s.prompt);
  const myQuestions = () => [...myConvs()].sort((a, b) => b.at - a.at);
  /** Topics the caller has been reading or saving: what "relevant to you" means here. */
  function myTopics() {
    const t = new Map();
    recentResources(10).forEach((x, i) => res(x.doc).topics.flatMap(topicLineage).forEach(id => t.set(id, (t.get(id) || 0) + 2 - i * 0.1)));
    savedResources().forEach(d => res(d).topics.flatMap(topicLineage).forEach(id => t.set(id, (t.get(id) || 0) + 1)));
    return t;
  }

  /* ═══════════════ Hero: one box to ask or find ═══════════════ */
  const callName = n => { const p = String(n || '').trim().split(/\s+/); return p.length >= 3 ? p[p.length - 1] : p[0]; };
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  /** Text that reads like a question defaults to Ask; anything else defaults to finding documents. Both actions are always shown. */
  const QUESTION = /^(how|what|when|where|why|who|which|can|could|do|does|did|is|are|should|tell me|explain|summari[sz]e)\b/i;
  const isQuestion = q => /\?\s*$/.test(q) || QUESTION.test(q.trim());
  const hui = () => ui('home', { q: '', scope: '', open: false, active: 0 });
  /** Scope: the whole workspace, one readable knowledge base or one of my spaces. Secondary: a quiet menu inside the box. */
  function scopeLabel(f) {
    if (f.scope.startsWith('kb:')) { const k = kbById(f.scope.slice(3)); if (k && canReadKb(k)) return k.name; }
    if (f.scope.startsWith('sp:')) { const s = spaceById(f.scope.slice(3)); if (s && spaceRole(s)) return s.name; }
    f.scope = ''; return `All of ${curWs().name}`;
  }
  const scopeOf = () => { const s = hui().scope || ''; return s.startsWith('kb:') ? { kb: s.slice(3) } : s.startsWith('sp:') ? { space: s.slice(3) } : {}; };
  const scopeFilters = () => { const s = scopeOf(); return s.kb ? { kb: [s.kb] } : s.space ? { space: [s.space] } : {}; };
  /** What the box offers for the current text: the two actions first (the likely one leads), then matching documents and earlier
      questions. Empty text: your recent questions, then a few the workspace suggests. Each option: { act, html, …data }. */
  function options(q) {
    const text = q.trim(), out = [];
    if (text) {
      const ask = { kind: 'ask', q: text, icon: 'sparkles', html: `<span class="home-opt__main">Ask AI <span class="home-opt__q">“${esc(text)}”</span></span><span class="home-opt__hint">Answer with sources</span>` };
      const find = { kind: 'find', q: text, icon: 'search', html: `<span class="home-opt__main">Find documents for <span class="home-opt__q">“${esc(text)}”</span></span><span class="home-opt__hint">Open in Knowledge</span>` };
      out.push(...(isQuestion(text) ? [ask, find] : [find, ask]));
      const toks = tokens(text);
      catalogSearch({ q: text, filters: scopeFilters(), view: 'grid' }).rows.filter(x => isShared(x.doc)).slice(0, 4).forEach(({ doc }) => out.push({
        kind: 'doc', id: doc.id, q: text, group: 'Documents',
        lead: fileIcon(doc.type, 'sm'), html: `<span class="home-opt__main">${markTokens(bare(doc.name), toks)}</span><span class="home-opt__hint">${esc(kindMeta(res(doc).kind).label)}</span>`,
      }));
      myQuestions().filter(c => toks.length && toks.every(t => fold(c.title).includes(t))).slice(0, 2).forEach(c => out.push({
        kind: 'conv', id: c.id, group: 'You asked', icon: 'message', html: `<span class="home-opt__main">${markTokens(c.title, toks)}</span><span class="home-opt__hint">${esc(relLow(c.at))}</span>`,
      }));
    } else {
      const recent = myQuestions().slice(0, 3);
      recent.forEach(c => out.push({ kind: 'conv', id: c.id, group: 'Continue a conversation', icon: 'message', html: `<span class="home-opt__main">${esc(c.title)}</span><span class="home-opt__hint">${esc(relLow(c.at))}</span>` }));
      const seen = new Set(recent.map(c => fold(c.title)));
      starters().filter(s => !seen.has(fold(s))).slice(0, 4 - Math.min(recent.length, 2)).forEach(s => out.push({ kind: 'ask', q: s, group: 'Ask', icon: 'sparkles', html: `<span class="home-opt__main">${esc(s)}</span>` }));
    }
    return out;
  }
  function panelHtml(f) {
    const opts = options(f.q || '');
    if (!f.open || !opts.length) return '';
    f.active = Math.min(f.active || 0, opts.length - 1);
    let last = '';
    const rows = opts.map((o, i) => {
      const head = o.group && o.group !== last ? `<div class="home-opt__group" role="presentation">${esc(o.group)}</div>` : '';
      last = o.group || '';
      return `${head}<div class="${cx('home-opt', `home-opt--${o.kind}`, i === f.active && 'is-active')}" role="option" id="home-opt-${i}" aria-selected="${i === f.active}" data-act="home-pick" data-i="${i}">${o.lead || `<span class="home-opt__icon" aria-hidden="true">${ic(o.icon, 'i-sm')}</span>`}<span class="home-opt__body">${o.html}</span>${i === f.active ? `<span class="home-opt__key" aria-hidden="true">${kbd('↵')}</span>` : ''}</div>`;
    }).join('');
    return `<div class="home-sug__list" role="listbox" id="home-sug-list" aria-label="Suggestions">${rows}</div>`;
  }
  /** Redraw only the suggestions (typing must not re-render the page or move focus). */
  function syncPanel() {
    const f = hui(), box = $('#home-sug'), inp = $('#home-q'); if (!box || !inp) return;
    box.innerHTML = panelHtml(f);
    const open = !!box.innerHTML;
    box.hidden = !open;
    inp.setAttribute('aria-expanded', String(open));
    if (open) inp.setAttribute('aria-activedescendant', 'home-opt-' + f.active); else inp.removeAttribute('aria-activedescendant');
  }
  function hero(f, firstVisit) {
    const sps = hasModule('spaces') ? mySpaces() : [], scoped = readableBases().length + sps.length > 1;
    const scope = scoped ? `<button type="button" class="home-box__scope" data-menu="home-scope" aria-haspopup="menu" aria-label="Search in: ${esc(scopeLabel(f))}">${ic(f.scope ? 'filter' : 'globe', 'i-xs')}<span class="truncate">${esc(scopeLabel(f))}</span>${ic('chevron-down', 'i-xs')}</button>` : '';
    // First visit only: three questions people actually ask here, so the box is never a blank page. Returning people get them on focus.
    const tries = firstVisit ? starters().slice(0, 3) : [];
    const suggest = tries.length ? `<div class="home-suggest" role="group" aria-label="Suggested questions"><span class="home-suggest__label">Try asking</span>${tries.map(s => `<button type="button" class="home-suggest__chip" data-act="home-suggest" data-q="${esc(s)}" title="${esc(s)}"><span class="truncate">${esc(s)}</span></button>`).join('')}</div>` : '';
    return `<section class="home-hero" aria-labelledby="home-title">
      <h1 class="home-title" id="home-title">${esc(greeting())}, ${esc(callName(me().name))}</h1>
      <div class="home-search">
        <div class="home-box" role="search">
          ${ic('search', 'home-box__icon')}
          ${input({ id: 'home-q', bind: 'home.q', value: f.q, type: 'search', placeholder: 'Ask a question or find a document', onEnter: 'home-go', cls: 'home-box__input', autofocus: true, attrs: `data-input="home-type" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="home-sug-list" aria-label="Ask a question or find a document" enterkeyhint="go"` })}
          ${scope}
        </div>
        <div class="home-sug" id="home-sug" hidden></div>
      </div>
      ${suggest}
    </section>`;
  }
  MENUS['home-scope'] = () => {
    const f = hui(), set = v => { f.scope = v; refresh(); requestAnimationFrame(() => $('#home-q')?.focus()); };
    const sps = hasModule('spaces') ? mySpaces() : [];
    return [
      { section: 'Search and answer from' },
      { label: `All of ${curWs().name}`, icon: 'globe', checked: !f.scope, run: () => set('') },
      ...(readableBases().length ? [{ section: 'Knowledge bases' }, ...readableBases().map(k => ({ label: k.name, checked: f.scope === 'kb:' + k.id, run: () => set('kb:' + k.id) }))] : []),
      ...(sps.length ? [{ section: 'My spaces' }, ...sps.map(s => ({ label: s.name, checked: f.scope === 'sp:' + s.id, run: () => set('sp:' + s.id) }))] : []),
    ];
  };

  /* ═══════════════ Pick up where you left off ═══════════════ */
  /** At most four: what is waiting on you first (changes requested, a reply, today's deadline, your review queue), then the documents
      you read last. Conversations live in the sidebar's Recent and in the box, so they aren't repeated here. Empty for a new person. */
  function continueItems() {
    const out = [];
    myContributions().filter(d => lifecycleOf(d).key === 'changes').slice(0, 1).forEach(d => out.push({
      href: `/knowledge/library?tab=contributions&open=${d.id}`, lead: fileIcon(d.type, 'sm'), title: bare(d.name), sub: 'Changes requested', tone: 'warning',
    }));
    const n = canReview() ? reviewQueue().length : 0;
    if (n) out.push({ href: '/documents?tab=review', lead: `<span class="home-cont__icon" aria-hidden="true">${ic('inbox', 'i-sm')}</span>`, title: `${plural(n, 'document')} to review`, sub: 'Waiting for your decision', tone: 'accent' });
    if (hasModule('spaces') || hasModule('requests')) X.upNext({ limit: 4 }).filter(it => it.kind === 'reply' || (it.at - NOW < 2 * DAY && it.at > NOW - DAY)).slice(0, 1).forEach(it => out.push({
      href: it.action?.href || '/inbox', act: it.action?.act, data: it.action?.data, lead: `<span class="home-cont__icon" aria-hidden="true">${ic(KIND_ICON[it.kind] || 'calendar', 'i-sm')}</span>`, title: it.title, sub: when(it).text, tone: 'warning',
    }));
    recentResources(8).filter(x => isReaderVisible(x.doc)).slice(0, Math.max(0, 4 - out.length)).forEach(({ doc, at }) => out.push({
      href: '/doc/' + doc.id, lead: fileIcon(doc.type, 'sm'), title: bare(doc.name), sub: `Opened ${relLow(at)}`, recent: true,
    }));
    return out.slice(0, 4);
  }
  function continueSection(items) {
    if (!items.length) return '';
    const card = it => {
      const attrs = it.act ? `role="button" tabindex="0" data-act="${it.act}" ${dataAttrs(it.data)}` : `href="#${esc(it.href)}"`;
      return `<${it.act ? 'div' : 'a'} class="${cx('home-cont', it.tone && 'home-cont--' + it.tone)}" ${attrs}>${it.lead}<span class="home-cont__body"><span class="home-cont__title">${esc(it.title)}</span><span class="home-cont__sub">${esc(it.sub)}</span></span>${ic('arrow-right', 'i-sm home-cont__go')}</${it.act ? 'div' : 'a'}>`;
    };
    const title = items.some(it => it.recent) ? 'Pick up where you left off' : 'Waiting for you';
    return `<section class="home-sec" aria-labelledby="home-cont-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-cont-h">${title}</h2></div><div class="home-conts">${items.map(card).join('')}</div></section>`;
  }

  /* ═══════════════ Worth knowing: what changed, from the source ═══════════════ */
  /** Source-backed updates people may have missed: a new version of a document with its owner's change note ("Batch cut-off moved
      from 16:00 to 15:30"), or an announcement with its summary. Only text written in or for the document; nothing generated. Skips
      what you already read after it changed. Ranked by your topics and spaces, then recency; three at most. */
  function insights() {
    const read = new Map(recentResources(40).map(x => [x.doc.id, x.at])), mine = myTopics(), spaces = new Set(hasModule('spaces') ? mySpaces().map(s => s.id) : []);
    const out = [];
    publishedPool().filter(d => !d.dupOf).forEach(d => {
      const r = res(d), v = (d.versions || [])[0];
      let it = null;
      if (v && v.v > 1 && v.note && NOW - v.at < 120 * DAY && !/reprocess|current version/i.test(v.note) && d.status === 'ready')
        it = { doc: d, at: v.at, text: v.note, label: `${kindMeta(r.kind).label} updated`, icon: 'history', source: `Version ${v.v}` };
      else if (r.kind === 'announcement' && d.summary && NOW - d.updated < 60 * DAY)
        it = { doc: d, at: d.updated, text: d.summary, label: 'Announcement', icon: 'megaphone', source: '' };
      if (!it || (read.get(d.id) || 0) > it.at) return;
      const rel = r.topics.flatMap(topicLineage).reduce((a, id) => a + (mine.get(id) || 0), 0) + (r.contexts.some(id => spaces.has(id)) ? 2 : 0);
      it.score = Math.min(rel, 6) + (isVerified(d) ? 1 : 0) + Math.max(0, 3 - (NOW - it.at) / (30 * DAY));
      out.push(it);
    });
    return out.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 3);
  }
  function insightsSection(list) {
    if (!list.length) return '';
    const card = it => `<a class="home-insight" href="#/doc/${esc(it.doc.id)}">
      <span class="home-insight__label">${ic(it.icon, 'i-xs')}${esc(it.label)}<span class="res-dot" aria-hidden="true">·</span>${esc(relLow(it.at))}</span>
      <span class="home-insight__text">${esc(it.text)}</span>
      <span class="home-insight__src">${fileIcon(it.doc.type, 'sm')}<span class="truncate">${esc(bare(it.doc.name))}${it.source ? ` · ${esc(it.source)}` : ''}</span>${okMark(it.doc)}</span></a>`;
    return `<section class="home-sec" aria-labelledby="home-know-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-know-h">Worth knowing</h2><span class="home-sec__note">What changed in documents you can read</span></div><div class="home-grid3">${list.map(card).join('')}</div></section>`;
  }

  /* ═══════════════ Reading: start here (new) · for you (returning) ═══════════════ */
  /** New people: what admins featured, topped up with the most-opened verified documents. Returning people: related to what they read,
      from their spaces, on topics they save — never what they've opened or what Worth knowing already shows. Three, each with its reason. */
  function reading(firstVisit, exclude) {
    const pool = publishedPool().filter(d => d.status === 'ready' && !d.dupOf && !exclude.has(d.id));
    const ok = new Set(pool.map(d => d.id));
    if (firstVisit) {
      const picked = featuredResources(8).filter(d => ok.has(d.id)).map(d => ({ doc: d, reason: `Recommended by ${curWs().name}` }));
      const popular = pool.filter(d => isVerified(d) && !picked.some(x => x.doc === d)).sort((a, b) => (b.views || 0) - (a.views || 0)).map(d => ({ doc: d, reason: 'Often opened' }));
      return [...picked, ...popular].slice(0, 3);
    }
    const read = new Set(recentResources(40).map(x => x.doc.id)), best = new Map();
    const bump = (d, score, reason) => {
      if (!ok.has(d.id) || read.has(d.id)) return;
      const cur = best.get(d.id) || { doc: d, score: 0, top: -1, reason: '' };
      cur.score += score; if (score > cur.top) { cur.top = score; cur.reason = reason; }
      best.set(d.id, cur);
    };
    recentResources(5).forEach((x, i) => relatedResources(x.doc, 6).forEach((d, j) => bump(d, 6 - i - j * 0.5, `Because you read ${shortName(x.doc)}`)));
    if (hasModule('spaces')) mySpaces().forEach(sp => pool.forEach(d => res(d).contexts.includes(sp.id) && bump(d, 2, `From ${sp.name}`)));
    featuredResources(8).forEach(d => bump(d, 1.5, `Recommended by ${curWs().name}`));
    best.forEach(x => { if (isVerified(x.doc)) x.score += 0.5; });
    const ranked = [...best.values()].sort((a, b) => b.score - a.score || b.doc.updated - a.doc.updated), per = new Map();
    // One per reason first, so one recent read doesn't fill the row.
    const out = ranked.filter(x => { const k = (per.get(x.reason) || 0) + 1; per.set(x.reason, k); return k <= 1; }).slice(0, 3);
    if (out.length < 3) out.push(...ranked.filter(x => !out.includes(x)).slice(0, 3 - out.length));
    return out;
  }
  function readingSection(list, firstVisit) {
    if (!list.length) return '';
    const manage = isAdmin() ? btn('', { v: 'ghost', size: 'sm', icon: 'sliders', menu: 'home-featured', tip: 'Documents featured on Home', aria: 'aria-label="Manage featured documents"' }) : '';
    const card = ({ doc, reason }) => `<a class="home-read" href="#/doc/${esc(doc.id)}">
      <span class="home-read__head">${fileIcon(doc.type, 'sm')}<span class="home-read__title">${esc(bare(doc.name))}</span>${okMark(doc)}</span>
      ${X.res.blurb(doc) ? `<span class="home-read__about">${esc(X.res.blurb(doc))}</span>` : ''}
      <span class="home-read__why">${esc(reason)}</span></a>`;
    return `<section class="home-sec" aria-labelledby="home-read-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-read-h">${firstVisit ? 'Start here' : 'Recommended for you'}</h2><span class="grow"></span>${manage}</div><div class="home-grid3">${list.map(card).join('')}</div></section>`;
  }

  /* ═══════════════ Topic shortcuts into Knowledge ═══════════════ */
  const HEX = /^#[0-9a-f]{3,8}$/i;
  /** The same domains and filter links as Knowledge's topic pills; hierarchy and counts stay in Knowledge. */
  function topicsSection() {
    const counts = new Map((catalogSearch(parseCatalogQuery({})).facets.topic || []).map(o => [o.value, o.count]));
    const domains = topicTree().filter(dm => counts.get(dm.id));
    if (!domains.length) return '';
    return `<section class="home-sec" aria-labelledby="home-topics-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-topics-h">Explore by topic</h2><span class="grow"></span>${linkBtn('All knowledge', { href: '/knowledge', icon: 'arrow-right' })}</div>
      <div class="home-topics">${domains.map(dm => `<a class="home-topic" href="#${catalogHref({ filters: { topic: [dm.id] } })}" ${HEX.test(dm.color || '') ? `style="--tone:${dm.color}"` : ''}><span class="home-topic__icon" aria-hidden="true">${ic(dm.icon || 'tag', 'i-sm')}</span>${esc(dm.name)}</a>`).join('')}</div></section>`;
  }

  /* ═══════════════ States ═══════════════ */
  function loadingBody() {
    const row = `<div class="home-cont home-skel" aria-hidden="true"><span class="skeleton home-skel__icon"></span><span class="home-cont__body"><span class="skeleton skeleton--line" style="width:70%"></span><span class="skeleton skeleton--line" style="width:40%;height:10px"></span></span></div>`;
    const card = `<div class="home-insight home-skel" aria-hidden="true"><span class="skeleton skeleton--line" style="width:45%;height:10px"></span><span class="skeleton skeleton--line" style="width:95%"></span><span class="skeleton skeleton--line" style="width:70%"></span><span class="skeleton skeleton--line" style="width:55%;height:10px"></span></div>`;
    const head = w => `<div class="home-sec__head"><span class="skeleton skeleton--title" style="width:${w}px"></span></div>`;
    return `<div class="home-body" aria-busy="true" aria-label="Loading"><section class="home-sec">${head(200)}<div class="home-conts">${row.repeat(4)}</div></section><section class="home-sec">${head(150)}<div class="home-grid3">${card.repeat(3)}</div></section></div>`;
  }
  const emptyBody = () => `<section class="home-sec">${emptyState({
    icon: 'book', title: 'Your workspace has no published knowledge yet', boxed: true,
    desc: canContribute() ? 'Contribute documents for review. Published documents show up here and can be asked about.' : 'Documents show up here once they’re published.',
    actions: X.res.uploadBtn('primary') + btn('Knowledge', { href: '/knowledge' }),
  })}</section>`;

  P.home = () => {
    const f = hui();
    f.open = false;
    const live = S.pageState === 'live' && !S.navLoading;
    const firstVisit = !recentResources(1).length && !myConvs().length;
    const body = gate({
      loading: loadingBody,
      empty: emptyBody,
      error: () => `<section class="home-sec">${errorState()}</section>`,
      ok: () => {
        if (!publishedPool().length) return emptyBody();
        const conts = continueItems(), know = insights();
        const shown = new Set([...know.map(x => x.doc.id)]);
        return `<div class="home-body">${continueSection(conts)}${insightsSection(know)}${readingSection(reading(firstVisit, shown), firstVisit)}${topicsSection()}</div>`;
      },
    });
    return `<div class="page home">${hero(f, live && firstVisit)}${body}</div>`;
  };

  /* ═══════════════ Actions ═══════════════ */
  const typed = () => String(hui().q ?? $('#home-q')?.value ?? '').trim();
  function ask(q) {
    if (!q) { $('#home-q')?.focus(); return; }
    Object.assign(hui(), { q: '', open: false });
    if (A['chat-ask']) A['chat-ask']({ dataset: { q, ...scopeOf() } }); else go('/chat');
  }
  function find(q) {
    Object.assign(hui(), { q: '', open: false });
    go(catalogHref({ q, filters: scopeFilters() }));
  }
  function pick(o) {
    if (!o) return;
    if (o.kind === 'ask') ask(o.q);
    else if (o.kind === 'find') find(o.q);
    else if (o.kind === 'doc') { Object.assign(hui(), { q: '', open: false }); go('/doc/' + o.id + (o.q ? '?q=' + encodeURIComponent(o.q) : '')); }
    else if (o.kind === 'conv') { hui().open = false; go('/chat/' + o.id); }
  }
  /** Enter runs the highlighted option: Ask for question-like text, Find otherwise — the box always shows which. */
  A['home-go'] = () => { const f = hui(), q = typed(); if (!q && !f.open) return; pick(options(q)[f.open ? f.active : 0]); };
  A['home-pick'] = el => pick(options(typed())[+el.dataset.i]);
  A['home-type'] = () => { const f = hui(); f.open = true; f.active = 0; syncPanel(); };
  A['home-suggest'] = el => ask(el.dataset.q || '');
  A['home-request'] = el => {
    const type = el?.dataset?.type;
    if (A['rq-new']) A['rq-new']({ dataset: { type } }); else go('/requests/new' + (type ? '?type=' + type : ''));
  };
  /* Open the suggestions when someone clicks into the box or presses ↓ (not on autofocus, so the page isn't covered on arrival);
     ↑/↓ move, Escape closes, leaving the box closes. Options keep focus in the input (mousedown is cancelled). */
  const onHome = () => S.cur?.r.page === 'home';
  document.addEventListener('mousedown', e => {
    if (!onHome()) return;
    if (e.target.closest?.('#home-sug [data-act]')) { e.preventDefault(); return; }
    if (e.target.id === 'home-q') { const f = hui(); if (!f.open) { f.open = true; f.active = 0; requestAnimationFrame(syncPanel); } }
  });
  document.addEventListener('keydown', e => {
    if (!onHome() || e.target.id !== 'home-q') return;
    const f = hui(), n = options(f.q || '').length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!f.open) { f.open = true; f.active = 0; } else if (n) f.active = (f.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      syncPanel(); $('#home-opt-' + f.active)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Escape' && f.open) { e.preventDefault(); e.stopPropagation(); f.open = false; syncPanel(); }
  }, true);
  document.addEventListener('focusout', e => {
    if (!onHome() || e.target.id !== 'home-q') return;
    setTimeout(() => { if (document.activeElement?.id !== 'home-q') { hui().open = false; syncPanel(); } }, 0);
  });
  /** Admins: what's featured on Home, with a quick way to take a document off. Adding happens from a document's ⋯ menu. */
  MENUS['home-featured'] = () => {
    const docs = featuredResources(8).filter(isShared);
    const items = docs.map(d => ({ label: bare(d.name), icon: 'x', run: () => {
      toggleFeatured(d.id); refresh();
      toast(`Removed “${bare(d.name)}” from Home`, { action: { label: 'Undo', run: () => { const l = featuredIds(), i = l.indexOf(d.id); if (i < 0) l.splice(Math.min(docs.indexOf(d), l.length), 0, d.id); persist(); refresh(); } } });
    } }));
    return [
      { section: docs.length ? 'Featured on Home · remove' : 'Nothing featured yet' },
      ...items,
      { sep: true },
      { label: 'Feature from Knowledge (⋯ menu)', icon: 'search', run: () => go(catalogHref({})) },
    ];
  };
})();

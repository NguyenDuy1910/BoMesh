/* Home (/home): Discover & Start — the workspace's front page, not a second
   chat composer. A greeting with what this workspace holds for you; three
   intent cards (find a document → Knowledge, ask a question → New chat,
   contribute → review); then, only when there's something to show, what
   needs you, what you were reading (with Ask about it), what changed at the
   source, a map of the knowledge by topic and a few documents to read.
   Home points into Knowledge, Chat and the Inbox; it doesn't reproduce them.
   Shared: X.upNext({space?, limit?, queue?}), X.upNextList(items, {empty?, space?}).
   Drawer: home-featured. Prefix: home-. */
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
      const desc = `<span class="${cx('home-when', w.tone && 'home-when--' + w.tone)}" data-tip="${esc(fmtDateTime(it.at))}">${esc(w.text)}</span>${sp ? ` · ${esc(sp.name)}` : ''}`;
      const trail = a ? btn(a.label, { v: a.strong ? 'secondary' : 'tertiary', size: 'sm', href: a.href, act: a.act, data: a.data }) : '';
      return item({ lead: itemIcon(KIND_ICON[it.kind] || 'calendar', w.tone === 'danger' ? 'danger' : w.tone === 'soon' ? 'warning' : '', 'sm'), title: esc(it.title), desc, trail });
    }), 'home-upnext');
  };

  /* ═══════════════ Document helpers ═══════════════ */
  const bare = bareName;
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
  const publishedPool = sharedPool;
  /** Topics the caller has been reading or saving: what "relevant to you" means here. */
  function myTopics() {
    const t = new Map();
    recentResources(10).forEach((x, i) => res(x.doc).topics.flatMap(topicLineage).forEach(id => t.set(id, (t.get(id) || 0) + 2 - i * 0.1)));
    savedResources().forEach(d => res(d).topics.flatMap(topicLineage).forEach(id => t.set(id, (t.get(id) || 0) + 1)));
    return t;
  }
  /** Readable document counts per topic (domains and their topics), from the same facets Knowledge shows. */
  const topicCounts = () => new Map((catalogSearch(parseCatalogQuery({}), publishedPool()).facets.topic || []).map(o => [o.value, o.count]));
  /** Domains that hold at least one readable document, each with its readable topics (most documents first). */
  function domains() {
    const counts = topicCounts();
    return topicTree().filter(dm => counts.get(dm.id)).map(dm => ({ ...dm, count: counts.get(dm.id), subs: dm.children.filter(t => counts.get(t.id)).sort((a, b) => counts.get(b.id) - counts.get(a.id)) }));
  }
  const sec = (key, title, body, { action = '' } = {}) =>
    `<section class="home-sec home-sec--${key}" aria-labelledby="home-${key}-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-${key}-h">${esc(title)}</h2><span class="grow"></span>${action}</div>${body}</section>`;

  /* ═══════════════ Header: who you are here, and what this workspace holds ═══════════════ */
  const callName = n => { const p = String(n || '').trim().split(/\s+/); return p.length >= 3 ? p[p.length - 1] : p[0]; };
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  /** One line of scale, computed from what the caller can read: "214 documents you can read, across 6 topics · 12 updated in the last 30 days". */
  function lede(pool) {
    if (!pool.length) return '<p class="home-lede">Find documents, ask questions answered from them and share what you know.</p>';
    const n = domains().length, fresh = pool.filter(d => NOW - d.updated < 30 * DAY).length;
    return `<p class="home-lede"><span>${n ? `${plural(pool.length, 'document')} you can read, across ${plural(n, 'topic')}` : `${plural(pool.length, 'document')} you can read`}</span>${fresh ? `<span class="home-lede__fresh">${fresh} updated in the last 30 days</span>` : ''}</p>`;
  }
  /** The three things people come here to do, each one click into the page that owns it. Not a composer: nothing is typed on Home. */
  function starts(pool) {
    const n = pool.length;
    const cards = [
      { icon: 'search', title: 'Find a document', desc: n ? `Search ${plural(n, 'document')} by title, topic or content` : 'Search by title, topic or content', href: '/knowledge', act: 'home-find' },
      { icon: 'sparkles', tone: 'accent', title: 'Ask a question', desc: `Answers from ${curWs().name} documents, with citations`, href: '/chat' },
      canContribute()
        ? { icon: 'upload', title: 'Contribute knowledge', desc: 'Share a document; a reviewer publishes it', act: 'contribute' }
        : { icon: 'bookmark', title: 'Your library', desc: 'Saved documents, recent reads and collections', href: '/knowledge/library' },
    ];
    const card = c => {
      const inner = `${itemIcon(c.icon, c.tone || '')}<span class="home-start__body"><span class="home-start__title">${esc(c.title)}</span><span class="home-start__desc">${esc(c.desc)}</span></span>${ic('arrow-right', 'i-sm home-start__go')}`;
      return c.href ? `<a class="home-start" href="#${c.href}"${c.act ? ` data-act="${c.act}"` : ''}>${inner}</a>` : `<button type="button" class="home-start" data-act="${c.act}">${inner}</button>`;
    };
    return `<nav class="home-starts" aria-label="Get started">${cards.map(card).join('')}</nav>`;
  }

  /* ═══════════════ Needs your attention · Continue reading ═══════════════ */
  /** What is waiting on you (changes requested, your review queue, a reply or today's deadline — three at most). */
  function waitingItems() {
    const out = [];
    myContributions().filter(d => lifecycleOf(d).key === 'changes').slice(0, 1).forEach(d => out.push({
      href: `/knowledge/library?tab=contributions&open=${d.id}`, lead: fileIcon(d.type, 'sm'), title: bare(d.name), sub: 'Changes requested', tone: 'warning',
    }));
    const n = canReview() ? reviewQueue().length : 0;
    if (n) out.push({ href: '/documents?tab=review', lead: itemIcon('inbox', 'accent', 'sm'), title: `${plural(n, 'document')} to review`, sub: 'Waiting for your decision' });
    if (hasModule('spaces') || hasModule('requests')) X.upNext({ limit: 4 }).filter(it => it.kind === 'reply' || (it.at - NOW < 2 * DAY && it.at > NOW - DAY)).slice(0, 1).forEach(it => out.push({
      href: it.action?.href || '/inbox', act: it.action?.act, data: it.action?.data, lead: itemIcon(KIND_ICON[it.kind] || 'calendar', 'warning', 'sm'), title: it.title, sub: when(it).text, tone: 'warning',
    }));
    return out.slice(0, 3);
  }
  function attentionSection() {
    const items = waitingItems();
    if (!items.length) return '';
    const row = it => item({ lead: it.lead, title: esc(it.title), desc: `<span class="${cx(it.tone && 'home-tone--' + it.tone)}">${esc(it.sub)}</span>`, ...(it.act ? { act: it.act, data: it.data } : { href: it.href }) });
    return sec('attention', 'Needs your attention', list(items.map(row), 'home-list'));
  }
  /** The documents you opened last → the Reader where you left off; Ask continues from the document (Reader's Ask, then Continue in chat). */
  function continueSection() {
    const all = recentResources(40).filter(x => isReaderVisible(x.doc)), rows = all.slice(0, 4);
    if (!rows.length) return '';
    const more = all.length > rows.length ? linkBtn('View all', { href: '/knowledge/library?tab=recent', size: 'sm' }) : '';
    return sec('continue', 'Continue reading', list(rows.map(({ doc, at }) => item({
      lead: fileIcon(doc.type, 'sm'), title: esc(bare(doc.name)), titleExtra: okMark(doc),
      desc: `Opened ${esc(relLow(at))}<span class="res-dot" aria-hidden="true">·</span>${esc(kindMeta(res(doc).kind).label)}`,
      href: '/doc/' + doc.id,
      trail: `<span class="reveal-on-hover">${iconBtn('sparkles', 'Ask about this document', { href: `/doc/${doc.id}?ask=1` })}</span>`,
    })), 'home-list'), { action: more });
  }

  /* ═══════════════ What's new: what changed, from the source ═══════════════ */
  /** Source-backed updates people may have missed: a new version of a document with its owner's change note ("Batch cut-off moved
      from 16:00 to 15:30"), or an announcement with its summary. Only text written in or for the document; nothing generated. Skips
      what you already read after it changed. Ranked by your topics and spaces, then recency; four at most. */
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
    return out.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 4);
  }
  function newsSection(items) {
    if (!items.length) return '';
    const row = it => `<a class="home-news" href="#/doc/${esc(it.doc.id)}" data-act="doc-preview" data-id="${esc(it.doc.id)}">
      <span class="home-news__meta">${ic(it.icon, 'i-xs')}<span>${esc(it.label)}</span><span class="res-dot" aria-hidden="true">·</span><span>${esc(relLow(it.at))}</span></span>
      <span class="home-news__text">${esc(it.text)}</span>
      <span class="home-news__src">${fileIcon(it.doc.type, 'sm')}<span class="truncate">${esc(bare(it.doc.name))}${it.source ? ` · ${esc(it.source)}` : ''}</span>${okMark(it.doc)}</span></a>`;
    return sec('news', 'What’s new', `<div class="home-feed">${items.map(row).join('')}</div>`);
  }

  /* ═══════════════ Reading: start here (new) · for you (returning) ═══════════════ */
  /** New people: what admins featured, topped up with the most-opened verified documents. Returning people: related to what they read,
      from their spaces, on topics they save — never what they've opened or what What's new already shows. Three, each with its reason. */
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
  function readingSection(rows, firstVisit) {
    if (!rows.length) return '';
    // Admins curate what Home features — the tool sits on the section only when it shows featured documents.
    const manage = isAdmin() && (firstVisit || rows.some(x => isFeatured(x.doc.id))) ? iconBtn('sliders', 'Edit featured documents', { size: 'sm', act: 'home-featured' }) : '';
    const row = ({ doc, reason }) => `<a class="item item--action home-rec" href="#/doc/${esc(doc.id)}" data-act="doc-preview" data-id="${esc(doc.id)}">
      <span class="item__lead">${fileIcon(doc.type, 'sm')}</span>
      <span class="home-rec__body"><span class="home-rec__title"><span class="truncate">${esc(bare(doc.name))}</span>${okMark(doc)}</span>
      ${X.res.blurb(doc) ? `<span class="home-rec__about">${esc(X.res.blurb(doc))}</span>` : ''}
      <span class="home-rec__why">${esc(reason)}</span></span></a>`;
    return sec(firstVisit ? 'start' : 'rec', firstVisit ? 'Start here' : 'Recommended for you', list(rows.map(row), 'home-list'), { action: manage });
  }

  /* ═══════════════ Explore knowledge: a map of what's here ═══════════════ */
  const HEX = /^#[0-9a-f]{3,8}$/i;
  /** One card per domain: what it covers (its description), how much there is, and its largest topics. The card opens Knowledge
      filtered to the domain; a topic opens it filtered to that topic. Browsing, filters and the full hierarchy stay in Knowledge. */
  function exploreSection() {
    const list_ = domains();
    if (!list_.length) return '';
    const card = dm => `<article class="home-topic"${HEX.test(dm.color || '') ? ` style="--tone:${dm.color}"` : ''}>
      <span class="home-topic__icon" aria-hidden="true">${ic(dm.icon || 'tag', 'i-sm')}</span>
      <div class="home-topic__body">
        <h3 class="home-topic__head"><a class="home-topic__link" href="#${catalogHref({ filters: { topic: [dm.id] } })}">${esc(dm.name)}</a><span class="home-topic__count num">${plural(dm.count, 'document')}</span></h3>
        ${dm.desc ? `<p class="home-topic__desc">${esc(dm.desc)}</p>` : ''}
        ${dm.subs.length ? `<p class="home-topic__subs">${dm.subs.slice(0, 3).map(t => `<a class="home-topic__sub" href="#${catalogHref({ filters: { topic: [t.id] } })}">${esc(t.name)}</a>`).join('')}</p>` : ''}
      </div></article>`;
    return sec('explore', 'Explore knowledge', `<div class="home-topics">${list_.map(card).join('')}</div>`, { action: linkBtn('All knowledge', { href: '/knowledge', icon: 'arrow-right', size: 'sm' }) });
  }

  /* ═══════════════ States ═══════════════ */
  function loadingBody() {
    const rows = n => `<div class="list home-list home-skel" aria-hidden="true">${`<div class="item"><span class="skeleton home-skel__icon"></span><span class="item__body"><span class="skeleton skeleton--line" style="width:62%"></span><span class="skeleton skeleton--line" style="width:34%;height:10px"></span></span></div>`.repeat(n)}</div>`;
    const topic = `<div class="home-topic home-skel" aria-hidden="true"><span class="skeleton home-skel__icon"></span><div class="home-topic__body"><span class="skeleton skeleton--line" style="width:45%"></span><span class="skeleton skeleton--line" style="width:90%;height:10px"></span><span class="skeleton skeleton--line" style="width:60%;height:10px"></span></div></div>`;
    const head = w => `<div class="home-sec__head"><span class="skeleton skeleton--title" style="width:${w}px"></span></div>`;
    return `<div class="home-body" aria-busy="true" aria-label="Loading"><div class="home-main"><section class="home-sec home-sec--continue">${head(160)}${rows(3)}</section><section class="home-sec home-sec--explore">${head(180)}<div class="home-topics">${topic.repeat(4)}</div></section></div>
      <aside class="home-aside"><section class="home-sec home-sec--news">${head(110)}${rows(3)}</section></aside></div>`;
  }
  const emptyBody = () => `<section class="home-sec">${emptyState({
    icon: 'book', title: 'Your workspace has no published knowledge yet', boxed: true,
    desc: canContribute() ? 'Contribute documents for review. Published documents show up here and can be asked about.' : 'Documents show up here once they’re published.',
    actions: X.res.uploadBtn('primary') + btn('Browse knowledge', { href: '/knowledge' }),
  })}</section>`;

  P.home = () => {
    const st = S.navLoading ? 'loading' : S.pageState, pool = st === 'live' ? publishedPool() : [];
    const empty = st === 'empty' || (st === 'live' && !pool.length);
    const firstVisit = !recentResources(1).length && !myConvs().length;
    const body = gate({
      loading: loadingBody,
      empty: emptyBody,
      error: () => `<section class="home-sec">${errorState()}</section>`,
      ok: () => {
        if (!pool.length) return emptyBody();
        const news = insights(), shown = new Set(news.map(x => x.doc.id)), reads = readingSection(reading(firstVisit, shown), firstVisit);
        // Main: carry on, then discover. Aside: what is timely. Phones and tablets interleave them (CSS order) so what needs you comes first.
        const main = `${continueSection()}${firstVisit ? reads : ''}${exploreSection()}${firstVisit ? '' : reads}`;
        const aside = `${attentionSection()}${newsSection(news)}`;
        return `<div class="${cx('home-body', !aside && 'home-body--single')}"><div class="home-main">${main}</div>${aside ? `<aside class="home-aside" aria-label="For you now">${aside}</aside>` : ''}</div>`;
      },
    });
    return `<div class="page home">
      <header class="home-head"><h1 class="home-title">${esc(greeting())}, ${esc(callName(me().name))}</h1>${lede(pool)}</header>
      ${empty ? '' : starts(pool)}
      ${body}</div>`;
  };

  /* ═══════════════ Actions ═══════════════ */
  /** Find a document: Knowledge → Browse with its search field ready to type in (once the page has finished loading). */
  A['home-find'] = () => {
    go('/knowledge');
    const until = Date.now() + 2000, focus = () => { const el = !S.navLoading && S.cur?.r.page === 'catalog' && $('#cat-q'); if (el) el.focus(); else if (Date.now() < until) setTimeout(focus, 50); };
    setTimeout(focus, 0);
  };
  A['home-request'] = el => {
    const type = el?.dataset?.type;
    if (A['rq-new']) A['rq-new']({ dataset: { type } }); else go('/requests/new' + (type ? '?type=' + type : ''));
  };
  /* ═══════════════ Featured on Home (admins) ═══════════════
     A small drawer: featured rows open the document, a trailing × takes one off (with Undo), and "Add documents" switches the
     drawer to a searchable picker of published shared documents. Also reachable from ⌘K ("Edit featured documents"). */
  const fui = () => ui('homeFeat', { adding: false, q: '', sel: {}, err: '' });
  const featuredDocs = () => featuredResources(99).filter(isShared);
  function candidates() {
    const f = fui(), fq = fold(f.q.trim());
    return publishedPool().filter(d => d.status === 'ready' && !d.dupOf && !isFeatured(d.id) && isReaderVisible(d) && (!fq || fold(bare(d.name)).includes(fq))).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 40);
  }
  DR['home-featured'] = () => {
    const f = fui();
    if (f.adding) {
      const rows = candidates(), n = Object.values(f.sel).filter(Boolean).length;
      return {
        title: 'Add to Home', desc: 'Pick published documents everyone should see first.',
        body: `${searchField({ bind: 'homeFeat.q', act: 'home-feat-q', placeholder: 'Search published documents', size: 'md', full: true, autofocus: true, id: 'home-feat-q' })}
          ${rows.length ? `<div class="option-list home-feat-pick mt-12">${rows.map(d => checkbox({ label: `${fileIcon(d.type, 'sm')}<span class="truncate">${esc(bare(d.name))}</span>`, checked: !!f.sel[d.id], act: 'home-feat-sel', data: { id: d.id } })).join('')}</div>` : `<p class="description mt-12">No published documents match “${esc(f.q)}”.</p>`}
          ${f.err ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${esc(f.err)}</span></div>` : ''}`,
        footStart: btn('Back', { v: 'ghost', icon: 'arrow-left', act: 'home-feat-back' }),
        foot: btn(n ? `Add ${plural(n, 'document')}` : 'Add documents', { v: 'primary', act: 'home-feat-add' }),
      };
    }
    const docs = featuredDocs();
    return {
      title: 'Featured on Home', desc: 'Shown to people in “Start here” and mixed into recommendations.',
      body: docs.length ? list(docs.map(d => item({ lead: fileIcon(d.type, 'sm'), title: esc(bare(d.name)), desc: esc(kbById(d.kb)?.name || ''), href: '/doc/' + d.id, trail: iconBtn('x', 'Remove from Home', { size: 'sm', act: 'home-feat-remove', data: { id: d.id } }) })), 'home-feat-list')
        : emptyState({ icon: 'sliders', title: 'Nothing featured yet', desc: 'Home shows the most-opened verified documents until you pick some.', compact: true }),
      foot: btn('Add documents', { v: 'primary', icon: 'plus', act: 'home-feat-adding' }),
    };
  };
  X.homeFeatured = () => { Object.assign(fui(), { adding: false, q: '', sel: {}, err: '' }); openDrawer('home-featured'); };
  A['home-featured'] = () => X.homeFeatured();
  A['home-feat-adding'] = () => { Object.assign(fui(), { adding: true, q: '', sel: {}, err: '' }); refreshLayer(); focusFirst('#layer .drawer__dialog'); };
  A['home-feat-back'] = () => { fui().adding = false; refreshLayer(); };
  A['home-feat-q'] = () => refreshLayer();
  A['home-feat-sel'] = el => { const f = fui(); f.sel[el.dataset.id] = !f.sel[el.dataset.id]; f.err = ''; refreshLayer(); };
  A['home-feat-add'] = () => {
    const f = fui(), ids = Object.keys(f.sel).filter(k => f.sel[k]);
    if (!ids.length) { f.err = 'Select at least one document to add.'; refreshLayer(); return; }
    ids.reverse().forEach(id => { if (!isFeatured(id)) toggleFeatured(id); });
    Object.assign(f, { adding: false, sel: {}, q: '', err: '' }); refresh();
    toast(`${plural(ids.length, 'document')} added to Home`, { action: { label: 'Undo', run: () => { ids.forEach(id => isFeatured(id) && toggleFeatured(id)); refresh(); } } });
  };
  A['home-feat-remove'] = el => {
    const id = el.dataset.id, l = featuredIds(), at = l.indexOf(id), d = docById(id); if (at < 0) return;
    l.splice(at, 1); persist(); refresh();
    toast(`Removed “${bare(d?.name)}” from Home`, { action: { label: 'Undo', run: () => { if (!featuredIds().includes(id)) featuredIds().splice(Math.min(at, featuredIds().length), 0, id); persist(); refresh(); } } });
  };
})();

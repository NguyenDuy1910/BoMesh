/* Home (/home): the knowledge-first start page in every workspace. It shows
   what this workspace knows before asking anything of you: search & ask,
   explore topics / knowledge bases / collections, featured documents (with
   real first-page thumbnails), recently published and recommended reading,
   then — quietly — where you left off. Not a dashboard, not a second Browse.
   Shared: X.upNext({space?, limit?, queue?}), X.upNextList(items, {empty?, space?}),
   X.docCard(d, {reason?}) and X.docThumb(d). Menu: home-featured. Prefix: home-. */
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

  /* ═══════════════ Document card + thumbnail (shared) ═══════════════ */
  const bare = n => String(n || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  /** "ADR-027" for coded titles ("ADR-027 — Event-driven ledger updates"), else the title, shortened. */
  function shortName(d) {
    const n = bare(d.name), code = n.match(/^([A-Z][A-Z0-9]*-?\d+[A-Z0-9-]*)\s+[—–-]\s+/);
    if (code) return code[1];
    return n.length > 42 ? n.slice(0, 40).trimEnd() + '…' : n;
  }
  const isVerified = d => trustOf(d).state === 'verified';
  const isShared = d => !kbById(d.kb)?.personal;
  const FMT_TONE = { pdf: 'danger', word: 'accent', sheet: 'success', slides: 'warning' };
  /** First page of a document's rendition, cached per version. Ids are dropped so several thumbnails can share a page. */
  const pageCache = new Map();
  function firstPage(d) {
    if (!X.docModel || !isSearchable(d)) return null;
    const key = [S.ws, d.id, d.updated, d.status, d.name].join('|');
    if (!pageCache.has(key)) {
      const p = X.docModel(d)?.pages?.[0];
      pageCache.set(key, p ? { cls: p.cls || '', html: p.html.replace(/\sid="[^"]*"/g, '') } : null);
    }
    return pageCache.get(key);
  }
  /** Thumbnail: the real first page, scaled down (slides, sheets and policies look like themselves); otherwise a tinted type tile. Decorative. */
  function docThumb(d) {
    const p = firstPage(d);
    if (p) {
      const slide = /doc-page--slide/.test(p.cls);
      return `<div class="${cx('doc-thumb', slide && 'doc-thumb--slide')}" aria-hidden="true" inert><div class="doc-thumb__page"><div class="${cx('doc-page', p.cls)}">${p.html}</div></div></div>`;
    }
    const k = kindMeta(res(d).kind), tone = FMT_TONE[formatOf(d)[0]] || 'default';
    return `<div class="doc-thumb doc-thumb--blank doc-thumb--${tone}" aria-hidden="true">${fileIcon(d.type, 'lg')}<span class="doc-thumb__title">${esc(bare(d.name))}</span><span class="doc-thumb__kind">${ic(k.icon, 'i-xs')}${esc(k.label)}</span></div>`;
  }
  /** Document card: thumbnail, type, title, topic and base, freshness and trust. The whole card opens the reader; Save stays its own control. */
  function docCard(d, { reason = '' } = {}) {
    const r = res(d), topic = r.topics[0], rendered = !!firstPage(d);
    const where = [topic && topicName(topic), r.kb?.name].filter(Boolean).map(esc).join('<span class="res-dot" aria-hidden="true">·</span>');
    return `<article class="doc-card">
      <div class="doc-card__media">${docThumb(d)}${rendered ? `<span class="doc-card__type">${fileIcon(d.type, 'sm')}</span>` : ''}</div>
      <div class="doc-card__body">
        <div class="doc-card__top">${X.res.kindChip(d)}<span class="grow"></span>${X.res.saveBtn(d)}</div>
        <h3 class="doc-card__title"><a class="doc-card__link" href="#/doc/${esc(d.id)}" title="${esc(d.name)}">${esc(bare(d.name))}</a></h3>
        ${where ? `<p class="doc-card__where">${where}</p>` : ''}
        ${reason ? `<p class="doc-card__reason">${esc(reason)}</p>` : ''}
        <div class="doc-card__foot"><span class="doc-card__when" title="${esc(fmtDateTime(d.updated))}">Updated ${esc(rel(d.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase()))}</span>${isVerified(d) ? X.res.trustChip(d) : ''}</div>
      </div>
    </article>`;
  }
  X.docThumb = docThumb;
  X.docCard = docCard;

  /* ═══════════════ Home ═══════════════ */
  const callName = n => { const p = String(n || '').trim().split(/\s+/); return p.length >= 3 ? p[p.length - 1] : p[0]; };
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  /** Enter asks when the text reads like a question, otherwise it searches. */
  const QUESTION = /^(how|what|when|where|why|who|which|can|could|do|does|did|is|are|should)\b/i;
  const isQuestion = q => /\?\s*$/.test(q) || QUESTION.test(q.trim());
  const hint = q => (q.trim() && isQuestion(q) ? `${kbd('Enter')}<span>to ask · answers cite their sources</span>` : `${kbd('Enter')}<span>to search · type a question to ask</span>`);

  /** Shared bases the caller can read (My files and locked bases excluded). */
  const readableBases = () => visibleKbs().filter(k => !k.personal && canReadKb(k));
  const publishedPool = () => catalogPool().filter(isShared);
  const starters = () => (D.assistant?.roleStarters?.[S.persona] || D.assistant?.starters || []).filter(s => s?.prompt).slice(0, 4);

  /* ── Hero: search & ask ── */
  function scopeSelect(f, kbs, sps) {
    if (!kbs.length && !sps.length) return '';
    const opt = (v, l) => `<option value="${esc(v)}" ${v === f.scope ? 'selected' : ''}>${esc(l)}</option>`;
    const group = (label, opts) => (opts.length ? `<optgroup label="${esc(label)}">${opts.join('')}</optgroup>` : '');
    return `<select class="select select--sm home-box__scope" id="home-scope" data-bind="home.scope" aria-label="Search and answer from">${opt('', `All of ${curWs().name}`)}${group('Knowledge bases', kbs.map(k => opt('kb:' + k.id, k.name)))}${group('My spaces', sps.map(s => opt('sp:' + s.id, s.name)))}</select>`;
  }
  function hero(f, lead) {
    const kbs = readableBases(), sps = hasModule('spaces') ? mySpaces() : [];
    const valid = !f.scope || (f.scope.startsWith('kb:') ? kbs.some(k => 'kb:' + k.id === f.scope) : sps.some(s => 'sp:' + s.id === f.scope));
    if (!valid) f.scope = '';
    const tries = starters();
    const suggest = tries.length ? `<div class="home-suggest" role="group" aria-label="Suggested questions"><span class="home-suggest__label">Try</span>${tries.map(s => `<button type="button" class="home-suggest__chip" data-act="home-suggest" data-q="${esc(s.prompt)}" title="${esc(s.prompt)}"><span class="truncate">${esc(s.prompt)}</span></button>`).join('')}</div>` : '';
    return `<section class="home-hero" aria-labelledby="home-title">
      <h1 class="home-title" id="home-title">${esc(greeting())}, ${esc(callName(me().name))}</h1>
      ${lead}
      <div class="home-box" role="search">
        ${ic('search', 'home-box__icon')}
        ${input({ id: 'home-q', bind: 'home.q', value: f.q, type: 'search', placeholder: 'Ask a question or search documents', onEnter: 'home-go', cls: 'home-box__input', autofocus: true, attrs: 'data-input="home-type" aria-label="Search or ask" aria-describedby="home-hint" enterkeyhint="go"' })}
        <div class="home-box__end">${scopeSelect(f, kbs, sps)}${btn('Search', { act: 'home-search', cls: 'home-box__search' })}${btn('Ask', { v: 'primary', icon: 'sparkles', act: 'home-ask' })}</div>
      </div>
      <p class="home-hint" id="home-hint">${hint(f.q || '')}</p>
      ${suggest}
    </section>`;
  }

  /* ── Explore knowledge: topics · knowledge bases · collections ── */
  const HEX = /^#[0-9a-f]{3,8}$/i;
  const toneStyle = c => (HEX.test(c || '') ? `style="--tone:${c}"` : '');
  function topicCard(dm, counts) {
    const n = counts.get(dm.id) || 0;
    const kids = dm.children.map(t => [t, counts.get(t.id) || 0]).filter(([, c]) => c).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const chips = kids.map(([t, c]) => `<a class="home-chip" href="#${catalogHref({ filters: { topic: [t.id] } })}" aria-label="${esc(t.name)}, ${plural(c, 'document')}"><span class="truncate">${esc(t.name)}</span><span class="home-chip__n">${fmtNum(c)}</span></a>`).join('');
    return `<article class="home-card home-topic" ${toneStyle(dm.color)}>
      <div class="home-card__head"><span class="home-tile" aria-hidden="true">${ic(dm.icon || 'tag')}</span>
        <div class="home-card__titles"><h3 class="home-card__name"><a class="home-card__link" href="#${catalogHref({ filters: { topic: [dm.id] } })}">${esc(dm.name)}</a></h3><span class="home-card__count">${plural(n, 'document')}</span></div></div>
      ${dm.desc ? `<p class="home-card__desc">${esc(dm.desc)}</p>` : ''}
      ${chips ? `<div class="home-chips">${chips}</div>` : ''}
    </article>`;
  }
  function kbCard(k, counts) {
    const locked = !canReadKb(k), n = counts.get(k.id) || 0, acc = X.kbAccess ? X.kbAccess(k) : { icon: 'globe', label: '' };
    const pending = locked && (D.requests || []).some(r => r.kb === k.id && r.user === me().id && r.status === 'pending');
    const name = locked ? esc(k.name) : `<a class="home-card__link" href="#${catalogHref({ filters: { kb: [k.id] } })}">${esc(k.name)}</a>`;
    const foot = locked
      ? (pending ? chip('Access requested', { tone: 'warning', icon: 'clock', size: 'sm' }) : btn('Request access', { size: 'sm', icon: 'lock', act: 'kb-request', data: { kb: k.id }, cls: 'home-card__act' }))
      : `<span class="home-card__count">${plural(n, 'document')}</span>${acc.label ? chip(acc.label, { icon: acc.icon, size: 'sm' }) : ''}`;
    const unit = ownerOfKb(k);
    return `<article class="${cx('home-card home-kb', locked && 'is-locked')}">
      <div class="home-card__head">${X.kbMark ? X.kbMark(k, 40, locked) : itemIcon(locked ? 'lock' : 'book')}
        <div class="home-card__titles"><h3 class="home-card__name">${name}</h3>${unit ? `<span class="home-card__sub truncate">${esc(unit)}</span>` : ''}</div></div>
      ${k.desc ? `<p class="home-card__desc">${esc(k.desc)}</p>` : ''}
      <div class="home-card__foot">${foot}</div>
    </article>`;
  }
  function colCard(c) {
    const items = collectionItems(c), s = shareLabel(c);
    return `<article class="home-card home-col">
      <div class="home-card__head"><span class="home-tile home-tile--plain" aria-hidden="true">${ic('layers')}</span>
        <div class="home-card__titles"><h3 class="home-card__name"><a class="home-card__link" href="#/knowledge/collections/${esc(c.id)}">${esc(c.name)}</a></h3><span class="home-card__count">${plural(items.ok.length, 'document')}</span></div></div>
      ${c.desc ? `<p class="home-card__desc">${esc(c.desc)}</p>` : ''}
      <div class="home-card__foot"><span class="home-card__share">${ic(s.icon, 'i-xs')}<span class="truncate">${esc(s.label)}</span></span>${c.featured ? chip('Featured', { size: 'sm', tone: 'accent' }) : ''}</div>
    </article>`;
  }
  /** Featured and shared collections (private ones live in My library). */
  const sharedCollections = () => visibleCollections().filter(c => c.share !== 'private' || c.featured).sort((a, b) => !!b.featured - !!a.featured || b.updated - a.updated);
  function exploreSection(f, facets) {
    const tree = topicTree(), counts = new Map([...(facets.topic || []), ...(facets.kb || [])].map(o => [o.value, o.count]));
    const domains = tree.filter(dm => counts.get(dm.id));
    const tabs = [domains.length && ['topics', 'Topics'], ['bases', 'Knowledge bases'], ['collections', 'Collections']].filter(Boolean);
    const view = tabs.some(t => t[0] === f.explore) ? f.explore : tabs[0][0];
    let body, link;
    if (view === 'topics') {
      body = `<div class="home-grid3">${domains.map(dm => topicCard(dm, counts)).join('')}</div>`;
      link = linkBtn('Browse all', { href: catalogHref({}), icon: 'arrow-right' });
    } else if (view === 'bases') {
      const kbs = visibleKbs().filter(k => !k.personal).sort((a, b) => canReadKb(b) - canReadKb(a) || (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
      body = kbs.length ? `<div class="home-grid3">${kbs.map(k => kbCard(k, counts)).join('')}</div>` : emptyState({ icon: 'book', title: 'No knowledge bases shared with you', compact: true, boxed: true });
      link = linkBtn('All knowledge bases', { href: '/knowledge/bases', icon: 'arrow-right' });
    } else {
      const cols = sharedCollections().slice(0, 6);
      body = cols.length ? `<div class="home-grid3">${cols.map(colCard).join('')}</div>`
        : emptyState({ icon: 'layers', title: 'No shared collections yet', desc: 'Collections are reading lists anyone can follow.', actions: btn('New collection', { size: 'sm', icon: 'plus', act: 'col-new' }), compact: true, boxed: true });
      link = linkBtn('Your collections', { href: '/knowledge/library?tab=collections', icon: 'arrow-right' });
    }
    const sw = seg({ value: view, options: tabs, act: 'home-explore', label: 'Explore by' });
    return `<section class="home-sec" aria-labelledby="home-explore-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-explore-h">Explore knowledge</h2>${sw}<span class="grow"></span>${link}</div>${body}</section>`;
  }

  /* ── Featured, recently published, recommended ── */
  /** Admin-picked documents first; when a row isn't full, it's topped up with the most-opened verified ones (rows of 4 on desktop, 2 on tablet). */
  function featured() {
    const picked = featuredResources(8).filter(isShared);
    const popular = publishedPool().filter(d => d.status === 'ready' && !d.dupOf && isVerified(d) && !picked.includes(d)).sort((a, b) => (b.views || 0) - (a.views || 0) || b.updated - a.updated);
    if (!picked.length) return { docs: popular.slice(0, 8), picked: false };
    const want = Math.min(8, Math.ceil(picked.length / 4) * 4);
    return { docs: [...picked, ...popular.slice(0, want - picked.length)], picked: true };
  }
  function featuredSection(ft) {
    if (!ft.docs.length) return '';
    const manage = isAdmin() ? btn('Manage', { v: 'ghost', size: 'sm', icon: 'sliders', menu: 'home-featured', tip: 'Feature documents from their ⋯ menu' }) : '';
    return `<section class="home-sec" aria-labelledby="home-feat-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-feat-h">${ft.picked ? 'Featured knowledge' : 'Popular and verified'}</h2><span class="grow"></span>${manage}</div>
      <div class="home-feat">${ft.docs.map(d => docCard(d)).join('')}</div></section>`;
  }
  /** Compact document row: type badge, title, one line of context, time. */
  function docRow(d, sub, meta = '') {
    return `<a class="home-row" href="#/doc/${esc(d.id)}">${fileIcon(d.type, 'sm')}<span class="home-row__body"><span class="home-row__title"><span class="truncate">${esc(bare(d.name))}</span>${isVerified(d) ? `<span class="home-row__ok" title="Verified">${ic('shield-check', 'i-xs')}<span class="sr-only">Verified</span></span>` : ''}</span><span class="home-row__sub truncate">${sub}</span></span>${meta ? `<span class="home-row__meta">${meta}</span>` : ''}</a>`;
  }
  /** For you: related to what you read, from your spaces, on the topics you save; never what you've already opened. */
  function recommendations(exclude, n = 5) {
    const read = new Set(recentResources(40).map(x => x.doc.id));
    const pool = publishedPool().filter(d => d.status === 'ready' && !d.dupOf && !read.has(d.id) && !exclude.has(d.id));
    const ok = new Map(pool.map(d => [d.id, d])), best = new Map();
    const bump = (d, score, reason) => {
      if (!ok.has(d.id)) return;
      const cur = best.get(d.id) || { doc: d, score: 0, top: -1, reason: '' };
      cur.score += score; if (score > cur.top) { cur.top = score; cur.reason = reason; }
      best.set(d.id, cur);
    };
    recentResources(5).forEach((x, i) => relatedResources(x.doc, 6).forEach((d, j) => bump(d, 6 - i - j * 0.5, `Because you read ${shortName(x.doc)}`)));
    const spaces = hasModule('spaces') ? mySpaces() : [];
    if (spaces.length) pool.forEach(d => { const ctx = res(d).contexts; spaces.forEach(sp => ctx.includes(sp.id) && bump(d, 2, `From ${sp.name}`)); });
    const savedTopics = new Set(savedResources().flatMap(d => res(d).topics));
    if (savedTopics.size) pool.forEach(d => { const t = res(d).topics.find(x => savedTopics.has(x)); if (t) bump(d, 1.5, `More on ${topicName(t)}`); });
    best.forEach(x => { if (isVerified(x.doc)) x.score += 0.5; });
    /* At most two per reason first, so one recent read doesn't fill the list. */
    const ranked = [...best.values()].sort((a, b) => b.score - a.score || b.doc.updated - a.doc.updated), per = new Map();
    const out = ranked.filter(x => { const k = (per.get(x.reason) || 0) + 1; per.set(x.reason, k); return k <= 2; }).slice(0, n);
    if (out.length < n) out.push(...ranked.filter(x => !out.includes(x)).slice(0, n - out.length));
    if (out.length < n) {
      const have = new Set(out.map(x => x.doc.id));
      pool.filter(d => !have.has(d.id) && isVerified(d)).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, n - out.length)
        .forEach(d => out.push({ doc: d, reason: `Often opened in ${curWs().name}` }));
    }
    return out;
  }
  function readingSection(ft) {
    const shown = new Set(ft.docs.map(d => d.id));
    const fresh = recentlyPublished(5 + shown.size).filter(d => isShared(d) && !shown.has(d.id)).slice(0, 5);
    fresh.forEach(d => shown.add(d.id));
    const recs = recommendations(shown);
    const fmtWhen = d => `<span title="Published ${esc(fmtDateTime(publishedAt(d)))}">${esc(rel(publishedAt(d)))}</span>`;
    const col = (id, title, rows, link, empty) => `<section class="home-sec home-sec--col" aria-labelledby="${id}"><div class="home-sec__head"><h2 class="home-sec__title" id="${id}">${title}</h2><span class="grow"></span>${link}</div><div class="home-list">${rows.length ? rows.join('') : `<p class="home-list__empty">${empty}</p>`}</div></section>`;
    return `<div class="home-cols">
      ${col('home-new-h', 'Recently published', fresh.map(d => docRow(d, `${esc(kindMeta(res(d).kind).label)} · ${esc(kbById(d.kb)?.name || '')}`, fmtWhen(d))), linkBtn('See all', { href: catalogHref({ sort: 'updated' }) }), 'Nothing new this month.')}
      ${col('home-rec-h', 'Recommended for you', recs.map(x => docRow(x.doc, `${ic('sparkles', 'i-xs')}${esc(x.reason)}`)), '', 'Open a few documents and we’ll suggest more like them.')}
    </div>`;
  }

  /* ── Continue (quiet, last) ── */
  function panel(title, body, link = '') {
    return `<section class="home-panel" aria-label="${esc(title)}"><div class="home-panel__head"><h3 class="home-panel__title">${esc(title)}</h3>${link}</div>${body}</section>`;
  }
  const quietEmpty = text => `<p class="home-list__empty">${esc(text)}</p>`;
  function continueSection() {
    const viewed = recentResources(4);
    const convs = [...myConvs()].sort((a, b) => b.at - a.at).slice(0, 3);
    const needs = d => lifecycleOf(d).key === 'changes';
    const contribs = myContributions().sort((a, b) => needs(b) - needs(a)).slice(0, 3);
    const reviews = canReview() ? reviewQueue().length : 0;
    const up = hasModule('spaces') || hasModule('requests') ? X.upNext({ limit: 3 }) : [];
    const convRow = c => {
      const sp = c.space && spaceById(c.space);
      return `<a class="home-row" href="#/chat/${esc(c.id)}"><span class="home-row__icon" aria-hidden="true">${ic('message', 'i-sm')}</span><span class="home-row__body"><span class="home-row__title"><span class="truncate">${esc(c.title)}</span></span><span class="home-row__sub truncate">${esc(sp ? sp.name : 'Conversation')}</span></span><span class="home-row__meta">${esc(rel(c.at))}</span></a>`;
    };
    const contribRow = d => `<a class="home-row" href="#/knowledge/library?tab=contributions&open=${esc(d.id)}">${fileIcon(d.type, 'sm')}<span class="home-row__body"><span class="home-row__title"><span class="truncate">${esc(bare(d.name))}</span></span><span class="home-row__sub truncate">${esc(kbById(d.kb)?.name || '')}</span></span><span class="home-row__meta">${lifeChip(d, 'sm')}</span></a>`;
    const panels = [
      panel('Recently viewed', viewed.length ? `<div class="home-list">${viewed.map(x => docRow(x.doc, esc(kbById(x.doc.kb)?.name || ''), esc(rel(x.at)))).join('')}</div>` : quietEmpty('Documents you open show up here.'), viewed.length ? linkBtn('History', { href: '/knowledge/library?tab=recent' }) : ''),
      panel('Conversations', convs.length ? `<div class="home-list">${convs.map(convRow).join('')}</div>` : quietEmpty('Your questions and answers show up here.'), convs.length ? linkBtn('All', { href: '/chats' }) : ''),
      contribs.length && panel('Your contributions', `<div class="home-list">${contribs.map(contribRow).join('')}</div>`, linkBtn('All', { href: '/knowledge/library?tab=contributions' })),
      up.length && panel('Up next', X.upNextList(up)),
    ].filter(Boolean);
    const review = reviews ? `<a class="home-review" href="#/documents?tab=review">${ic('inbox', 'i-sm')}<span class="home-review__text">${plural(reviews, 'document')} waiting for your review</span><span class="home-review__go">Review${ic('arrow-right', 'i-sm')}</span></a>` : '';
    return `<section class="home-sec home-sec--quiet" aria-labelledby="home-cont-h"><div class="home-sec__head"><h2 class="home-sec__title" id="home-cont-h">Pick up where you left off</h2></div>${review}<div class="home-panels">${panels.join('')}</div></section>`;
  }

  /* ── States ── */
  function loadingBody() {
    const card = `<div class="home-card home-skel" aria-hidden="true"><div class="home-card__head"><span class="skeleton home-skel__tile"></span><div class="home-card__titles"><span class="skeleton skeleton--line" style="width:60%"></span><span class="skeleton skeleton--line" style="width:35%;height:10px"></span></div></div><span class="skeleton skeleton--line" style="width:90%;height:10px"></span><div class="home-chips"><span class="skeleton home-skel__chip"></span><span class="skeleton home-skel__chip"></span><span class="skeleton home-skel__chip"></span></div></div>`;
    const doc = `<div class="doc-card home-skel" aria-hidden="true"><span class="skeleton home-skel__thumb"></span><div class="doc-card__body"><span class="skeleton skeleton--line" style="width:40%"></span><span class="skeleton skeleton--line" style="width:85%"></span><span class="skeleton skeleton--line" style="width:55%;height:10px"></span></div></div>`;
    const head = w => `<div class="home-sec__head"><span class="skeleton skeleton--title" style="width:${w}px"></span></div>`;
    return `<div aria-busy="true" aria-label="Loading">
      <section class="home-sec">${head(200)}<div class="home-grid3">${card.repeat(6)}</div></section>
      <section class="home-sec">${head(180)}<div class="home-feat">${doc.repeat(4)}</div></section>
      <div class="home-cols"><section class="home-sec">${head(160)}${skelRows(4)}</section><section class="home-sec">${head(180)}${skelRows(4)}</section></div>
    </div>`;
  }
  const emptyBody = () => `<section class="home-sec">${emptyState({
    icon: 'book', title: 'Your workspace has no published knowledge yet', boxed: true,
    desc: canContribute() ? 'Contribute documents for review. Published documents show up here.' : 'Documents show up here once they’re published.',
    actions: X.res.uploadBtn('primary') + btn('Browse', { href: '/knowledge' }),
  })}</section>`;

  P.home = () => {
    const f = ui('home', { q: '', scope: '', explore: '' });
    const live = S.pageState === 'live' && !S.navLoading;
    const pool = live ? publishedPool() : [];
    const kbN = readableBases().filter(k => pool.some(d => d.kb === k.id)).length;
    const lead = S.navLoading || S.pageState === 'loading'
      ? '<p class="home-lead"><span class="skeleton skeleton--line" style="width:min(420px,80%)"></span></p>'
      : live && pool.length ? `<p class="home-lead">Search or ask across ${plural(pool.length, 'published document')} in ${plural(kbN, 'knowledge base')}</p>` : '';
    const body = gate({
      loading: loadingBody,
      empty: emptyBody,
      error: () => `<section class="home-sec">${errorState()}</section>`,
      ok: () => {
        if (!pool.length) return emptyBody();
        const facets = catalogSearch(parseCatalogQuery({})).facets, ft = featured();
        return exploreSection(f, facets) + featuredSection(ft) + readingSection(ft) + continueSection();
      },
    });
    return `<div class="page home">${hero(f, lead)}${body}</div>`;
  };

  /* ── Actions ── */
  const scopeOf = () => { const s = ui('home').scope || ''; return s.startsWith('kb:') ? { kb: s.slice(3) } : s.startsWith('sp:') ? { space: s.slice(3) } : {}; };
  const typed = () => String(ui('home').q ?? $('#home-q')?.value ?? '').trim();
  function ask(q) {
    if (!q) { $('#home-q')?.focus(); toast('Type a question first', { tone: 'accent' }); return; }
    ui('home').q = '';
    if (A['chat-ask']) A['chat-ask']({ dataset: { q, ...scopeOf() } }); else go('/chat');
  }
  function search(q) {
    const s = scopeOf(); ui('home').q = '';
    go(catalogHref({ q, filters: s.kb ? { kb: [s.kb] } : s.space ? { space: [s.space] } : {} }));
  }
  A['home-ask'] = () => ask(typed());
  A['home-search'] = () => search(typed());
  A['home-go'] = () => { const q = typed(); if (q && isQuestion(q)) ask(q); else search(q); };
  A['home-type'] = el => { const h = $('#home-hint'); if (h) h.innerHTML = hint(el.value); };
  A['home-suggest'] = el => ask(el.dataset.q || '');
  A['home-explore'] = el => { ui('home').explore = el.dataset.value; refresh(); };
  A['home-request'] = el => {
    const type = el?.dataset?.type;
    if (A['rq-new']) A['rq-new']({ dataset: { type } }); else go('/requests/new' + (type ? '?type=' + type : ''));
  };
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
      { label: 'Feature from Browse (⋯ menu)', icon: 'search', run: () => go(catalogHref({})) },
    ];
  };
})();

'use strict';
/* Home (/home): where every member starts, and where a new one learns what the workspace is for.

   One column, read top to bottom:
   1. The greeting and the composer on the plain page (the page's single primary action), with the assistant's starters for
      the caller's group or role (Assistant settings), so a newcomer sees the questions people like them ask.
   2. Getting started (members in their first 30 days, until done or hidden) — or Jump back in (recent reads and chat) for everyone else.
      A new member's first visit, once Home has loaded, opens the welcome card: the product tour (chat.js) or Later.
   3. Picked for you: four documents, each with the reason it was picked (one of your role's questions, one of your spaces,
      more on what you read, most read).
   4. Explore by domain: the first classification scheme's top concepts (firstScheme(): Lĩnh vực on campus, Subject in
      enterprise) with what they hold, opening Knowledge filtered.
   What changed lately is not a section of its own: domains count what's new, and Knowledge sorts by Recently updated.
   Everything comes from what the caller can read (sharedPool) and the per-document insights: summary, concepts, trust, views,
   freshness. The full tree of collections is Knowledge › Map (features/atlas.js). Prefix: home-. */
(() => {
  const NEW_FOR = 30 * DAY;   // how long a member counts as new
  const FRESH = 30 * DAY;     // "{n} new" on domain cards
  const PICKS = 4, DOMAINS = 6;
  const ANSWERS_AT = 0.2;    // least share of a starter question's weighted words a document must cover to count as its answer

  const isNewMember = () => { const m = memberById(me().id); return !!m?.joined && NOW - m.joined < NEW_FOR; };
  const startHidden = () => !!D.gettingStarted?.[me().id];
  /** By display name: people have no separate given name, and which word is the given one depends on the name's order. */
  function greeting() {
    const h = new Date().getHours(), who = me().name;
    return h < 12 ? `Good morning, ${who}` : h < 18 ? `Good afternoon, ${who}` : `Good evening, ${who}`;
  }

  /* ═══════════════ Insights ═══════════════ */
  /** The document that best answers each question: the question's words weighted by how rare they are among the documents
      (title hits count double), so "học phí" outweighs "học". A document answers when it covers enough of the question —
      words no document uses count against it — so task-like starters ("what did students ask this week?") get no document. */
  function answersTo(pool, starters) {
    const bags = pool.map(d => ({ d, title: Object.fromEntries(tokens(docTitle(d)).map(t => [t, true])), body: Object.fromEntries(tokens(d.summary || '').map(t => [t, true])) }));
    const df = {};
    bags.forEach(b => Object.keys({ ...b.title, ...b.body }).forEach(t => { df[t] = (df[t] || 0) + 1; }));
    return starters.map(s => {
      const words = [...new Set(tokens(s.prompt))].map(t => ({ t, w: Math.log(1 + pool.length / (df[t] || 1)) }));
      const full = 2 * words.reduce((a, x) => a + x.w, 0);
      const top = bags.map(b => ({ d: b.d, s: words.reduce((a, x) => a + (b.title[x.t] ? 2 : b.body[x.t] ? 1 : 0) * x.w, 0) })).sort((a, b) => b.s - a.s)[0];
      return top && full && top.s / full >= ANSWERS_AT ? { d: top.d, starter: s } : null;
    }).filter(Boolean);
  }
  /** Four documents for the caller, each with why: one per starter question of their group or role, then their spaces,
      the concepts of what they read, then the most read in the domains those questions are about. Nothing already saved or opened.
      “About” is the first scheme (Lĩnh vực, Subject): the other schemes say what a document is or is for, not what it covers. */
  function picks(pool) {
    const seen = Object.fromEntries([...userList('saved'), ...userList('recent').map(x => x.doc)].map(id => [id, true]));
    const fresh = pool.filter(d => !seen[d.id]);
    const best = (list, score) => list.map(d => ({ d, s: score(d) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || (b.d.views || 0) - (a.d.views || 0)).map(x => x.d);
    const answered = answersTo(fresh, X.assistantStarters?.() || []);
    const asked = answered.map(({ d, starter }) => ({ d, why: { icon: 'message', label: starter.title, own: true, tip: starter.prompt } }));
    const spaces = Object.fromEntries(mySpaces().map(s => [s.id, s]));
    const inSpace = best(fresh, d => ((d.contexts || []).some(id => spaces[id]) ? 1 + d.updated / NOW : 0))
      .map(d => ({ d, why: { icon: 'layers', label: `In ${spaces[d.contexts.find(id => spaces[id])].name}` } }));
    const first = firstScheme()?.id, about = d => resConcepts(d).filter(id => conceptById(id).scheme === first);
    const readConcepts = {};
    userList('recent').forEach(x => { const d = docById(x.doc); if (d && canOpenRes(d)) about(d).forEach(c => { readConcepts[c] = (readConcepts[c] || 0) + 1; }); });
    const related = best(fresh, d => about(d).reduce((a, c) => a + (readConcepts[c] || 0), 0))
      .map(d => ({ d, why: { icon: 'tag', label: `More on ${conceptName(about(d).find(c => readConcepts[c]))}` } }));
    // The top concepts of the role's questions (and of what the caller read) say what's relevant to them; the most read comes from there.
    const near = {};
    [...answered.map(x => about(x.d)), Object.keys(readConcepts)].forEach(ids => ids.forEach(c => { near[conceptTop(c)] = true; }));
    const anyNear = Object.keys(near).length > 0;
    const popular = best(fresh, d => (!anyNear || about(d).some(c => near[conceptTop(c)]) ? 1 + (d.views || 0) : 0)).map(d => ({ d, why: { icon: 'eye', label: 'Most read' } }));
    const out = [];
    [inSpace[0], asked[0], related[0], asked[1], asked[2], inSpace[1], related[1], ...popular].forEach(p => {
      if (p && out.length < PICKS && !out.some(x => x.d.id === p.d.id)) out.push(p);
    });
    return out;
  }
  /** The first scheme's top concepts that hold readable documents, largest first: count (narrower concepts included, each
      document once), new this month, their three biggest narrower concepts. */
  function domains(pool) {
    const s = firstScheme(); if (!s) return [];
    const mine = new Map(pool.map(d => [d.id, new Set(resConcepts(d))]));
    const under = id => { const ids = [id, ...descendantsOf(id)]; return pool.filter(d => ids.some(x => mine.get(d.id).has(x))); };
    return topConcepts(s.id).map(c => {
      const docs = under(c.id);
      const top = narrowerOf(c.id).map(k => ({ c: k, n: under(k.id).length })).filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 3);
      return { c, n: docs.length, fresh: docs.filter(d => NOW - d.updated < FRESH).length, top };
    }).filter(x => x.n).sort((a, b) => b.n - a.n);
  }

  /* ═══════════════ Pieces ═══════════════ */
  const verified = d => (trustOf(d).state === 'verified' ? `<span class="doc-card__ok" data-tip="${esc(trustOf(d).note || 'Verified')}">${ic('shield-check', 'i-sm')}<span class="sr-only">Verified</span></span>` : '');

  /** The page's one primary action, on the plain page (no hero box): greeting, then the product's one composer — the same
      component and draft that start every conversation (attach, "Search in", send; chat.js) — and its suggestions as short
      labels. Files dropped anywhere on it attach to the question. */
  function hero() {
    const ws = curWs(), isNew = isNewMember();
    const c = X.chat.composer('home');
    const placeholder = c.scope.length || c.space ? '' : D.assistant?.welcome || '';
    return `<header class="home-hero chat-drop" data-drop="home">
      <h1 class="home-hero__title">${esc(isNew ? `Welcome, ${me().name}` : greeting())}</h1>
      ${isNew ? `<p class="home-hero__lead">${esc(`This is where ${ws.name} keeps its knowledge. Ask anything to get started.`)}</p>` : ''}
      <div class="home-ask" id="home-ask">${X.chat.composerHtml({ key: 'home', holder: c, lg: true, placeholder })}${X.chat.suggestions(c)}</div>
    </header>`;
  }

  /** New members: three steps, each done by doing it for real (a question asked, a document opened, one saved), each with
      one button while it's open: Ask focuses the box, Open opens the first pick (Browse opens Knowledge when there are no
      picks), Find one opens it too and says where Save is. Once all three are done it says so, until the member hides it;
      then Jump back in takes its place. */
  function gettingStarted(first) {
    if (!isNewMember() || startHidden()) return '';
    const steps = [
      { done: myConvs().some(c => c.messages?.length), title: 'Ask your first question', desc: 'Every answer shows the documents it comes from.', action: btn('Ask', { size: 'sm', act: 'home-ask-focus' }) },
      { done: userList('recent').length > 0, title: 'Open a document', desc: first ? docTitle(first) : 'Find one in Knowledge.', own: !!first, action: first ? btn('Open', { size: 'sm', href: '/doc/' + first.id }) : btn('Browse', { size: 'sm', href: '/knowledge' }) },
      { done: userList('saved').length > 0, title: 'Save one you’ll need again', desc: 'Select the bookmark on a document. Saved ones stay in Knowledge › Saved.', action: btn('Find one', { size: 'sm', act: 'home-start-save', data: first ? { id: first.id } : {} }) },
    ];
    const done = steps.filter(s => s.done).length;
    if (done === steps.length) {
      return `<section class="home-start home-start--done" aria-labelledby="home-start-title">
        <div class="home-start__head">
          <span class="home-start__ok" aria-hidden="true">${ic('check', 'i-sm')}</span>
          <div class="grow"><h2 class="home-start__title" id="home-start-title">You’re all set</h2><p class="home-start__desc">You’ve asked, read and saved. Hide this to see where you left off.</p></div>
          ${btn('Hide', { size: 'sm', act: 'home-start-hide' })}
        </div>
      </section>`;
    }
    return `<section class="home-start" aria-labelledby="home-start-title">
      <div class="home-start__head">
        <div class="grow"><h2 class="home-start__title" id="home-start-title">Getting started</h2><p class="home-start__desc"><span>${esc(`${done} of ${steps.length} done`)}</span><span class="res-dot" aria-hidden="true">·</span>${linkBtn('Take the tour', { act: 'home-tour' })}</p></div>
        <div class="progress-bar home-start__bar" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}" aria-label="Getting started"><span class="progress-bar__fill" style="width:${Math.round((done / steps.length) * 100)}%"></span></div>
        ${iconBtn('x', 'Hide getting started', { size: 'sm', act: 'home-start-hide' })}
      </div>
      <ol class="home-start__steps">${steps.map((s, i) => `<li class="${cx('home-step', s.done && 'is-done')}">
        <span class="home-step__mark" aria-hidden="true">${s.done ? ic('check', 'i-sm') : i + 1}</span>
        <div class="home-step__body"><h3 class="home-step__title">${esc(s.title)}${s.done ? '<span class="sr-only"> (done)</span>' : ''}</h3><p class="home-step__desc"${s.own ? ' translate="no"' : ''}>${esc(s.desc)}</p></div>
        ${s.done ? '' : s.action}
      </li>`).join('')}</ol>
    </section>`;
  }

  /** Everyone else: where they left off — their latest conversation and the last documents they opened, as small covered tiles. */
  function jumpBack() {
    const conv = myConvs().find(c => c.messages?.length);
    const docs = recentResources(conv ? 3 : 4);
    if (!conv && !docs.length) return '';
    const tile = (href, thumb, title, at) => `<a class="home-recent" href="#${href}"><span class="home-recent__thumb">${thumb}</span><span class="home-recent__text"><span class="home-recent__title" translate="no">${esc(title)}</span><span class="home-recent__when">${esc(rel(at))}</span></span></a>`;
    return `<section class="home-section" aria-labelledby="home-recent-title">
      <div class="home-section__head"><h2 class="home-section__title" id="home-recent-title">Jump back in</h2></div>
      <div class="home-recent__grid">${conv ? tile('/chat/' + conv.id, `<span class="home-recent__chat">${ic('message')}</span>`, conv.title, conv.at) : ''}${docs.map(x => tile('/doc/' + x.doc.id, X.res.thumb(x.doc), docTitle(x.doc), x.at)).join('')}</div>
    </section>`;
  }

  /** Browse's document card (cover, title, summary, where, age, trust) with the reason it was picked over its cover. */
  function pickCard({ d, why }) {
    return `<article class="doc-card home-pick" role="button" tabindex="0" data-act="res-open" data-id="${esc(d.id)}">
      <div class="doc-card__media">${X.res.thumb(d)}
        <span class="home-pick__why"${why.tip ? ` data-tip="${esc(why.tip)}"` : ''}>${ic(why.icon, 'i-sm')}<span class="truncate"${why.own ? ' translate="no"' : ''}>${esc(why.label)}</span></span>
        <div class="doc-card__actions">${X.res.saveBtn(d)}</div></div>
      <div class="doc-card__body">
        <div class="doc-card__head">${fileIcon(d.type, 'sm')}<h3 class="doc-card__title" translate="no">${esc(docTitle(d))}</h3></div>
        ${d.summary ? `<p class="doc-card__about" translate="no">${esc(d.summary)}</p>` : ''}
        <div class="doc-card__meta"><span class="doc-card__where truncate" translate="no">${esc(kbById(d.kb)?.name || '')}</span><span class="doc-card__when">${esc(rel(d.updated))}</span>${verified(d)}</div>
      </div>
    </article>`;
  }

  /** A top concept of the first scheme: its icon in its color (conceptLook), name, count, what's new, its definition and its
      biggest narrower concepts — each opening Browse filtered to it (conceptHref). */
  function domainCard({ c, n, fresh, top }) {
    const l = conceptLook(c.id);
    return `<article class="home-domain"${l.style}>
      <div class="home-domain__head">
        <span class="home-domain__icon" aria-hidden="true">${ic(l.icon)}</span>
        <div class="home-domain__titles">
          <h3 class="home-domain__name"><a class="home-domain__link" href="#${conceptHref(c.id)}" translate="no">${esc(conceptName(c.id))}</a></h3>
          <p class="home-domain__meta"><span>${plural(n, 'document')}</span>${fresh ? `<span class="res-dot" aria-hidden="true">·</span><span class="home-domain__new">${esc(`${fresh} new`)}</span>` : ''}</p>
        </div>
      </div>
      ${c.definition ? `<p class="home-domain__desc" translate="no">${esc(c.definition)}</p>` : ''}
      ${top.length ? `<div class="home-domain__concepts">${top.map(x => `<a class="home-concept" href="#${conceptHref(x.c.id)}" translate="no">${esc(conceptName(x.c.id))}</a>`).join('')}</div>` : ''}
    </article>`;
  }

  /* ═══════════════ States ═══════════════ */
  const loadingBody = () => `<div class="home-skel" aria-busy="true" aria-label="Loading">
    <div class="home-picks__grid">${[0, 1, 2, 3].map(() => '<span class="skeleton home-skel__card"></span>').join('')}</div>
    <div class="home-domains__grid">${[0, 1, 2].map(() => '<span class="skeleton home-skel__card home-skel__card--short"></span>').join('')}</div>
  </div>`;
  const emptyBody = () => emptyState({
    icon: 'book', title: 'Your workspace has no published knowledge yet', boxed: true,
    desc: canContribute() ? 'Contribute documents for review. Once they’re published, Home shows what’s here and what to read first.' : 'Home fills in as documents are published. You can still ask the assistant.',
    actions: canContribute() ? X.res.uploadBtn('primary') : '',
  });

  /* ═══════════════ Page ═══════════════ */
  let entered = null;   // the route visit Home last drew: sections rise in once per visit, not on every re-render (saving, typing)
  P.home = () => {
    const state = S.navLoading ? 'loading' : S.pageState;
    const pool = state === 'live' ? sharedPool() : [];
    const doms = domains(pool);
    const body = gate({
      loading: loadingBody,
      empty: emptyBody,
      error: () => errorState(),
      ok: () => {
        if (!pool.length) return emptyBody();
        const mine = picks(pool);
        const allDomains = doms.length > DOMAINS ? linkBtn(`All ${doms.length} domains`, { href: '/knowledge', icon: 'arrow-right' }) : linkBtn('Browse knowledge', { href: '/knowledge', icon: 'arrow-right' });
        return [
          gettingStarted(mine[0]?.d) || jumpBack(),
          mine.length ? `<section class="home-section home-picks" aria-labelledby="home-picks-title">
            <div class="home-section__head"><div class="grow"><h2 class="home-section__title" id="home-picks-title">Picked for you</h2><p class="home-section__desc">From your role’s questions, your spaces and what you read.</p></div></div>
            <div class="home-picks__grid">${mine.map(pickCard).join('')}</div>
          </section>` : '',
          doms.length ? `<section class="home-section home-domains" aria-labelledby="home-domains-title">
            <div class="home-section__head"><div class="grow"><h2 class="home-section__title" id="home-domains-title">Explore by domain</h2></div>${allDomains}</div>
            <div class="home-domains__grid">${doms.slice(0, DOMAINS).map(domainCard).join('')}</div>
          </section>` : '',
        ].filter(Boolean).join('');
      },
    });
    const entering = entered !== S.cur; entered = S.cur;
    return `<div class="${cx('page home', entering && state === 'live' && 'is-entering')}">${hero()}${body}</div>`;
  };
  /* The composer sizes itself to its draft (and takes focus when Home opens), as everywhere it appears; a new member's first
     visit then gets the welcome card. */
  AFTER.home = ({ changed }) => { X.chat.afterComposer(changed); setTimeout(welcomeMaybe); };

  /* ═══════════════ Welcome: a new member's first visit ═══════════════
     One onboarding entry, by choice. The first time a new member's Home has finished loading in a workspace (nothing else
     open), a welcome card offers the product tour (chat.js) or Later. It also confirms joining: joining shows no toast of its
     own when the card is due (X.home.welcomes). One way out: Later (or Escape) is an answer, remembered per person and
     workspace; Take a quick tour counts once the tour ends. Getting started's "Take the tour" and Help › Product tour bring the
     tour back any time. */
  const welcomes = () => isNewMember() && !X.tour.seen() && !X.tour.busy();
  function welcomeMaybe() {
    if (!S.signedIn || S.cur?.r.page !== 'home' || S.navLoading || !['live', 'empty'].includes(S.pageState)) return;
    if (S.modal || S.drawer || S.palette || S.menu || S.popover || !welcomes()) return;
    openModal('home-welcome', { steps: X.tour.count() });
  }
  M['home-welcome'] = ({ steps }) => ({
    title: `Welcome to ${curWs().name}`, icon: 'sparkles', size: 'sm', guard: true, noClose: true,
    desc: esc('Here you ask questions and get answers from the documents you can read, with their sources.'),
    footStart: `<span class="t-sm muted">${esc(plural(steps, 'step'))}</span>`,
    foot: btn('Later', { act: 'home-welcome-later' }) + btn('Take a quick tour', { v: 'primary', act: 'home-welcome-tour' }),
  });
  A['home-welcome-later'] = () => { X.tour.markSeen(); closeModal(); };
  A['home-welcome-tour'] = () => { closeModal(); X.startTour(); };
  /* Escape answers Later (an open menu or the palette takes it first). */
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || S.modal?.name !== 'home-welcome' || S.menu || S.palette || S.popover) return;
    e.preventDefault(); e.stopImmediatePropagation(); A['home-welcome-later']();
  }, true);
  X.home = { welcomes };

  /* ═══════════════ Actions ═══════════════ */
  A['home-ask-focus'] = () => { const t = $('#chat-input'); if (!t) return; t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.focus({ preventScroll: true }); };
  A['home-tour'] = () => X.startTour();
  /** Getting started › Find one: the first pick (its Save is at the top of the Reader), else Knowledge, saying where to save. */
  A['home-start-save'] = el => {
    if (el.dataset.id) { go('/doc/' + el.dataset.id); toast('Select Save to keep it in Knowledge › Saved.'); }
    else { go('/knowledge'); toast('Select the bookmark on a document to save it.'); }
  };
  A['home-start-hide'] = () => {
    const id = me().id;
    (D.gettingStarted ??= {})[id] = true; persist(); refresh();
    toast('Getting started hidden', { action: { label: 'Undo', run: () => { delete D.gettingStarted[id]; persist(); refresh(); } } });
  };
})();

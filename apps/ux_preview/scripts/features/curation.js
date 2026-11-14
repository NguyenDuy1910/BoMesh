/* Knowledge Studio (/studio) — Manage → Knowledge Studio: the one place knowledge is run. Its sections are sub-rows of
   Knowledge Studio in the sidebar, named after what they hold:
     daily work   Documents — every document, whatever its origin, in four views (page tabs): All (the registry: filter
                  by processing state, select documents and Process them — nothing is processed until someone asks),
                  Review (submissions and what a sync held back), Issues (what couldn't be processed, what changed at its
                  source, what a sync couldn't read) and Quality (re-verification, missing details, duplicates).
     setup        Collections (where documents live, who reads them) · Topics (what documents are about: the topic tree
                  and the suggestions the pipeline and reviewers make; features/masterdata.js, governance.js) · Sources
                  (what comes in, how often, how it's published; with the accounts it signs in with). The setup guide
                  (X.setupGuide) walks collections → topics → sources → first sync.
   Publication and processing are independent (core/lifecycle.js): a document can be published and not processed (people
   open it, search doesn't find it) or processed and unpublished (ready, hidden until someone publishes it).
   Sections show only to people who can use them (X.studioTabs). Scope: documents in the collections the caller owns
   (workspace admins own all) — curatedDocs(). Readers never see any of this. Every document row opens the same drawer
   (cur-doc).
   Exports: X.reviewQueues() (counts for Overview → Knowledge health), X.reviewNotices(), X.studioTabs(), X.studioBadge(),
   X.setupGuide(), X.setupNext(). Actions: cur-*, doc-view, topic-view. Menu: cur-row. Drawers: cur-doc, cur-compare.
   Modals: cur-decide, cur-process, rb-pii. Batch actions: rb-*. Model: core/lifecycle.js. */
(() => {
  'use strict';

  const BASE = '/studio';
  /** Who works documents (review, issues, processing): reviewers. Who keeps the topics: workspace admins. */
  const canWork = () => can('knowledge.manage') && canReview();
  /** [id, label, group, who may use it]. Setup is listed in the order it's done: where → what about → what comes in. */
  const TAB_DEFS = [
    ['documents', 'Documents', 'work', () => canWork()],
    ['collections', 'Collections', 'setup', () => canManageKbs()],
    ['topics', 'Topics', 'setup', () => canManageTaxonomy() || canWork()],
    ['sources', 'Sources', 'setup', () => can('source.manage')],
  ];
  /** Documents' views: [id, label, tone of its count]. Review and Issues keep documents from people; Quality never blocks. */
  const VIEWS = [['all', 'All', ''], ['review', 'Review', 'accent'], ['issues', 'Issues', 'danger'], ['quality', 'Quality', '']];
  const VIDS = VIEWS.map(v => v[0]);
  /** Topics' views: the tree (workspace admins) and the suggestions (everyone who works documents). */
  const TOPIC_VIEWS = [['topics', 'Topics'], ['suggestions', 'Suggestions']];
  const topicViews = () => TOPIC_VIEWS.filter(([id]) => id === 'suggestions' || canManageTaxonomy()).map(v => v[0]);
  const PARTS = [['reverify', 'Re-verification due'], ['details', 'Missing details'], ['duplicates', 'Possible duplicates']];
  const QK = 'curQ', PK = 'curProb', AK = 'curAll', PER = 25;
  const names = list => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${plural(list.length - 2, 'other')}`);
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const lifeKey = d => lifecycleOf(d).key;
  const isLocked = d => /password/i.test(d.error || '');
  const analyzing = d => d.ai?.status === 'analyzing';
  const flagsOf = d => aiOf(d).flags || [];
  const hasFlag = (d, type) => flagsOf(d).some(f => f.type === type);
  const srcKey = d => (d.source && d.source !== 'upload' ? d.source : 'upload');
  /** Where a document came from: its source, a person's contribution, or an editor's upload (the Origin column). */
  const originKey = d => (srcKey(d) !== 'upload' ? d.source : d.submission?.by ? 'contrib' : 'upload');
  const drafts = () => ui('curDraft');
  const tabsAllowed = () => TAB_DEFS.filter(t => t[3]()).map(t => t[0]);
  X.studioTabs = tabsAllowed;
  /** Broken sources and accounts (each root cause once): what the Sources tab counts. */
  const sourceProblems = () => (can('source.manage') ? (X.srcBadge?.() || 0) + (X.accBadge?.() || 0) : 0);
  /** Access requests a base owner decides here (workspace admins decide them in People). */
  const ownerRequests = () => (can('user.manage') ? 0 : pendingRequests().filter(r => kbRole(kbById(r.kb)) === 'owner').length);
  /** Documents that stopped: couldn't be processed, or changed at the source since they were. */
  const PROBLEM_KEYS = ['failed', 'update'];
  const problemDocs = () => curatedDocs().filter(d => PROBLEM_KEYS.includes(lifeKey(d)) || (stageOf(d) === 'unpublished' && ['failed', 'outdated'].includes(d.status)));
  /** Published or unpublished documents nobody has processed yet. */
  const notProcessed = () => curatedDocs().filter(d => ['published', 'unpublished'].includes(stageOf(d)) && processingOf(d) === 'pending');
  /** Decisions that keep documents from people (Review and Issues): what the sub-row and the Studio badge count. */
  const decisionCount = () => reviewQueue().length + openBatches().length + problemDocs().length;
  /** Items per view: entries to decide (a batch is one), issue rows plus the error classes syncs report, documents to keep
      right; and what isn't processed (Overview). */
  function counts() {
    const g = X.gov?.counts?.() || {};
    return {
      review: reviewQueue().length + openBatches().length,
      issues: problemDocs().length + backfillRuns().reduce((s, r) => s + (r.backfill.issues || []).length, 0),
      quality: (g.reverify || 0) + (g.details || 0) + (g.duplicates || 0),
      parts: { reverify: g.reverify || 0, details: g.details || 0, duplicates: g.duplicates || 0 },
      pending: notProcessed().length,
      suggestions: X.gov?.suggestionCount?.() || 0,
    };
  }
  /** For Overview → Knowledge health: counts per view, empty when the caller doesn't review. */
  X.reviewQueues = () => (canWork() ? counts() : {});
  /** The section the Studio opens on: what needs the caller first — decisions, then something broken, then the first one. */
  function landing() {
    const ok = tabsAllowed();
    if (ok.includes('documents') && decisionCount()) return 'documents';
    if (ok.includes('sources') && sourceProblems()) return 'sources';
    return ok[0] || 'documents';
  }
  const tabOf = query => (tabsAllowed().includes(query.tab) ? query.tab : landing());
  /** Documents' view: ?view=, else Review when ?sel= names a submission or batch, else Review while it has entries, else All. */
  function viewOf(query, c = counts()) {
    if (VIDS.includes(query.view)) return query.view;
    if (query.sel || c.review) return 'review';
    return 'all';
  }
  const topicViewOf = query => (topicViews().includes(query.view) ? query.view : topicViews()[0]);
  /** Quality's open list: ?part=, else the first with items. */
  function partOf(query, c = counts()) {
    return PARTS.some(([id]) => id === query.part) ? query.part : PARTS.find(([id]) => c.parts[id])?.[0] || 'reverify';
  }
  /** Old addresses (Review, Documents, Taxonomy, Knowledge flow and their queues, stages and segments) → the view that
      holds them now; null when the address is current. */
  function legacyOf(q) {
    const oldTab = ['flow', 'review', 'quality', 'details', 'duplicates', 'all', 'library', 'taxonomy', 'master'].includes(q.tab);
    if (!oldTab && !q.queue && !q.life && !q.stage && !q.seg && !q.mode) return null;
    const n = { ...q }; ['mode', 'queue', 'life', 'stage', 'seg'].forEach(k => delete n[k]);
    const queue = q.queue || q.seg || (['details', 'duplicates'].includes(q.tab) ? q.tab : '');
    const toSuggestions = ['confirm', 'classify'].includes(queue) || q.node === '__learn';
    if (['taxonomy', 'master'].includes(q.tab) || q.mode === 'rules' || toSuggestions) {
      n.tab = 'topics'; n.view = toSuggestions ? 'suggestions' : 'topics';
      if (q.node === '__learn') delete n.node;
      return n;
    }
    n.tab = 'documents';
    if (['reverify', 'details', 'duplicates', 'quality', 'upkeep'].includes(queue) || q.tab === 'quality' || (queue === 'review' && q.tab !== 'review')) { n.view = 'quality'; if (PARTS.some(([id]) => id === queue)) n.part = queue; else if (queue === 'review') n.part = 'reverify'; }
    else if (['problems', 'issues'].includes(queue) || q.life === 'attention' || q.stage === 'issue') n.view = 'issues';
    else if (['submissions', 'batches', 'publish'].includes(queue) || ['review', 'changes'].includes(q.life) || q.stage === 'decide' || q.tab === 'review' || q.mode === 'needs') n.view = 'review';
    else n.view = 'all';
    return n;
  }
  /** The sidebar badge counts what the landing section shows (Documents: decisions that keep documents from people). */
  X.studioBadge = () => {
    const l = landing();
    if (l === 'documents') return { n: decisionCount(), tone: 'accent' };
    if (l === 'sources') return { n: sourceProblems(), tone: 'danger' };
    return { n: ownerRequests(), tone: 'accent' };
  };
  const onDocs = () => S.cur?.r.page === 'studio' && tabOf(S.cur.query) === 'documents';
  const onReview = () => onDocs() && viewOf(S.cur.query) === 'review';
  /** What each section counts — only what waits on the caller: decisions, access requests, topic decisions, broken sources. */
  const tabCounts = () => ({
    documents: { count: canWork() ? decisionCount() : 0 },
    collections: { count: ownerRequests() },
    topics: { count: X.gov?.suggestionCount?.() || 0, tone: 'default' },
    sources: { count: sourceProblems(), tone: 'danger' },
  });
  /** The Studio's sections as sidebar sub-rows of Knowledge Studio (core/shell.js navItem), in the order of TAB_DEFS; the first
      setup section starts a new cluster. A base's page (/studio/collections/:id) belongs to Collections. */
  X.studioNav = () => {
    const cur = S.cur, here = cur?.r.page === 'studio' ? tabOf(cur.query) : cur?.r.page === 'kbDetail' ? 'collections' : '';
    const tc = tabCounts(), defs = TAB_DEFS.filter(t => t[3]());
    return defs.map(([id, label, group], i) => ({ id, label, to: studioHref(id), current: id === here, gap: i > 0 && defs[i - 1][2] !== group, ...tc[id] }));
  };

  /* ═══════════════ Badges and inbox ═══════════════ */
  X.reviewNotices = () => {
    if (!canWork()) return [];
    const out = [], q = reviewQueue();
    if (q.length) out.push({ id: 'cur-queue-' + q.length, icon: 'clock', tone: 'info', title: `${plural(q.length, 'document')} ${q.length === 1 ? 'is' : 'are'} waiting for your review`, body: names(q.map(d => d.name)), at: Math.max(...q.map(d => lastEvent(d).at)), to: docsHref('review'), cta: 'Review' });
    // Workspace admins already get one notice per base with failed publishes.
    if (!isAdmin()) reviewableKbs().forEach(kb => {
      const failed = curatedDocs().filter(d => d.kb === kb.id && lifeKey(d) === 'failed');
      if (failed.length) out.push({ id: `cur-failed-${kb.id}-${failed.length}`, icon: 'alert-circle', tone: 'warn', title: `${plural(failed.length, 'document')} in ${kb.name} couldn’t be published`, body: failed.map(d => d.name).join(', '), at: Math.max(...failed.map(d => d.updated)), to: docsHref('issues', { kb: kb.id }) });
    });
    return out;
  };

  /* ═══════════════ Setup guide ═══════════════ */
  /** The first-time order: where documents live, how they're classified, what comes in, then the first sync. */
  function setupSteps() {
    const kbs = D.kbs.filter(k => !k.archived && !k.personal), leaves = (D.topics || []).filter(t => t.parent && !t.archived);
    const keyed = leaves.filter(t => topicKeywords(t).length).length;
    const synced = D.sources.some(s => s.last?.at) || D.docs.some(d => d.source && d.source !== 'upload' && d.status === 'ready');
    return [
      { id: 'collections', done: kbs.length > 0, title: 'Create collections', desc: 'Where documents live and who can read them. Make one per access boundary — a team, a function, the whole company.', cta: 'New collection', act: 'kb-create' },
      { id: 'taxonomy', done: !!(D.masterImports || []).length || (leaves.length && keyed / leaves.length >= 0.8), title: 'Load your topics', desc: 'The domains and topics documents are filed under, with the words that recognise them. Import them before the first sync, so every document is classified when it’s processed.', cta: 'Import topics', act: 'md-import' },
      { id: 'sources', done: D.sources.length > 0, title: 'Add sources', desc: 'Pick the folders, the collection they land in, how often they sync and how documents are published.', cta: 'Add source', act: 'src-connect' },
      { id: 'sync', done: synced, title: 'Check the first sync', desc: 'Watch it read, classify, index and publish. Decide what it held back, confirm the topics it wasn’t sure of, then let the schedule take over.', cta: 'Open Sources', href: studioHref('sources') },
    ];
  }
  /** The full checklist, only for a workspace with nothing set up yet (Overview's empty state; force: the prototype's Empty
      state). Once anything is done, what's left is one row in Overview → Needs attention (X.setupNext) — never a block on the
      Studio's own pages, where each section's empty state and header action already lead. */
  X.setupGuide = ({ force = false } = {}) => {
    if (!isAdmin()) return '';
    const steps = setupSteps().map(s => (force ? { ...s, done: false } : s)), left = steps.filter(s => !s.done);
    if (!left.length || left.length < steps.length) return '';
    const next = left[0];
    const rows = steps.map((s, i) => {
      const now = s === next, action = now ? btn(s.cta, { v: 'secondary', size: 'sm', act: s.act, href: s.href }) : '';
      return `<li class="${cx('setup__step', now && 'is-next')}"><span class="setup__num" aria-hidden="true">${i + 1}</span>
        <div class="grow"><div class="setup__title">${esc(s.title)}</div><p class="setup__desc">${esc(s.desc)}</p></div>${action}</li>`;
    }).join('');
    return `<section class="setup card" aria-label="Set up knowledge"><div class="setup__head"><h2 class="setup__heading grow">Set up knowledge</h2></div><ol class="setup__steps">${rows}</ol></section>`;
  };
  /** The next unfinished setup step as an Overview attention item ({ title, desc, actions }), or null. Named by what's
      actually missing: topics without keywords can't classify anything, so that's the problem, not "load the rules". */
  X.setupNext = () => {
    if (!isAdmin()) return null;
    const steps = setupSteps(), left = steps.filter(s => !s.done);
    if (!left.length || left.length === steps.length) return null;
    const s = left[0], leaves = (D.topics || []).filter(t => t.parent && !t.archived), bare = leaves.filter(t => !topicKeywords(t).length && !topicSynonyms(t).length).length;
    if (s.id === 'taxonomy' && bare) return { icon: 'tag', title: `${plural(bare, 'topic')} without keywords`, desc: 'Documents aren’t filed under a topic until it has words to recognise it by.', actions: btn('Add keywords', { v: 'secondary', size: 'sm', href: topicsHref('topics', { show: 'bare' }) }) };
    return { icon: 'list', title: s.title, desc: s.desc, actions: btn(s.cta, { v: 'secondary', size: 'sm', act: s.act, href: s.href }) };
  };

  /* ═══════════════ Page ═══════════════ */
  /** The page's one primary action follows the section and view: Add documents (Documents; secondary in Review, where the
      decision bar is the primary), Import (Topics), New collection or Add source. */
  function headerAction(tab, view) {
    const upKb = S.ui[AK]?.kb;
    if (tab === 'topics') return canManageTaxonomy() && view === 'topics' ? btn('Import', { v: 'primary', icon: 'upload', act: 'md-import' }) : '';
    if (tab === 'documents' && canContribute()) return btn('Add documents', { v: view === 'review' ? 'secondary' : 'primary', icon: 'upload', act: 'contribute', data: upKb ? { kb: upKb } : undefined });
    if (tab === 'collections' && can('knowledge.manage')) return btn('New collection', { v: 'primary', icon: 'plus', act: 'kb-create' });
    if (tab === 'sources') return X.src?.addBtn?.() || '';
    return '';
  }
  const page = (head, body) => `<div class="page page--wide page--studio cur">${head}${body ?? skelRows(6)}</div>`;
  P.studio = ({ query }) => {
    const allowed = tabsAllowed();
    if (!allowed.length) return noAccessPage();
    const tab = tabOf(query), title = TAB_DEFS.find(t => t[0] === tab)[1], extra = X.res.demoChip();
    if (tab === 'documents') {
      const c = counts(), view = viewOf(query, c);
      const body = view === 'review' ? reviewView(query, c) : view === 'issues' ? issuesView(c) : view === 'quality' ? qualityView(query, c) : documentsTab(query);
      return page(pageHeader({ title, extra, actions: headerAction(tab, view) }), docTabs(view, c) + (view === 'all' || view === 'issues' ? processStrip() : '') + body);
    }
    if (tab === 'topics') {
      const view = topicViewOf(query), ok = topicViews(), n = X.gov?.suggestionCount?.() || 0;
      const nav = ok.length > 1 ? contextBar(tabs(TOPIC_VIEWS.filter(([id]) => ok.includes(id)).map(([id, label]) => ({ id, label, ...(id === 'suggestions' && n ? { count: n, tone: 'default' } : {}) })), view, BASE, { act: 'topic-view', label: 'Topics views' })) : '';
      return page(pageHeader({ title, extra, actions: headerAction(tab, view) }), nav + (view === 'topics' ? X.md?.tab?.({ query }) : X.gov?.suggestions?.()));
    }
    // The section's name is the title; the sidebar lists the sections under Knowledge Studio (X.studioNav).
    return page(pageHeader({ title, extra, actions: headerAction(tab) }), tab === 'collections' ? X.kb?.tab?.({ query }) : X.src?.tab?.({ query }));
  };
  const prevAfter = AFTER.studio;
  AFTER.studio = args => {
    prevAfter?.(args);
    // Old addresses the router doesn't rewrite land on the current one, so the view and Back agree.
    const q = legacyOf(args.query); if (!q) return;
    Object.keys(q).forEach(k => q[k] === '' && delete q[k]);
    history.replaceState(null, '', '#' + BASE + '?' + new URLSearchParams(q));
    S.cur.query = q;
  };
  A['topic-view'] = el => setQuery({ view: el.dataset.value, node: '', show: '' });

  /** Documents' four views (page tabs: views of one set of documents). Review and Issues count what keeps documents from
      people (accent, danger); Quality counts quietly; All carries no count. */
  function docTabs(view, c) {
    const items = VIEWS.map(([id, label, tone]) => ({ id, label, ...(id !== 'all' && c[id] ? { count: c[id], alert: !!tone, tone: tone || 'default' } : {}) }));
    return contextBar(tabs(items, view, BASE, { act: 'doc-view', label: 'Documents views' }));
  }
  A['doc-view'] = el => setQuery({ view: el.dataset.value, sel: '', part: '' });
  /** One row of filter pills with counts (a select on phones): [id, label, count, tone]. */
  function pillRow(items, cur, act, label) {
    const pill = ([id, l, n, tone]) => `<button type="button" class="${cx('rq__pill', n && tone && 'rq__pill--' + tone)}" aria-pressed="${id === cur}" data-act="${act}" data-value="${id}">${esc(l)}${n ? `<span class="rq__n num">${fmtNum(n)}</span>` : ''}</button>`;
    const opts = items.map(([id, l, n]) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(n ? `${l} · ${fmtNum(n)}` : l)}</option>`).join('');
    return `<div class="rq"><div class="rq__groups"><div class="rq__pills" role="group" aria-label="${esc(label)}">${items.map(pill).join('')}</div></div><select class="select select--sm rq__select" data-change="${act}" aria-label="${esc(label)}">${opts}</select></div>`;
  }
  /** A processing run in flight: how far it is, with Show them and Stop (a run left in flight by a reload picks up here). */
  function processStrip() {
    const r = X.resumeProcessRun?.(); if (!r) return '';
    const pct = Math.round((r.done + r.failed) / Math.max(1, r.total) * 100), c = r.context;
    const ctx = c?.topics?.length ? `Classifying against ${plural(c.topics.length, 'topic')} you chose${c.note ? ', with your context' : ''}` : c?.note ? 'Classifying with your context' : '';
    return `<div class="proc-strip" role="status">${spinner('sm')}<div class="proc-strip__main"><div class="proc-strip__text"><span class="medium">${esc(`Processing ${plural(r.total, 'document')}`)}</span><span class="muted">${esc(`${fmtNum(r.done)} processed${r.failed ? ` · ${fmtNum(r.failed)} failed` : ''} · ${pct}%`)}</span>${ctx ? `<span class="muted" data-tip="${esc(c.topics?.length ? c.topics.map(topicName).join(', ') : c.note)}">${esc(ctx)}</span>` : ''}</div>${progress(pct, '', 'Processing progress')}</div>
      ${btn('Show them', { v: 'ghost', size: 'sm', act: 'cur-show-processing' })}${btn('Stop', { v: 'ghost', size: 'sm', act: 'cur-stop-processing' })}</div>`;
  }
  A['cur-show-processing'] = () => setQuery({ view: 'all', processing: 'processing' });
  A['cur-stop-processing'] = () => { X.stopProcessRun?.(activeProcessRun()); toast('Stopped processing. What’s done stays processed; the rest is Not processed again.', { tone: 'accent' }); };
  /** A view that's done: say so, and point at the next view with something in it. */
  function viewDone(id, c) {
    const next = VIEWS.find(([v]) => v !== id && v !== 'all' && c[v]);
    const COPY = {
      review: ['Nothing to review', 'Submissions and what a sync held back show up here, one decision each.'],
      issues: ['No issues', 'Documents that couldn’t be processed, or changed at their source, show up here with their fix.'],
    };
    const [title, desc] = COPY[id] || COPY.review;
    const action = next ? btn(`Next: ${next[1]}`, { icon: 'arrow-right', act: 'doc-view', data: { value: next[0] } }) : btn('See all documents', { act: 'doc-view', data: { value: 'all' } });
    return emptyState({ icon: 'check-circle', tone: 'success', title, desc, actions: action, boxed: true });
  }

  /* ── Publish: what syncs held back (one decision per batch) and submissions, in one list ── */
  const FILTERS = [['all', 'All'], ['flagged', 'Flagged'], ['version', 'New versions'], ['sync', 'From sources']];
  const FILTER_FN = {
    all: () => true,
    flagged: d => flagsOf(d).length > 0,
    version: d => !!d.submission?.versionOf,
    sync: d => d.submission?.via === 'sync',
  };
  function queueRows() {
    const u = ui(QK, { q: '', f: 'all', kb: '', sel: {} }), all = reviewQueue();
    const fn = FILTER_FN[u.f] || FILTER_FN.all;
    const rows = all.filter(d => fn(d) && (!u.kb || d.kb === u.kb) && matchesQ(QK, d.name, contributorName(d), kbById(d.kb)?.name, d.submission?.note));
    return { all, rows, order: rows.map(d => d.id) };
  }
  /** Batches first (each one decision for many files a first sync held back, with a sample), then submissions, oldest first. */
  function publishRows() {
    const subs = queueRows(), batches = openBatches();
    return { subs, batches, order: [...batches.map(b => b.id), ...subs.order] };
  }
  /** The open entry: ?sel when it's in the list, else the first. */
  function currentId({ order }) { const s = S.cur?.query.sel; return order.includes(s) ? s : order[0] || ''; }
  /** The entry to open after deciding `skip`: the next one down, else the one above. */
  function nextEntry(skip) {
    const q = publishRows(), i = q.order.indexOf(currentId(q));
    return q.order.slice(i + 1).find(id => !skip.has(id)) || q.order.slice(0, Math.max(0, i)).reverse().find(id => !skip.has(id)) || '';
  }

  /** The reviewer's working copy of the pipeline's classification (reset when the document is classified again). `teach`:
      a changed topic is recorded for Topics → Suggestions (on unless the reviewer turns it off); `process`: process it on approval. */
  function draftOf(d) {
    const ai = aiOf(d); if (ai.status !== 'done') return null;
    let f = drafts()[d.id];
    if (!f || f.at !== ai.at) f = drafts()[d.id] = { at: ai.at, kind: ai.kind.value, topics: ai.topics.map(t => t.id), kb: d.kb, summary: ai.summary || '', asVersionOf: '', teach: true, process: true };
    return f;
  }
  const decisionOf = d => { const f = draftOf(d); return f ? { kind: f.kind, topics: [...f.topics], kb: f.kb, summary: f.summary.trim(), asVersionOf: f.asVersionOf || undefined, teach: f.teach, process: f.process !== false } : {}; };

  function confBadge(c, edited) {
    if (edited) return '<span class="cur-conf cur-conf--edited">Edited</span>';
    if (c == null) return '';
    const p = Math.round(c * 100);
    return `<span class="cur-conf cur-conf--${p >= 80 ? 'hi' : p >= 60 ? 'mid' : 'lo'}" data-tip="Assistant confidence">${p}%</span>`;
  }
  /** Blocking risks get a labelled chip (readable on touch); informational signals stay a small icon with a tooltip. */
  const FLAG_META = { duplicate: ['copy', 'Possible duplicate', 'warning', true], personal: ['shield', 'Personal data', 'danger', true], unreadable: ['alert-circle', 'Couldn’t be read', 'danger', true], version: ['history', 'New version', 'accent'], format: ['file', 'Can’t be searched', 'default'] };
  function flagIcons(d) {
    const ai = aiOf(d), flags = ai.flags || [];
    const meta = x => FLAG_META[x.type] || FLAG_META.format;
    const chips = flags.filter(x => meta(x)[3]).map(x => { const [icon, label, tone] = meta(x); return chip(label, { tone, icon, size: 'sm', tip: x.text }); });
    const icons = flags.filter(x => !meta(x)[3]).map(x => { const [icon, tip, tone] = meta(x); return `<span class="cur-flag cur-flag--${tone}" data-tip="${esc(tip)}" role="img" aria-label="${esc(tip)}">${ic(icon, 'i-xs')}</span>`; });
    if ((ai.proposed || []).some(id => proposalById(id)?.status === 'open')) icons.push(`<span class="cur-flag cur-flag--accent" data-tip="Suggests a new topic" role="img" aria-label="Suggests a new topic">${ic('tag', 'i-xs')}</span>`);
    return chips.join('') + icons.join('');
  }
  function queueItem(d, active) {
    const u = ui(QK), via = d.submission?.via === 'sync';
    const who = `${via ? appIcon(res(d).source.app, 'sm') : ''}<span class="truncate">${esc(contributorName(d))} · ${esc(relLow(lastEvent(d).at))}</span>`;
    return `<div class="${cx('cur-item', active && 'is-active')}" role="button" tabindex="0" data-act="cur-pick" data-id="${d.id}" ${active ? 'aria-current="true"' : ''}>
      <span class="cur-item__check">${checkbox({ checked: !!u.sel?.[d.id], act: 'sel-toggle', data: { ui: QK, id: d.id }, aria: 'Select ' + d.name })}</span>
      ${fileIcon(d.type)}
      <span class="cur-item__body">
        <span class="cur-item__title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</span>
        <span class="cur-item__meta">${who}</span>
        <span class="cur-item__meta"><span class="truncate">${esc(kbById(d.kb)?.name || '')}</span><span class="cur-item__flags">${analyzing(d) ? lifeChip(d, 'sm') : flagIcons(d)}</span></span>
      </span>
    </div>`;
  }
  /** Search and filters appear once the queue is long enough to need them (or one is in use); bulk actions once something is selected. */
  const MANY = 6;
  const queueKbs = all => [...new Set(all.map(d => d.kb))].map(kbById).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  /** A batch: one decision for many documents held back by a first sync, for one reason. */
  function batchItem(b, active) {
    const m = BATCH[b.reason], src = srcById(b.source);
    return `<div class="${cx('cur-item', 'rb-item', active && 'is-active')}" role="button" tabindex="0" data-act="cur-pick" data-id="${b.id}" ${active ? 'aria-current="true"' : ''}>
      ${itemIcon(m.icon, m.tone, 'sm')}
      <span class="cur-item__body">
        <span class="cur-item__title truncate">${esc(m.label)}</span>
        <span class="cur-item__meta"><span class="truncate">${esc(`${plural(b.n, 'document')} · ${src?.name || kbById(b.kb)?.name || ''}`)}</span></span>
      </span>
    </div>`;
  }
  /** The Publish list: what syncs held back (no selection — each batch is already one decision for many), then the
      submissions with their search, filter and selection. Labels only when both kinds are there. */
  function queuePanel({ subs, batches }, cur) {
    const { all, rows } = subs;
    const u = ui(QK), f = u.f || 'all', filtered = f !== 'all' || !!u.kb, long = all.length > MANY;
    const canFilter = filtered || queueKbs(all).length > 1 || FILTERS.some(([k]) => k !== 'all' && all.some(FILTER_FN[k]));
    const fLabel = [f !== 'all' && FILTERS.find(([k]) => k === f)?.[1], u.kb && kbById(u.kb)?.name].filter(Boolean).join(' · ');
    const filter = (long || filtered) && canFilter ? `<button type="button" class="${cx('filter-button', filtered && 'is-set')}" data-menu="cur-qfilter" aria-haspopup="menu" aria-expanded="false">${filtered ? '' : ic('filter')}<span class="truncate">${esc(fLabel || 'Filter')}</span>${ic('chevron-down')}</button>` : '';
    const search = long || u.q ? searchField({ uiKey: QK, placeholder: 'Search submissions' }) : '';
    const tools = search || filter ? `<div class="cur-queue__tools">${search}${filter ? `<div class="cur-queue__filters">${filter}</div>` : ''}</div>` : '';
    // With a selection, the floating bulk bar (queueBulk) carries the decisions; this row only offers Select all.
    const ids = rows.map(d => d.id), n = ids.filter(id => u.sel?.[id]).length;
    const selRow = n ? `<div class="cur-queue__sel">${checkbox({ checked: n === ids.length, indeterminate: n < ids.length, act: 'sel-all', data: { ui: QK, ids: ids.join(',') }, aria: 'Select all', label: n === ids.length ? 'All selected' : `Select all ${fmtNum(ids.length)}` })}</div>` : '';
    const both = batches.length && all.length, label = t => (both ? `<div class="cur-queue__label t-label">${esc(t)}</div>` : '');
    const held = batches.length ? label('Held back by a sync') + batches.map(b => batchItem(b, b.id === cur)).join('') : '';
    const items = rows.map(d => queueItem(d, d.id === cur)).join('');
    const subsHtml = all.length ? label('Submissions') + (items || `<div class="cur-queue__none">${noMatches(QK, ['f', 'kb'], 'submissions')}</div>`) : '';
    return `<div class="${cx('cur-queue', n && 'has-sel')}">${all.length ? tools + selRow : ''}<div class="cur-queue__list" id="cur-queue" data-keep-scroll role="list">${held}${subsHtml}</div></div>`;
  }
  /** The queue's bulk decisions, in the same floating bar Documents and the other queues use. */
  const queueBulk = () => bulkBar(QK, btn('Decline…', { v: 'ghost', size: 'sm', icon: 'x-circle', act: 'cur-bulk-decline' }) + btn('Approve & publish', { v: 'secondary', size: 'sm', icon: 'check', act: 'cur-bulk-approve' }));
  MENUS['cur-qfilter'] = () => {
    const u = ui(QK), all = reviewQueue(), f = u.f || 'all', kbs = queueKbs(all);
    const set = (k, v) => { u[k] = v; refresh(); };
    const show = FILTERS.filter(([k]) => k === 'all' || k === f || all.some(FILTER_FN[k]))
      .map(([k, l]) => ({ label: l, meta: fmtNum(all.filter(FILTER_FN[k]).length), checked: f === k, run: () => set('f', k) }));
    const bases = kbs.length > 1 || u.kb ? [{ section: 'Collection' }, { label: 'All collections', checked: !u.kb, run: () => set('kb', '') }, ...kbs.map(k => ({ label: k.name, checked: u.kb === k.id, run: () => set('kb', k.id) }))] : [];
    const clear = (u.f && u.f !== 'all') || u.kb ? [{ sep: true }, { label: 'Clear filters', icon: 'x', run: () => { u.f = ''; u.kb = ''; refresh(); } }] : [];
    return [{ section: 'Show' }, ...show, ...bases, ...clear];
  };

  /* ── Detail ── */
  function noteHtml(d) {
    const sub = d.submission || {}, last = lastEvent(d);
    const note = last.kind === 'resubmitted' && last.text ? last.text : sub.note;
    const asked = [...(sub.events || [])].reverse().find(e => e.kind === 'changes');
    return (note ? `<figure class="cur-note"><figcaption class="t-label">Note to reviewers</figcaption><blockquote>${esc(note)}</blockquote></figure>` : '')
      + (last.kind === 'resubmitted' && asked ? `<div class="cur-asked">${ic('pencil', 'i-xs')}<span>Resubmitted after ${esc(actorName(asked.by))} asked: “${esc(asked.text)}”</span></div>` : '');
  }
  /** Risks as compact rows inside the inspector: icon, what was found, its one action — never full-width alert cards. */
  function flagsHtml(d, f) {
    const row = (tone, icon, title, text, action = '', extra = '') => `<li class="cur-risk cur-risk--${tone}">${ic(icon, 'i-sm')}<div class="cur-risk__body"><div class="cur-risk__title">${esc(title)}</div>${text ? `<div class="cur-risk__text">${text}</div>` : ''}${extra}</div>${action}</li>`;
    const out = flagsOf(d).map(x => {
      const o = x.doc && docById(x.doc), seen = o && canSeeDoc(o);
      if (x.type === 'duplicate') {
        if (!seen) return row('warning', 'copy', 'Possible duplicate', 'It looks like a document you can’t open. Check with a workspace admin.');
        const on = f?.asVersionOf === o.id;
        const sw = f ? `<div class="cur-risk__switch">${switchRow({ title: 'Publish as a new version', desc: on ? `It becomes v${res(o).version + 1}. The current version stays published until you approve.` : 'Off: it’s published as a separate document.', on, act: 'cur-asver', data: { id: d.id, other: o.id } })}</div>` : '';
        return row('warning', 'copy', 'Possible duplicate', esc(`Looks like “${o.name}” (${Math.round((x.sim || 0) * 100)}% similar title).`), linkBtn('Compare', { act: 'cur-compare', data: { id: d.id, other: o.id } }), sw);
      }
      if (x.type === 'version') return seen ? row('accent', 'history', `Replaces v${res(o).version} of “${o.name}”`, 'The current version stays published until you approve.', linkBtn('Open current', { href: '/doc/' + o.id })) : '';
      if (x.type === 'personal') return row('danger', 'shield', 'May contain personal data', 'Names, grades or ID numbers shouldn’t be shared. Check before publishing.');
      if (x.type === 'format') return row('default', 'file', 'Can’t be searched', esc(x.text));
      if (x.type === 'unreadable') return row('danger', 'alert-circle', 'Couldn’t be read', esc(`${x.text} Published or not, it can’t be searched until the file is fixed.`));
      return '';
    }).filter(Boolean);
    return out.length ? `<ul class="cur-risks" aria-label="What the pipeline found">${out.join('')}</ul>` : '';
  }
  /** The document itself, in its own pane: the first page at reading size, scrolling on its own. */
  function docPane(d) {
    const fmt = hasFlag(d, 'format'), p = fmt ? null : X.docModel?.(d)?.pages?.[0], pages = Math.max(1, d.pages || 1);
    const canvas = fmt ? emptyState({ icon: 'file', title: 'No preview for this file type', desc: 'Download it to check the content.', actions: btn('Download', { size: 'sm', icon: 'download', act: 'doc-dl', data: { id: d.id } }), compact: true })
      : p ? `<div class="${cx('doc-page', p.cls)}">${p.html}</div>` : emptyState({ icon: 'file', title: 'No preview yet', compact: true });
    const bar = `<header class="cur-pane__bar">${fileIcon(d.type, 'sm')}<span class="cur-pane__title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</span>${fmt ? '' : `<span class="cur-pane__meta num">${esc(`Page 1 of ${pages}`)}</span>${linkBtn('Open full preview', { href: '/doc/' + d.id, icon: 'external' })}`}</header>`;
    return `<section class="cur-pane" aria-label="Preview">${bar}<div class="cur-pane__scroll" id="cur-preview-${d.id}" data-keep-scroll tabindex="0">${canvas}</div></section>`;
  }
  const sugRow = (label, badge, control, foot = '') => `<div class="cur-sug"><div class="cur-sug__label"><span class="t-label">${esc(label)}</span>${badge}</div><div class="cur-sug__ctl">${control}${foot}</div></div>`;
  /** Why the assistant suggested a topic, in words, strongest first (the contributor's confirmation leads; core/lifecycle.js). */
  const whyText = t => topicEvidence(t.why || {}).join(' · ');
  const byContributor = '<span class="t-xs muted">Chosen by the contributor</span>';
  function suggestionsCard(d, f) {
    // The fields show they're editable; the line says who chose them: the contributor, or the assistant against the topics.
    const ai = aiOf(d), from = `<p class="cur-insp__sub">${esc(ai.confirmed ? 'Confirmed by the contributor.' : 'Suggested by the assistant, checked against your topics.')}</p>`;
    const sec = body => `<section class="cur-insp__sec cur-sugs" aria-labelledby="cur-cls-h"><h3 class="cur-insp__h" id="cur-cls-h">Classification</h3>${from}${body}</section>`;
    if (!f) return sec(`<div class="cur-analyzing">${spinner()}<span>Reading the file and classifying it against your rules…</span></div>`);
    const kinds = Object.entries(RESOURCE_KINDS).map(([id, k]) => [id, k.label]);
    // What the contributor confirmed carries no assistant confidence: it says who chose it instead.
    const kindBadge = f.kind !== ai.kind.value ? confBadge(null, true) : ai.kind.by === 'contributor' ? byContributor : confBadge(ai.kind.conf);
    const type = sugRow('Type', kindBadge, select({ id: 'cur-kind', bind: `curDraft.${d.id}.kind`, value: f.kind, options: kinds, change: 'cur-redraw', size: 'sm', label: 'Type' }));
    // Topics: suggestions toggle on/off; reviewers may add any existing topic.
    const sugg = ai.topics, extra = f.topics.filter(id => !sugg.some(t => t.id === id));
    const tchip = (id, on, badge) => `<button type="button" class="cur-topic" aria-pressed="${on}" data-act="cur-topic" data-id="${d.id}" data-topic="${id}">${ic(on ? 'check' : 'plus', 'i-xs')}<span>${esc(topicName(id))}</span>${badge}</button>`;
    const chipsHtml = [...sugg.map(t => tchip(t.id, f.topics.includes(t.id), t.accepted ? '<span class="cur-conf cur-conf--new">New</span>' : t.why?.contributor ? '' : confBadge(t.conf))), ...extra.map(id => tchip(id, true, '<span class="cur-conf cur-conf--edited">Added</span>'))].join('');
    const addOpts = [['', 'Add topic…'], ...topicTree().flatMap(dm => dm.children.filter(t => !f.topics.includes(t.id)).map(t => [t.id, `${dm.name} · ${t.name}`]))];
    const why = sugg.filter(t => f.topics.includes(t.id) && whyText(t)).map(t => `<li><span class="medium" translate="no">${esc(topicName(t.id))}</span><span class="muted" aria-hidden="true"> — </span><span class="muted">${esc(whyText(t))}</span></li>`).join('');
    // A changed topic teaches the rules (recorded as a correction; a workspace admin turns corrections into keywords).
    const changed = f.topics.length !== sugg.length || f.topics.some(id => !sugg.some(t => t.id === id));
    const teach = changed && !ai.confirmed ? `<div class="cur-teach">${checkbox({ checked: f.teach, act: 'cur-teach', data: { id: d.id }, label: 'Use my change to improve classification' })}<span class="cur-teach__hint">${esc(canManageTaxonomy() ? 'You’ll find it in Topics → Suggestions.' : 'Workspace admins see it in Topics → Suggestions.')}</span></div>` : '';
    const topics = sugRow('Topics', '', `<div class="cur-topics">${chipsHtml || '<span class="t-sm muted">No topic suggested</span>'}${addOpts.length > 1 ? select({ id: 'cur-add-topic', value: '', options: addOpts, change: 'cur-topic-add', size: 'sm', cls: 'cur-add-topic', label: 'Add topic', attrs: `data-id="${d.id}"` }) : ''}</div>`, (why ? `<ul class="cur-why" aria-label="Why these topics">${why}</ul>` : '') + teach);
    // Proposed new topics are decided in one place, Topics → Suggestions (workspace admins); publishing never waits for them.
    const props = (ai.proposed || []).map(proposalById).filter(p => p && p.status === 'open');
    const decideIn = canManageTaxonomy() ? `<a class="link" href="#${topicsHref('suggestions')}">Decide in Topics → Suggestions</a>` : '<span>A workspace admin decides.</span>';
    const proposed = props.length ? `<div class="cur-prop-note">${ic('sparkles', 'i-xs')}<div><span>${props.length === 1 ? 'Suggests a new topic:' : 'Suggests new topics:'}</span> ${props.map(p => `<span class="medium">${esc(p.name)}</span>`).join(', ')}<br><span>You can publish without it.</span> ${decideIn}</div></div>` : '';
    // Collection: where it lives decides who can see it.
    const version = !!(f.asVersionOf || d.submission?.versionOf);
    const kbs = reviewableKbs().filter(k => k.contribute !== false || k.id === d.kb);
    const orig = version ? docById(f.asVersionOf || d.submission.versionOf) : null;
    const target = kbById(orig ? orig.kb : f.kb) || kbById(d.kb), who = X.whoCanSee(target, orig ? docFolder(orig) : target.id === d.kb ? docFolder(d) : null);
    const kbBadge = version ? '' : ai.kb.by === 'ai' ? confBadge(ai.kb.conf, f.kb !== ai.kb.id) : f.kb !== d.kb ? confBadge(null, true) : byContributor;
    const kbCtl = version ? `<div class="cur-fixed">${X.kbMark(target, 20)}<span class="truncate">${esc(target.name)}</span></div>` : select({ id: 'cur-kb', bind: `curDraft.${d.id}.kb`, value: f.kb, options: kbs.map(k => [k.id, k.name]), change: 'cur-redraw', size: 'sm', label: 'Collection' });
    const kb = sugRow('Collection', kbBadge, kbCtl, `<div class="cur-who">${ic(who.icon, 'i-xs')}<span>${version ? 'Same as the current version · ' : ''}${esc(who.label)} will see it</span></div>`);
    const summary = sugRow('Summary', confBadge(null, f.summary.trim() !== (ai.summary || '').trim()), textarea({ id: 'cur-sum-' + d.id, bind: `curDraft.${d.id}.summary`, value: f.summary, rows: 3, attrs: 'maxlength="280" aria-label="Summary"' }));
    return sec(`<div class="cur-sug-list">${type}${topics}${proposed}${kb}${summary}</div>`);
  }
  /** The decision footer: where it publishes, whether to process it now (on: it becomes searchable; off: published but Not
      processed until someone processes it from All), and the three decisions. */
  function decisionBar(d, f) {
    const v = f && (f.asVersionOf || d.submission?.versionOf), o = v && docById(v);
    const target = f && kbById(f.kb), hint = !f ? 'Waiting for the assistant…' : o ? `Publishes v${res(o).version + 1} of “${o.name}”` : `Publishes to ${target?.name || ''} · ${target ? X.whoCanSee(target, target.id === d.kb ? docFolder(d) : null).label : ''}`;
    const proc = f && !UNPROCESSABLE.includes(d.type) ? `<span class="cur-decide__proc" data-tip="${esc('Read, classify and index it so search and the assistant can use it.')}">${checkbox({ checked: f.process !== false, act: 'cur-proc', data: { id: d.id }, label: 'Process it now' })}</span>` : '';
    return `<footer class="cur-decide" role="group" aria-label="Decision">
      <span class="cur-decide__hint truncate" data-tip="${esc(hint)}">${esc(hint)}</span>${proc}
      <div class="cur-decide__btns">${btn('Decline', { v: 'ghost', act: 'cur-decline', data: { id: d.id } })}${btn('Request changes', { icon: 'pencil', act: 'cur-changes', data: { id: d.id }, tip: 'Request changes (R)' })}
      ${btn(f ? 'Approve & publish' : 'Classifying…', { v: 'primary', icon: f ? 'check' : '', act: 'cur-approve', data: { id: d.id }, disabled: !f, loading: !f, tip: f ? 'Approve & publish (A)' : '' })}</div>
    </footer>`;
  }
  A['cur-proc'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; f.process = f.process === false; refresh(); };
  const SEP = '<span aria-hidden="true"> · </span>';
  const navHtml = (pos, total) => `<div class="cur-detail__nav"><span class="t-xs muted num">${pos + 1} of ${total}</span>${iconBtn('chevron-up', 'Previous (K)', { size: 'sm', act: 'cur-step', data: { dir: -1 }, disabled: pos <= 0 })}${iconBtn('chevron-down', 'Next (J)', { size: 'sm', act: 'cur-step', data: { dir: 1 }, disabled: pos >= total - 1 })}</div>`;
  /** The workbench's right side: the document pane, then the inspector (who sent it, what the assistant found, its
      classification, the decision). With queue items selected, the floating bulk bar replaces the decision footer. */
  function detailPanel(d, pos, total, selecting) {
    const sub = d.submission || {}, kb = kbById(d.kb), f = draftOf(d), via = sub.via === 'sync';
    const resub = lastEvent(d).kind === 'resubmitted';
    const meta = [
      `${via ? 'Synced from' : 'From'} <span class="medium">${esc(contributorName(d))}</span>`,
      `${resub ? 'Resubmitted' : 'Submitted'} ${esc(relLow(lastEvent(d).at))}`,
      `to <a class="link" href="#${canEditKb(kb) ? kbManageHref(kb) : kbHref(kb)}">${esc(kb.name)}</a>`,
    ].join(SEP);
    // Narrow screens have no document pane: the full preview (which reviewers can open before publishing) is one click away.
    const peek = iconBtn('eye', 'Open full preview', { size: 'sm', href: '/doc/' + d.id, cls: 'cur-peek' });
    const head = `<header class="cur-detail__head">
      ${iconBtn('arrow-left', 'Back to the queue', { act: 'cur-back', cls: 'cur-back' })}
      <div class="grow"><h2 class="cur-detail__title">${esc(d.name)}</h2><div class="cur-detail__meta">${meta}${analyzing(d) ? lifeChip(d, 'sm') : ''}</div></div>
      ${peek}${navHtml(pos, total)}
    </header>`;
    const found = flagsHtml(d, f), note = noteHtml(d);
    const context = note || found ? `<section class="cur-insp__sec">${note}${found}</section>` : '';
    const insp = `<aside class="cur-detail cur-insp" id="cur-detail" aria-label="${esc(d.name)}">${head}<div class="cur-insp__body" data-keep-scroll>${context}${suggestionsCard(d, f)}</div>${selecting ? '' : decisionBar(d, f)}</aside>`;
    return docPane(d) + insp;
  }

  /* ── Batches: what a first sync at scale held back, decided once per reason (D.reviewBatches) ── */
  /** Per reason: how it shows, what the primary does (hint), and the two decisions [label, status, icon, action?]. */
  const BATCH = {
    duplicate: { label: 'Possible duplicates', icon: 'copy', tone: 'warning', hint: 'The published copies stay the only ones people find.',
      main: ['Keep the published ones', 'declined', 'check'], alt: ['Publish them too', 'approved', 'upload'] },
    personal: { label: 'Personal data', icon: 'shield', tone: 'danger', hint: 'Unpublished, they stay out of search and answers.',
      main: ['Keep unpublished', 'declined', 'eye-off'], alt: ['Publish anyway…', 'approved', 'upload', 'rb-pii'] },
    version: { label: 'Possible new versions', icon: 'history', tone: 'accent', hint: 'Each replaces the published document it updates.',
      main: ['Publish as new versions', 'replaced', 'history'], alt: ['Keep current versions', 'declined', 'x'] },
  };
  /** How a decision moves the run's counters (run.backfill). Declined documents stay unpublished; new versions replace, so they don't add topics. */
  const BATCH_DELTA = {
    declined: n => ({ review: -n, declined: n }),
    approved: n => ({ review: -n, published: n, 'topics.confident': n }),
    replaced: n => ({ review: -n, published: n }),
  };
  const batchById = id => (D.reviewBatches || []).find(b => b.id === id);
  function batchDetail(b, pos, total) {
    const m = BATCH[b.reason], kb = kbById(b.kb), src = srcById(b.source), who = X.whoCanSee(kb);
    const srcName = src ? (can('source.manage') ? `<a class="link" href="#${studioHref('sources')}">${esc(src.name)}</a>` : `<span class="medium">${esc(src.name)}</span>`) : '';
    const meta = [
      `<span class="num">${esc(plural(b.n, 'document'))}</span>`,
      `<span>${srcName}${srcName ? ' <span aria-hidden="true">→</span><span class="sr-only">to</span> ' : ''}<a class="link" href="#${canEditKb(kb) ? kbManageHref(kb) : kbHref(kb)}">${esc(kb.name)}</a></span>`,
      `<span>${esc(`Held ${relLow(b.at)}`)}</span>`,
    ].join(SEP);
    const head = `<header class="cur-detail__head">
      ${iconBtn('arrow-left', 'Back to the queue', { act: 'cur-back', cls: 'cur-back' })}
      ${itemIcon(m.icon, m.tone, 'sm')}
      <div class="grow"><h2 class="cur-detail__title">${esc(m.label)}</h2><div class="cur-detail__meta">${meta}</div></div>
      ${navHtml(pos, total)}
    </header>`;
    const why = `<section class="cur-insp__sec"><h3 class="cur-insp__h">Why they were held</h3><p class="cur-insp__text">${esc(b.note)}</p>
      <div class="cur-who">${ic(who.icon, 'i-xs')}<span>${esc(`${who.label} would see them once published`)}</span></div></section>`;
    const rows = (b.sample || []).map(name => `<li class="rb-sample__row">${fileIcon(name.split('.').pop(), 'sm')}<span class="truncate" translate="no" data-tip="${esc(name)}">${esc(name)}</span></li>`).join('');
    // What a person checks before deciding for all of them: a few of the held files, by name.
    const sample = `<section class="cur-insp__sec" aria-labelledby="rb-sample-h"><h3 class="cur-insp__h" id="rb-sample-h">Sample${SEP}<span class="muted num">${esc(`${(b.sample || []).length} of ${plural(b.n, 'document')}`)}</span></h3><ul class="rb-sample">${rows}</ul></section>`;
    const bar = `<footer class="cur-decide" role="group" aria-label="Decision">
      <span class="cur-decide__hint truncate" data-tip="${esc(m.hint)}">${esc(m.hint)}</span>
      <div class="cur-decide__btns">${btn(m.alt[0], { icon: m.alt[2], act: m.alt[3] || 'rb-decide', data: { id: b.id, to: m.alt[1] } })}
      ${btn(m.main[0], { v: 'primary', icon: m.main[2], act: 'rb-decide', data: { id: b.id, to: m.main[1] } })}</div>
    </footer>`;
    return `<aside class="cur-detail cur-insp rb-detail" id="cur-detail" aria-label="${esc(m.label)}">${head}<div class="cur-insp__body" data-keep-scroll>${why}${sample}</div>${bar}</aside>`;
  }

  /* ── Review: what syncs held back and submissions, one workbench ── */
  function reviewView(query, c) {
    return gate({
      loading: () => `<div class="cur-split cur-wb"><div class="cur-queue">${skelRows(6)}</div><div class="cur-pane">${skelRows(3)}</div><div class="cur-detail cur-insp">${skelRows(3)}</div></div>`,
      empty: () => viewDone('review', c),
      ok: () => {
        // ?kb= (from a collection page or a notice) preselects the base filter.
        const qkb = query.kb || '', u = ui(QK, { q: '', f: 'all', kb: '', sel: {} });
        if (u._kb !== qkb) { u._kb = qkb; u.kb = qkb; }
        return publishQueue(query, c);
      },
    });
  }
  /** One workbench for every publishing decision: a batch a sync held back opens its reason, sample and decision; a
      submission opens the document beside its inspector. */
  function publishQueue(query, c) {
    const q = publishRows();
    if (!q.order.length && !q.subs.all.length) return viewDone('review', c);
    const u = ui(QK), live = new Set(q.subs.all.map(d => d.id));
    u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
    const cur = currentId(q), b = batchById(cur), d = b ? null : docById(cur), pos = q.order.indexOf(cur), total = q.order.length;
    const open = !!query.sel && cur === query.sel, selecting = selCount(QK) > 0;
    const detail = b ? batchDetail(b, pos, total) : d ? detailPanel(d, pos, total, selecting) : '<div class="cur-pane"></div><div class="cur-detail cur-insp"></div>';
    return `<div class="${cx('cur-split', 'cur-wb', b && 'cur-split--batch', open && 'has-sel')}">${queuePanel(q, cur)}${detail}</div>${queueBulk()}`;
  }
  /** Quality: three lists that keep published knowledge trustworthy, one at a time. */
  function qualityView(query, c) {
    const part = partOf(query, c);
    const seg = PARTS.filter(([id]) => c.parts[id] || id === part).map(([id, label]) => ({ id, label, count: c.parts[id] || '' }));
    const nav = seg.length > 1 ? `<div class="cur-parts">${tabs(seg, part, BASE, { act: 'cur-part', label: 'Quality', variant: 'primary' })}</div>` : '';
    return nav + (X.gov?.queue?.(part) ?? skelRows(4));
  }
  A['cur-part'] = el => setQuery({ part: el.dataset.value });

  /* ── Issues: documents that couldn't be processed or changed at the source, each with its fix; files a sync couldn't read ── */
  const PROBLEM_OPTS = [['failed', 'Processing failed'], ['update', 'Changed at the source']];
  /** What first syncs couldn't read, by error class (counted, not listed): each class with its fix and its run. */
  function syncIssues() {
    const rows = backfillRuns().flatMap(r => (r.backfill.issues || []).map(([, label, n, fix]) => item({
      lead: itemIcon('alert', 'warning', 'sm'), title: esc(label), desc: esc(`${fix} · ${r.srcName || srcById(r.source)?.name || ''}`), meta: `<span class="num">${fmtNum(n)}</span>`,
      trail: btn('Open sync', { v: 'ghost', size: 'sm', act: 'src-run-open', data: { id: r.id } }),
    })));
    return rows.length ? section('Couldn’t be read in a sync', list(rows), { desc: esc('Fixed at the source, then the next sync reads them again.') }) : '';
  }
  function issuesView(c) {
    const u = ui(PK, { q: '', kb: '', life: '', sort: { key: 'updated', dir: 'desc' }, page: 1, sel: {} }), docs = problemDocs(), fromSyncs = syncIssues();
    if (!docs.length) return fromSyncs || viewDone('issues', c);
    const live = new Set(docs.map(d => d.id));
    u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
    const kbOpts = queueKbs(docs).map(k => [k.id, k.name]), lifeOpts = PROBLEM_OPTS.filter(([k]) => docs.some(d => lifeKey(d) === k));
    const tools = needsTools(docs.length, PK, ['kb', 'life'])
      ? `<div class="toolbar">${searchField({ uiKey: PK, placeholder: 'Search documents' })}${lifeOpts.length > 1 || u.life ? filterButton('Issue', PK, 'life', lifeOpts) : ''}${kbOpts.length > 1 || u.kb ? filterButton('Collection', PK, 'kb', kbOpts) : ''}${clearFilters(PK, ['kb', 'life'])}</div>` : '';
    const hint = '<p class="gov-summary">Couldn’t be processed, or changed at the source since it was. Each row shows its fix; select several to process them again together.</p>';
    let rows = docs.filter(d => (!u.kb || d.kb === u.kb) && (!u.life || lifeKey(d) === u.life) && matchesQ(PK, d.name, kbById(d.kb)?.name, originName(d)));
    rows = applySort(rows, PK, SORTERS);
    if (!rows.length) return hint + tools + noMatches(PK, ['kb', 'life'], 'documents') + fromSyncs;
    const pageRows = paginate(rows, PK, PER);
    const head = `${selAllCheck(PK, pageRows.map(d => d.id))}${sortHead('Name', 'name', PK)}${th('Issue')}${th('Origin', 'table__column--hide-sm')}${sortHead('Updated', 'updated', PK)}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
    const bulk = bulkBar(PK, btn('Process again', { v: 'ghost', size: 'sm', icon: 'refresh', act: 'cur-prob-process' }));
    return hint + tools + `<div class="cur-prob">${table({ label: 'Issues', head, rows: pageRows.map(problemRow), foot: pager(rows.length, PK, PER) })}</div>` + fromSyncs + bulk;
  }
  function problemRow(d) {
    const on = !!ui(PK).sel?.[d.id], why = d.status === 'failed' ? d.error || 'Processing stopped partway.' : lifecycleOf(d).desc;
    return `<tr class="table__row" data-act="cur-doc" data-id="${d.id}" tabindex="0" ${on ? 'aria-selected="true"' : ''}>
      ${selCheck(PK, d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbById(d.kb)?.name || '')}</div></div></div></td>
      <td class="table__cell"><div class="stack gap-2">${lifeChip(d, 'sm')}<span class="cell-sub cur-prob__why" data-tip="${esc(why)}">${esc(why)}</span></div></td>
      <td class="table__cell table__cell--hide-sm">${originCell(d)}</td>
      <td class="table__cell muted cur-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${rowFix(d)}<span class="reveal-on-hover">${iconBtn('more', 'More actions', { size: 'sm', menu: 'cur-row', data: { id: d.id, ctx: 'row' } })}</span></div></td></tr>`;
  }
  A['cur-prob-process'] = () => processSelected(PK);

  /* ── Review actions ── */
  /** Scroll the detail's top into view (after picking or deciding). */
  function showDetail() {
    const sc = $('#scroll'), el = $('#cur-detail'); if (!sc || !el) return;
    const r = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    if (r.top < s.top) sc.scrollTop += r.top - s.top - 16;
    $(`.cur-item[aria-current="true"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function pick(id) { setQuery({ sel: id }); requestAnimationFrame(showDetail); }
  A['cur-pick'] = (el, e) => {
    // Enter on the open submission opens the full preview (a batch has none).
    if (e?.type === 'keydown' && el.getAttribute('aria-current') === 'true') { if (!batchById(el.dataset.id)) go('/doc/' + el.dataset.id); return; }
    pick(el.dataset.id);
  };
  A['cur-back'] = () => setQuery({ sel: '' });
  /** J/K and the detail's arrows move through the Publish list (batches, then submissions). */
  function step(dir) {
    if (!onReview()) return;
    const q = publishRows(), { order } = q; if (!order.length) return;
    const i = order.indexOf(currentId(q)), n = order[Math.min(order.length - 1, Math.max(0, i + dir))];
    if (n && n !== order[i]) pick(n);
  }
  A['cur-step'] = el => step(+el.dataset.dir);
  A['cur-redraw'] = () => refresh();
  A['cur-topic'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; const t = el.dataset.topic; f.topics = f.topics.includes(t) ? f.topics.filter(x => x !== t) : [...f.topics, t]; refresh(); };
  A['cur-topic-add'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f || !el.value) return; if (!f.topics.includes(el.value)) f.topics.push(el.value); refresh(); };
  A['cur-teach'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; f.teach = !f.teach; refresh(); };
  A['cur-asver'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; f.asVersionOf = f.asVersionOf === el.dataset.other ? '' : el.dataset.other; refresh(); };

  /** Run a decision on submissions with Undo, then move on to the next entry of the Publish list. */
  function decide(docs, run, msg) {
    const ids = new Set(docs.map(d => d.id)), next = nextEntry(ids), here = onReview();
    const snaps = [], corrections = (D.classCorrections || []).length;
    docs.forEach(d => {
      snaps.push([d, snapDoc(d)]);
      const o = docById(drafts()[d.id]?.asVersionOf || d.submission?.versionOf);
      if (o && !snaps.some(([x]) => x === o)) snaps.push([o, snapDoc(o)]);
    });
    run();
    const added = (D.classCorrections || []).length - corrections;
    const sel = ui(QK).sel || {}; docs.forEach(d => delete sel[d.id]);
    // Stay in Review (its done state points at the next view) instead of jumping elsewhere.
    if (here) { setQuery({ view: 'review', sel: next }); requestAnimationFrame(showDetail); } else refresh();
    toast(msg, { action: { label: 'Undo', run: () => { if (added > 0) D.classCorrections.splice(0, added); undo(snaps, docs); } } });
  }
  function undo(snaps, docs) {
    snaps.forEach(([d, s]) => restoreDoc(d, s));
    if (onDocs()) setQuery({ view: 'review', sel: docs[0].id }); else refresh();
    toast(docs.length === 1 ? `“${docs[0].name}” is back in review` : `${plural(docs.length, 'document')} are back in review`, { tone: 'accent' });
  }
  /** Decide a batch: its status, the run's counters (so Sources, the run and Documents agree), audit, Undo, then the next
      entry. Publishing a batch publishes its documents; the sync processes them, as it does everything it publishes. */
  const BATCH_AUDIT = { declined: 'Kept a batch unpublished', approved: 'Published a batch', replaced: 'Published a batch as new versions' };
  function batchToast(b, to) {
    const n = plural(b.n, 'document'), kb = kbById(b.kb)?.name || '';
    if (to === 'approved') return `Published ${n} to ${kb}`;
    if (to === 'replaced') return `Published ${n} as new versions`;
    return { duplicate: `Kept the published ones. ${n} stay unpublished.`, personal: `Kept ${n} with personal data unpublished`, version: `Kept the current versions. ${n} stay unpublished.` }[b.reason];
  }
  function decideBatch(id, to) {
    const b = batchById(id); if (!b || b.status !== 'open' || !canReviewKb(kbById(b.kb)) || !BATCH_DELTA[to]) return;
    const delta = BATCH_DELTA[to](b.n), next = nextEntry(new Set([b.id])), here = onReview();
    b.status = to; b.decided = { by: me().id, at: Date.now() };
    shiftBackfill(b.run, delta);
    lifeAudit(BATCH_AUDIT[to], `${BATCH[b.reason].label} · ${plural(b.n, 'document')} · ${srcById(b.source)?.name || kbById(b.kb)?.name || ''}`);
    if (here) { setQuery({ view: 'review', sel: next }); requestAnimationFrame(showDetail); } else refresh();
    toast(batchToast(b, to), { action: { label: 'Undo', run: () => {
      if (b.status !== to) return;
      b.status = 'open'; delete b.decided; shiftBackfill(b.run, delta, -1);
      if (onDocs()) setQuery({ view: 'review', sel: b.id }); else refresh();
      toast(`${plural(b.n, 'document')} are back in review`, { tone: 'accent' });
    } } });
  }
  A['rb-decide'] = el => decideBatch(el.dataset.id, el.dataset.to);
  /** Publishing personal data is the risky way out: say who will see it first. */
  A['rb-pii'] = el => { const b = batchById(el.dataset.id); if (b?.status === 'open') openModal('rb-pii', { id: b.id }); };
  M['rb-pii'] = ({ id }) => {
    const b = batchById(id), kb = b && kbById(b.kb);
    if (!b || !kb) return { size: 'sm', title: 'This batch was decided already', body: '', foot: btn('Close', { v: 'ghost', act: 'close-modal' }) };
    const who = X.whoCanSee(kb);
    return {
      size: 'sm', title: `Publish ${plural(b.n, 'document')} with personal data?`, icon: 'shield', tone: 'danger',
      desc: esc(`${who.label} will be able to find and read them, and the assistant can quote them in answers.`),
      body: alertBox('warning', 'What was found', esc(b.note), '', { icon: 'shield' }),
      footStart: 'You can undo right after.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Publish anyway', { v: 'danger', icon: 'upload', act: 'rb-pii-go' }),
    };
  };
  A['rb-pii-go'] = () => { const id = S.modal?.props?.id; closeModal(); decideBatch(id, 'approved'); };
  const inQueue = id => { const d = docById(id); return d && stageOf(d) === 'review' && canReviewKb(kbById(d.kb)) ? d : null; };
  A['cur-approve'] = el => {
    const d = inQueue(el.dataset.id); if (!d || !draftOf(d)) return;
    const dec = decisionOf(d), o = docById(dec.asVersionOf || d.submission?.versionOf), kb = kbById(dec.kb || d.kb)?.name || 'its collection';
    // Processed now unless the reviewer unticked it; then it waits as Not processed (Documents → All).
    const after = dec.process ? 'Processing it now.' : 'Not processed yet: process it from All when you’re ready.';
    const msg = o ? `Published v${res(o).version + 1} of “${o.name}”. ${after}` : `Published “${d.name}” to ${kb}. ${after}`;
    decide([d], () => approveAndPublish(d, dec), msg);
  };
  A['cur-bulk-approve'] = () => {
    const ids = Object.keys(ui(QK).sel || {}).filter(id => ui(QK).sel[id]);
    const docs = ids.map(inQueue).filter(Boolean);
    const personal = docs.filter(d => !analyzing(d) && hasFlag(d, 'personal')), busy = docs.filter(analyzing);
    const ok = docs.filter(d => !personal.includes(d) && !busy.includes(d));
    const skipped = [personal.length && `${personal.length} with personal data`, busy.length && `${busy.length} still being classified`].filter(Boolean).join(' and ');
    if (!ok.length) { toast(`Nothing published: ${skipped || 'select submissions first'}. Review ${personal.length + busy.length === 1 ? 'it' : 'them'} one by one.`, { tone: 'danger' }); return; }
    const decisions = new Map(ok.map(d => [d, decisionOf(d)]));
    decide(ok, () => ok.forEach(d => approveAndPublish(d, decisions.get(d))), `Published ${plural(ok.length, 'document')} and started processing them${skipped ? ` · skipped ${skipped}` : ''}`);
    // Keep the skipped ones selected so they're easy to find.
    ui(QK).sel = Object.fromEntries([...personal, ...busy].map(d => [d.id, true])); refresh();
  };

  /* Request changes / decline: a required message the contributor sees. */
  const QUICK = {
    changes: ['Please remove personal data (names, grades, ID numbers) and resubmit.', 'Please add a short note on what this covers and who it’s for.', 'Please upload the final version as a PDF.'],
    decline: ['This is already published. Use the existing document instead.', 'We can’t publish copyrighted material.', 'It contains personal data that can’t be shared.', 'It doesn’t belong in this collection.'],
  };
  function openDecide(mode, ids) {
    const docs = ids.map(inQueue).filter(Boolean); if (!docs.length) return;
    S.ui.curDecide = { text: '', tried: false };
    openModal('cur-decide', { mode, ids: docs.map(d => d.id) });
  }
  A['cur-changes'] = el => openDecide('changes', [el.dataset.id]);
  A['cur-decline'] = el => openDecide('decline', [el.dataset.id]);
  A['cur-bulk-decline'] = () => openDecide('decline', Object.keys(ui(QK).sel || {}).filter(id => ui(QK).sel[id]));
  M['cur-decide'] = ({ mode, ids }) => {
    const f = ui('curDecide'), changes = mode === 'changes', n = ids.length, d = docById(ids[0]);
    const err = f.tried && !f.text.trim() ? (changes ? 'Tell the contributor what to change.' : 'Give a reason. The contributor sees it.') : '';
    const person = n === 1 && d.submission?.by ? contributorName(d) : '';
    const desc = changes
      ? (n > 1 ? 'Each contributor gets your message and can resubmit.' : person ? `${esc(person)} gets your message and can resubmit.` : 'Your message is kept with the document’s history.')
      : (n > 1 ? 'They won’t be published. Each contributor sees your reason.' : person ? `It won’t be published. ${esc(person)} sees your reason.` : 'It won’t be published. Your reason is kept with its history.');
    const docs = n === 1 ? `<div class="cur-dec-doc">${fileIcon(d.type, 'sm')}<span class="truncate" data-tip="${esc(d.name)}">${esc(d.name)}</span></div>` : '';
    const quick = QUICK[mode].map(q => `<button type="button" class="cur-quick__opt" aria-pressed="${f.text.trim() === q}" data-act="cur-quick" data-text="${esc(q)}">${ic(f.text.trim() === q ? 'check' : 'quote', 'i-sm')}<span>${esc(q)}</span></button>`).join('');
    return {
      size: 'md', title: changes ? 'Request changes' : n > 1 ? `Decline ${plural(n, 'submission')}` : 'Decline submission',
      icon: changes ? 'pencil' : 'x-circle', tone: changes ? 'warning' : 'danger', desc,
      body: docs + field({ id: 'cur-msg', label: changes ? 'What should change?' : 'Reason', required: true, error: err, control: textarea({ id: 'cur-msg', bind: 'curDecide.text', value: f.text, rows: 4, invalid: !!err, placeholder: changes ? 'Be specific, so they can fix it in one go.' : 'Say why, so they know what to do instead.', attrs: `data-autofocus maxlength="600" ${err ? 'data-live' : ''}` }) })
        + `<div class="cur-quick" role="group" aria-labelledby="cur-quick-label"><div class="t-label" id="cur-quick-label">Or start from a common reply</div>${quick}</div>`,
      footStart: 'You can undo right after.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(changes ? 'Send request' : n > 1 ? `Decline ${n}` : 'Decline', { v: changes ? 'primary' : 'danger', icon: changes ? 'send' : 'x-circle', act: 'cur-decide-go' }),
    };
  };
  A['cur-quick'] = el => { const f = ui('curDecide'); f.text = el.dataset.text; refreshLayer(); const t = $('#cur-msg'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } };
  A['cur-decide-go'] = () => {
    const f = ui('curDecide'), { mode, ids } = S.modal.props; f.tried = true;
    const text = f.text.trim(); if (!text) { refreshLayer(); $('#cur-msg')?.focus(); return; }
    const docs = ids.map(inQueue).filter(Boolean); closeModal(); if (!docs.length) return;
    const one = docs.length === 1, d = docs[0];
    if (mode === 'changes') decide(docs, () => docs.forEach(x => requestChanges(x, text)), d.submission?.by ? `Asked ${contributorName(d)} for changes` : 'Changes requested');
    else decide(docs, () => docs.forEach(x => rejectSubmission(x, text)), one ? `Declined “${d.name}”` : `Declined ${plural(docs.length, 'submission')}`);
  };

  /* Keyboard (Publish): J/K or ↓/↑ move through the list; on a submission, Enter opens the full preview, A approves and
     publishes, R asks for changes. */
  document.addEventListener('keydown', e => {
    if (!onReview() || S.modal || S.drawer || S.menu || S.palette || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target;
    if (t.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    const k = e.key, id = currentId(publishRows()), d = !batchById(id) && inQueue(id);
    if (k === 'j' || k === 'J' || k === 'ArrowDown') { e.preventDefault(); step(1); return; }
    if (k === 'k' || k === 'K' || k === 'ArrowUp') { e.preventDefault(); step(-1); return; }
    if (!d || selCount(QK)) return;
    if (k === 'Enter' && !t.closest?.('button,a,[role="button"],label,[data-act]')) { e.preventDefault(); go('/doc/' + d.id); }
    else if (k === 'a' || k === 'A') { e.preventDefault(); A['cur-approve']({ dataset: { id: d.id } }); }
    else if (k === 'r' || k === 'R') { e.preventDefault(); A['cur-changes']({ dataset: { id: d.id } }); }
  });

  /* ── Compare (possible duplicate) ── */
  A['cur-compare'] = el => openDrawer('cur-compare', { id: el.dataset.id, other: el.dataset.other });
  function excerpt(d) {
    const m = X.docModel?.(d), text = (m?.blocks?.length ? m.blocks.map(b => b.text).join(' ') : m?.text || '').replace(/\s+/g, ' ').trim();
    return text.length > 420 ? text.slice(0, 420).replace(/\s+\S*$/, '') + '…' : text;
  }
  function cmpCol(d, label) {
    const r = res(d), info = isPublishedStage(d) && stageOf(d) === 'published' ? X.res.details(d) : kv([
      ['Type', esc(kindMeta(aiOf(d).kind?.value || r.kind).label)],
      ['Collection', esc(kbById(d.kb)?.name || '—')],
      ['Contributor', esc(contributorName(d))],
      ['Submitted', esc(fmtDateTime(d.submission?.at || d.updated))],
      ['Size', `${esc(fmtSize(d.size))} · ${plural(d.pages || 1, 'page')}`],
    ]);
    return `<div class="cur-cmp__col"><div class="t-label">${esc(label)}</div><div class="row gap-8">${fileIcon(d.type)}<span class="medium cur-cmp__name">${esc(d.name)}</span></div>
      <p class="cur-cmp__text">${esc(excerpt(d)) || '<span class="muted">No text to show.</span>'}</p>${info}</div>`;
  }
  DR['cur-compare'] = ({ id, other }) => {
    const d = docById(id), o = docById(other);
    if (!d || !o || !canSeeDoc(d) || !canSeeDoc(o)) return { title: 'Comparison not available', body: emptyState({ icon: 'git-compare', title: 'One of these documents isn’t available', desc: 'It may have been archived or decided already.' }) };
    const f = stageOf(d) === 'review' ? draftOf(d) : null, on = f?.asVersionOf === o.id;
    return {
      size: 'xl', title: 'Compare', desc: 'The submission and the published document it resembles.', lead: itemIcon('git-compare', 'warning'),
      body: `<div class="cur-cmp">${cmpCol(d, 'Submission')}${cmpCol(o, `Published · v${res(o).version}`)}</div>`,
      foot: f ? btn('Keep as separate documents', { act: 'cur-cmp-pick', data: { id: d.id, other: '' } }) + btn(on ? 'Publishing as a new version' : 'Publish as a new version', { v: 'primary', icon: on ? 'check' : 'history', act: 'cur-cmp-pick', data: { id: d.id, other: o.id } }) : btn('Close', { act: 'close-drawer' }),
    };
  };
  A['cur-cmp-pick'] = el => { const f = draftOf(docById(el.dataset.id)); if (f) f.asVersionOf = el.dataset.other; closeDrawer(); refresh(); };

  /* ═══════════════ All: the registry — filter by processing, select, Process ═══════════════ */
  const SORTERS = { name: d => d.name.toLowerCase(), updated: d => d.updated };
  const FACETS = ['kb', 'pub', 'src', 'kind', 'topic'];
  function syncFromQuery(u, query) {
    const qs = JSON.stringify([query.processing, query.kb, query.src, query.topic, query.q]);
    if (u._qs === qs) return;
    Object.assign(u, { _qs: qs, proc: PROCESSING[query.processing] ? query.processing : '', kb: query.kb || '', src: query.src || '', topic: query.topic || '', q: query.q || '', kind: '', pub: '', page: 1, sel: {} });
  }
  /** Who or what a document came from, in words: its source, its contributor, or the editor who uploaded it. */
  const originName = d => (srcKey(d) !== 'upload' ? srcById(d.source)?.name || res(d).source.name : contributorName(d));
  const originCell = d => `<span class="row gap-6 cur-origin">${appIcon(res(d).source.app, 'sm')}<span class="truncate" data-tip="${esc(originName(d))}">${esc(originName(d))}</span></span>`;
  /** Processing state for the filter: only documents that can be processed have one (submissions and declined ones don't). */
  const procKey = d => (['published', 'unpublished'].includes(stageOf(d)) ? processingOf(d) : '');
  const PUBS = { published: 'Published', unpublished: 'Unpublished', review: 'In review' };
  const pubKey = d => ({ changes: 'review' }[stageOf(d)] || stageOf(d));
  /** Every filter but processing (the pill row is the processing filter). */
  const facetMatch = (d, u) => (!u.kb || d.kb === u.kb) && (!u.pub || pubKey(d) === u.pub) && (!u.src || originKey(d) === u.src) && (!u.kind || resKind(d) === u.kind) && (!u.topic || resTopics(d).includes(u.topic)) && matchesQ(AK, d.name, contributorName(d), kbById(d.kb)?.name);
  function allRows(u) {
    const docs = curatedDocs(), pool = docs.filter(d => facetMatch(d, u));
    const rows = pool.filter(d => !u.proc || procKey(d) === u.proc);
    return { docs, pool, rows: applySort(rows, AK, SORTERS) };
  }
  /** The processing pills: All, then each state with its count (Not processed accent, Failed danger), hiding empty ones. */
  function procPills(pool, cur) {
    const n = Object.fromEntries(PROCESSING_ORDER.map(k => [k, 0]));
    pool.forEach(d => { const k = procKey(d); if (k) n[k]++; });
    const tone = { pending: 'accent', failed: 'danger' };
    const items = [['', 'All', pool.length, ''], ...PROCESSING_ORDER.filter(k => n[k] || k === cur).map(k => [k, PROCESSING[k].label, n[k], tone[k] || ''])];
    return pillRow(items, cur, 'cur-proc-filter', 'Processing state');
  }
  A['cur-proc-filter'] = el => { const v = el.tagName === 'SELECT' ? el.value : el.dataset.value; const u = ui(AK); u.proc = u.proc === v ? '' : v; u.page = 1; u.sel = {}; refresh(); };
  /** Processing: its state (a chip) and what that means for search. */
  function procCell(d) {
    const k = procKey(d);
    if (!k) return '<span class="cell-sub">—</span>';
    const p = PROCESSING[k], searchable = inSearch(d);
    const line = { pending: 'Search can’t find it', processing: 'Reading, classifying, indexing…', ready: searchable ? `Searchable · v${res(d).version}` : 'Ready to publish', failed: d.error || 'Stopped partway', outdated: 'The previous version answers', unsupported: 'Download only' }[k];
    return `<div class="stack gap-2">${chip(p.label, { tone: p.tone, variant: k === 'ready' ? 'tertiary' : 'soft', dot: true, live: !!p.live, size: 'sm', tip: p.desc })}<span class="${cx('cell-sub truncate', (k === 'failed' || k === 'outdated') && 'cur-ix--bad')}" data-tip="${esc(line)}">${esc(line)}</span></div>`;
  }
  /** Publication: can readers see it? */
  function pubCell(d) {
    const st = stageOf(d), icon = { published: 'eye', unpublished: 'eye-off', review: 'clock', changes: 'pencil', rejected: 'x-circle', merged: 'history' }[st] || 'eye';
    return `<span class="${cx('cur-pub', 'cur-pub--' + st)}">${ic(icon, 'i-xs')}<span class="truncate">${esc(publicationOf(d))}</span></span>`;
  }
  /** Its topics and who chose them: the pipeline (with how sure it was), a person, or a suggestion still in review. */
  function topicCell(d) {
    const inReview = ['review', 'changes'].includes(stageOf(d)), ai = inReview && d.ai?.status === 'done' ? d.ai : null;
    const ids = ai ? ai.topics.map(t => t.id) : d.topics || [];
    if (d.error && (d.status === 'failed' || inReview)) return `<span class="cur-topic-cell is-none">${esc('Not classified: no text to read')}</span>`;
    if (!ids.length) return `<span class="cur-topic-cell is-none">${esc(inReview ? 'Classifying…' : procKey(d) === 'pending' ? 'Classified when processed' : 'No topic')}</span>`;
    const p = ai ? Math.round((ai.topics[0].conf || 0) * 100) : topicsByPipeline(d) ? Math.round(topicConfidence(d, ids[0]) * 100) : null;
    const by = ai ? `Suggested · ${p}%` : p != null ? `Pipeline · ${p}%` : 'Set by a person';
    const tone = p == null ? '' : p >= 80 ? 'hi' : p >= Math.round(classThreshold() * 100) ? 'mid' : 'lo';
    return `<div class="stack gap-2 cur-topic-cell"><span class="truncate" translate="no">${esc(ids.map(topicName).join(', '))}</span><span class="${cx('cell-sub', tone && 'cur-by--' + tone)}">${esc(by)}</span></div>`;
  }
  function allRow(d) {
    const on = !!ui(AK).sel?.[d.id];
    return `<tr class="table__row" data-act="cur-doc" data-id="${d.id}" tabindex="0" ${on ? 'aria-selected="true"' : ''}>
      ${selCheck(AK, d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate"><span translate="no">${esc([kbById(d.kb)?.name, ...folderPath(docFolder(d)).map(f => f.name)].filter(Boolean).join(' › '))}</span><span aria-hidden="true"> · </span><span translate="no">${esc(originName(d))}</span></div></div></div></td>
      <td class="table__cell">${procCell(d)}</td>
      <td class="table__cell table__cell--hide-sm">${pubCell(d)}</td>
      <td class="table__cell table__cell--hide-sm">${topicCell(d)}</td>
      <td class="table__cell muted cur-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${rowFix(d)}<span class="reveal-on-hover">${iconBtn('more', 'More actions', { size: 'sm', menu: 'cur-row', data: { id: d.id, ctx: 'row' } })}</span></div></td></tr>`;
  }
  function documentsTab(query) {
    const u = ui(AK, { q: '', proc: '', kb: '', pub: '', src: '', kind: '', topic: '', sort: { key: 'updated', dir: 'desc' }, page: 1, sel: {} });
    syncFromQuery(u, query);
    const empty = () => emptyState({ icon: 'files', title: 'No documents yet', desc: 'Documents added to the collections you look after show up here, whatever their origin.', actions: canContribute() ? btn('Add documents', { v: 'primary', icon: 'upload', act: 'contribute' }) : '', boxed: true });
    return gate({
      loading: () => skelRows(8),
      empty,
      ok: () => {
        const { docs, pool, rows } = allRows(u);
        if (!docs.length) return empty();
        const live = new Set(docs.map(d => d.id));
        u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
        const facets = allFacets(docs, u), sortLabel = u.sort?.key === 'name' ? 'Name' : 'Recently updated';
        const n = FACETS.filter(k => u[k]).length;
        // Wide: one dropdown per facet. Narrow: one Filters button (a bottom sheet on phones) plus removable chips for what's on.
        // Processing is the pill row under the toolbar, never a second dropdown.
        const wide = facets.map(f => filterButton(f.label, AK, f.key, f.opts)).join('') + clearFilters(AK, FACETS);
        const narrow = facets.length ? `<button type="button" class="${cx('filter-button', n && 'is-set')}" data-popover="cur-filters" aria-haspopup="dialog" aria-expanded="false">${ic('filter')}<span>Filters</span>${n ? badge(n, { tone: 'accent' }) : ''}</button>` : '';
        const chips = n ? `<div class="cur-fchips">${facets.filter(f => u[f.key]).map(f => `<button type="button" class="chip chip--soft chip--accent cur-fchip" data-act="cur-filter-set" data-field="${f.key}" data-value="" aria-label="${esc(`Remove filter: ${f.label}`)}">${esc(f.opts.find(o => o[0] === u[f.key])?.[1] || u[f.key])}${ic('x', 'i-xs')}</button>`).join('')}</div>` : '';
        const toolbar = `<div class="toolbar cur-toolbar">${searchField({ uiKey: AK, placeholder: 'Search documents' })}
          <div class="cur-filters--wide">${wide}</div><div class="cur-filters--narrow">${narrow}</div>
          <div class="toolbar__end cur-sortmenu">${btn(sortLabel, { v: 'ghost', size: 'sm', icon: 'sort', menu: 'cur-sort', aria: `aria-label="Sort: ${esc(sortLabel)}"` })}</div></div>${chips}`;
        const pills = procPills(pool, u.proc);
        if (!rows.length) return toolbar + pills + noMatches(AK, FACETS, 'documents');
        const pageRows = paginate(rows, AK, PER);
        // Selecting the whole page offers the whole filtered list (the way to pick 1,000 documents to process at once).
        const nSel = selCount(AK), allPage = pageRows.every(d => u.sel?.[d.id]);
        const more = nSel && allPage && nSel < rows.length ? linkBtn(`Select all ${fmtNum(rows.length)}`, { act: 'cur-sel-matching' }) : '';
        const bulk = bulkBar(AK, more + btn('Process', { v: 'secondary', size: 'sm', icon: 'play', act: 'cur-bulk-process' }) + btn('Publish', { v: 'ghost', size: 'sm', icon: 'eye', act: 'cur-bulk-publish' }) + btn('Unpublish', { v: 'ghost', size: 'sm', icon: 'eye-off', act: 'cur-bulk-unpublish' }) + btn('Archive', { v: 'ghost', size: 'sm', icon: 'archive', act: 'cur-bulk-archive' }));
        // Processing and publication are separate columns: either can be where a document stopped. No Visibility column:
        // who can read a document is its collection's (or folder's) audience.
        const head = `${selAllCheck(AK, pageRows.map(d => d.id))}${sortHead('Name', 'name', AK)}${th('Processing state')}${th('Publication', 'table__column--hide-sm')}${th('Topics', 'table__column--hide-sm')}${sortHead('Updated', 'updated', AK)}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
        return toolbar + pills + `<div class="cur-all">${table({ label: 'All documents', head, rows: pageRows.map(allRow), foot: pager(rows.length, AK, PER) })}</div>` + bulk;
      },
    });
  }
  A['cur-sel-matching'] = () => { const u = ui(AK); u.sel = Object.fromEntries(allRows(u).rows.map(d => [d.id, true])); refresh(); };
  /** Facets Documents offers, only when they'd split it (or one is in use): [{ key, label, opts }]. */
  function allFacets(docs, u) {
    const kbs = queueKbs(docs);
    const srcs = [...new Set(docs.map(srcKey))].filter(k => k !== 'upload').map(srcById).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const origins = [docs.some(d => originKey(d) === 'contrib') && ['contrib', 'Contributions'], docs.some(d => originKey(d) === 'upload') && ['upload', 'Uploads'], ...srcs.map(s => [s.id, s.name])].filter(Boolean);
    const kinds = [...new Set(docs.map(resKind))].map(k => [k, kindMeta(k).label]).sort((a, b) => a[1].localeCompare(b[1]));
    const topics = [...new Set(docs.flatMap(resTopics))].filter(id => topicById(id)).map(id => [id, topicName(id)]).sort((a, b) => a[1].localeCompare(b[1]));
    const pubs = Object.entries(PUBS).filter(([k]) => docs.some(d => pubKey(d) === k));
    return [
      (kbs.length > 1 || u.kb) && { key: 'kb', label: 'Collection', opts: kbs.map(k => [k.id, k.name]) },
      (pubs.length > 1 || u.pub) && { key: 'pub', label: 'Publication', opts: pubs },
      (origins.length > 1 || u.src) && { key: 'src', label: 'Origin', opts: origins },
      (kinds.length > 1 || u.kind) && { key: 'kind', label: 'Type', opts: kinds },
      (topics.length > 1 || u.topic) && { key: 'topic', label: 'Topic', opts: topics },
    ].filter(Boolean);
  }
  /** Filters popover (narrow screens; a bottom sheet on phones): each facet as a group of options, applied as you pick. */
  PO['cur-filters'] = () => {
    const u = ui(AK), facets = allFacets(curatedDocs(), u), FF = facets.map(f => f.key);
    const opt = (f, v, l) => `<button type="button" class="cur-fopt" role="radio" aria-checked="${(u[f.key] || '') === v}" data-act="cur-filter-set" data-field="${f.key}" data-value="${esc(v)}"><span class="cur-fopt__dot" aria-hidden="true"></span><span class="truncate">${esc(l)}</span></button>`;
    const body = facets.map(f => `<fieldset class="cur-fgroup"><legend class="t-label">${esc(f.label)}</legend><div role="radiogroup" aria-label="${esc(f.label)}">${opt(f, '', 'Any')}${f.opts.map(([v, l]) => opt(f, v, l)).join('')}</div></fieldset>`).join('');
    return { title: 'Filters', body: `<div class="cur-fgroups">${body}</div>`, foot: FF.some(k => u[k]) ? btn('Clear filters', { v: 'ghost', size: 'sm', act: 'cur-filter-clear' }) : '' };
  };
  A['cur-filter-set'] = el => { const u = ui(AK); u[el.dataset.field] = el.dataset.value || ''; u.page = 1; u.sel = {}; refresh(); };
  A['cur-filter-clear'] = () => { const u = ui(AK); FACETS.forEach(k => { u[k] = ''; }); u.page = 1; refresh(); };
  MENUS['cur-sort'] = () => {
    const u = ui(AK), set = (key, dir) => { u.sort = { key, dir }; u.page = 1; refresh(); };
    return [{ section: 'Sort by' }, { label: 'Recently updated', checked: u.sort?.key !== 'name', run: () => set('updated', 'desc') }, { label: 'Name', checked: u.sort?.key === 'name', run: () => set('name', 'asc') }];
  };
  /** Selected documents in a list (All or Issues) the caller reviews. */
  const selectedIn = key => selIds(key).map(docById).filter(d => d && canReviewKb(kbById(d.kb)));
  const canPublish = d => stageOf(d) === 'unpublished' && !d.archived;
  const canUnpublish = d => stageOf(d) === 'published' && !d.archived;
  /** Publish what's selected: readers see it at once; what isn't processed yet stays out of search until it is. */
  function bulkPublish(key) {
    const docs = selectedIn(key).filter(canPublish);
    if (!docs.length) { toast('None of these are unpublished', { tone: 'danger' }); return; }
    const snaps = docs.map(d => [d, snapDoc(d)]), raw = docs.filter(d => d.status !== 'ready').length;
    docs.forEach(republish); ui(key).sel = {}; refresh();
    toast(raw ? `Published ${plural(docs.length, 'document')} · ${raw} not processed yet, so search can’t find them` : `Published ${plural(docs.length, 'document')}`, { action: { label: 'Undo', run: () => { snaps.forEach(([d, s]) => restoreDoc(d, s)); refresh(); } } });
  }
  A['cur-bulk-publish'] = () => bulkPublish(AK);
  /** Process what's selected: one dialog that says what will happen, then one processing run. */
  function processSelected(key) {
    const docs = selectedIn(key);
    if (!docs.some(canProcess)) { toast(docs.some(d => d.status === 'processing') ? 'These are being processed already' : docs.some(d => UNPROCESSABLE.includes(d.type)) ? 'Images and archives can’t be processed.' : 'None of these can be processed', { tone: 'danger' }); return; }
    openModal('cur-process', { key, ids: docs.map(d => d.id) });
  }
  A['cur-bulk-process'] = () => processSelected(AK);
  /** A collection's usual topics: the ones it lists, then those its documents carry most (at most eight). */
  function kbTopicIds(kb) {
    const n = new Map();
    docsIn(kb.id).forEach(d => (d.topics || []).forEach(id => n.set(id, (n.get(id) || 0) + 1)));
    const live = id => { const t = topicById(id); return !!t?.parent && !t.archived; };
    return [...new Set([...(kb.topics || []), ...[...n].sort((a, b) => b[1] - a[1]).map(([id]) => id)])].filter(live).slice(0, 8);
  }
  const PROC_DEFAULT = () => ({ scope: 'all', topics: [], expanded: false, note: '', noteOpen: false, tried: false });
  const procKbs = ids => [...new Set(ids.map(docById).filter(canProcess).map(d => d.kb))].map(kbById).filter(kb => kb && kbTopicIds(kb).length);
  /** The Process dialog: one decision (which topics the AI may suggest), one optional input (context) and the action.
      Processing never publishes: people review, then publish. */
  M['cur-process'] = ({ ids }) => {
    const todo = ids.map(docById).filter(canProcess), n = todo.length;
    const f = ui('curProcess', PROC_DEFAULT()), pages = todo.reduce((s, d) => s + (d.pages || 1), 0), mins = Math.max(1, Math.round(pages / 120));
    const leaves = topicTree().flatMap(dm => dm.children), chosen = f.scope === 'chosen';
    const sec = (label, control, body = '', opt = false) => `<section class="proc-sec"><div class="proc-sec__head"><h3 class="proc-sec__label">${esc(label)}${opt ? '<span class="label__opt">(optional)</span>' : ''}</h3>${control}</div>${body}</section>`;

    // Topics: all of them, or a few the admin picks (one click loads the documents' collections' usual topics).
    const loadable = chosen ? procKbs(ids).filter(kb => kbTopicIds(kb).some(id => !f.topics.includes(id))) : [];
    const load = loadable.length ? linkBtn(loadable.length === 1 ? `Use ${loadable[0].name}’s topics` : 'Use their collections’ topics', { act: 'cur-proc-load' }) : '';
    const hint = chosen ? (f.topics.length ? `The AI suggests only from these ${plural(f.topics.length, 'topic')}.` : 'Pick the topics the AI may suggest.') : `The AI suggests from all ${plural(leaves.length, 'topic')}.`;
    const err = chosen && f.tried && !f.topics.length ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc('Select at least one topic, or use all topics.')}</span></div>` : '';
    const picker = chosen ? topicPicker({ id: 'cur-proc-add', ids: f.topics, act: 'cur-proc-topic', label: 'Selected topics', domains: true, limit: 5, expanded: f.expanded, quiet: true }) : '';
    const topics = sec('Topics', seg({ value: f.scope, act: 'cur-proc-scope', label: 'Topics the AI may suggest', size: 'sm', options: [['all', 'All topics'], ['chosen', 'Selected']] }),
      `<p class="proc-sec__hint"><span>${esc(hint)}</span>${load}</p>${picker}${err}`);

    // Context: secondary, closed until asked for.
    const open = f.noteOpen || !!f.note;
    const context = sec('Context for the AI', open ? '' : linkBtn('Add', { act: 'cur-proc-note' }),
      open ? textarea({ id: 'cur-proc-note', bind: 'curProcess.note', value: f.note, rows: 2, placeholder: 'e.g. Scanned decisions and notices, 2015–2024', attrs: 'maxlength="300" aria-label="Context for the AI"' }) : '', true);
    return {
      size: 'md', icon: 'play', title: `Process ${plural(n, 'document')}`,
      desc: esc(`The AI reads each file and suggests topics. About ${mins} min for ${fmtNum(pages)} pages; you can keep working.`),
      body: `<div class="proc">${topics}${context}</div>`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(`Process ${plural(n, 'document')}`, { v: 'primary', icon: 'play', act: 'cur-process-go' }),
    };
  };
  /** Selected starts from what the documents' collection usually holds, when only one collection is involved. */
  A['cur-proc-scope'] = el => {
    const f = ui('curProcess'); f.scope = el.dataset.value; f.tried = false;
    if (f.scope === 'chosen' && !f.topics.length) { const kbs = procKbs(S.modal?.props?.ids || []); if (kbs.length === 1) f.topics = kbTopicIds(kbs[0]); }
    refreshLayer();
  };
  A['cur-proc-load'] = () => {
    const f = ui('curProcess');
    f.topics = [...new Set([...f.topics, ...procKbs(S.modal?.props?.ids || []).flatMap(kbTopicIds)])]; f.tried = false; refreshLayer();
  };
  A['cur-proc-topic-add'] = el => {
    const f = ui('curProcess'), v = el.value; if (!v) return;
    const add = v.startsWith('domain:') ? (topicTree().find(dm => dm.id === v.slice(7))?.children || []).map(t => t.id) : [v];
    f.topics = [...new Set([...f.topics, ...add])]; f.tried = false; refreshLayer();
    requestAnimationFrame(() => $('#cur-proc-add')?.focus());
  };
  A['cur-proc-topic-remove'] = el => {
    const f = ui('curProcess'); f.topics = f.topics.filter(id => id !== el.dataset.topic); refreshLayer();
    requestAnimationFrame(() => $('#cur-proc-add')?.focus());
  };
  A['cur-proc-topic-more'] = () => { ui('curProcess').expanded = true; refreshLayer(); };
  A['cur-proc-note'] = () => { ui('curProcess').noteOpen = true; refreshLayer(); requestAnimationFrame(() => $('#cur-proc-note')?.focus()); };
  A['cur-process-go'] = () => {
    const { key, ids } = S.modal.props, f = ui('curProcess'), docs = ids.map(docById).filter(canProcess);
    if (f.scope === 'chosen' && !f.topics.length) { f.tried = true; refreshLayer(); requestAnimationFrame(() => $('#cur-proc-add')?.focus()); return; }
    const note = f.note.trim(), context = f.scope === 'chosen' || note ? { topics: f.scope === 'chosen' ? [...f.topics] : [], note } : null;
    closeModal(); ui(key).sel = {};
    const run = X.processRun(docs, { context });
    Object.assign(f, PROC_DEFAULT());
    if (run) toast(`Processing ${plural(run.total, 'document')}`, { tone: 'accent', action: { label: 'Show them', run: () => A['cur-show-processing']() } });
  };
  /** Unpublishing is reversible: it happens at once, with Undo (no confirmation). */
  function unpublishDocs(docs, onDone) {
    docs = docs.filter(canUnpublish);
    if (!docs.length) { toast('None of these are published', { tone: 'danger' }); return; }
    const one = docs.length === 1, snaps = docs.map(d => [d, snapDoc(d)]);
    docs.forEach(d => unpublish(d)); onDone?.(); refresh();
    toast(one ? `Unpublished “${docs[0].name}”. It left search and answers.` : `Unpublished ${plural(docs.length, 'document')}. They left search and answers.`, { action: { label: 'Undo', run: () => { snaps.forEach(([d, s]) => restoreDoc(d, s)); refresh(); toast(one ? `“${docs[0].name}” is published again` : `${plural(docs.length, 'document')} are published again`, { tone: 'accent' }); } } });
  }
  A['cur-bulk-unpublish'] = () => unpublishDocs(selectedIn(AK), () => { ui(AK).sel = {}; });
  A['cur-bulk-archive'] = () => X.archiveDocs(selectedIn(AK), () => { ui(AK).sel = {}; });

  /* ── One document: drawer + row menu ── */
  const closeDocDrawer = () => { if (S.drawer?.name === 'cur-doc') S.drawer = null; };
  const OPS = {
    review: { label: 'Review', icon: 'check', run: d => { closeDocDrawer(); go(docsHref('review', { sel: d.id })); } },
    process: { label: 'Process', icon: 'play', run: d => X.processDocs([d], { msg: `Processing ${d.name}` }) },
    retry: { label: 'Process again', icon: 'retry', run: d => X.processDocs([d], { msg: `Processing ${d.name} again` }) },
    replace: { label: 'Replace file', icon: 'upload', run: d => A['doc-replace']({ dataset: { id: d.id } }) },
    // Changed at its source: process the source's version (never a file picker for synced documents).
    update: { label: 'Process the update', icon: 'refresh', run: d => X.processDocs([d], { msg: `Processing the update to ${d.name}` }) },
    source: { label: 'Open source', icon: 'plug', run: d => { closeDocDrawer(); if (can('source.manage') && A['src-open']) A['src-open']({ dataset: { id: d.source } }); else go(studioHref('sources')); } },
    republish: { label: 'Publish', icon: 'eye', run: d => { const s = snapDoc(d); republish(d); refresh(); toast(d.status === 'ready' ? `Published “${d.name}”` : `Published “${d.name}” · not processed yet, so search can’t find it`, { action: { label: 'Undo', run: () => { restoreDoc(d, s); refresh(); } } }); } },
    unpublish: { label: 'Unpublish', icon: 'eye-off', run: d => unpublishDocs([d]) },
    edit: { label: 'Edit details…', icon: 'pencil', run: d => A['res-edit']({ dataset: { id: d.id } }) },
    move: { label: 'Move to…', icon: 'folder', run: d => A['doc-move']({ dataset: { id: d.id } }) },
    open: { label: 'Open', icon: 'file-text', run: d => { closeDocDrawer(); go('/doc/' + d.id); } },
    original: { label: 'Open the published document', icon: 'file-text', run: d => { closeDocDrawer(); go('/doc/' + d.mergedInto); } },
    download: { label: 'Download', icon: 'download', run: d => X.downloadDocument(d) },
    archive: { label: 'Archive', icon: 'archive', danger: true, run: d => X.archiveDocs([d], closeDocDrawer) },
  };
  /** Fixes a row shows as a visible button (actionable states only); everything else lives in ⋯. */
  const ROW_FIX = new Set(['process', 'retry', 'replace', 'update', 'republish', 'source']);
  /** May the caller open the document drawer? Reviewers of its base; editors for published documents (Classification and Upkeep). */
  const canOpenDoc = d => { const kb = d && kbById(d.kb); return !!kb && (canReviewKb(kb) || (canEditKb(kb) && isPublishedStage(d))); };
  /** { main, more, tail } operations for a document's lifecycle state. Editors who don't review the base only open, edit and download. */
  function opsFor(d) {
    const k = lifeKey(d), live = ['published', 'update', 'stored', 'queued', 'failed', 'publishing'].includes(k);
    if (!canReviewKb(kbById(d.kb))) return { main: 'open', more: live ? ['edit'] : [], tail: ['download'] };
    const synced = srcKey(d) !== 'upload' && !!srcById(d.source), raw = processingOf(d) === 'pending';
    const main = { analyzing: 'review', review: 'review', queued: 'process', failed: isLocked(d) ? (synced ? 'source' : 'replace') : 'retry', update: synced ? 'update' : 'replace', unpublished: raw ? 'process' : 'republish', merged: d.mergedInto ? 'original' : 'open' }[k] || 'open';
    const more = [main !== 'open' && 'open', k === 'unpublished' && main !== 'republish' && 'republish', (live || k === 'unpublished') && 'edit', (live || k === 'unpublished') && !kbById(d.kb)?.personal && 'move', canUnpublish(d) && 'unpublish'].filter(Boolean);
    return { main, more, tail: ['download', !d.archived && k !== 'merged' && 'archive'].filter(Boolean) };
  }
  /** The state's fix as a small row button (All documents, Problems), or ''. */
  function rowFix(d) {
    const { main } = opsFor(d); if (!ROW_FIX.has(main)) return '';
    return btn(OPS[main].label, { v: 'secondary', size: 'sm', icon: OPS[main].icon, act: 'cur-op', data: { id: d.id, op: main } });
  }
  A['cur-op'] = el => {
    const d = docById(el.dataset.id), op = el.dataset.op; if (!d || !canOpenDoc(d)) return;
    const { main, more, tail } = opsFor(d);
    if ([main, ...more, ...tail].includes(op)) OPS[op]?.run(d);
  };
  A['cur-doc'] = el => openDrawer('cur-doc', { id: el.dataset.id });
  /** Row ⋯ (the row itself opens the drawer): what the row and the drawer footer don't already show. */
  MENUS['cur-row'] = el => {
    const d = docById(el.dataset.id); if (!d || !canOpenDoc(d)) return [];
    const { main, more, tail } = opsFor(d), item = op => ({ label: OPS[op].label, icon: OPS[op].icon, danger: OPS[op].danger, run: () => OPS[op].run(d) });
    const shown = el.dataset.ctx === 'drawer' || (el.dataset.ctx === 'row' && ROW_FIX.has(main));
    const head = [...(shown ? [] : [main]), ...more].map(item);
    return head.concat(tail.length ? [...(head.length ? [{ sep: true }] : []), ...tail.map(item)] : []);
  };
  const EVENTS = {
    submitted: ['upload', 'Submitted', ''], resubmitted: ['upload', 'Resubmitted', ''], changes: ['pencil', 'Changes requested', 'warning'],
    rejected: ['x-circle', 'Declined', 'danger'], approved: ['check-circle', 'Approved', 'success'], published: ['upload', 'Published again', 'success'],
    unpublished: ['eye-off', 'Unpublished', ''], withdrawn: ['archive', 'Withdrawn', ''],
  };
  function timeline(d) {
    const evs = d.submission?.events || [], src = srcKey(d) !== 'upload' ? srcById(d.source) : null;
    const items = evs.length ? evs.map(e => {
      const [icon, label, tone] = EVENTS[e.kind] || ['clock', e.kind, ''];
      return { icon, tone, label, by: e.by ? actorName(e.by) : e.kind === 'submitted' ? contributorName(d) : '', text: e.text, at: e.at };
    }) : [{ icon: src ? 'refresh' : 'upload', label: src ? `Synced from ${src.name}` : 'Added', by: src ? '' : d.addedBy || '', at: d.updated }];
    if (evs.length && lifeKey(d) === 'published' && evs.at(-1).kind !== 'unpublished') items.push({ icon: 'check-circle', tone: 'success', label: 'Published', at: Math.max(d.updated, evs.at(-1).at) });
    return `<ol class="cur-tl">${items.map(x => `<li class="cur-tl__item">${itemIcon(x.icon, x.tone, 'sm')}<div class="grow"><div class="t-sm"><span class="medium">${esc(x.label)}</span>${x.by ? ` · ${esc(x.by)}` : ''}</div>${x.text ? `<div class="cur-tl__text">“${esc(x.text)}”</div>` : ''}<div class="t-xs muted">${esc(fmtDateTime(x.at))}</div></div></li>`).join('')}</ol>`;
  }
  /** A document's progress, whatever its origin: Received → Reviewed → Published → Processed → Searchable. Publication and
      processing are independent, so either can be done while the other isn't; Searchable needs both.
      Each step: { label, state: done | current | issue | skipped | todo, text, at?, action?, busy? }. */
  function flowSteps(d) {
    const k = lifeKey(d), st = stageOf(d), sub = d.submission || {}, src = srcKey(d) !== 'upload' ? srcById(d.source) : null, kb = kbById(d.kb);
    const ev = kind => [...(sub.events || [])].reverse().find(e => e.kind === kind);
    const open = ['analyzing', 'review', 'changes'].includes(k), by = e => (e?.by ? ` by ${actorName(e.by)}` : '');
    const received = { state: 'done', at: sub.at || d.updated, text: sub.by ? `Contributed by ${actorName(sub.by)}` : src ? `Synced from ${src.name}` : `Uploaded by ${d.addedBy || 'an editor'}` };
    const reviewed = k === 'analyzing' || k === 'review' ? { state: 'current', text: 'Waiting for a reviewer' }
      : k === 'changes' ? { state: 'issue', text: `Changes requested${by(ev('changes'))}`, at: ev('changes')?.at }
        : k === 'rejected' ? { state: 'issue', text: `Declined${by(ev('rejected'))}`, at: ev('rejected')?.at }
          : ev('approved') ? { state: 'done', text: `Approved${by(ev('approved'))}`, at: ev('approved').at }
            : { state: 'skipped', text: src ? `Not needed: ${src.name} publishes automatically` : 'Not needed: added by an editor of the collection' };
    const who = kb ? X.whoCanSee(kb, docFolder(d)).label : '';
    const published = st === 'published' ? { state: 'done', text: who }
      : st === 'merged' ? { state: 'done', text: 'Published as a new version of another document' }
        : st === 'unpublished' ? { state: 'issue', text: 'Unpublished · readers don’t see it', action: X.res.canEditRes(d) || canReviewKb(kb) ? btn('Publish', { v: 'secondary', size: 'sm', icon: 'eye', act: 'cur-op', data: { id: d.id, op: 'republish' } }) : '' }
          : st === 'rejected' ? { state: 'skipped', text: 'Won’t be published' } : { state: 'todo', text: `After approval · ${who} will see it` };
    // Processed: read → classified → indexed, in one line, with what the pipeline chose.
    const v = res(d).version, p = processingOf(d), topics = res(d).topics;
    const pct = topics.length && topicsByPipeline(d) ? Math.round(topicConfidence(d, topics[0]) * 100) : null;
    const what = topics.length ? `${kindMeta(res(d).kind).label} · ${topics.map(topicName).join(', ')}${pct != null ? ` (${pct}%)` : ''}` : 'no topic found';
    const procBtn = canProcess(d) && canReviewKb(kb) ? btn(p === 'pending' ? 'Process' : 'Process again', { v: 'secondary', size: 'sm', icon: 'play', act: 'cur-op', data: { id: d.id, op: p === 'pending' ? 'process' : 'retry' } }) : '';
    const processed = open || st === 'rejected' || st === 'merged' ? { state: 'todo', text: open ? 'After approval, unless the reviewer processes it later' : 'Not processed' }
      : d.reclassifying ? { state: 'current', busy: true, text: 'Classifying again with the changed topics…' }
        : { pending: { state: 'todo', text: 'Not processed yet: search and the assistant can’t use it', action: procBtn },
          processing: { state: 'current', busy: true, text: 'Reading, classifying and indexing…' },
          ready: { state: 'done', text: `v${v} · ${what}${d.classCtx?.topics?.length ? ` · among ${plural(d.classCtx.topics.length, 'topic')} chosen for its run` : ''}${d.classCtx?.note ? ' · with context for the AI' : ''}`, at: d.processedAt },
          failed: { state: 'issue', text: d.error || 'Processing stopped partway', action: procBtn },
          outdated: { state: 'issue', text: `Changed at the source · v${v} still answers until it’s processed again`, action: procBtn },
          unsupported: { state: 'skipped', text: 'This file type can’t be processed' } }[p];
    const searchable = inSearch(d) ? { state: 'done', text: `In search and answers for ${who}` }
      : k === 'update' ? { state: 'done', text: `Answers use v${v} until the update is processed` }
        : { state: 'todo', text: st === 'published' ? 'Once it’s processed' : st === 'unpublished' && p === 'ready' ? 'Once it’s published' : 'Once it’s published and processed' };
    return [['Received', received], ['Reviewed', reviewed], ['Published', published], ['Processed', processed], ['Searchable', searchable]].map(([label, s]) => ({ label, ...s }));
  }
  /** current = waiting on someone (clock) or, when busy, work in progress (spinning loader). */
  const STEP_ICON = { done: ['check', 'success'], current: ['clock', 'accent'], issue: ['alert', 'warning'], skipped: ['minus', ''], todo: ['circle-dashed', ''] };
  const STEP_SR = { done: 'Done', current: 'In progress', issue: 'Needs attention', skipped: 'Skipped', todo: 'Not yet' };
  function stepper(d) {
    return `<ol class="flow-steps">${flowSteps(d).map(s => {
      const [icon, tone] = s.busy ? ['loader', 'accent'] : STEP_ICON[s.state];
      return `<li class="${cx('flow-steps__item', 'is-' + s.state, s.busy && 'is-busy')}"><span class="${cx('flow-steps__dot', tone && 'flow-steps__dot--' + tone)}" aria-hidden="true">${ic(icon, 'i-xs')}</span>
        <div class="grow"><div class="t-sm"><span class="medium">${esc(s.label)}</span><span class="sr-only">${esc(STEP_SR[s.state])}</span></div><div class="flow-steps__text">${esc(s.text)}${s.at ? `<span class="muted"> · ${esc(rel(s.at))}</span>` : ''}</div>${s.action ? `<div class="mt-8">${s.action}</div>` : ''}</div></li>`;
    }).join('')}</ol>`;
  }
  DR['cur-doc'] = ({ id }) => {
    const d = docById(id), kb = d && kbById(d.kb);
    if (!d || !kb || !canOpenDoc(d)) return { title: 'Document not available', body: emptyState({ icon: 'file', title: 'This document isn’t available', desc: 'It may have been moved to a collection you don’t look after.' }) };
    const l = lifecycleOf(d), { main } = opsFor(d), k = l.key;
    const opBtn = (op, v = 'secondary') => btn(OPS[op].label, { v, icon: OPS[op].icon, act: 'cur-op', data: { id: d.id, op } });
    const last = [...(d.submission?.events || [])].reverse().find(e => ['changes', 'rejected', 'unpublished'].includes(e.kind));
    // The chip names the state; one note says why and what fixes it (never a second title repeating the chip).
    const fixHint = main === 'source' ? ' Remove the password at the source, then sync again.' : main === 'replace' ? ' Replace the file with a copy without a password.' : '';
    const saysFix = /remove the password|copy without|sync again|try again/i.test(d.error || '');
    const note = k === 'failed' ? alertBox('danger', '', esc((d.error || 'Processing stopped partway. Try again.') + (isLocked(d) && !saysFix ? fixHint : '')))
      : k === 'merged' && d.mergedInto ? alertBox('success', '', esc(`It replaced the earlier version of “${docById(d.mergedInto)?.name || 'a document'}”.`))
        : ['changes', 'rejected', 'unpublished'].includes(k) && last?.text ? `<blockquote class="cur-tl__text">“${esc(last.text)}” — ${esc(actorName(last.by))}</blockquote>` : '';
    const published = stageOf(d) === 'published';
    const events = (d.submission?.events || []).length;
    const body = `<div class="drawer__section"><div class="row gap-8 wrap">${lifeChip(d)}</div>${note ? `<div class="mt-12">${note}</div>` : ''}</div>
      <div class="drawer__section"><h3 class="drawer__section-title">Progress</h3>${stepper(d)}</div>
      <div class="drawer__section">${disclosure({ path: 'curDocHistory', title: 'History', icon: 'history', summary: events ? plural(events, 'event') : '', body: timeline(d) })}</div>
      <div class="drawer__section"><h3 class="drawer__section-title">Details</h3>${published ? X.res.details(d) : kv([
        ['Collection', `<span class="stack gap-2"><a class="link" href="#${canEditKb(kb) ? kbContentsHref(kb, docFolder(d) || '') : kbHref(kb)}">${esc(kb.name)}</a>${docFolder(d) ? `<span class="t-xs muted" translate="no">${esc(folderPath(docFolder(d)).map(f => f.name).join(' › '))}</span>` : ''}</span>`],
        ['Contributor', esc(contributorName(d))],
        ['Type', esc(kindMeta(res(d).kind).label)],
        ['Size', `${esc(fmtSize(d.size))} · ${plural(d.pages || 1, 'page')}`],
        ['Version', `v${res(d).version}`],
        ['Who could see it', `<span class="row gap-6">${ic(X.whoCanSee(kb, docFolder(d)).icon, 'i-sm muted')}${esc(X.whoCanSee(kb, docFolder(d)).label)}</span>`],
      ])}</div>`;
    return {
      title: d.name, lead: fileIcon(d.type, 'lg'), desc: esc(kb.name), size: 'lg', body,
      headActions: iconBtn('more', 'More actions', { menu: 'cur-row', data: { id: d.id, ctx: 'drawer' } }),
      foot: opBtn(main, 'primary'),
    };
  };
})();

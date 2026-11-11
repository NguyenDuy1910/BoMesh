/* Knowledge Studio (/studio) — Manage → Knowledge Studio: the one place knowledge is run.
   Two groups of tabs, one row:
     daily work   Review (one workbench for everything that needs a person, picked with a queue chooser:
                  To publish — Submissions · Sync batches · Publishing problems; To keep right — Topics to confirm ·
                  Re-verification due · Missing details · Possible duplicates) · Library (every document whatever its
                  origin, along the flow: In review → Publishing → Published, plus Needs attention and Not published)
     setup        Knowledge bases (where documents live, who reads them) · Taxonomy (how they're classified) ·
                  Sources (what comes in, how often, how it's published; with the accounts it signs in with)
   The setup group is in the order it's done the first time; the setup guide (X.setupGuide) walks it.
   Tabs show only to people who can use them (X.studioTabs); bodies come from governance.js (X.gov.queue — the
   "To keep right" queues), knowledge.js (X.kb.tab), masterdata.js (X.md.tab) and sources.js (X.src.tab).
   Scope of review: documents in the knowledge bases the caller owns (workspace admins own all) — curatedDocs().
   Readers never see any of this. Every document row opens the same drawer (cur-doc), which shows where the
   document is in the flow; a row shows its state's fix.
   Exports: X.reviewNotices(), X.studioTabs(), X.studioBadge(), X.setupGuide(), X.reviewQueues() (counts per queue,
   for Overview → Knowledge health). Actions: cur-*. Menu: cur-row. Drawers: cur-doc, cur-compare.
   Modals: cur-decide, rb-pii. Batch actions: rb-*. Model: core/lifecycle.js. */
(() => {
  'use strict';

  const BASE = '/studio';
  /** [id, label, group, who may use it]. Setup is listed in the order it's done: where → how classified → what comes in. */
  const TAB_DEFS = [
    ['review', 'Review', 'work', () => can('knowledge.manage') && canReview()],
    ['library', 'Library', 'work', () => can('knowledge.manage') && canReview()],
    ['bases', 'Knowledge bases', 'setup', () => canManageKbs()],
    ['taxonomy', 'Taxonomy', 'setup', () => canManageTaxonomy()],
    ['sources', 'Sources', 'setup', () => can('source.manage')],
  ];
  /** Old tab ids: Documents → Library, Master data/Topics → Taxonomy, Quality (and Knowledge health's tabs) → Review queues. */
  const TAB_ALIAS = { all: 'library', documents: 'library', master: 'taxonomy', topics: 'taxonomy', quality: 'review', details: 'review', duplicates: 'review' };
  /** Review queues: [id, label, group]. To publish = decisions before documents reach people; to keep right = published ones. */
  const QUEUES = [
    ['submissions', 'Submissions', 'publish'], ['batches', 'Sync batches', 'publish'], ['problems', 'Publishing problems', 'publish'],
    ['confirm', 'Topics to confirm', 'keep'], ['reverify', 'Re-verification due', 'keep'], ['details', 'Missing details', 'keep'], ['duplicates', 'Possible duplicates', 'keep'],
  ];
  const QIDS = QUEUES.map(q => q[0]), KEEP = QUEUES.filter(q => q[2] === 'keep').map(q => q[0]);
  const QUEUE_GROUPS = [['publish', 'To publish'], ['keep', 'To keep right']];
  const QK = 'curQ', PK = 'curProb', AK = 'curAll', PER = 25;
  const names = list => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${plural(list.length - 2, 'other')}`);
  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  const lifeKey = d => lifecycleOf(d).key;
  const isLocked = d => /password/i.test(d.error || '');
  const analyzing = d => d.ai?.status === 'analyzing';
  const flagsOf = d => aiOf(d).flags || [];
  const hasFlag = (d, type) => flagsOf(d).some(f => f.type === type);
  const srcKey = d => (d.source && d.source !== 'upload' ? d.source : 'upload');
  /** Where a document came from: its source, a person's contribution, or an editor's upload (the Library's Origin). */
  const originKey = d => (srcKey(d) !== 'upload' ? d.source : d.submission?.by ? 'contrib' : 'upload');
  const drafts = () => ui('curDraft');
  const tabsAllowed = () => TAB_DEFS.filter(t => t[3]()).map(t => t[0]);
  X.studioTabs = tabsAllowed;
  /** Broken sources and accounts (each root cause once): what the Sources tab counts. */
  const sourceProblems = () => (can('source.manage') ? (X.srcBadge?.() || 0) + (X.accBadge?.() || 0) : 0);
  /** Access requests a base owner decides here (workspace admins decide them in People). */
  const ownerRequests = () => (can('user.manage') ? 0 : pendingRequests().filter(r => kbRole(kbById(r.kb)) === 'owner').length);
  /** Approved documents that stopped on the way to people: couldn't publish, changed at the source, waiting to publish. */
  const PROBLEM_KEYS = ['failed', 'update', 'queued'];
  const problemDocs = () => curatedDocs().filter(d => PROBLEM_KEYS.includes(lifeKey(d)));
  /** Decisions waiting before documents reach people (the To publish queues): what the Review tab and the Studio badge count. */
  const decisionCount = () => reviewQueue().length + openBatches().length + problemDocs().length;
  /** Items per Review queue. Topics to confirm counts documents (decided per group). */
  function queueCounts() {
    const g = X.gov?.counts?.() || {};
    return { submissions: reviewQueue().length, batches: openBatches().length, problems: problemDocs().length, confirm: g.confirm || 0, reverify: g.reverify || 0, details: g.details || 0, duplicates: g.duplicates || 0 };
  }
  /** For Overview → Knowledge health: counts per queue, empty when the caller doesn't review. */
  X.reviewQueues = () => (can('knowledge.manage') && canReview() ? queueCounts() : {});
  /** The tab the Studio opens on: what needs the caller first — the queue, then something broken, then the inventory. */
  function landing() {
    const ok = tabsAllowed();
    if (ok.includes('review') && decisionCount()) return 'review';
    if (ok.includes('sources') && sourceProblems()) return 'sources';
    return ok[0] || 'review';
  }
  function tabOf(query) {
    const t = TAB_ALIAS[query.tab] || query.tab;
    return tabsAllowed().includes(t) ? t : landing();
  }
  /** The open Review queue: ?queue= (legacy ?seg= / Knowledge health tabs / `quality` → the first quality queue with items),
      a ?sel= of a batch or submission, else the first queue with items. */
  function queueOf(query, counts = queueCounts()) {
    let q = query.queue || query.seg || (query.tab === 'details' || query.tab === 'duplicates' ? query.tab : '');
    if (q === 'review') q = 'reverify';
    if (q === 'quality') q = KEEP.find(k => counts[k]) || 'reverify';
    if (QIDS.includes(q)) return q;
    if (query.sel) return batchById(query.sel) ? 'batches' : 'submissions';
    return QIDS.find(k => counts[k]) || 'submissions';
  }
  /** The sidebar badge counts what the landing tab shows (Review: the To publish decisions). */
  X.studioBadge = () => {
    const l = landing();
    if (l === 'review') return { n: decisionCount(), tone: 'accent' };
    if (l === 'sources') return { n: sourceProblems(), tone: 'danger' };
    return { n: ownerRequests(), tone: 'accent' };
  };
  const onReview = () => S.cur?.r.page === 'studio' && tabOf(S.cur.query) === 'review';
  const onSplit = kind => onReview() && queueOf(S.cur.query) === kind;

  /* ═══════════════ Badges and inbox ═══════════════ */
  X.reviewNotices = () => {
    if (!can('knowledge.manage') || !canReview()) return [];
    const out = [], q = reviewQueue();
    if (q.length) out.push({ id: 'cur-queue-' + q.length, icon: 'clock', tone: 'info', title: `${plural(q.length, 'document')} ${q.length === 1 ? 'is' : 'are'} waiting for your review`, body: names(q.map(d => d.name)), at: Math.max(...q.map(d => lastEvent(d).at)), to: studioHref('review', { queue: 'submissions' }), cta: 'Review' });
    // Workspace admins already get one notice per base with failed publishes.
    if (!isAdmin()) reviewableKbs().forEach(kb => {
      const failed = curatedDocs().filter(d => d.kb === kb.id && lifeKey(d) === 'failed');
      if (failed.length) out.push({ id: `cur-failed-${kb.id}-${failed.length}`, icon: 'alert-circle', tone: 'warn', title: `${plural(failed.length, 'document')} in ${kb.name} couldn’t be published`, body: failed.map(d => d.name).join(', '), at: Math.max(...failed.map(d => d.updated)), to: studioHref('review', { queue: 'problems', kb: kb.id }) });
    });
    return out;
  };

  /* ═══════════════ Setup guide ═══════════════ */
  /** The first-time order, one step per setup tab, then the first sync. Each step: done, what it decides, where. */
  function setupSteps() {
    const kbs = D.kbs.filter(k => !k.archived && !k.personal), leaves = (D.topics || []).filter(t => t.parent && !t.archived);
    const keyed = leaves.filter(t => topicKeywords(t).length).length;
    const synced = D.sources.some(s => s.last?.at) || D.docs.some(d => d.source && d.source !== 'upload' && d.status === 'ready');
    return [
      { id: 'bases', done: kbs.length > 0, title: 'Create knowledge bases', desc: 'Where documents live and who can read them. Make one per access boundary — a team, a function, the whole company.', cta: 'Create knowledge base', act: 'kb-create' },
      { id: 'taxonomy', done: !!(D.masterImports || []).length || (leaves.length && keyed / leaves.length >= 0.8), title: 'Load the taxonomy', desc: 'The domains and topics documents are filed under, with the words that recognise them. Import them before the first sync, so every document is classified as it arrives.', cta: 'Import taxonomy', act: 'md-import' },
      { id: 'sources', done: D.sources.length > 0, title: 'Connect sources', desc: 'Pick the folders, the knowledge base they land in, how often they sync and how documents are published.', cta: 'Connect source', act: 'src-connect' },
      { id: 'sync', done: synced, title: 'Check the first sync', desc: 'Watch it read, classify and publish. Review what the assistant wasn’t sure about, then let the schedule take over.', cta: 'Open Sources', href: studioHref('sources') },
    ];
  }
  /** The guide while setup is unfinished (admins). force: a brand-new workspace (the prototype's Empty state) — every step to do. */
  X.setupGuide = ({ force = false } = {}) => {
    if (!isAdmin()) return '';
    const steps = setupSteps().map(s => (force ? { ...s, done: false } : s)), left = steps.filter(s => !s.done);
    if (!left.length) return '';
    const next = left[0], done = steps.length - left.length;
    const rows = steps.map((s, i) => {
      // Secondary: the page header keeps the one primary; the guide only names the next step.
      const now = s === next, action = now ? btn(s.cta, { v: 'secondary', size: 'sm', act: s.act, href: s.href }) : '';
      return `<li class="${cx('setup__step', s.done && 'is-done', now && 'is-next')}"><span class="setup__num" aria-hidden="true">${s.done ? ic('check', 'i-xs') : i + 1}</span>
        <div class="grow"><div class="setup__title">${esc(s.title)}${s.done ? '<span class="sr-only">Done</span>' : ''}</div>${s.done ? '' : `<p class="setup__desc">${esc(s.desc)}</p>`}</div>${action}</li>`;
    }).join('');
    return `<section class="setup card" aria-label="Set up knowledge"><div class="setup__head"><div class="grow"><h2 class="setup__heading">Set up knowledge</h2><p class="setup__sub"><span>${esc(`${done} of ${steps.length} done`)}</span><span aria-hidden="true"> · </span><span>Where documents live, how they’re classified, then what comes in.</span></p></div><div class="setup__bar">${progress(done / steps.length * 100, 'success', 'Setup progress')}</div></div><ol class="setup__steps">${rows}</ol></section>`;
  };

  /* ═══════════════ Page ═══════════════ */
  /** The page's one primary action follows the tab: add documents while working, create, import or connect while setting up. */
  function headerAction(tab) {
    const upKb = S.ui[AK]?.kb;
    // On Review the decision bar is the primary; adding documents stays secondary there.
    if ((tab === 'review' || tab === 'library') && canContribute()) return btn('Add documents', { v: tab === 'library' ? 'primary' : 'secondary', icon: 'upload', act: 'contribute', data: upKb ? { kb: upKb } : undefined });
    if (tab === 'bases' && can('knowledge.manage')) return btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'kb-create' });
    if (tab === 'taxonomy') return btn('Import', { v: 'primary', icon: 'upload', act: 'md-import' });
    if (tab === 'sources') return btn('Connect source', { v: 'primary', icon: 'plus', act: 'src-connect' });
    return '';
  }
  P.studio = ({ query }) => {
    crumbs([{ label: 'Knowledge Studio' }]);
    const allowed = tabsAllowed();
    if (!allowed.length) return noAccessPage();
    const tab = tabOf(query);
    // The tabs say where you are; a description under the title would repeat it on every visit.
    const head = pageHeader({ title: 'Knowledge Studio', extra: X.res.demoChip(), actions: headerAction(tab) });
    const COUNTS = {
      review: { count: decisionCount() || '', alert: true },
      bases: { count: ownerRequests() || '', alert: true },
      // Only workspace admins change the taxonomy, so only they get the tab (and the proposed topics to decide).
      taxonomy: { count: X.md?.proposalCount?.() || '' },
      sources: { count: sourceProblems() || '', alert: true, tone: 'danger' },
    };
    const defs = TAB_DEFS.filter(t => allowed.includes(t[0]));
    const work = defs.filter(t => t[2] === 'work'), setup = defs.filter(t => t[2] === 'setup');
    const item = ([id, label]) => ({ id, label, ...COUNTS[id] });
    const tabList = [...work.map(item), ...(work.length && setup.length ? [{ sep: true }] : []), ...setup.map(item)];
    const body = tab === 'review' ? reviewTab(query)
      : tab === 'library' ? libraryTab(query)
        : tab === 'bases' ? X.kb?.tab?.({ query })
          : tab === 'taxonomy' ? X.md?.tab?.({ query })
            : X.src?.tab?.({ query });
    // While setup is unfinished, the guide leads every tab of the setup group (it names the next step and its action).
    const guide = TAB_DEFS.find(t => t[0] === tab)?.[2] === 'setup' ? X.setupGuide() : '';
    return `<div class="page page--studio cur">${head}${defs.length > 1 ? contextBar(tabs(tabList, tab, BASE)) : ''}${guide}${body ?? skelRows(6)}</div>`;
  };
  const prevAfter = AFTER.studio;
  AFTER.studio = args => {
    prevAfter?.(args);
    const { query } = args;
    // Old addresses the router didn't rewrite (?tab=all|master|details|duplicates, ?seg=, ?queue=quality) land on the
    // canonical one, so the tabs, the queue chooser and Back agree.
    const legacyTab = !!TAB_ALIAS[query.tab];
    const legacyQueue = tabOf(query) === 'review' && (!!query.seg || query.queue === 'quality' || query.tab === 'details' || query.tab === 'duplicates');
    if (!legacyTab && !legacyQueue) return;
    const q = { ...query, tab: tabOf(query) };
    if (legacyQueue) q.queue = queueOf(query);
    delete q.seg;
    history.replaceState(null, '', '#' + BASE + '?' + new URLSearchParams(q));
    S.cur.query = q;
  };

  /* ═══════════════ Review: the workbench ═══════════════ */
  /** The queue chooser: pills in two labelled groups with their counts (To publish counts are decisions and stand out;
      To keep right counts are quiet). Empty queues hide unless open. Phones get one select. Hidden with a single queue. */
  function chooser(cur, counts) {
    const shown = QUEUES.filter(([id]) => counts[id] || id === cur);
    if (shown.length < 2) return '';
    const pill = ([id, label, g]) => {
      const n = counts[id] || 0;
      return `<button type="button" class="${cx('rq__pill', n && g === 'publish' && 'rq__pill--due')}" aria-pressed="${id === cur}" data-act="cur-queue" data-value="${id}">${esc(label)}${n ? `<span class="rq__n num">${fmtNum(n)}</span>` : ''}</button>`;
    };
    const groups = QUEUE_GROUPS.map(([g, label]) => {
      const items = shown.filter(q => q[2] === g); if (!items.length) return '';
      return `<div class="rq__group" role="group" aria-labelledby="rq-${g}"><span class="rq__label" id="rq-${g}">${esc(label)}</span><div class="rq__pills">${items.map(pill).join('')}</div></div>`;
    }).join('');
    const opts = QUEUE_GROUPS.map(([g, label]) => {
      const items = shown.filter(q => q[2] === g); if (!items.length) return '';
      return `<optgroup label="${esc(label)}">${items.map(([id, l]) => `<option value="${id}" ${id === cur ? 'selected' : ''}>${esc(counts[id] ? `${l} · ${fmtNum(counts[id])}` : l)}</option>`).join('')}</optgroup>`;
    }).join('');
    return `<div class="rq"><div class="rq__groups">${groups}</div><select class="select select--sm rq__select" data-change="cur-queue" aria-label="Review queue">${opts}</select></div>`;
  }
  A['cur-queue'] = el => {
    const v = el.tagName === 'SELECT' ? el.value : el.dataset.value; if (!QIDS.includes(v)) return;
    [QK, PK, 'khReview', 'khDetails'].forEach(k => { if (S.ui[k]) { S.ui[k].sel = {}; S.ui[k].page = 1; } });
    setQuery({ tab: 'review', queue: v, sel: '', seg: '' });
  };
  /** A queue that's done: say so, and point at the next queue with something in it. */
  function queueDone(id, counts) {
    const next = QUEUES.find(([q]) => q !== id && counts[q]);
    const COPY = {
      submissions: ['You’re all caught up', 'New submissions to your knowledge bases show up here.'],
      batches: ['No batches waiting', 'When a first sync holds files back, they show up here, one decision per reason.'],
      problems: ['Everything approved is published', 'Documents that couldn’t publish or changed at their source show up here with their fix.'],
    };
    const [title, desc] = COPY[id] || COPY.submissions;
    const action = next ? btn(`Next: ${next[1]}`, { icon: 'arrow-right', act: 'cur-queue', data: { value: next[0] } }) : btn('Open the library', { href: studioHref('library') });
    return emptyState({ icon: 'check-circle', tone: 'success', title, desc, actions: action, boxed: true });
  }

  /* ── Submissions ── */
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
  /** Open batches (first syncs at scale), one decision each. */
  function batchRows() { const rows = openBatches(); return { rows, order: rows.map(b => b.id) }; }
  const splitRows = kind => (kind === 'batches' ? batchRows() : queueRows());
  /** The open entry: ?sel when it's in the list, else the first. */
  function currentId({ order }) { const s = S.cur?.query.sel; return order.includes(s) ? s : order[0] || ''; }
  /** The entry to open after deciding `skip` in a split queue: the next one down, else the one above. */
  function nextEntry(skip, kind) {
    const q = splitRows(kind), i = q.order.indexOf(currentId(q));
    return q.order.slice(i + 1).find(id => !skip.has(id)) || q.order.slice(0, Math.max(0, i)).reverse().find(id => !skip.has(id)) || '';
  }

  /** The reviewer's working copy of the assistant's suggestion (reset when the document is analyzed again). */
  function draftOf(d) {
    const ai = aiOf(d); if (ai.status !== 'done') return null;
    let f = drafts()[d.id];
    if (!f || f.at !== ai.at) f = drafts()[d.id] = { at: ai.at, kind: ai.kind.value, topics: ai.topics.map(t => t.id), kb: d.kb, summary: ai.summary || '', asVersionOf: '' };
    return f;
  }
  const decisionOf = d => { const f = draftOf(d); return f ? { kind: f.kind, topics: [...f.topics], kb: f.kb, summary: f.summary.trim(), asVersionOf: f.asVersionOf || undefined } : {}; };

  function confBadge(c, edited) {
    if (edited) return '<span class="cur-conf cur-conf--edited">Edited</span>';
    if (c == null) return '';
    const p = Math.round(c * 100);
    return `<span class="cur-conf cur-conf--${p >= 80 ? 'hi' : p >= 60 ? 'mid' : 'lo'}" data-tip="Assistant confidence">${p}%</span>`;
  }
  /** Blocking risks get a labelled chip (readable on touch); informational signals stay a small icon with a tooltip. */
  const FLAG_META = { duplicate: ['copy', 'Possible duplicate', 'warning', true], personal: ['shield', 'Personal data', 'danger', true], version: ['history', 'New version', 'accent'], format: ['file', 'Can’t be searched', 'default'] };
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
  function queuePanel({ all, rows }, cur) {
    const u = ui(QK), f = u.f || 'all', filtered = f !== 'all' || !!u.kb, long = all.length > MANY;
    const canFilter = filtered || queueKbs(all).length > 1 || FILTERS.some(([k]) => k !== 'all' && all.some(FILTER_FN[k]));
    const fLabel = [f !== 'all' && FILTERS.find(([k]) => k === f)?.[1], u.kb && kbById(u.kb)?.name].filter(Boolean).join(' · ');
    const filter = (long || filtered) && canFilter ? `<button type="button" class="${cx('filter-button', filtered && 'is-set')}" data-menu="cur-qfilter" aria-haspopup="menu" aria-expanded="false">${filtered ? '' : ic('filter')}<span class="truncate">${esc(fLabel || 'Filter')}</span>${ic('chevron-down')}</button>` : '';
    const search = long || u.q ? searchField({ uiKey: QK, placeholder: 'Search submissions' }) : '';
    const tools = search || filter ? `<div class="cur-queue__tools">${search}${filter ? `<div class="cur-queue__filters">${filter}</div>` : ''}</div>` : '';
    // With a selection, the floating bulk bar (queueBulk) carries the decisions; this row only offers Select all.
    const ids = rows.map(d => d.id), n = ids.filter(id => u.sel?.[id]).length;
    const selRow = n ? `<div class="cur-queue__sel">${checkbox({ checked: n === ids.length, indeterminate: n < ids.length, act: 'sel-all', data: { ui: QK, ids: ids.join(',') }, aria: 'Select all', label: n === ids.length ? 'All selected' : `Select all ${fmtNum(ids.length)}` })}</div>` : '';
    const items = rows.map(d => queueItem(d, d.id === cur)).join('');
    const list = items ? `<div class="cur-queue__list" id="cur-queue" data-keep-scroll role="list">${items}</div>` : `<div class="cur-queue__none">${noMatches(QK, ['f', 'kb'], 'submissions')}</div>`;
    return `<div class="${cx('cur-queue', n && 'has-sel')}">${tools}${selRow}${list}</div>`;
  }
  /** Batches are few (one per reason per first sync): no tools, no selection — each is already one decision for many. */
  function batchList({ rows }, cur) {
    return `<div class="cur-queue"><div class="cur-queue__list" id="cur-queue" data-keep-scroll role="list">${rows.map(b => batchItem(b, b.id === cur)).join('')}</div></div>`;
  }
  /** The queue's bulk decisions, in the same floating bar the Library and the other queues use. */
  const queueBulk = () => bulkBar(QK, btn('Decline…', { v: 'ghost', size: 'sm', icon: 'x-circle', act: 'cur-bulk-decline' }) + btn('Approve & publish', { v: 'secondary', size: 'sm', icon: 'check', act: 'cur-bulk-approve' }));
  MENUS['cur-qfilter'] = () => {
    const u = ui(QK), all = reviewQueue(), f = u.f || 'all', kbs = queueKbs(all);
    const set = (k, v) => { u[k] = v; refresh(); };
    const show = FILTERS.filter(([k]) => k === 'all' || k === f || all.some(FILTER_FN[k]))
      .map(([k, l]) => ({ label: l, meta: fmtNum(all.filter(FILTER_FN[k]).length), checked: f === k, run: () => set('f', k) }));
    const bases = kbs.length > 1 || u.kb ? [{ section: 'Knowledge base' }, { label: 'All knowledge bases', checked: !u.kb, run: () => set('kb', '') }, ...kbs.map(k => ({ label: k.name, checked: u.kb === k.id, run: () => set('kb', k.id) }))] : [];
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
      return '';
    }).filter(Boolean);
    return out.length ? `<ul class="cur-risks" aria-label="What the assistant found">${out.join('')}</ul>` : '';
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
    const ai = aiOf(d), from = ai.confirmed ? 'Confirmed by the contributor. Check before you publish.' : `Matched against ${esc(curWs().name)}’s taxonomy. Check and edit before you publish.`;
    const sec = body => `<section class="cur-insp__sec cur-sugs" aria-labelledby="cur-cls-h"><h3 class="cur-insp__h" id="cur-cls-h">Classification</h3><p class="cur-insp__sub">${from}</p>${body}</section>`;
    if (!f) return sec(`<div class="cur-analyzing">${spinner()}<span>Reading the file and matching it against your taxonomy…</span></div>`);
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
    const topics = sugRow('Topics', '', `<div class="cur-topics">${chipsHtml || '<span class="t-sm muted">No topic suggested</span>'}${addOpts.length > 1 ? select({ id: 'cur-add-topic', value: '', options: addOpts, change: 'cur-topic-add', size: 'sm', cls: 'cur-add-topic', label: 'Add topic', attrs: `data-id="${d.id}"` }) : ''}</div>`, why ? `<ul class="cur-why" aria-label="Why these topics">${why}</ul>` : '');
    // Proposed new topics are decided in one place, Knowledge Studio → Taxonomy (workspace admins); publishing never waits for them.
    const props = (ai.proposed || []).map(proposalById).filter(p => p && p.status === 'open');
    const decideIn = canManageTaxonomy() ? `<a class="link" href="#${studioHref('taxonomy')}">Decide in Taxonomy</a>` : '<span>A workspace admin decides.</span>';
    const proposed = props.length ? `<div class="cur-prop-note">${ic('sparkles', 'i-xs')}<div><span>${props.length === 1 ? 'Suggests a new topic:' : 'Suggests new topics:'}</span> ${props.map(p => `<span class="medium">${esc(p.name)}</span>`).join(', ')}<br><span>You can publish without it.</span> ${decideIn}</div></div>` : '';
    // Knowledge base: where it lives decides who can see it.
    const version = !!(f.asVersionOf || d.submission?.versionOf);
    const kbs = reviewableKbs().filter(k => k.contribute !== false || k.id === d.kb);
    const target = kbById(version ? docById(f.asVersionOf || d.submission.versionOf)?.kb : f.kb) || kbById(d.kb), who = X.whoCanSee(target);
    const kbBadge = version ? '' : ai.kb.by === 'ai' ? confBadge(ai.kb.conf, f.kb !== ai.kb.id) : f.kb !== d.kb ? confBadge(null, true) : byContributor;
    const kbCtl = version ? `<div class="cur-fixed">${X.kbMark(target, 20)}<span class="truncate">${esc(target.name)}</span></div>` : select({ id: 'cur-kb', bind: `curDraft.${d.id}.kb`, value: f.kb, options: kbs.map(k => [k.id, k.name]), change: 'cur-redraw', size: 'sm', label: 'Knowledge base' });
    const kb = sugRow('Knowledge base', kbBadge, kbCtl, `<div class="cur-who">${ic(who.icon, 'i-xs')}<span>${version ? 'Same as the current version · ' : ''}${esc(who.label)} will see it</span></div>`);
    const summary = sugRow('Summary', confBadge(null, f.summary.trim() !== (ai.summary || '').trim()), textarea({ id: 'cur-sum-' + d.id, bind: `curDraft.${d.id}.summary`, value: f.summary, rows: 3, attrs: 'maxlength="280" aria-label="Summary"' }));
    return sec(`<div class="cur-sug-list">${type}${topics}${proposed}${kb}${summary}</div>`);
  }
  function decisionBar(d, f) {
    const v = f && (f.asVersionOf || d.submission?.versionOf), o = v && docById(v);
    const target = f && kbById(f.kb), hint = !f ? 'Waiting for the assistant…' : o ? `Publishes v${res(o).version + 1} of “${o.name}”` : `Publishes to ${target?.name || ''} · ${target ? X.whoCanSee(target).label : ''}`;
    return `<footer class="cur-decide" role="group" aria-label="Decision">
      <span class="cur-decide__hint truncate" data-tip="${esc(hint)}">${esc(hint)}</span>
      <div class="cur-decide__btns">${btn('Decline', { v: 'ghost', act: 'cur-decline', data: { id: d.id } })}${btn('Request changes', { icon: 'pencil', act: 'cur-changes', data: { id: d.id } })}
      ${btn(f ? 'Approve & publish' : 'Analyzing…', { v: 'primary', icon: f ? 'check' : '', act: 'cur-approve', data: { id: d.id }, disabled: !f, loading: !f })}</div>
    </footer>`;
  }
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

  /* ── The workbench: chooser, then the open queue ── */
  function reviewTab(query) {
    const caughtUp = () => emptyState({ icon: 'check-circle', tone: 'success', title: 'You’re all caught up', desc: 'Submissions, sync batches, publishing problems and quality checks show up here.', actions: btn('Open the library', { href: studioHref('library') }), boxed: true });
    return gate({
      loading: () => `<div class="cur-split cur-wb"><div class="cur-queue">${skelRows(6)}</div><div class="cur-pane">${skelRows(3)}</div><div class="cur-detail cur-insp">${skelRows(3)}</div></div>`,
      empty: caughtUp,
      ok: () => {
        // ?kb= (from a knowledge base page or a notice) preselects the base filter of Submissions and Publishing problems.
        const qkb = query.kb || '';
        [[QK, { q: '', f: 'all', kb: '', sel: {} }], [PK, { q: '', kb: '', life: '', sort: { key: 'updated', dir: 'desc' }, page: 1, sel: {} }]].forEach(([k, init]) => {
          const u = ui(k, init); if (u._kb !== qkb) { u._kb = qkb; u.kb = qkb; }
        });
        const counts = queueCounts(), id = queueOf(query, counts);
        if (!QIDS.some(k => counts[k]) && !query.queue) return caughtUp();
        const body = id === 'submissions' ? submissionsQueue(query, counts)
          : id === 'batches' ? batchesQueue(query, counts)
            : id === 'problems' ? problemsQueue(counts)
              : X.gov?.queue?.(id) ?? skelRows(4);
        return chooser(id, counts) + body;
      },
    });
  }
  function submissionsQueue(query, counts) {
    const q = queueRows();
    if (!q.all.length) return queueDone('submissions', counts);
    const u = ui(QK), live = new Set(q.all.map(d => d.id));
    u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
    const cur = currentId(q), d = docById(cur), pos = q.order.indexOf(cur), total = q.order.length;
    const open = !!query.sel && cur === query.sel, selecting = selCount(QK) > 0;
    return `<div class="${cx('cur-split', 'cur-wb', open && 'has-sel')}">${queuePanel(q, cur)}${d ? detailPanel(d, pos, total, selecting) : '<div class="cur-pane"></div><div class="cur-detail cur-insp"></div>'}</div>${queueBulk()}`;
  }
  function batchesQueue(query, counts) {
    const q = batchRows();
    if (!q.rows.length) return queueDone('batches', counts);
    const cur = currentId(q), b = batchById(cur), open = !!query.sel && cur === query.sel;
    return `<div class="${cx('cur-split', 'cur-split--batch', open && 'has-sel')}">${batchList(q, cur)}${batchDetail(b, q.order.indexOf(cur), q.order.length)}</div>`;
  }

  /* ── Publishing problems: approved documents that didn't reach people, each with its fix ── */
  const PROBLEM_OPTS = [['failed', 'Couldn’t publish'], ['update', 'Changed at the source'], ['queued', 'Waiting to publish']];
  function problemsQueue(counts) {
    const u = ui(PK), docs = problemDocs();
    if (!docs.length) return queueDone('problems', counts);
    const live = new Set(docs.map(d => d.id));
    u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
    const kbOpts = queueKbs(docs).map(k => [k.id, k.name]), lifeOpts = PROBLEM_OPTS.filter(([k]) => docs.some(d => lifeKey(d) === k));
    const tools = needsTools(docs.length, PK, ['kb', 'life'])
      ? `<div class="toolbar">${searchField({ uiKey: PK, placeholder: 'Search documents' })}${lifeOpts.length > 1 || u.life ? filterButton('Problem', PK, 'life', lifeOpts) : ''}${kbOpts.length > 1 || u.kb ? filterButton('Knowledge base', PK, 'kb', kbOpts) : ''}${clearFilters(PK, ['kb', 'life'])}</div>` : '';
    const hint = '<p class="gov-summary">Approved, but not in front of people yet. Each row shows its fix; select several to publish them together.</p>';
    let rows = docs.filter(d => (!u.kb || d.kb === u.kb) && (!u.life || lifeKey(d) === u.life) && matchesQ(PK, d.name, kbById(d.kb)?.name, originName(d)));
    rows = applySort(rows, PK, SORTERS);
    if (!rows.length) return hint + tools + noMatches(PK, ['kb', 'life'], 'documents');
    const page = paginate(rows, PK, PER);
    const head = `${selAllCheck(PK, page.map(d => d.id))}${sortHead('Name', 'name', PK)}${th('Problem')}${th('Origin', 'table__column--hide-sm')}${sortHead('Updated', 'updated', PK)}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
    const bulk = bulkBar(PK, btn('Publish', { v: 'ghost', size: 'sm', icon: 'upload', act: 'cur-prob-publish' }));
    return hint + tools + `<div class="cur-prob">${table({ label: 'Publishing problems', head, rows: page.map(problemRow), foot: pager(rows.length, PK, PER) })}</div>` + bulk;
  }
  function problemRow(d) {
    const on = !!ui(PK).sel?.[d.id], why = lifeKey(d) === 'failed' ? d.error || 'Publishing stopped partway.' : lifecycleOf(d).desc;
    return `<tr class="table__row" data-act="cur-doc" data-id="${d.id}" tabindex="0" ${on ? 'aria-selected="true"' : ''}>
      ${selCheck(PK, d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc(kbById(d.kb)?.name || '')}</div></div></div></td>
      <td class="table__cell"><div class="stack gap-2">${lifeChip(d, 'sm')}<span class="cell-sub cur-prob__why" data-tip="${esc(why)}">${esc(why)}</span></div></td>
      <td class="table__cell table__cell--hide-sm">${originCell(d)}</td>
      <td class="table__cell muted cur-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${rowFix(d)}<span class="reveal-on-hover">${iconBtn('more', 'More actions', { size: 'sm', menu: 'cur-row', data: { id: d.id, ctx: 'row' } })}</span></div></td></tr>`;
  }
  A['cur-prob-publish'] = () => bulkPublish(PK);

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
  /** J/K and the detail's arrows move through the open split queue (Submissions or Sync batches). */
  function step(dir) {
    const kind = queueOf(S.cur.query); if (kind !== 'submissions' && kind !== 'batches') return;
    const q = splitRows(kind), { order } = q; if (!order.length) return;
    const i = order.indexOf(currentId(q)), n = order[Math.min(order.length - 1, Math.max(0, i + dir))];
    if (n && n !== order[i]) pick(n);
  }
  A['cur-step'] = el => step(+el.dataset.dir);
  A['cur-redraw'] = () => refresh();
  A['cur-topic'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; const t = el.dataset.topic; f.topics = f.topics.includes(t) ? f.topics.filter(x => x !== t) : [...f.topics, t]; refresh(); };
  A['cur-topic-add'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f || !el.value) return; if (!f.topics.includes(el.value)) f.topics.push(el.value); refresh(); };
  A['cur-asver'] = el => { const f = draftOf(docById(el.dataset.id)); if (!f) return; f.asVersionOf = f.asVersionOf === el.dataset.other ? '' : el.dataset.other; refresh(); };

  /** Run a decision on queue items with Undo, then move on to the next item. */
  function decide(docs, run, msg) {
    const ids = new Set(docs.map(d => d.id)), next = nextEntry(ids, 'submissions'), here = onSplit('submissions');
    const snaps = [];
    docs.forEach(d => {
      snaps.push([d, snapDoc(d)]);
      const o = docById(drafts()[d.id]?.asVersionOf || d.submission?.versionOf);
      if (o && !snaps.some(([x]) => x === o)) snaps.push([o, snapDoc(o)]);
    });
    run();
    const sel = ui(QK).sel || {}; docs.forEach(d => delete sel[d.id]);
    // Stay in Submissions (its done state points at the next queue) instead of jumping to whichever queue has items.
    if (here) { setQuery({ queue: 'submissions', sel: next }); requestAnimationFrame(showDetail); } else refresh();
    toast(msg, { action: { label: 'Undo', run: () => undo(snaps, docs) } });
  }
  function undo(snaps, docs) {
    snaps.forEach(([d, s]) => restoreDoc(d, s));
    if (onReview()) setQuery({ queue: 'submissions', sel: docs[0].id }); else refresh();
    toast(docs.length === 1 ? `“${docs[0].name}” is back in review` : `${plural(docs.length, 'document')} are back in review`, { tone: 'accent' });
  }
  /** Decide a batch: its status, the run's counters (so Sources, the run, Review and the Library agree), audit, Undo, then the next entry. */
  const BATCH_AUDIT = { declined: 'Kept a batch unpublished', approved: 'Published a batch', replaced: 'Published a batch as new versions' };
  function batchToast(b, to) {
    const n = plural(b.n, 'document'), kb = kbById(b.kb)?.name || '';
    if (to === 'approved') return `Publishing ${n} to ${kb}`;
    if (to === 'replaced') return `Publishing ${n} as new versions`;
    return { duplicate: `Kept the published ones. ${n} stay unpublished.`, personal: `Kept ${n} with personal data unpublished`, version: `Kept the current versions. ${n} stay unpublished.` }[b.reason];
  }
  function decideBatch(id, to) {
    const b = batchById(id); if (!b || b.status !== 'open' || !canReviewKb(kbById(b.kb)) || !BATCH_DELTA[to]) return;
    const delta = BATCH_DELTA[to](b.n), next = nextEntry(new Set([b.id]), 'batches'), here = onSplit('batches');
    b.status = to; b.decided = { by: me().id, at: Date.now() };
    shiftBackfill(b.run, delta);
    lifeAudit(BATCH_AUDIT[to], `${BATCH[b.reason].label} · ${plural(b.n, 'document')} · ${srcById(b.source)?.name || kbById(b.kb)?.name || ''}`);
    if (here) { setQuery({ queue: 'batches', sel: next }); requestAnimationFrame(showDetail); } else refresh();
    toast(batchToast(b, to), { action: { label: 'Undo', run: () => {
      if (b.status !== to) return;
      b.status = 'open'; delete b.decided; shiftBackfill(b.run, delta, -1);
      if (onReview()) setQuery({ queue: 'batches', sel: b.id }); else refresh();
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
    const dec = decisionOf(d), o = docById(dec.asVersionOf || d.submission?.versionOf);
    const msg = o ? `Approved. “${o.name}” is publishing as v${res(o).version + 1}.` : `Approved “${d.name}”. Publishing to ${kbById(dec.kb || d.kb)?.name || 'its knowledge base'}.`;
    decide([d], () => approveAndPublish(d, dec), msg);
  };
  A['cur-bulk-approve'] = () => {
    const ids = Object.keys(ui(QK).sel || {}).filter(id => ui(QK).sel[id]);
    const docs = ids.map(inQueue).filter(Boolean);
    const personal = docs.filter(d => !analyzing(d) && hasFlag(d, 'personal')), busy = docs.filter(analyzing);
    const ok = docs.filter(d => !personal.includes(d) && !busy.includes(d));
    const skipped = [personal.length && `${personal.length} with personal data`, busy.length && `${busy.length} still being analyzed`].filter(Boolean).join(' and ');
    if (!ok.length) { toast(`Nothing published: ${skipped || 'select submissions first'}. Review ${personal.length + busy.length === 1 ? 'it' : 'them'} one by one.`, { tone: 'danger' }); return; }
    const decisions = new Map(ok.map(d => [d, decisionOf(d)]));
    decide(ok, () => ok.forEach(d => approveAndPublish(d, decisions.get(d))), `Approved ${plural(ok.length, 'document')}${skipped ? ` · skipped ${skipped}` : ''}`);
    // Keep the skipped ones selected so they're easy to find.
    ui(QK).sel = Object.fromEntries([...personal, ...busy].map(d => [d.id, true])); refresh();
  };

  /* Request changes / decline: a required message the contributor sees. */
  const QUICK = {
    changes: ['Please remove personal data (names, grades, ID numbers) and resubmit.', 'Please add a short note on what this covers and who it’s for.', 'Please upload the final version as a PDF.'],
    decline: ['This is already published. Use the existing document instead.', 'We can’t publish copyrighted material.', 'It contains personal data that can’t be shared.', 'It doesn’t belong in this knowledge base.'],
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

  /* Keyboard (Submissions and Sync batches): J/K or ↓/↑ move through the queue; Enter opens the full preview. */
  document.addEventListener('keydown', e => {
    if (!onReview() || S.modal || S.drawer || S.menu || S.palette || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    const t = e.target, kind = queueOf(S.cur.query);
    if (kind !== 'submissions' && kind !== 'batches') return;
    if (t.closest?.('input,textarea,select,[contenteditable="true"]')) return;
    const k = e.key;
    if (k === 'j' || k === 'J' || k === 'ArrowDown') { e.preventDefault(); step(1); return; }
    if (k === 'k' || k === 'K' || k === 'ArrowUp') { e.preventDefault(); step(-1); return; }
    if (k === 'Enter' && kind === 'submissions' && !t.closest?.('button,a,[role="button"],label,[data-act]')) {
      const id = currentId(queueRows()); if (id) { e.preventDefault(); go('/doc/' + id); }
    }
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
      ['Knowledge base', esc(kbById(d.kb)?.name || '—')],
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

  /* ═══════════════ Library ═══════════════ */
  const SORTERS = { name: d => d.name.toLowerCase(), updated: d => d.updated };
  const LIFE_OF_GROUP = Object.fromEntries(LIFE_GROUPS.map(([k, , keys]) => [k, keys]));
  const FACETS = ['kb', 'src', 'kind', 'topic'];
  function syncFromQuery(u, query) {
    const qs = JSON.stringify([query.life, query.kb, query.src, query.topic, query.q]);
    if (u._qs === qs) return;
    Object.assign(u, { _qs: qs, life: LIFE_GROUP_ALIAS[query.life] || query.life || '', kb: query.kb || '', src: query.src || '', topic: query.topic || '', q: query.q || '', kind: '', page: 1, sel: {} });
  }
  /** Who or what a document came from, in words: its source, its contributor, or the editor who uploaded it. */
  const originName = d => (srcKey(d) !== 'upload' ? srcById(d.source)?.name || res(d).source.name : contributorName(d));
  const originCell = d => `<span class="row gap-6 cur-origin">${appIcon(res(d).source.app, 'sm')}<span class="truncate" data-tip="${esc(originName(d))}">${esc(originName(d))}</span></span>`;
  /** Every filter but the stage: the flow strip counts within it (like a facet), the table narrows it further. */
  const facetMatch = (d, u) => (!u.kb || d.kb === u.kb) && (!u.src || originKey(d) === u.src) && (!u.kind || res(d).kind === u.kind) && (!u.topic || res(d).topics.includes(u.topic)) && matchesQ(AK, d.name, contributorName(d), kbById(d.kb)?.name);
  function allRows(u) {
    const docs = curatedDocs();
    const rows = docs.filter(d => (!u.life || LIFE_OF_GROUP[u.life]?.includes(lifeKey(d))) && facetMatch(d, u));
    return { docs, rows: applySort(rows, AK, SORTERS) };
  }
  /** The flow strip: where every document is, read left to right (In review › Publishing › Published), with the two
      off-ramps apart (Needs attention, Not published). It is the page's stage filter: pressing a step shows those documents. */
  const FLOW_TIPS = {
    review: 'Being classified, waiting for a reviewer, or back with the contributor.',
    publishing: 'Approved and being made searchable.',
    published: 'Searchable, and used in answers for everyone who can read its knowledge base.',
    attention: 'Couldn’t publish, waiting to publish, or changed at the source. Each row shows its fix; Review → Publishing problems fixes them together.',
    closed: 'Declined by a reviewer or unpublished. Kept with their history.',
  };
  /** With a first sync at scale: what its batches and its published documents mean here (they're never rows of this table). */
  const FLOW_TIPS_SCALE = {
    review: 'Being classified, waiting for a reviewer, or back with the contributor. Batches a first sync held back are decided in Review and aren’t listed here.',
    published: 'Searchable, and used in answers for everyone who can read its knowledge base. Documents published by a first sync are counted in Sources.',
  };
  function flowStrip(docs, u) {
    const pool = docs.filter(d => facetMatch(d, u)), count = k => pool.filter(d => LIFE_OF_GROUP[k].includes(lifeKey(d))).length;
    // In review also holds what went back to its contributor: said once, under the count, so it squares with the Review tab.
    const back = pool.filter(d => lifeKey(d) === 'changes').length;
    // Open batches (thousands of documents each) show under In review as a sub-line, never added to its count or the table.
    const held = u.kind || u.topic || (u.q || '').trim() ? 0 : openBatches().filter(b => (!u.kb || b.kb === u.kb) && (!u.src || b.source === u.src)).reduce((s, b) => s + b.n, 0);
    const firstSync = (D.runs || []).some(r => r.backfill && canReviewKb(kbById(r.kb)));
    const tips = { ...FLOW_TIPS, ...(held ? { review: FLOW_TIPS_SCALE.review } : {}), ...(firstSync ? { published: FLOW_TIPS_SCALE.published } : {}) };
    const subs = { review: [back && `${fmtNum(back)} with the contributor`, held && `+${fmtNum(held)} in batches`] };
    const sub = k => (subs[k] || []).filter(Boolean).map(t => `<span class="flow__sub">${esc(t)}</span>`).join('');
    const step = (k, label, n, tone = '') => `<button type="button" class="${cx('flow__step', tone && n && 'flow__step--' + tone)}" aria-pressed="${(u.life || '') === k}" data-act="cur-flow" data-value="${k}" ${tips[k] ? `data-tip="${esc(tips[k])}"` : ''}><span class="flow__label">${esc(label)}</span><span class="flow__count num">${fmtNum(n)}</span>${sub(k)}</button>`;
    const [rv, pub, done, att, closed] = LIFE_GROUPS;
    const sep = `<span class="flow__sep" aria-hidden="true">${ic('chevron-right', 'i-sm')}</span>`;
    return `<div class="flow" role="group" aria-label="Where documents are">
      ${step('', 'All', pool.length)}<span class="flow__div" aria-hidden="true"></span>
      <div class="flow__main">${[rv, pub, done].map(([k, l]) => step(k, l, count(k), k === 'review' ? 'accent' : '')).join(sep)}</div>
      <div class="flow__off">${step(att[0], att[1], count(att[0]), 'danger')}${step(closed[0], closed[1], count(closed[0]))}</div>
    </div>`;
  }
  A['cur-flow'] = el => { const u = ui(AK), v = el.dataset.value || ''; u.life = u.life === v ? '' : v; u.page = 1; u.sel = {}; refresh(); };
  /** Who can find it: the base's audience once it's searchable; before (or after it's taken down) nobody but reviewers. */
  function visibilityCell(d) {
    const kb = kbById(d.kb), who = X.whoCanSee(kb), seen = ['published', 'update', 'stored'].includes(lifeKey(d));
    if (seen) return `<span class="row gap-6 cur-vis" data-tip="${esc(who.detail || who.label)}">${ic(who.icon, 'i-sm muted')}<span class="truncate">${esc(who.label)}</span></span>`;
    return `<span class="row gap-6 cur-vis muted" data-tip="${esc(`${who.label} once it’s published`)}">${ic('eye-off', 'i-sm')}<span class="truncate">Not visible yet</span></span>`;
  }
  function allRow(d) {
    const on = !!ui(AK).sel?.[d.id], r = res(d);
    return `<tr class="table__row" data-act="cur-doc" data-id="${d.id}" tabindex="0" ${on ? 'aria-selected="true"' : ''}>
      ${selCheck(AK, d.id, 'Select ' + d.name)}
      <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div><div class="cell-sub truncate">${esc([kbById(d.kb)?.name, ...r.topics.slice(0, 2).map(topicName)].filter(Boolean).join(' · '))}</div></div></div></td>
      <td class="table__cell table__cell--hide-sm">${originCell(d)}</td>
      <td class="table__cell table__cell--hide-sm cur-owner"><span class="truncate">${esc(r.owner || '—')}</span></td>
      <td class="table__cell">${lifeChip(d, 'sm')}</td>
      <td class="table__cell table__cell--hide-sm">${visibilityCell(d)}</td>
      <td class="table__cell muted cur-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${rowFix(d)}<span class="reveal-on-hover">${iconBtn('more', 'More actions', { size: 'sm', menu: 'cur-row', data: { id: d.id, ctx: 'row' } })}</span></div></td></tr>`;
  }
  function libraryTab(query) {
    const u = ui(AK, { q: '', life: '', kb: '', src: '', kind: '', topic: '', sort: { key: 'updated', dir: 'desc' }, page: 1, sel: {} });
    syncFromQuery(u, query);
    const empty = () => emptyState({ icon: 'files', title: 'No documents yet', desc: 'Documents added to the knowledge bases you look after show up here, whatever their origin.', actions: canContribute() ? btn('Add documents', { v: 'primary', icon: 'upload', act: 'contribute' }) : '', boxed: true });
    return gate({
      loading: () => skelRows(8),
      empty,
      ok: () => {
        const { docs, rows } = allRows(u);
        if (!docs.length) return empty();
        const live = new Set(docs.map(d => d.id));
        u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
        const facets = allFacets(docs, u), sortLabel = u.sort?.key === 'name' ? 'Name' : 'Recently updated';
        const n = FACETS.filter(k => u[k]).length;
        // Wide: one dropdown per facet. Narrow: one Filters button (a bottom sheet on phones) plus removable chips for what's on,
        // so the first document isn't pushed below the fold. The sort menu stands in for the column headers on narrow screens.
        // The stage is the flow strip above, never a second dropdown.
        const wide = facets.map(f => filterButton(f.label, AK, f.key, f.opts)).join('') + clearFilters(AK, FACETS);
        const narrow = facets.length ? `<button type="button" class="${cx('filter-button', n && 'is-set')}" data-popover="cur-filters" aria-haspopup="dialog" aria-expanded="false">${ic('filter')}<span>Filters</span>${n ? badge(n, { tone: 'accent' }) : ''}</button>` : '';
        const chips = n ? `<div class="cur-fchips">${facets.filter(f => u[f.key]).map(f => `<button type="button" class="chip chip--soft chip--accent cur-fchip" data-act="cur-filter-set" data-field="${f.key}" data-value="" aria-label="${esc(`Remove filter: ${f.label}`)}">${esc(f.opts.find(o => o[0] === u[f.key])?.[1] || u[f.key])}${ic('x', 'i-xs')}</button>`).join('')}</div>` : '';
        const toolbar = docs.length > MANY || u.q || n ? `<div class="toolbar cur-toolbar">${searchField({ uiKey: AK, placeholder: 'Search documents' })}
          <div class="cur-filters--wide">${wide}</div><div class="cur-filters--narrow">${narrow}</div>
          <div class="toolbar__end cur-sortmenu">${btn(sortLabel, { v: 'ghost', size: 'sm', icon: 'sort', menu: 'cur-sort', aria: `aria-label="Sort: ${esc(sortLabel)}"` })}</div></div>${chips}` : '';
        const flow = flowStrip(docs, u);
        // Where things are, then the tools to browse the rest. Fixing several at once happens in Review → Publishing problems.
        if (!rows.length) return flow + toolbar + noMatches(AK, ['life', ...FACETS], 'documents');
        const page = paginate(rows, AK, PER);
        const bulk = bulkBar(AK, btn('Publish', { v: 'ghost', size: 'sm', icon: 'upload', act: 'cur-bulk-publish' }) + btn('Unpublish', { v: 'ghost', size: 'sm', icon: 'eye-off', act: 'cur-bulk-unpublish' }) + btn('Archive', { v: 'ghost', size: 'sm', icon: 'archive', act: 'cur-bulk-archive' }));
        const head = `${selAllCheck(AK, page.map(d => d.id))}${sortHead('Name', 'name', AK)}${th('Origin', 'table__column--hide-sm')}${th('Owner', 'table__column--hide-sm')}${th('Lifecycle')}${th('Visibility', 'table__column--hide-sm')}${sortHead('Updated', 'updated', AK)}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
        return flow + toolbar + `<div class="cur-all">${table({ label: 'Library', head, rows: page.map(allRow), foot: pager(rows.length, AK, PER) })}</div>` + bulk;
      },
    });
  }
  /** Facets the Library offers, only when they'd split it (or one is in use): [{ key, label, opts }]. */
  function allFacets(docs, u) {
    const kbs = queueKbs(docs);
    const srcs = [...new Set(docs.map(srcKey))].filter(k => k !== 'upload').map(srcById).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const origins = [docs.some(d => originKey(d) === 'contrib') && ['contrib', 'Contributions'], docs.some(d => originKey(d) === 'upload') && ['upload', 'Uploads'], ...srcs.map(s => [s.id, s.name])].filter(Boolean);
    const kinds = [...new Set(docs.map(d => res(d).kind))].map(k => [k, kindMeta(k).label]).sort((a, b) => a[1].localeCompare(b[1]));
    const topics = [...new Set(docs.flatMap(d => res(d).topics))].filter(id => topicById(id)).map(id => [id, topicName(id)]).sort((a, b) => a[1].localeCompare(b[1]));
    return [
      (kbs.length > 1 || u.kb) && { key: 'kb', label: 'Knowledge base', opts: kbs.map(k => [k.id, k.name]) },
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
  /** Selected documents in a list (Library or Publishing problems) the caller reviews. */
  const selectedIn = key => selIds(key).map(docById).filter(d => d && canReviewKb(kbById(d.kb)));
  const canPublish = d => { const k = lifeKey(d); return k === 'unpublished' || k === 'queued' || k === 'update' || (k === 'failed' && !isLocked(d)); };
  const canUnpublish = d => stageOf(d) === 'published' && !d.archived;
  function publishDocs(docs) {
    const again = docs.filter(d => stageOf(d) === 'unpublished'), rest = docs.filter(d => stageOf(d) !== 'unpublished');
    again.forEach(republish);
    if (rest.length) X.processDocs(rest, { quiet: true });
  }
  /** Publish (or retry, or publish the update of) what's selected; password-protected files are skipped and said so. */
  function bulkPublish(key) {
    const docs = selectedIn(key), ok = docs.filter(canPublish), skipped = docs.length - ok.length;
    if (!ok.length) { toast(docs.some(isLocked) ? 'Password-protected files can’t be published. Replace them or remove the password at the source.' : 'None of these need publishing', { tone: 'danger' }); return; }
    ui(key).sel = {}; publishDocs(ok); refresh();
    toast(`Publishing ${plural(ok.length, 'document')}${skipped ? ` · ${skipped} skipped` : ''}`, { tone: 'accent' });
  }
  A['cur-bulk-publish'] = () => bulkPublish(AK);
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
    review: { label: 'Review', icon: 'check', run: d => { closeDocDrawer(); go(studioHref('review', { queue: 'submissions', sel: d.id })); } },
    publish: { label: 'Publish now', icon: 'play', run: d => X.processDocs([d], { msg: `Publishing ${d.name}` }) },
    retry: { label: 'Retry', icon: 'retry', run: d => X.processDocs([d], { msg: `Publishing ${d.name} again` }) },
    replace: { label: 'Replace file', icon: 'upload', run: d => A['doc-replace']({ dataset: { id: d.id } }) },
    // Changed at its source: republish from the source (never a file picker for synced documents).
    update: { label: 'Publish update', icon: 'refresh', run: d => X.processDocs([d], { msg: `Publishing the update to ${d.name}` }) },
    source: { label: 'Open source', icon: 'plug', run: d => { closeDocDrawer(); if (can('source.manage') && A['src-open']) A['src-open']({ dataset: { id: d.source } }); else go(studioHref('sources')); } },
    republish: { label: 'Publish again', icon: 'upload', run: d => { const s = snapDoc(d); republish(d); refresh(); toast(`Publishing “${d.name}” again`, { tone: 'accent', action: { label: 'Undo', run: () => { restoreDoc(d, s); refresh(); } } }); } },
    unpublish: { label: 'Unpublish', icon: 'eye-off', run: d => unpublishDocs([d]) },
    edit: { label: 'Edit details…', icon: 'pencil', run: d => A['res-edit']({ dataset: { id: d.id } }) },
    move: { label: 'Move to…', icon: 'folder', run: d => A['doc-move']({ dataset: { id: d.id } }) },
    open: { label: 'Open', icon: 'file-text', run: d => { closeDocDrawer(); go('/doc/' + d.id); } },
    original: { label: 'Open the published document', icon: 'file-text', run: d => { closeDocDrawer(); go('/doc/' + d.mergedInto); } },
    download: { label: 'Download', icon: 'download', run: d => X.downloadDocument(d) },
    archive: { label: 'Archive', icon: 'archive', danger: true, run: d => X.archiveDocs([d], closeDocDrawer) },
  };
  /** Fixes a row shows as a visible button (actionable states only); everything else lives in ⋯. */
  const ROW_FIX = new Set(['publish', 'retry', 'replace', 'update', 'republish', 'source']);
  /** May the caller open the document drawer? Reviewers of its base; editors for published documents (the To keep right queues). */
  const canOpenDoc = d => { const kb = d && kbById(d.kb); return !!kb && (canReviewKb(kb) || (canEditKb(kb) && isPublishedStage(d))); };
  /** { main, more, tail } operations for a document's lifecycle state. Editors who don't review the base only open, edit and download. */
  function opsFor(d) {
    const k = lifeKey(d), live = ['published', 'update', 'stored', 'queued', 'failed', 'publishing'].includes(k);
    if (!canReviewKb(kbById(d.kb))) return { main: 'open', more: live ? ['edit'] : [], tail: ['download'] };
    const synced = srcKey(d) !== 'upload' && !!srcById(d.source);
    const main = { analyzing: 'review', review: 'review', queued: 'publish', failed: isLocked(d) ? (synced ? 'source' : 'replace') : 'retry', update: synced ? 'update' : 'replace', unpublished: 'republish', merged: d.mergedInto ? 'original' : 'open' }[k] || 'open';
    const more = [main !== 'open' && 'open', live && 'edit', live && !kbById(d.kb)?.personal && 'move', canUnpublish(d) && 'unpublish'].filter(Boolean);
    return { main, more, tail: ['download', !d.archived && k !== 'merged' && 'archive'].filter(Boolean) };
  }
  /** The state's fix as a small row button (Library, Publishing problems), or ''. */
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
  /** Where a document is in the Studio flow — Received → Classified → Reviewed → Published — whatever its origin.
      Each step: { label, state: done | current | issue | skipped | todo, text, at?, action? }. */
  function flowSteps(d) {
    const k = lifeKey(d), sub = d.submission || {}, src = srcKey(d) !== 'upload' ? srcById(d.source) : null, kb = kbById(d.kb);
    const ev = kind => [...(sub.events || [])].reverse().find(e => e.kind === kind);
    const open = ['analyzing', 'review', 'changes'].includes(k);
    const received = { label: 'Received', state: 'done', at: sub.at || d.updated,
      text: sub.by ? `Contributed by ${actorName(sub.by)}` : src ? `Synced from ${src.name}` : `Uploaded by ${d.addedBy || 'an editor'}` };
    const ai = open && d.ai?.status === 'done' ? d.ai : null;
    const topics = open ? (ai ? ai.topics.map(t => t.id) : []) : res(d).topics, kind = kindMeta(ai ? ai.kind.value : res(d).kind).label;
    const tagTopic = isPublishedStage(d) && X.res.canEditRes(d) ? btn('Add topic', { v: 'secondary', size: 'sm', icon: 'tag', iconRight: 'chevron-down', menu: 'kh-topic', data: { ids: d.id } }) : '';
    const classified = k === 'analyzing' ? { state: 'current', busy: true, text: 'Matching it against the taxonomy…' }
      : topics.length ? { state: 'done', text: `${kind} · ${topics.map(topicName).join(', ')}${open ? ' · suggested, the reviewer confirms' : d.classifiedBy === 'assistant' ? ' · tagged by the assistant' : ''}` }
        : { state: 'issue', text: `${kind} · no topic yet`, action: tagTopic };
    const by = e => (e?.by ? ` by ${actorName(e.by)}` : '');
    const reviewed = k === 'analyzing' || k === 'review' ? { state: 'current', text: 'Waiting for a reviewer' }
      : k === 'changes' ? { state: 'issue', text: `Changes requested${by(ev('changes'))}`, at: ev('changes')?.at }
        : k === 'rejected' ? { state: 'issue', text: `Declined${by(ev('rejected'))}`, at: ev('rejected')?.at }
          : ev('approved') ? { state: 'done', text: `Approved${by(ev('approved'))}`, at: ev('approved').at }
            : { state: 'skipped', text: src ? `Not needed: ${src.name} publishes automatically` : 'Not needed: added by an editor of the knowledge base' };
    const who = kb ? X.whoCanSee(kb).label : '';
    const PUB = {
      queued: { state: 'issue', text: 'Waiting to publish' }, publishing: { state: 'current', busy: true, text: 'Making it searchable…' },
      published: { state: 'done', text: `Searchable · ${who}` }, stored: { state: 'done', text: 'Stored · this file type can’t be searched' },
      failed: { state: 'issue', text: 'Couldn’t publish' }, update: { state: 'issue', text: 'Changed at the source · answers use the previous version' },
      unpublished: { state: 'issue', text: 'Unpublished · out of search and answers' }, merged: { state: 'done', text: 'Published as a new version' },
      rejected: { state: 'skipped', text: 'Won’t be published' },
    };
    const published = PUB[k] || { state: 'todo', text: `After approval · ${who} will see it` };
    return [{ ...received }, { label: 'Classified', ...classified }, { label: 'Reviewed', ...reviewed }, { label: 'Published', ...published }];
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
    if (!d || !kb || !canOpenDoc(d)) return { title: 'Document not available', body: emptyState({ icon: 'file', title: 'This document isn’t available', desc: 'It may have been moved to a knowledge base you don’t look after.' }) };
    const l = lifecycleOf(d), { main } = opsFor(d), k = l.key;
    const opBtn = (op, v = 'secondary') => btn(OPS[op].label, { v, icon: OPS[op].icon, act: 'cur-op', data: { id: d.id, op } });
    const last = [...(d.submission?.events || [])].reverse().find(e => ['changes', 'rejected', 'unpublished'].includes(e.kind));
    // The chip names the state; one note says why and what fixes it (never a second title repeating the chip).
    const fixHint = main === 'source' ? ' Remove the password at the source, then sync again.' : main === 'replace' ? ' Replace the file with a copy without a password.' : '';
    const saysFix = /remove the password|copy without|sync again|try again/i.test(d.error || '');
    const note = k === 'failed' ? alertBox('danger', '', esc((d.error || 'Publishing stopped partway. Try again.') + (isLocked(d) && !saysFix ? fixHint : '')))
      : k === 'merged' && d.mergedInto ? alertBox('success', '', esc(`It replaced the earlier version of “${docById(d.mergedInto)?.name || 'a document'}”.`))
        : ['changes', 'rejected', 'unpublished'].includes(k) && last?.text ? `<blockquote class="cur-tl__text">“${esc(last.text)}” — ${esc(actorName(last.by))}</blockquote>` : '';
    const published = stageOf(d) === 'published';
    const events = (d.submission?.events || []).length;
    const body = `<div class="drawer__section"><div class="row gap-8 wrap">${lifeChip(d)}</div>${note ? `<div class="mt-12">${note}</div>` : ''}</div>
      <div class="drawer__section"><h3 class="drawer__section-title">Progress</h3>${stepper(d)}</div>
      <div class="drawer__section">${disclosure({ path: 'curDocHistory', title: 'History', icon: 'history', summary: events ? plural(events, 'event') : '', body: timeline(d) })}</div>
      <div class="drawer__section"><h3 class="drawer__section-title">Details</h3>${published ? X.res.details(d) : kv([
        ['Knowledge base', `<a class="link" href="#${canEditKb(kb) ? kbManageHref(kb) : kbHref(kb)}">${esc(kb.name)}</a>`],
        ['Contributor', esc(contributorName(d))],
        ['Type', esc(kindMeta(res(d).kind).label)],
        ['Size', `${esc(fmtSize(d.size))} · ${plural(d.pages || 1, 'page')}`],
        ['Version', `v${res(d).version}`],
        ['Who could see it', `<span class="row gap-6">${ic(X.whoCanSee(kb).icon, 'i-sm muted')}${esc(X.whoCanSee(kb).label)}</span>`],
      ])}</div>`;
    return {
      title: d.name, lead: fileIcon(d.type, 'lg'), desc: esc(kb.name), size: 'lg', body,
      headActions: iconBtn('more', 'More actions', { menu: 'cur-row', data: { id: d.id, ctx: 'drawer' } }),
      foot: opBtn(main, 'primary'),
    };
  };
})();

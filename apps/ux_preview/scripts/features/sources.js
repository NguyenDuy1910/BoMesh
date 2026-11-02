(() => {
  'use strict';
  /* Sources: simulated sync engine, the Sources page (sources + sync history),
     source and sync-run drawers, and the connect-source wizard.
     Accounts (connections.js) reuse the engine through X.src. */

  const DAYS = [['Mon', 'Monday'], ['Tue', 'Tuesday'], ['Wed', 'Wednesday'], ['Thu', 'Thursday'], ['Fri', 'Friday'], ['Sat', 'Saturday'], ['Sun', 'Sunday']];
  const TZ = [['Asia/Ho_Chi_Minh', 'Ho Chi Minh City (GMT+7)'], ['Asia/Singapore', 'Singapore (GMT+8)'], ['Asia/Tokyo', 'Tokyo (GMT+9)'], ['Europe/London', 'London (GMT+1)'], ['America/New_York', 'New York (GMT−4)'], ['UTC', 'UTC']];
  const TIMES = Array.from({ length: 24 }, (_, h) => { const t = String(h).padStart(2, '0') + ':00'; return [t, t]; });
  const KB_COLORS = ['#2F6FB5', '#C2620F', '#0E7C66', '#6B4FBF', '#B4467A', '#1F7A8C'];
  const POOL = {
    gdrive: ['Q4 Pricing Update.pdf', 'Competitive Battlecard — Litware.pdf', 'Security Whitepaper 2026.pdf', 'Customer Onboarding Deck.pptx', 'Reference Call Guide.docx', 'Pricing FAQ.docx', 'Renewal Email Templates.docx', 'Partner Pricing Sheet.xlsx', 'Product Overview One-pager.pdf', 'Executive Briefing Deck.pptx', 'Brand Guidelines 2026.pdf', 'Campaign Calendar.xlsx'],
    confluence: ['Release Notes 4.3.md', 'Feature Flags Guide.md', 'Sandbox Reset Steps.md', 'Holiday Schedule 2026.md', 'Expense Categories.md', 'Incident Review Template.md', 'Team Directory.md', 'Data Export Guide.md', 'Access Request Process.md', 'Glossary Updates.md', 'On-call Handbook.md', 'Service Ownership.md'],
    website: ['News — New office opening.html', 'Notice — Planned maintenance this weekend.html', 'News — Annual results published.html', 'Notice — Holiday opening hours.html', 'Notice — Updated privacy notice.html', 'News — New partnership announced.html'],
    sharepoint: ['Vendor Risk Assessment Procedure.pdf', 'Business Continuity Plan 2026.pdf', 'Information Classification Standard.pdf', 'Quarterly Access Review Checklist.xlsx', 'Chargeback Reason Codes.xlsx', 'Leave Policy 2027.pdf', 'Records Retention Schedule.xlsx', 'Third-party Risk Register.xlsx'],
    github: ['Runbook — Ledger consumer lag.md', 'ADR-043 — Outbox pattern for payment events.md', 'Payments API changelog.md', 'Service ownership map.md', 'Load test results — Q4.md', 'Webhook signing guide.md'],
  };
  /* Folder / space trees offered by the content picker. */
  const TREE = {
    gdrive: [
      { id: 'g-my', name: 'My Drive', kids: [{ id: 'g-my-proj', name: 'Projects', docs: 18 }, { id: 'g-my-notes', name: 'Notes', docs: 42 }, { id: 'g-my-arch', name: 'Archive', docs: 130 }] },
      { id: 'g-sd', name: 'Shared drives', kids: [
        { id: 'g-sales', name: 'Sales Enablement', kids: [{ id: 'g-sales-decks', name: 'Pitch decks', docs: 12 }, { id: 'g-sales-price', name: 'Pricing', docs: 7 }, { id: 'g-sales-cases', name: 'Case studies', docs: 9 }] },
        { id: 'g-contracts', name: 'Contracts', kids: [{ id: 'g-con-cust', name: 'Customer agreements', docs: 64 }, { id: 'g-con-vend', name: 'Vendor agreements', docs: 23 }] },
        { id: 'g-mkt', name: 'Marketing', kids: [{ id: 'g-mkt-brand', name: 'Brand guidelines', docs: 6 }, { id: 'g-mkt-camp', name: 'Campaigns', docs: 31 }] },
        { id: 'g-legal', name: 'Legal', kids: [{ id: 'g-legal-exec', name: 'Executed contracts', docs: 10 }, { id: 'g-legal-tpl', name: 'Templates', docs: 14 }] },
      ] },
    ],
    confluence: [
      { id: 'c-po', name: 'People Ops', space: true, kids: [{ id: 'c-po-pol', name: 'Policies', docs: 14 }, { id: 'c-po-ben', name: 'Benefits', docs: 8 }, { id: 'c-po-onb', name: 'Onboarding', docs: 11 }] },
      { id: 'c-pd', name: 'Product Docs', space: true, kids: [{ id: 'c-pd-rn', name: 'Release notes', docs: 16 }, { id: 'c-pd-api', name: 'API reference', docs: 9 }, { id: 'c-pd-guides', name: 'Guides', docs: 12 }] },
      { id: 'c-eng', name: 'Engineering', space: true, kids: [{ id: 'c-eng-run', name: 'Runbooks', docs: 21 }, { id: 'c-eng-arch', name: 'Architecture', docs: 13 }, { id: 'c-eng-pm', name: 'Postmortems', docs: 27 }] },
      { id: 'c-fin', name: 'Finance', space: true, kids: [{ id: 'c-fin-proc', name: 'Procurement', docs: 9 }, { id: 'c-fin-exp', name: 'Expenses', docs: 6 }] },
    ],
  };
  const WIZ_STEPS = ['App', 'Account', 'Content', 'Destination'];
  const ENG = { timers: {}, booted: false, newId: null, docN: {} };

  /* Older sync history so paging and filters are meaningful. Runs at boot, after hydrate(). */
  function seedHistory() {
    if (D.runs.some(r => r.id === 'run-1038')) return;
    const base = [['src-hr', 'kb-hr'], ['src-product', 'kb-product'], ['src-sales', 'kb-sales'], ['src-legal', 'kb-legal']];
    for (let i = 0; i < 14; i++) {
      const [source, kb] = base[i % 4];
      let trigger = i % 5 === 2 ? 'Manual' : 'Scheduled';
      let by = trigger === 'Manual' ? ['Linh Tran', 'An Nguyen', 'Ben Walker'][i % 3] : 'Schedule';
      if (source === 'src-legal') { trigger = 'Manual'; by = 'Sara Lopez'; }
      const total = 3 + (i * 7) % 15, cancelled = i === 6;
      D.runs.push({ id: 'run-' + (1038 - i), source, kb, trigger, status: cancelled ? 'cancelled' : 'completed', started: ago((13 + i * 1.5) * DAY + (i % 3) * HOUR), dur: (40 + (i * 23) % 400) * 1000, counts: { total, ok: cancelled ? Math.floor(total / 2) : total, failed: 0, skipped: cancelled ? total - Math.floor(total / 2) : 0 }, by });
    }
    const r47 = D.runs.find(r => r.id === 'run-1047'); if (r47) { r47.added = 3; r47.updated = 5; }
    const r44 = D.runs.find(r => r.id === 'run-1044'); if (r44) { r44.added = 2; r44.updated = 12; }
  }

  /* ── Helpers ── */
  const srcCan = () => can('source.manage');
  const runById = id => D.runs.find(r => r.id === id);
  const runsOf = id => D.runs.filter(r => r.source === id).sort((a, b) => b.started - a.started);
  const runName = r => r.srcName || srcById(r.source)?.name || 'Removed source';
  const runApp = r => r.app || srcById(r.source)?.app || 'upload';
  const appName = key => APPS[key]?.name || 'App';
  const isLocked = d => /password/i.test(d.error || '');
  const tzShort = tz => (TZ.find(t => t[0] === tz)?.[1] || tz).replace(/ \(.*\)$/, '');
  function schedText(s) { if (!s || s.freq === 'manual') return 'Manual'; if (s.freq === 'daily') return `Daily at ${s.time}`; return `Weekly on ${s.day} at ${s.time}`; }
  function nextAt(s) {
    if (!s || s.freq === 'manual' || !s.time) return null;
    const [h, m] = s.time.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0);
    if (s.freq === 'daily') { if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); }
    const want = DAYS.findIndex(x => x[0] === s.day), cur = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() + (want - cur + 7) % 7); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 7);
    return d.getTime();
  }
  const scopeText = s => !s.scope?.length ? 'Everything' : s.scope[0] + (s.scope.length > 1 ? ` +${s.scope.length - 1}` : '');
  function delta(r) { const ok = r.counts.ok; const added = r.added ?? Math.round(ok * 0.3); return { added, updated: r.updated ?? Math.max(0, ok - added), failed: r.counts.failed }; }
  function deltaText(r) {
    if (r.status === 'running' || r.status === 'queued') return `${r.counts.ok + r.counts.failed} of ${plural(r.counts.total, 'document')}`;
    if (r.status === 'failed' && !r.counts.total) return 'Nothing synced';
    const d = delta(r), p = [];
    if (d.added) p.push(`${d.added} added`); if (d.updated) p.push(`${d.updated} updated`); if (d.failed) p.push(`${d.failed} failed`); if (r.counts.skipped) p.push(`${r.counts.skipped} skipped`);
    return p.join(' · ') || 'No changes';
  }
  function lastText(l) {
    if (l.result === 'failed') return 'Failed';
    if (l.result === 'cancelled') return 'Cancelled';
    if (l.review) return [`${l.review} sent to review`, l.failed && `${l.failed} failed`].filter(Boolean).join(' · ');
    return [l.added && `${l.added} added`, l.updated && `${l.updated} updated`, l.failed && `${l.failed} failed`].filter(Boolean).join(' · ') || 'No changes';
  }
  const kbLink = kb => kb ? `<a class="src-kb" href="#/knowledge/${kb.id}" data-act="go" data-to="/knowledge/${kb.id}"><span class="src-kb__dot" style="background:${esc(kb.color)}"></span><span class="truncate">${esc(kb.name)}</span></a>` : '<span class="muted">Removed</span>';
  function audit(action, target, outcome = 'success') { D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Sources', target, outcome, ip: '10.4.12.30', device: 'Chrome on macOS' }); }
  /* Publishing policy for new and changed files: trusted systems publish directly, others wait for a reviewer. */
  const policyOf = s => (s.publish === 'review' ? 'review' : 'auto');
  const POLICY = {
    auto: { label: 'Publish automatically', short: 'Publishes automatically', icon: 'zap', desc: 'For trusted systems. New and changed files become searchable without a review.' },
    review: { label: 'Send to review first', short: 'Review first', icon: 'shield-check', desc: 'A reviewer of the knowledge base approves each new or changed file before it’s published.' },
  };
  const policyChoices = () => Object.entries(POLICY).map(([k, p]) => [k, p.label, esc(p.desc)]);

  /* ═══════════════ Sync engine (simulated) ═══════════════ */
  const TICK_PAGES = ['sources', 'connections', 'kbDetail', 'overview'];
  const FULL_PAGES = [...TICK_PAGES, 'kbList', 'documents', 'documentsAdmin', 'library', 'docViewer', 'inbox'];
  /** Repaint whatever shows sync state. Progress ticks repaint only sync-aware views. */
  function rerender(full) {
    if (document.activeElement?.tagName === 'SELECT') { setTimeout(() => rerender(full), 500); return; }
    const page = S.cur?.r.page;
    if ((full ? FULL_PAGES : TICK_PAGES).includes(page)) refresh();
    else if (S.drawer?.name?.startsWith('src-') || /^(src|acc)-/.test(S.modal?.name || '')) refreshLayer();
  }
  function newRunId() { return 'run-' + (D.runs.reduce((m, r) => Math.max(m, +String(r.id).replace(/\D/g, '') || 0), 1048) + 1); }
  /** Starts a sync for a source whose account works. plan = { added, updated, failed, failures }. */
  function startSync(src, o = {}) {
    if (!src || src.status === 'syncing' || accById(src.account)?.status !== 'connected') return null;
    const own = D.docs.filter(d => d.source === src.id && !d.archived && stageOf(d) === 'published');
    const stuck = own.filter(d => d.status === 'failed' && isLocked(d));
    const fixable = own.filter(d => ['failed', 'pending', 'outdated'].includes(d.status) && !isLocked(d)).length;
    const plan = o.plan || { added: 1 + Math.floor(rnd() * 3), updated: 2 + Math.floor(rnd() * 4) + fixable, failed: stuck.length, failures: stuck.map(d => d.id) };
    const total = plan.added + plan.updated + (plan.failed || 0);
    const run = { id: newRunId(), source: src.id, srcName: src.name, app: src.app, kb: src.kb, trigger: o.trigger || 'Manual', status: 'running', started: Date.now(), counts: { total, ok: 0, failed: 0, skipped: 0 }, by: o.trigger === 'Scheduled' ? 'Schedule' : me().name, plan };
    D.runs.unshift(run);
    src.prevStatus = src.status; src.status = 'syncing'; src.progress = { done: 0, total }; src.runId = run.id;
    drive(src, run, { every: 600, inc: Math.max(1, Math.ceil(total / (o.ticks || Math.max(total, 4)))) });
    return run;
  }
  function drive(src, run, { every = 600, inc = 1 }) {
    clearInterval(ENG.timers[run.id]);
    ENG.timers[run.id] = setInterval(() => {
      if (run.status !== 'running') { clearInterval(ENG.timers[run.id]); delete ENG.timers[run.id]; return; }
      const c = run.counts; c.ok = Math.min(c.total, c.ok + inc);
      if (src) src.progress = { done: c.ok, total: c.total };
      if (c.ok >= c.total) finishRun(src, run); else rerender();
    }, every);
  }
  function docName(app) {
    const pool = POOL[app] || POOL.gdrive; const i = ENG.docN[app] = (ENG.docN[app] || D.docs.filter(d => d.source && srcById(d.source)?.app === app && pool.some(p => d.name.startsWith(p.replace(/\.\w+$/, '')))).length) + 1;
    const n = pool[(i - 1) % pool.length], k = Math.floor((i - 1) / pool.length);
    return k ? n.replace(/(\.\w+)$/, ` (${k + 1})$1`) : n;
  }
  /** Publish documents (an Ingestion Run). Syncs only change the inventory: documents land as Waiting to publish.
      Scheduled syncs publish what changed; manual and first syncs leave it for an explicit Publish.
      Review-policy sources send new and changed files to the review queue instead. */
  function processDocs(docs) {
    if (!docs.length) return;
    if (X.processDocs) { X.processDocs(docs, { quiet: true }); return; }
    setTimeout(() => { docs.forEach(d => { if (D.docs.includes(d) && d.status === 'pending') d.status = 'processing'; }); rerender(true); }, 1200);
    setTimeout(() => { docs.forEach(d => { if (D.docs.includes(d) && d.status === 'processing') { d.status = 'ready'; d.error = ''; d.updated = Date.now(); } }); rerender(true); }, 4200);
  }
  /** Published documents from this source that are waiting to be (re)published. Submissions in review don't count. */
  const waitingDocs = s => D.docs.filter(d => d.source === s.id && !d.archived && stageOf(d) === 'published' && ['pending', 'outdated'].includes(d.status));
  A['src-process'] = el => {
    const s = srcById(el.dataset.id); const docs = s ? waitingDocs(s) : [];
    if (!docs.length) { toast('Nothing waiting to publish', { tone: 'accent' }); return; }
    processDocs(docs); audit('Started publishing', s.name);
    toast(`Publishing ${plural(docs.length, 'document')} from ${s.name}`); rerender(true);
  };
  A['src-process-all'] = () => {
    const list = D.sources.filter(s => s.status !== 'syncing'); const docs = list.flatMap(waitingDocs);
    if (!docs.length) return;
    processDocs(docs); audit(`Started publishing ${plural(docs.length, 'document')}`, 'Sources');
    toast(`Publishing ${plural(docs.length, 'document')}`); rerender(true);
  };
  /** A synced file that waits for a reviewer: a submission with no person behind it (via 'sync'). versionOf marks a changed file. */
  function syncSubmission(src, name, { versionOf } = {}) {
    const at = Date.now();
    const d = mkDoc(src.kb, uid('d'), name, { source: src.id, addedBy: src.name, updated: at, status: 'pending' });
    d.stage = 'review';
    d.submission = { by: null, via: 'sync', at, note: '', kbBy: 'contributor', ...(versionOf ? { versionOf } : {}), events: [{ at, by: null, kind: 'submitted', text: `Synced from ${src.name}` }] };
    D.docs.push(d); analyzeSoon(d);
    return d;
  }
  function finishRun(src, run) {
    clearInterval(ENG.timers[run.id]); delete ENG.timers[run.id];
    const p = run.plan || { added: 0, updated: run.counts.total, failed: 0 };
    run.counts.failed = p.failed || 0; run.counts.ok = run.counts.total - run.counts.failed;
    run.status = run.counts.failed ? 'partial' : 'completed'; run.dur = Date.now() - run.started; run.added = p.added; run.updated = p.updated;
    if (run.counts.failed) run.failures = p.failures || [];
    delete run.plan;
    if (src && D.sources.includes(src)) {
      src.status = src.prevStatus === 'paused' ? 'paused' : 'healthy'; delete src.prevStatus; src.progress = null; src.runId = null;
      src.last = { at: Date.now(), result: run.status, added: p.added, updated: p.updated, removed: 0, failed: run.counts.failed };
      src.next = src.status === 'paused' ? null : nextAt(src.schedule);
      const own = D.docs.filter(d => d.source === src.id && !d.archived && stageOf(d) === 'published'), affected = [], toReview = [];
      const review = policyOf(src) === 'review';
      // Approved documents that didn't finish publishing are retried either way.
      own.filter(d => ['failed', 'pending', 'outdated'].includes(d.status) && !isLocked(d)).forEach(d => { d.status = 'pending'; d.error = ''; d.updated = Date.now(); affected.push(d); });
      const changed = own.filter(d => d.status === 'ready').slice(0, Math.max(0, p.updated - affected.length));
      if (review) {
        // Changed files become new-version submissions; the published copy keeps answering until a reviewer approves.
        const open = new Set(D.docs.filter(x => !x.archived && stageOf(x) === 'review').map(x => x.submission?.versionOf).filter(Boolean));
        changed.filter(d => !open.has(d.id)).forEach(d => toReview.push(syncSubmission(src, d.name, { versionOf: d.id })));
        for (let i = 0; i < p.added; i++) toReview.push(syncSubmission(src, docName(src.app)));
        if (toReview.length) audit(`Sent ${plural(toReview.length, 'synced file')} to review`, src.name);
      } else {
        changed.forEach(d => { d.status = 'pending'; d.updated = Date.now(); affected.push(d); });
        for (let i = 0; i < p.added; i++) {
          const d = mkDoc(src.kb, uid('d'), docName(src.app), { source: src.id, addedBy: src.name, updated: Date.now(), status: 'pending' });
          D.docs.push(d); affected.push(d);
        }
      }
      src.last.review = toReview.length;
      const kb = kbById(src.kb); if (kb) kb.updated = Date.now();
      if (run.trigger === 'Scheduled') processDocs(affected);
      else {
        const parts = [toReview.length && `${plural(toReview.length, 'document')} sent to review`, (affected.length || !review) && `${plural(affected.length, 'document')} waiting to publish`].filter(Boolean);
        const action = toReview.length && canReview() ? { label: 'Review', run: () => go('/documents?tab=review') }
          : affected.length ? { label: 'Publish', run: () => A['src-process']({ dataset: { id: src.id } }) }
          : kb ? { label: 'View', run: () => go(`/knowledge/${kb.id}?tab=documents`) } : undefined;
        toast(`${src.name} synced · ${parts.join(' · ') || 'no changes'}`, { tone: run.counts.failed ? 'accent' : 'success', action });
      }
    }
    rerender(true);
  }
  function stopRun(run) {
    const src = srcById(run.source); clearInterval(ENG.timers[run.id]); delete ENG.timers[run.id];
    run.status = 'cancelled'; run.dur = Date.now() - run.started; run.counts.skipped = Math.max(0, run.counts.total - run.counts.ok - run.counts.failed);
    run.added = Math.min(run.plan?.added || 0, run.counts.ok); run.updated = run.counts.ok - run.added; delete run.plan;
    if (src) {
      src.status = src.prevStatus === 'paused' ? 'paused' : 'healthy'; delete src.prevStatus; src.progress = null; src.runId = null;
      src.last = { at: Date.now(), result: 'cancelled', added: 0, updated: run.counts.ok, removed: 0, failed: 0 };
      src.next = src.status === 'paused' ? null : nextAt(src.schedule);
    }
    audit('Cancelled a sync', src?.name || runName(run));
  }
  /** Resumes runs that were in flight (mock data or before a reload); idempotent. */
  function boot() {
    if ((ENG.bootedWs ||= {})[S.ws]) return; ENG.bootedWs[S.ws] = true; if (srcById('src-hr')) seedHistory();
    D.runs.filter(r => r.status === 'running' || r.status === 'queued').forEach(r => {
      const s = srcById(r.source);
      if (!s) { r.status = 'cancelled'; r.dur = Date.now() - r.started; delete r.plan; return; }
      r.status = 'running';
      const left = Math.max(1, r.counts.total - r.counts.ok);
      r.plan = r.plan || { added: Math.min(4, r.counts.total), updated: Math.max(0, r.counts.total - 4), failed: 0 };
      s.prevStatus = s.prevStatus || 'healthy'; s.status = 'syncing'; s.runId = r.id; s.progress = { done: r.counts.ok, total: r.counts.total };
      drive(s, r, { every: Math.max(600, Math.round(10000 / left)), inc: 1 });
    });
    D.sources.filter(s => s.status === 'syncing' && runById(s.runId)?.status !== 'running').forEach(s => { s.status = 'healthy'; s.progress = null; s.runId = null; delete s.prevStatus; });
    D.sources.forEach(s => { if (s.next) s.next = nextAt(s.schedule); });
  }
  window.addEventListener('load', boot);
  /** An account works again: its waiting sources resume and start syncing. Returns those sources. */
  function resumeAccount(acc) {
    const fixed = D.sources.filter(s => s.account === acc.id && ['reconnect', 'failed'].includes(s.status));
    fixed.forEach(s => { s.status = 'healthy'; s.next = nextAt(s.schedule); startSync(s, { plan: s.id === 'src-sales' ? { added: 3, updated: 5, failed: 0 } : undefined }); });
    return fixed;
  }
  /** Point a source at another account (used after connecting a new one). */
  function attach(s, acc) {
    if (!s || !acc) return;
    s.account = acc.id; audit('Changed source account', s.name);
    if (['reconnect', 'failed'].includes(s.status) || (s.status === 'paused' && s.noAccount)) { delete s.noAccount; s.status = 'healthy'; s.next = nextAt(s.schedule); startSync(s); }
    toast(`${s.name} now syncs with ${acc.label}`);
  }
  /** An account was disconnected: its sources pause and stop any running sync. */
  function detachAccount(acc) {
    const list = D.sources.filter(s => s.account === acc.id);
    list.forEach(s => { const r = runById(s.runId); if (r?.status === 'running') stopRun(r); s.status = 'paused'; s.noAccount = true; s.account = null; s.next = null; });
    return list;
  }
  X.src = { boot, startSync, resumeAccount, attach, detachAccount, schedText, rerender, audit, open: id => A['src-open']({ dataset: { id } }) };

  /* ═══════════════ Page ═══════════════ */
  P.sources = ({ query }) => {
    boot();
    const tab = query.tab === 'history' ? 'history' : 'sources';
    const live = S.pageState === 'live' && !S.navLoading;
    const alerts = live ? attention() : '';
    const empty = tab === 'sources' && !S.navLoading && (S.pageState === 'empty' || (S.pageState === 'live' && !D.sources.length));
    const actions = empty ? '' : btn('Connect source', { v: alerts ? 'secondary' : 'primary', icon: 'plus', act: 'src-connect' });
    return `<div class="page">${pageHeader({ title: 'Sources', desc: 'Apps that keep your knowledge bases up to date.', actions })}${alerts}<div class="page-tabs">${tabs([{ id: 'sources', label: 'Sources', count: live ? D.sources.length : null }, { id: 'history', label: 'Sync history' }], tab, '/sources')}</div>${tab === 'history' ? tabHistory() : tabSources()}</div>`;
  };
  /** One alert per problem: an expired account (grouping its sources) or a failed source. */
  function attention() {
    const out = [], byAcc = {};
    D.sources.filter(s => s.status === 'reconnect').forEach(s => (byAcc[s.account] ||= []).push(s));
    Object.entries(byAcc).forEach(([accId, list]) => {
      const acc = accById(accId); const who = list.length === 1 ? list[0].name : `${list[0].name} and ${plural(list.length - 1, 'other source')}`;
      out.push(alertBox('danger', `${who} can’t sync — ${appName(list[0].app)} access expired`, acc ? `Sign in again as ${esc(acc.user)}. Synced documents stay searchable.` : '', btn('Reconnect', { v: 'primary', size: 'sm', act: 'acc-reconnect', data: { id: accId } })));
    });
    D.sources.filter(s => s.status === 'failed').forEach(s => out.push(alertBox('danger', `${s.name} couldn’t sync`, esc(s.last?.error || 'Try syncing again.'), btn('Sync now', { v: 'primary', size: 'sm', act: 'src-sync', data: { id: s.id } }))));
    const waitSrc = D.sources.filter(s => s.status !== 'syncing' && waitingDocs(s).length);
    if (waitSrc.length) {
      const n = waitSrc.reduce((a, s) => a + waitingDocs(s).length, 0);
      out.push(alertBox('accent', `${plural(n, 'synced document')} waiting to publish`, `From ${esc(waitSrc.map(s => s.name).join(', '))}. Publishing makes them searchable.`, btn('Publish all waiting', { size: 'sm', icon: 'play', act: 'src-process-all' })));
    }
    return out.length ? `<div class="stack gap-8 mb-16">${out.join('')}</div>` : '';
  }
  const emptySources = () => emptyState({ icon: 'plug', title: 'Connect your first source', desc: 'Keep a knowledge base in sync with Google Drive or Confluence.', actions: btn('Connect source', { v: 'primary', icon: 'plus', act: 'src-connect' }), boxed: true });

  /* ── Sources tab ── */
  function tabSources() {
    const u = ui('srcList', { q: '', status: '' });
    return gate({
      loading: () => skelRows(4),
      empty: emptySources,
      ok: () => {
        if (!D.sources.length) return emptySources();
        const toolbar = `<div class="toolbar">${searchField({ uiKey: 'srcList', placeholder: 'Search sources' })}${filterButton('Status', 'srcList', 'status', [['healthy', 'Up to date'], ['syncing', 'Syncing'], ['attention', 'Needs attention'], ['paused', 'Paused']])}${clearFilters('srcList', ['status'])}</div>`;
        let rows = D.sources.filter(s => (!u.status || (u.status === 'attention' ? ['failed', 'reconnect'].includes(s.status) : s.status === u.status)) && matchesQ('srcList', s.name, kbById(s.kb)?.name, accById(s.account)?.label, appName(s.app), ...(s.scope || [])));
        rows = applySort(rows, 'srcList', { name: s => s.name.toLowerCase(), last: s => s.last?.at || 0 });
        if (!rows.length) return toolbar + noMatches('srcList', ['status'], 'sources');
        const head = sortHead('Source', 'name', 'srcList') + th('Knowledge base') + th('Schedule') + sortHead('Last sync', 'last', 'srcList') + th('Status') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
        return toolbar + table({ label: 'Sources', head, rows: rows.map(srcRow) });
      },
    });
  }
  function syncingChip(s) {
    const p = s.progress || { done: 0, total: 0 };
    return `<div class="src-syncing">${status('source', 'syncing')}<span class="src-syncing__bar">${progress(p.done / Math.max(1, p.total) * 100, '', 'Sync progress')}<span class="num t-xs muted">${p.done}/${p.total}</span></span></div>`;
  }
  function rowAction(s) {
    const acc = accById(s.account);
    if (s.status === 'reconnect') return btn('Reconnect', { size: 'sm', act: 'acc-reconnect', data: { id: s.account } });
    if (s.status === 'syncing') return btn('Cancel', { v: 'ghost', size: 'sm', act: 'src-cancel', data: { id: s.id } });
    if (s.status === 'paused') return btn('Resume', { size: 'sm', icon: 'play', act: 'src-pause', data: { id: s.id } });
    if (acc?.status !== 'connected') return '';
    return btn('Sync now', { size: 'sm', icon: 'refresh', act: 'src-sync', data: { id: s.id } });
  }
  function policyNote(s) { const p = POLICY[policyOf(s)]; return `<span class="cell-sub src-policy src-policy--${policyOf(s)}" title="${esc(p.desc)}">${ic(p.icon, 'i-xs')}<span class="truncate">${esc(p.short)}</span></span>`; }
  function srcRow(s) {
    const acc = accById(s.account);
    const last = s.last ? `<div class="stack"><span>${rel(s.last.at)}</span><span class="cell-sub ${s.last.result === 'failed' ? 'text-danger' : s.last.failed ? 'text-warning' : ''}">${esc(lastText(s.last))}</span></div>` : '<span class="muted">Never</span>';
    return `<tr class="${cx('table__row', ENG.newId === s.id && 'table__row--new')}" data-act="src-open" data-id="${s.id}" tabindex="0">
      <td class="table__cell table__cell--primary"><div class="row gap-12">${appIcon(s.app)}<div class="stack src-min"><span class="cell-title truncate">${esc(s.name)}</span><span class="cell-sub truncate">${esc(acc ? scopeText(s) : 'No account')}</span></div></div></td>
      <td class="table__cell"><div class="stack src-min src-kbcell">${kbLink(kbById(s.kb))}${policyNote(s)}</div></td>
      <td class="table__cell table__cell--hide-sm ${s.status === 'paused' ? 'muted' : ''}">${esc(schedText(s.schedule))}</td>
      <td class="table__cell table__cell--hide-sm">${last}</td>
      <td class="table__cell">${s.status === 'syncing' ? syncingChip(s) : status('source', s.status)}</td>
      <td class="table__cell table__cell--actions src-actions"><div class="row gap-4">${rowAction(s)}${iconBtn('more', 'More actions', { size: 'sm', menu: 'src-row', data: { id: s.id } })}</div></td></tr>`;
  }
  MENUS['src-row'] = el => {
    const s = srcById(el.dataset.id); if (!s) return [];
    const syncing = s.status === 'syncing', paused = s.status === 'paused';
    const items = [];
    if (el.dataset.ctx !== 'drawer') items.push(
      { label: 'Sync now', icon: 'refresh', disabled: syncing, run: () => A['src-sync']({ dataset: { id: s.id } }) },
      { label: 'Edit schedule', icon: 'clock', run: () => A['src-open']({ dataset: { id: s.id, focus: 'schedule' } }) },
      { label: paused ? 'Resume' : 'Pause', icon: paused ? 'play' : 'pause', disabled: syncing, run: () => A['src-pause']({ dataset: { id: s.id } }) });
    items.push({ label: 'Change what’s synced', icon: 'folder', disabled: !accById(s.account), run: () => openWizard({ mode: 'scope', srcId: s.id }) },
      { label: 'View sync history', icon: 'history', run: () => A['src-history']({ dataset: { id: s.id } }) },
      { sep: true }, { label: 'Disconnect', icon: 'trash', danger: true, run: () => A['src-disconnect']({ dataset: { id: s.id } }) });
    return items;
  };

  /* ── Sync history tab ── */
  const RUN_STATUS = [['running', 'In progress'], ['completed', 'Completed'], ['partial', 'Completed with issues'], ['failed', 'Failed'], ['cancelled', 'Cancelled']];
  function tabHistory() {
    const u = ui('srcRuns', { source: '', status: '' });
    const none = () => emptyState({ icon: 'history', title: 'No syncs yet', desc: 'Syncs appear here once a source runs.', boxed: true });
    return gate({
      loading: () => skelRows(6),
      empty: none,
      ok: () => {
        const all = D.runs.filter(r => r.source);
        if (!all.length) return none();
        const srcOpts = [...new Map(all.map(r => [r.source, runName(r)])).entries()];
        const toolbar = `<div class="toolbar">${filterButton('Source', 'srcRuns', 'source', srcOpts)}${filterButton('Status', 'srcRuns', 'status', RUN_STATUS)}${clearFilters('srcRuns', ['source', 'status'])}</div>`;
        const rows = all.filter(r => (!u.source || r.source === u.source) && (!u.status || r.status === u.status || (u.status === 'running' && r.status === 'queued'))).sort((a, b) => b.started - a.started);
        if (!rows.length) return toolbar + noMatches('srcRuns', ['source', 'status'], 'syncs');
        const head = th('Source') + th('Trigger') + th('Started') + th('Duration') + th('Documents') + th('Status');
        return toolbar + table({ label: 'Sync history', head, rows: paginate(rows, 'srcRuns', 10).map(runRow), foot: pager(rows.length, 'srcRuns', 10) });
      },
    });
  }
  function runRow(r) {
    const dur = r.status === 'running' ? Date.now() - r.started : r.dur;
    const docs = r.status === 'running' || r.status === 'queued'
      ? `<span class="src-syncing__bar">${progress(r.counts.ok / Math.max(1, r.counts.total) * 100, '', 'Sync progress')}<span class="num t-xs muted">${r.counts.ok}/${r.counts.total}</span></span>`
      : `<span class="${r.counts.failed ? 'text-warning' : ''}">${esc(deltaText(r))}</span>`;
    return `<tr class="table__row" data-act="src-run-open" data-id="${r.id}" tabindex="0">
      <td class="table__cell table__cell--primary"><div class="row gap-12">${appIcon(runApp(r))}<div class="stack src-min"><span class="cell-title truncate">${esc(runName(r))}</span><span class="cell-sub truncate">${esc(kbById(r.kb)?.name || '')}</span></div></div></td>
      <td class="table__cell table__cell--hide-sm">${r.trigger === 'Scheduled' ? 'Scheduled' : `<div class="stack"><span>${esc(r.trigger)}</span><span class="cell-sub truncate">${esc(r.by)}</span></div>`}</td>
      <td class="table__cell num">${esc(fmtDateTime(r.started))}</td>
      <td class="table__cell table__cell--hide-sm num muted">${dur ? fmtDuration(dur) : '—'}</td>
      <td class="table__cell">${docs}</td>
      <td class="table__cell">${status('run', r.status)}</td></tr>`;
  }

  /* ═══════════════ Row / drawer actions ═══════════════ */
  A['src-sync'] = el => {
    boot(); const s = srcById(el.dataset.id); if (!s) return;
    const acc = accById(s.account);
    if (!acc) { toast('Choose an account for this source first', { tone: 'danger' }); if (S.drawer?.props?.id !== s.id) A['src-open']({ dataset: { id: s.id } }); return; }
    if (s.status === 'reconnect' || acc.status !== 'connected') return A['acc-reconnect']?.({ dataset: { id: acc.id } });
    if (s.status === 'syncing') return toast(`${s.name} is already syncing`, { tone: 'accent' });
    startSync(s); audit('Started a sync', s.name);
    toast(`Syncing ${s.name}…`, { tone: 'accent' }); refresh();
  };
  A['src-cancel'] = el => {
    const r = runById(el.dataset.run) || runById(srcById(el.dataset.id)?.runId); if (!r || r.status !== 'running') return;
    stopRun(r); toast(`Sync cancelled. ${plural(r.counts.ok, 'document')} already synced stay.`); refresh();
  };
  A['src-pause'] = el => {
    const s = srcById(el.dataset.id); if (!s || s.status === 'syncing') return;
    const before = { status: s.status, next: s.next };
    if (s.status === 'paused') {
      const acc = accById(s.account);
      if (!acc) { toast('Choose an account for this source first', { tone: 'danger' }); if (S.drawer?.props?.id !== s.id) A['src-open']({ dataset: { id: s.id } }); return; }
      s.status = acc.status === 'expired' ? 'reconnect' : 'healthy'; s.next = nextAt(s.schedule);
      audit('Resumed a source', s.name);
      toast(s.status === 'reconnect' ? `Resumed ${s.name}. Reconnect ${appName(s.app)} to sync again.` : `Resumed ${s.name}`, { tone: s.status === 'reconnect' ? 'accent' : 'success' });
    } else {
      s.status = 'paused'; s.next = null; audit('Paused a source', s.name);
      toast(`Paused ${s.name}`, { action: { label: 'Undo', run: () => { if (s.status !== 'paused') return; s.status = before.status; s.next = before.next; refresh(); } } });
    }
    refresh();
  };
  A['src-disconnect'] = el => {
    const s = srcById(el.dataset.id); if (!s) return; const kb = kbById(s.kb);
    confirmAction({ title: `Disconnect ${s.name}?`, body: `Documents already in ${esc(kb?.name || 'the knowledge base')} stay. New changes stop syncing.`, confirm: 'Disconnect', danger: true, onConfirm: () => {
      const r = runById(s.runId); if (r?.status === 'running') stopRun(r);
      D.sources.splice(D.sources.indexOf(s), 1);
      D.docs.forEach(d => { if (d.source === s.id) d.source = 'upload'; });
      if (S.drawer?.props?.id === s.id) S.drawer = null;
      audit('Disconnected a source', s.name); toast(`Disconnected ${s.name}`); refresh();
    } });
  };
  A['src-history'] = el => {
    const u = ui('srcRuns', {}); u.source = el.dataset.id || ''; u.status = ''; u.page = 1; S.drawer = null;
    if (S.cur?.r.page === 'sources') setQuery({ tab: 'history' }); else go('/sources?tab=history');
  };

  /* ═══════════════ Source drawer ═══════════════ */
  function schedInit(s) { const c = s.schedule; S.ui.srcSched = { id: s.id, freq: c.freq, day: c.day || 'Mon', time: c.time || '02:00', tz: c.tz || 'Asia/Ho_Chi_Minh' }; }
  const schedDirty = (f, c) => f.freq !== c.freq || (f.freq !== 'manual' && (f.time !== c.time || f.tz !== c.tz || (f.freq === 'weekly' && f.day !== c.day)));
  A['src-open'] = el => {
    boot(); const s = srcById(el.dataset.id);
    if (!s) { toast('This source was disconnected', { tone: 'danger' }); return; }
    schedInit(s); openDrawer('src-source', { id: s.id });
    if (el.dataset.focus === 'schedule') requestAnimationFrame(() => { const sec = $('#src-sched'); sec?.scrollIntoView({ block: 'start' }); sec?.querySelector('[aria-pressed="true"]')?.focus(); });
  };
  const sec = (title, body, actions = '', id = '') => `<section class="drawer__section" ${id ? `id="${id}"` : ''}><div class="src-sec__head"><h3 class="drawer__section-title">${esc(title)}</h3>${actions}</div>${body}</section>`;
  function sourceSummary(s, acc, kb) {
    let top = '';
    if (s.status === 'reconnect') top = alertBox('danger', `${appName(s.app)} access expired`, `Sign in again as ${esc(acc?.user || 'the account owner')}. Documents in ${esc(kb?.name || 'the knowledge base')} stay searchable.`);
    else if (s.status === 'failed') top = alertBox('danger', 'Last sync failed', esc(s.last?.error || 'Try syncing again.'));
    else if (!acc) top = alertBox('warning', 'No account', 'Choose an account to sync again.', btn('Choose account', { size: 'sm', menu: 'src-acc-switch', data: { id: s.id } }));
    else if (s.status === 'paused') top = alertBox('default', 'Paused', 'Scheduled syncs are off until you resume.');
    else if (s.status === 'syncing') {
      const p = s.progress || { done: 0, total: 0 };
      top = `<div class="card card--secondary src-live"><div class="row between gap-12"><span class="medium">Syncing · ${p.done} of ${plural(p.total, 'document')}</span>${btn('Cancel', { v: 'ghost', size: 'sm', act: 'src-cancel', data: { id: s.id } })}</div>${progress(p.done / Math.max(1, p.total) * 100, '', 'Sync progress')}</div>`;
    }
    const waiting = waitingDocs(s).length;
    if (!top && waiting) top = alertBox('accent', `${plural(waiting, 'document')} waiting to publish`, 'Synced into the knowledge base. Publish them to make them searchable.', srcCan() ? btn('Publish', { v: 'primary', size: 'sm', icon: 'play', act: 'src-process', data: { id: s.id } }) : '');
    const last = s.last ? `${rel(s.last.at)} · <span class="${s.last.result === 'failed' ? 'text-danger' : s.last.failed ? 'text-warning' : ''}">${esc(lastText(s.last).toLowerCase())}</span>` : 'Never';
    const next = s.status === 'paused' ? 'Paused' : s.next ? `${relFuture(s.next)} <span class="muted">· ${esc(fmtDateTime(s.next))}</span>` : s.schedule.freq === 'manual' ? 'When someone clicks Sync now' : s.status === 'reconnect' ? 'After you reconnect' : '—';
    const accCell = `<div class="row gap-8 wrap">${acc ? `<span class="truncate">${esc(acc.label)}</span>${acc.status !== 'connected' ? status('account', acc.status) : ''}` : '<span class="muted">None</span>'}${srcCan() ? btn('Change', { v: 'ghost', size: 'sm', menu: 'src-acc-switch', data: { id: s.id } }) : ''}</div>`;
    return `<section class="drawer__section">${top ? `<div class="mb-16">${top}</div>` : ''}${kv([['Status', s.status === 'syncing' ? status('source', 'syncing') : status('source', s.status)], ['Last sync', last], ['Next sync', next], ['Account', accCell]])}</section>`;
  }
  function schedForm(s) {
    const f = S.ui.srcSched?.id === s.id ? S.ui.srcSched : (schedInit(s), S.ui.srcSched);
    const day = f.freq === 'weekly' ? field({ id: 'src-sch-day', label: 'Day', control: select({ id: 'src-sch-day', bind: 'srcSched.day', value: f.day, options: DAYS, change: 'src-sched-chg' }) }) : '';
    const time = f.freq !== 'manual' ? field({ id: 'src-sch-time', label: 'Time', control: select({ id: 'src-sch-time', bind: 'srcSched.time', value: f.time, options: TIMES, change: 'src-sched-chg' }) }) + field({ id: 'src-sch-tz', label: 'Time zone', control: select({ id: 'src-sch-tz', bind: 'srcSched.tz', value: f.tz, options: TZ, change: 'src-sched-chg' }) }) : '';
    const n = nextAt(f);
    const hint = f.freq === 'manual' ? 'Syncs only when someone clicks Sync now.' : n ? `Next sync ${relFuture(n)} (${esc(tzShort(f.tz))}).` : '';
    const dirty = schedDirty(f, s.schedule);
    return `<div class="stack gap-12">${seg({ value: f.freq, options: [['manual', 'Manual'], ['daily', 'Daily'], ['weekly', 'Weekly']], act: 'src-sched-freq', label: 'How often to sync', full: true })}${day || time ? `<div class="src-sched-grid ${f.freq === 'weekly' ? 'src-sched-grid--3' : ''}">${day}${time}</div>` : ''}<div class="row between gap-12"><span class="description">${hint}</span>${btn('Save schedule', { v: 'secondary', size: 'sm', act: 'src-sched-save', disabled: !dirty })}</div></div>`;
  }
  DR['src-source'] = p => {
    const s = srcById(p.id);
    if (!s) return { title: 'Source disconnected', body: emptyState({ icon: 'plug', title: 'This source was disconnected', desc: 'Documents it synced stay in their knowledge base.' }) };
    const kb = kbById(s.kb), acc = accById(s.account), canM = srcCan();
    const syncing = s.status === 'syncing', paused = s.status === 'paused';
    const scope = sec('What it syncs', list((s.scope?.length ? s.scope : ['Everything']).map(x => item({ lead: ic(s.app === 'gdrive' ? 'folder' : 'book', 'muted'), title: esc(x) }))), canM && acc ? btn('Change', { v: 'ghost', size: 'sm', act: 'src-scope', data: { id: s.id } }) : '');
    const dest = sec('Destination', list([item({ lead: `<span class="src-kb__dot src-kb__dot--lg" style="background:${esc(kb?.color || 'var(--default)')}"></span>`, title: esc(kb?.name || 'Removed knowledge base'), desc: kb ? plural(docsIn(kb.id).length, 'document') : '', trail: kb ? ic('chevron-right', 'muted') : '', href: kb ? `/knowledge/${kb.id}?tab=documents` : undefined })]));
    const sched = canM ? sec('Schedule', schedForm(s), '', 'src-sched') : '';
    const policy = sec('New and changed files', policyForm(s, canM), '', 'src-policy');
    const runs = runsOf(s.id).slice(0, 5);
    const recent = sec('Recent syncs', runs.length ? list(runs.map(r => item({ title: esc(fmtDateTime(r.started)), desc: esc(deltaText(r)), trail: status('run', r.status), act: 'src-run-open', data: { id: r.id } }))) : '<p class="muted">No syncs yet.</p>', runs.length ? btn('View all', { v: 'ghost', size: 'sm', act: 'src-history', data: { id: s.id } }) : '');
    const danger = canM ? sec('Disconnect', `<div class="src-danger"><p class="description grow">Stops syncing. Documents already in ${esc(kb?.name || 'the knowledge base')} stay.</p>${btn('Disconnect', { v: 'danger-soft', size: 'sm', act: 'src-disconnect', data: { id: s.id } })}</div>`) : '';
    let foot = '';
    if (canM) {
      if (syncing) foot = btn('Cancel sync', { icon: 'stop', act: 'src-cancel', data: { id: s.id } });
      else if (s.status === 'reconnect') foot = btn('Reconnect', { v: 'primary', act: 'acc-reconnect', data: { id: s.account } });
      else foot = btn(paused ? 'Resume' : 'Pause', { icon: paused ? 'play' : 'pause', act: 'src-pause', data: { id: s.id } }) + btn('Sync now', { v: 'primary', icon: 'refresh', act: 'src-sync', data: { id: s.id }, disabled: !acc });
    }
    return {
      lead: appIcon(s.app, 'lg'), title: s.name, desc: esc(`${appName(s.app)}${acc ? ' · ' + acc.label : ''}`),
      headActions: canM ? iconBtn('more', 'More actions', { menu: 'src-row', data: { id: s.id, ctx: 'drawer' } }) : '',
      body: sourceSummary(s, acc, kb) + scope + dest + policy + sched + recent + danger,
      foot,
    };
  };
  A['src-sched-freq'] = el => { ui('srcSched').freq = el.dataset.value; refreshLayer(); };
  A['src-sched-chg'] = () => refreshLayer();
  A['src-sched-save'] = () => {
    const f = ui('srcSched'); const s = srcById(f.id); if (!s) return;
    s.schedule = { freq: f.freq, day: f.day, time: f.time, tz: f.tz, on: f.freq !== 'manual' };
    s.next = s.status === 'paused' ? null : nextAt(s.schedule);
    audit('Changed sync schedule', s.name); toast(`Schedule saved · ${schedText(s.schedule)}`); refresh();
  };
  A['src-scope'] = el => openWizard({ mode: 'scope', srcId: el.dataset.id });
  /** Publishing policy: who decides when synced files become searchable. Changes apply to the next sync. */
  function policyForm(s, canM) {
    const cur = policyOf(s), waiting = D.docs.filter(d => d.source === s.id && !d.archived && stageOf(d) === 'review').length;
    const queue = waiting ? `<div class="row gap-8 wrap mt-8"><span class="t-sm muted">${esc(`${plural(waiting, 'file')} from this source waiting in review`)}</span>${canReview() ? linkBtn('Open review', { href: '/documents?tab=review', icon: 'arrow-up-right' }) : ''}</div>` : '';
    if (!canM) return `<div class="row gap-8">${ic(POLICY[cur].icon, 'i-sm muted')}<span class="medium">${esc(POLICY[cur].label)}</span></div><p class="description mt-4">${esc(POLICY[cur].desc)}</p>${queue}`;
    return choiceGroup({ name: `src-pol-${s.id}`, value: cur, options: policyChoices(), act: 'src-policy', data: { id: s.id } }) + `<p class="description mt-8">Applies from the next sync. Files already published stay published.</p>${queue}`;
  }
  A['src-policy'] = el => {
    const s = srcById(el.dataset.id), v = el.dataset.value; if (!s || !srcCan() || !POLICY[v] || policyOf(s) === v) return;
    const before = s.publish;
    s.publish = v; audit(v === 'review' ? 'Set synced files to need review' : 'Set synced files to publish automatically', s.name);
    refresh();
    toast(v === 'review' ? `${s.name}: new and changed files go to review first` : `${s.name}: new and changed files publish automatically`, { action: { label: 'Undo', run: () => { if (before) s.publish = before; else delete s.publish; audit('Changed publishing policy back', s.name); refresh(); } } });
  };
  MENUS['src-acc-switch'] = el => {
    const s = srcById(el.dataset.id); if (!s) return [];
    const items = [{ section: 'Sync with' }, ...D.accounts.filter(a => a.app === s.app).map(a => ({
      label: a.label, checked: a.id === s.account, meta: a.status !== 'connected' ? 'Reconnect needed' : '', disabled: a.status !== 'connected' && a.id !== s.account,
      run: () => { if (a.id === s.account) return; attach(s, a); refresh(); },
    }))];
    items.push({ sep: true }, { label: 'Connect another account', icon: 'plus', run: () => A['acc-connect']?.({ dataset: { app: s.app, src: s.id } }) });
    return items;
  };

  /* ═══════════════ Sync run drawer ═══════════════ */
  A['src-run-open'] = el => { boot(); const r = runById(el.dataset.id); if (r) openDrawer('src-run', { id: r.id }); };
  function runSteps(r) {
    const c = r.counts, el = r.status === 'running' ? Date.now() - r.started : (r.dur || 0);
    const s1 = { label: 'Find changes' }, s2 = { label: 'Read documents' }, s3 = { label: 'Make searchable' };
    if (r.status === 'failed' && !c.total) { s1.st = 'failed'; s1.note = `Couldn’t open ${appName(runApp(r))}`; s1.dur = el; s2.st = s3.st = 'pending'; s2.note = s3.note = 'Not started'; }
    else if (r.status === 'running' || r.status === 'queued') { s1.st = 'done'; s1.note = `Found ${plural(c.total, 'changed document')}`; s1.dur = Math.min(el * 0.15, 20e3); s2.st = 'active'; s2.note = `${c.ok + c.failed} of ${c.total} read`; s3.st = c.ok ? 'active' : 'pending'; s3.note = c.ok ? `${c.ok} ready for questions` : 'Waiting'; }
    else if (r.status === 'cancelled') { s1.st = 'done'; s1.note = `Found ${plural(c.total, 'changed document')}`; s2.st = 'stopped'; s2.note = `Cancelled after ${c.ok} of ${c.total}`; s3.st = 'stopped'; s3.note = `${c.ok} ready for questions`; }
    else { s1.st = s2.st = s3.st = 'done'; s1.note = `Found ${plural(c.total, 'changed document')}`; s1.dur = el * 0.1; s2.note = `${c.ok} read${c.failed ? ` · ${c.failed} couldn’t be read` : ''}`; s2.dur = el * 0.6; s3.note = `${c.ok} ready for questions`; s3.dur = el * 0.3; if (c.failed) s2.st = 'warn'; }
    return [s1, s2, s3];
  }
  const STEP_ICON = { done: ['check-circle', 'success'], warn: ['alert', 'warning'], failed: ['x-circle', 'danger'], pending: ['clock', 'default'], stopped: ['stop', 'default'] };
  function stepsHtml(r) {
    return `<ol class="src-timeline">${runSteps(r).map(st => `<li class="src-timeline__step src-timeline__step--${st.st}"><span class="src-timeline__icon">${st.st === 'active' ? spinner('sm') : ic(STEP_ICON[st.st][0], 'i-sm')}</span><div class="grow"><div class="medium">${esc(st.label)}</div><div class="description">${esc(st.note)}</div></div>${st.dur >= 1000 ? `<span class="t-xs muted num">${fmtDuration(st.dur)}</span>` : ''}</li>`).join('')}</ol>`;
  }
  DR['src-run'] = p => {
    const r = runById(p.id); if (!r) return { title: 'Sync not found', body: emptyState({ icon: 'history', title: 'This sync is no longer available' }) };
    const s = srcById(r.source), acc = s && accById(s.account), canM = srcCan(), c = r.counts;
    const who = r.trigger === 'Scheduled' ? 'Scheduled' : r.trigger === 'Upload' ? `Uploaded by ${r.by}` : `Started by ${r.by}`;
    let top = '';
    if (r.status === 'failed' && r.error) top = alertBox('danger', `Couldn’t reach ${appName(runApp(r))}`, esc(r.error), acc?.status === 'expired' && canM ? btn('Reconnect', { v: 'primary', size: 'sm', act: 'acc-reconnect', data: { id: acc.id } }) : '');
    if (r.status === 'running') top = `<div class="card card--secondary src-live"><div class="row between gap-12"><span class="medium">${c.ok + c.failed} of ${plural(c.total, 'document')}</span>${canM ? btn('Cancel', { v: 'ghost', size: 'sm', act: 'src-cancel', data: { run: r.id } }) : ''}</div>${progress((c.ok + c.failed) / Math.max(1, c.total) * 100, '', 'Sync progress')}</div>`;
    const d = delta(r);
    const tiles = r.status === 'running' ? '' : `<div class="src-counts">${[['Added', d.added], ['Updated', d.updated], ['Failed', d.failed], ...(c.skipped ? [['Skipped', c.skipped]] : [])].map(([l, n]) => `<div class="src-counts__tile"><div class="src-counts__n num ${l === 'Failed' && n ? 'text-danger' : ''}">${fmtNum(n)}</div><div class="t-xs muted">${l}</div></div>`).join('')}</div>`;
    const fails = (r.failures || []).map(docById).filter(Boolean), open = fails.filter(x => x.status === 'failed');
    const failHtml = fails.length ? sec('Couldn’t publish', list(fails.map(x => item({ lead: fileIcon(x.type, 'sm'), title: esc(x.name), desc: esc(x.status === 'failed' ? (x.error || 'This file couldn’t be read.') : 'Published in a later sync.'), trail: x.status === 'failed' ? ic('chevron-right', 'muted') : status('doc', x.status), href: `/doc/${x.id}` })))) : '';
    let foot = '';
    if (s) foot = btn('Open source', { act: 'src-open', data: { id: s.id } }) + (canM && open.length ? btn('Retry failed', { v: 'primary', icon: 'retry', act: 'src-retry', data: { id: r.id }, disabled: s.status === 'syncing' }) : '');
    return {
      lead: appIcon(runApp(r), 'lg'), title: runName(r), desc: esc(`${fmtDateTime(r.started)} · ${who}`),
      body: `<section class="drawer__section"><div class="row gap-8 wrap mb-16">${status('run', r.status)}${r.dur ? `<span class="t-sm muted">Took ${fmtDuration(r.dur)}</span>` : ''}</div>${top ? `<div class="mb-16">${top}</div>` : ''}${tiles}</section>${sec('Steps', stepsHtml(r))}${failHtml}`,
      foot,
    };
  };
  A['src-retry'] = el => {
    const r = runById(el.dataset.id); const s = r && srcById(r.source); if (!s) return;
    if (accById(s.account)?.status !== 'connected') return A['acc-reconnect']?.({ dataset: { id: s.account } });
    const docs = (r.failures || []).map(docById).filter(d => d?.status === 'failed'); if (!docs.length) return;
    const stuck = docs.filter(isLocked);
    const nr = startSync(s, { plan: { added: 0, updated: docs.length - stuck.length, failed: stuck.length, failures: stuck.map(d => d.id) }, ticks: 3 });
    if (!nr) return toast(`${s.name} is already syncing`, { tone: 'accent' });
    audit('Retried failed documents', s.name); toast(`Retrying ${plural(docs.length, 'document')}…`, { tone: 'accent' });
    openDrawer('src-run', { id: nr.id }); refresh();
  };

  /* ═══════════════ Connect wizard ═══════════════ */
  const TIDX = {};
  function treeIdx(app) {
    if (TIDX[app]) return TIDX[app];
    const byId = {}, parent = {}, path = {};
    const walk = (nodes, par, pre) => nodes.forEach(n => { byId[n.id] = n; parent[n.id] = par; path[n.id] = pre ? pre + ' / ' + n.name : n.name; if (n.kids) walk(n.kids, n.id, path[n.id]); });
    walk(TREE[app] || [], null, '');
    return (TIDX[app] = { byId, parent, path });
  }
  const leaves = n => n.kids ? n.kids.flatMap(leaves) : [n];
  const nodeDocs = n => leaves(n).reduce((a, l) => a + l.docs, 0);
  function nodeState(n, sel) { const L = leaves(n); const k = L.filter(l => sel[l.id]).length; return k === 0 ? 'none' : k === L.length ? 'all' : 'some'; }
  function selItems(app, sel) { const out = []; const walk = nodes => nodes.forEach(n => { const st = nodeState(n, sel); if (st === 'all') out.push(n); else if (st === 'some') walk(n.kids); }); walk(TREE[app] || []); return out; }
  const treeMatch = (n, q) => n.name.toLowerCase().includes(q) || (n.kids || []).some(k => treeMatch(k, q));
  function wizName(w, items) {
    const idx = treeIdx(w.app), first = items[0]; if (!first) return '';
    let name = first.name;
    if (w.app === 'confluence') { let top = first; while (idx.parent[top.id]) top = idx.byId[idx.parent[top.id]]; name = items.length === 1 && first !== top ? `${top.name} — ${first.name}` : `${top.name} space`; }
    let n = name, i = 2; while (D.sources.some(s => s.name === n)) n = `${name} ${i++}`;
    return n;
  }
  /** Opens the wizard. kb preselects the destination; app/acc jump to content; mode 'scope' edits a source's content. */
  function openWizard({ kb, app, acc, mode = 'create', srcId } = {}) {
    if (!srcCan()) { toast('Ask a workspace admin to connect sources', { tone: 'accent' }); return; }
    boot();
    const w = S.ui.srcWiz = { step: 1, mode, srcId: '', app: '', acc: '', oauth: '', t: null, oauthErr: '', rcAcc: '', conf: { site: '', email: '', token: '' }, cerr: {}, sel: {}, open: {}, openFor: '', q: '', selErr: '', kb: '', kbName: '', freq: 'daily', day: 'Mon', time: '02:00', tz: 'Asia/Ho_Chi_Minh', publish: 'review', err: {}, busy: false, ask: false, init: '' };
    const k = kbById(kb); if (k && !k.personal && canEditKb(k)) w.kb = k.id;
    if (mode === 'scope') {
      const s = srcById(srcId); if (!s) return;
      w.srcId = s.id; w.app = s.app; w.acc = s.account; w.step = 3; w.openFor = s.app;
      const idx = treeIdx(s.app);
      (s.scope || []).forEach(p => {
        const id = Object.keys(idx.path).find(i => idx.path[i] === p || idx.path[i].endsWith(' / ' + p) || idx.path[i].replace(/^Shared drives \/ /, '') === p);
        if (!id) return;
        leaves(idx.byId[id]).forEach(l => (w.sel[l.id] = true));
        let a = idx.parent[id]; while (a) { w.open[a] = true; a = idx.parent[a]; }
      });
      w.init = JSON.stringify(w.sel);
    } else if (app && TREE[app]) {
      w.app = app; w.acc = accById(acc)?.status === 'connected' ? acc : '';
      w.step = w.acc ? 3 : 2; if (!w.acc) w.acc = D.accounts.find(a => a.app === app && a.status === 'connected')?.id || 'new';
      if (w.step === 3) prepTree(w);
    }
    S.ui.srcWiz = w;
    openModal('src-wizard', { guard: true });
  }
  X.src.openWizard = openWizard;
  A['src-connect'] = el => openWizard({ kb: el?.dataset?.kb, app: el?.dataset?.app, acc: el?.dataset?.acc });
  function prepTree(w) { if (w.openFor === w.app) return; w.open = {}; w.sel = {}; w.q = ''; if (w.app === 'gdrive') TREE.gdrive.forEach(n => (w.open[n.id] = true)); w.openFor = w.app; }
  function wizGo(w, step) {
    w.step = step; w.ask = false; w.selErr = ''; w.oauthErr = '';
    if (step === 3) prepTree(w);
    refreshLayer(); const mb = $('#modal-body'); if (mb) mb.scrollTop = 0;
  }
  M['src-wizard'] = () => {
    const w = S.ui.srcWiz; if (!w) return { title: 'Connect a source', body: '' };
    const scope = w.mode === 'scope', s = scope && srcById(w.srcId);
    const stepper = scope ? '' : `<ol class="src-stepper" aria-label="Steps">${WIZ_STEPS.map((l, i) => { const n = i + 1; const st = n < w.step ? 'done' : n === w.step ? 'current' : 'todo'; return `<li class="src-stepper__step src-stepper__step--${st}" ${n === w.step ? 'aria-current="step"' : ''}><span class="src-stepper__dot">${n < w.step ? ic('check', 'i-xs') : n}</span><span class="src-stepper__label">${esc(l)}</span></li>`; }).join('')}</ol>`;
    const body = w.step === 1 ? step1(w) : w.step === 2 ? step2(w) : w.step === 3 ? step3(w) : step4(w);
    const f = wizFoot(w);
    return { size: 'lg', noClose: w.oauth === 'waiting' || !!w.rcAcc, title: scope ? 'Change what’s synced' : 'Connect a source', desc: scope ? esc(`${s?.name || ''} · ${appName(w.app)}`) : '', body: stepper + body, foot: f.foot, footStart: f.start };
  };
  function wizFoot(w) {
    if (w.ask) return { start: `<span class="t-sm medium">${w.mode === 'scope' ? 'Discard your changes?' : 'Discard this source?'}</span>`, foot: btn('Keep editing', { act: 'src-wiz-keep' }) + btn('Discard', { v: 'danger', act: 'src-wiz-discard' }) };
    if (w.oauth === 'waiting' || w.rcAcc) return { foot: btn('Cancel', { act: 'src-wiz-oauth-cancel' }) };
    const back = btn('Back', { act: 'src-wiz-back', disabled: w.busy });
    if (w.step === 1) return { foot: btn('Cancel', { act: 'src-wiz-close' }) + btn('Continue', { v: 'primary', act: 'src-wiz-next', disabled: !w.app }) };
    if (w.step === 2) {
      if (w.acc === 'new' && w.app === 'gdrive') return { foot: back + btn('Continue with Google', { v: 'primary', iconRight: 'external', act: 'src-wiz-next' }) };
      if (w.acc === 'new') return { foot: back + btn('Verify and continue', { v: 'primary', act: 'src-wiz-next', loading: w.busy }) };
      const a = accById(w.acc); return { foot: back + btn('Continue', { v: 'primary', act: 'src-wiz-next', disabled: !a || a.status !== 'connected' }) };
    }
    if (w.step === 3) return w.mode === 'scope' ? { foot: btn('Cancel', { act: 'src-wiz-close', disabled: w.busy }) + btn('Save changes', { v: 'primary', act: 'src-wiz-next', loading: w.busy }) } : { foot: back + btn('Continue', { v: 'primary', act: 'src-wiz-next' }) };
    return { foot: back + btn('Connect and sync', { v: 'primary', act: 'src-wiz-next', loading: w.busy }) };
  }
  const waitHtml = (title, sub) => `<div class="src-wait" role="status">${spinner('lg')}<div class="t-subheading">${esc(title)}</div><p class="description">${esc(sub)}</p></div>`;
  function step1(w) {
    const apps = D.pConnectors.filter(c => c.key !== 'upload');
    return `<p class="muted mb-12">Where are the documents?</p><div class="src-apps" role="radiogroup" aria-label="App">${apps.map(c => c.status === 'enabled'
      ? `<button type="button" class="card card--action src-app" role="radio" aria-checked="${w.app === c.key}" data-act="src-wiz-app" data-app="${c.key}">${appIcon(c.key, 'lg')}<span class="src-app__name">${esc(c.name)}</span><span class="src-app__desc">${esc(c.desc)}</span></button>`
      : `<div class="card src-app src-app--off" aria-disabled="true">${appIcon(c.key, 'lg')}<span class="src-app__name">${esc(c.name)}</span><span class="src-app__desc">Not available yet</span><span class="src-app__foot">${(c.requestedBy || []).includes(me().id) ? chip('Requested', { size: 'sm', icon: 'check' }) : linkBtn('Request', { act: 'src-wiz-request', data: { app: c.key } })}</span></div>`).join('')}</div>`;
  }
  function step2(w) {
    const prov = w.app === 'gdrive' ? 'Google' : 'Atlassian';
    if (w.oauth === 'waiting') return waitHtml(`Finish signing in with ${prov}`, `A ${prov} window opened. Come back here when you’re done.`);
    const rows = D.accounts.filter(a => a.app === w.app).map(a => {
      const off = a.status !== 'connected', used = D.sources.filter(s => s.account === a.id).length;
      const trail = off ? (w.rcAcc === a.id ? `<span class="row gap-6 t-sm muted src-choice__trail">${spinner('sm')}Waiting for ${prov}…</span>` : `<span class="src-choice__trail">${btn('Reconnect', { size: 'sm', act: 'src-wiz-reacc', data: { id: a.id }, disabled: w.busy })}</span>`) : '';
      return `<label class="${cx('choice', off && 'src-choice--off')}"><input type="radio" name="src-acc" value="${a.id}" ${w.acc === a.id ? 'checked' : ''} ${off || w.busy ? 'disabled' : ''} data-change="src-wiz-acc" data-value="${a.id}"><span class="radio__control" aria-hidden="true"></span><span class="grow src-min"><span class="choice__title truncate" style="display:block">${esc(a.label)}</span><span class="choice__desc" style="display:block">${off ? 'Access expired — reconnect to use it' : used ? `Used by ${plural(used, 'source')}` : 'Connected'}</span></span>${trail}</label>`;
    }).join('');
    const isNew = w.acc === 'new';
    const add = `<label class="choice"><input type="radio" name="src-acc" value="new" ${isNew ? 'checked' : ''} ${w.busy ? 'disabled' : ''} data-change="src-wiz-acc" data-value="new"><span class="radio__control" aria-hidden="true"></span><span class="grow"><span class="choice__title" style="display:block">Connect a new account</span><span class="choice__desc" style="display:block">${w.app === 'gdrive' ? 'Sign in with Google.' : 'Use your Confluence site and an API token.'}</span></span></label>`;
    const form = isNew && w.app === 'confluence' ? `<div class="src-conf">${X.acc?.confForm('srcWiz.conf', w.conf, w.cerr, 'src-wiz-next') || ''}</div>` : '';
    const err = w.oauthErr ? alertBox('danger', '', esc(w.oauthErr)) : '';
    return `<p class="muted mb-12">Which ${esc(appName(w.app))} account should BoMesh read from?</p><div class="stack gap-8 src-choices">${err}${rows}${add}${form}</div>`;
  }
  function treeRows(nodes, depth, w, q, force) {
    return nodes.map(n => {
      const hit = q && n.name.toLowerCase().includes(q);
      if (q && !force && !treeMatch(n, q)) return '';
      const kids = n.kids || [];
      const open = q ? (kids.some(k => treeMatch(k, q)) || !!w.open[n.id]) : !!w.open[n.id];
      const st = nodeState(n, w.sel), icon = w.app === 'gdrive' ? 'folder' : n.space ? 'book' : 'file-text';
      const tog = kids.length ? btn('', { v: 'ghost', size: 'sm', icon: open ? 'chevron-down' : 'chevron-right', act: 'src-wiz-tog', data: { id: n.id }, muted: true, aria: `aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(n.name)}"`, cls: 'src-tree__tog' }) : '<span class="src-tree__tog" aria-hidden="true"></span>';
      return `<div class="src-tree__row" style="--depth:${depth}">${tog}${checkbox({ label: `<span class="row gap-8 src-min">${ic(icon, 'i-sm muted')}<span class="truncate">${esc(n.name)}</span></span>`, checked: st === 'all', indeterminate: st === 'some', act: 'src-wiz-check', data: { id: n.id } })}<span class="src-tree__count num">${fmtNum(nodeDocs(n))}</span></div>` + (kids.length && open ? treeRows(kids, depth + 1, w, q, force || hit) : '');
    }).join('');
  }
  function step3(w) {
    const q = (w.q || '').trim().toLowerCase(), items = selItems(w.app, w.sel), docs = items.reduce((a, n) => a + nodeDocs(n), 0);
    const noun = w.app === 'gdrive' ? 'folders' : 'spaces and pages';
    const rows = treeRows(TREE[w.app] || [], 0, w, q, false);
    return `<p class="muted mb-12">Choose the ${noun} to keep in sync. New files inside them sync automatically.</p>
      <div class="toolbar src-tree-bar">${searchField({ uiKey: 'srcWiz', placeholder: `Search ${noun}` })}<div class="toolbar__end"><span class="t-sm muted" aria-live="polite">${items.length ? `${plural(items.length, 'item')} · about ${plural(docs, 'document')}` : 'Nothing selected'}</span>${items.length ? btn('Clear', { v: 'ghost', size: 'sm', act: 'src-wiz-clear' }) : ''}</div></div>
      <div class="src-tree" role="group" aria-label="Content to sync">${rows || emptyState({ icon: 'search', title: 'No matches', desc: 'Try a different name.', compact: true })}</div>
      ${w.selErr ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${esc(w.selErr)}</span></div>` : ''}`;
  }
  function step4(w) {
    const kbs = D.kbs.filter(k => !k.archived && !k.personal && canEditKb(k));
    const items = selItems(w.app, w.sel), docs = items.reduce((a, n) => a + nodeDocs(n), 0), idx = treeIdx(w.app);
    const kbF = field({ id: 'src-w-kb', label: 'Knowledge base', required: true, error: w.err.kb, control: select({ id: 'src-w-kb', bind: 'srcWiz.kb', value: w.kb, options: [['', 'Choose a knowledge base'], ...kbs.map(k => [k.id, k.name]), ['__new', 'New knowledge base…']], change: 'src-wiz-kb', attrs: w.err.kb ? 'aria-invalid="true"' : '' }) });
    const nameF = w.kb === '__new' ? field({ id: 'src-w-kbname', label: 'Name', required: true, error: w.err.kbName, control: input({ id: 'src-w-kbname', bind: 'srcWiz.kbName', value: w.kbName, placeholder: 'e.g. Marketing Assets', invalid: !!w.err.kbName, attrs: 'data-input="src-wiz-kbinput"', onEnter: 'src-wiz-next' }) }) : '';
    const sched = `<div class="field"><span class="label">Keep in sync</span>${seg({ value: w.freq, options: [['manual', 'Manual'], ['daily', 'Daily'], ['weekly', 'Weekly']], act: 'src-wiz-freq', label: 'Keep in sync', full: true })}</div>${w.freq === 'manual' ? '<p class="description">Syncs only when someone clicks Sync now.</p>' : `<div class="src-sched-grid ${w.freq === 'weekly' ? 'src-sched-grid--3' : ''}">${w.freq === 'weekly' ? field({ id: 'src-w-day', label: 'Day', control: select({ id: 'src-w-day', bind: 'srcWiz.day', value: w.day, options: DAYS }) }) : ''}${field({ id: 'src-w-time', label: 'Time', control: select({ id: 'src-w-time', bind: 'srcWiz.time', value: w.time, options: TIMES }) })}${field({ id: 'src-w-tz', label: 'Time zone', control: select({ id: 'src-w-tz', bind: 'srcWiz.tz', value: w.tz, options: TZ }) })}</div>`}`;
    const content = items.length ? `${idx.path[items[0].id]}${items.length > 1 ? ` +${items.length - 1}` : ''} · about ${plural(docs, 'document')}` : '—';
    const summary = `<div class="card card--secondary">${kv([['Source', esc(wizName(w, items))], ['Account', `<span class="row gap-8">${appIcon(w.app, 'sm')}<span class="truncate">${esc(accById(w.acc)?.label || '—')}</span></span>`], ['Content', esc(content)]])}</div>`;
    const first = Math.min(docs, 30);
    const then = w.publish === 'review' ? `The first sync sends about ${plural(first, 'file')} to the review queue.` : `About ${plural(first, 'file')} will be ready to publish after the first sync.`;
    const policy = `<div class="field"><span class="label">New and changed files</span>${choiceGroup({ name: 'src-w-pol', value: w.publish, options: policyChoices(), act: 'src-wiz-policy' })}<p class="description">${esc(then)}</p></div>`;
    return `<div class="stack gap-16">${kbF}${nameF}${sched}${policy}${summary}</div>`;
  }

  /* Wizard actions */
  A['src-wiz-app'] = el => {
    const w = ui('srcWiz');
    if (w.app !== el.dataset.app) { w.app = el.dataset.app; w.cerr = {}; const ok = D.accounts.find(a => a.app === w.app && a.status === 'connected'); w.acc = ok ? ok.id : D.accounts.some(a => a.app === w.app) ? '' : 'new'; }
    wizGo(w, 2);
  };
  A['src-wiz-request'] = el => {
    const c = D.pConnectors.find(x => x.key === el.dataset.app); if (!c) return;
    c.requestedBy = [...new Set([...(c.requestedBy || []), me().id])]; c.requests = (c.requests || 0) + 1;
    audit('Requested a connector', c.name);
    toast(`Request for ${c.name} sent to your platform admin`); refreshLayer(); persist();
  };
  A['src-wiz-acc'] = el => { const w = ui('srcWiz'); if (w.busy) return; w.acc = el.dataset.value; w.oauthErr = ''; refreshLayer(); if (w.acc === 'new' && w.app === 'confluence') requestAnimationFrame(() => $('#acc-c-site')?.focus()); };
  A['src-wiz-back'] = () => { const w = ui('srcWiz'); if (w.busy || w.step <= 1) return; wizGo(w, w.step - 1); };
  A['src-wiz-close'] = () => {
    const w = S.ui.srcWiz; if (!w) return closeModal();
    if (w.oauth === 'waiting' || w.rcAcc) return A['src-wiz-oauth-cancel']();
    if (w.busy) return;
    if (w.ask) { w.ask = false; refreshLayer(); return; }
    const dirty = w.mode === 'scope' ? JSON.stringify(w.sel) !== w.init : w.step > 1;
    if (!dirty) { closeModal(); S.ui.srcWiz = null; return; }
    w.ask = true; refreshLayer(); requestAnimationFrame(() => $('#layer .modal__footer .button--danger')?.focus());
  };
  A['src-wiz-keep'] = () => { ui('srcWiz').ask = false; refreshLayer(); };
  A['src-wiz-discard'] = () => { closeModal(); S.ui.srcWiz = null; };
  A['src-wiz-oauth-cancel'] = () => { const w = ui('srcWiz'); w.t = null; w.oauth = ''; w.rcAcc = ''; w.busy = false; refreshLayer(); };
  A['src-wiz-tog'] = el => { const w = ui('srcWiz'); w.open[el.dataset.id] = !w.open[el.dataset.id]; refreshLayer(); };
  A['src-wiz-check'] = el => {
    const w = ui('srcWiz'); const n = treeIdx(w.app).byId[el.dataset.id]; if (!n) return;
    const all = nodeState(n, w.sel) === 'all';
    leaves(n).forEach(l => { if (all) delete w.sel[l.id]; else w.sel[l.id] = true; });
    if (!all) w.selErr = ''; refreshLayer();
  };
  A['src-wiz-clear'] = () => { ui('srcWiz').sel = {}; refreshLayer(); };
  A['src-wiz-kb'] = () => { const w = ui('srcWiz'); if (w.kb) delete w.err.kb; refreshLayer(); if (w.kb === '__new') requestAnimationFrame(() => $('#src-w-kbname')?.focus()); };
  A['src-wiz-freq'] = el => { ui('srcWiz').freq = el.dataset.value; refreshLayer(); };
  A['src-wiz-policy'] = el => { if (POLICY[el.dataset.value]) { ui('srcWiz').publish = el.dataset.value; refreshLayer(); } };
  function kbNameErr(v) { const n = (v || '').trim(); if (!n) return 'Name the new knowledge base.'; if (D.kbs.some(k => !k.archived && k.name.toLowerCase() === n.toLowerCase())) return 'A knowledge base with this name already exists.'; return ''; }
  A['src-wiz-kbinput'] = () => { const w = ui('srcWiz'); if (!w.err.kbName) return; const e = kbNameErr(w.kbName); if (e !== w.err.kbName) { w.err.kbName = e; refreshLayer(); } };
  A['src-wiz-reacc'] = async el => {
    const w = ui('srcWiz'); if (w.busy) return; const acc = accById(el.dataset.id); if (!acc) return;
    const t = w.t = uid('o'); w.rcAcc = acc.id; w.busy = true; w.oauthErr = ''; refreshLayer();
    await sleep(1600);
    if (S.ui.srcWiz !== w || w.t !== t || S.modal?.name !== 'src-wizard') return;
    w.rcAcc = ''; w.busy = false;
    if (S.pageState === 'error') { w.oauthErr = 'Google didn’t confirm the sign-in. Try again, or use a different account.'; refreshLayer(); return; }
    const fixed = X.acc.reconnect(acc); w.acc = acc.id;
    toast(X.acc.reconnectMsg(acc, fixed)); refresh();
  };
  async function wizGoogle(w) {
    const t = w.t = uid('o'); w.oauth = 'waiting'; w.oauthErr = ''; w.busy = true; refreshLayer();
    const acc = await X.acc.googleSignIn(() => S.ui.srcWiz === w && w.t === t && S.modal?.name === 'src-wizard');
    if (S.ui.srcWiz !== w || w.t !== t || S.modal?.name !== 'src-wizard') return;
    w.busy = false; w.oauth = '';
    if (!acc) { w.oauthErr = 'Google didn’t confirm the sign-in. Try again, or use a different account.'; refreshLayer(); return; }
    w.acc = acc.id; toast(`Connected ${acc.label}`); wizGo(w, 3);
  }
  async function wizConfluence(w) {
    w.cerr = X.acc.confErrors(w.conf); const bad = Object.keys(w.cerr);
    if (bad.length) { refreshLayer(); $('#acc-c-' + bad[0])?.focus(); return; }
    w.busy = true; refreshLayer();
    const res = await X.acc.confVerify(w.conf);
    if (S.ui.srcWiz !== w || S.modal?.name !== 'src-wizard') return;
    w.busy = false;
    if (res.err) { w.cerr = { token: res.err }; refreshLayer(); $('#acc-c-token')?.focus(); return; }
    w.conf = { site: '', email: '', token: '' };
    w.acc = res.acc.id; toast(`Connected ${res.acc.label}`); wizGo(w, 3);
  }
  async function wizSaveScope(w) {
    const s = srcById(w.srcId); if (!s) { closeModal(); return; }
    const idx = treeIdx(w.app); const paths = selItems(w.app, w.sel).map(n => idx.path[n.id]);
    w.busy = true; refreshLayer(); await sleep(700); if (S.ui.srcWiz !== w) return;
    closeModal(); S.ui.srcWiz = null; s.scope = paths; audit('Changed synced content', s.name);
    if (startSync(s)) toast('Content updated. Syncing changes…', { tone: 'accent' }); else toast('Content updated');
    refresh();
  }
  async function wizSubmit(w) {
    w.err = {}; if (!w.kb) w.err.kb = 'Choose where documents go.';
    if (w.kb === '__new') { const e = kbNameErr(w.kbName); if (e) w.err.kbName = e; }
    if (Object.keys(w.err).length) { refreshLayer(); $(w.err.kb ? '#src-w-kb' : '#src-w-kbname')?.focus(); return; }
    w.busy = true; refreshLayer(); await sleep(900);
    if (S.ui.srcWiz !== w || S.modal?.name !== 'src-wizard') return;
    let kbId = w.kb;
    if (kbId === '__new') {
      const k = { id: uid('kb'), name: w.kbName.trim(), desc: '', color: KB_COLORS[D.kbs.length % KB_COLORS.length], memberRole: null, general: 'restricted', shares: [{ kind: 'user', id: me().id, role: 'owner' }], updated: Date.now() };
      D.kbs.push(k); kbId = k.id;
      D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action: 'Created knowledge base', type: 'Knowledge', target: k.name, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
    }
    const idx = treeIdx(w.app), items = selItems(w.app, w.sel), docs = items.reduce((a, n) => a + nodeDocs(n), 0);
    const schedule = { freq: w.freq, day: w.day, time: w.time, tz: w.tz, on: w.freq !== 'manual' };
    const src = { id: uid('src'), name: wizName(w, items), app: w.app, account: w.acc, kb: kbId, status: 'healthy', scope: items.map(n => idx.path[n.id]), schedule, publish: w.publish === 'auto' ? 'auto' : 'review', last: null, next: nextAt(schedule), created: Date.now(), owner: me().name };
    D.sources.unshift(src); audit('Connected a source', src.name);
    closeModal(); S.ui.srcWiz = null;
    ENG.newId = src.id; Object.assign(ui('srcList', {}), { q: '', status: '' });
    startSync(src, { plan: { added: Math.min(docs, 30), updated: 0, failed: 0 }, ticks: 9 });
    setTimeout(() => { if (ENG.newId === src.id) ENG.newId = null; }, 4000);
    const view = () => S.cur?.r.page === 'sources' ? A['src-open']({ dataset: { id: src.id } }) : go('/sources');
    toast('Connected. First sync started.', { action: { label: 'View', run: view } });
    if (S.cur?.r.page === 'sources' && S.cur.query.tab === 'history') setQuery({ tab: 'sources' }); else refresh();
  }
  A['src-wiz-next'] = () => {
    const w = S.ui.srcWiz; if (!w || w.busy || w.ask) return;
    if (w.step === 1) { if (w.app) wizGo(w, 2); return; }
    if (w.step === 2) {
      if (w.acc === 'new') return w.app === 'gdrive' ? wizGoogle(w) : wizConfluence(w);
      const a = accById(w.acc); if (!a || a.status !== 'connected') return;
      return wizGo(w, 3);
    }
    if (w.step === 3) {
      if (!selItems(w.app, w.sel).length) { w.selErr = w.app === 'gdrive' ? 'Choose at least one folder.' : 'Choose at least one space or page.'; refreshLayer(); return; }
      return w.mode === 'scope' ? wizSaveScope(w) : wizGo(w, 4);
    }
    return wizSubmit(w);
  };
  /* Esc, the close button and the scrim ask before discarding wizard work. */
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || S.menu || S.palette || S.modal?.name !== 'src-wizard') return;
    e.preventDefault(); e.stopImmediatePropagation(); A['src-wiz-close']();
  }, true);
  window.addEventListener('click', e => {
    if (S.modal?.name !== 'src-wizard' || S.menu) return;
    if (e.target.closest?.('.modal__close [data-act="close-modal"]') || e.target.classList?.contains('modal__container')) { e.preventDefault(); e.stopImmediatePropagation(); A['src-wiz-close'](); }
  }, true);
})();

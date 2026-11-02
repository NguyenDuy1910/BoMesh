/* Platform console → Indexing (/p/indexing): operational oversight of document processing across
   workspaces — queues, failure rates, error classes, recent jobs and deployment-wide policies.
   Platform admins see job metadata only (job id, workspace, file type, size, stage, error class,
   duration). No document names or content appear anywhere on this page.
   Data: D.pIndex (global) = { ws: { [wsId]: { status, queue, pub24, fail, median, paused?, pausedAt?, pausedBy? } },
   jobs: [{ id, ws, type, size, stage, status, error, dur, at, retries? }], policy }.
   Exports: X.pIndexAlerts() (degraded + paused workspaces). Actions: pix-*. Menu: pix-ws. Drawer: pix-ws. */
(() => {
  'use strict';

  const PREVIEW = chip('Preview', { tone: 'default', variant: 'outline', size: 'sm' });
  const STAGES = { parse: 'Parse', ocr: 'OCR', chunk: 'Chunk', index: 'Index' };
  /** Error classes, in the order operators triage them. retry: a retry can succeed without the workspace doing anything. */
  const ERR = {
    password: { label: 'Password-protected', icon: 'lock', retry: false, hint: 'The workspace has to upload a copy without a password.' },
    notext: { label: 'No readable text', icon: 'eye-off', retry: 'ocr', hint: 'Scanned pages. A retry reads them when OCR is on.' },
    unsupported: { label: 'Unsupported type', icon: 'ban', retry: false, hint: 'The file type isn’t on the allowed list. It’s stored, not searchable.' },
    toolarge: { label: 'Too large', icon: 'maximize', retry: false, hint: 'Above the maximum file size in Policies.' },
    timeout: { label: 'Timed out', icon: 'clock', retry: true, hint: 'Usually clears on retry.' },
  };
  const JOB = { queued: ['default', 'Queued'], running: ['accent', 'Running'], held: ['default', 'On hold'], done: ['success', 'Done'], failed: ['danger', 'Failed'] };
  const WS_ST = { healthy: ['success', 'Healthy', 'tertiary'], degraded: ['warning', 'Degraded', 'soft'], paused: ['default', 'Paused', 'soft'] };
  const TYPES = [['pdf', 'PDF'], ['word', 'Word (DOC, DOCX)'], ['slides', 'PowerPoint (PPT, PPTX)'], ['sheets', 'Excel and CSV'], ['text', 'Text and Markdown'], ['html', 'Web pages (HTML)'], ['images', 'Images (PNG, JPG)'], ['zip', 'ZIP archives']];
  const RETENTION = [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['180', '180 days'], ['365', '1 year']];
  const MAX_MB = 2048;

  /* ═══════════════ Seed (deterministic; no titles anywhere) ═══════════════ */
  const PROFILE = {
    'ws-woodgrove': { status: 'degraded', queue: 1240, pub24: 3120, fail: 0.064, median: 9.2 * MIN, errs: ['timeout', 'timeout', 'timeout', 'toolarge', 'password'] },
    'ws-fabrikam': { status: 'degraded', queue: 310, pub24: 860, fail: 0.081, median: 4.1 * MIN, errs: ['notext', 'notext', 'notext', 'unsupported', 'toolarge'] },
    'ws-adatum': { status: 'healthy', paused: true, pausedAt: ago(18 * DAY), pausedBy: 'Alex Rivera', queue: 42, pub24: 0, fail: 0.012, median: 2.2 * MIN, errs: [] },
    'ws-litware': { status: 'healthy', queue: 0, pub24: 0, fail: 0, median: 0, errs: [] },
    'ws-finx': { status: 'healthy', queue: 6, pub24: 41, fail: 0.031, median: 2.6 * MIN, errs: ['password', 'notext'] },
    'ws-northwind': { status: 'healthy', queue: 3, pub24: 58, fail: 0.009, median: 1.4 * MIN, errs: ['password'] },
  };
  const FILE_TYPES = ['pdf', 'pdf', 'pdf', 'docx', 'docx', 'pptx', 'xlsx', 'html', 'md', 'csv'];
  const ERR_TYPE = { password: 'xlsx', notext: 'pdf', unsupported: 'zip', toolarge: 'pdf', timeout: 'pdf' };
  const ERR_STAGE = { password: 'parse', notext: 'ocr', unsupported: 'parse', toolarge: 'parse', timeout: 'chunk' };
  function wsSeed(w) {
    const h = hashOf(w.id), p = PROFILE[w.id];
    if (p) return { ...p, errs: undefined };
    return { status: 'healthy', queue: 2 + (h % 28), pub24: Math.round((w.docs || 0) * 0.02) + (h % 9), fail: (4 + (h % 20)) / 1000, median: (60 + (h % 150)) * 1000 };
  }
  function seedIndex() {
    const ws = {}, jobs = []; let n = 48213;
    D.pWorkspaces.forEach((w, wi) => {
      const h = hashOf(w.id), st = ws[w.id] = wsSeed(w);
      const errs = PROFILE[w.id]?.errs ?? (h % 3 ? ['password'] : ['notext']);
      const job = (o, i) => {
        const type = o.type || FILE_TYPES[(h + i * 7) % FILE_TYPES.length];
        jobs.push({ id: 'job-' + (n -= 1 + ((h + i) % 5)), ws: w.id, type, size: Math.round(40e3 + ((h * (i + 3)) % 9000) * 640), stage: 'index', status: 'done', error: null, dur: (20 + ((h + i * 13) % 200)) * 1000, at: ago((wi * 37 + i * 53 + (h % 40)) * MIN), ...o });
      };
      if (w.status === 'new' && !w.docs) { job({ type: 'pdf', at: ago(40 * HOUR) }, 0); return; }
      errs.forEach((e, i) => job({ status: 'failed', error: e, type: ERR_TYPE[e], stage: ERR_STAGE[e], ...(e === 'toolarge' ? { size: 412e6 + i * 3e6 } : {}), dur: e === 'timeout' ? 15 * MIN : (4 + i) * 1000 }, i));
      for (let i = 0; i < 3 + (h % 4); i++) job({}, i + 10);
      if (st.queue) {
        job({ status: 'running', stage: ['parse', 'ocr', 'chunk', 'index'][h % 4], dur: null, at: ago((2 + (h % 6)) * MIN) }, 30);
        job({ status: 'queued', stage: 'parse', dur: null, at: ago((1 + (h % 3)) * MIN) }, 31);
      }
    });
    return {
      ws, jobs: jobs.sort((a, b) => b.at - a.at),
      policy: { types: ['pdf', 'word', 'slides', 'sheets', 'text', 'html'], maxMb: 200, ocr: true, sheets: true, review: true, retention: '30' },
      updated: { by: 'Alex Rivera', at: ago(26 * DAY) },
    };
  }
  D.pIndex ??= seedIndex();
  DATA_KEYS.push('pIndex');

  /* ═══════════════ Model ═══════════════ */
  const wsById = id => D.pWorkspaces.find(w => w.id === id);
  /** Stats for a workspace (created on first sight, e.g. a workspace created in this session). */
  const statOf = w => (D.pIndex.ws[w.id] ??= wsSeed(w));
  const wsStatus = w => { const s = statOf(w); return s.paused ? 'paused' : s.status === 'degraded' ? 'degraded' : 'healthy'; };
  const isPaused = id => !!D.pIndex.ws[id]?.paused;
  const jobStatus = j => (['queued', 'running'].includes(j.status) && isPaused(j.ws) ? 'held' : j.status);
  const failedJobs = (wsId = '') => D.pIndex.jobs.filter(j => j.status === 'failed' && (!wsId || j.ws === wsId));
  const canRetry = j => j.status === 'failed' && (ERR[j.error]?.retry === true || (ERR[j.error]?.retry === 'ocr' && D.pIndex.policy.ocr));
  const errCounts = jobs => Object.keys(ERR).map(k => ({ k, n: jobs.filter(j => j.error === k).length })).filter(x => x.n);
  const byRecent = jobs => [...jobs].sort((a, b) => b.at - a.at);
  X.pIndexAlerts = () => (D.pIndex ? D.pWorkspaces.filter(w => wsStatus(w) !== 'healthy').length : 0);

  function log(action, target, ws = null) {
    (D.pAudit ??= []).unshift({ id: uid('pev'), at: Date.now(), ws, actor: me().name, action, area: 'Indexing', target, outcome: 'success', ip: '10.4.0.12', device: 'Chrome on macOS' });
  }
  function repaint() {
    persist();
    if (S.cur?.r.page === 'pIndexing') refresh();
    else if (S.drawer?.name === 'pix-ws') refreshLayer();
  }
  const fmtPct = f => (f ? (f * 100).toFixed(f < 0.1 ? 1 : 0) + '%' : '0%');
  const wsCell = w => (w ? `<span class="row gap-8 pix-min">${wsMark(w, 20)}<span class="truncate">${esc(w.name)}</span></span>` : '<span class="muted">Removed workspace</span>');
  const wsChip = w => { const st = wsStatus(w), [tone, label, variant] = WS_ST[st]; return chip(label, { tone, variant, dot: st !== 'paused', icon: st === 'paused' ? 'pause' : '', size: 'sm' }); };
  const jobChip = j => {
    const st = jobStatus(j), [tone, label] = JOB[st];
    if (st === 'failed') return chip(ERR[j.error]?.label || 'Failed', { tone: 'danger', size: 'sm', icon: ERR[j.error]?.icon, tip: ERR[j.error]?.hint });
    return chip(label, { tone, size: 'sm', variant: st === 'done' ? 'tertiary' : 'soft', dot: st !== 'held', live: st === 'running', tip: st === 'held' ? 'Indexing is paused for this workspace' : '' });
  };

  /* ═══════════════ Page ═══════════════ */
  /** One sentence: what needs attention right now. */
  function summary() {
    const all = D.pWorkspaces, attention = all.filter(w => wsStatus(w) !== 'healthy').length;
    const queued = all.reduce((a, w) => a + (statOf(w).queue || 0), 0), failed = failedJobs().length;
    return esc(`${attention ? `${plural(attention, 'workspace')} need${attention === 1 ? 's' : ''} attention` : 'Every workspace is healthy'} · ${plural(queued, 'job')} queued · ${plural(failed, 'failed job')} in the last 24 hours.`);
  }
  P.pIndexing = () => {
    const live = S.pageState === 'live' && !S.navLoading;
    const ok = () => {
      const banner = alertBox('default', '', 'You see job metadata only. Document names and content stay inside each workspace.', '', { icon: 'lock' });
      return `<div class="pix"><div class="pix-banner">${banner}</div>${wsSection()}${errSection()}${jobsSection()}${policySection()}</div>`;
    };
    return `<div class="page">${pageHeader({ title: 'Indexing', extra: PREVIEW, desc: live ? summary() : 'How documents are processed across workspaces.' })}
      ${gate({
        ok,
        loading: () => skelRows(8),
        error: () => errorState({ title: 'Indexing status didn’t load' }),
        empty: () => emptyState({ icon: 'database', title: 'No indexing jobs yet', desc: 'Jobs appear once workspaces add documents.', boxed: true }),
      })}</div>`;
  };

  /* ── Workspaces ── */
  function wsSection() {
    const rows = [...D.pWorkspaces].sort((a, b) => ['paused', 'degraded', 'healthy'].indexOf(wsStatus(a)) - ['paused', 'degraded', 'healthy'].indexOf(wsStatus(b)) || (statOf(b).queue || 0) - (statOf(a).queue || 0));
    const head = th('Workspace') + th('Status') + th('Queue', 'table__column--num') + th('Published, 24 h', 'table__column--num hide-sm') + th('Failure rate', 'table__column--num') + th('Median time', 'table__column--num hide-md') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    return section('Workspaces', table({ label: 'Indexing by workspace', head, rows: rows.map(wsRow) }));
  }
  function wsRow(w) {
    const s = statOf(w), paused = !!s.paused, high = s.fail >= 0.05;
    const act = paused ? btn('Resume', { size: 'sm', icon: 'play', act: 'pix-pause', data: { id: w.id } }) : btn('Pause', { size: 'sm', v: 'ghost', icon: 'pause', act: 'pix-pause', data: { id: w.id } });
    return `<tr class="table__row" data-act="pix-ws-open" data-id="${esc(w.id)}" tabindex="0">
      <td class="table__cell table__cell--primary">${wsCell(w)}</td>
      <td class="table__cell">${wsChip(w)}</td>
      <td class="table__cell table__cell--num num" data-label="Queue">${fmtNum(s.queue || 0)}</td>
      <td class="table__cell table__cell--num table__cell--hide-sm num hide-sm">${fmtNum(s.pub24 || 0)}</td>
      <td class="table__cell table__cell--num num ${high ? 'text-warning medium' : ''}" data-label="Failure rate">${fmtPct(s.fail)}</td>
      <td class="table__cell table__cell--num table__cell--hide-sm num hide-md">${s.median ? esc(fmtDuration(s.median)) : '—'}</td>
      <td class="table__cell table__cell--actions"><div class="row gap-4 none">${act}${iconBtn('more', 'More actions', { size: 'sm', menu: 'pix-ws', data: { id: w.id } })}</div></td></tr>`;
  }
  MENUS['pix-ws'] = el => {
    const w = wsById(el.dataset.id); if (!w) return [];
    const paused = isPaused(w.id), n = failedJobs(w.id).filter(canRetry).length;
    return [
      { label: 'View errors', icon: 'alert-circle', run: () => openDrawer('pix-ws', { id: w.id }) },
      { label: n ? `Retry ${plural(n, 'failed job')}` : 'Retry failed jobs', icon: 'retry', disabled: !n, run: () => retryJobs(failedJobs(w.id), w.name, w.id) },
      { label: 'Show jobs', icon: 'list', run: () => showJobs({ ws: w.id }) },
      { sep: true },
      { label: paused ? 'Resume indexing' : 'Pause indexing', icon: paused ? 'play' : 'pause', run: () => A['pix-pause']({ dataset: { id: w.id } }) },
    ];
  };
  A['pix-ws-open'] = el => { if (wsById(el.dataset.id)) openDrawer('pix-ws', { id: el.dataset.id }); };
  A['pix-pause'] = el => {
    const w = wsById(el.dataset.id); if (!w) return;
    const s = statOf(w);
    if (s.paused) {
      const held = D.pIndex.jobs.filter(j => j.ws === w.id && ['queued', 'running'].includes(j.status)).length;
      confirmAction({ title: `Resume indexing for ${w.name}?`, body: `${plural(s.queue || held, 'queued job')} start${(s.queue || held) === 1 ? 's' : ''} right away.`, confirm: 'Resume indexing', onConfirm: () => {
        const before = { pausedAt: s.pausedAt, pausedBy: s.pausedBy };
        delete s.paused; delete s.pausedAt; delete s.pausedBy; log('Resumed indexing', w.name, w.id);
        settleRetries(w.id); repaint();
        toast(`Resumed indexing for ${w.name}`, { action: { label: 'Undo', run: () => { Object.assign(s, { paused: true, ...before }); log('Paused indexing', w.name, w.id); repaint(); } } });
      } });
      return;
    }
    confirmAction({ title: `Pause indexing for ${w.name}?`, body: 'New and changed files wait in the queue until you resume. Published documents stay searchable.', confirm: 'Pause indexing', danger: true, onConfirm: () => {
      Object.assign(s, { paused: true, pausedAt: Date.now(), pausedBy: me().name }); log('Paused indexing', w.name, w.id); repaint();
      toast(`Paused indexing for ${w.name}`, { action: { label: 'Undo', run: () => { delete s.paused; delete s.pausedAt; delete s.pausedBy; log('Resumed indexing', w.name, w.id); repaint(); } } });
    } });
  };

  /* ── Retry ── */
  const retryTimers = {};
  /** Retried jobs finish a few seconds later unless their workspace is paused (they wait until it resumes). */
  function finishRetried(jobs) {
    jobs.forEach(j => {
      if (j.status !== 'queued' || !j.retries || isPaused(j.ws)) return;
      Object.assign(j, { status: 'done', error: null, stage: 'index', dur: (25 + (hashOf(j.id) % 90)) * 1000, at: Date.now() });
    });
  }
  function settleRetries(wsId) {
    const jobs = D.pIndex.jobs.filter(j => j.ws === wsId && j.status === 'queued' && j.retries);
    if (jobs.length) setTimeout(() => { finishRetried(jobs); repaint(); }, 2600);
  }
  /** Retry what can succeed; say what can't. scope: label for the toast and audit; wsId when it's one workspace. */
  function retryJobs(jobs, scope, wsId = null) {
    const ok = jobs.filter(canRetry), skipped = jobs.filter(j => j.status === 'failed' && !canRetry(j)).length;
    if (!ok.length) { toast(skipped ? `None of these can be retried. ${plural(skipped, 'job')} need${skipped === 1 ? 's' : ''} the workspace to replace the file.` : 'No failed jobs to retry', { tone: 'accent' }); return; }
    const snap = ok.map(j => [j, { ...j }]), key = uid('rt');
    ok.forEach(j => Object.assign(j, { status: 'queued', retries: (j.retries || 0) + 1, at: Date.now(), dur: null }));
    log(`Retried ${plural(ok.length, 'failed job')}`, scope, wsId);
    retryTimers[key] = setTimeout(() => { delete retryTimers[key]; finishRetried(ok); repaint(); }, 3200);
    repaint();
    const held = wsId && isPaused(wsId) ? ' · they run when indexing resumes' : '';
    toast(`Retrying ${plural(ok.length, 'job')}${held}${skipped ? ` · ${skipped} can’t be retried` : ''}`, { action: { label: 'Undo', run: () => {
      clearTimeout(retryTimers[key]); delete retryTimers[key];
      snap.forEach(([j, s]) => { Object.keys(j).forEach(k => delete j[k]); Object.assign(j, s); });
      log('Cancelled a retry', scope, wsId); repaint();
    } } });
  }
  A['pix-retry-ws'] = el => { const w = wsById(el.dataset.id); if (w) retryJobs(failedJobs(w.id), w.name, w.id); };
  A['pix-retry-class'] = el => { const e = ERR[el.dataset.err]; if (e) retryJobs(failedJobs().filter(j => j.error === el.dataset.err), e.label); };

  /* ── Errors by class ── */
  function errSection() {
    const counts = errCounts(failedJobs());
    const body = counts.length ? list(counts.map(({ k, n }) => {
      const e = ERR[k], wsN = new Set(failedJobs().filter(j => j.error === k).map(j => j.ws)).size;
      const retry = e.retry === true || (e.retry === 'ocr' && D.pIndex.policy.ocr)
        ? btn('Retry', { size: 'sm', icon: 'retry', act: 'pix-retry-class', data: { err: k } })
        : e.retry === 'ocr' ? `<span class="t-xs muted pix-nowrap">Turn on OCR to retry</span>` : '';
      return item({
        lead: itemIcon(e.icon, k === 'timeout' ? 'warning' : 'danger', 'sm'),
        title: `${esc(e.label)} <span class="num muted">· ${fmtNum(n)}</span>`,
        desc: `${esc(e.hint)} <span class="muted">${esc(`In ${plural(wsN, 'workspace')}.`)}</span>`,
        trail: `<span class="row gap-8 none">${retry}${btn('Show jobs', { v: 'ghost', size: 'sm', act: 'pix-show-err', data: { err: k } })}</span>`,
      });
    }), 'pix-errs') : emptyState({ icon: 'check-circle', tone: 'success', title: 'No failed jobs in the last 24 hours', compact: true, boxed: true });
    return section('Errors', body, { desc: 'Failed jobs in the last 24 hours, by cause.' });
  }
  A['pix-show-err'] = el => showJobs({ err: el.dataset.err, status: 'failed' });
  function showJobs(f) {
    Object.assign(ui('pixJobs', {}), { ws: '', status: '', err: '', q: '', page: 1 }, f);
    S.drawer = null;
    if (S.cur?.r.page !== 'pIndexing') { goThen('/p/indexing', () => $('#pix-jobs')?.scrollIntoView({ block: 'start' })); return; }
    refresh(); requestAnimationFrame(() => $('#pix-jobs')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }

  /* ── Recent jobs ── */
  function jobsSection() {
    const u = ui('pixJobs', { ws: '', status: '', err: '' });
    const wsOpts = D.pWorkspaces.filter(w => D.pIndex.jobs.some(j => j.ws === w.id)).map(w => [w.id, w.name]);
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'pixJobs', placeholder: 'Search job ID' })}${filterButton('Workspace', 'pixJobs', 'ws', wsOpts)}${filterButton('Status', 'pixJobs', 'status', Object.entries(JOB).map(([k, v]) => [k, v[1]]))}${filterButton('Error', 'pixJobs', 'err', Object.entries(ERR).map(([k, v]) => [k, v.label]))}${clearFilters('pixJobs', ['ws', 'status', 'err'])}</div>`;
    const rows = byRecent(D.pIndex.jobs.filter(j => (!u.ws || j.ws === u.ws) && (!u.status || jobStatus(j) === u.status) && (!u.err || j.error === u.err) && matchesQ('pixJobs', j.id, j.type)));
    const body = rows.length ? table({
      label: 'Recent jobs',
      head: th('Job') + th('Workspace') + th('File', 'hide-sm') + th('Stage', 'hide-md') + th('Status') + th('Duration', 'table__column--num hide-md') + th('When', 'table__column--num'),
      rows: paginate(rows, 'pixJobs', 12).map(jobRow),
      foot: pager(rows.length, 'pixJobs', 12),
    }) : noMatches('pixJobs', ['ws', 'status', 'err'], 'jobs');
    return section('Recent jobs', toolbar + body, { id: 'pix-jobs', desc: 'File type and size only. Names and content stay in the workspace.' });
  }
  function jobRow(j) {
    const st = jobStatus(j);
    const dur = st === 'running' ? `<span class="muted">${esc(fmtDuration(Date.now() - j.at))}</span>` : j.dur ? esc(fmtDuration(j.dur)) : '<span class="muted">—</span>';
    return `<tr class="table__row" data-act="pix-ws-open" data-id="${esc(j.ws)}" tabindex="0">
      <td class="table__cell table__cell--primary"><span class="mono pix-job">${esc(j.id)}</span>${j.retries ? `<span class="cell-sub">${esc(`Retry ${j.retries}`)}</span>` : ''}</td>
      <td class="table__cell">${wsCell(wsById(j.ws))}</td>
      <td class="table__cell table__cell--hide-sm hide-sm"><span class="row gap-8">${fileIcon(j.type, 'sm')}<span class="num muted pix-nowrap">${esc(fmtSize(j.size))}</span></span></td>
      <td class="table__cell table__cell--hide-sm hide-md">${esc(STAGES[j.stage] || '—')}</td>
      <td class="table__cell">${jobChip(j)}</td>
      <td class="table__cell table__cell--num table__cell--hide-sm num hide-md pix-nowrap">${dur}</td>
      <td class="table__cell table__cell--num muted num pix-nowrap" data-tip="${esc(fmtDateTime(j.at))}">${esc(rel(j.at))}</td></tr>`;
  }

  /* ── Workspace drawer ── */
  DR['pix-ws'] = ({ id }) => {
    const w = wsById(id);
    if (!w) return { title: 'Workspace not found', body: emptyState({ icon: 'building', title: 'This workspace no longer exists', compact: true }), foot: btn('Close', { act: 'close-drawer' }) };
    const s = statOf(w), fails = failedJobs(w.id), counts = errCounts(fails), n = fails.filter(canRetry).length;
    const recent = byRecent(D.pIndex.jobs.filter(j => j.ws === w.id)).slice(0, 6);
    const pausedNote = s.paused ? alertBox('default', 'Indexing is paused', esc(`Since ${fmtDate(s.pausedAt || Date.now())}${s.pausedBy ? ` · by ${s.pausedBy}` : ''}. New and changed files wait in the queue.`), '', { icon: 'pause' }) : '';
    const errs = counts.length ? list(counts.map(({ k, n: c }) => item({
      lead: itemIcon(ERR[k].icon, k === 'timeout' ? 'warning' : 'danger', 'sm'), title: esc(ERR[k].label), desc: esc(ERR[k].hint),
      trail: `<span class="num medium">${fmtNum(c)}</span>`,
    }))) : '<p class="t-sm muted">No failed jobs in the last 24 hours.</p>';
    const jobs = recent.length ? list(recent.map(j => item({ lead: fileIcon(j.type, 'sm'), title: `<span class="mono">${esc(j.id)}</span>`, desc: esc(`${fmtSize(j.size)} · ${STAGES[j.stage] || '—'} · ${rel(j.at)}`), trail: jobChip(j) }))) : '<p class="t-sm muted">No jobs yet.</p>';
    return {
      lead: wsMark(w, 36), title: w.name, desc: esc('Job metadata only'),
      body: `<section class="drawer__section">${pausedNote ? `<div class="mb-16">${pausedNote}</div>` : ''}${kv([
        ['Status', wsChip(w)],
        ['Queue', `<span class="num">${plural(s.queue || 0, 'job')}</span>`],
        ['Published, 24 h', `<span class="num">${fmtNum(s.pub24 || 0)}</span>`],
        ['Failure rate', `<span class="num ${s.fail >= 0.05 ? 'text-warning medium' : ''}">${fmtPct(s.fail)}</span>`],
        ['Median time', s.median ? esc(fmtDuration(s.median)) : '—'],
      ])}</section>
        <section class="drawer__section"><h3 class="drawer__section-title">Errors, last 24 hours</h3>${errs}</section>
        <section class="drawer__section"><div class="row between gap-8"><h3 class="drawer__section-title">Recent jobs</h3>${btn('Show all', { v: 'ghost', size: 'sm', act: 'pix-show-ws', data: { id: w.id } })}</div>${jobs}</section>`,
      foot: btn(s.paused ? 'Resume indexing' : 'Pause indexing', { icon: s.paused ? 'play' : 'pause', act: 'pix-pause', data: { id: w.id } })
        + btn(n ? `Retry ${plural(n, 'failed job')}` : 'Retry failed jobs', { v: 'primary', icon: 'retry', act: 'pix-retry-ws', data: { id: w.id }, disabled: !n, tip: n ? '' : fails.length ? 'These need the workspace to replace the file' : '' }),
    };
  };
  A['pix-show-ws'] = el => showJobs({ ws: el.dataset.id });

  /* ── Policies ── */
  const polForm = () => ui('pixPol', { ...clone(D.pIndex.policy), maxMb: String(D.pIndex.policy.maxMb), tried: false, busy: false });
  const polValues = f => ({ types: TYPES.map(t => t[0]).filter(t => f.types.includes(t)), maxMb: +f.maxMb, ocr: !!f.ocr, sheets: !!f.sheets, review: true, retention: String(f.retention) });
  const polDirty = f => JSON.stringify(polValues(f)) !== JSON.stringify(polValues({ ...D.pIndex.policy, maxMb: String(D.pIndex.policy.maxMb) }));
  function polErrors(f) {
    const e = {}, mb = Number(f.maxMb);
    if (!f.types.length) e.types = 'Allow at least one file type.';
    if (!String(f.maxMb).trim() || !Number.isInteger(mb) || mb < 1 || mb > MAX_MB) e.maxMb = `Enter a whole number from 1 to ${fmtNum(MAX_MB)}.`;
    return e;
  }
  function policySection() {
    const f = polForm(), e = f.tried ? polErrors(f) : {};
    const types = `<div class="pix-types" role="group" aria-label="Allowed file types">${TYPES.map(([k, l]) => checkbox({ label: esc(l), checked: f.types.includes(k), act: 'pix-pol-type', data: { t: k } })).join('')}</div>${e.types ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(e.types)}</span></div>` : ''}`;
    const size = field({ id: 'pix-maxmb', label: 'Maximum file size', error: e.maxMb, desc: 'Larger files fail with “Too large”.', control: `<div class="pix-size">${input({ id: 'pix-maxmb', bind: 'pixPol.maxMb', value: f.maxMb, type: 'number', invalid: !!e.maxMb, attrs: `min="1" max="${MAX_MB}" step="1" inputmode="numeric" data-input="pix-pol-input"` })}<span class="t-sm muted">MB</span></div>` });
    const ret = field({ id: 'pix-ret', label: 'Delete declined submissions after', desc: 'Applies to every workspace. Approved documents are never deleted by this.', control: select({ id: 'pix-ret', bind: 'pixPol.retention', value: f.retention, options: RETENTION, change: 'pix-pol-input' }) });
    const settings = list(D.pModels.map(m => item({ lead: itemIcon('settings', '', 'sm'), title: `<code class="mono">${esc(m.setting)}</code>`, desc: esc(m.name) })), 'pix-settings');
    const body = formSection('File types', 'Other types are stored but not searchable.', types)
      + formSection('Size', '', size)
      + formSection('Reading', '', switchRow({ title: 'Read scanned PDFs (OCR)', desc: 'Slower. Needed for scans and photos of pages.', on: f.ocr, act: 'pix-pol-switch', data: { k: 'ocr' } })
        + switchRow({ title: 'Parse spreadsheets', desc: 'Reads sheets and rows so answers can cite cells. Off: spreadsheets are stored as files only.', on: f.sheets, act: 'pix-pol-switch', data: { k: 'sheets' } }))
      + formSection('Review', '', switchRow({ title: 'Uploads need review before publishing', desc: 'Always on. Uploads become searchable only after a reviewer in the workspace approves them; workspaces choose this per source for synced files.', on: true, disabled: true }))
      + formSection('Retention', '', ret)
      + formSection('Deployment settings', 'Read-only. Changed in the deployment configuration and applied on restart.', settings);
    const bar = polDirty(f) ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes${f.tried && Object.keys(e).length ? ` · ${plural(Object.keys(e).length, 'field')} to fix` : ''}</span>${btn('Discard', { v: 'ghost', act: 'pix-pol-discard', disabled: f.busy })}${btn('Save changes', { v: 'primary', act: 'pix-pol-save', loading: f.busy, disabled: f.busy })}</div>` : '';
    const changed = D.pIndex.updated ? `<span class="t-xs muted">${esc(`Last changed by ${D.pIndex.updated.by} · ${fmtDate(D.pIndex.updated.at)}`)}</span>` : '';
    return section('Policies', card(body, { cls: 'card--lg pix-policy' }) + bar, { desc: 'Apply to every workspace on this deployment.', actions: changed, id: 'pix-policies' });
  }
  A['pix-pol-type'] = (el, e) => { e?.stopPropagation(); const f = polForm(), t = el.dataset.t; f.types = f.types.includes(t) ? f.types.filter(x => x !== t) : [...f.types, t]; refresh(); };
  A['pix-pol-switch'] = el => { const f = polForm(), k = el.dataset.k; if (k !== 'ocr' && k !== 'sheets') return; f[k] = !f[k]; refresh(); };
  /** Repaint only when the save bar appears or disappears, so typing stays smooth. */
  A['pix-pol-input'] = () => { const f = polForm(); if (polDirty(f) !== !!$('#app .pix .savebar') || f.tried) refresh(); };
  A['pix-pol-discard'] = () => { S.ui.pixPol = null; refresh(); };
  A['pix-pol-save'] = async () => {
    const f = polForm(); if (f.busy) return;
    f.tried = true;
    const e = polErrors(f);
    if (Object.keys(e).length) { refresh(); $(e.types ? '.pix-types input' : '#pix-maxmb')?.focus(); return; }
    f.busy = true; refresh(); await sleep(600);
    if (S.ui.pixPol !== f) return;
    const before = clone(D.pIndex.policy), beforeBy = D.pIndex.updated;
    D.pIndex.policy = polValues(f); D.pIndex.updated = { by: me().name, at: Date.now() };
    log('Updated indexing policies', 'Indexing policies');
    S.ui.pixPol = null; repaint();
    toast('Indexing policies saved. New jobs use them right away.', { action: { label: 'Undo', run: () => { D.pIndex.policy = before; D.pIndex.updated = beforeBy; S.ui.pixPol = null; log('Reverted indexing policies', 'Indexing policies'); repaint(); } } });
  };
})();

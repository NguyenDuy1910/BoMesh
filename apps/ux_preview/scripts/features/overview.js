/* Overview (/overview) — the admin home. Answers "what needs me?" first (operations: sources, accounts, access,
   office queues), then Knowledge health (Documents' views and Classification's suggestions as compact metrics, each a
   link to its view), then how the workspace is doing this week and where knowledge falls short.
   Module-aware: with Requests on it also watches office queues and SLA. */
(() => {
  'use strict';

  const call = (name, data, fallback) => (A[name] ? A[name]({ dataset: data }) : fallback?.());
  const managedKbs = () => D.kbs.filter(k => !k.archived && !k.personal);
  /** "A, B and 2 others" in the interface language (Intl joins with "và" in Vietnamese). */
  const joinList = list => new Intl.ListFormat(uiLocale(), { type: 'conjunction' }).format(list);
  const names = list => joinList(list.length <= 2 ? list : [...list.slice(0, 2), plural(list.length - 2, 'other')]);
  const OPEN_SR = ['submitted', 'in_review'], DONE_SR = ['approved', 'declined', 'completed'];
  const svcType = id => (D.requestTypes || []).find(t => t.id === id);
  const officeIds = () => new Set((D.spaces || []).filter(s => s.type === 'office' && !s.archived).map(s => s.id));
  const docsTo = () => docsHref('all', { stage: 'live' });
  function audit(action, target, type = 'Knowledge') { D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type, target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' }); }

  /* ── Needs attention: derived from D, so an item disappears once resolved ── */
  function requestAttention(items) {
    if (!hasModule('requests')) return;
    const offices = officeIds(), t = Date.now();
    const open = (D.svcRequests || []).filter(r => offices.has(r.space) && OPEN_SR.includes(r.status) && r.due);
    const late = open.filter(r => r.due < t), soon = open.filter(r => r.due >= t && r.due - t <= DAY);
    if (!late.length && !soon.length) return;
    const list = [...late, ...soon];
    const title = late.length ? `${plural(late.length, 'office request')} past the response time` : `${plural(soon.length, 'office request')} due within a day`;
    const extra = late.length && soon.length ? ` · ${soon.length} more due within a day` : '';
    items.push({ id: 'sla', tone: late.length ? 'danger' : 'warning', icon: 'clock', title, desc: esc(list.slice(0, 2).map(r => `${r.id} ${svcType(r.type)?.name || ''} · ${actorName(r.requester)}`).join(', ') + extra), actions: btn('Open queue', { v: 'secondary', size: 'sm', href: '/requests?tab=queue' }) });
  }
  /** Each item names a problem once and links to the one place its fix lives, with a verb for that fix.
      Knowledge work (submissions, publishing problems, quality checks) is counted once, in Knowledge health below. */
  function attention() {
    const items = [];
    requestAttention(items);
    // An expired account is one problem, however many sources it stops; Reconnect fixes it right here.
    const expired = new Map();
    attentionSources().forEach(s => {
      const acc = accById(s.account), app = APPS[s.app]?.name || 'The app';
      if (s.status === 'reconnect' || acc?.status === 'expired') { const k = s.account || s.id; if (!expired.has(k)) expired.set(k, { app, list: [] }); expired.get(k).list.push(s); return; }
      items.push({ id: 'src-' + s.id, tone: 'danger', icon: 'alert-circle', title: `${s.name} couldn’t sync`, desc: esc(s.last?.error || 'The last sync failed.'), actions: btn('Open source', { v: 'secondary', size: 'sm', act: 'ov-source', data: { id: s.id } }) });
    });
    expired.forEach(({ app, list }, k) => {
      const kbs = [...new Set(list.map(s => kbById(s.kb)?.name).filter(Boolean))];
      items.push({ id: 'acc-' + k, tone: 'danger', icon: 'plug', title: `${names(list.map(s => s.name))} stopped syncing`, desc: esc(`${app} access expired${kbs.length ? ` · ${names(kbs)} ${kbs.length === 1 ? 'isn’t' : 'aren’t'} getting updates` : ''}`), actions: btn('Reconnect', { v: 'secondary', size: 'sm', act: 'acc-reconnect', data: { id: k } }) });
    });
    const reqs = pendingRequests();
    if (reqs.length) {
      const r = reqs[0], one = reqs.length === 1, people = new Set(reqs.map(x => x.user)).size;
      const kbs = [...new Set(reqs.map(x => kbById(x.kb)?.name).filter(Boolean))];
      const title = one ? `${actorName(r.user)} asked for ${KB_ROLES[r.role === 'editor' ? 'editor' : 'viewer'].label} access` : `${plural(people, 'person', 'people')} waiting for access`;
      items.push({ id: 'req', tone: 'warning', icon: 'user-plus', title, desc: esc(one ? [kbById(r.kb)?.name, r.note && `“${r.note}”`].filter(Boolean).join(' · ') : `Asking for ${names(kbs)}`), actions: btn('Open access requests', { v: 'secondary', size: 'sm', href: '/people?tab=requests' }) });
    }
    // Setup left unfinished: one row naming what's missing and where to fix it (the full checklist is only for a new workspace).
    const next = X.setupNext?.();
    if (next) items.push({ id: 'setup', tone: 'accent', icon: next.icon || 'list', title: next.title, desc: esc(next.desc), actions: next.actions });
    // Most urgent first: broken (danger), then waiting on you (warning), then routine (accent, default).
    const rank = { danger: 0, warning: 1, accent: 2, default: 3 };
    return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }
  function attentionHtml() {
    const items = attention();
    if (!items.length) return emptyState({ icon: 'check-circle', tone: 'success', title: 'Everything is running', desc: hasModule('requests') ? 'Queues are on time, sources are syncing and no one is waiting for access.' : 'Sources are syncing and no one is waiting for access.', boxed: true, compact: true });
    return list(items.map(it => item({ lead: itemIcon(it.icon, it.tone), title: esc(it.title), desc: `<span class="ov-line">${it.desc}</span>`, trail: it.actions, lines: 2 })), 'ov-attn');
  }

  /* ── Knowledge health: one row of metrics, each opening its view in Knowledge Studio ── */
  /** [label, value, href, tone when non-zero, tip]. What keeps documents from people first (in the order work flows:
      Processing, then Review), then what keeps them right (All, filtered by quality). */
  function healthMetrics() {
    const c = X.reviewQueues?.() || {};
    if (!('review' in c)) return [];
    const ids = new Set(managedKbs().map(k => k.id));
    const pub = D.docs.filter(d => !d.archived && ids.has(d.kb) && stageOf(d) === 'published' && d.status === 'ready');
    const verified = pub.filter(d => trustOf(d).state === 'verified').length;
    const part = ['reverify', 'details', 'duplicates'].find(k => c.parts[k]) || 'reverify', sug = suggestionCount();
    return [
      ['Processing', fmtNum(c.processing), docsHref('processing'), c.waiting && 'warning', 'Not processed, failed or changed at the source: search and the assistant can’t use them, and submissions wait to be classified for review'],
      [inLang('Review', 'Chờ duyệt'), fmtNum(c.review), docsHref('review'), c.review && 'accent', 'Processed submissions, new versions and what syncs held back, waiting for a decision'],
      ['Classification suggestions', fmtNum(sug), taxonomyHref('suggestions'), sug && 'warning', 'Concepts awaiting review, documents no scheme could file and proposed concepts and labels'],
      ['Quality checks', fmtNum(c.quality), docsHref('all', { quality: part }), c.quality && 'warning', 'Re-verification due, missing classification, owner or summary, possible duplicates'],
      ['Verified', pub.length ? `${pct(verified, pub.length)}%` : '—', docsHref('all', { quality: 'reverify' }), pub.length ? 'share' : '', `${fmtNum(verified)} of ${fmtNum(pub.length)} published documents are verified`],
    ];
  }
  function healthHtml(metrics) {
    const cell = ([label, value, href, tone, tip]) => `<a class="${cx('health__item', tone && 'is-due', tone && 'health__item--' + tone)}" href="#${href}" data-tip="${esc(tip)}"><span class="health__value num">${esc(value)}</span><span class="health__label">${esc(label)}</span></a>`;
    return `<nav class="health" aria-label="Knowledge health">${metrics.map(cell).join('')}</nav>`;
  }
  /** Decisions waiting before documents reach people (counted in the page's "need you" line with the attention items). */
  const healthDue = metrics => metrics.slice(0, 2).filter(m => m[3]).length;

  /* ── This week ── */
  /** Change against last week; nothing when last week had none to compare with (a "↑0%" there would be wrong). */
  function delta(now, prev) {
    if (!prev) return '';
    const d = Math.round(((now - prev) / prev) * 100);
    return `<span class="${cx('ov-delta', d < 0 && 'ov-delta--down')}">${ic(d < 0 ? 'arrow-down' : 'arrow-up', 'i-xs')}${Math.abs(d)}%</span> vs last week`;
  }
  function slaCard() {
    const offices = officeIds();
    const all = (D.svcRequests || []).filter(r => offices.has(r.space));
    const done = all.filter(r => DONE_SR.includes(r.status));
    const onTime = done.filter(r => (r.resolvedAt || r.updated) <= r.due).length;
    const open = all.filter(r => OPEN_SR.includes(r.status) || r.status === 'needs_info').length;
    const p = pct(onTime, done.length);
    return statCard({ icon: 'clipboard', label: 'Requests on time', value: done.length ? `${p}%` : '—', meta: done.length ? `${fmtNum(onTime)} of ${fmtNum(done.length)} resolved by the due date · ${fmtNum(open)} open` : `No requests resolved yet · ${fmtNum(open)} open`, tone: !done.length ? '' : p >= 90 ? 'success' : 'warning', act: 'go', data: { to: '/requests?tab=queue' } });
  }
  function kpis() {
    const u = D.usage;
    const ids = managedKbs().map(k => k.id);
    const docs = D.docs.filter(d => !d.archived && isPublishedStage(d) && ids.includes(d.kb));
    const ready = docs.filter(d => d.status === 'ready').length;
    const srcBad = attentionSources().length, srcAll = D.sources.length;
    const last = hasModule('requests') ? slaCard()
      : statCard({ icon: 'refresh', label: 'Sources healthy', value: `${srcAll - srcBad}<span class="ov-of">/${srcAll}</span>`, meta: srcBad ? `${plural(srcBad, 'source')} need${srcBad === 1 ? 's' : ''} attention` : 'All syncing', tone: srcBad ? 'danger' : 'success', act: 'go', data: { to: studioHref('sources') } });
    // Every card opens where its number comes from; Questions has no page of its own, so its trend sits inside the card.
    const spark = `<div class="ov-spark" aria-hidden="true">${sparkline(u.questions.slice(-14), { height: 28 })}</div>`;
    return `<div class="grid cols-4">
      ${statCard({ icon: 'message', label: 'Questions this week', value: fmtNum(u.questions7), meta: delta(u.questions7, u.questions7Prev), tone: 'accent', extra: spark })}
      ${statCard({ icon: 'users', label: 'Active members', value: fmtNum(u.active), meta: delta(u.active, u.activePrev), act: 'go', data: { to: '/people' } })}
      ${statCard({ icon: 'files', label: 'Documents searchable', value: `${pct(ready, docs.length)}%`, meta: `${fmtNum(ready)} of ${fmtNum(docs.length)} published documents`, tone: ready < docs.length ? 'warning' : 'success', act: 'go', data: { to: docsTo() } })}
      ${last}
    </div>`;
  }
  /** Frequent questions knowledge couldn't answer well: one fix each (Answer it), the rest in ⋯. Hidden when there are none. */
  function gapsSection() {
    const gaps = D.gaps.filter(g => !g.dismissed && kbById(g.kb)).sort((a, b) => b.n - a.n).slice(0, 4);
    if (!gaps.length) return '';
    const rows = gaps.map(g => {
      const kb = kbById(g.kb), edit = canEditKb(kb);
      return item({
        lead: `<span class="ov-gap-n" data-tip="Times asked">${g.n}×</span>`,
        title: `“${esc(g.q)}”`,
        desc: `<span class="ov-line">${esc(kb.name)} · ${esc(g.why)}</span>`,
        trail: edit
          ? btn('Answer it', { v: 'secondary', size: 'sm', icon: 'pencil', act: 'ov-gap-answer', data: { id: g.id } }) + iconBtn('more', 'More actions', { size: 'sm', menu: 'ov-gap', data: { id: g.id } })
          : iconBtn('x', 'Dismiss', { size: 'sm', act: 'ov-gap-dismiss', data: { id: g.id } }),
      });
    });
    return section('Knowledge gaps', list(rows, 'ov-attn ov-gaps'));
  }
  MENUS['ov-gap'] = el => {
    const g = D.gaps.find(x => x.id === el.dataset.id); if (!g) return [];
    return [
      { label: 'Contribute', icon: 'upload', run: () => A['ov-gap-add']({ dataset: { kb: g.kb } }) },
      { sep: true },
      { label: 'Dismiss', icon: 'x', run: () => A['ov-gap-dismiss']({ dataset: { id: g.id } }) },
    ];
  };

  P.overview = () => {
    const live = S.pageState === 'live' && !S.navLoading, health = live ? healthMetrics() : [];
    const n = live ? attention().length + healthDue(health) : 0;
    const head = pageHeader({ title: 'Overview', meta: !live ? '' : n ? esc(n === 1 ? '1 thing needs you' : `${fmtNum(n)} things need you`) : 'Nothing needs you right now' });
    const body = gate({
      loading: () => `${skelRows(3)}<div class="mt-32">${skelCards(3)}</div>`,
      error: () => errorState({ title: 'The overview didn’t load' }),
      // A new workspace: the setup guide is the whole page (bases → taxonomy → sources → first sync).
      empty: () => `${X.setupGuide?.({ force: true }) || ''}<div class="mt-16">${btn('Add people', { icon: 'user-plus', act: 'ov-add-people' })}</div>`,
      ok: () => `${X.setupGuide?.() || ''}${section('Needs attention', attentionHtml())}
        ${health.length ? section('Knowledge health', healthHtml(health)) : ''}
        ${gapsSection()}
        ${section('This week', kpis())}`,
    });
    return `<div class="page">${head}${body}</div>`;
  };

  A['ov-source'] = el => call('src-open', { id: el.dataset.id }, () => go(studioHref('sources')));
  A['ov-kb-create'] = () => call('kb-create', {}, () => go('/knowledge'));
  A['ov-add-people'] = () => call('member-add', {}, () => go('/people'));
  A['ov-gap-add'] = el => call('contribute', { kb: el.dataset.kb }, () => go(kbManageHref({ id: el.dataset.kb })));
  A['ov-gap-dismiss'] = el => {
    const g = D.gaps.find(x => x.id === el.dataset.id); if (!g) return;
    g.dismissed = true; refresh();
    toast('Gap dismissed', { action: { label: 'Undo', run: () => { g.dismissed = false; refresh(); } } });
  };

  /* ── Answer a gap: the answer becomes a ready FAQ document the assistant can cite ── */
  const faqName = q => `FAQ — ${q.trim().replace(/[?？.\s]+$/, '').slice(0, 70)}.md`;
  A['ov-gap-answer'] = el => {
    const g = D.gaps.find(x => x.id === el.dataset.id); if (!g || !canEditKb(kbById(g.kb))) return;
    S.ui.ovGap = { id: g.id, text: '', tried: false, busy: false };
    openModal('ov-gap-answer', {});
  };
  M['ov-gap-answer'] = () => {
    const f = ui('ovGap'), g = D.gaps.find(x => x.id === f.id), kb = kbById(g?.kb);
    if (!g || !kb) return { title: 'This gap was closed', icon: 'check-circle', tone: 'success', size: 'sm', desc: 'Someone already answered it or dismissed it.', foot: btn('Close', { v: 'primary', act: 'close-modal' }) };
    const err = f.tried && !f.text.trim() ? 'Write the answer people should get.' : '';
    return {
      title: 'Answer a frequent question', icon: 'message-plus', size: 'md', guard: f.busy,
      desc: 'Your answer becomes a short FAQ the assistant cites from now on.',
      body: `<div class="ov-gap-q"><span class="ov-gap-n" data-tip="Times asked">${g.n}×</span><span class="stack gap-2"><span>“${esc(g.q)}”</span><span class="t-sm muted" style="font-weight:400">${esc(g.why)}</span></span></div>
        ${field({ id: 'ov-gap-text', label: 'Answer', required: true, error: err, desc: esc(`Saved to ${kb.name} as an FAQ document.`),
          control: textarea({ id: 'ov-gap-text', bind: 'ovGap.text', value: f.text, rows: 6, invalid: !!err, placeholder: 'A short, direct answer. Name the rule or office it comes from.', attrs: `data-autofocus ${err ? 'data-live' : ''} ${f.busy ? 'disabled' : ''}` }) })}`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Save answer', { v: 'primary', icon: 'check', act: 'ov-gap-save', loading: f.busy }),
    };
  };
  A['ov-gap-save'] = async () => {
    const f = ui('ovGap'); if (f.busy) return;
    const i = D.gaps.findIndex(x => x.id === f.id), g = D.gaps[i], kb = kbById(g?.kb); if (!g || !kb) return closeModal();
    f.tried = true;
    const text = f.text.trim();
    if (!text) { refreshLayer(); $('#ov-gap-text')?.focus(); return; }
    f.busy = true; refreshLayer(); await sleep(600);
    const doc = mkDoc(kb.id, uid('d'), faqName(g.q), { addedBy: me().name, updated: Date.now(), pages: 1, passages: Math.max(1, Math.round(text.length / 400)), size: 1200 + text.length * 2, status: 'ready' });
    doc.faq = { q: g.q, a: text };
    D.docs.push(doc); D.gaps.splice(i, 1);
    const prevUpdated = kb.updated; kb.updated = Date.now();
    audit('Answered a frequent question', `${doc.name} → ${kb.name}`);
    closeModal(); refresh();
    toast(`Saved to ${kb.name}. People get this answer now.`, { action: { label: 'Undo', run: () => { D.docs = D.docs.filter(d => d !== doc); D.gaps.splice(Math.min(i, D.gaps.length), 0, g); kb.updated = prevUpdated; refresh(); } } });
  };
})();

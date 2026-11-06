/* Overview (/overview) — the admin home. Answers "what needs me?" first,
   then how the workspace is doing this week and where knowledge falls short.
   Module-aware: with Requests on it also watches office queues and SLA. */
(() => {
  'use strict';

  const call = (name, data, fallback) => (A[name] ? A[name]({ dataset: data }) : fallback?.());
  const managedKbs = () => D.kbs.filter(k => !k.archived && !k.personal);
  const names = list => list.length <= 2 ? list.join(' and ') : `${list.slice(0, 2).join(', ')} and ${plural(list.length - 2, 'other')}`;
  const OPEN_SR = ['submitted', 'in_review'], DONE_SR = ['approved', 'declined', 'completed'];
  const svcType = id => (D.requestTypes || []).find(t => t.id === id);
  const officeIds = () => new Set((D.spaces || []).filter(s => s.type === 'office' && !s.archived).map(s => s.id));
  const docsTo = () => '/documents?tab=all';
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
      Decisions (approve a request, publish a submission) happen on that page, never here. */
  function attention() {
    const items = [];
    requestAttention(items);
    // An expired account is one problem, however many sources it stops; its fix lives in Connections.
    const expired = new Map();
    attentionSources().forEach(s => {
      const acc = accById(s.account), app = APPS[s.app]?.name || 'The app';
      if (s.status === 'reconnect' || acc?.status === 'expired') { const k = s.account || s.id; if (!expired.has(k)) expired.set(k, { app, list: [] }); expired.get(k).list.push(s); return; }
      items.push({ id: 'src-' + s.id, tone: 'danger', icon: 'alert-circle', title: `${s.name} couldn’t sync`, desc: esc(s.last?.error || 'The last sync failed.'), actions: btn('Open source', { v: 'secondary', size: 'sm', act: 'ov-source', data: { id: s.id } }) });
    });
    expired.forEach(({ app, list }, k) => {
      const kbs = [...new Set(list.map(s => kbById(s.kb)?.name).filter(Boolean))];
      items.push({ id: 'acc-' + k, tone: 'danger', icon: 'plug', title: `${names(list.map(s => s.name))} stopped syncing`, desc: esc(`${app} access expired${kbs.length ? ` · ${names(kbs)} ${kbs.length === 1 ? 'isn’t' : 'aren’t'} getting updates` : ''}`), actions: btn('Reconnect', { v: 'secondary', size: 'sm', href: '/connections' }) });
    });
    const reqs = pendingRequests();
    if (reqs.length) {
      const r = reqs[0], one = reqs.length === 1, people = new Set(reqs.map(x => x.user)).size;
      const kbs = [...new Set(reqs.map(x => kbById(x.kb)?.name).filter(Boolean))];
      const title = one ? `${actorName(r.user)} asked for ${KB_ROLES[r.role === 'editor' ? 'editor' : 'viewer'].label} access` : `${plural(people, 'person', 'people')} waiting for access`;
      items.push({ id: 'req', tone: 'warning', icon: 'user-plus', title, desc: esc(one ? [kbById(r.kb)?.name, r.note && `“${r.note}”`].filter(Boolean).join(' · ') : `To ${names(kbs)}`), actions: btn('Open requests', { v: 'secondary', size: 'sm', href: '/people?tab=requests' }) });
    }
    const queue = reviewQueue();
    if (queue.length) items.push({ id: 'cur-review', tone: 'accent', icon: 'inbox', title: `${plural(queue.length, 'submission')} waiting for review`, desc: esc(names(queue.map(d => d.name))), actions: btn('Review submissions', { v: 'secondary', size: 'sm', href: '/documents?tab=review' }) });
    const docs = managedKbs().flatMap(kb => docsIn(kb.id));
    const failed = docs.filter(d => d.status === 'failed');
    if (failed.length) items.push({ id: 'docs-failed', tone: 'warning', icon: 'file-text', title: `${plural(failed.length, 'document')} couldn’t be published`, desc: esc(names(failed.map(d => d.name))), actions: btn('Fix publishing', { v: 'secondary', size: 'sm', href: '/documents?tab=all&life=attention' }) });
    // Changed at the source: one item for all of them; the fix (Publish update) republishes from the source.
    const old = docs.filter(d => d.status === 'outdated');
    if (old.length) items.push({ id: 'docs-update', tone: 'warning', icon: 'refresh', title: `${plural(old.length, 'document')} changed at the source`, desc: esc(`${names(old.map(d => d.name))} · answers use the previous version`), actions: btn('Publish updates', { v: 'secondary', size: 'sm', act: 'ov-publish-updates' }) });
    const waiting = waitingDocs();
    if (waiting.length) items.push({ id: 'waiting', tone: 'default', icon: 'loader', title: `${plural(waiting.length, 'document')} waiting to publish`, desc: esc(names(waiting.map(d => d.name))), actions: btn('Publish all', { v: 'secondary', size: 'sm', act: 'ov-process' }) });
    // Re-verification is about trust (verification expired), not about source changes, which are listed above.
    const due = (X.khReview?.() || []).filter(x => x.reason === 'expired');
    if (due.length) items.push({ id: 'kh-review', tone: 'warning', icon: 'shield-check', title: `${plural(due.length, 'document')} due for re-verification`, desc: esc(names(due.map(x => x.d.name))), actions: btn('Re-verify', { v: 'secondary', size: 'sm', act: 'ov-reverify' }) });
    // Most urgent first: broken (danger), then waiting on you (warning), then routine (accent, default).
    const rank = { danger: 0, warning: 1, accent: 2, default: 3 };
    return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }
  /** Approved but not picked up for over 30 minutes, outside a running sync. */
  function waitingDocs() {
    const ids = new Set(managedKbs().map(k => k.id));
    return D.docs.filter(d => !d.archived && isPublishedStage(d) && ids.has(d.kb) && d.status === 'pending' && Date.now() - d.updated > 30 * MIN && srcById(d.source)?.status !== 'syncing');
  }
  function attentionHtml() {
    const items = attention();
    if (!items.length) return emptyState({ icon: 'check-circle', tone: 'success', title: 'Everything is running', desc: hasModule('requests') ? 'Queues are on time, sources are syncing and no one is waiting on you.' : 'Sources are syncing and no one is waiting on you.', boxed: true, compact: true });
    return list(items.map(it => item({ lead: itemIcon(it.icon, it.tone), title: esc(it.title), desc: `<span class="ov-line">${it.desc}</span>`, trail: it.actions, lines: 2 })), 'ov-attn');
  }

  /* ── This week ── */
  function delta(now, prev) {
    const d = prev ? Math.round(((now - prev) / prev) * 100) : 0;
    return `<span class="${cx('ov-delta', d < 0 && 'ov-delta--down')}">${ic(d < 0 ? 'arrow-down' : 'arrow-up', 'i-xs')}${Math.abs(d)}%</span> vs last week`;
  }
  function slaCard() {
    const offices = officeIds();
    const all = (D.svcRequests || []).filter(r => offices.has(r.space));
    const done = all.filter(r => DONE_SR.includes(r.status));
    const onTime = done.filter(r => (r.resolvedAt || r.updated) <= r.due).length;
    const open = all.filter(r => OPEN_SR.includes(r.status) || r.status === 'needs_info').length;
    const p = pct(onTime, done.length);
    return statCard({ icon: 'clipboard', label: 'Requests on time', value: done.length ? `${p}%` : '—', meta: done.length ? `${fmtNum(onTime)} of ${fmtNum(done.length)} resolved within SLA · ${fmtNum(open)} open` : `No requests resolved yet · ${fmtNum(open)} open`, tone: !done.length ? '' : p >= 90 ? 'success' : 'warning', act: 'go', data: { to: '/requests?tab=queue' } });
  }
  function kpis() {
    const u = D.usage;
    const ids = managedKbs().map(k => k.id);
    const docs = D.docs.filter(d => !d.archived && isPublishedStage(d) && ids.includes(d.kb));
    const ready = docs.filter(d => d.status === 'ready').length;
    const srcBad = attentionSources().length, srcAll = D.sources.length;
    const last = hasModule('requests') ? slaCard()
      : statCard({ icon: 'refresh', label: 'Sources healthy', value: `${srcAll - srcBad}<span class="ov-of">/${srcAll}</span>`, meta: srcBad ? `${plural(srcBad, 'source')} need${srcBad === 1 ? 's' : ''} attention` : 'All syncing', tone: srcBad ? 'danger' : 'success', act: 'go', data: { to: '/sources' } });
    // Every card opens where its number comes from; Questions has no page of its own, so its trend sits inside the card.
    const spark = `<div class="ov-spark" aria-hidden="true">${sparkline(u.questions.slice(-14), { height: 28 })}</div>`;
    return `<div class="grid cols-4">
      ${statCard({ icon: 'message', label: 'Questions this week', value: fmtNum(u.questions7), meta: delta(u.questions7, u.questions7Prev), tone: 'accent', extra: spark })}
      ${statCard({ icon: 'users', label: 'Active people', value: fmtNum(u.active), meta: delta(u.active, u.activePrev), act: 'go', data: { to: '/people' } })}
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
    return section('Knowledge gaps', list(rows, 'ov-attn ov-gaps'), { desc: 'Frequent questions knowledge couldn’t answer well.' });
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
    const live = S.pageState === 'live' && !S.navLoading, n = live ? attention().length : 0;
    const head = pageHeader({ title: 'Overview', desc: !live ? '' : n ? esc(n === 1 ? '1 thing needs you' : `${fmtNum(n)} things need you`) : 'Nothing needs you right now' });
    const body = gate({
      loading: () => `${skelRows(3)}<div class="mt-32">${skelCards(3)}</div>`,
      error: () => errorState({ title: 'The overview didn’t load' }),
      empty: () => emptyState({ icon: 'home', title: 'Your workspace is ready', desc: 'Add knowledge and people. Activity and health show up here.', actions: btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'ov-kb-create' }) + btn('Add people', { icon: 'user-plus', act: 'ov-add-people' }), boxed: true }),
      ok: () => `${section('Needs attention', attentionHtml())}
        ${gapsSection()}
        ${section('This week', kpis())}`,
    });
    return `<div class="page">${head}${body}</div>`;
  };

  A['ov-source'] = el => call('src-open', { id: el.dataset.id }, () => go('/sources'));
  A['ov-process'] = () => {
    const docs = waitingDocs(); if (!docs.length) return;
    if (X.processDocs) X.processDocs(docs, { msg: `Publishing ${plural(docs.length, 'document')}` });
    else go(docsTo());
  };
  /** Changed at the source → Publish update republishes from the source; uploads that changed need a new file, in Documents. */
  A['ov-publish-updates'] = () => {
    const old = managedKbs().flatMap(kb => docsIn(kb.id)).filter(d => d.status === 'outdated');
    const synced = old.filter(d => d.source && d.source !== 'upload' && srcById(d.source));
    if (synced.length && X.processDocs) X.processDocs(synced, { msg: `Publishing the update to ${plural(synced.length, 'document')}` });
    if (synced.length < old.length) go('/documents?tab=all&life=attention');
  };
  /** Opens Quality filtered to what the item counted (verification expired). */
  A['ov-reverify'] = () => { Object.assign(ui('khReview', {}), { reason: 'expired', kb: '', q: '', page: 1 }); go('/documents?tab=quality&seg=reverify'); };
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
    toast(`Saved to ${kb.name}. People get this answer now.`, { action: { label: 'Undo', run: () => { D.docs = D.docs.filter(d => d !== doc); D.gaps.splice(Math.min(i, D.gaps.length), 0, g); kb.updated = prevUpdated; refresh(); toast('Answer removed', { tone: 'accent' }); } } });
  };
})();

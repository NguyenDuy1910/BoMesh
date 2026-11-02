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
  function attention() {
    const items = [];
    requestAttention(items);
    attentionSources().forEach(s => {
      const acc = accById(s.account), kb = kbById(s.kb), app = APPS[s.app]?.name || 'The app';
      if (s.status === 'reconnect' || acc?.status === 'expired') {
        items.push({ id: 'src-' + s.id, tone: 'danger', icon: 'plug', title: `${s.name} stopped syncing`, desc: `${app} access expired${kb ? ` · ${esc(kb.name)} isn’t getting updates` : ''}`, actions: btn('Reconnect', { v: 'secondary', size: 'sm', act: 'ov-reconnect', data: { id: s.account } }) });
      } else {
        items.push({ id: 'src-' + s.id, tone: 'danger', icon: 'alert-circle', title: `${s.name} couldn’t sync`, desc: esc(s.last?.error || 'The last sync failed.'), actions: btn('Open', { v: 'secondary', size: 'sm', act: 'ov-source', data: { id: s.id } }) });
      }
    });
    const reqs = pendingRequests();
    if (reqs.length === 1) {
      const r = reqs[0];
      items.push({ id: 'req', tone: 'warning', icon: 'user-plus', title: `${actorName(r.user)} wants ${r.role === 'editor' ? 'edit' : 'view'} access`, desc: esc(kbById(r.kb)?.name || ''), actions: btn('Review', { v: 'ghost', size: 'sm', href: '/people?tab=requests' }) + btn('Approve', { v: 'secondary', size: 'sm', act: 'ov-approve', data: { id: r.id } }) });
    } else if (reqs.length) {
      const people = new Set(reqs.map(r => r.user)).size;
      const kbs = [...new Set(reqs.map(r => kbById(r.kb)?.name).filter(Boolean))];
      items.push({ id: 'req', tone: 'warning', icon: 'user-plus', title: `${plural(people, 'person', 'people')} waiting for access`, desc: esc(`To ${names(kbs)}`), actions: btn('Review', { v: 'secondary', size: 'sm', href: '/people?tab=requests' }) });
    }
    const queue = reviewQueue();
    if (queue.length) items.push({ id: 'cur-review', tone: 'accent', icon: 'clock', title: `${plural(queue.length, 'document')} waiting for review`, desc: esc(names(queue.map(d => d.name))), actions: btn('Review', { v: 'secondary', size: 'sm', href: '/documents?tab=review' }) });
    const failed = managedKbs().flatMap(kb => docsIn(kb.id).filter(d => d.status === 'failed'));
    if (failed.length) items.push({ id: 'docs-failed', tone: 'warning', icon: 'file-text', title: `${plural(failed.length, 'document')} couldn’t be published`, desc: esc(names(failed.map(d => d.name))), actions: btn('Review', { v: 'secondary', size: 'sm', href: '/documents?tab=all&life=attention' }) });
    managedKbs().forEach(kb => {
      const old = docsIn(kb.id).filter(d => d.status === 'outdated');
      if (old.length === 1) items.push({ id: 'old-' + old[0].id, tone: 'warning', icon: 'history', title: `${old[0].name} needs an update`, desc: `${esc(kb.name)} · answers that cite it may be out of date`, actions: btn('View', { v: 'ghost', size: 'sm', href: '/doc/' + old[0].id }) + btn('Update', { v: 'secondary', size: 'sm', icon: 'upload', act: 'ov-doc-update', data: { id: old[0].id } }) });
      else if (old.length) items.push({ id: 'old-' + kb.id, tone: 'warning', icon: 'history', title: `${plural(old.length, 'document')} in ${kb.name} need an update`, desc: esc(names(old.map(d => d.name))), actions: btn('Review', { v: 'secondary', size: 'sm', href: `/documents?tab=all&life=attention&kb=${kb.id}` }) });
    });
    const waiting = waitingDocs();
    if (waiting.length) items.push({ id: 'waiting', tone: 'default', icon: 'loader', title: `${plural(waiting.length, 'document')} waiting to publish`, desc: esc(names(waiting.map(d => d.name))), actions: btn('Publish now', { v: 'secondary', size: 'sm', act: 'ov-process' }) });
    const due = X.khReview?.() || [];
    if (due.length) items.push({ id: 'kh-review', tone: 'warning', icon: 'shield-check', title: `${plural(due.length, 'resource')} ${due.length === 1 ? 'is' : 'are'} due for review`, desc: esc(names(due.map(x => x.d.name))), actions: btn('Review', { v: 'secondary', size: 'sm', href: '/documents?tab=quality&seg=reverify' }) });
    return items;
  }
  /** Approved but not picked up for over 30 minutes, outside a running sync. */
  function waitingDocs() {
    const ids = new Set(managedKbs().map(k => k.id));
    return D.docs.filter(d => !d.archived && isPublishedStage(d) && ids.has(d.kb) && d.status === 'pending' && Date.now() - d.updated > 30 * MIN && srcById(d.source)?.status !== 'syncing');
  }
  function attentionHtml() {
    const items = attention();
    if (!items.length) return emptyState({ icon: 'check-circle', tone: 'success', title: 'Everything is running', desc: hasModule('requests') ? 'Queues are on time, sources are syncing and no one is waiting on you.' : 'Sources are syncing and no one is waiting on you.', boxed: true, compact: true });
    return list(items.map(it => item({ lead: itemIcon(it.icon, it.tone), title: esc(it.title), desc: `<span class="truncate ov-line">${it.desc}</span>`, trail: it.actions })), 'ov-attn');
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
    return `<div class="grid cols-4">
      ${statCard({ icon: 'message', label: 'Questions this week', value: fmtNum(u.questions7), meta: delta(u.questions7, u.questions7Prev), tone: 'accent', act: 'ov-usage' })}
      ${statCard({ icon: 'users', label: 'Active people', value: fmtNum(u.active), meta: delta(u.active, u.activePrev), act: 'go', data: { to: '/people' } })}
      ${statCard({ icon: 'files', label: 'Documents searchable', value: `${pct(ready, docs.length)}%`, meta: `${fmtNum(ready)} of ${fmtNum(docs.length)} published documents`, tone: ready < docs.length ? 'warning' : 'success', act: 'go', data: { to: docsTo() } })}
      ${last}
    </div>`;
  }
  function usageCard() {
    const q = D.usage.questions, days = q.map((_, i) => NOW - (q.length - 1 - i) * DAY);
    const total = q.reduce((a, b) => a + b, 0);
    return card(`<div class="stat__value">${fmtNum(total)}</div>${bars(q, { height: 140, labels: days.map(fmtDate) })}<div class="row between t-xs muted"><span>${esc(fmtDate(days[0]))}</span><span>Today</span></div>`, { title: 'Questions, last 30 days', cls: 'ov-usage' });
  }
  function gapsCard() {
    const gaps = D.gaps.filter(g => !g.dismissed && kbById(g.kb)).sort((a, b) => b.n - a.n).slice(0, 4);
    const body = gaps.length
      ? list(gaps.map(g => {
        const kb = kbById(g.kb), edit = canEditKb(kb);
        return item({
          lead: `<span class="ov-gap-n" title="Times asked">${g.n}×</span>`,
          title: `“${esc(g.q)}”`,
          desc: `<span class="ov-line">${esc(kb.name)} · ${esc(g.why)}</span>${edit ? `<span class="ov-gap-actions">${btn('Answer it', { v: 'secondary', size: 'sm', icon: 'pencil', act: 'ov-gap-answer', data: { id: g.id } })}${btn('Add documents', { v: 'ghost', size: 'sm', icon: 'upload', act: 'ov-gap-add', data: { kb: g.kb } })}</span>` : ''}`,
          trail: iconBtn('x', 'Dismiss', { size: 'sm', act: 'ov-gap-dismiss', data: { id: g.id } }),
        });
      }), 'list--plain ov-gaps')
      : emptyState({ icon: 'check-circle', tone: 'success', title: 'No gaps this week', desc: 'Frequent questions found good answers.', compact: true });
    return card(body, { title: 'Knowledge gaps', desc: 'Frequent questions knowledge couldn’t answer well.' });
  }

  P.overview = () => {
    const head = pageHeader({ title: 'Overview', desc: esc(curWs().name) });
    const body = gate({
      loading: () => `${skelRows(3)}<div class="mt-32">${skelCards(3)}</div>`,
      error: () => errorState({ title: 'The overview didn’t load' }),
      empty: () => emptyState({ icon: 'home', title: 'Your workspace is ready', desc: 'Add knowledge and people. Activity and health show up here.', actions: btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'ov-kb-create' }) + btn('Add people', { icon: 'user-plus', act: 'ov-add-people' }), boxed: true }),
      ok: () => `${section('Needs attention', attentionHtml())}
        ${section('This week', kpis())}
        <div class="ov-split mt-16">${usageCard()}${gapsCard()}</div>`,
    });
    return `<div class="page">${head}${body}</div>`;
  };

  A['ov-reconnect'] = el => call('acc-reconnect', { id: el.dataset.id }, () => go('/connections'));
  A['ov-source'] = el => call('src-open', { id: el.dataset.id }, () => go('/sources'));
  A['ov-approve'] = el => call('req-approve', { id: el.dataset.id }, () => go('/people?tab=requests'));
  A['ov-doc-update'] = el => call('doc-replace', { id: el.dataset.id }, () => go('/doc/' + el.dataset.id));
  A['ov-process'] = () => {
    const docs = waitingDocs(); if (!docs.length) return;
    if (X.processDocs) X.processDocs(docs, { msg: `Publishing ${plural(docs.length, 'document')}` });
    else go(docsTo());
  };
  A['ov-usage'] = () => { const c = $('.ov-usage'); if (!c) return; c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.remove('ov-flash'); void c.offsetWidth; c.classList.add('ov-flash'); };
  A['ov-kb-create'] = () => call('kb-create', {}, () => go('/knowledge'));
  A['ov-add-people'] = () => call('member-add', {}, () => go('/people'));
  A['ov-gap-add'] = el => call('contribute', { kb: el.dataset.kb }, () => go('/knowledge/' + el.dataset.kb));
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
    if (!g || !kb) return { title: 'This gap was closed', body: emptyState({ icon: 'check-circle', title: 'Nothing left to answer', compact: true }), foot: btn('Close', { act: 'close-modal' }) };
    const err = f.tried && !f.text.trim() ? 'Write the answer people should get.' : '';
    return {
      title: 'Answer a frequent question', size: 'md', guard: f.busy,
      body: `<div class="ov-gap-q"><span class="ov-gap-n">${g.n}×</span><span>“${esc(g.q)}”</span></div>
        ${field({ id: 'ov-gap-text', label: 'Answer', required: true, error: err, desc: `Saved to ${esc(kb.name)} as <span class="medium">${esc(faqName(g.q))}</span>. The assistant cites it from now on.`,
          control: textarea({ id: 'ov-gap-text', bind: 'ovGap.text', value: f.text, rows: 6, invalid: !!err, placeholder: 'A short, direct answer. Name the rule or office it comes from.', attrs: `data-autofocus ${f.busy ? 'disabled' : ''}` }) })}`,
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + btn('Save answer', { v: 'primary', act: 'ov-gap-save', loading: f.busy, disabled: f.busy }),
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

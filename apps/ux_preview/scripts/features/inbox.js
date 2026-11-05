/* Inbox (/inbox) — notifications for every persona. Items are derived from
   live data (sources, access requests, documents, spaces, events, work and
   requests, depending on the workspace's modules) plus a few fixed events.
   Ids are stable so read/dismissed state (S.inbox, persisted) sticks. */
(() => {
  'use strict';

  // Older events start read (first visit only; hydrate() replaces with saved state).
  ['a4', 'a5', 'm3', 'o1'].forEach(id => S.inbox.read.add(id));

  const TONE = { err: 'danger', warn: 'warning', info: 'accent', ok: 'success', neu: '' };
  const OPEN_SR = ['submitted', 'in_review'];
  const now = () => Date.now();
  const svcType = id => (D.requestTypes || []).find(t => t.id === id);
  /** Spaces whose queue the caller works (course teams, office staff). */
  const queueSpaces = () => (D.spaces || []).filter(sp => !sp.archived && isSpaceStaff(sp));

  /* ── Access requests to a knowledge base (admins: all; owners: their bases) ── */
  function accessItem(r) {
    const kb = kbById(r.kb);
    return { id: 'req-' + r.id, icon: 'user-plus', tone: 'warn', title: `${actorName(r.user)} requested ${r.role === 'editor' ? 'edit' : 'view'} access to ${kb?.name || 'a knowledge base'}`, body: r.note ? `“${r.note}”` : 'No message.', at: r.at, to: isAdmin() ? '/people?tab=requests' : `/knowledge/${r.kb}?tab=access`, kind: 'request', req: r.id };
  }

  /* ── Spaces: announcements from the last 7 days ── */
  function announcementItems() {
    if (!hasModule('spaces')) return [];
    return mySpaces().flatMap(sp => (sp.announcements || []).filter(a => a.by !== me().id && now() - a.at <= 7 * DAY).map(a => ({
      id: 'ann-' + a.id, icon: 'megaphone', tone: 'info', title: `${sp.code || sp.name}: ${a.title}`, body: `${actorName(a.by)} · ${a.text}`, at: a.at, to: '/space/' + sp.id, space: sp.id,
    })));
  }

  /* ── Events: what's due in the next 3 days for this person ── */
  function eventVisible(ev) {
    const sp = spaceById(ev.space); if (!sp) return ev.audience === 'all';
    const role = spaceRole(sp), staff = isSpaceStaff(sp);
    if (ev.audience === 'all') return true;
    if (ev.audience === 'staff') return staff;
    return !!role && !(staff && sp.type === 'course');
  }
  function deadlineItems() {
    if (!hasModule('spaces')) return [];
    const t = now();
    return (D.events || []).filter(ev => ev.at > t && ev.at - t <= 3 * DAY && eventVisible(ev)).map(ev => {
      const sp = spaceById(ev.space);
      const to = ev.work && hasModule('work') ? '/work/' + ev.work : ev.doc ? '/doc/' + ev.doc : ev.requestType && hasModule('requests') ? '/requests/new?type=' + ev.requestType : '/space/' + ev.space;
      const verb = { quiz: 'closes', exam: 'is', meeting: 'is' }[ev.kind] || 'is due';
      return { id: 'due-' + ev.id, icon: 'calendar', tone: 'warn', title: `${ev.title} ${verb} ${relFuture(ev.at)}`, body: sp?.name || '', at: Math.min(t, ev.at - 3 * DAY), when: `Due ${fmtDateTime(ev.at)}`, to };
    });
  }

  /* ── Work: new quizzes for members, results for their authors, drafts someone waits for ── */
  const attempted = w => (w.data?.attempts || []).some(a => (a.user || a.by) === me().id);
  function workItems() {
    if (!hasModule('work')) return [];
    const out = [];
    (D.works || []).forEach(w => {
      const sp = spaceById(w.space);
      if (w.kind === 'quiz' && w.status === 'published' && w.visibility === 'space' && sp && spaceRole(sp) && !isSpaceStaff(sp) && !attempted(w) && (!w.due || w.due > now())) {
        const n = w.data?.questions?.length || 0;
        out.push({ id: 'quiz-' + w.id, icon: WORKFLOWS[w.workflow]?.icon || 'list', tone: 'info', title: `New quiz in ${sp.name}: ${w.title}`, body: [plural(n, 'question'), w.data?.timeLimit && `${w.data.timeLimit} min`, w.due && `closes ${fmtDateTime(w.due)}`].filter(Boolean).join(' · '), at: w.published || w.updated, to: '/work/' + w.id, cta: 'Start', space: sp.id });
      }
      const st = w.data?.stats;
      if (w.kind === 'quiz' && w.owner === me().id && w.status === 'published' && st?.attempts > 0) {
        const qs = w.data.questions || [], by = st.byQuestion || [];
        const worst = by.length ? by.indexOf(Math.min(...by)) : -1;
        out.push({ id: 'quizres-' + w.id, icon: 'chart', tone: 'ok', title: `Results are in for ${w.title}`, body: `${plural(st.attempts, 'attempt')} · average ${st.avg}/${qs.length}${worst >= 0 && qs[worst] ? ` · most missed: “${qs[worst].q}” (${Math.round(by[worst] * 100)}% correct)` : ''}`, at: w.updated, to: '/work/' + w.id, cta: 'See results' });
      }
      if (w.owner === me().id && ['draft', 'ready'].includes(w.status) && sp) {
        const ev = (D.events || []).find(e => e.work === w.id && e.at > now());
        const leadRole = spaceType(sp.type).staff[0];
        const lead = sp.members?.find(m => m.role === leadRole && m.user !== me().id);
        if (ev && lead) out.push({ id: 'wdue-' + w.id, icon: 'pencil', tone: 'neu', title: `${actorName(lead.user)} is waiting for your draft`, body: `${w.title} · ${ev.title} ${fmtDate(ev.at)}`, at: Math.min(now(), w.updated), to: '/work/' + w.id, cta: 'Open draft' });
      }
    });
    return out;
  }

  /* ── Requests: updates come from the Requests module; this file adds the SLA summary ── */
  function requestFallback() {
    const out = [], mine = (D.svcRequests || []).filter(r => r.requester === me().id && now() - (r.updated || r.created) <= 14 * DAY);
    const T = { needs_info: ['alert', 'warn', 'needs more information'], approved: ['check-circle', 'ok', 'was approved'], declined: ['x-circle', 'neu', 'was declined'], completed: ['check-circle', 'ok', 'is done'] };
    mine.forEach(r => {
      const t = T[r.status]; if (!t) return;
      const type = svcType(r.type), last = r.thread?.[r.thread.length - 1];
      const answered = last?.kind === 'answer';
      out.push({ id: `sr-${r.id}-${r.status}`, icon: answered ? 'message' : t[0], tone: t[1], title: answered ? `${actorName(last.by)} answered your question` : `${type?.name || 'Your request'} ${t[2]}`, body: last?.text || r.id, at: r.updated || r.created, to: '/requests/' + r.id, ...(r.status === 'needs_info' ? { kind: 'reply', cta: 'Reply' } : {}) });
    });
    queueSpaces().forEach(sp => {
      const fresh = (D.svcRequests || []).filter(r => r.space === sp.id && r.status === 'submitted');
      if (!fresh.length) return;
      const q = fresh.every(r => svcType(r.type)?.question);
      out.push({ id: `srq-${sp.id}-${fresh.map(r => r.id).sort().join('.')}`, icon: q ? 'message' : 'clipboard', tone: 'info', title: `${plural(fresh.length, q ? 'new question' : 'new request')} in ${sp.name}`, body: fresh.slice(0, 3).map(r => `${actorName(r.requester)} · ${svcType(r.type)?.name || r.id}`).join(', '), at: Math.max(...fresh.map(r => r.created)), to: '/requests?tab=queue', cta: 'Review queue' });
    });
    return out;
  }
  function slaItem() {
    if (!hasModule('requests')) return [];
    const ids = new Set(queueSpaces().map(s => s.id)), t = now();
    const open = (D.svcRequests || []).filter(r => ids.has(r.space) && OPEN_SR.includes(r.status) && r.due);
    const late = open.filter(r => r.due < t), soon = open.filter(r => r.due >= t && r.due - t <= DAY);
    const hit = late.length ? late : soon; if (!hit.length) return [];
    const key = hit.map(r => r.id).sort().join('.');
    return [{
      id: 'sla-' + hashOf(key), icon: 'clock', tone: late.length ? 'err' : 'warn',
      title: late.length ? `${plural(late.length, 'request')} past the response time` : `${plural(soon.length, 'request')} due within a day`,
      body: hit.slice(0, 3).map(r => `${r.id} · ${svcType(r.type)?.name || ''} · ${actorName(r.requester)}`).join(', ') + (hit.length > 3 ? ` and ${hit.length - 3} more` : ''),
      at: late.length ? Math.max(...late.map(r => r.due)) : t - 30 * MIN, to: '/requests?tab=queue', cta: 'Review queue',
    }];
  }

  function items() {
    const out = [];
    if (isAdmin()) {
      attentionSources().forEach(s => {
        const reconnect = s.status === 'reconnect' || accById(s.account)?.status === 'expired';
        out.push({ id: 'src-' + s.id, icon: 'alert-circle', tone: 'err', title: `${s.name} stopped syncing`, body: s.last?.error || 'Open the source to see what happened.', at: s.last?.at || NOW, to: '/sources', src: s.id, kind: reconnect ? 'reconnect' : 'source', acc: s.account });
      });
      pendingRequests().forEach(r => out.push(accessItem(r)));
      D.kbs.filter(k => !k.archived && !k.personal).forEach(kb => {
        const failed = docsIn(kb.id).filter(d => d.status === 'failed');
        if (failed.length) out.push({ id: 'docs-' + kb.id, icon: 'file-text', tone: 'warn', title: `${plural(failed.length, 'document')} in ${kb.name} couldn’t be published`, body: failed.map(d => d.name).join(', '), at: Math.max(...failed.map(d => d.updated)), to: '/documents?tab=all&life=attention' });
      });
      const gaps = D.gaps.filter(g => !g.dismissed);
      out.push({ id: 'a4', icon: 'sparkles', tone: 'info', title: `Weekly summary: ${fmtNum(D.usage.questions7)} questions, ${plural(gaps.length, 'knowledge gap')}`, body: gaps.length ? `Most asked without a good answer: “${[...gaps].sort((a, b) => b.n - a.n)[0].q}”` : 'Questions people asked and where knowledge fell short.', at: ago(2 * DAY), to: '/overview' });
      if (kbById('kb-eng')) out.push({ id: 'a5', icon: 'users', tone: 'neu', title: 'Tuan Le shared Engineering Runbooks with Engineering', body: 'Engineering · 41 people', at: ago(5 * HOUR), to: '/knowledge/kb-eng' });
    } else {
      D.requests.filter(r => r.user === me().id).forEach(r => {
        const kb = kbById(r.kb)?.name || 'a knowledge base';
        const t = r.status === 'approved' ? { icon: 'check-circle', tone: 'ok', title: `You can now ${r.role === 'editor' ? 'edit' : 'view'} ${kb}`, body: 'Your access request was approved.' }
          : r.status === 'denied' ? { icon: 'x-circle', tone: 'neu', title: `Your request for ${kb} was declined`, body: 'Ask the owner if you still need it.' }
            : { icon: 'clock', tone: 'neu', title: `Your request for ${kb} is waiting for an owner`, body: 'You’ll hear back here when they decide.' };
        out.push({ id: `my-${r.id}-${r.status}`, ...t, at: r.decidedAt || r.at, to: '/knowledge/' + r.kb });
      });
      pendingRequests().filter(r => r.user !== me().id && kbRole(kbById(r.kb)) === 'owner').forEach(r => out.push(accessItem(r)));
      if (docById('d-hr-parental')) out.push({ id: 'm1', icon: 'book', tone: 'info', title: 'Parental Leave Guidelines was updated', body: 'HR Policies · An answer you saw cites it.', at: ago(3 * HOUR), to: '/doc/d-hr-parental' });
      if (kbById('kb-eng')) out.push({ id: 'm2', icon: 'check-circle', tone: 'ok', title: 'You can now view Engineering Runbooks', body: 'Shared with Engineering by Tuan Le.', at: ago(5 * HOUR), to: '/knowledge/kb-eng' });
      if (convById('c9')) out.push({ id: 'm3', icon: 'message', tone: 'neu', title: 'Ben Walker shared a chat with you', body: '“SSO setup steps for customers”', at: ago(2 * DAY), to: '/chats' });
    }
    // Document lifecycle: contributors hear about decisions on their submissions; reviewers about what waits for them.
    out.push(...(X.contribNotices?.() || []), ...(X.reviewNotices?.() || []));
    const work = workItems();
    // An announcement posted with a new quiz says the same thing: keep the actionable quiz item.
    const quizAt = work.filter(i => i.cta === 'Start');
    out.push(...announcementItems().filter(a => !quizAt.some(q => q.space === a.space && Math.abs(q.at - a.at) < HOUR)), ...deadlineItems(), ...work);
    if (hasModule('requests')) out.push(...(X.requestNotices ? X.requestNotices() : requestFallback()), ...slaItem());
    if (isOperator()) out.push({ id: 'o1', icon: 'server', tone: 'warn', title: 'Document processing is slower than usual', body: 'Queue wait is 9 minutes. New documents still process.', at: ago(40 * MIN), to: '/p/health' });
    const seen = new Set();
    return out.filter(i => !S.inbox.dismissed.has(i.id) && !seen.has(i.id) && seen.add(i.id)).sort((a, b) => b.at - a.at);
  }
  const isUnread = i => !S.inbox.read.has(i.id);
  X.inboxUnread = () => items().filter(isUnread).length;

  function inlineAction(i) {
    if (i.kind === 'request') return btn('Deny', { v: 'ghost', size: 'sm', act: 'inbox-deny', data: { id: i.id, req: i.req } }) + btn('Approve', { v: 'secondary', size: 'sm', act: 'inbox-approve', data: { id: i.id, req: i.req } });
    if (i.kind === 'reconnect') return btn('Reconnect', { v: 'secondary', size: 'sm', act: 'inbox-reconnect', data: { id: i.id, acc: i.acc } });
    if (i.cta || i.kind === 'reply') return btn(i.cta || 'Reply', { v: 'secondary', size: 'sm', act: 'inbox-open', data: { id: i.id } });
    return btn('Open', { v: 'tertiary', size: 'sm', act: 'inbox-open', data: { id: i.id }, cls: 'hide-sm' });
  }
  function row(i) {
    return item({
      lead: itemIcon(i.icon || 'bell', TONE[i.tone] ?? ''),
      title: esc(i.title),
      desc: `<span class="truncate inbox-line">${esc(i.body || '')}</span><span class="inbox-time">${esc(i.when || rel(i.at))}</span>`,
      trail: inlineAction(i) + iconBtn('x', 'Dismiss', { size: 'sm', act: 'inbox-dismiss', data: { id: i.id } }),
      act: 'inbox-open', data: { id: i.id }, unread: isUnread(i), cls: 'inbox-item',
    });
  }
  function caughtUpText() {
    const what = [hasModule('spaces') && 'deadlines and announcements', hasModule('requests') && 'request updates', isAdmin() ? 'syncs and access requests' : 'shared knowledge'].filter(Boolean);
    return `${what.join(', ').replace(/^./, c => c.toUpperCase())} show up here.`;
  }

  P.inbox = () => {
    const u = ui('inbox', { tab: 'all' });
    const all = items(), unread = all.filter(isUnread).length;
    const head = pageHeader({ title: 'Inbox', actions: unread ? btn('Mark all read', { v: 'ghost', icon: 'check-check', act: 'inbox-readall' }) : '' });
    const t = `<div class="page-tabs">${tabs([{ id: 'all', label: 'All' }, { id: 'unread', label: 'Unread', count: unread || '' }], u.tab, '/inbox', { variant: 'primary', act: 'inbox-tab' })}</div>`;
    const caughtUp = () => emptyState({ icon: 'check-circle', tone: 'success', title: 'You’re all caught up', desc: esc(caughtUpText()), boxed: true });
    const body = gate({
      loading: () => skelRows(5),
      empty: caughtUp,
      ok: () => {
        const shown = u.tab === 'unread' ? all.filter(isUnread) : all;
        if (!shown.length) return u.tab === 'unread' && all.length
          ? emptyState({ icon: 'check-circle', tone: 'success', title: 'Nothing unread', desc: 'You’ve seen everything.', actions: btn('Show all', { act: 'inbox-tab', data: { value: 'all' } }), boxed: true })
          : caughtUp();
        return list(shown.map(row), 'inbox-list');
      },
    });
    const foot = `<div class="inbox-foot">${linkBtn('Notification settings', { act: 'inbox-prefs', icon: 'settings' })}</div>`;
    return `<div class="page page--narrow">${head}${t}${body}${foot}</div>`;
  };

  const markRead = id => S.inbox.read.add(id);
  const find = id => items().find(i => i.id === id);
  A['inbox-tab'] = el => { ui('inbox').tab = el.dataset.value; refresh(); };
  A['inbox-readall'] = () => { items().forEach(i => markRead(i.id)); refresh(); toast('Marked all as read'); };
  A['inbox-open'] = el => {
    const i = find(el.dataset.id); markRead(el.dataset.id);
    if (!i) return refresh();
    if (i.src && A['src-open']) goThen(i.to, () => A['src-open']({ dataset: { id: i.src } }));
    else go(i.to);
  };
  A['inbox-dismiss'] = el => {
    const id = el.dataset.id; S.inbox.dismissed.add(id); refresh();
    toast('Notification dismissed', { action: { label: 'Undo', run: () => { S.inbox.dismissed.delete(id); refresh(); } } });
  };
  A['inbox-approve'] = el => { markRead(el.dataset.id); if (A['req-approve']) A['req-approve']({ dataset: { id: el.dataset.req } }); else go('/people?tab=requests'); };
  A['inbox-deny'] = el => { markRead(el.dataset.id); if (A['req-deny']) A['req-deny']({ dataset: { id: el.dataset.req } }); else go('/people?tab=requests'); };
  A['inbox-reconnect'] = el => { markRead(el.dataset.id); if (A['acc-reconnect']) A['acc-reconnect']({ dataset: { id: el.dataset.acc } }); else go('/connections'); };
  A['inbox-prefs'] = () => openModal('prefs');
})();

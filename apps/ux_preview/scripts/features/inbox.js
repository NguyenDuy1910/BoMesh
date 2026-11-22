/* Inbox — notifications for every persona, in a popover on the top-row bell (PO.inbox; a bottom sheet on phones), so reading
   them never leaves the page you're on. Items are derived from live data (sources, access requests, documents, spaces, events,
   work and requests, depending on the workspace's modules) plus a few fixed events. Ids are stable so read/dismissed state
   (S.inbox, persisted) sticks. */
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

  /* ── Access requests to a collection (admins: all; owners: their bases) ── */
  function accessItem(r) {
    const kb = kbById(r.kb);
    const who = actorName(r.user), where = kb?.name || 'a collection';
    return { id: 'req-' + r.id, icon: 'user-plus', tone: 'warn', title: r.role === 'editor' ? `${who} requested edit access to ${where}` : `${who} requested view access to ${where}`, body: r.note ? `“${r.note}”` : 'No message.', at: r.at, to: isAdmin() ? '/people?tab=requests' : kbManageHref({ id: r.kb }, 'access'), kind: 'request', req: r.id };
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
      // The event's own title; when it is, in words that fit its kind (a meeting isn't "due").
      const when = { quiz: 'Closes {0}', exam: 'Starts {0}', meeting: 'Starts {0}' }[ev.kind] || 'Due {0}';
      return { id: 'due-' + ev.id, icon: 'calendar', tone: 'warn', title: ev.title, body: sp?.name || '', at: Math.min(t, ev.at - 3 * DAY), due: ev.at, when: when.replace('{0}', relFuture(ev.at)), to, needs: true };
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
        out.push({ id: 'quiz-' + w.id, icon: WORKFLOWS[w.workflow]?.icon || 'list', tone: 'info', title: `New quiz in ${sp.name}: ${w.title}`, body: [plural(n, 'question'), w.data?.timeLimit && `${w.data.timeLimit} min`, w.due && `closes ${fmtDateTime(w.due)}`].filter(Boolean).join(' · '), at: w.published || w.updated, due: w.due, to: '/work/' + w.id, needs: true, quiz: true, space: sp.id });
      }
      const st = w.data?.stats;
      if (w.kind === 'quiz' && w.owner === me().id && w.status === 'published' && st?.attempts > 0) {
        const qs = w.data.questions || [], by = st.byQuestion || [];
        const worst = by.length ? by.indexOf(Math.min(...by)) : -1;
        const avg = `${st.avg}/${qs.length}`, tries = plural(st.attempts, 'attempt');
        const body = worst >= 0 && qs[worst] ? `Average ${avg} from ${tries} · Most missed: “${qs[worst].q}” (${Math.round(by[worst] * 100)}% correct)` : `Average ${avg} from ${tries}`;
        out.push({ id: 'quizres-' + w.id, icon: 'chart', tone: 'ok', title: `Results are in for ${w.title}`, body, at: w.updated, to: '/work/' + w.id });
      }
      if (w.owner === me().id && ['draft', 'changes'].includes(w.status) && sp) {
        const ev = (D.events || []).find(e => e.work === w.id && e.at > now());
        const leadRole = spaceType(sp.type).staff[0];
        const lead = sp.members?.find(m => m.role === leadRole && m.user !== me().id);
        if (ev && lead) out.push({ id: 'wdue-' + w.id, icon: 'pencil', tone: 'neu', title: `${actorName(lead.user)} is waiting for your draft`, body: `${w.title} · ${ev.title} ${fmtDate(ev.at)}`, at: Math.min(now(), w.updated), due: ev.at, to: '/work/' + w.id, needs: true });
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
      out.push({ id: `sr-${r.id}-${r.status}`, icon: answered ? 'message' : t[0], tone: t[1], title: answered ? `${actorName(last.by)} answered your question` : `${type?.name || 'Your request'} ${t[2]}`, body: last?.text || r.id, at: r.updated || r.created, to: '/requests/' + r.id, ...(r.status === 'needs_info' ? { kind: 'reply', needs: true } : {}) });
    });
    queueSpaces().forEach(sp => {
      const fresh = (D.svcRequests || []).filter(r => r.space === sp.id && r.status === 'submitted');
      if (!fresh.length) return;
      const q = fresh.every(r => svcType(r.type)?.question);
      out.push({ id: `srq-${sp.id}-${fresh.map(r => r.id).sort().join('.')}`, icon: q ? 'message' : 'clipboard', tone: 'info', title: `${plural(fresh.length, q ? 'new question' : 'new request')} in ${sp.name}`, body: fresh.slice(0, 3).map(r => `${actorName(r.requester)} · ${svcType(r.type)?.name || r.id}`).join(', '), at: Math.max(...fresh.map(r => r.created)), to: '/requests?tab=queue', needs: true });
    });
    return out;
  }
  /** Requests in the caller's queues that are late, or else due within a day — one summary row (their "new request" notices fold into it). */
  function slaHit() {
    if (!hasModule('requests')) return [];
    const ids = new Set(queueSpaces().map(s => s.id)), t = now();
    const open = (D.svcRequests || []).filter(r => ids.has(r.space) && OPEN_SR.includes(r.status) && r.due);
    const late = open.filter(r => r.due < t);
    return late.length ? late : open.filter(r => r.due >= t && r.due - t <= DAY);
  }
  function slaItem(hit) {
    if (!hit.length) return [];
    const t = now(), late = hit[0].due < t, key = hit.map(r => r.id).sort().join('.');
    return [{
      id: 'sla-' + hashOf(key), icon: 'clock', tone: late ? 'err' : 'warn',
      title: late ? `${plural(hit.length, 'request')} past the response time` : `${plural(hit.length, 'request')} due within a day`,
      body: hit.slice(0, 3).map(r => `${r.id} · ${svcType(r.type)?.name || ''} · ${actorName(r.requester)}`).join(', ') + (hit.length > 3 ? ` and ${hit.length - 3} more` : ''),
      at: late ? Math.max(...hit.map(r => r.due)) : t - 30 * MIN, due: Math.min(...hit.map(r => r.due)), to: '/requests?tab=queue', needs: true,
    }];
  }

  function items() {
    const out = [];
    if (isAdmin()) {
      attentionSources().forEach(s => {
        const reconnect = s.status === 'reconnect' || accById(s.account)?.status === 'expired';
        out.push({ id: 'src-' + s.id, icon: 'alert-circle', tone: 'err', title: `${s.name} stopped syncing`, body: s.last?.error || 'Open the source to see what happened.', at: s.last?.at || NOW, to: studioHref('sources'), src: s.id, kind: reconnect ? 'reconnect' : 'source', acc: s.account });
      });
      pendingRequests().forEach(r => out.push(accessItem(r)));
      D.kbs.filter(k => !k.archived && !k.personal).forEach(kb => {
        const failed = docsIn(kb.id).filter(d => d.status === 'failed');
        if (failed.length) out.push({ id: 'docs-' + kb.id, icon: 'file-text', tone: 'warn', title: `${plural(failed.length, 'document')} in ${kb.name} couldn’t be published`, body: failed.map(d => d.name).join(', '), at: Math.max(...failed.map(d => d.updated)), to: docsHref('processing', { kb: kb.id, state: 'failed' }), needs: true });
      });
      const gaps = D.gaps.filter(g => !g.dismissed);
      out.push({ id: 'a4', icon: 'sparkles', tone: 'info', title: `Weekly summary: ${fmtNum(D.usage.questions7)} questions, ${plural(gaps.length, 'knowledge gap')}`, body: gaps.length ? `Most asked without a good answer: “${[...gaps].sort((a, b) => b.n - a.n)[0].q}”` : 'Questions people asked and where knowledge fell short.', at: ago(2 * DAY), to: '/overview' });
      if (kbById('kb-eng')) out.push({ id: 'a5', icon: 'users', tone: 'neu', title: 'Tuan Le shared Engineering Runbooks with Engineering', body: 'Engineering · 41 people', at: ago(5 * HOUR), to: kbManageHref(kbById('kb-eng'), 'access') });
    } else {
      D.requests.filter(r => r.user === me().id).forEach(r => {
        const kb = kbById(r.kb)?.name || 'a collection';
        const t = r.status === 'approved' ? { icon: 'check-circle', tone: 'ok', title: `You can now ${r.role === 'editor' ? 'edit' : 'view'} ${kb}`, body: 'Your access request was approved.' }
          : r.status === 'denied' ? { icon: 'x-circle', tone: 'neu', title: `Your request for ${kb} was declined`, body: 'Ask the owner if you still need it.' }
            : { icon: 'clock', tone: 'neu', title: `Your request for ${kb} is waiting for an owner`, body: 'You’ll hear back here when they decide.' };
        out.push({ id: `my-${r.id}-${r.status}`, ...t, at: r.decidedAt || r.at, to: kbHref(kbById(r.kb)) });
      });
      pendingRequests().filter(r => r.user !== me().id && kbRole(kbById(r.kb)) === 'owner').forEach(r => out.push(accessItem(r)));
      if (docById('d-hr-parental')) out.push({ id: 'm1', icon: 'book', tone: 'info', title: 'Parental Leave Guidelines was updated', body: 'HR Policies · An answer you saw cites it.', at: ago(3 * HOUR), to: '/doc/d-hr-parental' });
      if (kbById('kb-eng')) out.push({ id: 'm2', icon: 'check-circle', tone: 'ok', title: 'You can now view Engineering Runbooks', body: 'Shared with Engineering by Tuan Le.', at: ago(5 * HOUR), to: kbHref(kbById('kb-eng')) });
      if (convById('c9')) out.push({ id: 'm3', icon: 'message', tone: 'neu', title: 'Ben Walker shared a chat with you', body: '“SSO setup steps for customers”', at: ago(2 * DAY), to: '/s/sh-nw-c9' });
    }
    // Document lifecycle: contributors hear about decisions on their submissions; reviewers about what waits for them; drafts in review.
    out.push(...(X.contribNotices?.() || []), ...(X.reviewNotices?.() || []), ...(X.workNotices?.() || []));
    const work = workItems();
    // An announcement posted with a new quiz says the same thing: keep the actionable quiz item.
    const quizAt = work.filter(i => i.quiz);
    out.push(...announcementItems().filter(a => !quizAt.some(q => q.space === a.space && Math.abs(q.at - a.at) < HOUR)), ...deadlineItems(), ...work);
    if (hasModule('requests')) {
      // One request, one row: a request already in the due/late summary doesn't also get its own "New request" notice.
      const hit = slaHit(), inSla = new Set(hit.map(r => '/requests/' + r.id));
      const staffOpen = n => (D.svcRequests || []).some(r => '/requests/' + r.id === n.to && r.requester !== me().id && OPEN_SR.includes(r.status));
      const notices = (X.requestNotices ? X.requestNotices() : requestFallback()).filter(n => !(inSla.has(n.to) && !n.needs && n.kind !== 'reply')).map(n => (staffOpen(n) ? { ...n, needs: true } : n));
      out.push(...notices, ...slaItem(hit));
    }
    if (isOperator()) out.push({ id: 'o1', icon: 'server', tone: 'warn', title: 'Document processing is slower than usual', body: 'Queue wait is 9 minutes. New documents still process.', at: ago(40 * MIN), to: '/p/health' });
    const seen = new Set();
    return out.filter(i => !S.inbox.dismissed.has(i.id) && !seen.has(i.id) && seen.add(i.id)).sort((a, b) => b.at - a.at);
  }
  const isUnread = i => !S.inbox.read.has(i.id);
  X.inboxUnread = () => items().filter(isUnread).length;
  /** Needs you: a decision or a person waiting on the caller (approve, reconnect, reply, review, a draft, a deadline). */
  const needsYou = i => !!(i.needs || i.cta || ['request', 'reconnect', 'reply', 'source'].includes(i.kind) || i.tone === 'err');

  /** Only in-place decisions get buttons (Approve, Deny, Reconnect); every other row opens by clicking it, with a quiet chevron. */
  function inlineAction(i) {
    if (i.kind === 'request') return btn('Approve', { v: 'secondary', size: 'sm', act: 'inbox-approve', data: { id: i.id, req: i.req } }) + btn('Deny', { v: 'ghost', size: 'sm', act: 'inbox-deny', data: { id: i.id, req: i.req } });
    if (i.kind === 'reconnect') return btn('Reconnect', { v: 'secondary', size: 'sm', act: 'inbox-reconnect', data: { id: i.id, acc: i.acc } });
    return '';
  }
  /** A notification row: the title (up to two lines), one body line, the time, and — for in-place decisions — the buttons under
      the text, so the title keeps the popover's width. */
  function row(i) {
    const decide = inlineAction(i);
    return item({
      lead: itemIcon(i.icon || 'bell', TONE[i.tone] ?? '', 'sm'),
      title: esc(i.title),
      desc: `<span class="truncate inbox-line">${esc(i.body || '')}</span><span class="inbox-time" data-tip="${esc(fmtDateTime(i.due ?? i.at))}">${esc(i.when || rel(i.at))}</span>${decide ? `<span class="inbox-decide">${decide}</span>` : ''}`,
      trail: `<span class="reveal-on-hover">${iconBtn('x', 'Dismiss', { size: 'sm', act: 'inbox-dismiss', data: { id: i.id } })}</span>`,
      act: 'inbox-open', data: { id: i.id }, unread: isUnread(i), cls: 'inbox-item', lines: 2,
    });
  }
  /** One sentence for every workspace and persona (a per-module list read as a stitched-together phrase, especially in Vietnamese). */
  const caughtUpText = () => 'What needs you and updates about your work show up here.';

  /** The bell's popover: Needs you (soonest due, or longest waiting, first), then Updates (newest first). Mark all read and
      Notification settings sit in its footer. Opening a row goes to its object and closes the popover. */
  PO.inbox = () => {
    const all = items(), unread = all.filter(isUnread).length;
    const needs = all.filter(needsYou).sort((a, b) => (a.due == null) - (b.due == null) || (a.due ?? a.at) - (b.due ?? b.at)), updates = all.filter(i => !needsYou(i));
    const group = (label, rows) => `<section class="inbox-pop__group" aria-label="${esc(label)}"><h3 class="inbox-pop__label">${esc(label)}</h3>${list(rows.map(row), 'inbox-list')}</section>`;
    const body = !all.length ? emptyState({ icon: 'check-circle', tone: 'success', title: 'You’re all caught up', desc: esc(caughtUpText()), compact: true })
      : !needs.length ? list(updates.map(row), 'inbox-list')
        : group('Needs you', needs) + (updates.length ? group('Updates', updates) : '');
    const foot = `<span class="grow">${linkBtn('Notification settings', { act: 'inbox-prefs', icon: 'settings' })}</span>${unread ? btn('Mark all read', { v: 'ghost', size: 'sm', icon: 'check-check', act: 'inbox-readall' }) : ''}`;
    return { title: 'Inbox', width: 400, body: `<div class="inbox-pop">${body}</div>`, foot };
  };
  /** Opens the bell's popover from elsewhere (⌘K, Home). */
  A['inbox-show'] = () => { const b = $('#topbar-inbox'); if (b) openPopover(b); };

  const markRead = id => S.inbox.read.add(id);
  const find = id => items().find(i => i.id === id);
  /** After an in-place action the pressed control is gone (the row was decided or dismissed, Mark all read hid itself):
      keep keyboard focus in the popover instead of dropping it to the page. */
  const stayIn = () => { const p = $('#popover'); if (p && !p.contains(document.activeElement)) p.focus({ preventScroll: true }); };
  A['inbox-readall'] = () => { items().forEach(i => markRead(i.id)); refresh(); stayIn(); toast('Marked all as read'); };
  A['inbox-open'] = el => {
    const i = find(el.dataset.id); markRead(el.dataset.id);
    if (!i) return refresh();
    closePopover(false);
    if (i.src && A['src-open']) goThen(i.to, () => A['src-open']({ dataset: { id: i.src } }));
    else go(i.to);
  };
  A['inbox-dismiss'] = el => {
    const id = el.dataset.id; S.inbox.dismissed.add(id); refresh(); stayIn();
    toast('Notification dismissed', { action: { label: 'Undo', run: () => { S.inbox.dismissed.delete(id); refresh(); } } });
  };
  A['inbox-approve'] = el => { markRead(el.dataset.id); if (A['req-approve']) { A['req-approve']({ dataset: { id: el.dataset.req } }); stayIn(); } else go('/people?tab=requests'); };
  A['inbox-deny'] = el => { markRead(el.dataset.id); if (A['req-deny']) { A['req-deny']({ dataset: { id: el.dataset.req } }); stayIn(); } else go('/people?tab=requests'); };
  A['inbox-reconnect'] = el => { markRead(el.dataset.id); closePopover(true); if (A['acc-reconnect']) A['acc-reconnect']({ dataset: { id: el.dataset.acc } }); else go(studioHref('sources')); };
  A['inbox-prefs'] = () => { closePopover(true); openPrefs('notif'); };
})();

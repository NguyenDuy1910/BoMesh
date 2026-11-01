/* Requests (/requests, /requests/new, /requests/:id) — people ask offices and
   teaching teams for things; staff work one queue within an SLA. Before a
   request is sent the assistant checks the rules that apply (each with its
   citation). A staff answer to a course question can become course FAQ
   knowledge. Requests live in D.requestTypes / D.svcRequests (data/ute.js). */
(() => {
  'use strict';

  /* ═══════════════ Vocabulary ═══════════════ */
  STATUS.svc = {
    submitted: ['default', 'Submitted'],
    in_review: ['accent', 'In review'],
    needs_info: ['warning', 'Needs your reply'],
    approved: ['success', 'Approved'],
    declined: ['danger', 'Declined'],
    completed: ['success', 'Done', 'tertiary'],
    withdrawn: ['default', 'Withdrawn'],
  };
  const OPEN = ['submitted', 'in_review', 'needs_info', 'approved'];
  /** Open states where the next step is the staff's (needs_info waits on the requester). */
  const ACTIONABLE = ['submitted', 'in_review', 'approved'];
  /** Thread entry kinds that imply a status (seed data predates explicit `status` on messages). */
  const KIND_STATUS = { needs_info: 'needs_info', answer: 'completed', approved: 'approved', declined: 'declined', completed: 'completed' };

  /* ═══════════════ Data helpers ═══════════════ */
  const all = () => D.svcRequests || [];
  const types = () => D.requestTypes || [];
  const typeById = id => types().find(t => t.id === id);
  const reqById = id => all().find(r => r.id === id);
  const isOpen = r => OPEN.includes(r.status);
  const isQ = r => !!typeById(r.type)?.question;
  const staffOf = r => isSpaceStaff(spaceById(r.space));
  const mine = () => all().filter(r => r.requester === me().id);
  /** Spaces whose requests the caller handles (offices they staff, courses they teach). */
  const staffSpaces = () => (D.spaces || []).filter(s => !s.archived && isSpaceStaff(s) && types().some(t => t.space === s.id));
  function queueAll() { const ids = new Set(staffSpaces().map(s => s.id)); return all().filter(r => ids.has(r.space) && r.requester !== me().id); }
  const overdue = r => ACTIONABLE.includes(r.status) && r.due < Date.now();
  const personaOf = id => Object.values(PERSONAS).find(p => p.id === id);
  const personName = id => memberById(id)?.name || personaOf(id)?.name || 'Someone';
  const firstName = id => personName(id).trim().split(/\s+/).pop();
  const title = r => (isQ(r) ? String(r.fields?.question || '').trim() : '') || typeById(r.type)?.name || 'Request';
  const staffRoles = sp => spaceType(sp?.type).staff;
  const staffMembers = sp => (sp?.members || []).filter(m => staffRoles(sp).includes(m.role));
  const roleLabel = (sp, userId) => { const role = spaceRole(sp, userId); return spaceType(sp?.type).roles.find(([k]) => k === role)?.[1] || ''; };
  const fmtDay = ts => new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const span = ms => ms < HOUR - MIN / 2 ? plural(Math.max(1, Math.round(ms / MIN)), 'min', 'min') : Math.round(ms / HOUR) < 24 ? Math.round(ms / HOUR) + ' h' : plural(Math.round(ms / DAY), 'day');
  /** rel() for use mid-sentence ("Updated just now", "closed yesterday"). */
  const relIn = ts => { const s = rel(ts); return /^(Just now|Yesterday)$/.test(s) ? s.toLowerCase() : s; };
  const slaUsual = t => t.sla <= 1 ? 'Usually the next working day' : `Usually ${t.sla} working days`;
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); if (s.length <= n) return s; const cut = s.slice(0, n); return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 12)).replace(/[\s,;:.–—-]+$/, '') + '…'; };
  /** "Ask the teaching team" vs "Ask the office", by space type. */
  /** Copy can speak of offices and teaching teams only where those space types exist. */
  const campusy = () => spaceTypeIds().some(t => t === 'office' || t === 'course');
  const teamWord = sp => sp?.type === 'course' ? 'the teaching team' : sp?.type === 'office' ? 'the office' : 'the team';

  /** Colored space tile — Home owns X.spaceMark; this is the fallback while it loads. */
  const mark = (sp, size = 32) => X.spaceMark?.(sp, size) || `<span class="rq-mark" style="--rq-c:${esc(sp?.color || '#4F5865')};width:${size}px;height:${size}px" aria-hidden="true">${ic(spaceType(sp?.type).icon, size < 32 ? 'i-sm' : '')}</span>`;

  /** Course label for a stored course code. */
  function courseLabel(code, requester) {
    const c = (personaOf(requester)?.profile?.courses || PERSONAS.student?.profile?.courses || []).find(x => x[0] === code);
    if (c) return `${c[0]} · ${c[1]}`;
    const sp = (D.spaces || []).find(s => s.code === code);
    return sp ? `${sp.code} · ${sp.name}` : String(code ?? '');
  }
  /** Courses the caller can pick in a request: their study plan, else the course spaces they attend. */
  function courseOptions() {
    const p = me().profile;
    if (p?.courses?.length) return p.courses.map(([code, name, cr]) => [code, `${code} · ${name} (${plural(cr, 'credit')})`]);
    return mySpaces().filter(s => s.type === 'course' && !isSpaceStaff(s) && s.code).map(s => [s.code, `${s.code} · ${s.name}`]);
  }
  function fmtField(fd, v, r) {
    if (v == null || v === '') return '<span class="muted">—</span>';
    if (fd.type === 'course') return esc(courseLabel(v, r.requester));
    return esc(String(v)).replace(/\n/g, '<br>');
  }

  /* ═══════════════ Status, SLA, list row ═══════════════ */
  /** Status chip as the viewer should read it (requester vs staff wording). */
  function requestStatus(r) {
    if (r.status === 'needs_info' && r.requester !== me().id) return chip(['course', 'office'].includes(spaceById(r.space)?.type) ? 'Waiting for student' : 'Waiting for reply', { tone: 'warning', dot: true });
    if (r.status === 'completed' && isQ(r)) return chip('Answered', { tone: 'success', variant: 'tertiary', dot: true });
    return status('svc', r.status);
  }
  /** A status change inside the thread, in past tense (history must not say "Needs your reply" once answered). */
  function stepChip(r, st) {
    const label = { submitted: 'Submitted', in_review: 'In review', needs_info: 'Asked for information', approved: 'Approved', declined: 'Declined', completed: isQ(r) ? 'Answered' : 'Completed', withdrawn: 'Withdrawn' }[st];
    const [tone] = STATUS.svc[st] || ['default'];
    return label ? chip(label, { tone, size: 'sm' }) : '';
  }
  /** SLA for staff: due in / overdue / paused while waiting for the requester. */
  function sla(r) {
    if (!isOpen(r)) return { text: 'Closed ' + relIn(r.updated), tone: 'muted' };
    if (r.status === 'needs_info') return { text: 'Paused', tone: 'muted', tip: 'The clock stops while you wait for the student' };
    const d = r.due - Date.now();
    if (d < 0) return { text: 'Overdue ' + span(-d), tone: 'danger' };
    return { text: 'Due in ' + span(d), tone: d < DAY ? 'warning' : '' };
  }
  const slaHtml = r => { const s = sla(r); return `<span class="${cx('rq-sla', s.tone && 'rq-sla--' + s.tone)}" ${s.tip ? `data-tip="${esc(s.tip)}"` : ''}>${s.tone === 'danger' ? ic('clock', 'i-sm') : ''}${esc(s.text)}</span>`; };

  /** One request as a list row (My requests, Home, Spaces). */
  function requestItem(r) {
    const t = typeById(r.type), sp = spaceById(r.space), mineR = r.requester === me().id;
    const needs = mineR && r.status === 'needs_info';
    const desc = [!mineR && personName(r.requester), isQ(r) ? `Question · ${sp?.name || ''}` : sp?.name, `Updated ${relIn(r.updated)}`].filter(Boolean).map(esc).join(' · ');
    return item({
      lead: itemIcon(t?.icon || 'clipboard', needs ? 'warning' : isOpen(r) ? 'accent' : ''),
      title: esc(title(r)), desc, trail: requestStatus(r),
      href: '/requests/' + r.id, unread: needs, cls: 'rq-item',
    });
  }

  /* ═══════════════ Mutations ═══════════════ */
  function audit(action, r, target) {
    (D.audit ||= []).unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Requests', target: target || `${typeById(r.type)?.name || 'Request'} — ${personName(r.requester)}`, outcome: 'success', ip: '10.20.4.12', device: 'Chrome on macOS' });
  }
  function nextId() { const n = Math.max(2000, ...all().map(r => parseInt(String(r.id).replace(/\D/g, ''), 10) || 0)); return 'SR-' + (n + 1); }
  function create(t, fields, extra = {}) {
    const now = Date.now();
    const r = { id: nextId(), type: t.id, space: t.space, requester: me().id, status: 'submitted', created: now, updated: now, lastBy: me().id, fields,
      thread: [{ id: uid('m'), by: me().id, at: now, text: 'Submitted.', kind: 'status' }], assignee: null, due: now + (t.sla || 3) * DAY, ...(t.fee ? { fee: t.fee } : {}), ...extra };
    if (!D.svcRequests) D.svcRequests = [];
    D.svcRequests.unshift(r);
    audit(t.question ? 'Asked a question' : 'Sent a request', r);
    return r;
  }
  /** Append to the thread, optionally changing status. Staff who act on an unassigned request take it. */
  function post(r, text, kind, { status: st, extra } = {}) {
    const m = { id: uid('m'), by: me().id, at: Date.now(), text, kind, ...extra };
    if (st && st !== r.status) { m.status = st; r.status = st; }
    if (!r.assignee && r.requester !== me().id && staffOf(r)) r.assignee = me().id;
    r.thread.push(m); r.updated = m.at; r.lastBy = me().id;
    return m;
  }
  const snap = r => ({ status: r.status, n: r.thread.length, updated: r.updated, lastBy: r.lastBy, assignee: r.assignee });
  const undoTo = (r, s) => () => { Object.assign(r, { status: s.status, updated: s.updated, lastBy: s.lastBy, assignee: s.assignee }); r.thread.length = s.n; refresh(); toast('Undone', { tone: 'accent' }); };
  const cKey = r => `rqc_${me().id}_${r.id}`;   // drafts belong to the person writing them
  const composerState = r => ui(cKey(r), { text: '', err: '', faq: true, files: [] });
  const clearComposer = r => Object.assign(composerState(r), { text: '', err: '', files: [] });

  function assign(r, userId, { quiet } = {}) {
    if (r.assignee === userId) return;
    const s = snap(r);
    const text = userId === me().id ? 'took this request' : userId ? `assigned this to ${personName(userId)}` : 'unassigned this request';
    r.assignee = userId;
    const m = { id: uid('m'), by: me().id, at: Date.now(), text, kind: 'event' };
    if (userId && r.status === 'submitted') { r.status = 'in_review'; m.status = 'in_review'; }
    r.thread.push(m); r.updated = m.at; r.lastBy = me().id;
    audit(userId ? 'Assigned a request' : 'Unassigned a request', r);
    if (!quiet) { refresh(); toast(userId === me().id ? 'Assigned to you' : userId ? `Assigned to ${personName(userId)}` : 'Unassigned', { action: { label: 'Undo', run: undoTo(r, s) } }); }
  }

  /* ── Course FAQ from a staff answer ── */
  const STOP = new Set(['the', 'and', 'for', 'can', 'are', 'was', 'with', 'this', 'that', 'what', 'how', 'does', 'will', 'from', 'into', 'our', 'you', 'your', 'must', 'about', 'when', 'which', 'also', 'use']);
  const words = s => (String(s).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) || []).filter(w => w.length >= 3 && !STOP.has(w));
  /** Does a knowledge-gap question ask the same thing as q? (most of its key words appear in q) */
  function similar(gapQ, q) { const g = words(gapQ), set = new Set(words(q)); return g.length > 0 && g.filter(w => set.has(w)).length / g.length >= 0.6; }
  function addToFaq(r, answer) {
    const sp = spaceById(r.space);
    const kb = (sp?.kbs || []).map(kbById).find(k => k && !k.archived && canEditKb(k)) || kbById(sp?.kbs?.[0]);
    if (!kb) return {};
    const q = String(r.fields?.question || '').trim();
    const name = 'FAQ — ' + fileNameSafe(clip(q.replace(/[?.!\s]+$/, ''), 72)) + '.md';
    const doc = mkDoc(kb.id, uid('du-faq'), name, { addedBy: me().name, updated: Date.now(), status: 'ready', pages: 1, size: 900 + answer.length * 2, passages: 2 });
    doc.faq = { q, a: answer, req: r.id };
    D.docs.unshift(doc); kb.updated = Date.now();
    const gi = (D.gaps || []).findIndex(g => g.kb === kb.id && similar(g.q, q));
    const gap = gi >= 0 ? D.gaps.splice(gi, 1)[0] : null;
    audit('Added a document', r, `${name} · ${kb.name}`);
    return { doc, gap, kb };
  }
  const faqLink = (docId, answer) => `/doc/${docId}?q=${encodeURIComponent(answer)}&page=1`;

  /* ═══════════════ Inbox notices (merged by inbox.js) ═══════════════ */
  /** Ids carry the viewer so read state stays per persona; a new thread entry makes a new (unread) notice. */
  const noticeId = (r, i, userId = me().id) => `sr-${r.id}-${i}-${userId}`;
  function markSeen(r) { r.thread.forEach((_, i) => S.inbox.read.add(noticeId(r, i))); }
  X.requestNotices = () => {
    if (!hasModule('requests')) return [];
    const out = [], uid_ = me().id;
    all().forEach(r => {
      const t = typeById(r.type) || { name: 'Request' }, sp = spaceById(r.space);
      if (r.requester === uid_) {
        // Latest thing someone else did that the requester should hear about.
        let i = r.thread.length - 1;
        while (i >= 0 && (r.thread[i].by === uid_ || (r.thread[i].kind === 'event' && !r.thread[i].status))) i--;
        if (i < 0) return;
        const m = r.thread[i], who = personName(m.by);
        const st = m.status || KIND_STATUS[m.kind] || (i === r.thread.length - 1 ? r.status : null);
        const base = { id: noticeId(r, i), at: m.at, to: '/requests/' + r.id, body: m.kind === 'event' ? title(r) : clip(m.text, 160) || plural(m.files?.length || 0, 'file') + ' attached' };
        const n = st === 'needs_info' ? { icon: 'message', tone: 'warn', title: `${sp?.name || 'The office'} needs more information`, kind: 'reply', req: r.id }
          : st === 'approved' ? { icon: 'check-circle', tone: 'ok', title: `${t.name} approved` }
            : st === 'declined' ? { icon: 'x-circle', tone: 'err', title: `${t.name} was declined` }
              : st === 'completed' ? (t.question ? { icon: 'message', tone: 'ok', title: `${capital(teamWord(sp))} answered your question` } : { icon: 'check-circle', tone: 'ok', title: `${t.name} is done` })
                : st === 'in_review' && m.kind === 'event' ? { icon: 'clock', tone: 'info', title: `${who} is reviewing your request` }
                  : { icon: 'message', tone: 'info', title: `${who} replied about ${t.question ? 'your question' : t.name}` };
        out.push({ ...base, ...n });
        return;
      }
      if (!staffOf(r)) return;
      const i = r.thread.length - 1, m = r.thread[i];
      if (!m || m.by !== r.requester) return;
      const who = personName(r.requester);
      const base = { id: noticeId(r, i), at: m.at, to: '/requests/' + r.id };
      if (r.status === 'withdrawn') out.push({ ...base, icon: 'undo', tone: 'neu', title: `${who} withdrew ${t.question ? 'a question' : t.name}`, body: title(r) });
      else if (!isOpen(r)) return;
      else if (m.kind === 'status' && m.text === 'Submitted.') out.push({ ...base, icon: t.question ? 'message' : 'clipboard', tone: 'info', title: t.question ? `New question in ${sp?.name || 'your course'}` : `New request: ${t.name}`, body: t.question ? clip(title(r), 160) : `${who} · ${sp?.name || ''}` });
      else out.push({ ...base, icon: 'message', tone: 'info', title: `${who} replied about ${t.question ? 'their question' : t.name}`, body: clip(m.text, 160) || plural(m.files?.length || 0, 'file') + ' attached' });
    });
    return out;
  };
  const capital = s => s.charAt(0).toUpperCase() + s.slice(1);

  /* ═══════════════ Exports ═══════════════ */
  X.requestStatus = requestStatus;
  X.requestItem = requestItem;
  X.requestTitle = title;
  /** Badge: staff — open items waiting on them in their queues; requester — items needing their reply. */
  X.requestsBadge = () => hasModule('requests') ? queueAll().filter(r => ACTIONABLE.includes(r.status)).length + mine().filter(r => r.status === 'needs_info').length : 0;
  /** Open requests of a space, for its staff (soonest due first). Members get []. */
  X.queueFor = spaceId => { const sp = spaceById(spaceId); if (!isSpaceStaff(sp)) return []; return all().filter(r => r.space === spaceId && isOpen(r) && r.requester !== me().id).sort(byDue); };
  function byDue(a, b) { return (a.status === 'needs_info') - (b.status === 'needs_info') || a.due - b.due; }

  /* ═══════════════ /requests ═══════════════ */
  P.requests = ({ query }) => {
    const hasQueue = staffSpaces().length > 0;
    const myRows = mine();
    const tab = hasQueue ? (['mine', 'queue'].includes(query.tab) ? query.tab : myRows.length ? 'mine' : 'queue') : 'mine';
    const q = hasQueue ? queueAll() : [];
    const head = pageHeader({ title: 'Requests', actions: btn('New request', { v: 'primary', icon: 'plus', href: '/requests/new' }) });
    const tb = hasQueue ? `<div class="page-tabs">${tabs([
      { id: 'mine', label: 'My requests', count: myRows.filter(isOpen).length || '' },
      { id: 'queue', label: 'Queue', count: q.filter(r => ACTIONABLE.includes(r.status)).length || '', alert: q.some(overdue) },
    ], tab, '/requests')}</div>` : '';
    return `<div class="page rq-page">${head}${tb}${tab === 'queue' ? queueView(q) : mineView(myRows)}</div>`;
  };

  function mineView(rows) {
    const empty = () => emptyState({ icon: 'clipboard', boxed: true, title: 'No requests yet', desc: campusy() ? 'Withdraw from a course, get a transcript or ask a teaching team. The assistant checks the rules before you send.' : 'Ask a team for something they handle. The assistant checks the rules before you send.', actions: btn('New request', { v: 'primary', icon: 'plus', href: '/requests/new' }) });
    return gate({
      loading: () => skelRows(4), empty,
      ok: () => {
        if (!rows.length) return empty();
        const by = (a, b) => b.updated - a.updated;
        const reply = rows.filter(r => r.status === 'needs_info').sort(by);
        const open = rows.filter(r => isOpen(r) && r.status !== 'needs_info').sort(by);
        const closed = rows.filter(r => !isOpen(r)).sort(by);
        return [
          reply.length && section('Needs your reply', list(reply.map(requestItem), 'rq-list rq-list--attn')),
          open.length && section('In progress', list(open.map(requestItem), 'rq-list')),
          closed.length && section('Closed', list(closed.map(requestItem), 'rq-list')),
        ].filter(Boolean).join('');
      },
    });
  }

  const OPEN_STATUS_OPTS = [['submitted', 'Submitted'], ['in_review', 'In review'], ['needs_info', 'Waiting for student'], ['approved', 'Approved']];
  const DONE_STATUS_OPTS = [['completed', 'Done'], ['declined', 'Declined'], ['withdrawn', 'Withdrawn']];
  function queueView(q) {
    const u = ui('rqQ', { view: 'open', sel: {} });
    const spaces = staffSpaces(), live = !S.navLoading && S.pageState === 'live';
    const inView = q.filter(r => (u.view === 'done' ? !isOpen(r) : isOpen(r)));
    const filtered = inView.filter(r => (!u.space || r.space === u.space) && (!u.status || r.status === u.status) && (!u.type || r.type === u.type)
      && matchesQ('rqQ', title(r), personName(r.requester), memberById(r.requester)?.email, r.id, typeById(r.type)?.name));
    const rows = u.sort ? applySort(filtered, 'rqQ', { name: r => personName(r.requester).toLowerCase(), created: r => r.created, due: r => r.due })
      : [...filtered].sort(u.view === 'done' ? (a, b) => b.updated - a.updated : byDue);
    const typeOpts = types().filter(t => spaces.some(s => s.id === t.space)).map(t => [t.id, t.question ? `${t.name} · ${spaceById(t.space)?.code || spaceById(t.space)?.name}` : t.name]);
    const counts = { open: q.filter(isOpen).length, done: q.length - q.filter(isOpen).length };
    const toolbar = `<div class="toolbar">${seg({ value: u.view, options: [['open', `Open · ${counts.open}`], ['done', `Done · ${counts.done}`]], act: 'rq-q-view', label: 'Show' })}
      ${searchField({ uiKey: 'rqQ', placeholder: 'Search by student, ID or request' })}
      ${spaces.length > 1 ? filterButton('Space', 'rqQ', 'space', spaces.map(s => [s.id, s.name])) : ''}
      ${filterButton('Status', 'rqQ', 'status', u.view === 'done' ? DONE_STATUS_OPTS : OPEN_STATUS_OPTS)}
      ${typeOpts.length > 1 ? filterButton('Type', 'rqQ', 'type', typeOpts) : ''}
      ${clearFilters('rqQ', ['space', 'status', 'type'])}
      ${live ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'request')}</span>` : ''}</div>`;
    const empty = () => u.view === 'done'
      ? emptyState({ icon: 'archive', boxed: true, title: 'Nothing closed yet', desc: 'Requests you approve, decline or answer move here.' })
      : emptyState({ icon: 'check-circle', tone: 'success', boxed: true, title: 'Your queue is clear', desc: campusy() ? 'New requests and student questions for your spaces show up here.' : 'New requests for your spaces show up here.' });
    return toolbar + gate({
      empty,
      ok: () => {
        if (!inView.length) return empty();
        if (!rows.length) return noMatches('rqQ', ['space', 'status', 'type'], 'requests');
        const page = paginate(rows, 'rqQ', 20), ids = page.filter(isOpen).map(r => r.id);
        const head = (ids.length ? selAllCheck('rqQ', ids) : th('', 'table__column--check')) + sortHead('Requester', 'name', 'rqQ') + th('Request') + sortHead('Submitted', 'created', 'rqQ', 'table__column--hide-sm') + sortHead(u.view === 'done' ? 'Closed' : 'SLA', 'due', 'rqQ') + th('Status') + th('Assignee', 'hide-md');
        const trs = page.map(r => {
          const t = typeById(r.type), sp = spaceById(r.space), m = memberById(r.requester), sid = /^\d+@/.test(m?.email || '') ? m.email.split('@')[0] : (m?.email || '');
          return `<tr class="${cx('table__row', overdue(r) && 'rq-row--over')}" data-act="rq-open" data-id="${r.id}" tabindex="0" ${u.sel?.[r.id] ? 'aria-selected="true"' : ''}>
            ${isOpen(r) ? selCheck('rqQ', r.id, 'Select ' + r.id) : '<td class="table__cell table__cell--check"></td>'}
            <td class="table__cell"><span class="row gap-12">${avatar(personName(r.requester), 'sm')}<span class="stack" style="min-width:0"><span class="cell-title truncate">${esc(personName(r.requester))}</span><span class="cell-sub truncate num">${esc(sid)}</span></span></span></td>
            <td class="table__cell table__cell--primary"><span class="stack rq-cell-req"><span class="cell-title rq-clamp">${esc(title(r))}</span><span class="cell-sub truncate">${esc(t?.question ? `Question · ${sp?.name || ''}` : `${spaces1(spaces, sp)}${r.id}`)}</span></span></td>
            <td class="table__cell table__cell--hide-sm muted"><span class="rq-nowrap">${esc(rel(r.created))}</span></td>
            <td class="table__cell">${slaHtml(r)}</td>
            <td class="table__cell">${requestStatus(r)}</td>
            <td class="table__cell hide-md table__cell--hide-sm">${r.assignee ? `<span class="row gap-6">${avatar(personName(r.assignee), 'xs')}<span class="truncate">${esc(r.assignee === me().id ? 'You' : firstName(r.assignee))}</span></span>` : '<span class="muted">Unassigned</span>'}</td></tr>`;
        });
        const bulk = bulkBar('rqQ', btn('Assign to me', { v: 'ghost', size: 'sm', icon: 'user', act: 'rq-bulk-assign' }));
        return table({ head, rows: trs, label: 'Request queue' }) + pager(rows.length, 'rqQ', 20) + bulk;
      },
    });
  }
  /** Space name prefix in the queue only when the caller staffs several spaces. */
  const spaces1 = (spaces, sp) => spaces.length > 1 && sp ? sp.name + ' · ' : '';

  A['rq-q-view'] = el => { const u = ui('rqQ'); u.view = el.dataset.value; u.status = ''; u.sel = {}; u.page = 1; refresh(); };
  A['rq-open'] = el => go('/requests/' + el.dataset.id);
  A['rq-bulk-assign'] = () => {
    const rs = selIds('rqQ').map(reqById).filter(r => r && isOpen(r) && r.assignee !== me().id);
    ui('rqQ').sel = {};
    if (!rs.length) { refresh(); toast('These are already yours', { tone: 'accent' }); return; }
    const snaps = rs.map(r => [r, snap(r)]);
    rs.forEach(r => assign(r, me().id, { quiet: true }));
    refresh();
    toast(`${plural(rs.length, 'request')} assigned to you`, { action: { label: 'Undo', run: () => { snaps.forEach(([r, s]) => { Object.assign(r, { status: s.status, updated: s.updated, lastBy: s.lastBy, assignee: s.assignee }); r.thread.length = s.n; }); refresh(); } } });
  };

  /* ═══════════════ /requests/new — catalog ═══════════════ */
  function catalogGroups() {
    const svc = visibleSpaces().map(sp => ({ sp, list: types().filter(t => t.space === sp.id && !t.question) })).filter(g => g.list.length)
      .sort((a, b) => (a.sp.type !== 'office') - (b.sp.type !== 'office') || a.sp.name.localeCompare(b.sp.name));
    const qs = mySpaces().filter(sp => !isSpaceStaff(sp)).map(sp => ({ sp, list: types().filter(t => t.space === sp.id && t.question && !t.auto) })).filter(g => g.list.length);
    return [...svc, ...qs];
  }
  function catalog() {
    crumbs([{ label: 'Requests', to: '/requests' }, { label: 'New request' }]);
    const groups = catalogGroups();
    const shown = groups.map(g => ({ sp: g.sp, list: g.list.filter(t => matchesQ('rqCat', t.name, t.desc, g.sp.name, g.sp.code)) })).filter(g => g.list.length);
    const head = pageHeader({ title: 'New request', desc: campusy() ? 'Ask an office or your teaching team. The assistant checks the rules before you send.' : 'Ask a team for something they handle. The assistant checks the rules before you send.' });
    const empty = () => emptyState({ icon: 'clipboard', boxed: true, title: 'No one takes requests here yet', desc: isAdmin() ? 'Offices and teams add request types in their space settings.' : 'When an office or team starts taking requests, you’ll find them here.', actions: btn('Back to requests', { href: '/requests' }) });
    const body = gate({
      loading: () => skelRows(6), empty,
      ok: () => {
        if (!groups.length) return empty();
        if (!shown.length) return noMatches('rqCat', [], 'request types');
        return shown.map(({ sp, list: ts }) => `<section class="rq-group"><div class="rq-group__head">${mark(sp, 32)}<div class="grow" style="min-width:0"><h2 class="section__title truncate">${esc(sp.name)}</h2><p class="t-xs muted truncate">${esc(sp.type === 'course' ? [sp.code, 'Your course'].filter(Boolean).join(' · ') : sp.schedule || sp.desc || '')}</p></div></div>
          ${list(ts.map(t => item({
            lead: itemIcon(t.icon || 'clipboard', t.question ? 'accent' : ''),
            title: esc(t.name),
            desc: `<span class="rq-cat-desc">${esc(t.desc || '')}</span><span class="rq-cat-meta">${ic('clock', 'i-sm')}${esc(slaUsual(t))}${t.fee ? ` · ${esc(t.fee)}` : ''}</span>`,
            trail: ic('chevron-right', 'muted'),
            href: `/requests/new?type=${t.id}`,
          })))}</section>`).join('');
      },
    });
    return `<div class="page page--narrow rq-page">${head}<div class="toolbar">${searchField({ uiKey: 'rqCat', placeholder: 'Search requests and offices' })}</div>${body}</div>`;
  }

  /* ═══════════════ /requests/new?type= — check rules, fill in, send ═══════════════ */
  /** Evaluate one rule against the caller's profile and the form so far. */
  function runCheck(c, vals) {
    const p = me().profile, now = Date.now();
    const base = { id: c.id, label: c.label, cite: c.cite || null };
    switch (c.rule) {
      case 'before': {
        const left = c.at - now;
        return left > 0 ? { ...base, state: 'pass', detail: `${capital(span(left))} left to send it` }
          : { ...base, state: 'fail', detail: `The deadline passed ${rel(c.at).toLowerCase()}.`, consequence: 'The office can’t accept this request after the deadline. Ask them whether an exception applies to you.' };
      }
      case 'minCredits': {
        if (!p) return { ...base, state: 'info', detail: 'The office checks this for you.' };
        const course = (p.courses || []).find(x => x[0] === vals.course);
        if (!course) return { ...base, state: 'wait', detail: 'Choose a course below to check this.' };
        const after = p.credits - course[2];
        return after >= c.min ? { ...base, state: 'pass', detail: `${p.credits} → ${after} credits after dropping ${course[0]}` }
          : { ...base, state: 'warn', detail: `${p.credits} → ${after} credits after dropping ${course[0]}, below the minimum of ${c.min}.`, consequence: 'You can still send it: the office forwards it to the Faculty for approval, so it may take longer.' };
      }
      case 'minYear':
        if (!p) return { ...base, state: 'info', detail: 'The office checks this for you.' };
        return p.year >= c.min ? { ...base, state: 'pass', detail: `You’re in year ${p.year} (${p.cohort || 'current cohort'})` }
          : { ...base, state: 'fail', detail: 'You haven’t completed a semester yet.', consequence: 'This request is only possible after your first semester.' };
      case 'minGpa':
        if (!p) return { ...base, state: 'info', detail: 'The office checks this for you.' };
        return p.gpa >= c.min ? { ...base, state: 'pass', detail: `Your GPA is ${p.gpa.toFixed(2)}` }
          : { ...base, state: 'fail', detail: `Your GPA is ${p.gpa.toFixed(2)}, below ${c.min}.`, consequence: 'An application below the minimum isn’t accepted.' };
      default: return { ...base, state: 'info', detail: '' };
    }
  }
  const CHECK_UI = { pass: ['check-circle', 'Met'], warn: ['alert', 'Needs attention'], fail: ['x-circle', 'Not met'], info: ['info', 'Good to know'], wait: ['circle-dashed', 'Not checked yet'] };
  function citeBtn(c, n) {
    const d = docById(c.doc);
    return `<button type="button" class="cite" data-act="rq-quote" ${dataAttrs({ doc: c.doc, page: c.page, q: c.quote })} aria-label="Source ${n}: ${esc(d?.name || 'regulation')}${c.page ? ', page ' + c.page : ''}">${n}</button>`;
  }
  function checkLines(results) {
    let n = 0;
    return `<ul class="rq-checks">${results.map(c => {
      const [icon, label] = CHECK_UI[c.state] || CHECK_UI.info;
      return `<li class="rq-check rq-check--${c.state}"><span class="rq-check__icon">${ic(icon)}<span class="sr-only">${label}:</span></span><div class="rq-check__body"><div class="rq-check__label">${esc(c.label)}${c.cite ? citeBtn(c.cite, ++n) : ''}</div>${c.detail ? `<div class="rq-check__detail">${esc(c.detail)}</div>` : ''}${c.consequence ? `<div class="rq-check__note">${esc(c.consequence)}</div>` : ''}</div></li>`;
    }).join('')}</ul>`;
  }

  function formState(t, query) {
    const key = [t.id, query.course, query.space, query.q].map(x => x || '').join('|');
    let f = S.ui.rqNew;
    if (f && f.key === key) return f;
    f = S.ui.rqNew = { key, type: t.id, vals: {}, errs: {}, phase: t.checks?.length ? 'checking' : 'done', conv: query.conv || '' };
    const courseCodes = courseOptions().map(o => o[0]);
    const fromSpace = spaceById(query.space)?.type === 'course' ? spaceById(query.space).code : '';
    t.fields.forEach(fd => {
      let v = ['type', 'space', 'conv', 'q'].includes(fd.id) ? '' : String(query[fd.id] ?? '');
      if (fd.type === 'select' && !fd.options.includes(v)) v = '';
      if (fd.type === 'course') { v = query.course || fromSpace || ''; if (!courseCodes.includes(v)) v = ''; }
      if (fd.id === 'question' && !v) v = query.q || '';
      if (fd.type === 'number' && !v) v = String(fd.min || 1);
      f.vals[fd.id] = v;
    });
    return f;
  }
  function validate(t, vals) {
    const e = {};
    t.fields.forEach(fd => {
      const v = String(vals[fd.id] ?? '').trim();
      if (fd.required && !v) e[fd.id] = fd.type === 'course' ? 'Choose a course.' : fd.type === 'select' ? 'Choose an option.' : fd.id === 'reason' ? 'Add a reason. A sentence is enough.' : fd.id === 'question' ? 'Write your question.' : 'This field is required.';
      else if (fd.type === 'number' && v) {
        const n = Number(v);
        if (!Number.isInteger(n) || (fd.min != null && n < fd.min) || (fd.max != null && n > fd.max)) e[fd.id] = `Enter a whole number from ${fd.min ?? 0} to ${fd.max ?? 99}.`;
      }
    });
    return e;
  }
  function fieldControl(fd, f) {
    const id = 'rq-f-' + fd.id, bind = 'rqNew.vals.' + fd.id, v = f.vals[fd.id] ?? '', invalid = !!f.errs[fd.id];
    const aria = invalid ? `aria-invalid="true" aria-describedby="${id}-err"` : '';
    if (fd.type === 'course') return select({ id, bind, value: v, change: 'rq-new-change', options: [['', 'Choose a course'], ...courseOptions()], attrs: aria });
    if (fd.type === 'select') return select({ id, bind, value: v, change: 'rq-new-change', options: [['', 'Choose…'], ...fd.options.map(o => [o, o])], attrs: aria });
    if (fd.type === 'number') return input({ id, bind, value: v, type: 'number', attrs: `min="${fd.min ?? 0}" max="${fd.max ?? 99}" inputmode="numeric" style="max-width:140px" data-input="rq-new-input"`, invalid });
    if (fd.type === 'textarea') return textarea({ id, bind, value: v, rows: fd.id === 'question' ? 5 : 3, placeholder: fd.placeholder || '', invalid, attrs: 'data-input="rq-new-input"' });
    return input({ id, bind, value: v, placeholder: fd.placeholder || '', invalid, attrs: 'data-input="rq-new-input"' });
  }

  function newForm(t, query) {
    const sp = spaceById(t.space);
    crumbs([{ label: 'Requests', to: '/requests' }, { label: 'New request', to: '/requests/new' }, { label: t.name }]);
    const f = formState(t, query);
    const checks = t.checks || [];
    const results = f.phase === 'done' ? checks.map(c => runCheck(c, f.vals)) : [];
    const failing = results.filter(c => c.state === 'fail');
    const head = pageHeader({ lead: mark(sp, 40), title: t.name, desc: esc([sp?.name, slaUsual(t)].filter(Boolean).join(' · ')) });

    let checkCard = '';
    if (checks.length) {
      const body = f.phase !== 'done'
        ? `<div class="rq-checking" role="status">${spinner()}<span>Checking regulations…</span></div><div class="stack gap-12 mt-4" aria-hidden="true">${checks.map((_, i) => `<span class="skeleton skeleton--line" style="width:${[78, 62, 70][i % 3]}%"></span>`).join('')}</div>`
        : checkLines(results) + (failing.length ? `<div class="mt-12">${alertBox('danger', 'You can’t send this request', `${capital(teamWord(sp))} can still tell you what’s possible, for example whether an exception applies.`, btn(`Ask ${teamWord(sp)} instead`, { v: 'secondary', size: 'sm', icon: 'message', act: 'rq-ask-instead', data: { type: t.id } }))}</div>` : '');
      checkCard = card(body, { title: 'Before you send', desc: f.phase === 'done' ? 'The assistant checked the rules that apply to you. Select a number to read the source.' : '', icon: itemIcon('shield-check', 'accent', 'sm'), cls: 'rq-checkcard' });
    }

    const fields = t.fields.map(fd => field({ id: 'rq-f-' + fd.id, label: fd.label, required: fd.required, error: f.errs[fd.id], control: fieldControl(fd, f) })).join('');
    const summary = `<div class="rq-summary">${kv([['Sent to', esc(sp?.name || '—')], ['Usually takes', esc(slaUsual(t).replace(/^Usually /, ''))], ['Fee', esc(t.fee || 'Free')]])}</div>`;
    const conv = f.conv && myConvs().some(c => c.id === f.conv) ? convById(f.conv) : null;
    const foot = `<div class="rq-form__foot">${btn('Cancel', { v: 'tertiary', href: '/requests/new' })}${btn(t.question ? 'Send question' : 'Send request', { v: 'primary', icon: 'send', act: 'rq-send', disabled: f.phase !== 'done' || failing.length > 0, loading: f.sending, id: 'rq-send' })}</div>`;
    const formCard = card(`${t.desc ? `<p class="t-sm muted">${esc(t.desc)}</p>` : ''}${conv ? `<p class="row gap-6 t-sm muted">${ic('message', 'i-sm')}<span class="truncate">From your conversation <a class="link" href="#/chat/${conv.id}">${esc(conv.title)}</a></span></p>` : ''}<div class="rq-fields">${fields}</div>${summary}${foot}`, { title: t.question ? 'Your question' : 'Details', cls: 'rq-formcard' });
    return `<div class="page page--narrow rq-page">${head}<div class="rq-new">${checkCard}${formCard}</div></div>`;
  }

  P.requestNew = ({ query }) => {
    const t = query.type && typeById(query.type);
    if (query.type && !t) {
      crumbs([{ label: 'Requests', to: '/requests' }, { label: 'New request' }]);
      return `<div class="page">${emptyState({ icon: 'clipboard', title: 'This request type isn’t available', desc: 'It may have been removed by the office.', actions: btn('See all request types', { v: 'primary', href: '/requests/new' }), boxed: true })}</div>`;
    }
    return t ? newForm(t, query) : catalog();
  };
  AFTER.requestNew = () => {
    const f = S.ui.rqNew;
    if (!S.cur.query.type || !f || f.phase !== 'checking' || f.timer) return;
    f.timer = setTimeout(() => { delete f.timer; if (S.ui.rqNew !== f) return; f.phase = 'done'; if (S.cur.r.page === 'requestNew') refresh(); }, 1100);
  };
  /** Editing a field clears its error; the course also re-runs the credit check. */
  const clearErr = el => { const f = S.ui.rqNew, k = el.id.replace(/^rq-f-/, ''); if (f?.errs?.[k]) { delete f.errs[k]; return true; } return false; };
  A['rq-new-change'] = el => { clearErr(el); refresh(); };
  A['rq-new-input'] = el => { if (clearErr(el)) refresh(); };
  A['rq-send'] = async () => {
    const f = S.ui.rqNew, t = typeById(f?.type);
    if (!t || f.sending) return;
    f.errs = validate(t, f.vals);
    const bad = Object.keys(f.errs);
    if (bad.length) { refresh(); $('#rq-f-' + bad[0])?.focus(); return; }
    const results = (t.checks || []).map(c => runCheck(c, f.vals));
    if (results.some(c => c.state === 'fail')) return;
    f.sending = true; refresh();
    await sleep(500);
    const fields = Object.fromEntries(t.fields.map(fd => [fd.id, fd.type === 'number' ? Number(f.vals[fd.id]) : String(f.vals[fd.id] ?? '').trim()]));
    const r = create(t, fields, { ...(results.length ? { checks: results, checkedAt: Date.now() } : {}), ...(f.conv ? { from: f.conv } : {}) });
    delete S.ui.rqNew;
    toast(t.question ? `Question sent to ${teamWord(spaceById(t.space))}` : `Request sent to ${spaceById(t.space)?.name || 'the office'}`);
    go('/requests/' + r.id);
  };
  A['rq-new'] = el => {
    const d = el?.dataset || {}, qs = new URLSearchParams();
    ['type', 'space', 'course', 'q', 'conv'].forEach(k => d[k] && qs.set(k, d[k]));
    delete S.ui.rqNew;
    go('/requests/new' + (qs.toString() ? '?' + qs : ''));
  };
  A['rq-quote'] = el => openDrawer('rq-quote', { doc: el.dataset.doc, page: el.dataset.page, q: el.dataset.q });
  DR['rq-quote'] = ({ doc, page, q }) => {
    const d = docById(doc), kb = d && kbById(d.kb), readable = !!kb && canReadKb(kb);
    return {
      title: d?.name || 'Source', desc: esc([kb?.name, page && `Page ${page}`].filter(Boolean).join(' · ')), lead: fileIcon(d?.type || 'pdf', 'lg'),
      body: `<blockquote class="rq-quote"><mark class="evidence">${esc(q)}</mark></blockquote><p class="t-sm muted mt-12">The assistant checked your request against this passage.</p>`,
      foot: readable ? btn('Open document', { v: 'primary', icon: 'external', href: `/doc/${doc}?q=${encodeURIComponent(q || '')}${page ? '&page=' + page : ''}` }) : '',
    };
  };

  /* ═══════════════ Ask the teaching team (or an office) ═══════════════ */
  /** The space's question type; offices without one get it on first use. */
  function questionType(sp) {
    let t = types().find(x => x.space === sp.id && x.question);
    if (t) return t;
    t = { id: 'rt-q-' + sp.id.replace(/^sp-/, ''), space: sp.id, name: sp.type === 'course' ? 'Question for the teaching team' : sp.type === 'office' ? 'Question for the office' : 'Question for the team', icon: 'message', sla: 2, fee: null, question: true, auto: true, desc: 'When the assistant can’t answer, ask the people who can.', fields: [{ id: 'question', label: 'Question', type: 'textarea', required: true }], checks: [] };
    if (!D.requestTypes) D.requestTypes = [];
    D.requestTypes.push(t);
    return t;
  }
  /** What the assistant answered last in a conversation, as plain text (sent along so staff don't repeat it). */
  function aiFrom(convId) {
    const c = convId && convById(convId);
    const m = c && [...(c.messages || [])].reverse().find(x => x.role === 'assistant' && x.text);
    return m ? clip(m.text.replace(/\*\*|__|`|^#+\s*/gm, '').replace(/\s*\[\d+\]/g, ''), 280) : '';
  }
  A['rq-ask-staff'] = el => {
    const d = el?.dataset || {};
    const space = d.space || convById(d.conv)?.space;
    if (!spaceById(space)) { toast('Open a course to ask its teaching team.', { tone: 'danger' }); return; }
    S.ui.rqAsk = { text: d.q || '', err: '', busy: false };
    openModal('rq-ask', { space, conv: d.conv || '', about: d.about || '' });
  };
  A['rq-ask-instead'] = el => {
    const t = typeById(el.dataset.type), f = S.ui.rqNew; if (!t) return;
    const fail = (t.checks || []).map(c => runCheck(c, f?.vals || {})).find(c => c.state === 'fail');
    A['rq-ask-staff']({ dataset: { space: t.space, q: `About “${t.name}”: ${fail?.detail || ''} What are my options?`.replace(/\s+/g, ' '), conv: f?.conv || '', about: t.id } });
  };
  M['rq-ask'] = ({ space, conv, about }) => {
    const sp = spaceById(space), f = ui('rqAsk', { text: '', err: '' }), t = types().find(x => x.space === space && x.question);
    const team = staffMembers(sp), roles = new Set(team.map(m => m.role));
    const days = plural(t?.sla || 2, 'day');
    const note = sp.type === 'course'
      ? `${roles.has('ta') ? 'The lecturer and TA answer' : 'The lecturer answers'} within ${days}; you’ll get it in your Inbox.`
      : `${sp.name} answers within ${plural(t?.sla || 2, 'working day')}; you’ll get it in your Inbox.`;
    const tried = aiFrom(conv), aboutT = typeById(about);
    return {
      title: sp.type === 'course' ? 'Ask the teaching team' : `Ask ${sp.name}`, size: 'md',
      desc: esc([sp.name, sp.code, aboutT && `About ${aboutT.name}`].filter(Boolean).join(' · ')),
      body: `${field({ id: 'rq-ask-q', label: 'Your question', required: true, error: f.err, desc: esc(note), control: textarea({ id: 'rq-ask-q', bind: 'rqAsk.text', value: f.text, rows: 5, placeholder: 'What do you want to know?', invalid: !!f.err, attrs: 'data-autofocus' }) })}
        ${tried ? `<div class="rq-ai mt-16">${ic('sparkles', 'i-sm')}<div class="grow"><div class="rq-ai__label">Sent along: what the assistant found</div><p>${esc(tried)}</p></div></div>` : ''}
        ${team.length ? `<div class="row gap-8 mt-16 t-sm muted"><span class="rq-avatars">${team.slice(0, 3).map(m => avatar(personName(m.user), 'xs')).join('')}</span><span class="truncate">${esc(team.map(m => personName(m.user)).join(', '))}</span></div>` : ''}`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Send question', { v: 'primary', icon: 'send', act: 'rq-ask-send', loading: f.busy, id: 'rq-ask-send' }),
    };
  };
  A['rq-ask-send'] = async () => {
    const p = S.modal?.props || {}, f = ui('rqAsk'), sp = spaceById(p.space);
    if (!sp || f.busy) return;
    const text = String(f.text || '').trim();
    if (!text) { f.err = 'Write your question.'; refreshLayer(); $('#rq-ask-q')?.focus(); return; }
    f.err = ''; f.busy = true; refreshLayer();
    await sleep(450);
    const t = questionType(sp), tried = aiFrom(p.conv);
    const r = create(t, { question: text }, { ...(tried ? { aiTried: tried } : {}), ...(p.conv ? { from: p.conv } : {}), ...(p.about ? { about: p.about } : {}) });
    delete S.ui.rqAsk;
    closeModal(); refresh();
    toast(`Question sent to ${teamWord(sp)}`, { action: { label: 'View', run: () => go('/requests/' + r.id) } });
  };

  /* ═══════════════ /requests/:id ═══════════════ */
  function entry(r, m, sp) {
    const who = m.by === me().id ? 'You' : personName(m.by);
    const st = m.status || KIND_STATUS[m.kind];
    const stChip = st ? stepChip(r, st) : '';
    if (m.kind === 'event' || (m.kind === 'status' && m.text === 'Submitted.')) {
      const text = m.text === 'Submitted.' ? (isQ(r) ? `asked ${teamWord(sp)}` : 'submitted this request') : m.text;
      const icon = m.text === 'Submitted.' ? 'send' : /withdrew/.test(m.text) ? 'undo' : /assign|took/.test(m.text) ? 'user' : 'clock';
      const submitted = m.text === 'Submitted.';
      const ai = submitted && r.aiTried ? `<div class="rq-ai rq-ai--thread">${ic('sparkles', 'i-sm')}<div class="grow"><div class="rq-ai__label">What the assistant found</div><p>${esc(r.aiTried)}</p></div></div>` : '';
      return `<div class="rq-event"><span class="rq-event__icon">${ic(icon, 'i-sm')}</span><span class="grow"><span class="medium fg">${esc(who)}</span> ${esc(text)}${stChip ? ` ${stChip}` : ''}</span><time class="rq-time" title="${esc(fmtDateTime(m.at))}">${esc(rel(m.at))}</time></div>${ai}`;
    }
    const staffMsg = m.by !== r.requester, role = staffMsg ? roleLabel(sp, m.by) : '';
    const files = m.files?.length ? `<div class="rq-files">${m.files.map(x => `<span class="rq-file">${fileIcon(String(x.name).split('.').pop(), 'sm')}<span class="truncate">${esc(x.name)}</span>${x.size ? `<span class="muted">${esc(fmtSize(x.size))}</span>` : ''}</span>`).join('')}</div>` : '';
    const faqDoc = m.faqDoc && docById(m.faqDoc);
    const faq = faqDoc && !faqDoc.archived ? `<a class="rq-faq-link" href="#${faqLink(faqDoc.id, m.text)}" title="${esc(faqDoc.name)}">${ic('book', 'i-sm')}<span class="truncate">Added to the course FAQ</span></a>` : '';
    return `<article class="${cx('rq-msg', staffMsg && 'rq-msg--staff')}">${avatar(personName(m.by), 'sm')}<div class="rq-msg__body">
      <header class="rq-msg__head"><span class="medium">${esc(who)}</span>${role ? `<span class="rq-msg__role">${esc(role)}</span>` : ''}<time class="rq-time" title="${esc(fmtDateTime(m.at))}">${esc(rel(m.at))}</time></header>
      ${stChip ? `<div class="rq-msg__status">${ic('arrow-right', 'i-sm')}${stChip}</div>` : ''}
      ${m.text ? `<div class="rq-msg__text">${esc(m.text).replace(/\n/g, '<br>')}</div>` : ''}${files}${faq}</div></article>`;
  }

  function composer(r, t, sp, { isReq, staff }) {
    if (!isOpen(r)) return closedNote(r, t, sp, isReq);
    if (!isReq && !staff) return `<div class="rq-closed">${ic('eye', 'i-sm')}<span>You can see this request, but only ${esc(sp?.name || 'its staff')} can act on it.</span></div>`;
    const c = composerState(r), data = { id: r.id };
    const first = firstName(r.requester);
    let label, placeholder, actions;
    if (isReq) {
      label = r.status === 'needs_info' ? 'Your reply' : 'Add a message';
      placeholder = r.status === 'needs_info' ? 'Answer the question above or attach what they asked for.' : `Add details for ${sp?.name || 'the office'}.`;
      actions = btn(r.status === 'needs_info' ? 'Send reply' : 'Send', { v: 'primary', icon: 'send', act: 'rq-reply', data });
    } else if (t.question) {
      label = 'Your answer'; placeholder = `Answer ${first}. Cite the slide or document if you can.`;
      actions = (r.status !== 'needs_info' ? btn('Ask for information', { v: 'tertiary', act: 'rq-askinfo', data }) : '') + btn('Answer', { v: 'primary', icon: 'send', act: 'rq-answer', data });
    } else if (r.status === 'approved') {
      label = `Message to ${first}`; placeholder = 'Optional: pick-up details, next steps…';
      actions = btn('Reply', { v: 'tertiary', act: 'rq-reply', data }) + btn('Mark completed', { v: 'primary', icon: 'check', act: 'rq-complete', data });
    } else {
      label = `Message to ${first}`; placeholder = `Reply, ask ${first} for something, or add a note to your decision.`;
      actions = (r.status !== 'needs_info' ? btn('Ask for information', { v: 'tertiary', act: 'rq-askinfo', data }) : '') + btn('Reply', { v: 'tertiary', act: 'rq-reply', data }) + btn('Decline', { v: 'danger-soft', act: 'rq-decline', data }) + btn('Approve', { v: 'primary', icon: 'check', act: 'rq-approve', data });
    }
    const ask = isReq && r.status === 'needs_info' ? [...r.thread].reverse().find(m => m.by !== r.requester && (m.status === 'needs_info' || m.kind === 'needs_info')) : null;
    const need = ask ? alertBox('warning', `${sp?.name || 'The office'} needs more information`, esc(clip(ask.text, 220))) : '';
    const files = c.files.length ? `<div class="rq-files">${c.files.map((x, i) => `<span class="rq-file">${fileIcon(String(x.name).split('.').pop(), 'sm')}<span class="truncate">${esc(x.name)}</span>${iconBtn('x', 'Remove ' + x.name, { size: 'sm', act: 'rq-file-rm', data: { id: r.id, i } })}</span>`).join('')}</div>` : '';
    const kbName = kbById(sp?.kbs?.[0])?.name;
    const faq = staff && !isReq && t.question && kbName ? switchRow({ title: 'Add this answer to the course FAQ', desc: `Saved to ${esc(kbName)} so the assistant can answer it next time.`, on: c.faq, act: 'rq-faq', data }) : '';
    return `<div class="card rq-composer">${need}
      ${field({ id: 'rq-text', label, error: c.err, control: textarea({ id: 'rq-text', bind: cKey(r) + '.text', value: c.text, rows: 3, placeholder, invalid: !!c.err }) })}
      ${files}${faq}
      <div class="rq-composer__actions">
        <input type="file" id="rq-file" class="sr-only" multiple data-change="rq-file" data-id="${r.id}" tabindex="-1" aria-hidden="true">
        ${iconBtn('paperclip', 'Attach a file', { act: 'rq-attach', data })}
        <div class="rq-composer__btns">${actions}</div>
      </div></div>`;
  }
  function closedNote(r, t, sp, isReq) {
    const word = { completed: t.question ? 'answered' : 'completed', declined: 'declined', withdrawn: 'withdrawn' }[r.status] || 'closed';
    const action = !isReq ? '' : t.question && r.status === 'completed' ? btn('Ask a follow-up', { size: 'sm', icon: 'message', act: 'rq-ask-staff', data: { space: r.space } })
      : r.status !== 'completed' ? btn('Send a new request', { size: 'sm', href: '/requests/new?type=' + r.type }) : '';
    return `<div class="rq-closed">${ic(r.status === 'declined' ? 'x-circle' : r.status === 'withdrawn' ? 'undo' : 'check-circle', 'i-sm')}<span class="grow">This request was ${word} ${esc(relIn(r.updated))}.</span>${action}</div>`;
  }

  function sideCards(r, t, sp, { isReq, staff }) {
    const fields = t.question ? [] : (t.fields || []).map(fd => [fd.label, fmtField(fd, r.fields?.[fd.id], r)]);
    const fee = r.fee || t.fee;
    const aboutT = typeById(r.about);
    const conv = r.from && myConvs().find(c => c.id === r.from);
    const dueRow = !isOpen(r) ? null : staff && !isReq ? ['SLA', slaHtml(r)] : ['Expected by', esc(fmtDay(r.due))];
    const assignee = r.assignee ? `<span class="row gap-6" style="min-width:0">${avatar(personName(r.assignee), 'xs')}<span class="truncate">${esc(r.assignee === me().id ? 'You' : personName(r.assignee))}</span></span>` : '<span class="muted">Not assigned yet</span>';
    const assignCtl = staff && isOpen(r) ? `<span class="row gap-4 none">${r.assignee !== me().id ? btn('Assign to me', { v: 'tertiary', size: 'sm', act: 'rq-assign-me', data: { id: r.id } }) : ''}${iconBtn('users', 'Assign to someone else', { size: 'sm', menu: 'rq-assign', data: { id: r.id } })}</span>` : '';
    const meta = kv([
      ['Request', `<span class="num">${esc(r.id)}</span>`],
      ['Sent to', esc(sp?.name || '—')],
      ['Submitted', esc(fmtDateTime(r.created))],
      dueRow,
      ['Assignee', `<span class="rq-assignee">${assignee}${assignCtl}</span>`],
      aboutT && ['About', esc(aboutT.name)],
      conv && ['Started from', `<a class="link" href="#/chat/${conv.id}">${esc(conv.title)}</a>`],
    ]);
    const answers = [...fields, fee && ['Fee', esc(fee)]].filter(Boolean);
    const details = card(`${answers.length ? `<dl class="rq-answers">${answers.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>${separator()}` : ''}${meta}`, { title: 'Details', cls: 'rq-side-card' });

    let person = '';
    if (staff && !isReq) {
      const m = memberById(r.requester), p = personaOf(r.requester)?.profile;
      const sid = p?.studentId || (/^\d+@/.test(m?.email || '') ? m.email.split('@')[0] : '');
      const program = p ? `${p.program} · ${p.cohort}` : (m?.groups || []).map(g => groupById(g)?.name).filter(Boolean).join(', ');
      const others = all().filter(x => x.requester === r.requester && x.id !== r.id && isOpen(x) && staffOf(x)).length;
      person = card(`<div class="rq-person">${avatar(personName(r.requester), 'lg')}<div class="grow" style="min-width:0"><div class="medium truncate">${esc(personName(r.requester))}</div><div class="t-sm muted truncate">${esc(m?.email || '')}</div></div></div>
        ${kv([sid && ['Student ID', `<span class="num">${esc(sid)}</span>`], program && ['Program', esc(program)], others && ['Other open', plural(others, 'request')]])}`, { title: 'Requester', cls: 'rq-side-card' });
    }
    const checks = r.checks?.length ? card(checkLines(r.checks), { title: 'Checked before sending', desc: `The assistant checked these rules${r.checkedAt ? ' on ' + esc(fmtDateTime(r.checkedAt)) : ''}.`, cls: 'rq-side-card' }) : '';
    return details + person + checks;
  }

  P.requestItem = ({ params }) => {
    const r = reqById(params.id);
    if (!r) {
      crumbs([{ label: 'Requests', to: '/requests' }, { label: 'Not found' }]);
      return `<div class="page">${emptyState({ icon: 'clipboard', title: 'This request doesn’t exist', desc: 'The link may be old or mistyped.', actions: btn('Go to requests', { v: 'primary', href: '/requests' }), boxed: true })}</div>`;
    }
    const isReq = r.requester === me().id, staff = staffOf(r);
    if (!isReq && !staff && !isAdmin()) {
      crumbs([{ label: 'Requests', to: '/requests' }, { label: r.id }]);
      return `<div class="page">${emptyState({ icon: 'lock', title: 'You can’t open this request', desc: 'Only the person who sent it and the staff handling it can see it.', actions: btn('Go to requests', { v: 'primary', href: '/requests' }), boxed: true })}</div>`;
    }
    markSeen(r);
    const t = typeById(r.type) || { name: 'Request', fields: [], icon: 'clipboard' }, sp = spaceById(r.space);
    crumbs([{ label: 'Requests', to: '/requests' + (staff && !isReq ? '?tab=queue' : '') }, { label: r.id }]);
    const sub = [isQ(r) ? t.name : null, sp?.name, isOpen(r) ? (staff && !isReq ? slaHtml(r) : `Expected by ${esc(fmtDay(r.due))}`) : null].filter(Boolean);
    const head = pageHeader({
      lead: mark(sp, 40),
      title: title(r), extra: requestStatus(r),
      desc: `<span class="rq-sub">${sub.map(x => /^</.test(x) ? x : esc(x)).join('<span aria-hidden="true">·</span>')}</span>`,
      actions: isReq && isOpen(r) ? btn('Withdraw', { v: 'ghost', icon: 'undo', act: 'rq-withdraw', data: { id: r.id } }) : '',
    });
    const thread = `<section class="card rq-thread" aria-label="Activity">${r.thread.map(m => entry(r, m, sp)).join('')}</section>`;
    return `<div class="page rq-page rq-page--item">${head}<div class="rq-detail"><div class="rq-main">${thread}${composer(r, t, sp, { isReq, staff })}</div><aside class="rq-side" aria-label="Request details">${sideCards(r, t, sp, { isReq, staff })}</aside></div></div>`;
  };

  /* ── Request actions ── */
  function ctx(el) { const r = reqById(el.dataset.id); return r ? { r, t: typeById(r.type) || { name: 'Request' }, c: composerState(r) } : null; }
  function need(c, msg) { c.err = msg; refresh(); $('#rq-text')?.focus(); }
  A['rq-reply'] = el => {
    const x = ctx(el); if (!x) return;
    const { r, c } = x, text = c.text.trim();
    if (!text && !c.files.length) return need(c, 'Write a message first.');
    const s = snap(r), isReq = r.requester === me().id;
    const st = isReq ? (r.status === 'needs_info' ? 'in_review' : null) : (r.status === 'submitted' ? 'in_review' : null);
    post(r, text, 'message', { status: st, extra: c.files.length ? { files: [...c.files] } : undefined });
    audit(isReq ? 'Replied to a request' : 'Replied to a requester', r);
    clearComposer(r); refresh();
    toast(isReq ? `Sent. ${r.assignee ? firstName(r.assignee) : 'The office'} will see it in their queue` : `Sent to ${firstName(r.requester)}`, { action: { label: 'Undo', run: undoTo(r, s) } });
  };
  A['rq-askinfo'] = el => {
    const x = ctx(el); if (!x) return;
    const { r, c } = x, text = c.text.trim();
    if (!text) return need(c, `Say what you need from ${firstName(r.requester)}.`);
    const s = snap(r);
    post(r, text, 'needs_info', { status: 'needs_info', extra: c.files.length ? { files: [...c.files] } : undefined });
    audit('Asked for information', r);
    clearComposer(r); refresh();
    toast(`Asked ${firstName(r.requester)} for information. The SLA clock pauses until they reply`, { action: { label: 'Undo', run: undoTo(r, s) } });
  };
  A['rq-approve'] = el => {
    const x = ctx(el); if (!x) return;
    const { r, c } = x, s = snap(r);
    post(r, c.text.trim() || 'Approved.', 'approved', { status: 'approved', extra: c.files.length ? { files: [...c.files] } : undefined });
    audit('Approved a request', r);
    clearComposer(r); refresh();
    toast(`Approved. ${firstName(r.requester)} will be notified`, { action: { label: 'Undo', run: undoTo(r, s) } });
  };
  A['rq-complete'] = el => {
    const x = ctx(el); if (!x) return;
    const { r, c } = x, s = snap(r);
    post(r, c.text.trim() || 'Completed.', 'completed', { status: 'completed', extra: c.files.length ? { files: [...c.files] } : undefined });
    audit('Completed a request', r);
    clearComposer(r); refresh();
    toast('Marked completed', { action: { label: 'Undo', run: undoTo(r, s) } });
  };
  A['rq-decline'] = el => {
    const x = ctx(el); if (!x) return;
    S.ui.rqDecline = { text: x.c.text.trim(), err: '' };
    openModal('rq-decline', { id: x.r.id });
  };
  M['rq-decline'] = ({ id }) => {
    const r = reqById(id), f = ui('rqDecline', { text: '', err: '' });
    return {
      title: 'Decline this request?', size: 'sm', icon: ic('x-circle'),
      desc: `${esc(firstName(r?.requester))} sees your reason and can send a new request.`,
      body: field({ id: 'rq-decline-text', label: 'Reason', required: true, error: f.err, control: textarea({ id: 'rq-decline-text', bind: 'rqDecline.text', value: f.text, rows: 4, placeholder: 'For example: the re-grading window for this exam closed on Oct 28.', invalid: !!f.err, attrs: 'data-autofocus' }) }),
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Decline', { v: 'danger', act: 'rq-decline-ok', data: { id } }),
    };
  };
  A['rq-decline-ok'] = el => {
    const r = reqById(el.dataset.id), f = ui('rqDecline'); if (!r) return;
    const text = String(f.text || '').trim();
    if (!text) { f.err = 'Add a reason so the student knows what to do next.'; refreshLayer(); $('#rq-decline-text')?.focus(); return; }
    const s = snap(r);
    post(r, text, 'declined', { status: 'declined' });
    audit('Declined a request', r);
    clearComposer(r); delete S.ui.rqDecline;
    closeModal(); refresh();
    toast(`Declined. ${firstName(r.requester)} will see your reason`, { action: { label: 'Undo', run: undoTo(r, s) } });
  };
  A['rq-answer'] = el => {
    const x = ctx(el); if (!x) return;
    const { r, c } = x, text = c.text.trim();
    if (!text) return need(c, 'Write the answer first.');
    const { doc, gap } = c.faq ? addToFaq(r, text) : {};
    post(r, text, 'answer', { status: 'completed', extra: { ...(doc ? { faqDoc: doc.id } : {}), ...(c.files.length ? { files: [...c.files] } : {}) } });
    audit('Answered a question', r);
    clearComposer(r); refresh();
    toast(doc ? `Answer sent and added to the course FAQ${gap ? '. 1 knowledge gap closed' : ''}` : `Answer sent to ${firstName(r.requester)}`,
      doc ? { action: { label: 'Open FAQ', run: () => go(faqLink(doc.id, text)) } } : {});
  };
  A['rq-faq'] = el => { const r = reqById(el.dataset.id); if (!r) return; const c = composerState(r); c.faq = !c.faq; refresh(); };
  A['rq-withdraw'] = el => {
    const r = reqById(el.dataset.id); if (!r) return;
    confirmAction({
      title: 'Withdraw this request?', danger: true, confirm: 'Withdraw',
      body: `${esc(spaceById(r.space)?.name || 'The office')} stops working on it. You can send a new request later.`,
      onConfirm: () => { post(r, 'withdrew this request', 'event', { status: 'withdrawn' }); audit('Withdrew a request', r); refresh(); toast('Request withdrawn'); },
    });
  };
  A['rq-assign-me'] = el => { const r = reqById(el.dataset.id); if (r) assign(r, me().id); };
  MENUS['rq-assign'] = el => {
    const r = reqById(el.dataset.id), sp = r && spaceById(r.space); if (!sp) return [];
    const ppl = staffMembers(sp).sort((a, b) => (b.user === me().id) - (a.user === me().id));
    return [{ section: 'Assign to' }, ...ppl.map(m => ({ label: personName(m.user) + (m.user === me().id ? ' (you)' : ''), meta: roleLabel(sp, m.user), checked: r.assignee === m.user, run: () => assign(r, m.user) })),
      ...(r.assignee ? [{ sep: true }, { label: 'Unassign', icon: 'x', run: () => assign(r, null) }] : [])];
  };
  A['rq-attach'] = () => $('#rq-file')?.click();
  A['rq-file'] = el => {
    const r = reqById(el.dataset.id); if (!r) return;
    const c = composerState(r);
    [...(el.files || [])].forEach(f => c.files.push({ name: f.name, size: f.size }));
    c.err = ''; refresh();
  };
  A['rq-file-rm'] = el => { const r = reqById(el.dataset.id); if (!r) return; composerState(r).files.splice(+el.dataset.i, 1); refresh(); };
})();

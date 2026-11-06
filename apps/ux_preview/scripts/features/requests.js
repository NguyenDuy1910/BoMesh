/* Requests (/requests, /requests/new, /requests/:id) — people ask offices and
   teams for things; staff work one queue within an SLA. Before a request is
   sent the assistant checks the rules that apply (each with its citation).
   A staff answer to a question can become FAQ knowledge. Requests live in
   D.requestTypes / D.svcRequests (workspace seed data). */
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
  const teamWord = sp => sp?.type === 'course' ? 'the teaching team' : sp?.type === 'office' ? 'the office' : 'the team';

  /** Colored space tile — Home owns X.spaceMark; this is the fallback while it loads. */
  const mark = (sp, size = 32) => X.spaceMark?.(sp, size) || `<span class="rq-mark" style="--rq-c:${esc(sp?.color || '#4F5865')};width:${size}px;height:${size}px" aria-hidden="true">${ic(spaceType(sp?.type).icon, size < 32 ? 'i-sm' : '')}</span>`;

  function fmtField(fd, v) {
    if (v == null || v === '') return '<span class="muted">—</span>';
    return esc(String(v)).replace(/\n/g, '<br>');
  }

  /* ═══════════════ Status, SLA, list row ═══════════════ */
  /** The one request status, as the viewer should read it: the requester is asked to reply; staff wait for the requester.
      Used everywhere a request shows (Requests, space queue, Home, request page). */
  function requestStatus(r) {
    if (r.status === 'needs_info' && r.requester !== me().id) return chip(spaceById(r.space)?.type === 'course' ? 'Waiting for student' : 'Waiting for reply', { tone: 'warning', dot: true });
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
    if (r.status === 'needs_info') return { text: 'Paused', tone: 'muted', tip: 'The clock stops while you wait for the requester' };
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
  const composerState = r => ui(cKey(r), { text: '', err: '', faq: true, files: [], ask: false });
  const clearComposer = r => Object.assign(composerState(r), { text: '', err: '', files: [], ask: false });

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
    const doc = mkDoc(kb.id, uid('faq'), name, { addedBy: me().name, updated: Date.now(), status: 'ready', pages: 1, size: 900 + answer.length * 2, passages: 2 });
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
    const empty = () => emptyState({ icon: 'clipboard', boxed: true, title: 'No requests yet', desc: 'Ask a team or office for something they handle. The assistant checks the rules before you send.', actions: btn('New request', { v: 'primary', icon: 'plus', href: '/requests/new' }) });
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

  const OPEN_STATUS_OPTS = [['submitted', 'Submitted'], ['in_review', 'In review'], ['needs_info', 'Waiting for reply'], ['approved', 'Approved']];
  const CLOSED_STATUS_OPTS = [['completed', 'Done'], ['declined', 'Declined'], ['withdrawn', 'Withdrawn']];
  /** The one staff queue. space: scoped to one space (its Requests/Questions tab) — same table, SLA, assignee and bulk actions. */
  function queueView(q, { space } = {}) {
    const key = space ? 'rqQ_' + space : 'rqQ';
    const u = ui(key, { view: 'open', sel: {} });
    if (u.view === 'done') u.view = 'closed';
    const spaces = space ? [] : staffSpaces();
    const inView = q.filter(r => (u.view === 'closed' ? !isOpen(r) : isOpen(r)));
    const filtering = !!(u.q || u.space || u.status || u.type);
    const tools = needsTools(inView.length, key, ['space', 'status', 'type']);
    const filtered = inView.filter(r => (!u.space || r.space === u.space) && (!u.status || r.status === u.status) && (!u.type || r.type === u.type)
      && matchesQ(key, title(r), personName(r.requester), memberById(r.requester)?.email, r.id, typeById(r.type)?.name));
    const rows = tools && u.sort ? applySort(filtered, key, { name: r => personName(r.requester).toLowerCase(), created: r => r.created, due: r => r.due })
      : [...filtered].sort(u.view === 'closed' ? (a, b) => b.updated - a.updated : byDue);
    const typeOpts = types().filter(t => (space ? t.space === space : spaces.some(s => s.id === t.space))).map(t => [t.id, t.question && !space ? `${t.name} · ${spaceById(t.space)?.code || spaceById(t.space)?.name}` : t.name]);
    // The tab counts what waits on you; Open / Closed only switches the view.
    const filters = tools ? `${searchField({ uiKey: key, placeholder: 'Search by person, ID or request' })}
      ${spaces.length > 1 ? filterButton('Space', key, 'space', spaces.map(s => [s.id, s.name])) : ''}
      ${filterButton('Status', key, 'status', u.view === 'closed' ? CLOSED_STATUS_OPTS : OPEN_STATUS_OPTS)}
      ${typeOpts.length > 1 ? filterButton('Type', key, 'type', typeOpts) : ''}
      ${clearFilters(key, ['space', 'status', 'type'])}
      ${filtering && !S.navLoading && S.pageState === 'live' ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'request')}</span>` : ''}` : '';
    const toolbar = `<div class="toolbar">${seg({ value: u.view, options: [['open', 'Open'], ['closed', 'Closed']], act: 'rq-q-view', data: { ui: key }, label: 'Show' })}${filters}</div>`;
    const empty = () => u.view === 'closed'
      ? emptyState({ icon: 'archive', boxed: true, compact: !!space, title: 'Nothing closed yet', desc: 'Requests you approve, decline or answer move here.' })
      : emptyState({ icon: 'check-circle', tone: 'success', boxed: true, compact: !!space, title: 'Your queue is clear', desc: space ? 'New requests and questions for this space show up here.' : 'New requests and questions for your spaces show up here.' });
    return toolbar + gate({
      empty,
      ok: () => {
        if (!inView.length) return empty();
        if (!rows.length) return noMatches(key, ['space', 'status', 'type'], 'requests');
        const page = paginate(rows, key, 20), ids = tools ? page.filter(isOpen).map(r => r.id) : [];
        const sorted = (label, k, cls = '') => (tools ? sortHead(label, k, key, cls) : th(label, cls));
        const head = (tools ? (ids.length ? selAllCheck(key, ids) : th('', 'table__column--check')) : '') + sorted('Requester', 'name') + th('Request') + sorted('Submitted', 'created', 'table__column--hide-sm') + sorted(u.view === 'closed' ? 'Closed' : 'SLA', 'due') + th('Status') + th('Assignee', 'hide-md');
        const trs = page.map(r => {
          const t = typeById(r.type), sp = spaceById(r.space), m = memberById(r.requester), sid = /^\d+@/.test(m?.email || '') ? m.email.split('@')[0] : (m?.email || '');
          return `<tr class="${cx('table__row', overdue(r) && 'rq-row--over')}" data-act="rq-open" data-id="${r.id}" tabindex="0" ${tools && u.sel?.[r.id] ? 'aria-selected="true"' : ''}>
            ${!tools ? '' : isOpen(r) ? selCheck(key, r.id, 'Select ' + r.id) : '<td class="table__cell table__cell--check"></td>'}
            <td class="table__cell"><span class="row gap-12">${avatar(personName(r.requester), 'sm')}<span class="stack" style="min-width:0"><span class="cell-title truncate">${esc(personName(r.requester))}</span><span class="cell-sub truncate num">${esc(sid)}</span></span></span></td>
            <td class="table__cell table__cell--primary"><span class="stack rq-cell-req"><span class="cell-title rq-clamp">${esc(title(r))}</span><span class="cell-sub truncate">${esc(t?.question ? (space ? `Question · ${r.id}` : `Question · ${sp?.name || ''}`) : `${spaces1(spaces, sp)}${r.id}`)}</span></span></td>
            <td class="table__cell table__cell--hide-sm muted"><span class="rq-nowrap">${esc(rel(r.created))}</span></td>
            <td class="table__cell">${slaHtml(r)}</td>
            <td class="table__cell">${requestStatus(r)}</td>
            <td class="table__cell hide-md table__cell--hide-sm">${r.assignee ? `<span class="row gap-6">${avatar(personName(r.assignee), 'xs')}<span class="truncate">${esc(r.assignee === me().id ? 'You' : firstName(r.assignee))}</span></span>` : '<span class="muted">Unassigned</span>'}</td></tr>`;
        });
        const bulk = tools ? bulkBar(key, btn('Assign to me', { v: 'ghost', size: 'sm', icon: 'user', act: 'rq-bulk-assign', data: { ui: key } })) : '';
        return table({ head, rows: trs, label: 'Request queue' }) + pager(rows.length, key, 20) + bulk;
      },
    });
  }
  /** Space page: the same queue, scoped to one space's requests. */
  X.requestQueue = spaceId => { const sp = spaceById(spaceId); return isSpaceStaff(sp) ? queueView(all().filter(r => r.space === spaceId && r.requester !== me().id), { space: spaceId }) : ''; };
  /** Space page: open items waiting on staff (the tab badge counts these; same rule as the Requests badge). */
  X.requestQueueCount = spaceId => { const sp = spaceById(spaceId); return isSpaceStaff(sp) ? all().filter(r => r.space === spaceId && r.requester !== me().id && ACTIONABLE.includes(r.status)).length : 0; };
  /** Space name prefix in the queue only when the caller staffs several spaces. */
  const spaces1 = (spaces, sp) => spaces.length > 1 && sp ? sp.name + ' · ' : '';

  A['rq-q-view'] = el => { const u = ui(el.dataset.ui || 'rqQ'); u.view = el.dataset.value; u.status = ''; u.sel = {}; u.page = 1; refresh(); };
  A['rq-open'] = el => go('/requests/' + el.dataset.id);
  A['rq-bulk-assign'] = el => {
    const key = el?.dataset?.ui || 'rqQ';
    const rs = selIds(key).map(reqById).filter(r => r && isOpen(r) && r.assignee !== me().id);
    ui(key).sel = {};
    if (!rs.length) { refresh(); toast('These are already yours', { tone: 'accent' }); return; }
    const snaps = rs.map(r => [r, snap(r)]);
    rs.forEach(r => assign(r, me().id, { quiet: true }));
    refresh();
    toast(`${plural(rs.length, 'request')} assigned to you`, { action: { label: 'Undo', run: () => { snaps.forEach(([r, s]) => { Object.assign(r, { status: s.status, updated: s.updated, lastBy: s.lastBy, assignee: s.assignee }); r.thread.length = s.n; }); refresh(); } } });
  };

  /* ═══════════════ /requests/new — catalog ═══════════════ */
  /** Service requests only. Questions to a team go through "Ask the team" on the space (one surface, with the assistant's context). */
  function catalogGroups() {
    return visibleSpaces().map(sp => ({ sp, list: types().filter(t => t.space === sp.id && !t.question && !t.archived) })).filter(g => g.list.length)
      .sort((a, b) => (a.sp.type !== 'office') - (b.sp.type !== 'office') || a.sp.name.localeCompare(b.sp.name));
  }
  function catalog(query = {}) {
    crumbs([{ label: 'Requests', to: '/requests' }, { label: 'New request' }]);
    const all = catalogGroups();
    // From a space's page ("New request"), the catalog is that space's; the rest stays one link away.
    const scoped = query.space && all.find(g => g.sp.id === query.space);
    const groups = scoped ? [scoped] : all;
    const shown = groups.map(g => ({ sp: g.sp, list: g.list.filter(t => matchesQ('rqCat', t.name, t.desc, g.sp.name, g.sp.code)) })).filter(g => g.list.length);
    const head = pageHeader({ title: 'New request', desc: 'Ask a team or office for something they handle. The assistant checks the rules before you send.', actions: scoped && all.length > 1 ? btn('All request types', { v: 'ghost', href: '/requests/new' }) : '' });
    const total = groups.reduce((n, g) => n + g.list.length, 0);
    const toolbar = needsTools(total, 'rqCat') ? `<div class="toolbar">${searchField({ uiKey: 'rqCat', placeholder: 'Search requests and offices' })}</div>` : '';
    const empty = () => emptyState({ icon: 'clipboard', boxed: true, title: 'No one takes requests here yet', desc: isAdmin() ? 'Office and team leads add request types in their space’s Settings, under Requests.' : 'When an office or team starts taking requests, you’ll find them here.', actions: btn('Back to requests', { href: '/requests' }) });
    const body = gate({
      loading: () => skelRows(6), empty,
      ok: () => {
        if (!groups.length) return empty();
        if (!shown.length) return noMatches('rqCat', [], 'request types');
        return shown.map(({ sp, list: ts }) => `<section class="rq-group"><div class="rq-group__head">${mark(sp, 32)}<div class="grow" style="min-width:0"><h2 class="section__title truncate">${esc(sp.name)}</h2><p class="t-xs muted truncate">${esc(sp.type === 'course' ? [sp.code, 'Your course'].filter(Boolean).join(' · ') : sp.schedule || sp.desc || '')}</p></div></div>
          ${list(ts.map(t => item({
            lead: itemIcon(t.icon || 'clipboard'),
            title: esc(t.name),
            desc: `<span class="rq-cat-desc">${esc(t.desc || '')}</span><span class="rq-cat-meta">${ic('clock', 'i-sm')}${esc(slaUsual(t))}${t.fee ? ` · ${esc(t.fee)}` : ''}</span>`,
            trail: ic('chevron-right', 'muted'),
            href: `/requests/new?type=${t.id}`,
          })))}</section>`).join('');
      },
    });
    return `<div class="page page--narrow rq-page">${head}${toolbar}${body}</div>`;
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
      case 'has': {
        if (!p) return { ...base, state: 'info', detail: 'The team checks this for you.' };
        const v = p[c.key], ok = Array.isArray(v) ? v.includes(c.value) : v === c.value;
        return ok ? { ...base, state: 'pass', detail: `Completed: ${c.value}` }
          : { ...base, state: 'fail', detail: `Your profile doesn’t show ${c.value} yet.`, consequence: `Complete it first: ${c.fix || c.value}. Then send this request.` };
      }
      default: return { ...base, state: 'info', detail: '' };
    }
  }
  const CHECK_UI = { pass: ['check-circle', 'Met'], warn: ['alert', 'Needs attention'], fail: ['x-circle', 'Not met'], info: ['info', 'Good to know'], wait: ['circle-dashed', 'Not checked yet'] };
  function citeBtn(c, n) {
    const d = docById(c.doc);
    return `<button type="button" class="cite" data-act="rq-quote" ${dataAttrs({ doc: c.doc, page: c.page, q: c.quote })} aria-label="Source ${n}: ${esc(d?.name || 'source')}${c.page ? ', page ' + c.page : ''}">${n}</button>`;
  }
  function checkLines(results, { notes = true } = {}) {
    let n = 0;
    return `<ul class="rq-checks">${results.map(c => {
      const [icon, label] = CHECK_UI[c.state] || CHECK_UI.info;
      return `<li class="rq-check rq-check--${c.state}"><span class="rq-check__icon">${ic(icon)}<span class="sr-only">${label}:</span></span><div class="rq-check__body"><div class="rq-check__label">${esc(c.label)}${c.cite ? citeBtn(c.cite, ++n) : ''}</div>${c.detail ? `<div class="rq-check__detail">${esc(c.detail)}</div>` : ''}${notes && c.consequence ? `<div class="rq-check__note">${esc(c.consequence)}</div>` : ''}</div></li>`;
    }).join('')}</ul>`;
  }
  /** Rules that are met fold into one line; only what blocks the request stays open. */
  function metLine(ok) {
    const met = ok.filter(c => c.state === 'pass').length, know = ok.length - met;
    const summary = [met && plural(met, 'rule') + ' met', know && plural(know, 'thing') + ' to know'].filter(Boolean).join(' · ');
    return disclosure({ path: 'rqNew.showChecks', icon: 'shield-check', title: 'Rules the assistant checked', summary: esc(summary), body: checkLines(ok) });
  }

  function formState(t, query) {
    const key = [t.id, query.space, query.q].map(x => x || '').join('|');
    let f = S.ui.rqNew;
    if (f && f.key === key) return f;
    f = S.ui.rqNew = { key, type: t.id, vals: {}, errs: {}, phase: t.checks?.length ? 'checking' : 'done', conv: query.conv || '' };
    t.fields.forEach(fd => {
      let v = ['type', 'space', 'conv', 'q'].includes(fd.id) ? '' : String(query[fd.id] ?? '');
      if (fd.type === 'select' && !fd.options.includes(v)) v = '';
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
      if (fd.required && !v) e[fd.id] = fd.type === 'select' ? 'Choose an option.' : fd.id === 'reason' ? 'Add a reason. A sentence is enough.' : fd.id === 'question' ? 'Write your question.' : 'This field is required.';
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
      const ok = results.filter(c => c.state !== 'fail');
      if (f.phase !== 'done') checkCard = card(`<div class="rq-checking" role="status">${spinner()}<span>Checking the rules that apply to you…</span></div>`, { cls: 'rq-checkcard' });
      else if (!failing.length) checkCard = `<div class="card rq-checkcard rq-checkcard--ok">${metLine(ok)}</div>`;
      else {
        // One red box: the failing rule's plain detail, then what to do about it.
        const fix = failing.find(c => c.cite)?.cite;
        const fixDoc = fix && docById(fix.doc), readable = !!fixDoc && canReadKb(kbById(fixDoc.kb));
        const actions = btn(`Ask ${teamWord(sp)} instead`, { v: 'secondary', size: 'sm', icon: 'message', act: 'rq-ask-instead', data: { type: t.id } })
          + (readable ? linkBtn('Read the policy', { href: `/doc/${fix.doc}?q=${encodeURIComponent(fix.quote || '')}&page=${fix.page || 1}`, icon: 'arrow-up-right' }) : '');
        checkCard = card(`${alertBox('danger', 'You can’t send this request yet', esc(failing.map(c => c.consequence || c.detail).join(' ')), actions)}
          <div class="mt-12">${checkLines(failing, { notes: false })}</div>${ok.length ? `<div class="mt-8">${metLine(ok)}</div>` : ''}`, { title: 'Before you send', icon: itemIcon('shield-check', 'accent', 'sm'), cls: 'rq-checkcard' });
      }
    }

    const fields = t.fields.map(fd => field({ id: 'rq-f-' + fd.id, label: fd.label, required: fd.required, error: f.errs[fd.id], control: fieldControl(fd, f) })).join('');
    // Where it goes and how long it takes are in the header; the footer only adds a fee when there is one.
    const fee = t.fee ? `<span class="rq-form__fee">${ic('info', 'i-sm')}${esc(`Fee: ${t.fee}`)}</span>` : '';
    const wait = f.waitNote && f.phase !== 'done' ? `<span class="rq-form__fee" role="status">${spinner()}Still checking the rules. One moment.</span>` : '';
    const conv = f.conv && myConvs().some(c => c.id === f.conv) ? convById(f.conv) : null;
    const foot = `<div class="rq-form__foot">${wait || fee}${btn('Cancel', { v: 'ghost', href: '/requests/new' })}${btn(t.question ? 'Send question' : 'Send request', { v: 'primary', icon: 'send', act: 'rq-send', loading: f.sending, id: 'rq-send' })}</div>`;
    const formCard = card(`${t.desc ? `<p class="t-sm muted">${esc(t.desc)}</p>` : ''}${conv ? `<p class="row gap-6 t-sm muted">${ic('message', 'i-sm')}<span class="truncate">From your conversation <a class="link" href="#/chat/${conv.id}">${esc(conv.title)}</a></span></p>` : ''}<div class="rq-fields">${fields}</div>${foot}`, { title: t.question ? 'Your question' : 'Details', cls: 'rq-formcard' });
    // A failed rule can't be fixed in the form, so the form waits until the rules are met; asking the office is the way forward.
    return `<div class="page page--narrow rq-page">${head}<div class="rq-new">${checkCard}${failing.length ? '' : formCard}</div></div>`;
  }

  P.requestNew = ({ query }) => {
    const t = query.type && typeById(query.type) && !typeById(query.type).archived ? typeById(query.type) : null;
    if (query.type && !t) {
      crumbs([{ label: 'Requests', to: '/requests' }, { label: 'New request' }]);
      return `<div class="page">${emptyState({ icon: 'clipboard', title: 'This request type isn’t available', desc: 'It may have been removed by the office.', actions: btn('See all request types', { v: 'primary', href: '/requests/new' }), boxed: true })}</div>`;
    }
    // Old links to a question type open the one way to ask a team: its Ask dialog.
    if (t?.question) { askFromLink = t.space; return catalog({ space: t.space }); }
    return t ? newForm(t, query) : catalog(query);
  };
  let askFromLink = '';
  AFTER.requestNew = () => {
    if (askFromLink) { const space = askFromLink; askFromLink = ''; if (!S.modal) A['rq-ask-staff']({ dataset: { space, q: S.cur.query.q || '' } }); return; }
    const f = S.ui.rqNew;
    if (!S.cur.query.type || !f || f.phase !== 'checking' || f.timer) return;
    f.timer = setTimeout(() => { delete f.timer; if (S.ui.rqNew !== f) return; f.phase = 'done'; f.waitNote = false; if (S.cur.r.page === 'requestNew') refresh(); }, 1100);
  };
  /** Editing a field clears its error; a select change re-renders so checks see the new value. */
  const clearErr = el => { const f = S.ui.rqNew, k = el.id.replace(/^rq-f-/, ''); if (f?.errs?.[k]) { delete f.errs[k]; return true; } return false; };
  A['rq-new-change'] = el => { clearErr(el); refresh(); };
  A['rq-new-input'] = el => { if (clearErr(el)) refresh(); };
  A['rq-send'] = async () => {
    const f = S.ui.rqNew, t = typeById(f?.type);
    if (!t || f.sending) return;
    if (f.phase !== 'done') { f.waitNote = true; refresh(); return; }
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
    const d = { ...(el?.dataset || {}) }, qs = new URLSearchParams();
    // A space that takes a single kind of request opens its form directly.
    if (d.space && !d.type) { const only = types().filter(t => t.space === d.space && !t.question && !t.archived); if (only.length === 1) d.type = only[0].id; }
    ['type', 'space', 'course', 'q', 'conv'].forEach(k => d[k] && qs.set(k, d[k]));
    delete S.ui.rqNew;
    go('/requests/new' + (qs.toString() ? '?' + qs : ''));
  };
  /** The passage a rule check relied on: the shared document preview (preview.js), highlighted on its page. */
  A['rq-quote'] = el => X.preview.open({ id: el.dataset.doc, page: el.dataset.page, quote: el.dataset.q });

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
    const names = team.map(m => personName(m.user));
    const who = team.length ? `<span class="rq-avatars">${team.slice(0, 3).map(m => avatar(personName(m.user), 'xs')).join('')}</span><span class="truncate">${esc(names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(' and '))}</span>` : '';
    return {
      title: sp.type === 'course' ? `Ask the ${sp.code || sp.name} teaching team` : `Ask ${sp.name}`, size: 'md', icon: 'message',
      desc: esc(note),
      body: `${field({ id: 'rq-ask-q', label: 'Your question', required: true, error: f.err, desc: aboutT ? esc(`About ${aboutT.name}`) : 'Say what you already tried, so they can answer in one go.', control: textarea({ id: 'rq-ask-q', bind: 'rqAsk.text', value: f.text, rows: 5, placeholder: 'What do you want to know?', invalid: !!f.err, attrs: `data-autofocus ${f.busy ? 'disabled' : ''}` }) })}
        ${tried ? `<div class="rq-ai mt-16">${ic('sparkles', 'i-sm')}<div class="grow"><div class="rq-ai__label">Sent along: what the assistant found</div><p>${esc(tried)}</p></div></div>` : ''}`,
      footStart: who,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Send question', { v: 'primary', icon: 'send', act: 'rq-ask-send', loading: f.busy, id: 'rq-ask-send' }),
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
      // What was asked sits right under "submitted": staff read it before they decide, requesters see what they sent.
      const asked = submitted ? answersList(r) : '';
      return `<div class="rq-event"><span class="rq-event__icon">${ic(icon, 'i-sm')}</span><span class="grow"><span class="medium fg">${esc(who)}</span> ${esc(text)}${stChip ? ` ${stChip}` : ''}</span><time class="rq-time" data-tip="${esc(fmtDateTime(m.at))}" datetime="${new Date(m.at).toISOString()}">${esc(rel(m.at))}</time></div>${asked}${ai}`;
    }
    const staffMsg = m.by !== r.requester, role = staffMsg ? roleLabel(sp, m.by) : '';
    const files = m.files?.length ? `<div class="rq-files">${m.files.map(x => `<span class="rq-file">${fileIcon(String(x.name).split('.').pop(), 'sm')}<span class="truncate">${esc(x.name)}</span>${x.size ? `<span class="muted">${esc(fmtSize(x.size))}</span>` : ''}</span>`).join('')}</div>` : '';
    const faqDoc = m.faqDoc && docById(m.faqDoc);
    const faq = faqDoc && !faqDoc.archived ? `<a class="rq-faq-link" href="#${faqLink(faqDoc.id, m.text)}" data-tip="${esc(faqDoc.name)}">${ic('book', 'i-sm')}<span class="truncate">${sp?.type === 'course' ? 'Added to the course FAQ' : 'Added to the FAQ'}</span></a>` : '';
    return `<article class="${cx('rq-msg', staffMsg && 'rq-msg--staff')}">${avatar(personName(m.by), 'sm')}<div class="rq-msg__body">
      <header class="rq-msg__head"><span class="medium">${esc(who)}</span>${role ? `<span class="rq-msg__role">${esc(role)}</span>` : ''}<time class="rq-time" data-tip="${esc(fmtDateTime(m.at))}" datetime="${new Date(m.at).toISOString()}">${esc(rel(m.at))}</time></header>
      ${stChip ? `<div class="rq-msg__status">${ic('arrow-right', 'i-sm')}${stChip}</div>` : ''}
      ${m.text ? `<div class="rq-msg__text">${esc(m.text).replace(/\n/g, '<br>')}</div>` : ''}${files}${faq}</div></article>`;
  }
  /** The request's own answers (form fields), as filled in by the requester. Questions are their title. */
  function answersList(r) {
    const t = typeById(r.type);
    if (!t || t.question) return '';
    const rows = (t.fields || []).map(fd => [fd.label, fmtField(fd, r.fields?.[fd.id])]);
    return rows.length ? `<dl class="rq-answers rq-answers--thread">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>` : '';
  }

  function composer(r, t, sp, { isReq, staff }) {
    if (!isOpen(r)) return closedNote(r, t, sp, isReq);
    if (!isReq && !staff) return `<div class="rq-closed">${ic('eye', 'i-sm')}<span>You can see this request, but only ${esc(sp?.name || 'its staff')} can act on it.</span></div>`;
    const c = composerState(r), data = { id: r.id };
    const first = firstName(r.requester);
    // Requesters: one Send. Staff: one Send for the note (it can ask the requester for information, which pauses the SLA), then the decision.
    let label, placeholder, decide, ask = '';
    if (isReq) {
      label = r.status === 'needs_info' ? 'Your reply' : 'Add a message';
      placeholder = r.status === 'needs_info' ? 'Answer the question above or attach what they asked for.' : `Add details for ${sp?.name || 'the office'}.`;
      // Prominent only when the office is waiting on the requester; otherwise there's nothing to do but wait.
      decide = btn(r.status === 'needs_info' ? 'Send reply' : 'Send', { v: r.status === 'needs_info' ? 'primary' : 'secondary', icon: 'send', act: 'rq-reply', data });
    } else {
      const asking = c.ask && r.status !== 'needs_info';
      ask = r.status !== 'needs_info' ? `<div class="rq-composer__ask">${checkbox({ id: 'rq-ask-info', checked: asking, act: 'rq-ask-toggle', data, label: `Ask ${esc(first)} for information <span class="muted">(pauses the SLA)</span>` })}</div>` : '';
      const send = v => btn('Send', { v, icon: 'send', act: 'rq-send-note', data });
      if (t.question) {
        label = 'Your answer'; placeholder = asking ? `What do you need from ${first}?` : `Answer ${first}. Cite the slide or document if you can.`;
        decide = asking ? send('primary') : btn('Answer', { v: 'primary', icon: 'send', act: 'rq-answer', data });
      } else if (asking) {
        label = `Message to ${first}`; placeholder = `What do you need from ${first}?`;
        decide = send('primary');
      } else if (r.status === 'approved') {
        label = `Message to ${first}`; placeholder = 'Optional: pick-up details, next steps…';
        decide = send('secondary') + btn('Mark completed', { v: 'primary', icon: 'check', act: 'rq-complete', data });
      } else {
        label = `Message to ${first}`; placeholder = `Write to ${first}, or add a note to your decision.`;
        decide = send('secondary') + btn('Decline', { v: 'danger-soft', act: 'rq-decline', data }) + btn('Approve', { v: 'primary', icon: 'check', act: 'rq-approve', data });
      }
    }
    const files = c.files.length ? `<div class="rq-files">${c.files.map((x, i) => `<span class="rq-file">${fileIcon(String(x.name).split('.').pop(), 'sm')}<span class="truncate">${esc(x.name)}</span>${iconBtn('x', 'Remove ' + x.name, { size: 'sm', act: 'rq-file-rm', data: { id: r.id, i } })}</span>`).join('')}</div>` : '';
    const kbName = kbById(sp?.kbs?.[0])?.name;
    const faq = staff && !isReq && t.question && kbName && !c.ask ? switchRow({ title: sp?.type === 'course' ? 'Add this answer to the course FAQ' : 'Add this answer to the FAQ', desc: `Saved to ${esc(kbName)} so the assistant can answer it next time.`, on: c.faq, act: 'rq-faq', data }) : '';
    return `<div class="card rq-composer">
      ${field({ id: 'rq-text', label, error: c.err, control: textarea({ id: 'rq-text', bind: cKey(r) + '.text', value: c.text, rows: 3, placeholder, invalid: !!c.err }) })}
      ${files}${faq}${ask}
      <div class="rq-composer__actions">
        <input type="file" id="rq-file" class="sr-only" multiple data-change="rq-file" data-id="${r.id}" tabindex="-1" aria-hidden="true">
        ${iconBtn('paperclip', 'Attach a file', { act: 'rq-attach', data })}
        <div class="rq-composer__btns">${decide}</div>
      </div></div>`;
  }
  function closedNote(r, t, sp, isReq) {
    const word = { completed: t.question ? 'answered' : 'completed', declined: 'declined', withdrawn: 'withdrawn' }[r.status] || 'closed';
    const action = !isReq ? '' : t.question && r.status === 'completed' ? btn('Ask a follow-up', { size: 'sm', icon: 'message', act: 'rq-ask-staff', data: { space: r.space } })
      : r.status !== 'completed' ? btn('Send a new request', { size: 'sm', href: '/requests/new?type=' + r.type }) : '';
    return `<div class="rq-closed">${ic(r.status === 'declined' ? 'x-circle' : r.status === 'withdrawn' ? 'undo' : 'check-circle', 'i-sm')}<span class="grow">This request was ${word} ${esc(relIn(r.updated))}.</span>${action}</div>`;
  }

  function sideCards(r, t, sp, { isReq, staff }) {
    const fee = r.fee || t.fee;
    const aboutT = typeById(r.about);
    const conv = r.from && myConvs().find(c => c.id === r.from);
    // Where it was sent and when it's due are in the header; the request ID is in the breadcrumb.
    const assignee = r.assignee ? `<span class="row gap-6" style="min-width:0">${avatar(personName(r.assignee), 'xs')}<span class="truncate">${esc(r.assignee === me().id ? 'You' : personName(r.assignee))}</span></span>` : '<span class="muted">Not assigned yet</span>';
    const assignCtl = staff && isOpen(r) ? `<span class="row gap-4 none">${r.assignee !== me().id ? btn('Assign to me', { v: 'tertiary', size: 'sm', act: 'rq-assign-me', data: { id: r.id } }) : ''}${iconBtn('users', 'Assign to someone else', { size: 'sm', menu: 'rq-assign', data: { id: r.id } })}</span>` : '';
    const meta = kv([
      ['Submitted', esc(fmtDateTime(r.created))],
      ['Assignee', `<span class="rq-assignee">${assignee}${assignCtl}</span>`],
      aboutT && ['About', esc(aboutT.name)],
      conv && ['Started from', `<a class="link" href="#/chat/${conv.id}">${esc(conv.title)}</a>`],
      fee && ['Fee', esc(fee)],
    ]);
    const details = card(meta, { title: 'Details', cls: 'rq-side-card' });

    let person = '';
    if (staff && !isReq) {
      const m = memberById(r.requester), p = personaOf(r.requester)?.profile;
      const team = p?.team || (m?.groups || []).map(g => groupById(g)?.name).filter(Boolean).join(', ');
      const others = all().filter(x => x.requester === r.requester && x.id !== r.id && isOpen(x) && staffOf(x)).length;
      person = card(`<div class="rq-person">${avatar(personName(r.requester), 'lg')}<div class="grow" style="min-width:0"><div class="medium truncate">${esc(personName(r.requester))}</div><div class="t-sm muted truncate">${esc(m?.email || '')}</div></div></div>
        ${kv([team && ['Team', esc(team)], others && ['Other open', plural(others, 'request')]])}`, { title: 'Requester', cls: 'rq-side-card' });
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
      // Withdrawing is rare and ends the request: it lives in ⋯.
      actions: isReq && isOpen(r) ? iconBtn('more', 'More', { menu: 'rq-more', data: { id: r.id } }) : '',
    });
    const thread = `<section class="card rq-thread" aria-label="Activity">${r.thread.map(m => entry(r, m, sp)).join('')}</section>`;
    return `<div class="page rq-page rq-page--item">${head}<div class="rq-detail"><div class="rq-main">${thread}${composer(r, t, sp, { isReq, staff })}</div><aside class="rq-side" aria-label="Request details">${sideCards(r, t, sp, { isReq, staff })}</aside></div></div>`;
  };
  MENUS['rq-more'] = el => { const r = reqById(el.dataset.id); return r && isOpen(r) && r.requester === me().id ? [{ label: 'Withdraw request', icon: 'undo', danger: true, run: () => A['rq-withdraw']({ dataset: { id: r.id } }) }] : []; };

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
      title: 'Decline this request?', icon: 'x-circle', tone: 'danger',
      desc: `${esc(firstName(r?.requester))} sees your reason and can send a new request.`,
      body: field({ id: 'rq-decline-text', label: 'Reason', required: true, error: f.err, desc: f.err ? '' : 'Say why, and what they can do instead.', control: textarea({ id: 'rq-decline-text', bind: 'rqDecline.text', value: f.text, rows: 4, placeholder: 'For example: this needs sign-off from your manager first.', invalid: !!f.err, attrs: 'data-autofocus' }) }),
      footStart: 'You can undo this right after.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Decline request', { v: 'danger', icon: 'x-circle', act: 'rq-decline-ok', data: { id } }),
    };
  };
  A['rq-decline-ok'] = el => {
    const r = reqById(el.dataset.id), f = ui('rqDecline'); if (!r) return;
    const text = String(f.text || '').trim();
    if (!text) { f.err = 'Add a reason so the requester knows what to do next.'; refreshLayer(); $('#rq-decline-text')?.focus(); return; }
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
    const course = spaceById(r.space)?.type === 'course';
    toast(doc ? `${course ? 'Answer sent and added to the course FAQ' : 'Answer sent and added to the FAQ'}${gap ? '. 1 knowledge gap closed' : ''}` : `Answer sent to ${firstName(r.requester)}`,
      doc ? { action: { label: 'Open FAQ', run: () => go(faqLink(doc.id, text)) } } : {});
  };
  A['rq-faq'] = el => { const r = reqById(el.dataset.id); if (!r) return; const c = composerState(r); c.faq = !c.faq; refresh(); };
  A['rq-ask-toggle'] = el => { const r = reqById(el.dataset.id); if (!r) return; const c = composerState(r); c.ask = !c.ask; c.err = ''; refresh(); requestAnimationFrame(() => $('#rq-text')?.focus()); };
  /** Staff Send: a plain message, or — with "Ask … for information" ticked — a request for information that pauses the SLA. */
  A['rq-send-note'] = el => { const r = reqById(el.dataset.id); if (!r) return; (composerState(r).ask ? A['rq-askinfo'] : A['rq-reply'])(el); };
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

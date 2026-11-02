/* Home (/home): a personal start page, not a dashboard — ask (optionally
   inside one of my spaces), start a workflow or a request, what's up next,
   what needs me (space staff) and where I left off.
   Shared: X.upNext({space?, limit?, queue?}) and X.upNextList(items, {empty?}). Prefix: home-. */
(() => {
  'use strict';

  const WAITING = ['submitted', 'in_review'];
  const DUE_KINDS = ['deadline', 'quiz', 'queue'];
  const KIND_ICON = { deadline: 'clock', quiz: 'check-circle', exam: 'file-text', meeting: 'users', reply: 'message', queue: 'inbox' };
  /* Demo academic calendar until workspaces carry their own: Semester 1 of 2026–2027 starts Wed 2 Sep 2026. */
  const CAMPUS_TERM = { label: 'Semester 1', start: new Date(2026, 8, 2).getTime() };

  /* ── Time ── */
  const dayStart = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dayDiff = ts => Math.round((dayStart(ts) - dayStart(NOW)) / DAY);
  function termLine() {
    const ws = curWs();
    const term = ws.term || (wsTemplateId(ws) === 'campus' ? CAMPUS_TERM : null);
    if (!term) return '';
    const wk = Math.floor((dayStart(NOW) - dayStart(term.start)) / (7 * DAY)) + 1;
    return wk >= 1 && wk <= 22 ? `Week ${wk} of ${term.label}` : '';
  }
  /** Relative, human wording for an up-next item: "Due tomorrow, 9:00 PM", "In 3 days", "Overdue · Oct 30". */
  function when(it) {
    if (it.kind === 'reply') return { text: 'Needs your reply', tone: 'soon' };
    const due = DUE_KINDS.includes(it.kind), prefix = it.kind === 'queue' ? 'Oldest due' : 'Due', d = dayDiff(it.at);
    if (it.at < NOW) return { text: due ? `${it.kind === 'queue' ? 'Oldest overdue' : 'Overdue'} · ${fmtDate(it.at)}` : fmtDate(it.at), tone: due ? 'danger' : '' };
    const day = d <= 0 ? `today, ${fmtTime(it.at)}` : d === 1 ? `tomorrow, ${fmtTime(it.at)}` : d < 7 ? `in ${d} days` : fmtDate(it.at);
    return { text: due ? `${prefix} ${day}` : day[0].toUpperCase() + day.slice(1), tone: due && d <= 1 ? 'soon' : '' };
  }

  /* ── Up next ── */
  const typeOf = r => (D.requestTypes || []).find(t => t.id === r.type);
  function attempted(w) {
    if (X.work?.myAttempt) return !!X.work.myAttempt(w);
    const id = me().id; return (w.data?.attempts || []).some(a => a?.user === id);
  }
  function eventVisible(e) {
    const sp = e.space && spaceById(e.space);
    if (e.space && (!sp || sp.archived)) return false;
    if (e.audience === 'all') return true;
    if (e.audience === 'staff') return isSpaceStaff(sp);
    return !!spaceRole(sp);
  }
  /** The one action for an event; null = nothing left to do (e.g. quiz already taken). */
  function eventAction(e, sp) {
    const w = e.work && hasModule('work') && (D.works || []).find(x => x.id === e.work);
    if (w) {
      if (w.kind === 'quiz' && w.owner !== me().id && !isSpaceStaff(sp)) return attempted(w) ? null : { label: 'Take quiz', href: '/work/' + w.id, strong: true };
      return { label: w.owner !== me().id ? 'Open' : w.status === 'published' ? 'Results' : 'Continue', href: '/work/' + w.id };
    }
    if (e.requestType && hasModule('requests')) {
      if (isSpaceStaff(sp)) return { label: 'Review queue', href: `/space/${sp.id}?tab=queue` };
      if (me().profile) return { label: 'Start request', act: 'home-request', data: { type: e.requestType } };
    }
    const doc = e.doc && docById(e.doc);
    if (doc && canReadKb(kbById(doc.kb))) return { label: 'Open', href: '/doc/' + doc.id };
    return sp ? { label: 'Open', href: '/space/' + sp.id } : undefined;
  }
  /** What's coming up for the caller: visible events plus quizzes to take, requests waiting on them and (staff) their queues. */
  X.upNext = ({ space, limit = 6, queue = true } = {}) => {
    const out = [], inScope = id => !space || id === space, eventWorks = new Set();
    (D.events || []).forEach(e => {
      if (!inScope(e.space) || !eventVisible(e) || e.at < NOW - 2 * DAY) return;
      if (e.work) eventWorks.add(e.work);
      const sp = spaceById(e.space), action = eventAction(e, sp);
      if (action === null) return;
      out.push({ id: e.id, title: e.title, at: e.at, space: e.space, kind: e.kind, action });
    });
    if (hasModule('work')) (D.works || []).forEach(w => {
      const sp = spaceById(w.space);
      if (w.kind !== 'quiz' || w.status !== 'published' || w.visibility !== 'space' || eventWorks.has(w.id) || !inScope(w.space)) return;
      if (!sp || sp.archived || !spaceRole(sp) || isSpaceStaff(sp) || w.owner === me().id || attempted(w)) return;
      out.push({ id: 'quiz-' + w.id, title: w.title, at: w.due || w.published || w.updated, space: w.space, kind: 'quiz', action: { label: 'Take quiz', href: '/work/' + w.id, strong: true } });
    });
    if (hasModule('requests')) {
      (D.svcRequests || []).filter(r => r.requester === me().id && r.status === 'needs_info' && inScope(r.space)).forEach(r =>
        out.push({ id: 'req-' + r.id, title: typeOf(r)?.name || 'Request', at: r.updated, space: r.space, kind: 'reply', action: { label: 'Reply', href: '/requests/' + r.id, strong: true } }));
      if (queue) (D.spaces || []).filter(sp => !sp.archived && inScope(sp.id) && isSpaceStaff(sp)).forEach(sp => {
        const open = (D.svcRequests || []).filter(r => r.space === sp.id && WAITING.includes(r.status));
        if (!open.length) return;
        const oldest = open.reduce((a, b) => ((a.due || a.created) <= (b.due || b.created) ? a : b));
        const questions = open.every(r => typeOf(r)?.question);
        out.push({ id: 'queue-' + sp.id, title: `${plural(open.length, questions ? 'question' : 'request')} waiting`, at: oldest.due || oldest.created, space: sp.id, kind: 'queue', action: { label: 'Review queue', href: `/space/${sp.id}?tab=queue` } });
      });
    }
    return out.sort((a, b) => (b.kind === 'reply') - (a.kind === 'reply') || a.at - b.at).slice(0, limit);
  };
  /** List of up-next items, each with one action. Pass {space} to drop the space name (inside a space page). */
  X.upNextList = (items, { empty, space } = {}) => {
    if (!items.length) return empty ?? emptyState({ icon: 'calendar', title: 'You’re all caught up', desc: 'Deadlines, quizzes and requests that need you show up here.', compact: true, boxed: true });
    return list(items.map(it => {
      const w = when(it), sp = !space && it.space && spaceById(it.space), a = it.action;
      const desc = `<span class="${cx('home-when', w.tone && 'home-when--' + w.tone)}" title="${esc(fmtDateTime(it.at))}">${esc(w.text)}</span>${sp ? ` · ${esc(sp.name)}` : ''}`;
      const trail = a ? btn(a.label, { v: a.strong ? 'secondary' : 'tertiary', size: 'sm', href: a.href, act: a.act, data: a.data }) : '';
      return item({ lead: itemIcon(KIND_ICON[it.kind] || 'calendar', w.tone === 'danger' ? 'danger' : w.tone === 'soon' ? 'warning' : '', 'sm'), title: esc(it.title), desc, trail });
    }), 'home-upnext');
  };

  /* ── Home ── */
  const callName = n => { const p = String(n || '').trim().split(/\s+/); return p.length >= 3 ? p[p.length - 1] : p[0]; };
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
  function askBox(f, mine) {
    const ws = curWs(), sp = f.space && spaceById(f.space);
    const ph = sp ? `Ask about ${sp.name}` : `Ask anything — answers come from ${ws.name} knowledge`;
    const scope = mine.length ? select({ id: 'home-scope', value: f.space, change: 'home-scope', size: 'sm', label: 'Answer from', cls: 'home-ask__scope', options: [['', `All of ${ws.name}`], ...mine.map(s => [s.id, s.name])] }) : '';
    return `<div class="home-ask">${ic('sparkles', 'home-ask__icon')}${input({ id: 'home-q', bind: 'home.q', value: f.q, placeholder: ph, onEnter: 'home-ask', cls: 'home-ask__input', autofocus: true, attrs: 'aria-label="Ask a question"' })}<div class="home-ask__end">${scope}${btn('', { v: 'primary', icon: 'arrow-up', tip: 'Ask', act: 'home-ask', cls: 'home-ask__send' })}</div></div>`;
  }
  function quickStarts() {
    const out = (hasModule('work') ? workflowsFor() : []).map(w => btn(w.label, { size: 'sm', icon: w.icon, act: 'home-work', data: { workflow: w.id } }));
    if (hasModule('requests')) out.push(btn('Start a request', { size: 'sm', icon: 'clipboard', act: 'home-request' }));
    return out.length ? `<div class="home-starts" role="group" aria-label="Start something">${out.join('')}</div>` : '';
  }
  /** Space staff and admins: what's waiting on them. */
  function needsYou() {
    const staffSpaces = (D.spaces || []).filter(sp => !sp.archived && isSpaceStaff(sp));
    if (!staffSpaces.length && !isAdmin()) return '';
    const ids = new Set(staffSpaces.map(s => s.id));
    const open = hasModule('requests') ? (D.svcRequests || []).filter(r => ids.has(r.space) && WAITING.includes(r.status)) : [];
    const qs = open.filter(r => typeOf(r)?.question).length, rs = open.length - qs;
    const drafts = hasModule('work') ? (D.works || []).filter(w => w.owner === me().id && w.status === 'draft') : [];
    const need = (icon, tone, text, sub, to) => `<a class="home-need" href="#${to}">${itemIcon(icon, tone, 'sm')}<span class="stack home-need__text"><span class="home-need__label">${text}</span>${sub ? `<span class="home-need__sub truncate">${esc(sub)}</span>` : ''}</span>${ic('chevron-right', 'i-sm home-need__chev')}</a>`;
    const spaceNames = pred => [...new Set(open.filter(pred).map(r => spaceById(r.space)?.name).filter(Boolean))].join(', ');
    const items = [
      rs && need('clipboard', 'accent', `${plural(rs, 'request')} in your queue`, spaceNames(r => !typeOf(r)?.question), '/requests?tab=queue'),
      qs && need('message', 'accent', `${plural(qs, 'question')} waiting`, spaceNames(r => typeOf(r)?.question), '/requests?tab=queue'),
      drafts.length && need('pencil', '', `${plural(drafts.length, 'draft')} not published`, drafts.length === 1 ? drafts[0].title : '', drafts.length === 1 ? '/work/' + drafts[0].id : '/work'),
    ].filter(Boolean);
    return items.length ? `<section class="home-needs" aria-label="Needs you"><h2 class="home-label">Needs you</h2><div class="home-needs__row">${items.join('')}</div></section>` : '';
  }
  function continueRows() {
    const works = hasModule('work') ? (X.worksVisible ? X.worksVisible() : D.works || []).filter(w => w.owner === me().id) : [];
    const rows = [
      ...works.map(w => ({ t: w.updated, html: () => {
        const sp = spaceById(w.space), kind = WORK_KINDS[w.kind]?.label || WORKFLOWS[w.workflow]?.label || 'Work';
        const icon = X.workIcon?.(w.kind) || WORKFLOWS[w.workflow]?.icon || 'sparkles';
        return item({ lead: itemIcon(icon, 'accent', 'sm'), title: esc(w.title), titleExtra: w.status === 'draft' ? chip('Draft', { size: 'sm' }) : '', desc: [kind, sp?.name].filter(Boolean).map(esc).join(' · '), meta: esc(rel(w.updated)), href: '/work/' + w.id });
      } })),
      ...myConvs().map(c => ({ t: c.at, html: () => {
        const sp = c.space && spaceById(c.space);
        return item({ lead: itemIcon('message', '', 'sm'), title: esc(c.title), desc: sp ? `Chat · ${esc(sp.name)}` : 'Chat', meta: esc(rel(c.at)), href: '/chat/' + c.id });
      } })),
    ];
    return rows.sort((a, b) => b.t - a.t).slice(0, 5).map(r => r.html());
  }
  const upEmpty = () => emptyState({ icon: 'calendar', title: 'You’re all caught up', desc: 'Deadlines and anything waiting on you from your spaces show up here.', compact: true, boxed: true });
  const contEmpty = () => emptyState({ icon: 'message', title: 'Nothing to continue yet', desc: 'Your conversations and work show up here. Ask a question to get started.', compact: true, boxed: true });

  P.home = () => {
    const f = ui('home', { q: '', space: '' });
    const mine = hasModule('spaces') ? mySpaces() : [];
    if (f.space && !mine.some(s => s.id === f.space)) f.space = '';
    const date = new Date(NOW).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const head = `<header class="home-head"><p class="home-date">${esc([date, termLine()].filter(Boolean).join(' · '))}</p><h1 class="home-title">${esc(greeting())}, ${esc(callName(me().name))}</h1></header>`;
    const needs = needsYou();
    const up = X.upNext({ limit: 6, queue: !needs });
    const showUp = up.length > 0 || mine.length > 0;
    const grid = inner => `<div class="${cx('home-grid', !showUp && 'home-grid--single')}">${inner}</div>`;
    const body = gate({
      loading: () => `<div class="home-grid">${skelRows(4)}${skelRows(4)}</div>`,
      empty: () => grid(`${showUp ? section('Up next', upEmpty()) : ''}${section('Continue', contEmpty())}`),
      ok: () => {
        const cont = continueRows();
        return grid(`${showUp ? section('Up next', X.upNextList(up, { empty: upEmpty() })) : ''}
          ${section('Continue', cont.length ? list(cont) : contEmpty(), { actions: cont.length ? linkBtn('All conversations', { href: '/chats' }) : '' })}`);
      },
    });
    return `<div class="page home">${head}${askBox(f, mine)}${quickStarts()}${S.pageState === 'live' && !S.navLoading ? needs : ''}${body}</div>`;
  };

  A['home-scope'] = el => { ui('home').space = el.value; refresh(); $('#home-q')?.focus(); };
  A['home-ask'] = () => {
    const f = ui('home'), q = (f.q || '').trim();
    if (!q) { $('#home-q')?.focus(); return; }
    const space = f.space || undefined; f.q = '';
    if (A['chat-ask']) A['chat-ask']({ dataset: { q, space } }); else go('/chat');
  };
  A['home-work'] = el => {
    const workflow = el.dataset.workflow, sp = spaceById(ui('home').space);
    const space = sp && workflowsFor(sp).some(w => w.id === workflow) ? sp.id : undefined;
    if (A['work-start']) A['work-start']({ dataset: { workflow, space } });
    else go(`/work/new?workflow=${workflow}${space ? '&space=' + space : ''}`);
  };
  A['home-request'] = el => {
    const type = el?.dataset?.type;
    if (A['rq-new']) A['rq-new']({ dataset: { type } }); else go('/requests/new' + (type ? '?type=' + type : ''));
  };
})();

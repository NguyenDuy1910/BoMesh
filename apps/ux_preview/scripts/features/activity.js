/* Activity: workspace changes and sign-ins (/activity?tab=changes|signins).
   Also owns the one audit-log builder shared with the platform Audit log (X.auditLog):
   the same toolbar (search · time window · filters, one Filters popover on phones), the same
   table (What happened · Person · [Workspace] · When) and the same event drawer
   (facts, Technical details folded, the related object as the primary action). */
(() => {
  'use strict';

  /* ═══════════════ Shared audit-log builders ═══════════════ */
  const WIN_OPTS = [['1', '24 hours'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
  const full = ts => new Date(ts).toLocaleString(uiLocale(), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const sysAv = size => `<span class="avatar avatar--default avatar--${size} act-sys" aria-hidden="true">${ic('zap', 'i-xs')}</span>`;
  /** Actor avatar: 'system'/'BoMesh' is the product itself. */
  const whoAv = (name, size = 'sm') => (name === 'BoMesh' ? sysAv(size) : avatar(name, size));
  const inWindow = (uiKey, at) => Date.now() - at <= +(ui(uiKey).win || '30') * DAY;
  const whenCell = ts => `<td class="table__cell muted"><span class="act-when" data-tip="${esc(full(ts))}">${rel(ts)}</span></td>`;

  /** Search, time window and filters. On phones the window and filters fold into one "Filters" sheet. */
  function toolbar({ uiKey, placeholder, filters, count }) {
    const u = ui(uiKey), fields = filters.map(f => f[1]), set = fields.filter(f => u[f]).length + ((u.win || '30') !== '30' ? 1 : 0);
    const inline = filters.map(([label, field, opts]) => filterButton(label, uiKey, field, opts)).join('');
    const sheet = `<button type="button" class="${cx('filter-button act-filters-btn', set && 'is-set')}" data-popover="audit-filters" data-ui="${uiKey}" aria-haspopup="dialog">${ic('filter')}${set ? `Filters · ${set}` : 'Filters'}${ic('chevron-down')}</button>`;
    const win = seg({ value: u.win || '30', options: WIN_OPTS, act: 'audit-win', data: { ui: uiKey }, label: 'Time window' });
    return `<div class="toolbar act-toolbar">${searchField({ uiKey, placeholder })}${win}<span class="act-filters">${inline}</span>${sheet}${clearFilters(uiKey, fields)}${count ? `<span class="toolbar__end t-sm muted num">${count}</span>` : ''}</div>`;
  }
  /* The window and filters of the toolbar that opened it, as one sheet (a bottom sheet on phones). */
  const FILTERS = {};
  const optGroup = (uiKey, label, field, opts, cur) => `<fieldset class="act-sheet__group"><legend class="act-sheet__label">${esc(label)}</legend><div class="act-sheet__opts">${opts.map(([v, l]) => `<button type="button" class="act-sheet__opt" aria-pressed="${cur === v}" data-act="audit-filter" data-ui="${uiKey}" data-field="${field}" data-value="${esc(v)}">${esc(l)}</button>`).join('')}</div></fieldset>`;
  PO['audit-filters'] = el => {
    const uiKey = el.dataset.ui, u = ui(uiKey), filters = FILTERS[uiKey] || [];
    const body = optGroup(uiKey, 'Time window', 'win', WIN_OPTS, u.win || '30') + filters.map(([label, field, opts]) => optGroup(uiKey, label, field, [['', 'Any'], ...opts], u[field] || '')).join('');
    return { title: 'Filters', body: `<div class="act-sheet">${body}</div>`, foot: btn('Reset', { v: 'ghost', size: 'sm', act: 'audit-sheet-reset', data: { ui: uiKey } }) };
  };
  A['audit-filter'] = el => { const u = ui(el.dataset.ui); u[el.dataset.field] = el.dataset.value; u.page = 1; refresh(); refreshLayer(); };
  A['audit-win'] = el => { const u = ui(el.dataset.ui); u.win = el.dataset.value; u.page = 1; refresh(); };
  A['audit-sheet-reset'] = el => { const uiKey = el.dataset.ui, u = ui(uiKey); (FILTERS[uiKey] || []).forEach(f => (u[f[1]] = '')); u.win = '30'; u.page = 1; refresh(); refreshLayer(); };

  /** Read as a sentence: what happened (to what), who did it, [where], when. Only failures carry an outcome mark. */
  function table({ rows, uiKey, label, who, where, open, per = 15 }) {
    const page = paginate(rows, uiKey, per);
    const head = th('What happened') + sortHead('Person', 'actor', uiKey) + (where ? th('Workspace', 'hide-md') : '') + sortHead('When', 'at', uiKey);
    const trs = page.map(ev => `<tr class="table__row" data-act="${open}" data-id="${esc(ev.id)}" tabindex="0">
      <td class="table__cell table__cell--primary"><span class="stack act-what"><span class="row gap-6"><span class="cell-title truncate">${esc(ev.action)}</span>${ev.outcome === 'failure' ? status('outcome', ev.outcome) : ''}</span><span class="cell-sub truncate">${esc(ev.target)}</span></span></td>
      <td class="table__cell"><span class="row gap-8">${whoAv(who(ev))}<span class="truncate">${esc(who(ev))}</span></span></td>
      ${where ? `<td class="table__cell hide-md table__cell--hide-sm">${where(ev)}</td>` : ''}
      ${whenCell(ev.at)}</tr>`);
    return table_({ head, rows: trs, label }) + pager(rows.length, uiKey, per);
  }
  const table_ = o => window.table(o);
  /** Sort the way the table says: newest first unless a column sort is set. */
  const sorted = (rows, uiKey, who) => (ui(uiKey).sort ? applySort(rows, uiKey, { at: e => e.at, actor: e => who(e) }) : [...rows].sort((a, b) => b.at - a.at));
  /** Event drawer: the person and action are its title line; facts add what the row didn't say. */
  function drawer({ ev, who, area, where = '', related }) {
    ui('actEv', { tech: false });
    const body = `<section class="drawer__section">${kv([
      ['Target', esc(ev.target)],
      ['Area', esc(area)],
      where && ['Workspace', where],
      ['Outcome', status('outcome', ev.outcome)],
      ['Time', esc(full(ev.at))],
    ])}</section><section class="drawer__section">${disclosure({ path: 'actEv.tech', icon: 'info', title: 'Technical details', body: kv([
      ['Event ID', `<span class="row gap-4"><span class="mono t-sm">${esc(ev.id)}</span>${iconBtn('copy', 'Copy event ID', { size: 'sm', act: 'copy', cls: 'act-copy', data: { text: ev.id, msg: 'Event ID copied' } })}</span>`],
      ['IP address', `<span class="mono t-sm">${esc(ev.ip || '—')}</span>`],
      ['Device', esc(ev.device || '—')],
    ]) })}</section>`;
    return {
      title: ev.action, desc: `${esc(who)} · ${rel(ev.at)}`, lead: whoAv(who, 'lg'), body,
      foot: related ? btn(related.label, { v: 'primary', iconRight: 'arrow-right', act: related.act, data: related.data }) : '',
    };
  }
  /** Header actions: Export as a button; on phones it moves into a ⋯ menu so content comes first. */
  const exportActions = (act, live) => btn('Export CSV', { icon: 'download', act, disabled: !live, tip: live ? '' : 'Available once the log has loaded', cls: 'act-export-wide' })
    + iconBtn('more', 'More actions', { menu: 'audit-more', data: { act }, cls: 'act-export-menu' });
  MENUS['audit-more'] = el => [{ label: 'Export CSV', icon: 'download', run: () => A[el.dataset.act]?.() }];

  X.auditLog = {
    toolbar: (o) => { FILTERS[o.uiKey] = o.filters; return toolbar(o); },
    table, drawer, sorted, inWindow, exportActions, whoAv,
    reset: (uiKey, fields) => { const u = ui(uiKey); fields.forEach(f => (u[f] = '')); u.q = ''; u.win = '30'; u.page = 1; },
  };

  /* ═══════════════ Workspace Activity ═══════════════ */
  STATUS.signin = { active: ['success', 'Active now', 'soft', 1], ended: ['default', 'Ended', 'tertiary'], blocked: ['danger', 'Blocked'] };
  /** Areas in the order people think about them; any other area found in the log is appended. Sign-ins have their own tab. */
  const AREA_ORDER = ['Knowledge', 'Sources', 'Spaces', 'Work', 'Requests', 'People', 'Settings'];
  const isChange = e => e.type !== 'Sign-in';
  function areas() {
    const seen = new Set(D.audit.filter(isChange).map(e => e.type));
    return [...AREA_ORDER.filter(a => seen.has(a)), ...[...seen].filter(a => !AREA_ORDER.includes(a)).sort()];
  }
  const actor = e => (e.actor === 'system' ? 'BoMesh' : actorName(e.actor));

  function events() {
    const u = ui('actC');
    const rows = D.audit.filter(e => isChange(e) && inWindow('actC', e.at) && (!u.area || e.type === u.area) && (!u.actor || e.actor === u.actor) && (!u.outcome || e.outcome === u.outcome) && matchesQ('actC', actor(e), e.action, e.target));
    return sorted(rows, 'actC', actor);
  }
  function signins() {
    const u = ui('actS');
    const rows = D.signins.filter(s => inWindow('actS', s.at) && (!u.method || s.method === u.method) && (!u.st || s.status === u.st) && matchesQ('actS', actorName(s.user), s.device, s.method));
    return u.sort ? applySort(rows, 'actS', { at: s => s.at, actor: s => actorName(s.user) }) : [...rows].sort((a, b) => b.at - a.at);
  }
  const noEvents = (uiKey, fields, what) => emptyState({ icon: 'search', boxed: true, compact: true, title: `No ${what} match`, desc: 'Try a longer time window or clear the filters.', actions: btn('Reset filters', { act: 'act-reset', data: { ui: uiKey, fields: fields.join(',') } }) });
  /** The shared list-tools rule (core needsTools), plus a non-default time window counts as "in use". */
  const needsTools = (n, uiKey, fields) => window.needsTools(n, uiKey, fields) || (ui(uiKey).win || '30') !== '30';

  P.activity = ({ query }) => {
    const tab = query.tab === 'signins' ? 'signins' : 'changes';
    const live = S.pageState === 'live' && !S.navLoading;
    const head = pageHeader({ title: 'Activity', desc: `Who changed what in ${esc(curWs().name)}, and who signed in.`, actions: exportActions('act-export', live) });
    const t = tabs([{ id: 'changes', label: 'Changes' }, { id: 'signins', label: 'Sign-ins' }], tab, '/activity');
    return `<div class="page">${head}<div class="page-tabs">${t}</div>${tab === 'signins' ? signinsTab() : changesTab()}</div>`;
  };

  function changesTab() {
    ui('actC', { q: '', win: '30', area: '', actor: '', outcome: '', page: 1 });
    const rows = events(); const live = !S.navLoading && S.pageState === 'live';
    const people = [['system', 'BoMesh'], ...[...D.members].sort((a, b) => a.name.localeCompare(b.name)).map(m => [m.id, m.name])];
    const filters = [['Person', 'actor', people], ['Area', 'area', areas().map(a => [a, a])], ['Outcome', 'outcome', [['success', 'Succeeded'], ['failure', 'Failed']]]];
    const fields = filters.map(f => f[1]);
    const tools = needsTools(D.audit.length, 'actC', fields) ? X.auditLog.toolbar({ uiKey: 'actC', placeholder: 'Search activity', filters, count: live ? plural(rows.length, 'event') : '' }) : '';
    return tools + gate({
      empty: () => emptyState({ icon: 'activity', boxed: true, title: 'No activity yet', desc: 'Changes to knowledge, sources, people and settings show up here.' }),
      ok: () => (rows.length ? table({ rows, uiKey: 'actC', label: 'Workspace changes', who: actor, open: 'act-open' }) : noEvents('actC', fields, 'events')),
    });
  }

  function signinsTab() {
    ui('actS', { q: '', win: '30', method: '', st: '', page: 1 });
    const rows = signins(); const live = !S.navLoading && S.pageState === 'live';
    const filters = [['Method', 'method', [...new Set(D.signins.map(s => s.method))].map(m => [m, m])], ['Status', 'st', [['active', 'Active now'], ['ended', 'Ended'], ['blocked', 'Blocked']]]];
    const fields = filters.map(f => f[1]);
    const tools = needsTools(D.signins.length, 'actS', fields) ? X.auditLog.toolbar({ uiKey: 'actS', placeholder: 'Search sign-ins', filters, count: live ? plural(rows.length, 'sign-in') : '' }) : '';
    const open = can('user.manage');
    return tools + gate({
      empty: () => emptyState({ icon: 'key', boxed: true, title: 'No sign-ins yet', desc: 'Each sign-in to this workspace shows up here.' }),
      ok: () => {
        if (!rows.length) return noEvents('actS', fields, 'sign-ins');
        const page = paginate(rows, 'actS', 15);
        /* Who, how (method and device), when; status only when it isn't the usual "Ended". */
        const head = sortHead('Person', 'actor', 'actS') + th('Method') + sortHead('Signed in', 'at', 'actS');
        const trs = page.map(s => {
          const rowAct = open && memberById(s.user) ? `data-act="member-open" data-id="${s.user}" tabindex="0"` : '';
          return `<tr class="table__row act-signin" ${rowAct}>
            <td class="table__cell table__cell--primary"><span class="row gap-8">${avatar(actorName(s.user), 'sm')}<span class="cell-title truncate">${esc(actorName(s.user))}</span>${s.status !== 'ended' ? status('signin', s.status) : ''}</span></td>
            <td class="table__cell"><span class="act-how"><span class="truncate">${esc(s.method)}</span><span class="cell-sub truncate">${esc(s.device)}</span></span></td>
            ${whenCell(s.at)}</tr>`;
        });
        return window.table({ head, rows: trs, label: 'Sign-ins' }) + pager(rows.length, 'actS', 15);
      },
    });
  }

  A['act-reset'] = el => { X.auditLog.reset(el.dataset.ui, el.dataset.fields.split(',')); refresh(); };
  A['act-export'] = () => {
    const iso = ts => new Date(ts).toISOString();
    if (S.cur.query.tab === 'signins') {
      const rows = signins();
      saveCsv('workspace-sign-ins.csv', [['Signed in', 'Person', 'Method', 'Device', 'Status'], ...rows.map(s => [iso(s.at), actorName(s.user), s.method, s.device, s.status])], `Exported ${plural(rows.length, 'sign-in')}`);
    } else {
      const rows = events();
      saveCsv('workspace-activity.csv', [['When', 'Event ID', 'Person', 'Area', 'Action', 'Target', 'Outcome', 'IP address', 'Device'], ...rows.map(e => [iso(e.at), e.id, actor(e), e.type, e.action, e.target, e.outcome, e.ip, e.device])], `Exported ${plural(rows.length, 'event')}`);
    }
  };

  /* ── Event drawer ── */
  A['act-open'] = el => openDrawer('act-event', { id: el.dataset.id });
  /** Where an event's target lives, if it still exists. Every area that has objects links to them. */
  function related(ev) {
    const later = fn => () => setTimeout(fn, 80);
    const t = ev.target;
    switch (ev.type) {
      case 'Knowledge': {
        const kb = D.kbs.find(k => k.name === t); if (kb) return { label: `Open ${kb.name}`, to: canEditKb(kb) ? kbManageHref(kb) : kbHref(kb) };
        const d = D.docs.find(x => x.name === t); if (d) return { label: 'Open document', to: '/doc/' + d.id };
        return null;
      }
      case 'Sources': { const s = D.sources.find(x => x.name === t); return s ? { label: `Open ${s.name}`, to: '/sources', then: later(() => A['src-open']?.({ dataset: { id: s.id } })) } : null; }
      case 'People': {
        const m = D.members.find(x => x.name === t || x.email === t); if (m) return { label: `View ${m.name}`, to: '/people?tab=members', then: later(() => A['member-open']?.({ dataset: { id: m.id } })) };
        const g = D.groups.find(x => x.name === t); if (g) return { label: `Open ${g.name}`, to: '/people?tab=groups', then: later(() => A['ppl-group-open']?.({ dataset: { id: g.id } })) };
        const r = D.roles.find(x => x.name === t); if (r) return { label: `Open ${r.name}`, run: () => A['ppl-role-show']?.({ dataset: { id: r.id } }) };
        if (t.includes('→')) return { label: 'Open access requests', to: '/people?tab=requests' };
        return null;
      }
      case 'Requests': {
        if (!hasModule('requests')) return null;
        /* Request events read "<request type> — <requester>" (requests.js audit). */
        const [kind, who] = t.split(' — ');
        const r = who && (D.svcRequests || []).find(x => actorName(x.requester) === who && (D.requestTypes || []).find(y => y.id === x.type)?.name.startsWith(kind));
        if (r) return { label: `Open ${r.id}`, to: '/requests/' + r.id };
        return { label: 'Open requests', to: '/requests' };
      }
      case 'Work': { const w = hasModule('work') && (D.works || []).find(x => x.title === t); return w ? { label: 'Open work', to: '/work/' + w.id } : null; }
      case 'Spaces': { const sp = hasModule('spaces') && (D.spaces || []).find(x => x.name === t); return sp ? { label: `Open ${sp.name}`, to: '/space/' + sp.id } : null; }
      case 'Settings':
        if (t === 'Assistant' || t === 'Assistant setup') return { label: 'Open assistant', to: '/assistant' };
        return { label: 'Open settings', to: /setup|template|module|space type|workflow/i.test(ev.action) ? '/settings?tab=setup' : '/settings' };
      default: return null;
    }
  }
  DR['act-event'] = ({ id }) => {
    const ev = D.audit.find(e => e.id === id);
    if (!ev) return { title: 'Event not found', body: emptyState({ icon: 'activity', title: 'This event is no longer in the log', compact: true }) };
    const to = related(ev);
    return drawer({ ev, who: actor(ev), area: ev.type, related: to && { label: to.label, act: 'act-related', data: { id } } });
  };
  A['act-related'] = el => {
    const ev = D.audit.find(e => e.id === el.dataset.id); const r = ev && related(ev); if (!r) return;
    closeDrawer();
    if (r.run) return r.run();
    go(r.to); r.then?.();
  };
})();

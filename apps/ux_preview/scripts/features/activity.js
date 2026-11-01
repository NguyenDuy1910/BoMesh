/* Activity: workspace changes and sign-ins (/activity?tab=changes|signins). */
(() => {
  'use strict';

  const WIN = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
  const WIN_OPTS = [['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
  const AREAS = ['Knowledge', 'Sources', 'People & access', 'Settings', 'Sign-in'];
  STATUS.signin = { active: ['success', 'Active now', 'soft', 1], ended: ['default', 'Ended', 'tertiary'], blocked: ['danger', 'Blocked'] };

  const full = ts => new Date(ts).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const actorAv = (id, size = 'sm') => id === 'system' ? `<span class="avatar avatar--default avatar--${size} act-sys" aria-hidden="true">${ic('zap', 'i-xs')}</span>` : avatar(actorName(id), size);
  const since = u => Date.now() - WIN[u.win || '30d'];
  const winSeg = uiKey => seg({ value: ui(uiKey).win, options: WIN_OPTS, act: 'act-win', data: { ui: uiKey }, label: 'Time window' });
  const whenCell = ts => `<td class="table__cell muted"><span class="act-when" title="${esc(full(ts))}">${rel(ts)}</span></td>`;

  function events() {
    const u = ui('actC'); const from = since(u);
    const rows = D.audit.filter(e => e.at >= from && (!u.area || e.type === u.area) && (!u.actor || e.actor === u.actor) && (!u.outcome || e.outcome === u.outcome) && matchesQ('actC', actorName(e.actor), e.action, e.target));
    return u.sort ? applySort(rows, 'actC', { at: e => e.at, actor: e => actorName(e.actor) }) : [...rows].sort((a, b) => b.at - a.at);
  }
  function signins() {
    const u = ui('actS'); const from = since(u);
    const rows = D.signins.filter(s => s.at >= from && (!u.method || s.method === u.method) && (!u.st || s.status === u.st) && matchesQ('actS', actorName(s.user), s.device, s.method));
    return u.sort ? applySort(rows, 'actS', { at: s => s.at, actor: s => actorName(s.user) }) : [...rows].sort((a, b) => b.at - a.at);
  }
  const noEvents = (uiKey, fields, what) => emptyState({ icon: 'search', boxed: true, compact: true, title: `No ${what} match`, desc: 'Try a longer time window or clear the filters.', actions: btn('Reset filters', { act: 'act-reset', data: { ui: uiKey, fields: fields.join(',') } }) });

  P.activity = ({ query }) => {
    const tab = query.tab === 'signins' ? 'signins' : 'changes';
    const live = S.pageState === 'live' && !S.navLoading;
    const head = pageHeader({ title: 'Activity', actions: btn('Export CSV', { icon: 'download', act: 'act-export', disabled: !live }) });
    const t = tabs([{ id: 'changes', label: 'Changes' }, { id: 'signins', label: 'Sign-ins' }], tab, '/activity');
    return `<div class="page">${head}<div class="page-tabs">${t}</div>${tab === 'signins' ? signinsTab() : changesTab()}</div>`;
  };

  function changesTab() {
    ui('actC', { q: '', win: '30d', area: '', actor: '', outcome: '', page: 1 });
    const rows = events(); const live = !S.navLoading && S.pageState === 'live';
    const people = [['system', 'BoMesh'], ...[...D.members].sort((a, b) => a.name.localeCompare(b.name)).map(m => [m.id, m.name])];
    const fields = ['area', 'actor', 'outcome'];
    const toolbar = `<div class="toolbar act-toolbar">${searchField({ uiKey: 'actC', placeholder: 'Search activity' })}${winSeg('actC')}${filterButton('Area', 'actC', 'area', AREAS.map(a => [a, a]))}${filterButton('Person', 'actC', 'actor', people)}${filterButton('Outcome', 'actC', 'outcome', [['success', 'Succeeded'], ['failure', 'Failed']])}${clearFilters('actC', fields)}${live ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'event')}</span>` : ''}</div>`;
    return toolbar + gate({
      empty: () => emptyState({ icon: 'activity', boxed: true, title: 'No activity yet', desc: 'Changes to knowledge, sources, people and settings show up here.' }),
      ok: () => {
        if (!rows.length) return noEvents('actC', fields, 'events');
        const page = paginate(rows, 'actC', 15);
        const head = sortHead('When', 'at', 'actC') + sortHead('Person', 'actor', 'actC') + th('Action') + th('Target', 'hide-md') + th('Outcome');
        const trs = page.map(ev => `<tr class="table__row" data-act="act-open" data-id="${ev.id}" tabindex="0">
          ${whenCell(ev.at)}
          <td class="table__cell"><span class="row gap-8">${actorAv(ev.actor)}<span class="truncate">${esc(actorName(ev.actor))}</span></span></td>
          <td class="table__cell table__cell--primary"><span class="cell-title">${esc(ev.action)}</span><span class="cell-sub only-sm"> · ${esc(ev.target)}</span></td>
          <td class="table__cell hide-md muted"><span class="act-target truncate">${esc(ev.target)}</span></td>
          <td class="table__cell">${status('outcome', ev.outcome)}</td></tr>`);
        return table({ head, rows: trs, label: 'Workspace changes' }) + pager(rows.length, 'actC', 15);
      },
    });
  }

  function signinsTab() {
    ui('actS', { q: '', win: '30d', method: '', st: '', page: 1 });
    const rows = signins(); const live = !S.navLoading && S.pageState === 'live';
    const fields = ['method', 'st'];
    const methods = [...new Set(D.signins.map(s => s.method))].map(m => [m, m]);
    const toolbar = `<div class="toolbar act-toolbar">${searchField({ uiKey: 'actS', placeholder: 'Search sign-ins' })}${winSeg('actS')}${filterButton('Method', 'actS', 'method', methods)}${filterButton('Status', 'actS', 'st', [['active', 'Active now'], ['ended', 'Ended'], ['blocked', 'Blocked']])}${clearFilters('actS', fields)}${live ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'sign-in')}</span>` : ''}</div>`;
    const open = can('user.manage');
    return toolbar + gate({
      empty: () => emptyState({ icon: 'key', boxed: true, title: 'No sign-ins yet', desc: 'Each sign-in to this workspace shows up here.' }),
      ok: () => {
        if (!rows.length) return noEvents('actS', fields, 'sign-ins');
        const page = paginate(rows, 'actS', 15);
        const head = sortHead('Person', 'actor', 'actS') + th('Method') + th('Device', 'hide-md') + sortHead('Signed in', 'at', 'actS') + th('Status');
        const trs = page.map(s => {
          const rowAct = open && memberById(s.user) ? `data-act="member-open" data-id="${s.user}" tabindex="0"` : '';
          return `<tr class="table__row" ${rowAct}>
            <td class="table__cell table__cell--primary"><span class="row gap-8">${avatar(actorName(s.user), 'sm')}<span class="cell-title truncate">${esc(actorName(s.user))}</span></span></td>
            <td class="table__cell muted">${esc(s.method)}</td>
            <td class="table__cell hide-md muted">${esc(s.device)}</td>
            ${whenCell(s.at)}
            <td class="table__cell">${status('signin', s.status)}</td></tr>`;
        });
        return table({ head, rows: trs, label: 'Sign-ins' }) + pager(rows.length, 'actS', 15);
      },
    });
  }

  A['act-win'] = el => { const u = ui(el.dataset.ui); u.win = el.dataset.value; u.page = 1; refresh(); };
  A['act-reset'] = el => { const u = ui(el.dataset.ui); el.dataset.fields.split(',').forEach(f => (u[f] = '')); u.q = ''; u.win = '30d'; u.page = 1; refresh(); };
  A['act-export'] = () => {
    const iso = ts => new Date(ts).toISOString();
    if (S.cur.query.tab === 'signins') {
      const rows = signins();
      saveCsv('workspace-sign-ins.csv', [['Signed in', 'Person', 'Method', 'Device', 'Status'], ...rows.map(s => [iso(s.at), actorName(s.user), s.method, s.device, s.status])], `Exported ${plural(rows.length, 'sign-in')}`);
    } else {
      const rows = events();
      saveCsv('workspace-activity.csv', [['When', 'Event ID', 'Person', 'Area', 'Action', 'Target', 'Outcome', 'IP address', 'Device'], ...rows.map(e => [iso(e.at), e.id, actorName(e.actor), e.type, e.action, e.target, e.outcome, e.ip, e.device])], `Exported ${plural(rows.length, 'event')}`);
    }
  };

  /* ── Event drawer ── */
  A['act-open'] = el => openDrawer('act-event', { id: el.dataset.id });
  /** Where an event's target lives, if it still exists. */
  function related(ev) {
    const later = fn => () => setTimeout(fn, 80);
    if (ev.type === 'Knowledge') { const kb = D.kbs.find(k => k.name === ev.target); if (kb) return { label: `Open ${kb.name}`, to: '/knowledge/' + kb.id }; }
    if (ev.type === 'Sources') { const s = D.sources.find(x => x.name === ev.target); if (s) return { label: `Open ${s.name}`, to: '/sources', then: later(() => A['src-open']?.({ dataset: { id: s.id } })) }; }
    if (ev.type === 'People & access') {
      const m = D.members.find(x => x.name === ev.target); if (m) return { label: `View ${m.name}`, to: '/people?tab=members', then: later(() => A['member-open']?.({ dataset: { id: m.id } })) };
      const g = D.groups.find(x => x.name === ev.target); if (g) return { label: `Open ${g.name}`, to: '/people?tab=groups', then: later(() => A['ppl-group-open']?.({ dataset: { id: g.id } })) };
      const r = D.roles.find(x => x.name === ev.target); if (r) return { label: `Open ${r.name}`, run: () => A['ppl-role-show']?.({ dataset: { id: r.id } }) };
      if (ev.target.includes('→')) return { label: 'Open access requests', to: '/people?tab=requests' };
    }
    if (ev.type === 'Settings') return ev.target === 'Assistant setup' ? { label: 'Open assistant', to: '/assistant' } : { label: 'Open settings', to: '/settings' };
    if (ev.type === 'Sign-in') return { label: 'View sign-ins', to: '/activity?tab=signins' };
    return null;
  }
  DR['act-event'] = ({ id }) => {
    const ev = D.audit.find(e => e.id === id);
    if (!ev) return { title: 'Event not found', body: emptyState({ icon: 'activity', title: 'This event is no longer in the log', compact: true }) };
    const to = related(ev);
    const body = kv([
      ['Event ID', `<span class="mono t-sm">${esc(ev.id)}</span>`],
      ['Person', `<span class="row gap-8">${actorAv(ev.actor, 'xs')}${esc(actorName(ev.actor))}</span>`],
      ['Action', esc(ev.action)],
      ['Target', esc(ev.target)],
      ['Area', esc(ev.type)],
      ['Outcome', status('outcome', ev.outcome)],
      ['IP address', `<span class="mono t-sm">${esc(ev.ip || '—')}</span>`],
      ['Device', esc(ev.device || '—')],
      ['Time', esc(full(ev.at))],
    ]);
    return {
      title: ev.action, desc: `${esc(actorName(ev.actor))} · ${rel(ev.at)}`, lead: actorAv(ev.actor, 'lg'), body,
      foot: to ? btn(to.label, { v: 'primary', iconRight: 'arrow-right', act: 'act-related', data: { id } }) : '',
    };
  };
  A['act-related'] = el => {
    const ev = D.audit.find(e => e.id === el.dataset.id); const r = ev && related(ev); if (!r) return;
    closeDrawer();
    if (r.run) return r.run();
    go(r.to); r.then?.();
  };
})();

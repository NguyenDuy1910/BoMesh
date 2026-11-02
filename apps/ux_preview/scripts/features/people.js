/* People: members, groups, roles and access requests (/people?tab=…).
   Shared actions: member-add, member-open, req-approve, req-deny. */
(() => {
  'use strict';

  const TABS = ['members', 'groups', 'roles', 'requests'];
  const AREA = 'People & access';
  const ACCESS = { viewer: 'Viewer', editor: 'Editor', owner: 'Owner' };
  const CAN = { viewer: 'Can view', editor: 'Can edit', owner: 'Can manage' };
  const fresh = new Set();

  /* Decided history gives "Recently decided" context (never the Member persona). */
  if (!D.requests.some(r => r.id === 'req-h1')) D.requests.push(
    { id: 'req-h1', user: 'u-james', kb: 'kb-fin', role: 'viewer', note: 'Quarterly audit of vendor approvals.', at: ago(2 * DAY + 3 * HOUR), status: 'approved', decidedAt: ago(2 * DAY), decidedBy: 'u-mai' },
    { id: 'req-h2', user: 'u-chi', kb: 'kb-legal', role: 'viewer', note: 'Looking for the standard NDA template.', at: ago(6 * DAY), status: 'denied', decidedAt: ago(5 * DAY), decidedBy: 'u-linh' },
  );

  /* ── Helpers ── */
  function audit(action, target, outcome = 'success') {
    const ev = { id: uid('ev'), at: Date.now(), actor: me().id, action, type: AREA, target, outcome, ip: '10.4.12.30', device: 'Chrome on macOS' };
    D.audit.unshift(ev); return ev;
  }
  /** Undo also takes the events back out of the activity log. */
  const unaudit = evs => evs.flat().forEach(ev => { const i = D.audit.indexOf(ev); if (i >= 0) D.audit.splice(i, 1); });
  const nameFromEmail = e => e.split('@')[0].split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  const first = n => String(n || '').split(' ')[0];
  const names = a => a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
  const markFresh = ids => { ids.forEach(id => fresh.add(id)); setTimeout(() => ids.forEach(id => fresh.delete(id)), 2600); };
  const roleCount = id => D.members.filter(m => m.roleId === id).length;
  const sharedKbs = () => D.kbs.filter(k => !k.personal && !k.archived);
  const groupKbs = gid => sharedKbs().filter(k => k.shares.some(s => s.kind === 'group' && s.id === gid));
  const kbDot = kb => `<span class="ppl-dot" style="background:${esc(kb.color || 'var(--muted)')}" aria-hidden="true"></span>`;
  const activeAdmins = () => D.members.filter(m => m.roleId === 'r-admin' && m.status === 'active');
  const isLastAdmin = m => m.roleId === 'r-admin' && m.status === 'active' && activeAdmins().length <= 1;
  /** Why this member's role can't change ('' when it can). */
  function roleGuard(m) {
    if (m.id === me().id) return 'You can’t change your own role';
    if (isLastAdmin(m)) return 'The last workspace admin keeps this role';
    return '';
  }
  /** Why this member can't be suspended or removed ('' when they can). */
  function accountGuard(m, verb) {
    if (m.id === me().id) return `You can’t ${verb} yourself`;
    if (isLastAdmin(m)) return `You can’t ${verb} the last workspace admin`;
    return '';
  }
  const tipWrap = (why, html) => why ? `<span class="ppl-tip" data-tip="${esc(why)}" tabindex="0">${html}</span>` : html;

  /* ── Page ── */
  P.people = ({ query }) => {
    const tab = TABS.includes(query.tab) ? query.tab : 'members';
    const pend = pendingRequests().length;
    const head = pageHeader({ title: 'People', actions: btn('Add people', { v: 'primary', icon: 'user-plus', act: 'member-add' }) });
    const t = tabs([
      { id: 'members', label: 'Members', count: D.members.length },
      { id: 'groups', label: 'Groups', count: D.groups.length },
      { id: 'roles', label: 'Roles', count: D.roles.length },
      { id: 'requests', label: 'Requests', count: pend || null, alert: true },
    ], tab, '/people');
    const body = { members: membersTab, groups: groupsTab, roles: rolesTab, requests: requestsTab }[tab]();
    return `<div class="page">${head}<div class="page-tabs">${t}</div>${body}</div>`;
  };

  /* ══════════════ Members ══════════════ */
  function memberRows() {
    const u = ui('pplM');
    const rows = D.members.filter(m => (!u.role || m.roleId === u.role) && (!u.status || m.status === u.status) && matchesQ('pplM', m.name, m.email));
    return applySort(rows, 'pplM', { name: m => m.name, role: m => roleById(m.roleId)?.name || '', last: m => m.lastActive || 0 });
  }
  function roleCell(m) {
    const why = roleGuard(m);
    const sel = select({ id: 'ppl-role-' + m.id, value: m.roleId, options: D.roles.map(r => [r.id, r.name]), size: 'sm', cls: 'ppl-role-select', change: 'ppl-role-change', label: 'Role for ' + m.name, attrs: `data-id="${m.id}"${why ? ' disabled' : ''}` });
    return tipWrap(why, sel);
  }
  function groupChips(ids, max = 2) {
    const gs = ids.map(groupById).filter(Boolean);
    if (!gs.length) return '<span class="muted">—</span>';
    const rest = gs.slice(max);
    return `<span class="row gap-4 wrap">${gs.slice(0, max).map(g => chip(g.name, { size: 'sm' })).join('')}${rest.length ? chip('+' + rest.length, { size: 'sm', variant: 'outline', tip: rest.map(g => g.name).join(', ') }) : ''}</span>`;
  }
  function membersTab() {
    const u = ui('pplM', { q: '', role: '', status: '', sel: {}, page: 1 });
    const rows = memberRows();
    const live = !S.navLoading && S.pageState === 'live';
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'pplM', placeholder: 'Search by name or email' })}${filterButton('Role', 'pplM', 'role', D.roles.map(r => [r.id, r.name]))}${filterButton('Status', 'pplM', 'status', [['active', 'Active'], ['suspended', 'Suspended']])}${clearFilters('pplM', ['role', 'status'])}${live ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'person', 'people')}</span>` : ''}</div>`;
    return toolbar + gate({
      empty: () => emptyState({ icon: 'users', boxed: true, title: 'Only you are here', desc: 'Add people who already have a BoMesh account. They can start asking right away.', actions: btn('Add people', { v: 'primary', icon: 'user-plus', act: 'member-add' }) }),
      ok: () => {
        if (!rows.length) return noMatches('pplM', ['role', 'status'], 'people');
        const page = paginate(rows, 'pplM', 20); const ids = page.map(m => m.id);
        const head = selAllCheck('pplM', ids) + sortHead('Person', 'name', 'pplM') + sortHead('Role', 'role', 'pplM') + th('Groups', 'hide-md') + sortHead('Last active', 'last', 'pplM') + th('Status');
        const trs = page.map(m => {
          const self = m.id === me().id;
          return `<tr class="${cx('table__row', fresh.has(m.id) && 'table__row--new')}" data-act="member-open" data-id="${m.id}" tabindex="0" ${u.sel?.[m.id] ? 'aria-selected="true"' : ''}>
            ${selCheck('pplM', m.id, 'Select ' + m.name)}
            <td class="table__cell table__cell--primary"><span class="row gap-12">${avatar(m.name)}<span class="stack" style="min-width:0"><span class="row gap-6"><span class="cell-title truncate">${esc(m.name)}</span>${self ? chip('You', { size: 'sm' }) : ''}</span><span class="cell-sub truncate">${esc(m.email)}</span></span></span></td>
            <td class="table__cell">${roleCell(m)}</td>
            <td class="table__cell hide-md table__cell--hide-sm">${groupChips(m.groups)}</td>
            <td class="table__cell muted"><span class="ppl-nowrap">${m.lastActive ? rel(m.lastActive) : 'Not yet'}</span></td>
            <td class="table__cell">${status('member', m.status)}</td></tr>`;
        });
        const bulk = bulkBar('pplM', btn('Change role', { v: 'ghost', size: 'sm', icon: 'shield', menu: 'ppl-bulk-role' }) + btn('Suspend', { v: 'ghost', size: 'sm', icon: 'pause', act: 'ppl-bulk-suspend' }));
        return table({ head, rows: trs, label: 'Members' }) + pager(rows.length, 'pplM', 20) + bulk;
      },
    });
  }

  /** Change role for one or more members; guarded (self, last admin) and undoable. */
  function setRole(ids, roleId, after) {
    const role = roleById(roleId); if (!role) return;
    const all = ids.map(memberById).filter(Boolean);
    const blocked = all.filter(m => roleGuard(m) && m.roleId !== roleId);
    const ms = all.filter(m => !roleGuard(m) && m.roleId !== roleId);
    if (roleId !== 'r-admin' && ms.some(m => m.roleId === 'r-admin') && !activeAdmins().some(a => !ms.includes(a))) {
      toast('Keep at least one workspace admin', { tone: 'danger' }); refresh(); return;
    }
    after?.();
    if (!ms.length) { refresh(); if (blocked.length) toast(blocked.some(m => m.id === me().id) ? 'You can’t change your own role' : 'The last workspace admin keeps this role', { tone: 'danger' }); return; }
    const prev = ms.map(m => [m, m.roleId]);
    const evs = ms.map(m => { m.roleId = roleId; return audit(`Changed role to ${role.name}`, m.name); });
    refresh();
    const msg = ms.length > 1 ? `${ms.length} people are now ${role.name}` : `${ms[0].name} is now ${role.name}`;
    toast(msg + (blocked.length ? ` · ${plural(blocked.length, 'person', 'people')} skipped` : ''), { action: { label: 'Undo', run: () => { prev.forEach(([m, r]) => (m.roleId = r)); unaudit(evs); refresh(); toast('Role change undone', { tone: 'accent' }); } } });
  }
  A['ppl-role-change'] = el => setRole([el.dataset.id], el.value);
  MENUS['ppl-bulk-role'] = () => [{ section: 'Change role to' }, ...D.roles.map(r => ({ label: r.name, run: () => setRole(selIds('pplM'), r.id, () => { ui('pplM').sel = {}; }) }))];
  A['ppl-bulk-suspend'] = () => suspend(selIds('pplM'), () => { ui('pplM').sel = {}; });

  function suspend(ids, after) {
    const all = ids.map(memberById).filter(m => m && m.status !== 'suspended');
    const ms = all.filter(m => !accountGuard(m, 'suspend'));
    if (!ms.length) { toast(all.length ? accountGuard(all[0], 'suspend') : 'Everyone selected is already suspended', { tone: 'danger' }); return; }
    const one = ms.length === 1;
    confirmAction({
      title: one ? `Suspend ${ms[0].name}?` : `Suspend ${ms.length} people?`,
      body: `${one ? esc(first(ms[0].name)) : 'They'} won’t be able to sign in until reactivated. Nothing they own is deleted.${all.length > ms.length ? ' You and the last admin are skipped.' : ''}`,
      confirm: 'Suspend', danger: true,
      onConfirm: () => {
        const evs = ms.map(m => { m.status = 'suspended'; return audit('Suspended member', m.name); });
        after?.(); refresh();
        toast(one ? `Suspended ${ms[0].name}` : `Suspended ${ms.length} people`, { action: { label: 'Undo', run: () => { ms.forEach(m => (m.status = 'active')); unaudit(evs); refresh(); } } });
      },
    });
  }
  function reactivate(id) {
    const m = memberById(id); if (!m || m.status !== 'suspended') return;
    m.status = 'active'; const ev = audit('Reactivated member', m.name); refresh();
    toast(`${first(m.name)} can sign in again`, { action: { label: 'Undo', run: () => { m.status = 'suspended'; unaudit([ev]); refresh(); } } });
  }
  function remove(id) {
    const m = memberById(id); if (!m || accountGuard(m, 'remove')) return; const ws = curWs();
    confirmAction({
      title: `Remove ${m.name}?`, body: `They lose access to ${esc(ws.name)} right away. Their chats are deleted after 30 days.`, confirm: 'Remove', danger: true,
      onConfirm: () => {
        const i = D.members.indexOf(m); if (i < 0) return;
        D.members.splice(i, 1); ws.members = Math.max(0, (ws.members || 1) - 1);
        if (ui('pplM').sel) delete ui('pplM').sel[m.id];
        const ev = audit('Removed member', m.name);
        if (S.drawer?.name === 'ppl-member') S.drawer = null;
        refresh();
        toast(`Removed ${m.name}`, { action: { label: 'Undo', run: () => { if (!memberById(m.id)) { D.members.splice(i, 0, m); ws.members += 1; } unaudit([ev]); refresh(); } } });
      },
    });
  }

  /* ── Member drawer ── */
  function openMember(id) {
    const m = memberById(id); if (!m) return;
    S.ui.pplMD = { id, role: m.roleId, groups: [...m.groups] };
    openDrawer('ppl-member', { id });
  }
  A['member-open'] = el => openMember(el.dataset.id);
  function kbAccess(m) {
    return sharedKbs().map(k => {
      const direct = k.shares.find(s => s.kind === 'user' && s.id === m.id);
      const grp = k.shares.filter(s => s.kind === 'group' && m.groups.includes(s.id));
      const sp = k.space && spaceById(k.space);
      if (direct) return { kb: k, via: 'Shared directly', role: direct.role };
      if (grp.length) return { kb: k, via: grp.map(s => groupById(s.id)?.name).filter(Boolean).join(', '), role: grp[0].role };
      if (k.general === 'workspace') return { kb: k, via: 'Everyone', role: 'viewer' };
      if (k.general !== 'private' && sp?.members?.some(x => x.user === m.id)) return { kb: k, via: `Member of ${sp.name}`, role: 'viewer' };
      return null;
    }).filter(Boolean);
  }
  /** Spaces the person belongs to, with their role there. */
  function spacesOf(m) {
    return (D.spaces || []).filter(s => !s.archived && s.members?.some(x => x.user === m.id)).map(sp => {
      const key = sp.members.find(x => x.user === m.id).role, t = spaceType(sp.type);
      return { sp, role: t.roles.find(r => r[0] === key)?.[1] || key, type: t };
    });
  }
  const spaceLead = sp => X.spaceMark?.(sp, 'sm') || `<span class="ppl-dot" style="background:${esc(sp.color || 'var(--muted)')}" aria-hidden="true"></span>`;
  /** Group changes can change what a demo persona may open; keep its stored role in step (knowledge.js owns the rule). */
  const syncKbs = (userIds, groupIds) => sharedKbs().filter(k => k.shares.some(s => s.kind === 'group' && groupIds.includes(s.id))).forEach(k => X.kbSyncPersonas?.(k, userIds));
  const mdDirty = (f, m) => f.role !== m.roleId || [...f.groups].sort().join() !== [...m.groups].sort().join();
  DR['ppl-member'] = ({ id }) => {
    const m = memberById(id);
    if (!m) return { title: 'Member removed', body: emptyState({ icon: 'user', title: 'This person is no longer a member', compact: true }) };
    const f = S.ui.pplMD?.id === id ? S.ui.pplMD : (S.ui.pplMD = { id, role: m.roleId, groups: [...m.groups] });
    const self = m.id === me().id; const role = roleById(f.role) || D.roles[0];
    const rWhy = roleGuard(m); const sWhy = accountGuard(m, 'suspend'); const xWhy = accountGuard(m, 'remove');
    const access = kbAccess({ ...m, groups: f.groups });
    const lastSi = D.signins.filter(s => s.user === m.id).sort((a, b) => b.at - a.at)[0];
    const sec = (title, html, extra = '') => `<section class="drawer__section"><div class="row between gap-8"><h3 class="drawer__section-title">${esc(title)}</h3>${extra}</div>${html}</section>`;
    const body = (m.status === 'suspended' ? `<div class="mb-16">${alertBox('danger', 'Suspended', `${esc(first(m.name))} can’t sign in until reactivated.`)}</div>` : '') +
      sec('Role', field({ id: 'ppl-md-role', desc: rWhy ? esc(rWhy) + '.' : esc(role.desc), control: select({ id: 'ppl-md-role', bind: 'pplMD.role', value: f.role, options: D.roles.map(r => [r.id, r.name]), change: 'ppl-md-refresh', label: 'Role', attrs: rWhy ? 'disabled' : '' }) })) +
      sec('Groups', D.groups.length ? `<div class="ppl-checks">${D.groups.map(g => checkbox({ label: esc(g.name), checked: f.groups.includes(g.id), act: 'ppl-md-group', data: { id: g.id } })).join('')}</div>` : `<p class="t-sm muted">No groups yet.</p>`, `<span class="t-xs muted">${f.groups.length} selected</span>`) +
      sec('Knowledge access', role.id === 'r-admin' ? `<p class="t-sm muted">Workspace admins can open every knowledge base.</p>`
        : access.length ? list(access.map(a => item({ lead: kbDot(a.kb), title: esc(a.kb.name), desc: esc(a.via), meta: CAN[a.role] || 'Can view', href: '/knowledge/' + a.kb.id }))) : `<p class="t-sm muted">No knowledge bases shared with ${esc(first(m.name))}.</p>`) +
      (hasModule('spaces') ? sec('Spaces', (() => { const sps = spacesOf(m); return sps.length ? list(sps.map(s => item({ lead: spaceLead(s.sp), title: esc(s.sp.name), desc: esc([s.type.label, s.sp.code].filter(Boolean).join(' · ')), meta: esc(s.role), href: '/space/' + s.sp.id }))) : `<p class="t-sm muted">${esc(first(m.name))} isn’t in any spaces.</p>`; })()) : '') +
      sec('Activity', kv([['Joined', fmtDate(m.joined)], ['Last active', m.lastActive ? rel(m.lastActive) : 'Not yet'], ['Last sign-in', lastSi ? `${esc(lastSi.method)} · ${esc(lastSi.device)} · ${rel(lastSi.at)}` : 'No sign-ins yet']]));
    const footStart = tipWrap(xWhy, btn('Remove', { v: 'danger-soft', icon: 'trash', act: 'ppl-md-remove', data: { id }, disabled: !!xWhy })) +
      (m.status === 'suspended' ? btn('Reactivate', { icon: 'play', act: 'ppl-md-reactivate', data: { id } }) : tipWrap(sWhy, btn('Suspend', { icon: 'pause', act: 'ppl-md-suspend', data: { id }, disabled: !!sWhy })));
    return {
      title: m.name + (self ? ' (you)' : ''), desc: esc(m.email), lead: avatar(m.name, 'lg'),
      body, footStart, foot: btn('Save', { v: 'primary', act: 'ppl-md-save', disabled: !mdDirty(f, m) }),
    };
  };
  A['ppl-md-refresh'] = () => refreshLayer();
  A['ppl-md-group'] = el => { const f = ui('pplMD'); const g = el.dataset.id; f.groups = f.groups.includes(g) ? f.groups.filter(x => x !== g) : [...f.groups, g]; refreshLayer(); };
  A['ppl-md-remove'] = el => remove(el.dataset.id);
  A['ppl-md-suspend'] = el => suspend([el.dataset.id]);
  A['ppl-md-reactivate'] = el => reactivate(el.dataset.id);
  A['ppl-md-save'] = () => {
    const f = ui('pplMD'); const m = memberById(f.id); if (!m || !mdDirty(f, m)) return;
    if (f.role !== m.roleId && roleGuard(m)) { toast(roleGuard(m), { tone: 'danger' }); return; }
    const prev = { role: m.roleId, groups: [...m.groups] }; const evs = [];
    if (f.role !== m.roleId) { m.roleId = f.role; evs.push(audit(`Changed role to ${roleById(f.role).name}`, m.name)); }
    f.groups.filter(g => !prev.groups.includes(g)).forEach(g => evs.push(audit(`Added to group ${groupById(g)?.name}`, m.name)));
    prev.groups.filter(g => !f.groups.includes(g)).forEach(g => evs.push(audit(`Removed from group ${groupById(g)?.name}`, m.name)));
    m.groups = [...f.groups];
    const changed = [...f.groups, ...prev.groups].filter(g => f.groups.includes(g) !== prev.groups.includes(g));
    syncKbs([m.id], changed);
    S.drawer = null; refresh();
    toast(`Saved changes to ${m.name}`, { action: { label: 'Undo', run: () => { m.roleId = prev.role; m.groups = prev.groups; syncKbs([m.id], changed); unaudit(evs); refresh(); } } });
  };

  /* ── Add people ── */
  function emailProblem(e) {
    if (!EMAIL_RE.test(e)) return 'Not a valid email address';
    if (D.members.some(m => m.email.toLowerCase() === e)) return 'Already a member';
    if (!D.knownAccounts.includes(e)) return 'No BoMesh account for this email';
    return '';
  }
  function commitEmails(text) {
    const f = ui('pplAdd');
    text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean).forEach(e => { if (!f.emails.includes(e)) f.emails.push(e); });
  }
  A['member-add'] = () => {
    if (!can('user.manage')) return;
    S.ui.pplAdd = { draft: '', emails: [], role: 'r-member', groups: [] };
    openModal('ppl-add', {});
  };
  M['ppl-add'] = p => {
    const f = ui('pplAdd');
    const checks = f.emails.map(e => [e, emailProblem(e)]);
    const bad = checks.filter(([, why]) => why);
    const draft = f.draft.trim().toLowerCase(); const draftOk = !!draft && !emailProblem(draft) && !f.emails.includes(draft);
    const n = checks.length - bad.length + (draftOk ? 1 : 0);
    const ready = n > 0 && !bad.length && (!draft || draftOk || f.emails.includes(draft));
    const role = roleById(f.role) || D.roles[0];
    const chips = checks.map(([e, why]) => `<span class="${cx('ppl-chip', why && 'is-invalid')}" ${why ? `data-tip="${esc(why)}"` : ''}>${why ? ic('alert-circle', 'i-xs') : avatar(nameFromEmail(e), 'xs')}<span class="truncate">${esc(e)}</span><button type="button" class="ppl-chip__x" data-act="ppl-add-rm" data-email="${esc(e)}" aria-label="Remove ${esc(e)}">${ic('x', 'i-xs')}</button></span>`).join('');
    const msg = bad.length ? `<div class="stack gap-4" role="alert">${bad.map(([e, why]) => `<div class="field-error">${ic('alert-circle')}<span><span class="medium">${esc(e)}</span> · ${esc(why)}</span></div>`).join('')}</div>`
      : '<div class="description">Paste or type emails, separated by commas. Each person needs a BoMesh account.</div>';
    const emails = `<div class="field"><label class="label" for="ppl-add-email">Emails</label><div class="${cx('ppl-chipin', bad.length && 'is-invalid')}" data-act="ppl-add-focus">${chips}<input id="ppl-add-email" class="ppl-chipin__input" type="text" value="${esc(f.draft)}" placeholder="${f.emails.length ? 'Add another' : 'name@northwind.com'}" data-bind="pplAdd.draft" data-live data-input="ppl-add-input" data-enter="ppl-add-enter" autocomplete="off" spellcheck="false" data-autofocus aria-label="Email addresses"></div>${msg}</div>`;
    const roleF = field({ id: 'ppl-add-role', label: 'Role', desc: esc(role.desc), control: select({ id: 'ppl-add-role', bind: 'pplAdd.role', value: f.role, options: D.roles.map(r => [r.id, r.name]), change: 'ppl-md-refresh' }) });
    const groupsF = D.groups.length ? `<div class="field"><span class="label">Groups<span class="label__opt">(optional)</span></span><div class="ppl-checks">${D.groups.map(g => checkbox({ label: esc(g.name), checked: f.groups.includes(g.id), act: 'ppl-add-group', data: { id: g.id } })).join('')}</div></div>` : '';
    return {
      title: 'Add people', desc: `They join ${esc(curWs().name)} right away.`, size: 'lg',
      body: emails + roleF + groupsF,
      foot: btn('Cancel', { act: 'close-modal' }) + btn(n > 1 ? `Add ${n} people` : 'Add person', { v: 'primary', act: 'ppl-add-submit', disabled: !ready, loading: p.busy, id: 'ppl-add-submit' }),
    };
  };
  A['ppl-add-focus'] = () => $('#ppl-add-email')?.focus();
  A['ppl-add-input'] = el => {
    const v = el.value; if (!/[,;\s]/.test(v)) return;
    const parts = v.split(/[,;\s]+/); const rest = /[,;\s]$/.test(v) ? '' : parts.pop();
    commitEmails(parts.join(',')); ui('pplAdd').draft = rest; refreshLayer();
  };
  A['ppl-add-enter'] = () => { const f = ui('pplAdd'); if (f.draft.trim()) { commitEmails(f.draft); f.draft = ''; refreshLayer(); } else A['ppl-add-submit'](); };
  A['ppl-add-rm'] = el => { const f = ui('pplAdd'); f.emails = f.emails.filter(e => e !== el.dataset.email); refreshLayer(); $('#ppl-add-email')?.focus(); };
  A['ppl-add-group'] = el => { const f = ui('pplAdd'); const g = el.dataset.id; f.groups = f.groups.includes(g) ? f.groups.filter(x => x !== g) : [...f.groups, g]; refreshLayer(); };
  A['ppl-add-submit'] = async () => {
    const f = ui('pplAdd'); const p = S.modal?.props; if (!p || p.busy || S.modal.name !== 'ppl-add') return;
    if (f.draft.trim()) { commitEmails(f.draft); f.draft = ''; }
    if (!f.emails.length || f.emails.some(emailProblem)) { refreshLayer(); $('#ppl-add-email')?.focus(); return; }
    p.busy = true; p.guard = true; refreshLayer();
    await sleep(700);
    const added = f.emails.map(e => ({ id: uid('u'), name: nameFromEmail(e), email: e, roleId: f.role, groups: [...f.groups], status: 'active', lastActive: null, joined: Date.now() }));
    D.members.unshift(...added);
    const evs = added.map(m => audit('Added member', m.name));
    curWs().members += added.length;
    markFresh(added.map(m => m.id));
    Object.assign(ui('pplM', {}), { q: '', role: '', status: '', page: 1, sort: null });
    closeModal();
    if (S.cur.path !== '/people' || (S.cur.query.tab && S.cur.query.tab !== 'members')) go('/people?tab=members'); else refresh();
    toast(added.length <= 2 ? `Added ${names(added.map(m => m.name))}` : `Added ${added.length} people`, {
      action: { label: 'Undo', run: () => { D.members = D.members.filter(m => !added.includes(m)); curWs().members -= added.length; unaudit(evs); refresh(); } },
    });
  };

  /* ══════════════ Groups ══════════════ */
  function groupsTab() {
    ui('pplG', { q: '' });
    const rows = D.groups.filter(g => matchesQ('pplG', g.name, g.desc));
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'pplG', placeholder: 'Search groups' })}${can('group.manage') ? `<span class="toolbar__end">${btn('Create group', { icon: 'plus', size: 'sm', act: 'ppl-group-create' })}</span>` : ''}</div>`;
    return toolbar + gate({
      loading: () => skelCards(6),
      empty: () => emptyState({ icon: 'users', boxed: true, title: 'No groups yet', desc: 'Groups let you share knowledge with a whole team in one step.', actions: can('group.manage') ? btn('Create group', { v: 'primary', icon: 'plus', act: 'ppl-group-create' }) : '' }),
      ok: () => !rows.length ? noMatches('pplG', [], 'groups') : `<div class="grid cols-3">${rows.map(g => {
        const ms = groupMembers(g.id); const kbs = groupKbs(g.id);
        return `<div class="${cx('card card--action ppl-group', fresh.has(g.id) && 'ppl-fresh')}" role="button" tabindex="0" data-act="ppl-group-open" data-id="${g.id}">
          <div class="row gap-12">${itemIcon('users', 'accent', 'sm')}<span class="grow stack"><span class="card__title truncate">${esc(g.name)}</span></span></div>
          <p class="t-sm muted clamp-2 ppl-group__desc">${esc(g.desc || 'No description')}</p>
          <div class="row between gap-8">${ms.length ? `<span class="row gap-8"><span class="avatar-group">${ms.slice(0, 4).map(m => avatar(m.name, 'sm')).join('')}</span><span class="t-xs muted num">${plural(ms.length, 'member')}</span></span>` : '<span class="t-xs muted">No members</span>'}<span class="t-xs muted">${kbs.length ? plural(kbs.length, 'knowledge base') : ''}</span></div></div>`;
      }).join('')}</div>`,
    });
  }
  const groupErr = (name, id) => { const n = name.trim(); if (!n) return 'Enter a group name.'; if (D.groups.some(g => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) return 'A group with this name already exists.'; return ''; };
  function openGroup(id) { const g = groupById(id); if (!g) return; S.ui.pplGD = { id, name: g.name, desc: g.desc || '', q: '', touched: false }; openDrawer('ppl-group', { id }); }
  A['ppl-group-open'] = el => openGroup(el.dataset.id);
  A['ppl-group-create'] = () => { S.ui.pplGN = { name: '', desc: '', touched: false }; openModal('ppl-group-new', {}); };
  M['ppl-group-new'] = p => {
    const f = ui('pplGN'); const err = f.touched ? groupErr(f.name) : '';
    return {
      size: 'sm', title: 'Create group',
      body: field({ id: 'ppl-gn-name', label: 'Name', required: true, error: err, control: input({ id: 'ppl-gn-name', bind: 'pplGN.name', value: f.name, placeholder: 'e.g. Marketing', autofocus: true, invalid: !!err, attrs: 'data-live maxlength="40"', onEnter: 'ppl-gn-save' }) }) +
        field({ id: 'ppl-gn-desc', label: 'Description', optional: true, control: input({ id: 'ppl-gn-desc', bind: 'pplGN.desc', value: f.desc, placeholder: 'Who belongs in this group', attrs: 'maxlength="80"', onEnter: 'ppl-gn-save' }) }),
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Create group', { v: 'primary', act: 'ppl-gn-save', loading: p.busy }),
    };
  };
  A['ppl-gn-save'] = async () => {
    const p = S.modal?.props; if (!p || p.busy) return; const f = ui('pplGN'); f.touched = true;
    if (groupErr(f.name)) { refreshLayer(); $('#ppl-gn-name')?.focus(); return; }
    p.busy = true; p.guard = true; refreshLayer(); await sleep(500);
    const g = { id: uid('g'), name: f.name.trim(), desc: f.desc.trim() };
    D.groups.push(g); audit('Created group', g.name); markFresh([g.id]);
    closeModal();
    if (S.cur.path !== '/people' || S.cur.query.tab !== 'groups') go('/people?tab=groups'); else refresh();
    toast(`Created ${g.name}`);
    setTimeout(() => openGroup(g.id), 80);
  };
  DR['ppl-group'] = ({ id }) => {
    const g = groupById(id);
    if (!g) return { title: 'Group deleted', body: emptyState({ icon: 'users', title: 'This group no longer exists', compact: true }) };
    const f = S.ui.pplGD?.id === id ? S.ui.pplGD : (S.ui.pplGD = { id, name: g.name, desc: g.desc || '', q: '', touched: false });
    const manage = can('group.manage');
    const ms = groupMembers(id); const kbs = groupKbs(id);
    const err = f.touched ? groupErr(f.name, id) : '';
    const dirty = f.name.trim() !== g.name || f.desc.trim() !== (g.desc || '');
    const q = f.q.trim().toLowerCase();
    const cands = q ? D.members.filter(m => !m.groups.includes(id) && (m.name.toLowerCase().includes(q) || m.email.includes(q))).slice(0, 6) : [];
    const details = field({ id: 'ppl-gd-name', label: 'Name', required: true, error: err, control: input({ id: 'ppl-gd-name', bind: 'pplGD.name', value: f.name, invalid: !!err, attrs: `data-live maxlength="40"${manage ? '' : ' readonly'}` }) }) +
      field({ id: 'ppl-gd-desc', label: 'Description', optional: true, control: input({ id: 'ppl-gd-desc', bind: 'pplGD.desc', value: f.desc, placeholder: 'Who belongs in this group', attrs: `data-live maxlength="80"${manage ? '' : ' readonly'}` }) });
    const addBox = manage ? `<div class="search-field ppl-full">${ic('search')}<input class="input input--sm" id="ppl-gd-q" type="search" placeholder="Add people by name or email" value="${esc(f.q)}" data-bind="pplGD.q" data-live autocomplete="off" aria-label="Add people to group"></div>
      ${q ? `<div class="mt-8">${cands.length ? list(cands.map(m => item({ lead: avatar(m.name, 'sm'), title: esc(m.name), desc: esc(m.email), trail: btn('Add', { size: 'sm', icon: 'plus', act: 'ppl-gd-add', data: { id, member: m.id } }) }))) : `<p class="t-sm muted">No one else matches “${esc(f.q)}”.</p>`}</div>` : ''}` : '';
    const members = ms.length ? list(ms.map(m => item({ lead: avatar(m.name, 'sm'), title: esc(m.name), desc: esc(roleById(m.roleId)?.name || ''), trail: manage ? iconBtn('x', `Remove ${m.name} from group`, { size: 'sm', act: 'ppl-gd-rm', data: { id, member: m.id } }) : '' }))) : `<p class="t-sm muted">No one is in this group yet.</p>`;
    const kbList = kbs.length ? list(kbs.map(k => { const s = k.shares.find(x => x.kind === 'group' && x.id === id); return item({ lead: kbDot(k), title: esc(k.name), meta: CAN[s.role] || 'Can view', href: '/knowledge/' + k.id + '?tab=access' }); })) : `<p class="t-sm muted">Not shared with any knowledge base yet. Share from a knowledge base’s Access tab.</p>`;
    const body = `<section class="drawer__section">${details}</section>
      <section class="drawer__section"><h3 class="drawer__section-title">Members · ${fmtNum(ms.length)}</h3>${addBox}<div class="mt-12">${members}</div></section>
      <section class="drawer__section"><h3 class="drawer__section-title">Knowledge bases</h3>${kbList}</section>`;
    return {
      title: g.name, desc: plural(ms.length, 'member'), lead: itemIcon('users', 'accent'), body,
      footStart: manage ? btn('Delete group', { v: 'danger-soft', icon: 'trash', act: 'ppl-gd-delete', data: { id } }) : '',
      foot: manage ? btn('Save', { v: 'primary', act: 'ppl-gd-save', data: { id }, disabled: !dirty }) : '',
    };
  };
  A['ppl-gd-save'] = el => {
    const g = groupById(el.dataset.id); const f = ui('pplGD'); if (!g) return; f.touched = true;
    if (groupErr(f.name, g.id)) { refreshLayer(); $('#ppl-gd-name')?.focus(); return; }
    const prev = { name: g.name, desc: g.desc }; g.name = f.name.trim(); g.desc = f.desc.trim(); f.touched = false;
    const ev = audit(prev.name !== g.name ? `Renamed group from ${prev.name}` : 'Edited group description', g.name);
    refresh();
    toast(`Saved ${g.name}`, { action: { label: 'Undo', run: () => { Object.assign(g, prev); if (S.ui.pplGD?.id === g.id) Object.assign(S.ui.pplGD, { name: g.name, desc: g.desc || '' }); unaudit([ev]); refresh(); } } });
  };
  A['ppl-gd-add'] = el => {
    const m = memberById(el.dataset.member); const g = groupById(el.dataset.id); if (!m || !g || m.groups.includes(g.id)) return;
    m.groups.push(g.id); syncKbs([m.id], [g.id]); if (S.ui.pplGD) S.ui.pplGD.q = ''; const ev = audit(`Added to group ${g.name}`, m.name); refresh();
    toast(`Added ${m.name} to ${g.name}`, { action: { label: 'Undo', run: () => { m.groups = m.groups.filter(x => x !== g.id); syncKbs([m.id], [g.id]); unaudit([ev]); refresh(); } } });
    $('#ppl-gd-q')?.focus();
  };
  A['ppl-gd-rm'] = el => {
    const m = memberById(el.dataset.member); const g = groupById(el.dataset.id); if (!m || !g) return;
    const i = m.groups.indexOf(g.id); if (i < 0) return;
    m.groups.splice(i, 1); syncKbs([m.id], [g.id]); const ev = audit(`Removed from group ${g.name}`, m.name); refresh();
    toast(`Removed ${m.name} from ${g.name}`, { action: { label: 'Undo', run: () => { if (!m.groups.includes(g.id)) m.groups.splice(i, 0, g.id); syncKbs([m.id], [g.id]); unaudit([ev]); refresh(); } } });
  };
  A['ppl-gd-delete'] = el => {
    const g = groupById(el.dataset.id); if (!g) return; const ms = groupMembers(g.id); const kbs = groupKbs(g.id);
    confirmAction({
      title: `Delete ${g.name}?`, confirm: 'Delete group', danger: true,
      body: `${ms.length ? `${plural(ms.length, 'member')} stay in the workspace but lose access that came from this group.` : 'No one is in this group.'}${kbs.length ? ` ${plural(kbs.length, 'knowledge base')} stop being shared with it.` : ''}`,
      onConfirm: () => {
        D.groups.splice(D.groups.indexOf(g), 1);
        D.members.forEach(m => { m.groups = m.groups.filter(x => x !== g.id); });
        D.kbs.forEach(k => { k.shares = k.shares.filter(s => !(s.kind === 'group' && s.id === g.id)); });
        kbs.forEach(k => X.kbSyncPersonas?.(k, ms.map(m => m.id)));
        audit('Deleted group', g.name);
        S.drawer = null; refresh(); toast(`Deleted ${g.name}`);
      },
    });
  };

  /* ══════════════ Roles ══════════════ */
  const sameSet = (a, b) => [...a].sort().join() === [...b].sort().join();
  function roleDirty() { const u = S.ui.pplR; const r = u && roleById(u.sel); return !!(r && u.draft && !sameSet(u.draft, r.perms)); }
  function rolesTab() {
    const u = ui('pplR', { sel: 'r-admin', draft: null, busy: false });
    if (!roleById(u.sel)) { u.sel = D.roles[0]?.id; u.draft = null; }
    return gate({
      loading: () => skelRows(5),
      empty: () => emptyState({ icon: 'shield', boxed: true, title: 'No roles yet', desc: 'Roles decide what people can do in this workspace.' }),
      ok: () => {
        const role = roleById(u.sel); const perms = u.draft || role.perms; const dirty = roleDirty();
        const manage = can('role.manage') && !role.system;
        const roleItem = r => item({ title: esc(r.name), desc: plural(roleCount(r.id), 'member'), act: 'ppl-role-select', data: { id: r.id }, cls: cx('ppl-role-item', r.id === role.id && 'is-active') });
        const builtIn = D.roles.filter(r => r.system), custom = D.roles.filter(r => !r.system);
        const nav = `<nav class="ppl-roles__nav" aria-label="Roles">
          <div class="ppl-roles__label">Built-in</div>${list(builtIn.map(roleItem))}
          <div class="ppl-roles__label">Custom</div>${custom.length ? list(custom.map(roleItem)) : '<p class="t-sm muted">No custom roles yet.</p>'}
          ${can('role.manage') ? `<div class="mt-12">${btn('Create role', { icon: 'plus', size: 'sm', act: 'ppl-role-create', full: true })}</div>` : ''}</nav>`;
        const n = roleCount(role.id);
        const actions = role.system ? (can('role.manage') ? btn('Duplicate', { size: 'sm', icon: 'copy', act: 'ppl-role-dup', data: { id: role.id } }) : '')
          : can('role.manage') ? btn('Edit details', { size: 'sm', icon: 'pencil', act: 'ppl-role-edit', data: { id: role.id } }) + iconBtn('more', 'More actions', { size: 'sm', menu: 'ppl-role-more', data: { id: role.id } }) : '';
        const head = `<div class="row-start gap-12"><div class="grow"><div class="row gap-8 wrap"><h2 class="t-heading">${esc(role.name)}</h2>${role.system ? chip('Built-in', { variant: 'outline', size: 'sm' }) : ''}</div>
          <p class="t-sm muted mt-4">${esc(role.desc || 'No description')}</p>
          <div class="t-sm mt-8">${n ? linkBtn(`${plural(n, 'member')} with this role`, { act: 'ppl-role-members', data: { id: role.id } }) : '<span class="muted">No one has this role yet.</span>'}</div></div>
          <div class="row gap-4 none">${actions}</div></div>`;
        const groups = D.permCatalog.map(g => `<div class="ppl-perm-group"><div class="row between gap-8"><h3 class="t-subheading">${esc(g.group)}</h3><span class="t-xs muted num">${g.items.filter(([c]) => perms.includes(c)).length} of ${g.items.length}</span></div>
          <div>${g.items.map(([code, text]) => switchRow({ title: text, on: perms.includes(code), act: 'ppl-perm-toggle', data: { perm: code }, disabled: !manage })).join('')}</div></div>`).join('');
        const note = role.system ? alertBox('default', '', 'Built-in roles can’t be changed. Duplicate one to make a custom role.') : '';
        const bar = dirty ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes to ${esc(role.name)}</span>${btn('Discard', { act: 'ppl-role-discard', disabled: u.busy })}${btn('Save changes', { v: 'primary', act: 'ppl-role-save', loading: u.busy })}</div>` : '';
        return `<div class="ppl-roles">${nav}<div class="ppl-roles__main">${card(head + note + groups, { cls: 'card--lg' })}${bar}</div></div>`;
      },
    });
  }
  function selectRole(id) { const u = ui('pplR'); u.draft = null; u.sel = id; refresh(); }
  A['ppl-role-select'] = el => {
    const u = ui('pplR'); const id = el.dataset.id; if (id === u.sel) return;
    if (roleDirty()) { confirmAction({ title: 'Discard unsaved changes?', body: `Your changes to ${esc(roleById(u.sel).name)} haven’t been saved.`, confirm: 'Discard', danger: true, delay: 0, onConfirm: () => selectRole(id) }); return; }
    selectRole(id);
  };
  /** Open the Roles tab with a role selected (used by Activity). */
  A['ppl-role-show'] = el => { ui('pplR', { sel: 'r-admin', draft: null, busy: false }); selectRole(el.dataset.id); go('/people?tab=roles'); };
  A['ppl-perm-toggle'] = el => {
    const u = ui('pplR'); const r = roleById(u.sel); if (!r || r.system || !can('role.manage')) return;
    const d = new Set(u.draft || r.perms); const c = el.dataset.perm; d.has(c) ? d.delete(c) : d.add(c);
    u.draft = sameSet(d, r.perms) ? null : [...d]; refresh();
  };
  A['ppl-role-discard'] = () => { ui('pplR').draft = null; refresh(); };
  A['ppl-role-save'] = async () => {
    const u = ui('pplR'); const r = roleById(u.sel); if (!r || !u.draft || u.busy) return;
    u.busy = true; refresh(); await sleep(600);
    const prev = r.perms; r.perms = [...u.draft]; u.draft = null; u.busy = false;
    const ev = audit('Changed role permissions', r.name); refresh();
    toast(`Saved ${r.name}`, { action: { label: 'Undo', run: () => { r.perms = prev; unaudit([ev]); refresh(); } } });
  };
  A['ppl-role-members'] = el => { closeModal(); Object.assign(ui('pplM', {}), { q: '', role: el.dataset.id, status: '', page: 1 }); go('/people?tab=members'); };
  MENUS['ppl-role-more'] = el => [
    { label: 'Duplicate', icon: 'copy', run: () => duplicateRole(el.dataset.id) },
    { sep: true },
    { label: 'Delete role', icon: 'trash', danger: true, run: () => deleteRole(el.dataset.id) },
  ];
  function uniqueRoleName(base) { let n = `${base} copy`, i = 2; while (D.roles.some(r => r.name.toLowerCase() === n.toLowerCase())) n = `${base} copy ${i++}`; return n; }
  function duplicateRole(id) {
    const src = roleById(id); if (!src) return;
    const r = { id: uid('r'), name: uniqueRoleName(src.name), system: false, desc: src.desc, perms: [...src.perms] };
    D.roles.push(r); audit('Created role', r.name); selectRole(r.id);
    toast(`Created ${r.name}`, { action: { label: 'Rename', run: () => roleForm(r.id) } });
  }
  A['ppl-role-dup'] = el => duplicateRole(el.dataset.id);
  function deleteRole(id) {
    const r = roleById(id); if (!r || r.system) return; const n = roleCount(id);
    if (n) { openModal('ppl-role-blocked', { id }); return; }
    confirmAction({ title: `Delete ${r.name}?`, body: 'The role and its permissions are deleted.', confirm: 'Delete role', danger: true, onConfirm: () => { D.roles.splice(D.roles.indexOf(r), 1); audit('Deleted role', r.name); selectRole('r-member'); toast(`Deleted ${r.name}`); } });
  }
  M['ppl-role-blocked'] = ({ id }) => ({
    size: 'sm', title: `Can’t delete ${roleById(id)?.name} yet`,
    body: `<p class="muted">Move ${plural(roleCount(id), 'member')} to another role first.</p>`,
    foot: btn('Cancel', { act: 'close-modal' }) + btn('Show members', { v: 'primary', act: 'ppl-role-members', data: { id } }),
  });
  const roleErr = (name, id) => { const n = name.trim(); if (!n) return 'Enter a role name.'; if (D.roles.some(r => r.id !== id && r.name.toLowerCase() === n.toLowerCase())) return 'A role with this name already exists.'; return ''; };
  function roleForm(id) { const r = id && roleById(id); S.ui.pplRF = { name: r?.name || '', desc: r?.desc || '', from: 'r-member', touched: false }; openModal('ppl-role-form', { id }); }
  A['ppl-role-create'] = () => roleForm(null);
  A['ppl-role-edit'] = el => roleForm(el.dataset.id);
  M['ppl-role-form'] = p => {
    const f = ui('pplRF'); const err = f.touched ? roleErr(f.name, p.id) : '';
    const from = [['r-member', 'Member'], ['r-km', 'Knowledge manager'], ['empty', 'Nothing']].filter(([v]) => v === 'empty' || roleById(v));
    return {
      size: 'sm', title: p.id ? 'Edit role details' : 'Create role',
      body: field({ id: 'ppl-rf-name', label: 'Name', required: true, error: err, control: input({ id: 'ppl-rf-name', bind: 'pplRF.name', value: f.name, placeholder: 'e.g. Support lead', autofocus: true, invalid: !!err, attrs: 'data-live maxlength="40"', onEnter: 'ppl-rf-save' }) }) +
        field({ id: 'ppl-rf-desc', label: 'Description', optional: true, control: input({ id: 'ppl-rf-desc', bind: 'pplRF.desc', value: f.desc, placeholder: 'What people with this role do', attrs: 'maxlength="90"', onEnter: 'ppl-rf-save' }) }) +
        (p.id ? '' : `<div class="field"><span class="label">Start with permissions from</span>${seg({ value: f.from, options: from, act: 'ppl-rf-from', label: 'Start from', full: true })}</div>`),
      foot: btn('Cancel', { act: 'close-modal' }) + btn(p.id ? 'Save' : 'Create role', { v: 'primary', act: 'ppl-rf-save', loading: p.busy }),
    };
  };
  A['ppl-rf-from'] = el => { ui('pplRF').from = el.dataset.value; refreshLayer(); };
  A['ppl-rf-save'] = async () => {
    const p = S.modal?.props; if (!p || p.busy) return; const f = ui('pplRF'); f.touched = true;
    if (roleErr(f.name, p.id)) { refreshLayer(); $('#ppl-rf-name')?.focus(); return; }
    p.busy = true; p.guard = true; refreshLayer(); await sleep(500);
    const name = f.name.trim();
    if (p.id) { const r = roleById(p.id); r.name = name; r.desc = f.desc.trim(); audit('Edited role details', name); closeModal(); refresh(); toast(`Saved ${name}`); return; }
    const r = { id: uid('r'), name, system: false, desc: f.desc.trim(), perms: f.from === 'empty' ? [] : [...(roleById(f.from)?.perms || [])] };
    D.roles.push(r); audit('Created role', name); closeModal();
    ui('pplR', {}).sel = r.id; ui('pplR').draft = null;
    if (S.cur.path !== '/people' || S.cur.query.tab !== 'roles') go('/people?tab=roles'); else refresh();
    toast(`Created ${name}`);
  };

  /* ══════════════ Requests ══════════════ */
  function reqSentence(r) {
    const m = memberById(r.user); const kb = kbById(r.kb);
    return `<span class="medium">${esc(m?.name || 'Someone')}</span> wants <span class="medium">${ACCESS[r.role] || 'Viewer'}</span> access to ${kb ? `<a class="link" href="#/knowledge/${kb.id}">${esc(kb.name)}</a>` : 'a knowledge base'}`;
  }
  function reqItem(r) {
    const m = memberById(r.user);
    return item({
      cls: 'ppl-req', lead: avatar(m?.name || '?'), title: reqSentence(r),
      desc: `${r.note ? `<q class="ppl-req__note">${esc(r.note)}</q>` : ''}<span class="ppl-req__time">${rel(r.at)}</span>`,
      trail: can('access.manage') ? btn('Deny', { v: 'ghost', size: 'sm', act: 'req-deny', data: { id: r.id } }) + btn('Approve', { v: 'primary', size: 'sm', act: 'req-approve', data: { id: r.id } }) : '',
    });
  }
  function decidedItem(r) {
    return item({
      cls: 'ppl-req', lead: avatar(memberById(r.user)?.name || '?', 'sm'), title: reqSentence(r),
      desc: `${r.status === 'approved' ? 'Approved' : 'Denied'} by ${esc(actorName(r.decidedBy || me().id))} · ${rel(r.decidedAt || r.at)}`,
      trail: status('request', r.status),
    });
  }
  function requestsTab() {
    const u = ui('pplQ', { open: false });
    const pend = pendingRequests().sort((a, b) => b.at - a.at);
    const decided = D.requests.filter(r => r.status !== 'pending').sort((a, b) => (b.decidedAt || b.at) - (a.decidedAt || a.at));
    const none = () => emptyState({ icon: 'check-check', boxed: true, title: 'No pending requests', desc: 'When someone asks for access to a restricted knowledge base, it shows up here.' });
    const main = gate({ loading: () => skelRows(3), empty: none, ok: () => pend.length ? list(pend.map(reqItem)) : none() });
    const live = S.pageState === 'live' && !S.navLoading;
    const history = live && decided.length ? `<div class="mt-24">${btn(`Recently decided · ${decided.length}`, { v: 'ghost', size: 'sm', icon: u.open ? 'chevron-down' : 'chevron-right', act: 'ppl-req-toggle', aria: `aria-expanded="${!!u.open}"` })}${u.open ? `<div class="mt-8">${list(decided.map(decidedItem))}</div>` : ''}</div>` : '';
    return main + history;
  }
  A['ppl-req-toggle'] = () => { const u = ui('pplQ'); u.open = !u.open; refresh(); };
  /** Role a demo persona holds as stored on a base (undefined when the person isn't a demo persona). */
  function personaRole(kb, userId) {
    const key = Object.keys(PERSONAS).find(k => PERSONAS[k].id === userId); if (!key || !kb) return undefined;
    return kb.access ? kb.access[key] : key === 'member' ? kb.memberRole : undefined;
  }
  /** Approve: grant a direct share on the knowledge base (and, for demo personas, the role they now hold). */
  A['req-approve'] = el => {
    const r = D.requests.find(x => x.id === el.dataset.id); if (!r || r.status !== 'pending') return;
    const kb = kbById(r.kb); const m = memberById(r.user);
    const prevRole = personaRole(kb, r.user); let share = null;
    r.status = 'approved'; r.decidedAt = Date.now(); r.decidedBy = me().id;
    if (kb) {
      setPersonaKbRole(kb, r.user, r.role);
      if (!kb.shares.some(s => s.kind === 'user' && s.id === r.user)) { share = { kind: 'user', id: r.user, role: r.role }; kb.shares.push(share); }
    }
    const ev = audit('Approved access request', `${m?.name || 'Someone'} → ${kb?.name || ''}`);
    refresh();
    toast(`${m?.name || 'They'} can now ${r.role === 'editor' ? 'edit' : 'view'} ${kb?.name || 'it'}`, {
      action: { label: 'Undo', run: () => { r.status = 'pending'; delete r.decidedAt; delete r.decidedBy; if (kb) { setPersonaKbRole(kb, r.user, prevRole); if (share) kb.shares = kb.shares.filter(s => s !== share); } unaudit([ev]); refresh(); } },
    });
  };
  A['req-deny'] = el => {
    const r = D.requests.find(x => x.id === el.dataset.id); if (!r || r.status !== 'pending') return;
    const m = memberById(r.user); const kb = kbById(r.kb);
    r.status = 'denied'; r.decidedAt = Date.now(); r.decidedBy = me().id;
    const ev = audit('Denied access request', `${m?.name || 'Someone'} → ${kb?.name || ''}`);
    refresh();
    toast(m ? `Denied ${first(m.name)}’s request` : 'Request denied', { tone: 'accent', action: { label: 'Undo', run: () => { r.status = 'pending'; delete r.decidedAt; delete r.decidedBy; unaudit([ev]); refresh(); } } });
  };
})();

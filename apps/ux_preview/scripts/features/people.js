/* People: members, groups, roles and access requests (/people?tab=…).
   Shared actions: member-add, member-open, req-approve, req-deny. */
(() => {
  'use strict';

  const AREA = 'People';
  /** Knowledge access role words, one map product-wide (core/lifecycle.js KB_ROLES). */
  const accessLabel = r => (KB_ROLES[r] || KB_ROLES.viewer).label;
  const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };
  const KB_PREVIEW = 5;
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
  /** One primary action per tab: the thing you came to that tab to do. */
  const TAB_ACTION = {
    // One primary: Add people. An invite link (for people whose email you don't have) is offered inside its dialog (features/shares.js).
    members: () => can('user.manage') ? btn('Add people', { v: 'primary', icon: 'user-plus', act: 'member-add' }) : '',
    groups: () => can('group.manage') ? btn('New group', { v: 'primary', icon: 'plus', act: 'ppl-group-create' }) : '',
    roles: () => can('role.manage') ? btn('New role', { v: 'primary', icon: 'plus', act: 'ppl-role-create' }) : '',
    requests: () => '',
  };
  /** People's sections are sidebar sub-rows of People (pageSections); Access requests counts who's waiting. */
  const sections = () => pageSections('/people', [
    { id: 'members', label: 'Members' },
    { id: 'groups', label: 'Groups' },
    { id: 'roles', label: 'Roles' },
    { id: 'requests', label: 'Access requests', count: pendingRequests().length },
  ]);
  (X.sections ||= {}).people = () => sections().nav();
  P.people = ({ query }) => {
    const s = sections(), tab = s.section(query);
    const head = pageHeader({ title: s.title(query), actions: TAB_ACTION[tab]() });
    const body = { members: membersTab, groups: groupsTab, roles: rolesTab, requests: requestsTab }[tab]();
    return `<div class="page page--wide">${head}${body}</div>`;
  };

  /* ══════════════ Members ══════════════ */
  function memberRows() {
    const u = ui('pplM');
    const rows = D.members.filter(m => (!u.role || m.roleId === u.role) && (!u.status || m.status === u.status) && matchesQ('pplM', m.name, m.email));
    return applySort(rows, 'pplM', { name: m => m.name, role: m => roleById(m.roleId)?.name || '', last: m => m.lastActive || 0 });
  }
  /** The role reads as words (admins carry a shield): changing it is a deliberate choice in the role dialog, never a live
      select on every row. */
  function roleText(m) {
    const r = roleById(m.roleId);
    return `<span class="ppl-role">${r?.id === 'r-admin' ? ic('shield', 'i-xs') : ''}<span class="truncate">${esc(r?.name || '—')}</span></span>`;
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
    const manage = can('user.manage');
    /* Search and filters only when there's a list to narrow (not on the empty or error state). Selecting rows swaps them for
       the selection toolbar in the same place, right above the rows it acts on. */
    const tools = S.pageState !== 'empty' && S.pageState !== 'error' && needsTools(D.members.length, 'pplM', ['role', 'status']);
    const pick = tools && manage;
    const bulk = pick ? selectionBar('pplM', btn('Change role…', { v: 'ghost', size: 'sm', icon: 'shield', act: 'ppl-bulk-role' })
      + (D.groups.length && can('group.manage') ? btn('Add to group', { v: 'ghost', size: 'sm', icon: 'users', iconRight: 'chevron-down', menu: 'ppl-bulk-group' }) : '')
      + btn('Suspend', { v: 'ghost', size: 'sm', icon: 'pause', act: 'ppl-bulk-suspend' })) : '';
    const toolbar = bulk || (tools ? `<div class="toolbar">${searchField({ uiKey: 'pplM', placeholder: 'Search by name or email' })}${filterButton('Role', 'pplM', 'role', D.roles.map(r => [r.id, r.name]))}${filterButton('Status', 'pplM', 'status', [['active', 'Active'], ['invited', 'Invited'], ['suspended', 'Suspended']])}${clearFilters('pplM', ['role', 'status'])}${live ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'person', 'people')}</span>` : ''}</div>` : '');
    return toolbar + gate({
      empty: () => emptyState({ icon: 'users', boxed: true, title: 'Only you are here', desc: 'Add people by their work email. Anyone without a BoMesh account gets an email invite.' }),
      ok: () => {
        if (!rows.length) return noMatches('pplM', ['role', 'status'], 'people');
        const page = paginate(rows, 'pplM', 20); const ids = page.map(m => m.id);
        /* Groups get a column once someone is in one (a column of dashes says nothing). Status sits next to the name, only
           when it isn't the usual "Active". Account actions are the row's ⋯; the row opens the person. */
        const showGroups = D.members.some(m => m.groups.length);
        const head = (pick ? selAllCheck('pplM', ids) : '') + sortHead('Person', 'name', 'pplM') + sortHead('Role', 'role', 'pplM') + (showGroups ? th('Groups', 'hide-md') : '') + sortHead('Last active', 'last', 'pplM') + (manage ? th('<span class="sr-only">Actions</span>', 'table__column--actions') : '');
        const trs = page.map(m => {
          const self = m.id === me().id;
          const flag = self ? chip('You', { size: 'sm' }) : m.status !== 'active' ? status('member', m.status) : '';
          const more = manage && memberActions(m).length ? `<span class="reveal-on-hover">${iconBtn('more', `Options for ${m.name}`, { size: 'sm', menu: 'ppl-row', data: { id: m.id } })}</span>` : '';
          return `<tr class="${cx('table__row', fresh.has(m.id) && 'table__row--new')}" data-act="member-open" data-id="${m.id}" tabindex="0" ${u.sel?.[m.id] ? 'aria-selected="true"' : ''}>
            ${pick ? selCheck('pplM', m.id, 'Select ' + m.name) : ''}
            <td class="table__cell table__cell--primary"><span class="row gap-12">${avatar(m.name)}<span class="stack" style="min-width:0"><span class="row gap-6"><span class="cell-title truncate">${esc(m.name)}</span>${flag}</span><span class="cell-sub truncate">${esc(m.email)}</span></span></span></td>
            <td class="table__cell">${roleText(m)}</td>
            ${showGroups ? `<td class="table__cell hide-md table__cell--hide-sm">${groupChips(m.groups)}</td>` : ''}
            <td class="table__cell muted"><span class="ppl-nowrap">${m.status === 'invited' ? `Invited ${relInline(m.invitedAt || m.joined)}` : m.lastActive ? rel(m.lastActive) : 'Not yet'}</span></td>
            ${manage ? `<td class="table__cell table__cell--actions">${more}</td>` : ''}</tr>`;
        });
        return table({ head, rows: trs, label: 'Members' }) + pager(rows.length, 'pplM', 20);
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
    /* Whole sentences localized first (sentence()), then filled: "{0} is now {1}" alone has too few words for the page translator. */
    const name = role.system ? tr(role.name) ?? role.name : role.name;
    const msg = ms.length > 1 ? sentence('{0} people are now {1}', ms.length, name) : sentence('{0} is now {1}', ms[0].name, name);
    toast(msg + (blocked.length ? sentence(' · {0} skipped', plural(blocked.length, 'person', 'people')) : ''), { action: { label: 'Undo', run: () => { prev.forEach(([m, r]) => (m.roleId = r)); unaudit(evs); refresh(); toast('Role change undone', { tone: 'accent' }); } } });
  }
  MENUS['ppl-row'] = el => { const m = memberById(el.dataset.id); return m ? memberActions(m) : []; };
  A['ppl-bulk-role'] = () => openRolePick(selIds('pplM'), true);
  MENUS['ppl-bulk-group'] = () => [{ section: 'Add to group' }, ...D.groups.map(g => ({ label: g.name, run: () => addToGroup(selIds('pplM'), g.id) }))];
  A['ppl-bulk-suspend'] = () => suspend(selIds('pplM'), () => { ui('pplM').sel = {}; });

  /** The role dialog: every role with what it's for, so the choice is made knowing what it grants (one person from a row or
      the drawer, or everyone selected). Making someone an admin says what that means before it applies; any change applies
      on Change role with Undo. */
  function openRolePick(ids, bulk = false) {
    const ms = ids.map(memberById).filter(Boolean); if (!ms.length || !can('user.manage')) return;
    const same = ms.every(m => m.roleId === ms[0].roleId);
    S.ui.pplRP = { ids: ms.map(m => m.id), role: same ? ms[0].roleId : '', bulk };
    openModal('ppl-role-pick', {});
  }
  M['ppl-role-pick'] = () => {
    const f = ui('pplRP'); const ms = f.ids.map(memberById).filter(Boolean); const one = ms.length === 1 ? ms[0] : null;
    const current = ms.every(m => m.roleId === ms[0]?.roleId) ? ms[0]?.roleId : '';
    const options = D.roles.map(r => [r.id, r.name, (r.id === current ? chip('Current', { size: 'sm' }) + ' ' : '') + esc(r.desc || '')]);
    const promote = f.role === 'r-admin' && ms.some(m => m.roleId !== 'r-admin');
    const blocked = ms.filter(m => roleGuard(m));
    return {
      title: one ? `Change ${one.name}’s role` : `Change role for ${ms.length} people`, icon: 'shield',
      body: `<div class="ppl-rp">${choiceGroup({ name: 'ppl-rp', value: f.role, options, act: 'ppl-rp-pick' })}</div>`
        + (promote ? `<div class="mt-12">${alertBox('warning', 'Admins have full control', 'They can add and remove people, change roles and settings, and manage every collection.')}</div>` : '')
        + (blocked.length && !one ? `<p class="t-sm muted mt-12">${blocked.length === 1 ? '1 person keeps their role: your own role and the last admin’s can’t change.' : `${blocked.length} people keep their role: your own role and the last admin’s can’t change.`}</p>` : ''),
      footStart: linkBtn('Compare roles', { act: 'ppl-rp-compare', icon: 'arrow-right' }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Change role', { v: 'primary', act: 'ppl-rp-save' }),
    };
  };
  A['ppl-rp-pick'] = el => { ui('pplRP').role = el.dataset.value; refreshLayer(); };
  A['ppl-rp-compare'] = () => { closeModal(); go('/people?tab=roles'); };
  A['ppl-rp-save'] = () => {
    if (S.modal?.name !== 'ppl-role-pick') return; const f = ui('pplRP');
    if (!f.role || f.ids.every(id => memberById(id)?.roleId === f.role)) { closeModal(); return; }
    closeModal();
    setRole(f.ids, f.role, f.bulk ? () => { ui('pplM').sel = {}; } : undefined);
  };
  /** Add everyone selected to a group (those already in it are left as they are); at once, with Undo. */
  function addToGroup(ids, groupId) {
    const g = groupById(groupId); if (!g || !can('group.manage')) return;
    const ms = ids.map(memberById).filter(m => m && !m.groups.includes(g.id));
    ui('pplM').sel = {};
    if (!ms.length) { refresh(); toast(`Everyone selected is already in ${g.name}`, { tone: 'accent' }); return; }
    ms.forEach(m => { m.groups = [...m.groups, g.id]; });
    syncKbs(ms.map(m => m.id), [g.id]);
    const evs = ms.map(m => audit(`Added to group ${g.name}`, m.name)); refresh();
    toast(ms.length === 1 ? `Added ${ms[0].name} to ${g.name}` : `Added ${ms.length} people to ${g.name}`, { action: { label: 'Undo', run: () => { ms.forEach(m => { m.groups = m.groups.filter(x => x !== g.id); }); syncKbs(ms.map(m => m.id), [g.id]); unaudit(evs); refresh(); } } });
  }

  /** Suspending is reversible: it applies at once and the toast offers Undo (no dialog). */
  function suspend(ids, after) {
    const all = ids.map(memberById).filter(m => m && m.status === 'active');
    const ms = all.filter(m => !accountGuard(m, 'suspend'));
    if (!ms.length) { toast(all.length ? accountGuard(all[0], 'suspend') : 'No one selected can be suspended', { tone: 'danger' }); return; }
    const evs = ms.map(m => { m.status = 'suspended'; return audit('Suspended member', m.name); });
    after?.(); refresh();
    const skipped = all.length - ms.length;
    toast((ms.length === 1 ? `Suspended ${ms[0].name}` : `Suspended ${ms.length} people`) + (skipped ? ` · ${plural(skipped, 'person', 'people')} skipped` : ''), { action: { label: 'Undo', run: () => { ms.forEach(m => (m.status = 'active')); unaudit(evs); refresh(); } } });
  }
  function reactivate(id) {
    const m = memberById(id); if (!m || m.status !== 'suspended') return;
    m.status = 'active'; const ev = audit('Reactivated member', m.name); refresh();
    toast(`${first(m.name)} can sign in again`, { action: { label: 'Undo', run: () => { m.status = 'suspended'; unaudit([ev]); refresh(); } } });
  }
  /** Removing is high-risk (access ends now, chats are deleted later): it asks once and has no Undo. */
  function remove(id) {
    const m = memberById(id); if (!m || accountGuard(m, 'remove')) return; const ws = curWs();
    confirmAction({
      title: `Remove ${m.name}?`, body: `They lose access to ${esc(ws.name)} right away. Their chats are deleted after 30 days.`, confirm: 'Remove', danger: true,
      onConfirm: () => {
        const i = D.members.indexOf(m); if (i < 0) return;
        D.members.splice(i, 1); ws.members = Math.max(0, (ws.members || 1) - 1);
        if (ui('pplM').sel) delete ui('pplM').sel[m.id];
        audit('Removed member', m.name);
        if (S.drawer?.name === 'ppl-member') S.drawer = null;
        refresh(); toast(`Removed ${m.name}`);
      },
    });
  }
  /** An invite that hasn't been accepted: revoking deletes nothing, so it applies at once with Undo. */
  function revokeInvite(id) {
    const m = memberById(id); if (!m || m.status !== 'invited') return;
    const i = D.members.indexOf(m); D.members.splice(i, 1);
    const ev = audit('Revoked invite', m.email);
    if (S.drawer?.name === 'ppl-member') S.drawer = null;
    refresh();
    toast(`Revoked the invite to ${m.email}`, { action: { label: 'Undo', run: () => { if (!memberById(m.id)) D.members.splice(i, 0, m); unaudit([ev]); refresh(); } } });
  }
  function resendInvite(id) {
    const m = memberById(id); if (!m || m.status !== 'invited') return;
    m.invitedAt = Date.now(); audit('Resent invite', m.email); refresh();
    toast(`Sent the invite to ${m.email} again`);
  }
  A['ppl-invite-resend'] = el => resendInvite(el.dataset.id);

  /* ── Member drawer ── */
  function openMember(id) {
    if (!memberById(id)) return;
    S.ui.pplMD = { id };
    openDrawer('ppl-member', { id });
  }
  A['member-open'] = el => openMember(el.dataset.id);
  /** What the person can open because someone chose them: direct shares, their groups, and restricted bases of their spaces.
      Bases everyone can open are only counted (they'd bury the grants that matter). */
  function kbAccess(m) {
    const grants = [], everyone = [];
    sharedKbs().forEach(k => {
      const direct = k.shares.find(s => s.kind === 'user' && s.id === m.id);
      const grp = k.shares.filter(s => s.kind === 'group' && m.groups.includes(s.id));
      const sp = k.space && spaceById(k.space);
      if (direct) grants.push({ kb: k, via: 'Shared directly', role: direct.role });
      else if (grp.length) grants.push({ kb: k, via: grp.map(s => groupById(s.id)?.name).filter(Boolean).join(', '), role: grp.reduce((best, s) => (ROLE_RANK[s.role] > ROLE_RANK[best] ? s.role : best), 'viewer') });
      else if (k.general === 'restricted' && sp?.members?.some(x => x.user === m.id)) grants.push({ kb: k, via: `Member of ${sp.name}`, role: 'viewer' });
      else if (k.general === 'workspace') everyone.push(k);
    });
    return { grants, everyone };
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
  /** Add to or take out of a group: applies at once with Undo (member drawer and group drawer alike). */
  function toggleGroup(memberId, groupId) {
    const m = memberById(memberId), g = groupById(groupId); if (!m || !g) return;
    const on = !m.groups.includes(g.id), prev = [...m.groups];
    m.groups = on ? [...m.groups, g.id] : m.groups.filter(x => x !== g.id);
    syncKbs([m.id], [g.id]);
    const ev = audit(on ? `Added to group ${g.name}` : `Removed from group ${g.name}`, m.name); refresh();
    toast(on ? `Added ${m.name} to ${g.name}` : `Removed ${m.name} from ${g.name}`, { action: { label: 'Undo', run: () => { m.groups = prev; syncKbs([m.id], [g.id]); unaudit([ev]); refresh(); } } });
  }
  DR['ppl-member'] = ({ id }) => {
    const m = memberById(id);
    if (!m) return { title: 'Member removed', body: emptyState({ icon: 'user', title: 'This person is no longer a member', compact: true }) };
    const f = S.ui.pplMD?.id === id ? S.ui.pplMD : (S.ui.pplMD = { id });
    const self = m.id === me().id, invited = m.status === 'invited'; const role = roleById(m.roleId) || D.roles[0];
    const rWhy = roleGuard(m);
    const { grants, everyone } = kbAccess(m);
    const lastSi = D.signins.filter(s => s.user === m.id).sort((a, b) => b.at - a.at)[0];
    const sec = (title, html) => `<section class="drawer__section"><h3 class="drawer__section-title">${esc(title)}</h3>${html}</section>`;
    const kbShown = f.allKb ? grants : grants.slice(0, KB_PREVIEW);
    const plus = everyone.length ? `<p class="t-sm muted ${grants.length ? 'mt-8' : ''}">${grants.length ? `Plus ${plural(everyone.length, 'collection')} everyone can open.` : `Only the ${plural(everyone.length, 'collection')} everyone can open.`}</p>` : '';
    const kbHtml = role.id === 'r-admin' ? `<p class="t-sm muted">Workspace admins can open every collection.</p>`
      : grants.length ? list(kbShown.map(a => item({ lead: kbDot(a.kb), title: esc(a.kb.name), desc: esc(a.via), meta: esc(accessLabel(a.role)), href: kbManageHref(a.kb, 'access') })))
        + (grants.length > KB_PREVIEW ? `<div class="mt-8">${linkBtn(f.allKb ? 'Show fewer' : `Show all ${grants.length}`, { act: 'ui-toggle', data: { path: 'pplMD.allKb' } })}</div>` : '') + plus
      : plus || `<p class="t-sm muted">No collections shared with ${esc(first(m.name))}.</p>`;
    const notice = m.status === 'suspended' ? alertBox('danger', 'Suspended', `${esc(first(m.name))} can’t sign in until reactivated.`, btn('Reactivate', { v: 'secondary', size: 'sm', icon: 'play', act: 'ppl-md-reactivate', data: { id } }))
      : invited ? alertBox('accent', 'Invite sent', `${esc(m.email)} hasn’t accepted yet. Sent ${esc(relInline(m.invitedAt || m.joined))}. Their role and groups apply once they join.`, btn('Resend invite', { v: 'secondary', size: 'sm', icon: 'send', act: 'ppl-invite-resend', data: { id } }), { icon: 'mail' }) : '';
    /* Role: what it is and what it's for, with Change (the role dialog). Groups: the ones they're in, removable, plus Add. */
    const canRole = can('user.manage') && !rWhy;
    const roleHtml = `<div class="ppl-md-role"><div class="grow" style="min-width:0"><div class="medium">${esc(role.name)}</div><p class="t-sm muted mt-4">${rWhy ? esc(rWhy) + '.' : esc(role.desc || '')}</p></div>${canRole ? btn('Change', { v: 'secondary', size: 'sm', act: 'ppl-md-role', data: { id } }) : ''}</div>`;
    const gManage = can('group.manage'), mine = D.groups.filter(g => m.groups.includes(g.id));
    const gChips = mine.map(g => `<span class="ppl-chip ppl-chip--group"><span class="truncate">${esc(g.name)}</span>${gManage ? `<button type="button" class="ppl-chip__x" data-act="ppl-md-group" data-id="${g.id}" data-member="${m.id}" aria-label="${esc(`Remove from ${g.name}`)}">${ic('x', 'i-xs')}</button>` : ''}</span>`).join('');
    const gAdd = gManage && D.groups.length > mine.length ? btn('Add to group', { v: 'ghost', size: 'sm', icon: 'plus', menu: 'ppl-md-addgroup', data: { id } }) : '';
    const groupsHtml = !D.groups.length ? `<p class="t-sm muted">No groups yet.</p>` : mine.length || gAdd ? `<div class="ppl-md-groups">${gChips}${gAdd}</div>` : `<p class="t-sm muted">Not in any group.</p>`;
    const body = (notice ? `<div class="mb-16">${notice}</div>` : '') +
      sec('Role', roleHtml) +
      sec('Groups', groupsHtml) +
      sec('Knowledge access', kbHtml) +
      (() => { const sps = hasModule('spaces') ? spacesOf(m) : []; return sps.length ? sec('Spaces', list(sps.map(s => item({ lead: spaceLead(s.sp), title: esc(s.sp.name), desc: esc([s.type.label, s.sp.code].filter(Boolean).join(' · ')), meta: esc(s.role), href: '/space/' + s.sp.id })))) : ''; })() +
      (invited ? '' : `<section class="drawer__section">${disclosure({ path: 'pplMD.more', icon: 'log-in', title: 'Sign-in details', summary: esc(`Joined ${fmtDate(m.joined)}`),
        body: kv([['Last sign-in', lastSi ? `${esc(lastSi.method)} · ${esc(lastSi.device)} · ${rel(lastSi.at)}` : 'No sign-ins yet']]) })}</section>`);
    return {
      title: m.name + (self ? ' (you)' : ''), desc: `<span>${esc(m.email)}</span> · <span>${invited ? 'Invited' : m.lastActive ? esc(`Last active ${rel(m.lastActive)}`) : 'Not active yet'}</span>`, lead: avatar(m.name, 'lg'), body,
      headActions: memberActions(m, true).length ? iconBtn('more', 'More actions', { menu: 'ppl-md-more', data: { id } }) : '',
    };
  };
  /** Account actions for a row's ⋯ and the drawer's ⋯; guarded ones (yourself, the last admin) are hidden. The drawer
      already shows Change (role), Reactivate and Resend invite, so its menu leaves them out. */
  function memberActions(m, inDrawer = false) {
    if (!can('user.manage')) return [];
    const items = [];
    if (!inDrawer && !roleGuard(m)) items.push({ label: 'Change role…', icon: 'shield', run: () => openRolePick([m.id]) });
    if (m.status === 'invited') {
      if (!inDrawer) items.push({ label: 'Resend invite', icon: 'send', run: () => resendInvite(m.id) });
      return [...items, ...(items.length ? [{ sep: true }] : []), { label: 'Revoke invite', icon: 'x-circle', danger: true, run: () => revokeInvite(m.id) }];
    }
    if (m.status === 'active' && !accountGuard(m, 'suspend')) items.push({ label: 'Suspend', icon: 'pause', run: () => suspend([m.id]) });
    if (!inDrawer && m.status === 'suspended') items.push({ label: 'Reactivate', icon: 'play', run: () => reactivate(m.id) });
    if (!accountGuard(m, 'remove')) items.push(...(items.length ? [{ sep: true }] : []), { label: 'Remove from workspace', icon: 'trash', danger: true, run: () => remove(m.id) });
    return items;
  }
  MENUS['ppl-md-more'] = el => { const m = memberById(el.dataset.id); return m ? memberActions(m, true) : []; };
  MENUS['ppl-md-addgroup'] = el => { const m = memberById(el.dataset.id); return m ? [{ section: 'Add to group' }, ...D.groups.filter(g => !m.groups.includes(g.id)).map(g => ({ label: g.name, run: () => toggleGroup(m.id, g.id) }))] : []; };
  A['ppl-md-role'] = el => openRolePick([el.dataset.id]);
  A['ppl-md-group'] = el => toggleGroup(el.dataset.member, el.dataset.id);
  A['ppl-md-reactivate'] = el => reactivate(el.dataset.id);

  /* ── Add people ── */
  /** Only real blockers: an invalid address, or someone already here. Emails without an account get an invite. */
  function emailProblem(e) {
    if (!EMAIL_RE.test(e)) return 'Not a valid email address';
    const m = D.members.find(x => x.email.toLowerCase() === e);
    if (m) return m.status === 'invited' ? 'Already invited' : 'Already a member';
    return '';
  }
  const isHere = why => why === 'Already a member' || why === 'Already invited';
  /** Has a BoMesh account (joins right away) or not (gets an email invite). */
  const hasAccount = e => (D.knownAccounts || []).includes(e) || Object.values(PERSONAS).some(p => p.email.toLowerCase() === e) || (D.pUsers || []).some(u => u.email === e && u.status !== 'invited');
  function commitEmails(text) {
    const f = ui('pplAdd');
    text.split(/[\s,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean).forEach(e => { if (!f.emails.includes(e)) f.emails.push(e); });
  }
  const myDomain = () => (me().email || '').split('@')[1] || 'company.com';
  A['member-add'] = () => {
    if (!can('user.manage')) return;
    S.ui.pplAdd = { draft: '', emails: [], role: 'r-member', groups: [], tried: false, showGroups: false };
    openModal('ppl-add', {});
  };
  M['ppl-add'] = p => {
    const f = ui('pplAdd');
    const checks = f.emails.map(e => [e, emailProblem(e)]);
    const bad = checks.filter(([, why]) => why);
    const draft = f.draft.trim().toLowerCase(); const draftOk = !!draft && !emailProblem(draft) && !f.emails.includes(draft);
    const ok = [...checks.filter(([, why]) => !why).map(([e]) => e), ...(draftOk ? [draft] : [])];
    const nInv = ok.filter(e => !hasAccount(e)).length, nAdd = ok.length - nInv;
    const role = roleById(f.role) || D.roles[0];
    const none = f.tried && !f.emails.length && !draft;
    const chips = checks.map(([e, why]) => {
      const invite = !why && !hasAccount(e);
      const tone = why ? (isHere(why) ? 'is-warn' : 'is-invalid') : invite ? 'is-invite' : '';
      const tip = why || (invite ? 'Gets an email invite' : '');
      const lead = why ? ic(isHere(why) ? 'user' : 'alert-circle', 'i-xs') : invite ? ic('mail', 'i-xs') : avatar(nameFromEmail(e), 'xs');
      return `<span class="${cx('ppl-chip', tone)}" ${tip ? `data-tip="${esc(tip)}"` : ''}>${lead}<span class="truncate">${esc(e)}</span><button type="button" class="ppl-chip__x" data-act="ppl-add-rm" data-email="${esc(e)}" aria-label="Remove ${esc(e)}">${ic('x', 'i-xs')}</button></span>`;
    }).join('');
    const ready = [nAdd ? (nAdd === 1 ? '1 person joins right away' : `${nAdd} people join right away`) : '', nInv ? (nInv === 1 ? '1 gets an email invite' : `${nInv} get an email invite`) : ''].filter(Boolean);
    const status = none ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>Add at least one email address.</span></div>`
      : bad.length ? `<div class="ppl-add-issues" role="alert"><div class="row between gap-8"><span class="ppl-add-issues__title">${bad.length === 1 ? 'One email can’t be added' : `${bad.length} emails can’t be added`}</span>${linkBtn(bad.length === 1 ? 'Remove it' : 'Remove them', { act: 'ppl-add-clean' })}</div>${bad.map(([e, why]) => `<div class="ppl-add-issue">${ic(isHere(why) ? 'user' : 'alert-circle', 'i-xs')}<span class="truncate medium">${esc(e)}</span><span class="ppl-add-issue__why">${esc(why)}</span></div>`).join('')}</div>`
        : ready.length ? `<div class="ppl-add-ok">${ic('check-circle', 'i-xs')}<span>${ready.map(esc).join(' · ')}</span></div>`
          : '<div class="description">Separate with commas or spaces, or paste a list.</div>';
    const emails = `<div class="field"><label class="label" for="ppl-add-email">Emails</label><div class="${cx('ppl-chipin', (bad.some(([, w]) => !isHere(w)) || none) && 'is-invalid')}" data-act="ppl-add-focus">${chips}<input id="ppl-add-email" class="ppl-chipin__input" type="text" value="${esc(f.draft)}" placeholder="${f.emails.length ? 'Add another' : `name@${esc(myDomain())}`}" data-bind="pplAdd.draft" data-live data-input="ppl-add-input" data-enter="ppl-add-enter" autocomplete="off" spellcheck="false" data-autofocus aria-describedby="ppl-add-status"${none ? ' aria-invalid="true"' : ''}></div><div id="ppl-add-status">${status}</div></div>`;
    const roleF = field({ id: 'ppl-add-role', label: 'Role', desc: esc(role.desc), control: select({ id: 'ppl-add-role', bind: 'pplAdd.role', value: f.role, options: D.roles.map(r => [r.id, r.name]), change: 'ppl-add-refresh', attrs: p.busy ? 'disabled' : '' }) });
    const picked = D.groups.filter(g => f.groups.includes(g.id));
    const groupsF = D.groups.length ? disclosure({
      path: 'pplAdd.showGroups', icon: 'users', title: 'Add to groups',
      summary: picked.length ? esc(picked.length <= 2 ? picked.map(g => g.name).join(', ') : plural(picked.length, 'group')) : 'None',
      body: `<div class="option-list">${D.groups.map(g => checkbox({ label: esc(g.name), checked: f.groups.includes(g.id), act: 'ppl-add-group', data: { id: g.id }, disabled: p.busy })).join('')}</div>`,
    }) : '';
    const label = nAdd && nInv ? `Add ${nAdd} · invite ${nInv}` : nInv ? (nInv === 1 ? 'Send invite' : `Invite ${nInv} people`) : nAdd > 1 ? `Add ${nAdd} people` : nAdd === 1 ? 'Add person' : 'Add people';
    return {
      title: 'Add people', icon: 'user-plus', size: 'lg',
      desc: `Type or paste their work emails. People with a BoMesh account join ${esc(curWs().name)} right away; anyone else gets an email invite.`,
      body: emails + roleF + groupsF,
      // People whose email you don't have: an invite link instead (the header keeps one primary, Add people).
      footStart: p.busy ? '' : linkBtn('Invite with a link instead', { act: 'ppl-add-link', icon: 'link' }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: p.busy }) + btn(label, { v: 'primary', icon: nInv && !nAdd ? 'send' : 'user-plus', act: 'ppl-add-submit', loading: p.busy, id: 'ppl-add-submit' }),
    };
  };
  A['ppl-add-refresh'] = () => refreshLayer();
  A['ppl-add-link'] = () => { closeModal(); A['sh-invite']?.({ dataset: { type: 'workspace' } }); };
  const focusEmails = () => requestAnimationFrame(() => $('#ppl-add-email')?.focus());
  A['ppl-add-focus'] = () => $('#ppl-add-email')?.focus();
  A['ppl-add-input'] = el => {
    const v = el.value; if (!/[,;\s]/.test(v)) return;
    const parts = v.split(/[,;\s]+/); const rest = /[,;\s]$/.test(v) ? '' : parts.pop();
    commitEmails(parts.join(',')); ui('pplAdd').draft = rest; refreshLayer();
  };
  A['ppl-add-enter'] = () => { const f = ui('pplAdd'); if (f.draft.trim()) { commitEmails(f.draft); f.draft = ''; refreshLayer(); } else A['ppl-add-submit'](); };
  A['ppl-add-rm'] = el => { const f = ui('pplAdd'); f.emails = f.emails.filter(e => e !== el.dataset.email); refreshLayer(); focusEmails(); };
  A['ppl-add-clean'] = () => { const f = ui('pplAdd'); f.emails = f.emails.filter(e => !emailProblem(e)); refreshLayer(); focusEmails(); };
  A['ppl-add-group'] = el => { const f = ui('pplAdd'); const g = el.dataset.id; f.groups = f.groups.includes(g) ? f.groups.filter(x => x !== g) : [...f.groups, g]; refreshLayer(); };
  /* Backspace in an empty email box takes back the last chip (standard tag-input behaviour). */
  document.addEventListener('keydown', e => {
    if (e.key !== 'Backspace' || e.target.id !== 'ppl-add-email' || e.target.value || S.modal?.props?.busy) return;
    const f = S.ui.pplAdd; if (!f?.emails.length) return;
    e.preventDefault(); f.draft = f.emails.pop(); refreshLayer(); focusEmails();
  });
  A['ppl-add-submit'] = async () => {
    const f = ui('pplAdd'); const p = S.modal?.props; if (!p || p.busy || S.modal.name !== 'ppl-add') return;
    if (f.draft.trim()) { commitEmails(f.draft); f.draft = ''; }
    f.tried = true;
    if (!f.emails.length || f.emails.some(emailProblem)) { refreshLayer(); focusEmails(); return; }
    p.busy = true; p.guard = true; refreshLayer();
    await sleep(700);
    const now = Date.now();
    const added = f.emails.map(e => { const inv = !hasAccount(e); return { id: uid('u'), name: nameFromEmail(e), email: e, roleId: f.role, groups: [...f.groups], status: inv ? 'invited' : 'active', lastActive: null, joined: now, ...(inv ? { invitedAt: now } : {}) }; });
    const joined = added.filter(m => m.status === 'active'), invited = added.filter(m => m.status === 'invited');
    D.members.unshift(...added);
    const evs = added.map(m => audit(m.status === 'invited' ? 'Invited member' : 'Added member', m.status === 'invited' ? m.email : m.name));
    /* Invitees get a pending BoMesh account, so the platform's Users list shows them as Invited. */
    const accounts = invited.filter(m => !(D.pUsers || []).some(u => u.email === m.email)).map(m => ({ id: uid('pu'), name: m.name, email: m.email, ws: 1, platformAdmin: false, status: 'invited', last: null }));
    D.pUsers?.push(...accounts);
    curWs().members += joined.length;
    markFresh(added.map(m => m.id));
    Object.assign(ui('pplM', {}), { q: '', role: '', status: '', page: 1, sort: null });
    closeModal();
    if (S.cur.path !== '/people' || (S.cur.query.tab && S.cur.query.tab !== 'members')) go('/people?tab=members'); else refresh();
    const said = [joined.length ? (joined.length <= 2 ? `Added ${names(joined.map(m => m.name))}` : `Added ${joined.length} people`) : '', invited.length ? (invited.length === 1 ? `Invited ${invited[0].email}` : `Invited ${invited.length} people`) : ''].filter(Boolean).join(' · ');
    toast(said, {
      action: { label: 'Undo', run: () => { D.members = D.members.filter(m => !added.includes(m)); if (D.pUsers) D.pUsers = D.pUsers.filter(u => !accounts.includes(u)); curWs().members -= joined.length; unaudit(evs); refresh(); } },
    });
  };

  /* ══════════════ Groups ══════════════ */
  function groupsTab() {
    ui('pplG', { q: '' });
    const rows = D.groups.filter(g => matchesQ('pplG', g.name, g.desc));
    const toolbar = needsTools(D.groups.length, 'pplG') ? `<div class="toolbar">${searchField({ uiKey: 'pplG', placeholder: 'Search groups' })}</div>` : '';
    return toolbar + gate({
      loading: () => skelCards(6),
      empty: () => emptyState({ icon: 'users', boxed: true, title: 'No groups yet', desc: 'Groups let you share knowledge with a whole team in one step.' }),
      ok: () => !rows.length ? noMatches('pplG', [], 'groups') : `<div class="grid cols-3">${rows.map(g => {
        const ms = groupMembers(g.id); const kbs = groupKbs(g.id);
        return `<div class="${cx('card card--action ppl-group', fresh.has(g.id) && 'ppl-fresh')}" role="button" tabindex="0" data-act="ppl-group-open" data-id="${g.id}">
          <span class="card__title truncate">${esc(g.name)}</span>
          <p class="t-sm muted clamp-2 ppl-group__desc">${esc(g.desc || 'No description')}</p>
          <div class="row between gap-8">${ms.length ? `<span class="row gap-8"><span class="avatar-group">${ms.slice(0, 4).map(m => avatar(m.name, 'sm')).join('')}</span><span class="t-xs muted num">${plural(ms.length, 'member')}</span></span>` : '<span class="t-xs muted">No members</span>'}<span class="t-xs muted">${kbs.length ? plural(kbs.length, 'collection') : ''}</span></div></div>`;
      }).join('')}</div>`,
    });
  }
  const groupErr = (name, id) => { const n = name.trim(); if (!n) return 'Enter a group name.'; if (D.groups.some(g => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) return 'A group with this name already exists.'; return ''; };
  function openGroup(id) { if (!groupById(id)) return; S.ui.pplGD = { id, q: '' }; openDrawer('ppl-group', { id }); }
  A['ppl-group-open'] = el => openGroup(el.dataset.id);
  /** Creating a group is a small form (name, optional description). Renaming happens on the group's own title. */
  A['ppl-group-create'] = () => { if (!can('group.manage')) return; S.ui.pplGN = { name: '', desc: '', touched: false }; openModal('ppl-group-form', {}); };
  M['ppl-group-form'] = p => {
    const f = ui('pplGN');
    const err = f.touched || f.name.trim() ? groupErr(f.name) : ''; const dis = p.busy ? ' disabled' : '';
    return {
      title: 'Create group', icon: 'users',
      desc: 'Share knowledge with a whole team in one step.',
      body: field({ id: 'ppl-gn-name', label: 'Name', required: true, error: err, control: input({ id: 'ppl-gn-name', bind: 'pplGN.name', value: f.name, placeholder: 'e.g. Customer support', autofocus: true, invalid: !!err, attrs: `data-live maxlength="40"${dis}`, onEnter: 'ppl-gn-save' }) }) +
        field({ id: 'ppl-gn-desc', label: 'Description', optional: true, control: input({ id: 'ppl-gn-desc', bind: 'pplGN.desc', value: f.desc, placeholder: 'Who belongs in this group', attrs: `maxlength="80"${dis}`, onEnter: 'ppl-gn-save' }) }),
      footStart: 'Next, you’ll add people to it.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: p.busy }) + btn('Create group', { v: 'primary', icon: 'plus', act: 'ppl-gn-save', loading: p.busy }),
    };
  };
  A['ppl-gn-save'] = async () => {
    const p = S.modal?.props; if (!p || p.busy || S.modal.name !== 'ppl-group-form') return; const f = ui('pplGN'); f.touched = true;
    if (groupErr(f.name)) { refreshLayer(); $('#ppl-gn-name')?.focus(); return; }
    p.busy = true; p.guard = true; refreshLayer(); await sleep(500);
    const g = { id: uid('g'), name: f.name.trim(), desc: f.desc.trim() };
    D.groups.push(g); audit('Created group', g.name); markFresh([g.id]);
    closeModal();
    if (S.cur.path !== '/people' || S.cur.query.tab !== 'groups') go('/people?tab=groups'); else refresh();
    toast(`Created ${g.name}`);
    setTimeout(() => openGroup(g.id), 80);
  };
  /** A name or description edited where it's shown (click-to-edit), for groups and custom roles alike: Enter or leaving
      the field applies it at once with Undo, Escape cancels. `st` holds { edit: 'name'|'desc', err }; `ent` is the group or
      role; `nameErr` validates a new name. Idempotent: Enter re-renders, then the field loses focus. */
  function commitText(st, ent, field, value, nameErr, logs) {
    if (st.edit !== field) return;
    const v = value.trim().replace(/\s+/g, ' ');
    if (field === 'name' && v && v !== ent.name) { const err = nameErr(v); if (err) { st.err = err; st.val = value; refresh(); return; } }
    st.edit = null; st.err = ''; st.val = '';
    const prev = ent[field] || '';
    if ((field === 'name' && !v) || v === prev) { refresh(); return; }
    ent[field] = v;
    const ev = field === 'name' ? audit(logs.renamed(prev), v) : audit(logs.desc, ent.name);
    refresh();
    toast(field === 'name' ? `Renamed to “${v}”` : v ? 'Description updated' : 'Description removed', { action: { label: 'Undo', run: () => { ent[field] = prev; unaudit([ev]); refresh(); } } });
  }
  /** The description under an editable name: same click-to-edit; empty shows a quiet "Add a description". */
  const descEdit = (st, ent, ids, maxlength, placeholder) => editableTitle({
    id: ids.id, tag: 'span', cls: cx('ppl-desc-edit', !ent.desc && st.edit !== 'desc' && 'is-empty'), label: 'Edit description', maxlength, placeholder,
    value: st.edit === 'desc' ? (ent.desc || '') : ent.desc || (tr('Add a description') ?? 'Add a description'), editing: st.edit === 'desc', edit: ids.edit, commit: ids.commit, cancel: ids.cancel, data: { id: ent.id, f: 'desc' },
  });
  /* Membership, name and description apply at once with Undo; Delete is the drawer's one header action. */
  DR['ppl-group'] = ({ id }) => {
    const g = groupById(id);
    if (!g) return { title: 'Group deleted', body: emptyState({ icon: 'users', title: 'This group no longer exists', compact: true }) };
    const f = S.ui.pplGD?.id === id ? S.ui.pplGD : (S.ui.pplGD = { id, q: '' });
    const manage = can('group.manage');
    const ms = groupMembers(id); const kbs = groupKbs(id);
    const q = f.q.trim().toLowerCase();
    const cands = q ? D.members.filter(m => !m.groups.includes(id) && (m.name.toLowerCase().includes(q) || m.email.includes(q))).slice(0, 6) : [];
    const addBox = manage ? `${searchField({ id: 'ppl-gd-q', bind: 'pplGD.q', value: f.q, live: true, full: true, placeholder: 'Add people by name or email', label: 'Add people to group' })}
      ${q ? `<div class="mt-8">${cands.length ? list(cands.map(m => item({ lead: avatar(m.name, 'sm'), title: esc(m.name), desc: esc(m.email), act: 'ppl-gd-add', data: { id, member: m.id }, cls: 'ppl-cand', trail: `<span class="ppl-cand__add">${ic('plus', 'i-sm')}Add</span>` }))) : `<p class="t-sm muted">No one else matches “${esc(f.q)}”.</p>`}</div>` : ''}` : '';
    const members = ms.length ? list(ms.map(m => item({ lead: avatar(m.name, 'sm'), title: esc(m.name), desc: esc(roleById(m.roleId)?.name || ''), trail: manage ? `<span class="reveal-on-hover">${iconBtn('x', `Remove ${m.name} from group`, { size: 'sm', act: 'ppl-gd-rm', data: { id, member: m.id } })}</span>` : '' })))
      : q ? '' : `<p class="t-sm muted">${manage ? 'No one is in this group yet. Search above to add people.' : 'No one is in this group yet.'}</p>`;
    const kbList = kbs.length ? list(kbs.map(k => { const s = k.shares.find(x => x.kind === 'group' && x.id === id); return item({ lead: kbDot(k), title: esc(k.name), meta: esc(accessLabel(s.role)), href: kbManageHref(k, 'access') }); })) : `<p class="t-sm muted">Not shared with any collection yet. Share from a collection’s Access tab.</p>`;
    const body = `<section class="drawer__section"><h3 class="drawer__section-title">Members · ${fmtNum(ms.length)}</h3>${addBox}<div class="mt-12">${members}</div></section>
      <section class="drawer__section"><h3 class="drawer__section-title">Collections</h3>${kbList}</section>`;
    const name = { id: 'ppl-gd-name', value: f.edit === 'name' && f.err ? f.val : g.name, editing: f.edit === 'name', edit: 'ppl-gd-edit', commit: 'ppl-gd-done', cancel: 'ppl-gd-cancel', label: 'Rename group', maxlength: 40, error: f.edit === 'name' ? f.err : '', data: { id, f: 'name' } };
    const desc = manage ? descEdit(f, g, { id: 'ppl-gd-desc', edit: 'ppl-gd-edit', commit: 'ppl-gd-done', cancel: 'ppl-gd-cancel' }, 80, 'Who belongs in this group') : g.desc ? esc(g.desc) : '';
    return {
      ...(manage ? { titleEdit: name } : { title: g.name }), desc, lead: itemIcon('users', 'accent'), body,
      headActions: manage ? iconBtn('trash', 'Delete group', { act: 'ppl-gd-delete', data: { id } }) : '',
    };
  };
  const groupState = id => (S.ui.pplGD?.id === id ? S.ui.pplGD : null);
  A['ppl-gd-edit'] = el => { const st = groupState(el.dataset.id); if (!st || !can('group.manage') || !groupById(el.dataset.id)) return; Object.assign(st, { edit: el.dataset.f, err: '', val: '' }); refresh(); };
  A['ppl-gd-cancel'] = el => { const st = groupState(el.dataset.id); if (!st?.edit) return; Object.assign(st, { edit: null, err: '', val: '' }); refresh(); };
  A['ppl-gd-done'] = el => {
    const g = groupById(el.dataset.id), st = groupState(el.dataset.id); if (!g || !st) return;
    commitText(st, g, el.dataset.f, el.value, v => groupErr(v, g.id), { renamed: prev => `Renamed group from ${prev}`, desc: 'Edited group description' });
  };
  A['ppl-gd-add'] = el => {
    const m = memberById(el.dataset.member); if (!m || m.groups.includes(el.dataset.id)) return;
    if (S.ui.pplGD) S.ui.pplGD.q = '';
    toggleGroup(m.id, el.dataset.id);
    $('#ppl-gd-q')?.focus();
  };
  A['ppl-gd-rm'] = el => { const m = memberById(el.dataset.member); if (m?.groups.includes(el.dataset.id)) toggleGroup(m.id, el.dataset.id); };
  A['ppl-gd-delete'] = el => {
    const g = groupById(el.dataset.id); if (!g) return; const ms = groupMembers(g.id); const kbs = groupKbs(g.id);
    confirmAction({
      title: `Delete ${g.name}?`, confirm: 'Delete group', danger: true, icon: 'trash',
      body: `<span>${ms.length ? 'Its members stay in the workspace but lose access that came from this group.' : 'No one is in this group.'}</span>${kbs.length ? ` <span>${kbs.length === 1 ? 'One collection stops being shared with it.' : `${kbs.length} collections stop being shared with it.`}</span>` : ''}`,
      onConfirm: () => {
        // Everything it touched is restorable, so the toast offers Undo like every other reversible delete.
        const at = D.groups.indexOf(g), memberOf = ms.map(m => [m, [...m.groups]]), shares = kbs.map(k => [k, [...k.shares]]);
        D.groups.splice(at, 1);
        D.members.forEach(m => { m.groups = m.groups.filter(x => x !== g.id); });
        D.kbs.forEach(k => { k.shares = k.shares.filter(s => !(s.kind === 'group' && s.id === g.id)); });
        kbs.forEach(k => X.kbSyncPersonas?.(k, ms.map(m => m.id)));
        const ev = audit('Deleted group', g.name);
        S.drawer = null; refresh();
        toast(`Deleted ${g.name}`, { action: { label: 'Undo', run: () => {
          if (!groupById(g.id)) D.groups.splice(at, 0, g);
          memberOf.forEach(([m, gs]) => (m.groups = gs)); shares.forEach(([k, s]) => (k.shares = s));
          kbs.forEach(k => X.kbSyncPersonas?.(k, ms.map(m => m.id))); unaudit([ev]); refresh();
        } } });
      },
    });
  };

  /* ══════════════ Roles ══════════════ */
  /** Roles compared at a glance: permissions down the side, one column per role. Each permission group is a band led
      by its tinted icon; each role column carries its own tone, its people and how many permissions it holds; every
      cell answers yes (green check) or no (dash). Nothing is edited here: a role's name opens its drawer, where that
      one role is renamed, described, switched and deleted (the Groups pattern). Phones show one role's column at a
      time, picked above the table. */
  const PERM_GROUP_MARK = { Workspace: ['building', 'blue'], People: ['users', 'violet'], Knowledge: ['book', 'teal'], 'Data sources': ['database', 'amber'], Activity: ['activity', 'pink'] };
  const groupMark = g => itemIcon(...(PERM_GROUP_MARK[g.group] || ['shield', categoryTone(g.group)]), 'sm');
  /** Built-in roles first, then custom ones; a role's tone is its place in that order, the same in the matrix and its drawer. */
  const orderedRoles = () => [...D.roles.filter(r => r.system), ...D.roles.filter(r => !r.system)];
  const roleTone = r => CATEGORY_TONES[Math.max(0, orderedRoles().indexOf(r)) % CATEGORY_TONES.length];
  function rolesTab() {
    const u = ui('pplR', {});
    return gate({
      loading: () => skelRows(5),
      empty: () => emptyState({ icon: 'shield', boxed: true, title: 'No roles yet', desc: 'Roles decide what people can do in this workspace.' }),
      ok: () => {
        const roles = orderedRoles();
        if (!roleById(u.focus)) u.focus = roles[0]?.id;
        const fc = r => r.id === u.focus && 'is-focus';
        const codes = D.permCatalog.flatMap(g => g.items.map(([code]) => code));
        const held = r => codes.filter(code => r.perms.includes(code)).length;
        const colHead = r => `<th scope="col" class="${cx('table__column ppl-mx__role', fc(r))}"><div class="ppl-mx__head">${itemIcon('shield', roleTone(r), 'sm')}<button type="button" class="ppl-mx__name" data-act="ppl-role-open" data-id="${r.id}"><span class="truncate">${esc(r.name)}</span></button><div class="ppl-mx__count">${plural(roleCount(r.id), 'person', 'people')} · ${fmtNum(held(r))}/${plural(codes.length, 'permission')}</div></div></th>`;
        const cell = (r, code) => `<td class="${cx('table__cell ppl-mx__cell', fc(r))}">${tick(r.perms.includes(code))}</td>`;
        /* Group headings are interface words, even where a workspace record shares the name ("People"): localized here. */
        const groupRow = g => `<tr class="ppl-mx__group"><th scope="rowgroup" colspan="${roles.length + 1}"><span class="ppl-mx__band">${groupMark(g)}<span class="ppl-mx__gname">${esc(tr(g.group) ?? g.group)}</span><span class="ppl-mx__gcount">${plural(g.items.length, 'permission')}</span></span></th></tr>`;
        const rows = D.permCatalog.map(g => groupRow(g)
          + g.items.map(([code, text]) => `<tr class="table__row ppl-mx__row"><th scope="row" class="table__cell ppl-mx__perm">${esc(text)}</th>${roles.map(r => cell(r, code)).join('')}</tr>`).join(''));
        const head = `<th scope="col" class="table__column ppl-mx__perm"><span class="sr-only">Permission</span></th>${roles.map(colHead).join('')}`;
        const pick = `<div class="ppl-mx-pick">${select({ id: 'ppl-mx-pick', value: u.focus, options: roles.map(r => [r.id, r.name]), change: 'ppl-mx-focus', label: 'Role to show' })}</div>`;
        return pick + `<div class="ppl-mx">${table({ head, rows, stack: false, label: 'Roles and permissions' })}</div>`;
      },
    });
  }
  A['ppl-mx-focus'] = el => { ui('pplR').focus = el.value; refresh(); };

  /* ── Role drawer ── */
  function openRole(id) { if (!roleById(id)) return; ui('pplR', {}).focus = id; S.ui.pplRD = { id }; openDrawer('ppl-role', { id }); }
  A['ppl-role-open'] = el => openRole(el.dataset.id);
  /** Open a role from elsewhere (Activity). */
  A['ppl-role-show'] = el => { go('/people?tab=roles'); setTimeout(() => openRole(el.dataset.id), 80); };
  /** One role: who has it, then what it allows. Built-in: read-only, allowed permissions only, Duplicate to customise.
      Custom: the name and description are click-to-edit, each permission a switch (at once with Undo), Delete in the header. */
  DR['ppl-role'] = ({ id }) => {
    const r = roleById(id);
    if (!r) return { title: 'Role deleted', body: emptyState({ icon: 'shield', title: 'This role no longer exists', compact: true }) };
    const st = S.ui.pplRD?.id === id ? S.ui.pplRD : (S.ui.pplRD = { id });
    const manage = can('role.manage'), edit = manage && !r.system, n = roleCount(id);
    const who = n ? linkBtn(`${plural(n, 'member')} with this role`, { act: 'ppl-role-members', data: { id }, icon: 'arrow-right' }) : `<span class="t-sm muted">No one has this role yet</span>`;
    const builtIn = r.system ? `<div class="ppl-rd-note">${ic('lock', 'i-sm')}<span class="grow">Built-in, can’t be changed</span>${manage ? btn('Duplicate to customise', { v: 'secondary', size: 'sm', icon: 'copy', act: 'ppl-role-dup', data: { id } }) : ''}</div>` : '';
    const perms = D.permCatalog.map(g => {
      const items = edit ? g.items : g.items.filter(([c]) => r.perms.includes(c));
      if (!items.length) return '';
      const rows = edit ? items.map(([code, text]) => switchRow({ title: text, on: r.perms.includes(code), act: 'ppl-perm-toggle', data: { role: id, perm: code } })).join('')
        : `<ul class="ppl-perms">${items.map(([, text]) => `<li class="ppl-perm">${tick(true)}<span>${esc(text)}</span></li>`).join('')}</ul>`;
      return `<div class="ppl-perm-group"><h4 class="ppl-perm-group__title">${groupMark(g)}<span>${esc(tr(g.group) ?? g.group)}</span></h4>${rows}</div>`;
    }).join('') || `<p class="t-sm muted">This role has no permissions yet.</p>`;
    const name = { id: 'ppl-rd-name', value: st.edit === 'name' && st.err ? st.val : r.name, editing: st.edit === 'name', edit: 'ppl-rd-edit', commit: 'ppl-rd-done', cancel: 'ppl-rd-cancel', label: 'Rename role', maxlength: 40, error: st.edit === 'name' ? st.err : '', data: { id, f: 'name' } };
    const desc = edit ? descEdit(st, r, { id: 'ppl-rd-desc', edit: 'ppl-rd-edit', commit: 'ppl-rd-done', cancel: 'ppl-rd-cancel' }, 90, 'What people with this role do') : r.desc ? esc(r.desc) : '';
    return {
      ...(edit ? { titleEdit: name } : { title: r.name }), desc, lead: itemIcon('shield', roleTone(r)),
      body: (builtIn ? `<div class="mb-16">${builtIn}</div>` : '') + who + `<section class="drawer__section ppl-rd-perms" aria-label="Permissions">${perms}</section>`,
      headActions: edit ? iconBtn('trash', 'Delete role', { act: 'ppl-role-delete', data: { id } }) : '',
    };
  };
  const roleState = id => (S.ui.pplRD?.id === id ? S.ui.pplRD : null);
  A['ppl-rd-edit'] = el => { const st = roleState(el.dataset.id), r = roleById(el.dataset.id); if (!st || !r || r.system || !can('role.manage')) return; Object.assign(st, { edit: el.dataset.f, err: '', val: '' }); refresh(); };
  A['ppl-rd-cancel'] = el => { const st = roleState(el.dataset.id); if (!st?.edit) return; Object.assign(st, { edit: null, err: '', val: '' }); refresh(); };
  A['ppl-rd-done'] = el => {
    const r = roleById(el.dataset.id), st = roleState(el.dataset.id); if (!r || !st) return;
    commitText(st, r, el.dataset.f, el.value, v => roleErr(v, r.id), { renamed: prev => `Renamed role from ${prev}`, desc: 'Edited role description' });
  };
  A['ppl-role-dup'] = el => openRoleForm({ from: el.dataset.id, copy: true });
  A['ppl-role-delete'] = el => deleteRole(el.dataset.id);
  /** A permission is a switch in the custom role's drawer: it applies at once with Undo. */
  A['ppl-perm-toggle'] = el => {
    const r = roleById(el.dataset.role); if (!r || r.system || !can('role.manage')) return;
    const c = el.dataset.perm, prev = [...r.perms], on = !r.perms.includes(c);
    r.perms = on ? [...r.perms, c] : r.perms.filter(x => x !== c);
    const ev = audit('Changed role permissions', r.name); refresh();
    toast(on ? `Turned on a permission for ${r.name}` : `Turned off a permission for ${r.name}`, { action: { label: 'Undo', run: () => { r.perms = prev; unaudit([ev]); refresh(); } } });
  };
  A['ppl-role-members'] = el => {
    const fromBlocked = S.modal?.name === 'ppl-role-blocked'; closeModal();
    if (S.drawer?.name === 'ppl-role') S.drawer = null;
    Object.assign(ui('pplM', {}), { q: '', role: el.dataset.id, status: '', page: 1 }); go('/people?tab=members');
    if (fromBlocked) toast('Select them, then use Change role to move them', { tone: 'accent' });
  };
  function uniqueRoleName(base) { let n = `${base} copy`, i = 2; while (D.roles.some(r => r.name.toLowerCase() === n.toLowerCase())) n = `${base} copy ${i++}`; return n; }
  /** No one holds it (otherwise it's blocked), so deleting is reversible: at once, with Undo. */
  function deleteRole(id) {
    const r = roleById(id); if (!r || r.system) return;
    if (roleCount(id)) { openModal('ppl-role-blocked', { id }); return; }
    const i = D.roles.indexOf(r); D.roles.splice(i, 1); const ev = audit('Deleted role', r.name);
    if (S.drawer?.name === 'ppl-role') S.drawer = null;
    refresh();
    toast(`Deleted ${r.name}`, { action: { label: 'Undo', run: () => { if (!roleById(r.id)) D.roles.splice(i, 0, r); unaudit([ev]); refresh(); } } });
  }
  M['ppl-role-blocked'] = ({ id }) => {
    const ms = D.members.filter(m => m.roleId === id), shown = ms.slice(0, 3);
    return {
      icon: 'shield', tone: 'warning', title: `Can’t delete ${roleById(id)?.name} yet`,
      desc: 'Move everyone with this role to another role, then delete it.',
      body: `<div class="t-sm muted mb-8">${plural(ms.length, 'member')} with this role</div>${list(shown.map(m => item({ lead: avatar(m.name, 'sm'), title: esc(m.name), desc: esc(m.email) })), 'ppl-blocked')}${ms.length > shown.length ? `<p class="t-sm muted mt-8">And ${ms.length - shown.length} more</p>` : ''}`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Show members', { v: 'primary', iconRight: 'arrow-right', act: 'ppl-role-members', data: { id } }),
    };
  };
  const roleErr = (name, id) => { const n = name.trim(); if (!n) return 'Enter a role name.'; if (D.roles.some(r => r.id !== id && r.name.toLowerCase() === n.toLowerCase())) return 'A role with this name already exists.'; return ''; };
  /** Creating a role is a small form with a starting point (another role's permissions, or none); the new role's drawer
      opens next to adjust them. Duplicate to customise opens it with the copy's name selected. */
  function openRoleForm({ from = 'r-member', copy = false } = {}) {
    if (!can('role.manage')) return;
    const src = roleById(from);
    S.ui.pplRF = { name: copy && src ? uniqueRoleName(src.name) : '', desc: copy && src ? src.desc || '' : '', from, touched: false };
    openModal('ppl-role-form', {});
    if (copy) requestAnimationFrame(() => $('#ppl-rf-name')?.select());
  }
  A['ppl-role-create'] = () => openRoleForm();
  M['ppl-role-form'] = p => {
    const f = ui('pplRF');
    const err = f.touched || f.name.trim() ? roleErr(f.name) : ''; const dis = p.busy ? ' disabled' : '';
    const total = D.permCatalog.reduce((n, g) => n + g.items.length, 0), src = roleById(f.from);
    return {
      title: 'Create role', icon: 'shield',
      desc: 'Pick a starting point, then fine-tune each permission.',
      body: field({ id: 'ppl-rf-name', label: 'Name', required: true, error: err, control: input({ id: 'ppl-rf-name', bind: 'pplRF.name', value: f.name, placeholder: 'e.g. Support lead', autofocus: true, invalid: !!err, attrs: `data-live maxlength="40"${dis}`, onEnter: 'ppl-rf-save' }) }) +
        field({ id: 'ppl-rf-desc', label: 'Description', optional: true, control: input({ id: 'ppl-rf-desc', bind: 'pplRF.desc', value: f.desc, placeholder: 'What people with this role do', attrs: `maxlength="90"${dis}`, onEnter: 'ppl-rf-save' }) }) +
        field({ id: 'ppl-rf-from', label: 'Start from', desc: src ? esc(`${src.perms.length} of ${total} permissions`) : 'Turn on only what it needs', control: select({ id: 'ppl-rf-from', bind: 'pplRF.from', value: f.from, options: [...D.roles.map(r => [r.id, r.name]), ['empty', 'Start empty']], change: 'ppl-rf-from', attrs: dis }) }),
      footStart: 'No one gets this role until you assign it.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: p.busy }) + btn('Create role', { v: 'primary', icon: 'plus', act: 'ppl-rf-save', loading: p.busy }),
    };
  };
  A['ppl-rf-from'] = () => refreshLayer();
  A['ppl-rf-save'] = async () => {
    const p = S.modal?.props; if (!p || p.busy || S.modal.name !== 'ppl-role-form') return; const f = ui('pplRF'); f.touched = true;
    if (roleErr(f.name)) { refreshLayer(); $('#ppl-rf-name')?.focus(); return; }
    p.busy = true; p.guard = true; refreshLayer(); await sleep(500);
    const name = f.name.trim().replace(/\s+/g, ' ');
    const r = { id: uid('r'), name, system: false, desc: f.desc.trim(), perms: f.from === 'empty' ? [] : [...(roleById(f.from)?.perms || [])] };
    D.roles.push(r); const ev = audit('Created role', name); closeModal();
    if (S.cur.path !== '/people' || S.cur.query.tab !== 'roles') go('/people?tab=roles'); else refresh();
    toast(`Created ${name}`, { action: { label: 'Undo', run: () => { D.roles = D.roles.filter(x => x !== r); if (S.drawer?.name === 'ppl-role') S.drawer = null; unaudit([ev]); refresh(); } } });
    setTimeout(() => openRole(r.id), 80);
  };

  /* ══════════════ Requests ══════════════ */
  /** One sentence with highlighted parts: the template is localized as a whole (word order differs by language), then filled. */
  const sentence = (tpl, ...parts) => (tr(tpl) ?? tpl).replace(/\{(\d)\}/g, (_, n) => parts[n]);
  function reqSentence(r) {
    const m = memberById(r.user); const kb = kbById(r.kb);
    return sentence('{0} wants {1} access to {2}', `<span class="medium">${esc(m?.name || 'Someone')}</span>`, `<span class="medium">${esc(accessLabel(r.role))}</span>`,
      kb ? `<a class="link" href="#${kbManageHref(kb, 'access')}">${esc(kb.name)}</a>` : '<span>a collection</span>');
  }
  function reqItem(r) {
    const m = memberById(r.user);
    return item({
      cls: 'ppl-req', lead: avatar(m?.name || '?'), title: reqSentence(r),
      desc: `${r.note ? `<q class="ppl-req__note">${esc(r.note)}</q>` : ''}<span class="ppl-req__time">${rel(r.at)}</span>`,
      trail: can('access.manage') ? btn('Deny', { v: 'ghost', size: 'sm', act: 'req-deny', data: { id: r.id } }) + btn('Approve', { v: 'secondary', size: 'sm', act: 'req-approve', data: { id: r.id } }) : '',
    });
  }
  function decidedItem(r) {
    return item({
      cls: 'ppl-req', lead: avatar(memberById(r.user)?.name || '?', 'sm'), title: reqSentence(r),
      desc: `${r.status === 'approved' ? 'Approved' : 'Denied'} by ${esc(actorName(r.decidedBy || me().id))} · ${rel(r.decidedAt || r.at)}`,
    });
  }
  function requestsTab() {
    ui('pplQ', { open: false });
    const pend = pendingRequests().sort((a, b) => b.at - a.at);
    const decided = D.requests.filter(r => r.status !== 'pending').sort((a, b) => (b.decidedAt || b.at) - (a.decidedAt || a.at));
    const none = () => emptyState({ icon: 'check-check', boxed: true, title: 'No pending requests', desc: 'When someone asks for access to a restricted collection, it shows up here.' });
    const main = gate({ loading: () => skelRows(3), empty: none, ok: () => pend.length ? list(pend.map(reqItem)) : none() });
    const live = S.pageState === 'live' && !S.navLoading;
    const history = live && decided.length ? `<div class="mt-24">${disclosure({ path: 'pplQ.open', icon: 'history', title: 'Recently decided', summary: fmtNum(decided.length), body: list(decided.map(decidedItem)) })}</div>` : '';
    return main + history;
  }
  /** Role a demo persona holds as stored on a base (undefined when the person isn't a demo persona). */
  function personaRole(kb, userId) {
    const key = Object.keys(PERSONAS).find(k => PERSONAS[k].id === userId); if (!key || !kb) return undefined;
    return kb.access ? kb.access[key] : key === 'member' ? kb.memberRole : undefined;
  }
  /** Approve: grant a direct share on the collection (and, for demo personas, the role they now hold). */
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
    toast(`${m?.name || 'They'} is now ${accessLabel(r.role)} on ${kb?.name || 'it'}`, {
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

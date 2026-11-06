/* People: members, groups, roles and access requests (/people?tab=…).
   Shared actions: member-add, member-open, req-approve, req-deny. */
(() => {
  'use strict';

  const TABS = ['members', 'groups', 'roles', 'requests'];
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
    members: () => can('user.manage') ? btn('Add people', { v: 'primary', icon: 'user-plus', act: 'member-add' }) : '',
    groups: () => can('group.manage') ? btn('Create group', { v: 'primary', icon: 'plus', act: 'ppl-group-create' }) : '',
    roles: () => can('role.manage') ? btn('Create role', { v: 'primary', icon: 'plus', act: 'ppl-role-create' }) : '',
    requests: () => '',
  };
  P.people = ({ query }) => {
    const tab = TABS.includes(query.tab) ? query.tab : 'members';
    const pend = pendingRequests().length;
    const head = pageHeader({ title: 'People', desc: `Who can use ${esc(curWs().name)}, what they can do and what they can open.`, actions: TAB_ACTION[tab]() });
    const t = tabs([
      { id: 'members', label: 'Members' },
      { id: 'groups', label: 'Groups' },
      { id: 'roles', label: 'Roles' },
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
    const tools = needsTools(D.members.length, 'pplM', ['role', 'status']);
    const toolbar = tools ? `<div class="toolbar">${searchField({ uiKey: 'pplM', placeholder: 'Search by name or email' })}${filterButton('Role', 'pplM', 'role', D.roles.map(r => [r.id, r.name]))}${filterButton('Status', 'pplM', 'status', [['active', 'Active'], ['invited', 'Invited'], ['suspended', 'Suspended']])}${clearFilters('pplM', ['role', 'status'])}${live ? `<span class="toolbar__end t-sm muted num">${plural(rows.length, 'person', 'people')}</span>` : ''}</div>` : '';
    return toolbar + gate({
      empty: () => emptyState({ icon: 'users', boxed: true, title: 'Only you are here', desc: 'Add people by their work email. Anyone without a BoMesh account gets an email invite.' }),
      ok: () => {
        if (!rows.length) return noMatches('pplM', ['role', 'status'], 'people');
        const page = paginate(rows, 'pplM', 20); const ids = page.map(m => m.id);
        /* Status lives next to the name, only when it isn't the usual "Active". */
        const head = (tools ? selAllCheck('pplM', ids) : '') + sortHead('Person', 'name', 'pplM') + sortHead('Role', 'role', 'pplM') + th('Groups', 'hide-md') + sortHead('Last active', 'last', 'pplM');
        const trs = page.map(m => {
          const self = m.id === me().id;
          const flag = self ? chip('You', { size: 'sm' }) : m.status !== 'active' ? status('member', m.status) : '';
          return `<tr class="${cx('table__row', fresh.has(m.id) && 'table__row--new')}" data-act="member-open" data-id="${m.id}" tabindex="0" ${u.sel?.[m.id] ? 'aria-selected="true"' : ''}>
            ${tools ? selCheck('pplM', m.id, 'Select ' + m.name) : ''}
            <td class="table__cell table__cell--primary"><span class="row gap-12">${avatar(m.name)}<span class="stack" style="min-width:0"><span class="row gap-6"><span class="cell-title truncate">${esc(m.name)}</span>${flag}</span><span class="cell-sub truncate">${esc(m.email)}</span></span></span></td>
            <td class="table__cell">${roleCell(m)}</td>
            <td class="table__cell hide-md table__cell--hide-sm">${groupChips(m.groups)}</td>
            <td class="table__cell muted"><span class="ppl-nowrap">${m.status === 'invited' ? `Invited ${rel(m.invitedAt || m.joined)}` : m.lastActive ? rel(m.lastActive) : 'Not yet'}</span></td></tr>`;
        });
        const bulk = tools ? bulkBar('pplM', btn('Change role', { v: 'ghost', size: 'sm', icon: 'shield', menu: 'ppl-bulk-role' }) + btn('Suspend', { v: 'ghost', size: 'sm', icon: 'pause', act: 'ppl-bulk-suspend' })) : '';
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
  A['ppl-invite-resend'] = el => {
    const m = memberById(el.dataset.id); if (!m || m.status !== 'invited') return;
    m.invitedAt = Date.now(); audit('Resent invite', m.email); refresh();
    toast(`Sent the invite to ${m.email} again`);
  };

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
    const plus = everyone.length ? `<p class="t-sm muted ${grants.length ? 'mt-8' : ''}">${grants.length ? `Plus ${plural(everyone.length, 'knowledge base')} everyone can open.` : `Only the ${plural(everyone.length, 'knowledge base')} everyone can open.`}</p>` : '';
    const kbHtml = role.id === 'r-admin' ? `<p class="t-sm muted">Workspace admins can open every knowledge base.</p>`
      : grants.length ? list(kbShown.map(a => item({ lead: kbDot(a.kb), title: esc(a.kb.name), desc: esc(a.via), meta: esc(accessLabel(a.role)), href: kbManageHref(a.kb, 'access') })))
        + (grants.length > KB_PREVIEW ? `<div class="mt-8">${linkBtn(f.allKb ? 'Show fewer' : `Show all ${grants.length}`, { act: 'ui-toggle', data: { path: 'pplMD.allKb' } })}</div>` : '') + plus
      : plus || `<p class="t-sm muted">No knowledge bases shared with ${esc(first(m.name))}.</p>`;
    const notice = m.status === 'suspended' ? alertBox('danger', 'Suspended', `${esc(first(m.name))} can’t sign in until reactivated.`, btn('Reactivate', { v: 'secondary', size: 'sm', icon: 'play', act: 'ppl-md-reactivate', data: { id } }))
      : invited ? alertBox('accent', 'Invite sent', `${esc(m.email)} hasn’t accepted yet. Sent ${esc(rel(m.invitedAt || m.joined).toLowerCase())}. Their role and groups apply once they join.`, btn('Resend invite', { v: 'secondary', size: 'sm', icon: 'send', act: 'ppl-invite-resend', data: { id } }), { icon: 'mail' }) : '';
    const body = (notice ? `<div class="mb-16">${notice}</div>` : '') +
      sec('Role', field({ id: 'ppl-md-role', desc: rWhy ? esc(rWhy) + '.' : esc(role.desc), control: tipWrap(rWhy, select({ id: 'ppl-md-role', value: m.roleId, options: D.roles.map(r => [r.id, r.name]), change: 'ppl-role-change', label: 'Role', attrs: `data-id="${m.id}"${rWhy ? ' disabled' : ''}` })) })) +
      sec('Groups', D.groups.length ? `<div class="ppl-checks">${D.groups.map(g => checkbox({ label: esc(g.name), checked: m.groups.includes(g.id), act: 'ppl-md-group', data: { id: g.id, member: m.id } })).join('')}</div>` : `<p class="t-sm muted">No groups yet.</p>`) +
      sec('Knowledge access', kbHtml) +
      (() => { const sps = hasModule('spaces') ? spacesOf(m) : []; return sps.length ? sec('Spaces', list(sps.map(s => item({ lead: spaceLead(s.sp), title: esc(s.sp.name), desc: esc([s.type.label, s.sp.code].filter(Boolean).join(' · ')), meta: esc(s.role), href: '/space/' + s.sp.id })))) : ''; })() +
      (invited ? '' : `<section class="drawer__section">${disclosure({ path: 'pplMD.more', icon: 'log-in', title: 'Sign-in details', summary: esc(`Joined ${fmtDate(m.joined)}`),
        body: kv([['Last sign-in', lastSi ? `${esc(lastSi.method)} · ${esc(lastSi.device)} · ${rel(lastSi.at)}` : 'No sign-ins yet']]) })}</section>`);
    return {
      title: m.name + (self ? ' (you)' : ''), desc: `<span>${esc(m.email)}</span> · <span>${invited ? 'Invited' : m.lastActive ? esc(`Last active ${rel(m.lastActive)}`) : 'Not active yet'}</span>`, lead: avatar(m.name, 'lg'), body,
      headActions: memberActions(m).length ? iconBtn('more', 'More actions', { menu: 'ppl-md-more', data: { id } }) : '',
    };
  };
  /** Account actions for the drawer's ⋯ menu; guarded ones (yourself, the last admin) are hidden. Reactivate and Resend sit in the drawer's notice. */
  function memberActions(m) {
    if (m.status === 'invited') return [{ label: 'Revoke invite', icon: 'x-circle', danger: true, run: () => revokeInvite(m.id) }];
    const items = [];
    if (m.status === 'active' && !accountGuard(m, 'suspend')) items.push({ label: 'Suspend', icon: 'pause', run: () => suspend([m.id]) });
    if (!accountGuard(m, 'remove')) items.push(...(items.length ? [{ sep: true }] : []), { label: 'Remove from workspace', icon: 'trash', danger: true, run: () => remove(m.id) });
    return items;
  }
  MENUS['ppl-md-more'] = el => { const m = memberById(el.dataset.id); return m ? memberActions(m) : []; };
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
      footStart: 'You can change roles and groups later.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: p.busy }) + btn(label, { v: 'primary', icon: nInv && !nAdd ? 'send' : 'user-plus', act: 'ppl-add-submit', loading: p.busy, id: 'ppl-add-submit' }),
    };
  };
  A['ppl-add-refresh'] = () => refreshLayer();
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
          <div class="row between gap-8">${ms.length ? `<span class="row gap-8"><span class="avatar-group">${ms.slice(0, 4).map(m => avatar(m.name, 'sm')).join('')}</span><span class="t-xs muted num">${plural(ms.length, 'member')}</span></span>` : '<span class="t-xs muted">No members</span>'}<span class="t-xs muted">${kbs.length ? plural(kbs.length, 'knowledge base') : ''}</span></div></div>`;
      }).join('')}</div>`,
    });
  }
  const groupErr = (name, id) => { const n = name.trim(); if (!n) return 'Enter a group name.'; if (D.groups.some(g => g.id !== id && g.name.toLowerCase() === n.toLowerCase())) return 'A group with this name already exists.'; return ''; };
  function openGroup(id) { if (!groupById(id)) return; S.ui.pplGD = { id, q: '' }; openDrawer('ppl-group', { id }); }
  A['ppl-group-open'] = el => openGroup(el.dataset.id);
  /** Create a group, or edit its name and description (a two-field form: dialog with Save/Cancel). */
  function groupForm(id) { const g = id && groupById(id); S.ui.pplGN = { name: g?.name || '', desc: g?.desc || '', touched: false }; openModal('ppl-group-form', { id }); }
  A['ppl-group-create'] = () => groupForm(null);
  M['ppl-group-form'] = p => {
    const f = ui('pplGN'); const orig = p.id ? groupById(p.id)?.name || '' : '';
    const err = f.touched || (f.name.trim() && f.name.trim() !== orig) ? groupErr(f.name, p.id) : ''; const dis = p.busy ? ' disabled' : '';
    return {
      title: p.id ? 'Edit group details' : 'Create group', icon: p.id ? 'pencil' : 'users',
      desc: p.id ? 'Rename it or say who belongs in it. Members and access stay as they are.' : 'Share knowledge with a whole team in one step.',
      body: field({ id: 'ppl-gn-name', label: 'Name', required: true, error: err, control: input({ id: 'ppl-gn-name', bind: 'pplGN.name', value: f.name, placeholder: 'e.g. Customer support', autofocus: true, invalid: !!err, attrs: `data-live maxlength="40"${dis}`, onEnter: 'ppl-gn-save' }) }) +
        field({ id: 'ppl-gn-desc', label: 'Description', optional: true, control: input({ id: 'ppl-gn-desc', bind: 'pplGN.desc', value: f.desc, placeholder: 'Who belongs in this group', attrs: `maxlength="80"${dis}`, onEnter: 'ppl-gn-save' }) }),
      footStart: p.id ? '' : 'Next, you’ll add people to it.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: p.busy }) + btn(p.id ? 'Save changes' : 'Create group', { v: 'primary', icon: p.id ? 'check' : 'plus', act: 'ppl-gn-save', loading: p.busy }),
    };
  };
  A['ppl-gn-save'] = async () => {
    const p = S.modal?.props; if (!p || p.busy || S.modal.name !== 'ppl-group-form') return; const f = ui('pplGN'); f.touched = true;
    if (groupErr(f.name, p.id)) { refreshLayer(); $('#ppl-gn-name')?.focus(); return; }
    p.busy = true; p.guard = true; refreshLayer(); await sleep(500);
    if (p.id) {
      const g = groupById(p.id); if (!g) { closeModal(); return; }
      const renamed = g.name !== f.name.trim(); const prev = g.name;
      g.name = f.name.trim(); g.desc = f.desc.trim();
      audit(renamed ? `Renamed group from ${prev}` : 'Edited group details', g.name);
      closeModal(); refresh(); toast(`Saved ${g.name}`); return;
    }
    const g = { id: uid('g'), name: f.name.trim(), desc: f.desc.trim() };
    D.groups.push(g); audit('Created group', g.name); markFresh([g.id]);
    closeModal();
    if (S.cur.path !== '/people' || S.cur.query.tab !== 'groups') go('/people?tab=groups'); else refresh();
    toast(`Created ${g.name}`);
    setTimeout(() => openGroup(g.id), 80);
  };
  /* Membership changes apply at once with Undo; details are edited in a dialog from ⋯ (one save model per surface). */
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
    const kbList = kbs.length ? list(kbs.map(k => { const s = k.shares.find(x => x.kind === 'group' && x.id === id); return item({ lead: kbDot(k), title: esc(k.name), meta: esc(accessLabel(s.role)), href: kbManageHref(k, 'access') }); })) : `<p class="t-sm muted">Not shared with any knowledge base yet. Share from a knowledge base’s Access tab.</p>`;
    const body = `<section class="drawer__section"><h3 class="drawer__section-title">Members · ${fmtNum(ms.length)}</h3>${addBox}<div class="mt-12">${members}</div></section>
      <section class="drawer__section"><h3 class="drawer__section-title">Knowledge bases</h3>${kbList}</section>`;
    return {
      title: g.name, desc: g.desc ? esc(g.desc) : '', lead: itemIcon('users', 'accent'), body,
      headActions: manage ? iconBtn('more', 'More actions', { menu: 'ppl-gd-more', data: { id } }) : '',
    };
  };
  MENUS['ppl-gd-more'] = el => [
    { label: 'Edit details', icon: 'pencil', run: () => groupForm(el.dataset.id) },
    { sep: true },
    { label: 'Delete group', icon: 'trash', danger: true, run: () => A['ppl-gd-delete']({ dataset: { id: el.dataset.id } }) },
  ];
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
      body: `<span>${ms.length ? 'Its members stay in the workspace but lose access that came from this group.' : 'No one is in this group.'}</span>${kbs.length ? ` <span>${kbs.length === 1 ? 'One knowledge base stops being shared with it.' : `${kbs.length} knowledge bases stop being shared with it.`}</span>` : ''}`,
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
  function rolesTab() {
    const u = ui('pplR', { sel: 'r-admin' });
    if (!roleById(u.sel)) u.sel = D.roles[0]?.id;
    return gate({
      loading: () => skelRows(5),
      empty: () => emptyState({ icon: 'shield', boxed: true, title: 'No roles yet', desc: 'Roles decide what people can do in this workspace.' }),
      ok: () => {
        const role = roleById(u.sel); const perms = role.perms;
        const manage = can('role.manage') && !role.system;
        const roleItem = r => item({ title: esc(r.name), desc: plural(roleCount(r.id), 'member'), act: 'ppl-role-select', data: { id: r.id }, cls: cx('ppl-role-item', r.id === role.id && 'is-active') });
        const builtIn = D.roles.filter(r => r.system), custom = D.roles.filter(r => !r.system);
        /* Group labels only when both kinds exist; creating a role is the page's primary action. */
        const nav = `<nav class="ppl-roles__nav" aria-label="Roles">${custom.length
          ? `<div class="ppl-roles__label">Built-in</div>${list(builtIn.map(roleItem))}<div class="ppl-roles__label">Custom</div>${list(custom.map(roleItem))}`
          : list(builtIn.map(roleItem))}</nav>`;
        const n = roleCount(role.id);
        /* Built-in roles: one way to customise (a copy). Custom roles: rename or delete under ⋯; permissions switch in place. */
        const actions = !can('role.manage') ? ''
          : role.system ? btn('Duplicate to customise', { v: 'secondary', size: 'sm', icon: 'copy', act: 'ppl-role-dup', data: { id: role.id } })
            : iconBtn('more', 'More actions', { size: 'sm', menu: 'ppl-role-more', data: { id: role.id } });
        const head = `<div class="ppl-role-head"><div class="grow"><h2 class="t-heading">${esc(role.name)}</h2>
          <p class="t-sm muted mt-4">${esc(role.desc || 'No description')}</p>
          <p class="ppl-role-meta">${role.system ? `<span class="row gap-4">${ic('lock', 'i-xs')}Built-in, can’t be changed</span><span aria-hidden="true">·</span>` : ''}${n ? linkBtn(`${plural(n, 'member')} with this role`, { act: 'ppl-role-members', data: { id: role.id } }) : '<span>No one has this role yet</span>'}</p></div>
          <div class="row gap-4 none">${actions}</div></div>`;
        const permRow = ([code, text]) => {
          const on = perms.includes(code);
          return manage ? switchRow({ title: text, on, act: 'ppl-perm-toggle', data: { perm: code } })
            : `<li class="${cx('ppl-perm', on && 'is-on')}">${ic(on ? 'check' : 'minus', 'i-sm')}<span>${esc(text)}</span><span class="sr-only">${on ? 'Allowed' : 'Not allowed'}</span></li>`;
        };
        const groups = D.permCatalog.map(g => `<div class="ppl-perm-group"><div class="row between gap-8"><h3 class="t-subheading">${esc(g.group)}</h3><span class="t-xs muted num">${g.items.filter(([c]) => perms.includes(c)).length} of ${g.items.length}</span></div>
          ${manage ? `<div>${g.items.map(permRow).join('')}</div>` : `<ul class="ppl-perms">${g.items.map(permRow).join('')}</ul>`}</div>`).join('');
        return `<div class="ppl-roles">${nav}<div class="ppl-roles__main">${card(head + groups, { cls: 'card--lg' })}</div></div>`;
      },
    });
  }
  function selectRole(id) { ui('pplR').sel = id; refresh(); }
  A['ppl-role-select'] = el => { if (el.dataset.id !== ui('pplR').sel) selectRole(el.dataset.id); };
  /** Open the Roles tab with a role selected (used by Activity). */
  A['ppl-role-show'] = el => { ui('pplR', { sel: 'r-admin' }).sel = el.dataset.id; go('/people?tab=roles'); };
  /** A permission is a toggle: it applies at once with Undo. */
  A['ppl-perm-toggle'] = el => {
    const r = roleById(ui('pplR').sel); if (!r || r.system || !can('role.manage')) return;
    const c = el.dataset.perm, prev = [...r.perms], on = !r.perms.includes(c);
    r.perms = on ? [...r.perms, c] : r.perms.filter(x => x !== c);
    const ev = audit('Changed role permissions', r.name); refresh();
    toast(`${on ? 'Turned on' : 'Turned off'} a permission for ${r.name}`, { action: { label: 'Undo', run: () => { r.perms = prev; unaudit([ev]); refresh(); } } });
  };
  A['ppl-role-members'] = el => {
    const fromBlocked = S.modal?.name === 'ppl-role-blocked'; closeModal();
    Object.assign(ui('pplM', {}), { q: '', role: el.dataset.id, status: '', page: 1 }); go('/people?tab=members');
    if (fromBlocked) toast('Select them, then use Change role to move them', { tone: 'accent' });
  };
  MENUS['ppl-role-more'] = el => [
    { label: 'Edit details', icon: 'pencil', run: () => roleForm(el.dataset.id) },
    { sep: true },
    { label: 'Delete role', icon: 'trash', danger: true, run: () => deleteRole(el.dataset.id) },
  ];
  function uniqueRoleName(base) { let n = `${base} copy`, i = 2; while (D.roles.some(r => r.name.toLowerCase() === n.toLowerCase())) n = `${base} copy ${i++}`; return n; }
  function duplicateRole(id) {
    const src = roleById(id); if (!src) return;
    const r = { id: uid('r'), name: uniqueRoleName(src.name), system: false, desc: src.desc, perms: [...src.perms] };
    D.roles.push(r); const ev = audit('Created role', r.name); selectRole(r.id);
    toast(`Created ${r.name}. Switch its permissions on or off.`, { action: { label: 'Undo', run: () => { D.roles = D.roles.filter(x => x !== r); unaudit([ev]); selectRole(id); } } });
  }
  A['ppl-role-dup'] = el => duplicateRole(el.dataset.id);
  /** No one holds it (otherwise it's blocked), so deleting is reversible: at once, with Undo. */
  function deleteRole(id) {
    const r = roleById(id); if (!r || r.system) return;
    if (roleCount(id)) { openModal('ppl-role-blocked', { id }); return; }
    const i = D.roles.indexOf(r); D.roles.splice(i, 1); const ev = audit('Deleted role', r.name); selectRole('r-member');
    toast(`Deleted ${r.name}`, { action: { label: 'Undo', run: () => { if (!roleById(r.id)) D.roles.splice(i, 0, r); unaudit([ev]); selectRole(r.id); } } });
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
  function roleForm(id) { const r = id && roleById(id); S.ui.pplRF = { name: r?.name || '', desc: r?.desc || '', from: 'r-member', touched: false }; openModal('ppl-role-form', { id }); }
  A['ppl-role-create'] = () => roleForm(null);
  /** Starting points for a new role: two common roles (when they exist) or nothing. */
  const ROLE_STARTS = [['r-member', 'user'], ['r-km', 'book']];
  M['ppl-role-form'] = p => {
    const f = ui('pplRF'); const orig = p.id ? roleById(p.id)?.name || '' : '';
    const err = f.touched || f.name.trim() !== orig ? roleErr(f.name, p.id) : ''; const dis = p.busy ? ' disabled' : '';
    const total = D.permCatalog.reduce((n, g) => n + g.items.length, 0);
    const from = [...ROLE_STARTS.filter(([id]) => roleById(id)).map(([id, icon]) => [id, roleById(id).name, `${roleById(id).perms.length} of ${total} permissions`, icon]),
      ['empty', 'Start empty', 'Turn on only what it needs', 'circle-dashed']];
    return {
      size: p.id ? 'md' : 'lg', title: p.id ? 'Edit role details' : 'Create role', icon: p.id ? 'pencil' : 'shield',
      desc: p.id ? 'Rename it or describe who it’s for. Permissions stay as they are.' : 'Pick a starting point, then fine-tune each permission.',
      body: field({ id: 'ppl-rf-name', label: 'Name', required: true, error: err, control: input({ id: 'ppl-rf-name', bind: 'pplRF.name', value: f.name, placeholder: 'e.g. Support lead', autofocus: true, invalid: !!err, attrs: `data-live maxlength="40"${dis}`, onEnter: 'ppl-rf-save' }) }) +
        field({ id: 'ppl-rf-desc', label: 'Description', optional: true, control: input({ id: 'ppl-rf-desc', bind: 'pplRF.desc', value: f.desc, placeholder: 'What people with this role do', attrs: `maxlength="90"${dis}`, onEnter: 'ppl-rf-save' }) }) +
        (p.id ? '' : `<div class="field"><span class="label">Start from</span>${choiceGroup({ name: 'ppl-rf-from', value: f.from, options: from, act: 'ppl-rf-from', cols: from.length })}</div>`),
      footStart: p.id ? '' : 'No one gets this role until you assign it.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: p.busy }) + btn(p.id ? 'Save changes' : 'Create role', { v: 'primary', icon: p.id ? 'check' : 'plus', act: 'ppl-rf-save', loading: p.busy }),
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
    ui('pplR', {}).sel = r.id;
    if (S.cur.path !== '/people' || S.cur.query.tab !== 'roles') go('/people?tab=roles'); else refresh();
    toast(`Created ${name}`);
  };

  /* ══════════════ Requests ══════════════ */
  function reqSentence(r) {
    const m = memberById(r.user); const kb = kbById(r.kb);
    return `<span class="medium">${esc(m?.name || 'Someone')}</span> wants <span class="medium">${esc(accessLabel(r.role))}</span> access to ${kb ? `<a class="link" href="#${kbManageHref(kb, 'access')}">${esc(kb.name)}</a>` : 'a knowledge base'}`;
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
    const none = () => emptyState({ icon: 'check-check', boxed: true, title: 'No pending requests', desc: 'When someone asks for access to a restricted knowledge base, it shows up here.' });
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

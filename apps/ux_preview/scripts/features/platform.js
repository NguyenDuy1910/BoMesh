(() => {
  'use strict';
  /* Platform console (operator): workspaces, users, connectors, usage, audit
     log and system health (incl. AI capabilities). Every page is a design
     proposal without a backend contract, so each header carries one Preview chip. */

  const PREVIEW = chip('Preview', { tone: 'default', variant: 'outline', size: 'sm' });
  const r01 = (seed, i) => { const x = Math.sin((seed % 100000) * 12.9898 + i * 78.233) * 43758.5453; return x - Math.floor(x); };
  const wsById = id => D.pWorkspaces.find(w => w.id === id);
  const isMemberWs = w => D.workspaces.some(x => x.id === w.id);
  const wsUrl = w => 'bomesh.app/' + w.code;
  const userById = id => D.pUsers.find(u => u.id === id);
  const userByName = name => D.pUsers.find(u => u.name === name);
  const isSelf = u => u.email === me().email;
  const conByKey = key => D.pConnectors.find(c => c.key === key);
  const CODE_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
  const NAMES = ['Grace Lee', 'Kevin Ng', 'Rosa Diaz', 'Nam Tran', 'Ivy Chen', 'Tom Becker', 'Ana Silva', 'Luca Rossi', 'Dara Okafor', 'Mia Novak'];
  const DEVICES = ['Chrome on macOS', 'Edge on Windows', 'Safari on macOS', 'Chrome on Windows', 'Firefox on Linux', 'Safari on iPad'];
  const WS_COLORS = ['#36A92D', '#6B4FBF', '#C2620F', '#2F6FB5', '#1F7A8C', '#A23B3B', '#4E6B2E', '#147D3F'];
  const READY_MS = 4000;
  let newId = null;
  const readyTimers = new Set();

  const slug = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  /** Daily series of n values summing to total, weekends quieter. Deterministic from seed. */
  function series(seed, n, total) {
    const w = Array.from({ length: n }, (_, i) => { const d = new Date(NOW - (n - 1 - i) * DAY).getDay(); return (0.78 + 0.22 * Math.sin(i / 3.1 + (seed % 7)) + 0.2 * r01(seed, i)) * (d === 0 || d === 6 ? 0.42 : 1); });
    const sum = w.reduce((a, b) => a + b, 0) || 1; const v = w.map(x => Math.round((total * x) / sum));
    v[n - 1] = Math.max(0, v[n - 1] + total - v.reduce((a, b) => a + b, 0)); return v;
  }
  const dayLabels = n => Array.from({ length: n }, (_, i) => fmtDate(NOW - (n - 1 - i) * DAY));
  const axis = (a, b) => `<div class="pf-axis" aria-hidden="true"><span>${esc(a)}</span><span>${esc(b)}</span></div>`;
  const wsDomain = w => { const u = userByName(w.owner); return u ? u.email.split('@')[1] : w.code.split('-')[0] + '.com'; };
  const emailOf = (name, dom) => name.toLowerCase().replace(/\s+/g, '.') + '@' + dom;
  /** An existing BoMesh account for this email, or null (the person gets an invite). */
  function accountFor(email) {
    const e = email.trim().toLowerCase();
    const k = D.pUsers.find(u => u.email === e) || D.members.find(m => m.email === e);
    if (k) return { name: k.name, email: e };
    return (D.knownAccounts || []).includes(e) ? { name: nameFromEmail(e), email: e } : null;
  }
  function nameFromEmail(email) { return email.split('@')[0].split(/[._-]+/).filter(Boolean).map(s => s[0].toUpperCase() + s.slice(1)).join(' ') || email; }
  function wsAdmins(w) {
    const own = DB.ws[w.id]?.members;   // workspaces with their own demo data list their real admins
    if (own) return own.filter(m => m.roleId === 'r-admin').map(m => ({ name: m.name, email: m.email, owner: m.name === w.owner }));
    const dom = wsDomain(w), h = hashOf(w.id);
    const out = [{ name: w.owner, email: w.adminEmail || userByName(w.owner)?.email || emailOf(w.owner, dom), owner: true }];
    const n = w.status === 'new' ? 0 : 1 + (h % 2);
    for (let i = 0; i < n; i++) { const name = NAMES[(h + i * 3) % NAMES.length]; out.push({ name, email: emailOf(name, dom) }); }
    return out;
  }
  function log(action, area, target, ws = null, outcome = 'success') {
    D.pAudit.unshift({ id: uid('pev'), at: Date.now(), ws, actor: me().name, action, area, target, outcome, ip: '10.4.0.12', device: 'Chrome on macOS' });
  }
  const wsCell = id => {
    const w = id && wsById(id);
    return w ? `<span class="row gap-8">${wsMark(w, 20)}<span class="truncate">${esc(w.name)}</span></span>` : `<span class="row gap-8"><span class="pf-plat">${ic('layers', 'i-xs')}</span><span class="muted">Platform</span></span>`;
  };

  /* ── Platform audit log: platform-level events only (workspaces, accounts, connectors, indexing, console sign-ins).
     What happens inside a workspace (documents, sources, members' sign-ins) stays in that workspace's Activity. ── */
  D.pAudit ??= (() => {
    const PLAT = [
      [26 * HOUR, null, 'Kenji Mori', 'Sign-in blocked — not a platform admin', 'Sign-in', 'Platform console', 'failure'],
      [2 * DAY + 3 * HOUR, 'ws-litware', 'Jordan Blake', 'Created workspace', 'Workspaces', 'Litware Labs', 'success'],
      [5 * DAY, null, 'Alex Rivera', 'Made platform admin', 'People', 'Jordan Blake', 'success'],
      [12 * DAY, null, 'Jordan Blake', 'Suspended account', 'People', 'Nora Quinn', 'success'],
      [18 * DAY, 'ws-adatum', 'Alex Rivera', 'Suspended workspace', 'Workspaces', 'Adatum Health', 'success'],
      [18 * DAY, 'ws-adatum', 'Alex Rivera', 'Paused indexing', 'Indexing', 'Adatum Health', 'success'],
      [33 * DAY, null, 'Alex Rivera', 'Turned on connector', 'Connectors', 'Confluence', 'success'],
      [42 * DAY, null, 'Alex Rivera', 'Updated connector settings', 'Connectors', 'Google Drive', 'success'],
    ];
    /* Recurring platform events, spread over the live workspaces. who: 0 = workspace owner, 1 = platform admin, 'sys' = BoMesh. */
    const ADMINS = ['Alex Rivera', 'Jordan Blake'];
    const T = [
      ['Sign-in', 'Signed in to the platform console', () => 'Platform console', 'success', 1, true],
      ['People', 'Invited account', (w, p) => emailOf(p, wsDomain(w)), 'success', 0],
      ['Indexing', 'Retried failed jobs', w => w.name, 'success', 1],
      ['Workspaces', 'Changed workspace web address', w => wsUrl(w), 'success', 0],
      ['Indexing', 'Indexing slowed down', w => w.name, 'failure', 'sys'],
      ['People', 'Added workspace admin', (w, p) => p, 'success', 0],
      ['Sign-in', 'Sign-in blocked — wrong password', () => 'Platform console', 'failure', 1, true],
      ['Workspaces', 'Changed workspace template', w => `${w.name} · ${wsTemplate(w).label}`, 'success', 0],
    ];
    const live = D.pWorkspaces.filter(w => w.status !== 'new');
    const out = PLAT.map(([t, ws, actor, action, area, target, outcome], i) => ({ id: 'pev-p' + i, at: ago(t), ws, actor, action, area, target, outcome, ip: `10.0.${8 + i}.${21 + i * 9}`, device: DEVICES[i % DEVICES.length] }));
    for (let i = 0; i < 30; i++) {
      const t = (i + 1) * (i + 1) * 60 * MIN;
      let w = live[(i * 5 + 2) % live.length]; if (w.id === 'ws-adatum' && t < 18 * DAY) w = wsById('ws-woodgrove');
      const h = hashOf(w.id); const [area, action, tgt, outcome, who, platform] = T[i % T.length];
      const actor = who === 'sys' ? 'BoMesh' : who === 1 ? ADMINS[i % 2] : w.owner;
      out.push({ id: 'pev-' + i, at: ago(t), ws: platform ? null : w.id, actor, action, area, target: tgt(w, NAMES[(h + i) % NAMES.length]), outcome, ip: `10.${20 + (h % 200)}.${(i * 7) % 250}.${(i * 13 + 40) % 250}`, device: DEVICES[(h + i) % DEVICES.length] });
    }
    return out.sort((a, b) => b.at - a.at);
  })();
  DATA_KEYS.push('pAudit');

  /* ═══════════════════════ Workspaces ═══════════════════════ */
  STATUS.ws.archiving ??= ['warning', 'Archive requested'];
  STATUS.ws.archived ??= ['default', 'Archived'];
  const WS_STATUS = [['active', 'Active'], ['new', 'Setting up'], ['suspended', 'Suspended'], ['archiving', 'Archive requested'], ['archived', 'Archived']];
  /** Archive requests wait on an operator: the Workspaces nav badge counts them. */
  X.pWsAttention = () => D.pWorkspaces.filter(w => w.status === 'archiving').length;
  /** Created workspaces finish setup a few seconds after creation (also after a reload). */
  function settleNew() {
    D.pWorkspaces.forEach(w => {
      if (w.status !== 'new' || !w.readyAt) return;
      if (w.readyAt <= Date.now()) { w.status = 'active'; delete w.readyAt; } else scheduleReady(w);
    });
  }
  function scheduleReady(w) {
    if (readyTimers.has(w.id)) return;
    readyTimers.add(w.id);
    setTimeout(() => {
      readyTimers.delete(w.id);
      if (w.status !== 'new') return;
      w.status = 'active'; delete w.readyAt; persist(); refresh();
      toast(`${w.name} is ready`, { action: { label: 'View', run: () => goThen('/p/workspaces', () => A['pws-open']({ dataset: { id: w.id } })) } });
    }, Math.max(0, w.readyAt - Date.now()));
  }
  const TEMPLATE_OPTS = () => Object.entries(TEMPLATES).map(([id, t]) => [id, t.label]);
  const TPL_ICON = { enterprise: 'building', campus: 'graduation' };
  const tplChip = w => chip(wsTemplate(w).label, { size: 'sm', icon: TPL_ICON[wsTemplateId(w)] || 'layers', tip: wsTemplate(w).desc });

  /** What needs an operator first: archive requests, then new, then suspended, then the steady state, archived last. */
  const WS_RANK = { archiving: 0, new: 1, suspended: 2, active: 3, archived: 4 };
  /** One line under the title: how many workspaces, and which ones aren't simply active. */
  function wsSummary(all) {
    const n = st => all.filter(w => w.status === st).length;
    const arc = n('archiving'), sus = n('suspended'), fresh = n('new'), gone = n('archived');
    const parts = [plural(all.length, 'workspace')];
    if (arc) parts.push(arc === 1 ? '1 archive request' : `${arc} archive requests`);
    if (sus) parts.push(`${sus} suspended`);
    if (fresh) parts.push(`${fresh} setting up`);
    if (gone) parts.push(`${gone} archived`);
    if (parts.length === 1) parts.push('all active');
    return esc(parts.join(' · '));
  }

  P.pWorkspaces = () => {
    settleNew();
    const u = ui('pws', { q: '', status: '' });
    const all = D.pWorkspaces;
    // Templates only help when workspaces differ; otherwise the chip and filter are noise.
    const mixed = new Set(all.map(w => wsTemplateId(w))).size > 1;
    const filtered = !!(u.q || u.status || u.template);
    const toolbar = all.length > 6 || filtered ? `<div class="toolbar">${searchField({ uiKey: 'pws', placeholder: 'Search workspaces' })}${filterButton('Status', 'pws', 'status', WS_STATUS)}${mixed || u.template ? filterButton('Template', 'pws', 'template', TEMPLATE_OPTS()) : ''}${clearFilters('pws', ['status', 'template'])}</div>` : '';
    const tbl = () => {
      let rows = all.filter(w => matchesQ('pws', w.name, w.code, w.owner) && (!u.status || w.status === u.status) && (!u.template || wsTemplateId(w) === u.template));
      if (!rows.length) return noMatches('pws', ['status', 'template'], 'workspaces');
      rows = u.sort ? applySort(rows, 'pws', { name: w => w.name.toLowerCase() }) : [...rows].sort((a, b) => (WS_RANK[a.status] ?? 3) - (WS_RANK[b.status] ?? 3) || b.created - a.created);
      return table({
        label: 'Workspaces',
        head: sortHead('Workspace', 'name', 'pws') + th('Owner', 'hide-md') + sortHead('Members', 'members', 'pws', 'table__column--num') + sortHead('Questions, 30 days', 'questions30', 'pws', 'table__column--num') + th('Status'),
        rows: rows.map(w => `<tr class="${cx('table__row', w.id === newId && 'table__row--new')}" data-act="pws-open" data-id="${w.id}" tabindex="0">
          <td class="table__cell table__cell--primary"><div class="row gap-12">${wsMark(w, 32)}<div class="stack"><span class="cell-title row gap-8"><span class="truncate">${esc(w.name)}</span>${mixed ? tplChip(w) : ''}</span><span class="cell-sub mono truncate">${esc(wsUrl(w))}</span></div></div></td>
          <td class="table__cell table__cell--hide-sm hide-md"><span class="row gap-8">${avatar(w.owner, 'xs')}<span class="truncate">${esc(w.owner)}</span></span></td>
          <td class="table__cell table__cell--num num" data-label="Members">${fmtNum(w.members)}</td>
          <td class="table__cell table__cell--num num" data-label="Questions">${fmtNum(w.questions30)}</td>
          <td class="table__cell">${status('ws', w.status)}</td></tr>`),
        foot: filtered ? `<div class="table-foot"><span class="num">${plural(rows.length, 'workspace')}</span></div>` : '',
      });
    };
    const live = S.pageState === 'live' && !S.navLoading;
    return `<div class="page">${pageHeader({ title: 'Workspaces', desc: live && all.length ? wsSummary(all) : 'Every customer and team on this deployment.', extra: PREVIEW, actions: btn('Create workspace', { v: 'primary', icon: 'plus', act: 'pws-create' }) })}
      ${gate({ ok: () => toolbar + tbl(), loading: () => skelRows(7), empty: () => emptyState({ icon: 'building', title: 'No workspaces yet', desc: 'Create one for each customer or team. Its first admin sets up the rest.', actions: btn('Create workspace', { icon: 'plus', act: 'pws-create' }), boxed: true }) })}</div>`;
  };
  AFTER.pWorkspaces = () => { if (newId) $('tr.table__row--new')?.scrollIntoView({ block: 'nearest' }); };

  function openWs(w) {
    if (!isMemberWs(w)) { toast(`You’re not a member of ${w.name}`, { tone: 'accent' }); return; }
    enterWorkspace(w.id, { quiet: true }); go('/overview'); toast(`Switched to ${w.name}`, { tone: 'accent' });
  }
  /** The workspace's own Activity log also records platform decisions about it (its admins see them). */
  const wsLog = (w, action) => DB.ws[w.id]?.audit?.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Settings', target: w.name, outcome: 'success', ip: '10.4.0.12', device: 'Chrome on macOS' });
  /** Suspending is reversible (nothing is deleted): it applies at once with Undo; so does reactivating. */
  function suspendWs(w) {
    const before = w.status, on = before !== 'suspended';
    w.status = on ? 'suspended' : 'active';
    log(on ? 'Suspended workspace' : 'Reactivated workspace', 'Workspaces', w.name, w.id); refresh(); refreshLayer();
    toast(on ? `Suspended ${w.name}. Members can’t sign in.` : `Reactivated ${w.name}`, { action: { label: 'Undo', run: () => { w.status = before; log(on ? 'Reactivated workspace' : 'Suspended workspace', 'Workspaces', w.name, w.id); refresh(); refreshLayer(); } } });
  }
  /** Complete an archive request: typed confirmation (high-risk), then restorable for 30 days from the drawer. */
  function archiveWs(w) {
    if (w.status !== 'archiving') return;
    confirmAction({
      title: `Archive ${w.name}?`, danger: true, icon: 'archive', confirm: 'Archive workspace', typeText: w.code,
      body: `<span>${esc(w.archiveRequest?.actor || 'Its admin')} asked for this.</span> <span>Members lose access and source syncs stop. Its data is kept, and you can restore it until ${esc(fmtDate(Date.now() + 30 * DAY))}.</span>`,
      onConfirm: () => {
        w.archiveDecision = { outcome: 'archived', by: me().name, at: Date.now() };
        delete w.archiveRequest; w.status = 'archived';
        log('Archived workspace', 'Workspaces', w.name, w.id); wsLog(w, 'Archived workspace'); refresh(); refreshLayer();
        toast(`Archived ${w.name}. You can restore it for 30 days.`);
      },
    });
  }
  function restoreWs(w) {
    if (w.status !== 'archived') return;
    const dec = w.archiveDecision; w.status = 'active'; delete w.archiveDecision;
    log('Restored workspace', 'Workspaces', w.name, w.id); wsLog(w, 'Restored workspace'); refresh(); refreshLayer();
    toast(`Restored ${w.name}`, { action: { label: 'Undo', run: () => { w.status = 'archived'; w.archiveDecision = dec; log('Archived workspace', 'Workspaces', w.name, w.id); refresh(); refreshLayer(); } } });
  }
  A['pws-open'] = el => { if (wsById(el.dataset.id)) openDrawer('pf-ws', { id: el.dataset.id }); };
  A['pf-ws-enter'] = el => { const w = wsById(el.dataset.id); if (w) openWs(w); };
  A['pf-ws-copy'] = el => { const w = wsById(el.dataset.id); if (w) copyText('https://' + wsUrl(w), 'Copied workspace URL'); };
  A['pf-ws-suspend'] = el => { const w = wsById(el.dataset.id); if (w) suspendWs(w); };
  A['pf-ws-archive'] = el => { const w = wsById(el.dataset.id); if (w) archiveWs(w); };
  A['pf-ws-restore'] = el => { const w = wsById(el.dataset.id); if (w) restoreWs(w); };
  A['pf-ws-decline'] = el => { const w = wsById(el.dataset.id); if (w?.status === 'archiving') { S.ui.pfDecline = { reason: '', tried: false }; openModal('pf-ws-decline', { id: w.id }); } };
  /** Declining needs a reason: it's shown to the workspace admin in Settings. */
  M['pf-ws-decline'] = ({ id }) => {
    const w = wsById(id), f = ui('pfDecline'), err = f.tried && !f.reason.trim() ? 'Say why, so the workspace admin knows what to do next.' : '';
    return {
      title: `Decline the archive request for ${w?.name}?`, icon: 'x-circle', tone: 'default', size: 'md',
      desc: 'The workspace stays active. Its admins see your reason in Settings.',
      body: field({ id: 'pf-decline-reason', label: 'Reason', required: true, error: err, control: textarea({ id: 'pf-decline-reason', bind: 'pfDecline.reason', value: f.reason, rows: 3, invalid: !!err, placeholder: 'e.g. The contract runs until March. Talk to your account manager first.' }) }),
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Decline request', { v: 'primary', act: 'pf-ws-decline-send', data: { id } }),
    };
  };
  A['pf-ws-decline-send'] = el => {
    const w = wsById(el.dataset.id), f = ui('pfDecline'); if (!w || w.status !== 'archiving') return;
    f.tried = true; if (!f.reason.trim()) { refreshLayer(); $('#pf-decline-reason')?.focus(); return; }
    w.archiveDecision = { outcome: 'declined', reason: f.reason.trim(), by: me().name, at: Date.now() };
    delete w.archiveRequest; w.status = 'active';
    log('Declined archive request', 'Workspaces', w.name, w.id); wsLog(w, 'Archive request declined');
    closeModal(); refresh(); refreshLayer();
    toast(`Declined. ${w.name}’s admins see your reason.`);
  };
  /* Rare and administrative: copy the address, suspend. The status's own next step is the drawer's footer instead. */
  MENUS['pf-ws-more'] = el => {
    const w = wsById(el.dataset.id); if (!w) return [];
    return [
      { label: 'Copy URL', icon: 'copy', run: () => A['pf-ws-copy']({ dataset: { id: w.id } }) },
      ...(['active', 'new'].includes(w.status) ? [{ sep: true }, { label: 'Suspend workspace', icon: 'pause', danger: true, run: () => suspendWs(w) }] : []),
    ];
  };

  DR['pf-ws'] = ({ id }) => {
    const w = wsById(id);
    if (!w) return { title: 'Workspace not found', body: emptyState({ icon: 'building', title: 'This workspace no longer exists', compact: true }) };
    const h = hashOf(w.id), off = w.status === 'suspended' || w.status === 'archived';
    const vals = off ? Array(14).fill(0) : series(h, 14, Math.round((w.questions30 * 14) / 30));
    const labels = dayLabels(14), total = vals.reduce((a, b) => a + b, 0);
    const admins = wsAdmins(w);
    const req = w.status === 'archiving' && w.archiveRequest, dec = w.archiveDecision;
    const notice = req ? alertBox('warning', 'Archive requested', `${esc(req.actor)} asked to archive this workspace ${esc(rel(req.at).toLowerCase())}. Archive it, or decline and say why.`)
      : w.status === 'archived' ? alertBox('default', 'Archived', `${esc(dec?.by || 'A platform admin')} archived it ${esc(rel(dec?.at || Date.now()).toLowerCase())}. You can restore it until ${esc(fmtDate((dec?.at || Date.now()) + 30 * DAY))}.`, '', { icon: 'archive' }) : '';
    /* One way forward per status: decide an archive request, restore an archived one, reactivate a suspended one, otherwise open it (members only). */
    const foot = req ? btn('Decline request', { v: 'ghost', act: 'pf-ws-decline', data: { id: w.id } }) + btn('Archive workspace', { v: 'danger', icon: 'archive', act: 'pf-ws-archive', data: { id: w.id } })
      : w.status === 'archived' ? btn('Restore workspace', { v: 'primary', icon: 'undo', act: 'pf-ws-restore', data: { id: w.id } })
        : w.status === 'suspended' ? btn('Reactivate', { v: 'primary', icon: 'play', act: 'pf-ws-suspend', data: { id: w.id } })
          : isMemberWs(w) ? btn('Open workspace', { v: 'primary', iconRight: 'arrow-right', act: 'pf-ws-enter', data: { id: w.id } }) : '';
    return {
      title: w.name, lead: wsMark(w, 40), desc: `<span class="mono">${esc(wsUrl(w))}</span>`,
      body: `${notice ? `<div class="drawer__section">${notice}</div>` : ''}<div class="drawer__section">${kv([
        ['Status', status('ws', w.status)],
        ['Template', tplChip(w)],
        ['Created', esc(fmtDate(w.created))],
        ['Members', `<span class="num">${fmtNum(w.members)}</span>`],
        ['Documents', `<span class="num">${fmtNum(w.docs)}</span>`],
      ])}</div>
        <div class="drawer__section"><div class="pf-sec-head"><h3 class="drawer__section-title">Questions, last 14 days</h3><span class="t-xs muted num">${fmtNum(total)}</span></div>
          ${off ? `<p class="t-sm muted">No questions while ${w.status === 'archived' ? 'archived' : 'suspended'}.</p>` : sparkline(vals, { height: 48 }) + axis(labels[0], 'Today')}</div>
        <div class="drawer__section"><h3 class="drawer__section-title">Admins</h3>${list(admins.map(a => item({ lead: avatar(a.name, 'sm'), title: esc(a.name), desc: esc(a.email), trail: a.owner ? chip('Owner', { size: 'sm' }) : '' })))}</div>`,
      headActions: iconBtn('more', 'More actions', { menu: 'pf-ws-more', data: { id: w.id } }),
      foot,
    };
  };

  /* ── Create workspace: name → web address (auto, editable, unique) → first admin ── */
  const newForm = () => ui('pfNew', { name: '', code: '', email: '', template: 'enterprise', codeEdited: false, submitted: false, busy: false });
  function newErrors(f) {
    const e = {}, name = f.name.trim(), code = f.code.trim(), email = f.email.trim();
    if (!name) e.name = 'Enter a name for the workspace.'; else if (name.length < 2) e.name = 'Use at least 2 characters.';
    if (!code) e.code = 'Enter a web address.';
    else if (!CODE_RE.test(code)) e.code = 'Use 3–40 lowercase letters, numbers or hyphens.';
    else { const t = D.pWorkspaces.find(w => w.code === code); if (t) e.code = `Already used by ${t.name}. Try another.`; }
    if (!email) e.email = 'Enter the email of the first admin.'; else if (!EMAIL_RE.test(email)) e.email = 'Enter a full email address, like sam@litware.com.';
    return e;
  }
  /** Errors show after the first submit; an address that’s taken shows right away. */
  function newVisible(f) {
    const e = newErrors(f);
    if (f.submitted) return e;
    return e.code && f.code.trim() && /Already used/.test(e.code) ? { code: e.code } : {};
  }
  A['pws-create'] = () => { S.ui.pfNew = null; newForm(); openModal('pf-ws-new'); };
  M['pf-ws-new'] = () => {
    const f = newForm();
    if (!f.codeEdited) f.code = slug(f.name);
    const v = newVisible(f);
    const email = f.email.trim(), acct = EMAIL_RE.test(email) ? accountFor(email) : null;
    const emailDesc = !EMAIL_RE.test(email) ? 'They become its first admin and invite everyone else.'
      : acct ? `<span class="row gap-6">${avatar(acct.name, 'xs')}${esc(acct.name)} already has an account.</span>` : 'We’ll email them an invite to create an account.';
    const dis = f.busy ? 'disabled' : '';
    return {
      title: 'Create workspace', size: 'md', guard: f.busy, icon: TPL_ICON[f.template] || 'building',
      desc: 'A private home for one customer or team. Its first admin sets up the rest.',
      body: `<div class="field"><span class="label">Template</span><div class="pf-tpl">${choiceGroup({ name: 'pf-new-tpl', value: f.template, act: 'pf-ws-tpl', cols: 2, options: Object.entries(TEMPLATES).map(([id, t]) => [id, t.label, esc(t.desc), TPL_ICON[id] || 'layers']) })}</div></div>
        ${field({ id: 'pf-new-name', label: 'Name', required: true, error: v.name, control: input({ id: 'pf-new-name', bind: 'pfNew.name', value: f.name, placeholder: f.template === 'campus' ? 'e.g. Hanoi University' : 'e.g. Litware Labs', autofocus: true, attrs: `data-live maxlength="60" ${dis}`, invalid: !!v.name, onEnter: 'pf-ws-new-submit' }) })}
        ${field({ id: 'pf-new-code', label: 'Web address', required: true, error: v.code, desc: f.codeEdited ? 'People sign in at this address.' : 'Filled in from the name. You can change it.',
          control: `<div class="pf-prefix"><span class="pf-prefix__text" aria-hidden="true">bomesh.app/</span>${input({ id: 'pf-new-code', bind: 'pfNew.code', value: f.code, placeholder: 'litware', cls: 'mono', attrs: `data-input="pf-ws-code" spellcheck="false" ${dis}`, invalid: !!v.code, onEnter: 'pf-ws-new-submit' })}</div>` })}
        ${field({ id: 'pf-new-email', label: 'First admin', required: true, error: v.email, desc: emailDesc, control: input({ id: 'pf-new-email', bind: 'pfNew.email', value: f.email, placeholder: 'name@company.com', autocomplete: 'off', attrs: `data-live inputmode="email" spellcheck="false" autocapitalize="off" ${dis}`, invalid: !!v.email, onEnter: 'pf-ws-new-submit' }) })}`,
      footStart: 'Ready in a few seconds. The admin can change the template later.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Create workspace', { v: 'primary', icon: 'plus', act: 'pf-ws-new-submit', loading: f.busy }),
    };
  };
  A['pf-ws-code'] = () => { const f = newForm(); f.codeEdited = f.code.trim() !== ''; refreshLayer(); };
  A['pf-ws-tpl'] = el => { if (TEMPLATES[el.dataset.value]) newForm().template = el.dataset.value; refreshLayer(); };
  A['pf-ws-new-submit'] = async () => {
    const f = newForm(); if (f.busy || S.modal?.name !== 'pf-ws-new') return;
    if (!f.codeEdited) f.code = slug(f.name);
    f.submitted = true; const e = newErrors(f);
    if (Object.keys(e).length) { refreshLayer(); $('#pf-new-' + Object.keys(e)[0])?.focus(); return; }
    f.busy = true; S.modal.props.guard = true; refreshLayer();
    await sleep(900);
    const code = f.code.trim(), email = f.email.trim().toLowerCase(), acct = accountFor(email), owner = acct?.name || nameFromEmail(email);
    const ws = { id: 'ws-' + code, name: f.name.trim(), code, color: WS_COLORS[hashOf(code) % WS_COLORS.length], members: 1, docs: 0, status: 'new', created: Date.now(), readyAt: Date.now() + READY_MS, owner, adminEmail: email, questions30: 0, template: f.template };
    D.pWorkspaces.push(ws);
    const pu = D.pUsers.find(x => x.email === email);
    if (pu) pu.ws += 1; else D.pUsers.push({ id: uid('pu'), name: owner, email, ws: 1, platformAdmin: false, status: acct ? 'active' : 'invited', last: null });
    log('Created workspace', 'Workspaces', `${ws.name} · ${TEMPLATES[ws.template].label}`, ws.id);
    f.busy = false; closeModal(); newId = ws.id;
    Object.assign(ui('pws'), { q: '', status: '', template: '', sort: null });
    if (S.cur.path !== '/p/workspaces') go('/p/workspaces'); else refresh();
    toast(acct ? `Created ${ws.name}. ${owner} is its first admin.` : `Created ${ws.name}. Invite sent to ${email}.`);
    scheduleReady(ws);
    setTimeout(() => { if (newId === ws.id) newId = null; }, 2600);
  };

  /* ═══════════════════════ Users ═══════════════════════ */
  function userWs(u) {
    const out = []; const add = (w, role) => { if (w && out.length < u.ws && !out.some(o => o.w === w)) out.push({ w, role }); };
    D.pWorkspaces.filter(w => w.owner === u.name).forEach(w => add(w, 'Owner'));
    const m = D.members.find(x => x.name === u.name);
    if (m) D.workspaces.forEach(w => add(w, roleById(m.roleId)?.name || 'Member'));
    const dom = u.email.split('@')[1].split('.')[0];
    D.pWorkspaces.filter(w => w.code.startsWith(dom)).forEach(w => add(w, 'Member'));
    const h = hashOf(u.id), pool = D.pWorkspaces;
    for (let i = 0; out.length < u.ws && i < pool.length * 2; i++) add(pool[(h + i * 3) % pool.length], 'Member');
    return out;
  }
  /** Granting platform admin is high-risk (every workspace, user and connector): it asks once. Taking it away is reversible: at once, with Undo. */
  function toggleAdmin(u) {
    if (isSelf(u)) return;
    if (!u.platformAdmin) {
      confirmAction({ title: `Make ${u.name} a platform admin?`, body: 'They’ll manage every workspace, user and connector on this deployment.', confirm: 'Make platform admin',
        onConfirm: () => { u.platformAdmin = true; log('Made platform admin', 'People', u.name); refresh(); refreshLayer(); toast(`${u.name} is now a platform admin`); } });
      return;
    }
    u.platformAdmin = false; log('Removed platform admin', 'People', u.name); refresh(); refreshLayer();
    toast(`${u.name} is no longer a platform admin`, { action: { label: 'Undo', run: () => { u.platformAdmin = true; log('Made platform admin', 'People', u.name); refresh(); refreshLayer(); } } });
  }
  /** Suspending an account deletes nothing: at once, with Undo; reactivating likewise. */
  function suspendUser(u) {
    if (isSelf(u)) return;
    const before = u.status, on = before !== 'suspended';
    u.status = on ? 'suspended' : 'active';
    log(on ? 'Suspended account' : 'Reactivated account', 'People', u.name); refresh(); refreshLayer();
    toast(on ? `Suspended ${u.name}. They can’t sign in to any workspace.` : `Reactivated ${u.name}`, { action: { label: 'Undo', run: () => { u.status = before; log(on ? 'Reactivated account' : 'Suspended account', 'People', u.name); refresh(); refreshLayer(); } } });
  }
  const lastActive = u => u.last ? rel(u.last) : 'Never';

  P.pUsers = () => {
    const f = ui('pfu', { q: '', role: '', status: '' });
    const filtered = !!(f.q || f.role || f.status);
    const toolbar = D.pUsers.length > 6 || filtered ? `<div class="toolbar">${searchField({ uiKey: 'pfu', placeholder: 'Search by name or email' })}${filterButton('Platform role', 'pfu', 'role', [['admin', 'Platform admin'], ['standard', 'Standard']])}${filterButton('Status', 'pfu', 'status', [['active', 'Active'], ['invited', 'Invited'], ['suspended', 'Suspended']])}${clearFilters('pfu', ['role', 'status'])}</div>` : '';
    const tbl = () => {
      let rows = D.pUsers.filter(u => matchesQ('pfu', u.name, u.email) && (!f.role || (f.role === 'admin') === u.platformAdmin) && (!f.status || u.status === f.status));
      if (!rows.length) return noMatches('pfu', ['role', 'status'], 'people');
      rows = f.sort ? applySort(rows, 'pfu', { name: u => u.name.toLowerCase(), last: u => u.last || 0 }) : [...rows].sort((a, b) => a.name.localeCompare(b.name));
      return table({
        label: 'Users',
        head: sortHead('Person', 'name', 'pfu') + sortHead('Workspaces', 'ws', 'pfu', 'table__column--num') + sortHead('Last active', 'last', 'pfu', 'hide-md'),
        /* Same rule as People: status sits next to the name, only when it isn't the usual "Active". */
        rows: rows.map(u => `<tr class="table__row" data-act="pu-open" data-id="${u.id}" tabindex="0">
          <td class="table__cell table__cell--primary"><div class="row gap-12">${avatar(u.name)}<div class="stack"><span class="cell-title row gap-8 wrap"><span class="truncate">${esc(u.name)}${isSelf(u) ? ' <span class="muted t-sm">(you)</span>' : ''}</span>${u.status !== 'active' ? status('member', u.status) : ''}${u.platformAdmin ? chip('Platform admin', { tone: 'accent', size: 'sm', icon: 'shield' }) : ''}</span><span class="cell-sub truncate">${esc(u.email)}</span></div></div></td>
          <td class="table__cell table__cell--num num" data-label="Workspaces">${fmtNum(u.ws)}</td>
          <td class="table__cell hide-md muted">${esc(u.status === 'invited' ? 'Not signed up yet' : lastActive(u))}</td></tr>`),
        foot: `<div class="table-foot"><span class="num">${plural(rows.length, 'account')}</span></div>`,
      });
    };
    return `<div class="page">${pageHeader({ title: 'Users', desc: 'Everyone with a BoMesh account, across all workspaces.', extra: PREVIEW })}
      ${gate({ ok: () => toolbar + tbl(), loading: () => skelRows(8), empty: () => emptyState({ icon: 'users', title: 'No accounts yet', desc: 'People appear here once they sign up or are invited to a workspace.', boxed: true }) })}</div>`;
  };
  A['pu-open'] = el => { if (userById(el.dataset.id)) openDrawer('pf-user', { id: el.dataset.id }); };
  A['pf-user-admin'] = el => { const u = userById(el.dataset.id); if (u) toggleAdmin(u); };
  A['pf-user-suspend'] = el => { const u = userById(el.dataset.id); if (u) suspendUser(u); };
  MENUS['pf-user-more'] = el => { const u = userById(el.dataset.id); return u && !isSelf(u) && u.status !== 'suspended' ? [{ label: 'Suspend account', icon: 'pause', danger: true, run: () => suspendUser(u) }] : []; };
  DR['pf-user'] = ({ id }) => {
    const u = userById(id);
    if (!u) return { title: 'Account not found', body: emptyState({ icon: 'user', title: 'This account no longer exists', compact: true }) };
    const self = isSelf(u), mships = userWs(u);
    return {
      title: u.name + (self ? ' (you)' : ''), desc: esc(u.email), lead: avatar(u.name, 'lg'),
      body: `<div class="drawer__section">${kv([['Status', status('member', u.status)], ['Last active', esc(lastActive(u))]])}</div>
        <div class="drawer__section"><h3 class="drawer__section-title">Workspaces</h3>
          ${mships.length ? list(mships.map(({ w, role }) => item({ lead: wsMark(w, 28), title: esc(w.name), desc: `<span class="mono">${esc(wsUrl(w))}</span>`, meta: esc(role), trail: ic('chevron-right', 'i-sm muted'), act: 'pws-open', data: { id: w.id } })))
            : emptyState({ icon: 'building', title: 'Not in any workspace', desc: 'Platform admins can manage workspaces without joining them.', compact: true, boxed: true })}</div>
        <div class="drawer__section">${switchRow({ title: 'Platform admin', desc: self ? 'You can’t change your own platform role.' : 'Can manage every workspace, user and connector.', on: u.platformAdmin, act: 'pf-user-admin', data: { id: u.id }, disabled: self })}</div>`,
      // Suspending is rare and destructive (⋯); a suspended account's way forward is reactivating it.
      headActions: self || u.status === 'suspended' ? '' : iconBtn('more', 'More actions', { menu: 'pf-user-more', data: { id: u.id } }),
      foot: !self && u.status === 'suspended' ? btn('Reactivate account', { v: 'primary', icon: 'play', act: 'pf-user-suspend', data: { id: u.id } }) : '',
    };
  };

  /* ═══════════════════════ Connectors ═══════════════════════ */
  const CON_CFG = {
    gdrive: { updated: ago(42 * DAY), by: 'Alex Rivera' },
    confluence: { updated: ago(88 * DAY), by: 'Jordan Blake' },
  };
  /* One card pattern for every installed connector: the whole card opens its drawer (status, who uses it, the
     "Available to workspaces" switch). Requested ones aren't installed: their card opens who asked. */
  P.pConnectors = () => {
    const head = (c, sub) => `<span class="row gap-12 pf-con__head">${appIcon(c.key, 'lg')}<span class="stack gap-4 grow"><span class="card__title truncate">${esc(c.name)}</span><span class="pf-con__sub">${sub}</span></span>${ic('chevron-right', 'pf-con__chev')}</span>`;
    const used = c => c.status === 'disabled' ? 'Workspaces can’t connect it' : c.status === 'builtin' ? `Always on · used by ${plural(c.workspaces || 0, 'workspace')}` : `Used by ${plural(c.workspaces || 0, 'workspace')}`;
    const availableCard = c => `<button type="button" class="card card--action pf-con" data-act="pf-con-open" data-key="${esc(c.key)}">${head(c, status('connector', c.status))}<span class="pf-con__foot t-sm muted">${esc(used(c))}</span></button>`;
    const requestedCard = c => `<button type="button" class="card card--action pf-con" data-act="pf-con-demand" data-key="${esc(c.key)}">${head(c, status('connector', c.status))}<span class="pf-con__foot t-sm muted">${esc(`Requested by ${plural(c.requests || 0, 'workspace')}`)}</span></button>`;
    const ok = () => {
      const avail = D.pConnectors.filter(c => c.status !== 'unavailable'), asked = D.pConnectors.filter(c => c.status === 'unavailable').sort((a, b) => (b.requests || 0) - (a.requests || 0));
      return section('Available to workspaces', `<div class="grid cols-3">${avail.map(availableCard).join('')}</div>`, { desc: 'Workspace admins can connect these as sources. Open one to turn it on or off.' })
        + (asked.length ? section('Requested', `<div class="grid cols-3">${asked.map(requestedCard).join('')}</div>`, { desc: 'Not on this deployment yet. Open one to see who asked.' }) : '');
    };
    return `<div class="page">${pageHeader({ title: 'Connectors', desc: 'Apps that workspaces can connect.', extra: PREVIEW })}
      ${gate({ ok, loading: () => skelCards(6), empty: () => emptyState({ icon: 'plug', title: 'No connectors installed', desc: 'Connectors appear once they’re part of this deployment.', boxed: true }) })}</div>`;
  };
  /** On/off is reversible (documents stay searchable): at once, with Undo. */
  function setConnector(c, on) {
    const before = c.status;
    c.status = on ? 'enabled' : 'disabled';
    log(on ? 'Turned on connector' : 'Turned off connector', 'Connectors', c.name);
    refresh(); refreshLayer();
    toast(on ? `${c.name} is available to workspaces` : `Turned off ${c.name}. Workspaces stop syncing from it.`, { action: { label: 'Undo', run: () => { c.status = before; log(on ? 'Turned off connector' : 'Turned on connector', 'Connectors', c.name); refresh(); refreshLayer(); } } });
  }
  A['pf-con-open'] = el => { if (conByKey(el.dataset.key)) openDrawer('pf-con', { key: el.dataset.key }); };
  A['pf-con-toggle'] = el => { const c = conByKey(el.dataset.key); if (c && c.status !== 'builtin') setConnector(c, c.status !== 'enabled'); };
  DR['pf-con'] = ({ key }) => {
    const c = conByKey(key);
    if (!c) return { title: 'Connector not found', body: '' };
    const cfg = CON_CFG[key], on = c.status !== 'disabled', builtin = c.status === 'builtin';
    const desc = builtin ? 'Built in. Every workspace can upload files, so it can’t be turned off.' : on ? 'Workspace admins can connect it as a source.' : `Workspaces can’t connect it. ${plural(c.workspaces || 0, 'workspace')} stopped syncing; their documents stay searchable.`;
    return {
      title: c.name, lead: appIcon(key, 'lg'), desc: esc(c.desc),
      body: `<div class="drawer__section">${kv([
        ['Status', status('connector', c.status)],
        c.auth && ['Sign-in method', esc(c.auth)],
        ['Used by', plural(c.workspaces || 0, 'workspace')],
        cfg && ['Last changed', `${esc(cfg.by)} · ${esc(fmtDate(cfg.updated))}`],
      ])}</div>
        <div class="drawer__section">${switchRow({ title: 'Available to workspaces', desc: esc(desc), on, act: 'pf-con-toggle', data: { key }, disabled: builtin })}</div>`,
    };
  };
  A['pf-con-demand'] = el => { if (conByKey(el.dataset.key)) openModal('pf-con-demand', { key: el.dataset.key }); };
  A['pf-con-demand-ws'] = el => { if (!wsById(el.dataset.id)) return; closeModal(); openDrawer('pf-ws', { id: el.dataset.id }); };
  M['pf-con-demand'] = ({ key }) => {
    const c = conByKey(key);
    const pool = D.pWorkspaces.filter(w => NOW - w.created > 7 * DAY);
    const reqs = [...pool].sort((a, b) => hashOf(key + a.id) - hashOf(key + b.id)).slice(0, c.requests || 0)
      .map(w => ({ w, at: Math.max(w.created + DAY, ago((2 + (hashOf(key + w.code) % 70)) * DAY)) })).sort((a, b) => b.at - a.at);
    return {
      title: `${c.name} requests`, icon: APPS[key]?.glyph(20) || 'plug', tone: 'default',
      desc: `${plural(reqs.length, 'workspace')} asked for this connector. It isn’t on this deployment yet.`,
      body: reqs.length ? list(reqs.map(({ w, at }) => item({ lead: wsMark(w, 28), title: esc(w.name), desc: `Requested by ${esc(w.owner)}`, meta: esc(fmtDate(at)), trail: ic('chevron-right', 'i-sm muted'), act: 'pf-con-demand-ws', data: { id: w.id } })))
        : emptyState({ icon: 'plug', title: 'No requests yet', desc: 'Workspaces that ask for it appear here.', compact: true }),
      footStart: 'Connectors are added in the deployment configuration.',
      foot: btn('Done', { v: 'primary', act: 'close-modal' }),
    };
  };

  /* ═══════════════════════ Usage ═══════════════════════ */
  const WINDOWS = [['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
  function usageOf(w, n) {
    const h = hashOf(w.id), off = w.status === 'suspended';
    const questions = off ? 0 : Math.round(((w.questions30 * n) / 30) * (0.92 + 0.16 * r01(h, n)));
    const active = off ? 0 : Math.min(w.members, Math.round(w.members * (0.35 + 0.4 * r01(h, 1)) * (n === 7 ? 0.62 : n === 30 ? 0.85 : 1)) || (w.questions30 ? 1 : 0));
    const processed = off ? 0 : Math.round(w.docs * 0.035 * (n / 30) * (0.7 + 0.6 * r01(h, n + 1)));
    return { w, questions, active, processed };
  }
  const usageRows = n => D.pWorkspaces.map(w => usageOf(w, n));
  /** Change vs the previous window, as a signed percentage. */
  function deltaPct(v, n, k) { const p = Math.round(v * (0.84 + 0.12 * r01(n, k))); return p ? Math.round(((v - p) / p) * 100) : 0; }
  const signed = d => `${d >= 0 ? '+' : '−'}${Math.abs(d)}%`;
  P.pUsage = () => {
    const u = ui('pfus', { win: '30' }); const n = +u.win;
    const header = pageHeader({ title: 'Usage', desc: 'Questions, active people and processed documents across workspaces.', extra: PREVIEW, actions: btn('Export CSV', { icon: 'download', act: 'pf-usage-export' }) });
    const ok = () => {
      const rows = usageRows(n);
      const tot = k => rows.reduce((a, r) => a + r[k], 0);
      const Q = tot('questions'), AP = tot('active'), DP = tot('processed');
      const qs = series(n * 13, n, Q), labels = dayLabels(n);
      /* Totals are one sentence next to the range they describe (no stat-card wall); the table and chart carry the detail. */
      const dq = deltaPct(Q, n, 1);
      const summary = `<p class="pf-usage-sum"><span><span class="medium num">${fmtNum(Q)}</span> questions <span class="${dq >= 0 ? 'text-success' : 'text-danger'} num">${signed(dq)}</span></span><span aria-hidden="true">·</span><span><span class="medium num">${fmtNum(AP)}</span> active people</span><span aria-hidden="true">·</span><span><span class="medium num">${fmtNum(DP)}</span> documents processed</span></p>`;
      const range = `<div class="toolbar pf-usage-bar">${seg({ value: u.win, options: WINDOWS, act: 'pf-usage-win', label: 'Time range' })}${summary}</div>`;
      const sorted = u.sort ? applySort(rows, 'pfus', { name: r => r.w.name.toLowerCase(), questions: r => r.questions, active: r => r.active, processed: r => r.processed }) : [...rows].sort((a, b) => b.questions - a.questions);
      return `${range}${table({
          label: 'Usage by workspace',
          head: sortHead('Workspace', 'name', 'pfus') + sortHead('Questions', 'questions', 'pfus', 'table__column--num') + sortHead('Active people', 'active', 'pfus', 'table__column--num') + sortHead('Documents processed', 'processed', 'pfus', 'table__column--num hide-md'),
          rows: sorted.map(r => { const share = Q ? (r.questions / Q) * 100 : 0; return `<tr class="table__row" data-act="pws-open" data-id="${r.w.id}" tabindex="0">
            <td class="table__cell table__cell--primary"><div class="row gap-8">${wsMark(r.w, 24)}<span class="cell-title truncate">${esc(r.w.name)}</span></div></td>
            <td class="table__cell table__cell--num"><div class="pf-share" data-tip="${share.toFixed(1)}% of all questions"><span class="num">${fmtNum(r.questions)}</span>${progress(share, '', 'Share of all questions')}</div></td>
            <td class="table__cell table__cell--num num" data-label="Active people">${fmtNum(r.active)}</td>
            <td class="table__cell table__cell--num num hide-md">${fmtNum(r.processed)}</td></tr>`; }),
        })}
        ${section('Questions per day', `${bars(qs, { height: 120, labels })}${axis(labels[0], labels[n - 1])}`)}`;
    };
    return `<div class="page">${header}${gate({ ok, loading: () => skelRows(6), empty: () => emptyState({ icon: 'chart', title: 'No usage yet', desc: 'Usage appears once people start asking questions.', boxed: true }) })}</div>`;
  };
  A['pf-usage-win'] = el => { ui('pfus').win = el.dataset.value; refresh(); };
  A['pf-usage-export'] = () => {
    const n = +ui('pfus', { win: '30' }).win, rows = usageRows(n), Q = rows.reduce((a, r) => a + r.questions, 0);
    saveCsv(`platform-usage-${n}d.csv`, [['Workspace', 'Web address', 'Questions', 'Share of questions (%)', 'Active people', 'Documents processed'],
      ...rows.sort((a, b) => b.questions - a.questions).map(r => [r.w.name, wsUrl(r.w), r.questions, Q ? ((r.questions / Q) * 100).toFixed(1) : '0', r.active, r.processed])],
    `Saved usage for the last ${n} days`);
  };

  /* ═══════════════════════ Audit log ═══════════════════════
     Built with the same toolbar, table and drawer as workspace Activity (X.auditLog, activity.js), plus a Workspace column. */
  const AUD_AREAS = ['Workspaces', 'People', 'Connectors', 'Indexing', 'Sign-in'];
  const audUi = () => ui('pfa', { q: '', ws: '', area: '', outcome: '', win: '30', page: 1 });
  const pWho = e => e.actor;
  function auditRows() {
    const f = audUi();
    const rows = D.pAudit.filter(e => X.auditLog.inWindow('pfa', e.at) && (!f.ws || (f.ws === 'platform' ? !e.ws : e.ws === f.ws)) && (!f.area || e.area === f.area) && (!f.outcome || e.outcome === f.outcome)
      && matchesQ('pfa', e.actor, e.action, e.target, e.area, wsById(e.ws)?.name || 'Platform'));
    return X.auditLog.sorted(rows, 'pfa', pWho);
  }
  const AUD_FIELDS = ['ws', 'area', 'outcome'];
  P.pAudit = () => {
    audUi();
    const live = S.pageState === 'live' && !S.navLoading;
    const rows = auditRows();
    const filters = [['Workspace', 'ws', [['platform', 'Platform'], ...D.pWorkspaces.map(w => [w.id, w.name])]], ['Area', 'area', AUD_AREAS.map(a => [a, a])], ['Outcome', 'outcome', [['success', 'Succeeded'], ['failure', 'Failed']]]];
    const tools = X.auditLog.toolbar({ uiKey: 'pfa', placeholder: 'Search events', filters, count: live ? plural(rows.length, 'event') : '' });
    const tbl = () => rows.length ? X.auditLog.table({ rows, uiKey: 'pfa', label: 'Audit events', who: pWho, where: e => wsCell(e.ws), open: 'pf-ev-open' })
      : emptyState({ icon: 'search', boxed: true, compact: true, title: 'No events match', desc: 'Try a longer time window or clear the filters.', actions: btn('Reset filters', { act: 'pf-audit-reset' }) });
    return `<div class="page">${pageHeader({ title: 'Audit log', desc: 'Changes to workspaces, accounts, connectors and indexing. What happens inside a workspace stays in its own Activity.', extra: PREVIEW, actions: X.auditLog.exportActions('pf-audit-export', live) })}
      ${gate({ ok: () => tools + tbl(), loading: () => skelRows(8), empty: () => emptyState({ icon: 'activity', title: 'No events recorded yet', desc: 'Changes to workspaces, accounts, connectors and indexing appear here.', boxed: true }) })}</div>`;
  };
  A['pf-audit-reset'] = () => { X.auditLog.reset('pfa', AUD_FIELDS); refresh(); };
  A['pf-ev-open'] = el => { if (D.pAudit.some(e => e.id === el.dataset.id)) openDrawer('pf-ev', { id: el.dataset.id }); };
  A['pf-audit-export'] = () => {
    const rows = auditRows();
    if (!rows.length) { toast('No events to export. Change the filters and try again.', { tone: 'danger' }); return; }
    saveCsv('platform-audit.csv', [['When', 'Workspace', 'Person', 'Area', 'Action', 'Target', 'Outcome', 'IP address', 'Device'],
      ...rows.map(e => [new Date(e.at).toISOString(), wsById(e.ws)?.name || 'Platform', e.actor, e.area, e.action, e.target, e.outcome, e.ip, e.device])],
    `Saved ${plural(rows.length, 'event')} to platform-audit.csv`);
  };
  /** The object a platform event is about, when it still exists. */
  function pRelated(e) {
    if (e.area === 'Connectors') { const c = D.pConnectors.find(x => x.name === e.target); if (c) return { label: `Open ${c.name}`, run: () => (c.status === 'unavailable' ? openModal('pf-con-demand', { key: c.key }) : openDrawer('pf-con', { key: c.key })) }; }
    if (e.area === 'People') { const u = userByName(e.target) || D.pUsers.find(x => x.email === e.target); if (u) return { label: `View ${u.name}`, run: () => openDrawer('pf-user', { id: u.id }) }; }
    if (e.area === 'Indexing') return { label: 'Open indexing', run: () => { closeDrawer(); go('/p/indexing'); } };
    const w = e.ws && wsById(e.ws); if (w) return { label: 'View workspace', run: () => openDrawer('pf-ws', { id: w.id }) };
    return null;
  }
  DR['pf-ev'] = ({ id }) => {
    const e = D.pAudit.find(x => x.id === id);
    if (!e) return { title: 'Event not found', body: emptyState({ icon: 'activity', title: 'This event is no longer in the log', compact: true }) };
    const to = pRelated(e);
    return X.auditLog.drawer({ ev: e, who: e.actor, area: e.area, where: wsCell(e.ws), related: to && { label: to.label, act: 'pf-ev-related', data: { id } } });
  };
  A['pf-ev-related'] = el => { const e = D.pAudit.find(x => x.id === el.dataset.id); pRelated(e)?.run(); };

  /* ═══════════════════════ System health + AI capabilities ═══════════════════════ */
  const INCIDENTS = [
    { id: 'inc-2', title: 'Answers were slow to start', at: ago(9 * DAY), dur: 38 * MIN, impact: 'The first words of answers took up to 12 seconds.' },
    { id: 'inc-1', title: 'Scheduled syncs were delayed', at: ago(23 * DAY), dur: 72 * MIN, impact: 'Syncs ran late and caught up once service resumed.' },
  ];
  const MODEL_ICON = { chat: 'sparkles', embed: 'search', vision: 'file-text', context: 'layers' };
  const BANNER = { processing: ['Document processing is slower than usual', 'New documents wait about 9 minutes before they’re searchable. Answers and search aren’t affected.'] };
  const fmtDur = ms => ms < HOUR ? Math.round(ms / MIN) + ' min' : Math.floor(ms / HOUR) + ' h ' + Math.round((ms % HOUR) / MIN) + ' min';

  P.pHealth = () => {
    const u = ui('pfh', { inc: false, busy: false, updated: Date.now(), open: {} });
    const bad = D.pServices.filter(s => s.status !== 'operational');
    /* The banner says what's wrong and, when indexing is the cause, where to act on it. */
    const banner = () => {
      if (!bad.length) return alertBox('success', 'All systems operational', '');
      const [title, desc] = BANNER[bad[0].id] || [`${bad[0].name} is ${STATUS.service[bad[0].status]?.[1].toLowerCase() || 'affected'}`, esc(bad[0].note || '')];
      const act = bad.some(s => s.id === 'processing') ? linkBtn('Indexing by workspace', { href: '/p/indexing', icon: 'arrow-up-right' }) : '';
      return alertBox(bad.some(s => s.status === 'down') ? 'danger' : 'warning', bad.length > 1 ? `${plural(bad.length, 'service')} need attention` : title, bad.length > 1 ? bad.map(s => esc(s.name)).join(', ') : desc, act);
    };
    const rank = s => (s.status === 'down' ? 0 : s.status === 'operational' ? 2 : 1);
    const services = () => table({
      label: 'Services',
      head: th('Service') + th('Status') + th('Response', 'table__column--num hide-sm') + th('Uptime, 30 days', 'table__column--num'),
      rows: [...D.pServices].sort((a, b) => rank(a) - rank(b)).map(s => {
        const open = s.note && (u.open[s.id] ?? s.status !== 'operational');
        return `<tr class="table__row" ${s.note ? `data-act="pf-svc-toggle" data-id="${s.id}" tabindex="0" aria-expanded="${!!open}"` : ''}>
          <td class="table__cell table__cell--primary"><div class="stack"><span class="cell-title pf-svc">${esc(s.name)}${s.note ? ic(open ? 'chevron-up' : 'chevron-down', 'i-sm muted') : ''}</span>${open ? `<span class="pf-note">${esc(s.note)}</span>` : ''}</div></td>
          <td class="table__cell">${status('service', s.status)}</td>
          <td class="table__cell table__cell--num table__cell--hide-sm hide-sm mono pf-nowrap">${esc(s.latency)}</td>
          <td class="table__cell table__cell--num num" data-label="Uptime">${s.uptime.toFixed(2).replace(/\.00$/, '')}%</td></tr>`;
      }),
    });
    const models = () => list(D.pModels.map(m => item({
      lead: itemIcon(MODEL_ICON[m.id] || 'cpu', m.status === 'operational' ? '' : 'warning', 'sm'),
      title: esc(m.name),
      desc: `${esc(m.desc)}<span class="pf-setting">Configured via <code class="mono">${esc(m.setting)}</code></span>`,
      trail: `<span class="pf-model-trail">${status('service', m.status)}<span class="t-xs muted num">${esc(m.p50)}</span></span>`,
    })), 'pf-models');
    const incidents = () => `<section class="section" aria-label="Recent incidents">${disclosure({ path: 'pfh.inc', icon: 'check-circle', title: 'Recent incidents', summary: esc(`${plural(INCIDENTS.length, 'incident')} resolved in the last 30 days`),
      body: list(INCIDENTS.map(x => item({ lead: itemIcon('check-circle', 'success', 'sm'), title: esc(x.title), desc: esc(x.impact), meta: `${esc(fmtDate(x.at))} · ${esc(fmtDur(x.dur))}` }))) })}</section>`;
    return `<div class="page">${pageHeader({ title: 'System health', desc: `Updated ${esc(rel(u.updated).toLowerCase())}`, extra: PREVIEW, actions: btn('Refresh', { icon: 'refresh', act: 'pf-health-refresh', loading: u.busy, disabled: u.busy }) })}
      ${gate({
        ok: () => `<div class="pf-banner">${banner()}</div>${section('Services', services())}${section('AI capabilities', models(), { desc: 'Models are set in the deployment configuration and change on restart.' })}${incidents()}`,
        loading: () => skelRows(7),
        empty: () => emptyState({ icon: 'server', title: 'No services reporting', desc: 'Status appears once the deployment reports in.', boxed: true }),
      })}</div>`;
  };
  A['pf-svc-toggle'] = el => { const u = ui('pfh'); const s = D.pServices.find(x => x.id === el.dataset.id); if (!s) return; u.open[s.id] = !(u.open[s.id] ?? s.status !== 'operational'); refresh(); };
  A['pf-health-refresh'] = async () => {
    const u = ui('pfh'); if (u.busy) return;
    u.busy = true; refresh(); await sleep(800);
    u.busy = false; u.updated = Date.now();
    if (S.cur.r.page === 'pHealth') refresh();
    toast('Status refreshed');
  };
})();

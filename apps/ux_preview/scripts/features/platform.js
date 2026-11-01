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

  /* ── Platform audit log (separate from the workspace activity log) ── */
  D.pAudit ??= (() => {
    const PLAT = [
      [26 * HOUR, null, 'Kenji Mori', 'Sign-in blocked — not a platform admin', 'Sign-in', 'Platform console', 'failure'],
      [2 * DAY + 3 * HOUR, 'ws-litware', 'Jordan Blake', 'Created workspace', 'Workspaces', 'Litware Labs', 'success'],
      [5 * DAY, null, 'Alex Rivera', 'Made platform admin', 'People & access', 'Jordan Blake', 'success'],
      [12 * DAY, null, 'Jordan Blake', 'Suspended account', 'People & access', 'Nora Quinn', 'success'],
      [18 * DAY, 'ws-adatum', 'Alex Rivera', 'Suspended workspace', 'Workspaces', 'Adatum Health', 'success'],
      [33 * DAY, null, 'Alex Rivera', 'Turned on connector', 'Connectors', 'Confluence', 'success'],
      [42 * DAY, null, 'Alex Rivera', 'Updated connector settings', 'Connectors', 'Google Drive', 'success'],
    ];
    const KB = ['Policies', 'Customer contracts', 'Product docs', 'Runbooks', 'Sales playbooks', 'Clinical guidelines', 'Branch procedures', 'Supplier specs'];
    const T = [
      ['Sign-in', 'Signed in', () => 'Google', 'success', 0],
      ['Knowledge', 'Uploaded 3 documents', k => k, 'success', 0],
      ['Sources', 'Sync failed', () => 'Shared drive — Operations', 'failure', 'sys'],
      ['People & access', 'Added member', (k, p) => p, 'success', 0],
      ['Sources', 'Connected a source', () => 'Google Drive — Shared drives', 'success', 0],
      ['People & access', 'Changed role to Workspace admin', (k, p) => p, 'success', 0],
      ['Sign-in', 'Sign-in blocked — wrong password', () => 'Password', 'failure', 1],
      ['Knowledge', 'Created knowledge base', k => k, 'success', 0],
      ['Settings', 'Updated assistant instructions', () => 'Assistant setup', 'success', 0],
      ['People & access', 'Approved access request', (k, p) => `${p} → ${k}`, 'success', 0],
      ['Sources', 'Paused a source', () => 'Confluence — Team space', 'success', 1],
      ['Knowledge', 'Archived document', () => 'Pricing 2025.pdf', 'success', 1],
    ];
    const live = D.pWorkspaces.filter(w => w.status !== 'new');
    const out = PLAT.map(([t, ws, actor, action, area, target, outcome], i) => ({ id: 'pev-p' + i, at: ago(t), ws, actor, action, area, target, outcome, ip: `10.0.${8 + i}.${21 + i * 9}`, device: DEVICES[i % DEVICES.length] }));
    for (let i = 0; i < 34; i++) {
      const t = (i + 1) * (i + 1) * 55 * MIN;
      let w = live[(i * 5 + 2) % live.length]; if (w.id === 'ws-adatum' && t < 18 * DAY) w = wsById('ws-woodgrove');
      const h = hashOf(w.id); const [area, action, tgt, outcome, who] = T[i % T.length];
      const people = [w.owner, NAMES[(h + i) % NAMES.length], NAMES[(h + i * 7 + 3) % NAMES.length]];
      const actor = who === 'sys' ? 'BoMesh' : people[who ? 1 + (i % 2) : i % 3 === 2 ? 1 : 0];
      out.push({ id: 'pev-' + i, at: ago(t), ws: w.id, actor, action, area, target: tgt(KB[(h + i) % KB.length], people[2]), outcome, ip: `10.${20 + (h % 200)}.${(i * 7) % 250}.${(i * 13 + 40) % 250}`, device: DEVICES[(h + i) % DEVICES.length] });
    }
    return out.sort((a, b) => b.at - a.at);
  })();
  DATA_KEYS.push('pAudit');

  /* ═══════════════════════ Workspaces ═══════════════════════ */
  const WS_STATUS = [['active', 'Active'], ['new', 'Setting up'], ['suspended', 'Suspended'], ['archiving', 'Archive requested']];
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

  P.pWorkspaces = () => {
    settleNew();
    const u = ui('pws', { q: '', status: '' });
    const all = D.pWorkspaces;
    const sum = k => all.reduce((a, w) => a + (w[k] || 0), 0);
    const kpis = `<div class="grid cols-4 pf-kpis">${[
      statCard({ icon: 'building', label: 'Active workspaces', value: fmtNum(all.filter(w => w.status === 'active').length), meta: `of ${fmtNum(all.length)}` }),
      statCard({ icon: 'users', label: 'Members', value: fmtNum(sum('members')) }),
      statCard({ icon: 'files', label: 'Documents', value: fmtCompact(sum('docs')) }),
      statCard({ icon: 'message', label: 'Questions, 30 days', value: fmtCompact(sum('questions30')) }),
    ].join('')}</div>`;
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'pws', placeholder: 'Search workspaces' })}${filterButton('Status', 'pws', 'status', WS_STATUS)}${filterButton('Template', 'pws', 'template', TEMPLATE_OPTS())}${clearFilters('pws', ['status', 'template'])}</div>`;
    const tbl = () => {
      let rows = all.filter(w => matchesQ('pws', w.name, w.code, w.owner) && (!u.status || w.status === u.status) && (!u.template || wsTemplateId(w) === u.template));
      if (!rows.length) return noMatches('pws', ['status', 'template'], 'workspaces');
      rows = u.sort ? applySort(rows, 'pws', { name: w => w.name.toLowerCase() }) : [...rows].sort((a, b) => b.created - a.created);
      return table({
        label: 'Workspaces',
        head: sortHead('Workspace', 'name', 'pws') + th('Template') + th('Owner', 'hide-md') + sortHead('Members', 'members', 'pws', 'table__column--num') + sortHead('Documents', 'docs', 'pws', 'table__column--num hide-md') + sortHead('Questions, 30 days', 'questions30', 'pws', 'table__column--num') + th('Status'),
        rows: rows.map(w => `<tr class="${cx('table__row', w.id === newId && 'table__row--new')}" data-act="pws-open" data-id="${w.id}" tabindex="0">
          <td class="table__cell table__cell--primary"><div class="row gap-12">${wsMark(w, 32)}<div class="stack"><span class="cell-title truncate">${esc(w.name)}</span><span class="cell-sub mono truncate">${esc(wsUrl(w))}</span></div></div></td>
          <td class="table__cell" data-label="Template">${tplChip(w)}</td>
          <td class="table__cell table__cell--hide-sm hide-md"><span class="row gap-8">${avatar(w.owner, 'xs')}<span class="truncate">${esc(w.owner)}</span></span></td>
          <td class="table__cell table__cell--num num" data-label="Members">${fmtNum(w.members)}</td>
          <td class="table__cell table__cell--num num hide-md">${fmtNum(w.docs)}</td>
          <td class="table__cell table__cell--num num" data-label="Questions">${fmtNum(w.questions30)}</td>
          <td class="table__cell">${status('ws', w.status)}</td></tr>`),
        foot: `<div class="table-foot"><span class="num">${plural(rows.length, 'workspace')}</span></div>`,
      });
    };
    return `<div class="page">${pageHeader({ title: 'Workspaces', extra: PREVIEW, actions: btn('Create workspace', { v: 'primary', icon: 'plus', act: 'pws-create' }) })}
      ${gate({ ok: () => kpis + toolbar + tbl(), loading: () => skelRows(7), empty: () => emptyState({ icon: 'building', title: 'No workspaces yet', desc: 'Create one for each customer or team. Its first admin sets up the rest.', actions: btn('Create workspace', { icon: 'plus', act: 'pws-create' }), boxed: true }) })}</div>`;
  };
  AFTER.pWorkspaces = () => { if (newId) $('tr.table__row--new')?.scrollIntoView({ block: 'nearest' }); };

  function openWs(w) {
    if (!isMemberWs(w)) { toast(`You’re not a member of ${w.name}`, { tone: 'accent' }); return; }
    enterWorkspace(w.id, { quiet: true }); go('/overview'); toast(`Switched to ${w.name}`, { tone: 'accent' });
  }
  function suspendWs(w) {
    if (w.status === 'suspended') {
      confirmAction({ title: `Reactivate ${w.name}?`, body: 'Members can sign in again right away.', confirm: 'Reactivate',
        onConfirm: () => { w.status = 'active'; log('Reactivated workspace', 'Workspaces', w.name, w.id); refresh(); toast(`Reactivated ${w.name}`); } });
      return;
    }
    confirmAction({ title: `Suspend ${w.name}?`, body: `Members can’t sign in while it’s suspended. Nothing is deleted.${isMemberWs(w) ? ' You’ll lose access too.' : ''}`, confirm: 'Suspend workspace', danger: true,
      onConfirm: () => { w.status = 'suspended'; log('Suspended workspace', 'Workspaces', w.name, w.id); refresh(); toast(`Suspended ${w.name}`); } });
  }
  A['pws-open'] = el => { if (wsById(el.dataset.id)) openDrawer('pf-ws', { id: el.dataset.id }); };
  A['pf-ws-enter'] = el => { const w = wsById(el.dataset.id); if (w) openWs(w); };
  A['pf-ws-copy'] = el => { const w = wsById(el.dataset.id); if (w) copyText('https://' + wsUrl(w), 'Copied workspace URL'); };
  A['pf-ws-suspend'] = el => { const w = wsById(el.dataset.id); if (w) suspendWs(w); };

  DR['pf-ws'] = ({ id }) => {
    const w = wsById(id);
    if (!w) return { title: 'Workspace not found', body: emptyState({ icon: 'building', title: 'This workspace no longer exists', compact: true }) };
    const h = hashOf(w.id), off = w.status === 'suspended';
    const vals = off ? Array(14).fill(0) : series(h, 14, Math.round((w.questions30 * 14) / 30));
    const labels = dayLabels(14), total = vals.reduce((a, b) => a + b, 0);
    const admins = wsAdmins(w);
    const archive = w.status === 'archiving' && w.archiveRequest ? `<div class="drawer__section">${alertBox('warning', 'Archive requested', `${esc(actorName(w.archiveRequest.actor))} asked to archive this workspace ${esc(rel(w.archiveRequest.at).toLowerCase())}.`)}</div>` : '';
    return {
      title: w.name, lead: wsMark(w, 40), desc: `<span class="mono">${esc(wsUrl(w))}</span>`,
      body: `${archive}<div class="drawer__section">${kv([
        ['Status', status('ws', w.status)],
        ['Template', tplChip(w)],
        ['Owner', `<span class="row gap-8">${avatar(w.owner, 'xs')}${esc(w.owner)}</span>`],
        ['Created', esc(fmtDate(w.created))],
        ['Members', `<span class="num">${fmtNum(w.members)}</span>`],
        ['Documents', `<span class="num">${fmtNum(w.docs)}</span>`],
      ])}</div>
        <div class="drawer__section"><div class="pf-sec-head"><h3 class="drawer__section-title">Questions, last 14 days</h3><span class="t-xs muted num">${fmtNum(total)}</span></div>
          ${off ? '<p class="t-sm muted">No questions while suspended.</p>' : sparkline(vals, { height: 48 }) + axis(labels[0], 'Today')}</div>
        <div class="drawer__section"><h3 class="drawer__section-title">Admins</h3>${list(admins.map(a => item({ lead: avatar(a.name, 'sm'), title: esc(a.name), desc: esc(a.email), trail: a.owner ? chip('Owner', { size: 'sm' }) : '' })))}</div>`,
      footStart: off ? btn('Reactivate', { icon: 'play', act: 'pf-ws-suspend', data: { id: w.id } }) : btn('Suspend', { v: 'danger-soft', icon: 'pause', act: 'pf-ws-suspend', data: { id: w.id } }),
      foot: btn('Copy URL', { icon: 'copy', act: 'pf-ws-copy', data: { id: w.id } }) + btn('Open workspace', { v: 'primary', iconRight: 'arrow-right', act: 'pf-ws-enter', data: { id: w.id } }),
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
    const emailDesc = !EMAIL_RE.test(email) ? 'They become the first admin and invite everyone else.'
      : acct ? `<span class="row gap-6">${avatar(acct.name, 'xs')}${esc(acct.name)} already has an account.</span>` : 'We’ll email them an invite to create an account.';
    return {
      title: 'Create workspace', size: 'md', guard: f.busy,
      body: `${field({ id: 'pf-new-name', label: 'Name', required: true, error: v.name, control: input({ id: 'pf-new-name', bind: 'pfNew.name', value: f.name, placeholder: 'Litware Labs', autofocus: true, attrs: 'data-live', invalid: !!v.name, onEnter: 'pf-ws-new-submit' }) })}
        ${field({ id: 'pf-new-code', label: 'Web address', required: true, error: v.code, desc: f.codeEdited ? 'People sign in at this address.' : 'Filled in from the name. You can change it.',
          control: `<div class="pf-prefix"><span class="pf-prefix__text" aria-hidden="true">bomesh.app/</span>${input({ id: 'pf-new-code', bind: 'pfNew.code', value: f.code, placeholder: 'litware', cls: 'mono', attrs: 'data-input="pf-ws-code" spellcheck="false"', invalid: !!v.code, onEnter: 'pf-ws-new-submit' })}</div>` })}
        ${field({ id: 'pf-new-email', label: 'First admin email', required: true, error: v.email, desc: emailDesc, control: input({ id: 'pf-new-email', bind: 'pfNew.email', value: f.email, placeholder: 'name@company.com', attrs: 'data-live inputmode="email" spellcheck="false" autocapitalize="off"', invalid: !!v.email, onEnter: 'pf-ws-new-submit' }) })}
        <div class="field mt-16"><span class="label">Template</span><div class="pf-tpl">${choiceGroup({ name: 'pf-new-tpl', value: f.template, act: 'pf-ws-tpl', cols: 2, options: Object.entries(TEMPLATES).map(([id, t]) => [id, t.label, esc(t.desc)]) })}</div><div class="description mt-4">Decides the modules it starts with. The admin can change it in Settings.</div></div>`,
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + btn('Create workspace', { v: 'primary', act: 'pf-ws-new-submit', loading: f.busy, disabled: f.busy }),
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
  function toggleAdmin(u) {
    if (isSelf(u)) return;
    if (u.platformAdmin) confirmAction({ title: `Remove ${u.name} as platform admin?`, body: 'They lose access to the platform console. Their workspace roles stay the same.', confirm: 'Remove platform admin', danger: true,
      onConfirm: () => { u.platformAdmin = false; log('Removed platform admin', 'People & access', u.name); refresh(); toast(`${u.name} is no longer a platform admin`); } });
    else confirmAction({ title: `Make ${u.name} a platform admin?`, body: 'They’ll manage every workspace, user and connector on this deployment.', confirm: 'Make platform admin',
      onConfirm: () => { u.platformAdmin = true; log('Made platform admin', 'People & access', u.name); refresh(); toast(`${u.name} is now a platform admin`); } });
  }
  function suspendUser(u) {
    if (isSelf(u)) return;
    const first = esc(u.name.split(' ')[0]);
    if (u.status === 'suspended') confirmAction({ title: `Reactivate ${u.name}?`, body: `${first} can sign in to their workspaces again.`, confirm: 'Reactivate account',
      onConfirm: () => { u.status = 'active'; log('Reactivated account', 'People & access', u.name); refresh(); toast(`Reactivated ${u.name}`); } });
    else confirmAction({ title: `Suspend ${u.name}?`, body: `${first} can’t sign in to any workspace until you reactivate the account. Nothing is deleted.`, confirm: 'Suspend account', danger: true,
      onConfirm: () => { u.status = 'suspended'; log('Suspended account', 'People & access', u.name); refresh(); toast(`Suspended ${u.name}`); } });
  }
  const lastActive = u => u.last ? rel(u.last) : 'Never';

  P.pUsers = () => {
    const f = ui('pfu', { q: '', role: '', status: '' });
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'pfu', placeholder: 'Search by name or email' })}${filterButton('Platform role', 'pfu', 'role', [['admin', 'Platform admin'], ['standard', 'Standard']])}${filterButton('Status', 'pfu', 'status', [['active', 'Active'], ['invited', 'Invited'], ['suspended', 'Suspended']])}${clearFilters('pfu', ['role', 'status'])}</div>`;
    const tbl = () => {
      let rows = D.pUsers.filter(u => matchesQ('pfu', u.name, u.email) && (!f.role || (f.role === 'admin') === u.platformAdmin) && (!f.status || u.status === f.status));
      if (!rows.length) return noMatches('pfu', ['role', 'status'], 'people');
      rows = f.sort ? applySort(rows, 'pfu', { name: u => u.name.toLowerCase(), last: u => u.last || 0 }) : [...rows].sort((a, b) => a.name.localeCompare(b.name));
      return table({
        label: 'Users',
        head: sortHead('Person', 'name', 'pfu') + sortHead('Workspaces', 'ws', 'pfu', 'table__column--num') + th('Platform role') + sortHead('Last active', 'last', 'pfu', 'hide-md') + th('Status'),
        rows: rows.map(u => `<tr class="table__row" data-act="pu-open" data-id="${u.id}" tabindex="0">
          <td class="table__cell table__cell--primary"><div class="row gap-12">${avatar(u.name)}<div class="stack"><span class="cell-title truncate">${esc(u.name)}${isSelf(u) ? ' <span class="muted t-sm">(you)</span>' : ''}</span><span class="cell-sub truncate">${esc(u.email)}</span></div></div></td>
          <td class="table__cell table__cell--num num" data-label="Workspaces">${fmtNum(u.ws)}</td>
          <td class="table__cell">${u.platformAdmin ? chip('Platform admin', { tone: 'accent', size: 'sm', icon: 'shield' }) : '<span class="muted hide-sm">Standard</span>'}</td>
          <td class="table__cell hide-md muted">${esc(lastActive(u))}</td>
          <td class="table__cell">${status('member', u.status)}</td></tr>`),
        foot: `<div class="table-foot"><span class="num">${plural(rows.length, 'account')}</span></div>`,
      });
    };
    return `<div class="page">${pageHeader({ title: 'Users', extra: PREVIEW })}
      ${gate({ ok: () => toolbar + tbl(), loading: () => skelRows(8), empty: () => emptyState({ icon: 'users', title: 'No accounts yet', desc: 'People appear here once they sign up or are invited to a workspace.', boxed: true }) })}</div>`;
  };
  A['pu-open'] = el => { if (userById(el.dataset.id)) openDrawer('pf-user', { id: el.dataset.id }); };
  A['pf-user-admin'] = el => { const u = userById(el.dataset.id); if (u) toggleAdmin(u); };
  A['pf-user-suspend'] = el => { const u = userById(el.dataset.id); if (u) suspendUser(u); };
  DR['pf-user'] = ({ id }) => {
    const u = userById(id);
    if (!u) return { title: 'Account not found', body: emptyState({ icon: 'user', title: 'This account no longer exists', compact: true }) };
    const self = isSelf(u), mships = userWs(u);
    return {
      title: u.name + (self ? ' (you)' : ''), desc: esc(u.email), lead: avatar(u.name, 'lg'),
      body: `<div class="drawer__section">${kv([['Status', status('member', u.status)], ['Last active', esc(lastActive(u))]])}</div>
        <div class="drawer__section"><div class="pf-sec-head"><h3 class="drawer__section-title">Workspaces</h3><span class="t-xs muted num">${fmtNum(mships.length)}</span></div>
          ${mships.length ? list(mships.map(({ w, role }) => item({ lead: wsMark(w, 28), title: esc(w.name), desc: `<span class="mono">${esc(wsUrl(w))}</span>`, meta: esc(role), trail: ic('chevron-right', 'i-sm muted'), act: 'pws-open', data: { id: w.id } })))
            : emptyState({ icon: 'building', title: 'Not in any workspace', desc: 'Platform admins can manage workspaces without joining them.', compact: true, boxed: true })}</div>
        <div class="drawer__section">${switchRow({ title: 'Platform admin', desc: self ? 'You can’t change your own platform role.' : 'Can manage every workspace, user and connector.', on: u.platformAdmin, act: 'pf-user-admin', data: { id: u.id }, disabled: self })}</div>`,
      footStart: self ? '' : u.status === 'suspended' ? btn('Reactivate account', { icon: 'play', act: 'pf-user-suspend', data: { id: u.id } }) : btn('Suspend account', { v: 'danger-soft', icon: 'pause', act: 'pf-user-suspend', data: { id: u.id } }),
      foot: btn('Done', { act: 'close-drawer' }),
    };
  };

  /* ═══════════════════════ Connectors ═══════════════════════ */
  const CON_CFG = {
    gdrive: { updated: ago(42 * DAY), by: 'Alex Rivera' },
    confluence: { updated: ago(88 * DAY), by: 'Jordan Blake' },
  };
  P.pConnectors = () => {
    const conCard = c => {
      const meta = c.status === 'unavailable' ? linkBtn(`Requested by ${plural(c.requests || 0, 'workspace')}`, { act: 'pf-con-demand', data: { key: c.key } })
        : `<span class="t-sm muted">${c.status === 'disabled' ? 'Workspaces can’t connect it' : `Used by ${plural(c.workspaces || 0, 'workspace')}`}</span>`;
      const action = c.status === 'enabled' ? btn('Configure', { size: 'sm', act: 'pf-con-open', data: { key: c.key } })
        : c.status === 'disabled' ? btn('Enable', { size: 'sm', v: 'secondary', act: 'pf-con-enable', data: { key: c.key } }) : '';
      return `<div class="card pf-con"><div class="row gap-12">${appIcon(c.key, 'lg')}<div class="stack gap-4 grow"><span class="card__title truncate">${esc(c.name)}</span><span>${status('connector', c.status)}</span></div></div><div class="pf-con__foot">${meta}${action}</div></div>`;
    };
    return `<div class="page">${pageHeader({ title: 'Connectors', desc: 'Apps that workspaces can connect.', extra: PREVIEW })}
      ${gate({ ok: () => `<div class="grid cols-3">${D.pConnectors.map(conCard).join('')}</div>`, loading: () => skelCards(6), empty: () => emptyState({ icon: 'plug', title: 'No connectors installed', desc: 'Connectors appear once they’re part of this deployment.', boxed: true }) })}</div>`;
  };
  function setConnector(c, on, { undo = true } = {}) {
    const before = c.status;
    c.status = on ? 'enabled' : 'disabled';
    log(on ? 'Turned on connector' : 'Turned off connector', 'Connectors', c.name);
    refresh();
    toast(on ? `${c.name} is available to workspaces` : `Turned off ${c.name}`, undo ? { action: { label: 'Undo', run: () => { c.status = before; log(on ? 'Turned off connector' : 'Turned on connector', 'Connectors', c.name); refresh(); } } } : {});
  }
  A['pf-con-open'] = el => { if (conByKey(el.dataset.key)) openDrawer('pf-con', { key: el.dataset.key }); };
  A['pf-con-enable'] = el => { const c = conByKey(el.dataset.key); if (c) setConnector(c, true); };
  A['pf-con-toggle'] = el => {
    const c = conByKey(el.dataset.key); if (!c) return;
    if (c.status !== 'enabled') { setConnector(c, true); return; }
    confirmAction({ title: `Turn off ${c.name}?`, body: `${plural(c.workspaces || 0, 'workspace')} will stop syncing from it. Their documents stay searchable.`, confirm: 'Turn off', danger: true,
      onConfirm: () => setConnector(c, false, { undo: false }) });
  };
  DR['pf-con'] = ({ key }) => {
    const c = conByKey(key);
    if (!c) return { title: 'Connector not found', body: '' };
    const cfg = CON_CFG[key], on = c.status === 'enabled';
    return {
      title: c.name, lead: appIcon(key, 'lg'), desc: esc(c.desc),
      body: `<div class="drawer__section">${kv([
        ['Status', status('connector', c.status)],
        ['Sign-in method', esc(c.auth || '—')],
        ['Used by', plural(c.workspaces || 0, 'workspace')],
        cfg && ['Last changed', `${esc(cfg.by)} · ${esc(fmtDate(cfg.updated))}`],
      ])}</div>
        <div class="drawer__section">${switchRow({ title: 'Available to workspaces', desc: on ? 'Workspace admins can connect it as a source.' : 'Workspaces can’t connect it. Existing documents stay searchable.', on, act: 'pf-con-toggle', data: { key } })}</div>`,
      foot: btn('Done', { act: 'close-drawer' }),
    };
  };
  A['pf-con-demand'] = el => openModal('pf-con-demand', { key: el.dataset.key });
  M['pf-con-demand'] = ({ key }) => {
    const c = conByKey(key);
    const pool = D.pWorkspaces.filter(w => NOW - w.created > 7 * DAY);
    const reqs = [...pool].sort((a, b) => hashOf(key + a.id) - hashOf(key + b.id)).slice(0, c.requests || 0)
      .map(w => ({ w, at: Math.max(w.created + DAY, ago((2 + (hashOf(key + w.code) % 70)) * DAY)) })).sort((a, b) => b.at - a.at);
    return {
      title: `${c.name} requests`, desc: `${plural(reqs.length, 'workspace')} asked for this connector.`,
      body: reqs.length ? list(reqs.map(({ w, at }) => item({ lead: wsMark(w, 28), title: esc(w.name), desc: `Requested by ${esc(w.owner)}`, meta: esc(fmtDate(at)) })))
        : emptyState({ icon: 'plug', title: 'No requests yet', compact: true }),
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
  function delta(v, n, k) {
    const p = Math.round(v * (0.84 + 0.12 * r01(n, k))); const d = p ? Math.round(((v - p) / p) * 100) : 0;
    return `<span class="${d >= 0 ? 'text-success' : 'text-danger'}">${d >= 0 ? '+' : '−'}${Math.abs(d)}%</span> vs previous ${n} days`;
  }
  P.pUsage = () => {
    const u = ui('pfus', { win: '30' }); const n = +u.win;
    const header = pageHeader({ title: 'Usage', extra: PREVIEW, actions: seg({ value: u.win, options: WINDOWS, act: 'pf-usage-win', label: 'Time range' }) + btn('Export CSV', { icon: 'download', act: 'pf-usage-export' }) });
    const ok = () => {
      const rows = usageRows(n);
      const tot = k => rows.reduce((a, r) => a + r[k], 0);
      const Q = tot('questions'), AP = tot('active'), DP = tot('processed');
      const qs = series(n * 13, n, Q), labels = dayLabels(n);
      const stat = (icon, label, v, k, seed) => statCard({ icon, label, value: fmtNum(v), meta: delta(v, n, k), extra: `<div class="pf-spark">${sparkline(series(seed, n, Math.max(v, n)), { height: 32 })}</div>` });
      const sorted = u.sort ? applySort(rows, 'pfus', { name: r => r.w.name.toLowerCase(), questions: r => r.questions, active: r => r.active, processed: r => r.processed }) : [...rows].sort((a, b) => b.questions - a.questions);
      return `<div class="grid cols-3">${stat('message', 'Questions', Q, 1, n * 13)}${stat('users', 'Active people', AP, 2, n * 17 + 3)}${stat('file-text', 'Documents processed', DP, 3, n * 29 + 5)}</div>
        <div class="mt-16">${card(`${bars(qs, { height: 140, labels })}${axis(labels[0], labels[n - 1])}`, { title: 'Questions per day', actions: `<span class="t-sm muted num">${fmtNum(Q)} total</span>` })}</div>
        ${section('By workspace', table({
          label: 'Usage by workspace',
          head: sortHead('Workspace', 'name', 'pfus') + sortHead('Questions', 'questions', 'pfus', 'table__column--num') + sortHead('Active people', 'active', 'pfus', 'table__column--num') + sortHead('Documents processed', 'processed', 'pfus', 'table__column--num hide-md'),
          rows: sorted.map(r => { const share = Q ? (r.questions / Q) * 100 : 0; return `<tr class="table__row" data-act="pws-open" data-id="${r.w.id}" tabindex="0">
            <td class="table__cell table__cell--primary"><div class="row gap-8">${wsMark(r.w, 24)}<span class="cell-title truncate">${esc(r.w.name)}</span></div></td>
            <td class="table__cell table__cell--num"><div class="pf-share" data-tip="${share.toFixed(1)}% of all questions"><span class="num">${fmtNum(r.questions)}</span>${progress(share, '', 'Share of all questions')}</div></td>
            <td class="table__cell table__cell--num num" data-label="Active people">${fmtNum(r.active)}</td>
            <td class="table__cell table__cell--num num hide-md">${fmtNum(r.processed)}</td></tr>`; }),
        }))}`;
    };
    return `<div class="page">${header}${gate({ ok, loading: () => skelCards(3) + `<div class="mt-16">${skelRows(6)}</div>`, empty: () => emptyState({ icon: 'chart', title: 'No usage yet', desc: 'Usage appears once people start asking questions.', boxed: true }) })}</div>`;
  };
  A['pf-usage-win'] = el => { ui('pfus').win = el.dataset.value; refresh(); };
  A['pf-usage-export'] = () => {
    const n = +ui('pfus', { win: '30' }).win, rows = usageRows(n), Q = rows.reduce((a, r) => a + r.questions, 0);
    saveCsv(`platform-usage-${n}d.csv`, [['Workspace', 'Web address', 'Questions', 'Share of questions (%)', 'Active people', 'Documents processed'],
      ...rows.sort((a, b) => b.questions - a.questions).map(r => [r.w.name, wsUrl(r.w), r.questions, Q ? ((r.questions / Q) * 100).toFixed(1) : '0', r.active, r.processed])],
    `Saved usage for the last ${n} days`);
  };

  /* ═══════════════════════ Audit log ═══════════════════════ */
  const AUD_WIN = [['1', '24 hours'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
  const audUi = () => ui('pfa', { q: '', ws: '', outcome: '', win: '30' });
  function auditRows() {
    const f = audUi();
    return D.pAudit.filter(e => Date.now() - e.at <= +f.win * DAY && (!f.ws || (f.ws === 'platform' ? !e.ws : e.ws === f.ws)) && (!f.outcome || e.outcome === f.outcome)
      && matchesQ('pfa', e.actor, e.action, e.target, e.area, wsById(e.ws)?.name || 'Platform'));
  }
  P.pAudit = () => {
    const f = audUi();
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'pfa', placeholder: 'Search events' })}${filterButton('Workspace', 'pfa', 'ws', [['platform', 'Platform'], ...D.pWorkspaces.map(w => [w.id, w.name])])}${filterButton('Outcome', 'pfa', 'outcome', [['success', 'Succeeded'], ['failure', 'Failed']])}${clearFilters('pfa', ['ws', 'outcome'])}<div class="toolbar__end">${seg({ value: f.win, options: AUD_WIN, act: 'pf-audit-win', label: 'Time window' })}</div></div>`;
    const tbl = () => {
      const rows = auditRows();
      if (!rows.length) return noMatches('pfa', ['ws', 'outcome'], 'events');
      const page = paginate(rows, 'pfa', 15);
      return table({
        label: 'Audit events',
        head: th('When') + th('Person', 'hide-md') + th('Action') + th('Workspace', 'hide-sm') + th('Outcome'),
        rows: page.map(e => `<tr class="table__row" data-act="pf-ev-open" data-id="${e.id}" tabindex="0">
          <td class="table__cell muted num pf-nowrap" data-tip="${esc(fmtDateTime(e.at))}">${esc(rel(e.at))}</td>
          <td class="table__cell hide-md"><span class="row gap-8">${avatar(e.actor, 'xs')}<span class="truncate">${esc(e.actor)}</span></span></td>
          <td class="table__cell table__cell--primary"><div class="stack"><span class="cell-title">${esc(e.action)}</span><span class="cell-sub truncate pf-target">${esc(e.target)}</span></div></td>
          <td class="table__cell table__cell--hide-sm hide-sm">${wsCell(e.ws)}</td>
          <td class="table__cell">${status('outcome', e.outcome)}</td></tr>`),
        foot: pager(rows.length, 'pfa', 15),
      });
    };
    return `<div class="page">${pageHeader({ title: 'Audit log', extra: PREVIEW, actions: btn('Export CSV', { icon: 'download', act: 'pf-audit-export' }) })}
      ${gate({ ok: () => toolbar + tbl(), loading: () => skelRows(8), empty: () => emptyState({ icon: 'activity', title: 'No events recorded yet', desc: 'Changes to workspaces, people and connectors appear here.', boxed: true }) })}</div>`;
  };
  A['pf-audit-win'] = el => { const f = audUi(); f.win = el.dataset.value; f.page = 1; refresh(); };
  A['pf-ev-open'] = el => { if (D.pAudit.some(e => e.id === el.dataset.id)) openDrawer('pf-ev', { id: el.dataset.id }); };
  A['pf-audit-export'] = () => {
    const rows = auditRows();
    if (!rows.length) { toast('No events to export. Change the filters and try again.', { tone: 'danger' }); return; }
    saveCsv('platform-audit.csv', [['When', 'Workspace', 'Person', 'Area', 'Action', 'Target', 'Outcome', 'IP address', 'Device'],
      ...rows.map(e => [new Date(e.at).toISOString(), wsById(e.ws)?.name || 'Platform', e.actor, e.area, e.action, e.target, e.outcome, e.ip, e.device])],
    `Saved ${plural(rows.length, 'event')} to platform-audit.csv`);
  };
  DR['pf-ev'] = ({ id }) => {
    const e = D.pAudit.find(x => x.id === id);
    if (!e) return { title: 'Event not found', body: '' };
    const w = e.ws && wsById(e.ws);
    return {
      title: e.action, desc: esc(fmtDateTime(e.at)),
      body: kv([
        ['Outcome', status('outcome', e.outcome)],
        ['When', `${esc(fmtDateTime(e.at))} <span class="muted">· ${esc(rel(e.at))}</span>`],
        ['Workspace', wsCell(e.ws)],
        ['Person', `<span class="row gap-8">${avatar(e.actor, 'xs')}${esc(e.actor)}</span>`],
        ['Area', esc(e.area)],
        ['Target', esc(e.target)],
        ['IP address', `<span class="mono">${esc(e.ip)}</span>`],
        ['Device', esc(e.device)],
      ]),
      foot: w ? btn('View workspace', { act: 'pws-open', data: { id: w.id } }) : btn('Done', { act: 'close-drawer' }),
    };
  };

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
    const banner = () => {
      if (!bad.length) return alertBox('success', 'All systems operational', '');
      const [title, desc] = BANNER[bad[0].id] || [`${bad[0].name} is ${STATUS.service[bad[0].status]?.[1].toLowerCase() || 'affected'}`, esc(bad[0].note || '')];
      return alertBox(bad.some(s => s.status === 'down') ? 'danger' : 'warning', bad.length > 1 ? `${plural(bad.length, 'service')} need attention` : title, bad.length > 1 ? bad.map(s => esc(s.name)).join(', ') : desc);
    };
    const services = () => table({
      label: 'Services',
      head: th('Service') + th('Status') + th('Response', 'table__column--num hide-sm') + th('Uptime, 30 days', 'table__column--num'),
      rows: D.pServices.map(s => {
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
    const incidents = () => section('Recent incidents', u.inc ? list(INCIDENTS.map(x => item({
      lead: itemIcon('check-circle', 'success', 'sm'), title: esc(x.title), desc: esc(x.impact),
      meta: `${esc(fmtDate(x.at))} · ${esc(fmtDur(x.dur))}`,
    }))) : '', { desc: `${plural(INCIDENTS.length, 'incident')} resolved in the last 30 days`, actions: btn(u.inc ? 'Hide' : 'Show', { v: 'ghost', size: 'sm', iconRight: u.inc ? 'chevron-up' : 'chevron-down', act: 'pf-inc-toggle', aria: `aria-expanded="${u.inc}"` }) });
    return `<div class="page">${pageHeader({ title: 'System health', desc: `Updated ${esc(rel(u.updated).toLowerCase())}`, extra: PREVIEW, actions: btn('Refresh', { icon: 'refresh', act: 'pf-health-refresh', loading: u.busy, disabled: u.busy }) })}
      ${gate({
        ok: () => `<div class="pf-banner">${banner()}</div>${section('Services', services())}${section('AI capabilities', models(), { desc: 'Models are set in the deployment configuration and change on restart.' })}${incidents()}`,
        loading: () => skelRows(7),
        empty: () => emptyState({ icon: 'server', title: 'No services reporting', desc: 'Status appears once the deployment reports in.', boxed: true }),
      })}</div>`;
  };
  A['pf-svc-toggle'] = el => { const u = ui('pfh'); const s = D.pServices.find(x => x.id === el.dataset.id); if (!s) return; u.open[s.id] = !(u.open[s.id] ?? s.status !== 'operational'); refresh(); };
  A['pf-inc-toggle'] = () => { const u = ui('pfh'); u.inc = !u.inc; refresh(); };
  A['pf-health-refresh'] = async () => {
    const u = ui('pfh'); if (u.busy) return;
    u.busy = true; refresh(); await sleep(800);
    u.busy = false; u.updated = Date.now();
    if (S.cur.r.page === 'pHealth') refresh();
    toast('Status refreshed');
  };
})();

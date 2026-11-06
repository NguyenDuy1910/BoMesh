/* Workspace settings (/settings?tab=general|setup) — name and web address,
   workspace ID, workspace setup (template, modules, space types, AI workflows)
   and the archive request (a design proposal: backend contract pending).
   Archiving is a request: a platform admin archives the workspace or declines (platform.js);
   the decision shows here (ws.archiveDecision). */
(() => {
  'use strict';

  const CODE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/;
  const MAX_NAME = 60;
  STATUS.ws.archiving ??= ['warning', 'Archive requested'];

  const audit = (action, target) => D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Settings', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  /** Platform-level events also go to the platform audit log (the operator acts on them). */
  const platformLog = (action, ws) => D.pAudit?.unshift({ id: uid('pev'), at: Date.now(), ws: ws.id, actor: me().name, action, area: 'Workspaces', target: ws.name, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });

  function form() {
    const ws = curWs(); let f = S.ui.setWs;
    if (!f || f.wsId !== ws.id) f = S.ui.setWs = { wsId: ws.id, name: ws.name, code: ws.code, touched: {}, tried: false, busy: false };
    return f;
  }
  function errors(f, ws) {
    const e = {}, name = f.name.trim(), code = f.code.trim();
    if (!name) e.name = 'Enter a workspace name.';
    else if (name.length > MAX_NAME) e.name = `Keep the name to ${MAX_NAME} characters.`;
    if (!code) e.code = 'Enter a web address.';
    else if (code !== ws.code) {
      if (code.length < 3 || code.length > 32) e.code = 'Use 3–32 characters.';
      else if (!CODE_RE.test(code)) e.code = 'Use lowercase letters, numbers and hyphens. Start and end with a letter or number.';
      else if (D.pWorkspaces.some(w => w.id !== ws.id && w.code === code)) e.code = `bomesh.app/${code} is already taken.`;
    }
    return e;
  }
  const isDirty = (f, ws) => f.name.trim() !== ws.name || f.code.trim() !== ws.code;

  function generalHtml() {
    const ws = curWs(), f = form(), errs = errors(f, ws);
    const show = k => ((f.tried || f.touched[k]) && errs[k]) || '';
    const code = f.code.trim(), codeChanged = code !== ws.code && !errs.code;
    /* The counter appears only when the limit is close. */
    const nameField = field({
      id: 'set-name', error: show('name'), counter: show('name') || f.name.length < MAX_NAME - 10 ? '' : `<span class="counter">${f.name.length}/${MAX_NAME}</span>`,
      control: input({ id: 'set-name', bind: 'setWs.name', value: f.name, invalid: !!show('name'), onEnter: 'set-save', attrs: `aria-label="Workspace name" maxlength="${MAX_NAME}" data-input="set-touch" data-field="name"` }),
    });
    const codeField = field({
      id: 'set-code', error: show('code'),
      control: `<div class="set-url"><span class="set-url__prefix" aria-hidden="true">bomesh.app/</span>${input({ id: 'set-code', bind: 'setWs.code', value: f.code, invalid: !!show('code'), onEnter: 'set-save', attrs: 'aria-label="Web address after bomesh.app/" maxlength="32" spellcheck="false" data-input="set-touch" data-field="code"' })}</div>`,
    });
    const impact = codeChanged ? alertBox('warning', 'Old links will stop working', `<span class="mono">bomesh.app/${esc(ws.code)}</span> won’t redirect to <span class="mono">bomesh.app/${esc(code)}</span>. Share the new address after saving.`) : '';
    const bar = isDirty(f, ws) ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes</span>${btn('Discard', { v: 'ghost', act: 'set-discard', disabled: f.busy })}${btn('Save changes', { v: 'primary', act: 'set-save', loading: f.busy, disabled: f.busy })}</div>` : '';
    return `${archiveNotice(ws)}<div class="set-form">
      ${formSection('Workspace name', 'Shown in navigation, invitations and emails.', nameField)}
      ${formSection('Web address', 'Where people sign in to this workspace.', codeField + impact)}
    </div>${advancedHtml(ws)}${bar}`;
  }

  /** A pending archive request (or the platform's answer to one) is status, not an option: it stays above the form. */
  function archiveNotice(ws) {
    const req = ws.archiveRequest, dec = ws.archiveDecision;
    if (req) return `<div class="set-notice">${alertBox('warning', 'Archive requested', `${esc(req.actor)} requested this ${esc(rel(req.at).toLowerCase())}. A platform admin archives it within 24 hours or tells you why not.`, btn('Cancel request', { v: 'secondary', size: 'sm', act: 'set-archive-cancel' }))}</div>`;
    if (dec?.outcome === 'declined') return `<div class="set-notice">${alertBox('default', 'Archive request declined', `${esc(dec.by)} declined it ${esc(rel(dec.at).toLowerCase())}: “${esc(dec.reason)}”`, btn('Dismiss', { v: 'ghost', size: 'sm', act: 'set-decision-dismiss' }))}</div>`;
    if (ws.status === 'archived') return `<div class="set-notice">${alertBox('danger', 'Archived', `${esc(dec?.by || 'A platform admin')} archived ${esc(ws.name)} ${esc(rel(dec?.at || Date.now()).toLowerCase())}. Members can’t open it. A platform admin can restore it until ${esc(fmtDate((dec?.at || Date.now()) + 30 * DAY))}.`)}</div>`;
    return '';
  }
  /** Rare and administrative: the workspace ID and archiving, behind one disclosure. */
  function advancedHtml(ws) {
    const idField = field({
      id: 'set-id', label: 'Workspace ID', desc: 'For support requests and API calls.',
      control: `<div class="input-group input-group--suffix set-id">${input({ id: 'set-id', value: ws.id, cls: 'mono', attrs: 'readonly' })}<span class="input-group__suffix">${iconBtn('copy', 'Copy workspace ID', { size: 'sm', act: 'copy', data: { text: ws.id, msg: 'Workspace ID copied' } })}</span></div>`,
    });
    const preview = chip('Preview', { tone: 'default', variant: 'outline', size: 'sm', tip: 'Design proposal — backend contract pending' });
    const archive = ws.archiveRequest || ws.status === 'archived' ? '' : `<div class="set-archive">
      <p class="grow t-sm muted"><span>Ask a platform admin to archive ${esc(ws.name)}. It disappears for everyone; its data is kept and can be restored for 30 days.</span> ${preview}</p>
      ${btn('Request archive', { v: 'danger-soft', size: 'sm', icon: 'archive', act: 'set-archive' })}
    </div>`;
    return `<div class="set-advanced">${disclosure({ path: 'setAdv.open', icon: 'settings', title: 'Advanced', summary: archive ? 'Workspace ID, archive' : 'Workspace ID', body: idField + archive })}</div>`;
  }

  /* ── Workspace setup: one platform, adapted per domain ── */
  const SETUP_KEYS = ['template', 'modules', 'spaceTypes', 'workflows'];
  const snapSetup = ws => clone(Object.fromEntries(SETUP_KEYS.map(k => [k, ws[k] ?? null])));
  function restoreSetup(ws, snap) { SETUP_KEYS.forEach(k => { if (snap[k] == null) delete ws[k]; else ws[k] = snap[k]; }); }
  const sameSet = (a, b) => [...a].sort().join() === [...b].sort().join();
  const workflowIds = ws => ws.workflows || wsTemplate(ws).workflows;
  /** Apply a setup change now: navigation follows on refresh; Undo restores the previous setup. */
  function applySetup(change, action, target, msg) {
    const ws = curWs(), snap = snapSetup(ws);
    change(ws);
    audit(action, target); refresh();
    toast(msg, { action: { label: 'Undo', run: () => { restoreSetup(ws, snap); audit('Undid a workspace setup change', target); refresh(); toast('Change undone', { tone: 'accent' }); } } });
  }
  const optLabel = (title, desc, meta = '', icon = '') => `<span class="set-opt"><span class="set-opt__title">${icon ? ic(icon, 'i-sm set-opt__icon') : ''}${esc(title)}${meta ? `<span class="set-opt__meta">${esc(meta)}</span>` : ''}</span><span class="set-opt__desc">${esc(desc)}</span></span>`;
  /** Template marks: the same icons the domain uses elsewhere (office building, course cap). */
  const TEMPLATE_ICON = { enterprise: 'building', campus: 'graduation' };

  /** How far this workspace's setup is from its template, in plain counts. */
  function setupChanges(ws, tpl) {
    const diff = (a, b) => a.filter(x => !b.includes(x)).length + b.filter(x => !a.includes(x)).length;
    return Object.keys(ws.modules || {}).length + (ws.spaceTypes ? diff(ws.spaceTypes, tpl.spaceTypes) : 0) + (ws.workflows ? diff(ws.workflows, tpl.workflows) : 0);
  }
  function setupHtml() {
    const ws = curWs(), tpl = wsTemplate(ws), tplId = wsTemplateId(ws);
    const changes = setupChanges(ws, tpl);
    /* Switching template is rare and resets modules: it sits last, behind a disclosure showing the current one.
       "Changed from the template" is said once, here, with its Reset. */
    const template = disclosure({
      path: 'setTpl.open', icon: TEMPLATE_ICON[tplId] || 'layers', title: 'Change template',
      summary: esc(changes ? `${tpl.label} · ${plural(changes, 'change')}` : tpl.label),
      body: choiceGroup({ name: 'set-tpl', value: tplId, act: 'set-template', cols: 2, options: Object.entries(TEMPLATES).map(([id, t]) => [id, t.label, esc(t.desc), TEMPLATE_ICON[id] || 'layers']) }),
    });
    const reset = changes ? `<div class="set-reset">${linkBtn(`Reset to ${tpl.label} defaults`, { act: 'set-reset' })}</div>` : '';
    const modules = `<div class="set-switches">${Object.entries(MODULES).map(([m, def]) => switchRow({ title: def.label, desc: esc(def.desc), on: hasModule(m, ws), act: 'set-module', data: { m } })).join('')}</div>`;
    /* Space types and AI workflows only appear while their module is on. */
    const types = spaceTypeIds(ws);
    const spaces = hasModule('spaces', ws) ? `<div class="set-checks">${Object.entries(SPACE_TYPES).map(([id, t]) => {
      const n = (D.spaces || []).filter(s => s.type === id && !s.archived).length;
      return checkbox({ label: optLabel(t.label, t.desc, n ? plural(n, 'space') : '', t.icon), checked: types.includes(id), act: 'set-space-type', data: { id } });
    }).join('')}</div>` : '';
    const flows = workflowIds(ws);
    /* A workflow that only runs in space types that are off can't be used: it's shown disabled with what turns it on. */
    const blockedBy = w => (w.spaceTypes && !(hasModule('spaces', ws) && w.spaceTypes.some(t => types.includes(t))) ? w.spaceTypes.map(t => SPACE_TYPES[t]?.label || t) : null);
    const workflows = hasModule('work', ws) ? `<div class="set-checks">${Object.entries(WORKFLOWS).map(([id, w]) => {
      const where = w.spaceTypes ? w.spaceTypes.map(t => SPACE_TYPES[t]?.plural || t).join(', ') : 'Anywhere';
      const off = blockedBy(w);
      const why = off ? (hasModule('spaces', ws) ? `Turn on ${off.join(' or ')} spaces to use this` : 'Turn on Spaces to use this') : '';
      const box = checkbox({ label: optLabel(w.label, w.desc, off ? why : where, w.icon), checked: !off && flows.includes(id), act: 'set-workflow', data: { id }, disabled: !!off });
      return off ? `<span class="set-opt-off" data-tip="${esc(why)}" tabindex="0">${box}</span>` : box;
    }).join('')}</div>` : '';
    return `<div class="set-form set-setup">
      ${formSection('Modules', 'Changes apply to everyone right away. Turning a module off hides it; nothing is deleted.', modules)}
      ${spaces ? formSection('Space types', 'How people group members, materials and work.', spaces) : ''}
      ${workflows ? formSection('AI workflows', 'Guided tasks people start from Work and from their spaces.', workflows) : ''}
      ${formSection('Template', 'Sets which modules, space types and AI workflows this workspace starts with.', template + reset)}
    </div>`;
  }

  P.settings = ({ query }) => {
    /* Archiving lives under General › Advanced; the old Danger zone link opens it there. */
    if (query.tab === 'danger') ui('setAdv', {}).open = true;
    const tab = query.tab === 'setup' ? 'setup' : 'general';
    const head = pageHeader({ title: 'Settings', desc: `How ${esc(curWs().name)} is named, reached and set up.` });
    const t = `<div class="page-tabs">${tabs([{ id: 'general', label: 'General' }, { id: 'setup', label: 'Workspace setup' }], tab, '/settings')}</div>`;
    const body = gate({
      loading: () => `<div class="card stack gap-16" aria-busy="true">${[30, 60, 45].map(w => `<span class="skeleton skeleton--line" style="width:${w}%"></span><span class="skeleton" style="height:36px"></span>`).join('')}</div>`,
      error: () => errorState({ title: 'Settings didn’t load', desc: 'Try again. Your settings haven’t changed.' }),
      ok: () => (tab === 'setup' ? setupHtml() : generalHtml()),
    });
    return `<div class="page page--narrow">${head}${t}${body}</div>`;
  };

  A['set-touch'] = el => { const k = el.dataset.field; const f = form(); if (k && !f.touched[k]) f.touched[k] = true; refresh(); };
  A['set-discard'] = () => { S.ui.setWs = null; refresh(); };
  A['set-save'] = async () => {
    const ws = curWs(), f = form(); if (f.busy || !isDirty(f, ws)) return;
    f.tried = true;
    const errs = errors(f, ws);
    if (Object.keys(errs).length) { refresh(); $(errs.name ? '#set-name' : '#set-code')?.focus(); return; }
    f.busy = true; refresh(); await sleep(700);
    const name = f.name.trim(), code = f.code.trim();
    if (name !== ws.name) audit('Renamed workspace', name);
    if (code !== ws.code) audit('Changed workspace web address', `bomesh.app/${code}`);
    ws.name = name; ws.code = code;
    S.ui.setWs = null; refresh(); toast('Settings saved');
  };
  /** High-risk, so typed confirmation; it only files a request, which the admin can cancel until a platform admin acts. */
  A['set-archive'] = () => {
    const ws = curWs();
    confirmAction({
      title: `Request archive of ${ws.name}?`, danger: true, icon: 'archive', confirm: 'Request archive', typeText: ws.code,
      body: `<span>A platform admin archives it within 24 hours. Until then you can cancel the request.</span> <span>Once archived, no one can open it; its data is kept and can be restored for 30 days.</span> ${chip('Preview', { tone: 'default', variant: 'outline', size: 'sm', tip: 'Design proposal — backend contract pending' })}`,
      onConfirm: () => {
        ws.archiveRequest = { at: Date.now(), actor: me().name }; delete ws.archiveDecision; ws.status = 'archiving';
        audit('Requested workspace archive', ws.name); platformLog('Requested workspace archive', ws); refresh();
        toast('Archive requested. You can cancel it until a platform admin acts.', { tone: 'accent' });
      },
    });
  };
  A['set-archive-cancel'] = () => {
    const ws = curWs(); if (!ws.archiveRequest) return; delete ws.archiveRequest; ws.status = 'active';
    audit('Cancelled workspace archive request', ws.name); platformLog('Cancelled workspace archive request', ws); refresh(); toast('Archive request cancelled');
  };
  A['set-decision-dismiss'] = () => { const ws = curWs(); delete ws.archiveDecision; refresh(); };

  /** Switching template resets the setup but deletes nothing: it applies at once, and Undo restores the previous setup. */
  A['set-template'] = el => {
    const ws = curWs(), id = el.dataset.value, next = TEMPLATES[id];
    if (!next || id === wsTemplateId(ws)) { refresh(); return; }
    applySetup(w => { w.template = id; delete w.modules; delete w.spaceTypes; delete w.workflows; }, 'Changed workspace template', next.label, `${ws.name} now uses the ${next.label} template`);
  };
  A['set-reset'] = () => {
    const tpl = wsTemplate();
    applySetup(w => { delete w.modules; delete w.spaceTypes; delete w.workflows; }, 'Reset workspace setup', tpl.label, `Back to the ${tpl.label} defaults`);
  };
  A['set-module'] = el => {
    const ws = curWs(), m = el.dataset.m, def = MODULES[m]; if (!def) return;
    const on = !hasModule(m, ws), tplOn = !!wsTemplate(ws).modules[m];
    applySetup(w => {
      const mods = { ...(w.modules || {}) };
      if (on === tplOn) delete mods[m]; else mods[m] = on;
      if (Object.keys(mods).length) w.modules = mods; else delete w.modules;
    }, on ? 'Turned on module' : 'Turned off module', def.label, on ? `${def.label} is on for everyone in ${ws.name}` : `${def.label} is off and hidden from navigation`);
  };
  /** Toggle one id in an ordered list setting; stored only when it differs from the template. */
  function toggleList({ key, id, all, cur, min, def, labels }) {
    const next = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id];
    if (!next.length) { refresh(); toast(min, { tone: 'danger' }); return; }
    const added = next.length > cur.length;
    applySetup(w => { const list = all.filter(x => next.includes(x)); if (sameSet(list, def(w))) delete w[key]; else w[key] = list; }, ...labels(added));
  }
  A['set-space-type'] = el => {
    const id = el.dataset.id, t = SPACE_TYPES[id]; if (!t) return;
    toggleList({ key: 'spaceTypes', id, all: Object.keys(SPACE_TYPES), cur: spaceTypeIds(), min: 'Keep at least one space type while Spaces is on.', def: w => wsTemplate(w).spaceTypes,
      labels: added => [added ? 'Added space type' : 'Removed space type', t.plural, added ? `People can now create ${t.plural.toLowerCase()}` : `New ${t.plural.toLowerCase()} can’t be created. Existing ones stay.`] });
  };
  A['set-workflow'] = el => {
    const id = el.dataset.id, wf = WORKFLOWS[id]; if (!wf) return;
    toggleList({ key: 'workflows', id, all: Object.keys(WORKFLOWS), cur: workflowIds(curWs()), min: 'Keep at least one AI workflow while Work is on.', def: w => wsTemplate(w).workflows,
      labels: added => [added ? 'Turned on AI workflow' : 'Turned off AI workflow', wf.label, added ? `${wf.label} is available in Work` : `${wf.label} is off. Saved work stays.`] });
  };
})();

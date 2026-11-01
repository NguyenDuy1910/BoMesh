/* Workspace settings (/settings?tab=general|setup|danger) — name and web address,
   workspace ID, workspace setup (template, modules, space types, AI workflows)
   and archiving (a design proposal: backend contract pending). */
(() => {
  'use strict';

  const CODE_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/;
  const MAX_NAME = 60;
  STATUS.ws.archiving ??= ['warning', 'Archive requested'];

  const audit = (action, target) => D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Settings', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });

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
    const nameField = field({
      id: 'set-name', error: show('name'), counter: show('name') ? '' : `<span class="counter">${f.name.length}/${MAX_NAME}</span>`,
      control: input({ id: 'set-name', bind: 'setWs.name', value: f.name, invalid: !!show('name'), onEnter: 'set-save', attrs: `aria-label="Workspace name" maxlength="${MAX_NAME}" data-input="set-touch" data-field="name"` }),
    });
    const codeField = field({
      id: 'set-code', error: show('code'), desc: '3–32 lowercase letters, numbers or hyphens.',
      control: `<div class="set-url"><span class="set-url__prefix" aria-hidden="true">bomesh.app/</span>${input({ id: 'set-code', bind: 'setWs.code', value: f.code, invalid: !!show('code'), onEnter: 'set-save', attrs: 'aria-label="Web address after bomesh.app/" maxlength="32" spellcheck="false" data-input="set-touch" data-field="code"' })}</div>`,
    });
    const impact = codeChanged ? alertBox('warning', 'Old links will stop working', `<span class="mono">bomesh.app/${esc(ws.code)}</span> won’t redirect to <span class="mono">bomesh.app/${esc(code)}</span>. Share the new address after saving.`) : '';
    const idField = field({
      id: 'set-id',
      control: `<div class="input-group input-group--suffix set-id">${input({ id: 'set-id', value: ws.id, cls: 'mono', attrs: 'readonly aria-label="Workspace ID"' })}<span class="input-group__suffix">${iconBtn('copy', 'Copy workspace ID', { size: 'sm', act: 'copy', data: { text: ws.id, msg: 'Workspace ID copied' } })}</span></div>`,
    });
    const bar = isDirty(f, ws) ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes</span>${btn('Discard', { v: 'ghost', act: 'set-discard', disabled: f.busy })}${btn('Save changes', { v: 'primary', act: 'set-save', loading: f.busy, disabled: f.busy })}</div>` : '';
    return `<div class="set-form">
      ${formSection('Workspace name', 'Shown in navigation, invitations and emails.', nameField)}
      ${formSection('Web address', 'Where people sign in to this workspace.', codeField + impact)}
      ${formSection('Workspace ID', 'For support requests and API calls.', idField)}
    </div>${bar}`;
  }

  function dangerHtml() {
    const ws = curWs(), req = ws.archiveRequest;
    const preview = chip('Preview', { tone: 'default', variant: 'outline', size: 'sm', tip: 'Design proposal — backend contract pending' });
    const head = `<div class="card__header"><span class="item-icon item-icon--danger">${ic('archive')}</span><div class="grow"><div class="row gap-8"><h3 class="card__title">Archive workspace</h3>${preview}</div><p class="card__description">Removes ${esc(ws.name)} for everyone without deleting its data.</p></div></div>`;
    if (req) {
      return `<div class="card card--lg set-danger">${head}
        ${alertBox('warning', 'Archive requested', `${esc(req.actor)} requested this ${esc(rel(req.at).toLowerCase())}. Platform admins finish archiving within 24 hours.`, btn('Cancel request', { v: 'secondary', size: 'sm', act: 'set-archive-cancel' }))}
      </div>`;
    }
    return `<div class="card card--lg set-danger">${head}
      <ul class="set-impact">
        <li>${ic('users', 'i-sm')}<span>Everyone loses access, including you.</span></li>
        <li>${ic('pause', 'i-sm')}<span>Source syncs pause.</span></li>
        <li>${ic('history', 'i-sm')}<span>Platform admins can restore it for 30 days.</span></li>
      </ul>
      <div class="card__footer"><span class="grow t-sm muted">You’ll confirm by typing <span class="mono strong">${esc(ws.code)}</span>.</span>${btn('Archive workspace', { v: 'danger-soft', icon: 'archive', act: 'set-archive' })}</div>
    </div>`;
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
  const optLabel = (title, desc, meta = '') => `<span class="set-opt"><span class="set-opt__title">${esc(title)}${meta ? `<span class="set-opt__meta">${esc(meta)}</span>` : ''}</span><span class="set-opt__desc">${esc(desc)}</span></span>`;

  function setupHtml() {
    const ws = curWs(), tpl = wsTemplate(ws), tplId = wsTemplateId(ws);
    const overridden = Object.keys(ws.modules || {}).length || ws.spaceTypes || ws.workflows;
    const template = choiceGroup({ name: 'set-tpl', value: tplId, act: 'set-template', cols: 2, options: Object.entries(TEMPLATES).map(([id, t]) => [id, t.label, esc(t.desc)]) })
      + (overridden ? `<div class="set-reset">${linkBtn(`Reset to ${tpl.label} defaults`, { act: 'set-reset' })}</div>` : '');
    const modules = `<div class="set-switches">${Object.entries(MODULES).map(([m, def]) => {
      const changed = ws.modules?.[m] != null && ws.modules[m] !== !!tpl.modules[m];
      return switchRow({ title: def.label, desc: esc(def.desc) + (changed ? ` <span class="set-changed">Changed from ${esc(tpl.label)}</span>` : ''), on: hasModule(m, ws), act: 'set-module', data: { m } });
    }).join('')}</div>`;
    const types = spaceTypeIds(ws);
    const spaces = hasModule('spaces', ws)
      ? `<div class="set-checks">${Object.entries(SPACE_TYPES).map(([id, t]) => {
        const n = (D.spaces || []).filter(s => s.type === id && !s.archived).length;
        return checkbox({ label: optLabel(t.label, t.desc, n ? plural(n, 'space') : ''), checked: types.includes(id), act: 'set-space-type', data: { id } });
      }).join('')}</div>`
      : `<p class="t-sm muted">Turn on Spaces to choose how people organise their work.</p>`;
    const flows = workflowIds(ws);
    const workflows = hasModule('work', ws)
      ? `<div class="set-checks">${Object.entries(WORKFLOWS).map(([id, w]) => {
        const where = w.spaceTypes ? w.spaceTypes.map(t => SPACE_TYPES[t]?.plural || t).join(', ') : 'Anywhere';
        return checkbox({ label: optLabel(w.label, w.desc, where), checked: flows.includes(id), act: 'set-workflow', data: { id } });
      }).join('')}</div>`
      : `<p class="t-sm muted">Turn on Work to offer AI workflows.</p>`;
    return `<div class="set-form set-setup">
      ${formSection('Template', 'Sets which modules, space types and AI workflows this workspace starts with.', template)}
      ${formSection('Modules', 'Changes apply to everyone right away. Turning a module off hides it; nothing is deleted.', modules)}
      ${formSection('Space types', 'How people group members, materials and work.', spaces)}
      ${formSection('AI workflows', 'Guided tasks people start from Work and from their spaces.', workflows)}
    </div>`;
  }

  P.settings = ({ query }) => {
    const tab = ['setup', 'danger'].includes(query.tab) ? query.tab : 'general';
    const head = pageHeader({ title: 'Settings', desc: esc(curWs().name) });
    const t = `<div class="page-tabs">${tabs([{ id: 'general', label: 'General' }, { id: 'setup', label: 'Workspace setup' }, { id: 'danger', label: 'Danger zone' }], tab, '/settings')}</div>`;
    const body = gate({
      loading: () => `<div class="card stack gap-16" aria-busy="true">${[30, 60, 45].map(w => `<span class="skeleton skeleton--line" style="width:${w}%"></span><span class="skeleton" style="height:36px"></span>`).join('')}</div>`,
      error: () => errorState({ title: 'Settings didn’t load', desc: 'Try again. Your settings haven’t changed.' }),
      ok: () => (tab === 'danger' ? dangerHtml() : tab === 'setup' ? setupHtml() : generalHtml()),
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
  A['set-archive'] = () => {
    const ws = curWs();
    confirmAction({
      title: `Archive ${ws.name}?`, danger: true, confirm: 'Archive workspace', typeText: ws.code,
      body: 'Everyone loses access and source syncs pause. Platform admins can restore it for 30 days.',
      onConfirm: () => {
        const prev = ws.status;
        ws.archiveRequest = { at: Date.now(), actor: me().name }; ws.status = 'archiving';
        audit('Requested workspace archive', ws.name); refresh();
        toast('Archive requested', { tone: 'accent', action: { label: 'Undo', run: () => { delete ws.archiveRequest; ws.status = prev; refresh(); } } });
      },
    });
  };
  A['set-archive-cancel'] = () => {
    const ws = curWs(); delete ws.archiveRequest; ws.status = 'active';
    audit('Cancelled workspace archive', ws.name); refresh(); toast('Archive request cancelled');
  };

  A['set-template'] = el => {
    const ws = curWs(), id = el.dataset.value, next = TEMPLATES[id];
    refresh(); // the current template stays selected until the switch is confirmed
    if (!next || id === wsTemplateId(ws)) return;
    confirmAction({
      title: `Switch to the ${next.label} template?`, confirm: 'Switch template',
      body: `Modules, space types and AI workflows reset to the ${esc(next.label)} defaults. Knowledge, people, chats and spaces stay as they are.`,
      onConfirm: () => applySetup(w => { w.template = id; delete w.modules; delete w.spaceTypes; delete w.workflows; }, 'Changed workspace template', next.label, `${ws.name} now uses the ${next.label} template`),
    });
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

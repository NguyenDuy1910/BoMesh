/* Workspace settings (/settings?tab=general|setup) — name, the web address (read-only: chosen when the workspace is
   created), who can join (private, or public with visitors and their daily question quota), workspace ID, workspace
   setup (template, modules, space types, AI workflows, knowledge map levels) and the archive request (a design proposal:
   backend contract pending).
   Archiving is a request: a platform admin archives the workspace or declines (platform.js);
   the decision shows here (ws.archiveDecision). */
(() => {
  'use strict';

  const MAX_NAME = 60;
  STATUS.ws.archiving ??= ['warning', 'Archive requested'];

  const audit = (action, target) => D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Settings', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  /** Platform-level events also go to the platform audit log (the operator acts on them). */
  const platformLog = (action, ws) => D.pAudit?.unshift({ id: uid('pev'), at: Date.now(), ws: ws.id, actor: me().name, action, area: 'Workspaces', target: ws.name, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });

  function form() {
    const ws = curWs(); let f = S.ui.setWs;
    if (!f || f.wsId !== ws.id) f = S.ui.setWs = { wsId: ws.id, name: ws.name, touched: {}, tried: false, busy: false };
    return f;
  }
  function errors(f) {
    const e = {}, name = f.name.trim();
    if (!name) e.name = 'Enter a workspace name.';
    else if (name.length > MAX_NAME) e.name = `Keep the name to ${MAX_NAME} characters.`;
    return e;
  }
  const isDirty = (f, ws) => f.name.trim() !== ws.name;

  function generalHtml() {
    const ws = curWs(), f = form(), errs = errors(f);
    const show = k => ((f.tried || f.touched[k]) && errs[k]) || '';
    /* The counter appears only when the limit is close. */
    const nameField = field({
      id: 'set-name', error: show('name'), counter: show('name') || f.name.length < MAX_NAME - 10 ? '' : `<span class="counter">${f.name.length}/${MAX_NAME}</span>`,
      control: input({ id: 'set-name', bind: 'setWs.name', value: f.name, invalid: !!show('name'), onEnter: 'set-save', attrs: `aria-label="Workspace name" maxlength="${MAX_NAME}" data-input="set-touch" data-field="name"` }),
    });
    /* The web address names the workspace's storage, so it is fixed at creation: shown to read and copy, never edited. */
    const address = `<div class="set-url set-url--copy"><span class="set-url__prefix" aria-hidden="true">bomesh.app/</span>${input({ id: 'set-address', value: ws.code, attrs: 'readonly aria-label="Web address"' })}${iconBtn('copy', 'Copy web address', { size: 'sm', act: 'copy', data: { text: `https://bomesh.app/${ws.code}`, msg: 'Web address copied' } })}</div>`;
    const bar = isDirty(f, ws) ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes</span>${btn('Discard', { v: 'ghost', act: 'set-discard', disabled: f.busy })}${btn('Save changes', { v: 'primary', act: 'set-save', loading: f.busy, disabled: f.busy })}</div>` : '';
    return `${archiveNotice(ws)}<div class="set-form">
      ${formSection('Workspace name', 'Shown in navigation, invitations and emails.', nameField)}
      ${formSection('Logo', 'Shown instead of the first letter in the sidebar, the workspace list and the join page. PNG, JPEG or WebP up to 1 MB; any shape is fitted whole into the square.', logoHtml(ws))}
      ${formSection('Web address', 'Where people sign in to this workspace. It’s set when the workspace is created and can’t be changed.', address)}
      ${formSection('Who can join', 'A public workspace lets anyone with a BoMesh account join by themselves as a member.', joinHtml(ws))}
    </div>${advancedHtml(ws)}${bar}`;
  }

  /* ── Logo (WorkspaceSettings.branding.logo): applies at once with Undo, like who can join. The file is checked here first
     (type and size) so the message is immediate; the server checks the same. ── */
  const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
  const LOGO_MAX = 1024 * 1024;
  function logoHtml(ws) {
    const err = S.ui.setLogoErr || '', logo = ws.logo;
    const text = logo
      ? `<div class="medium truncate" translate="no">${esc(logo.name)}</div><div class="t-xs muted">${esc(`Updated ${relLow(logo.at)}`)}</div>`
      : `<div class="medium">${esc('No logo')}</div><div class="t-xs muted">${esc('The first letter of the name is shown.')}</div>`;
    const actions = logo
      ? btn('Replace', { size: 'sm', icon: 'upload', act: 'set-logo-pick' }) + btn('Remove', { size: 'sm', v: 'ghost', act: 'set-logo-remove' })
      : btn('Upload logo', { size: 'sm', icon: 'upload', act: 'set-logo-pick' });
    const error = err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : '';
    return `<div class="set-logo">${wsMark(ws, 48)}<div class="grow set-logo__text">${text}</div><div class="row gap-8">${actions}</div>
      <input type="file" id="set-logo-file" class="sr-only" accept="image/*" data-change="set-logo-file" tabindex="-1" aria-hidden="true"></div>${error}`;
  }
  /** The chooser and the sidebar read D.workspaces; settings and the platform console read D.pWorkspaces. */
  function putLogo(id, logo) {
    [D.workspaces, D.pWorkspaces].forEach(list => { const w = list.find(x => x.id === id); if (!w) return; if (logo) w.logo = logo; else delete w.logo; });
  }
  function applyLogo(ws, next, action, msg) {
    const prev = ws.logo || null;
    putLogo(ws.id, next); S.ui.setLogoErr = ''; audit(action, ws.name); refresh();
    toast(msg, { action: { label: 'Undo', run: () => { putLogo(ws.id, prev); audit('Undid a logo change', ws.name); refresh(); toast('Change undone', { tone: 'accent' }); } } });
  }
  A['set-logo-pick'] = () => $('#set-logo-file')?.click();
  A['set-logo-file'] = el => {
    const ws = curWs(), file = el.files?.[0]; el.value = '';
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) { S.ui.setLogoErr = 'Use a PNG, JPEG or WebP image.'; refresh(); return; }
    if (file.size > LOGO_MAX) { S.ui.setLogoErr = 'The logo must be 1 MB or smaller.'; refresh(); return; }
    const rd = new FileReader();
    rd.onerror = () => { S.ui.setLogoErr = 'Couldn’t read this image. Try another file.'; refresh(); };
    rd.onload = () => applyLogo(ws, { src: String(rd.result), name: file.name, at: Date.now() }, ws.logo ? 'Replaced the workspace logo' : 'Added a workspace logo', ws.logo ? 'Logo updated' : 'Logo added');
    rd.readAsDataURL(file);
  };
  A['set-logo-remove'] = () => { const ws = curWs(); if (ws.logo) applyLogo(ws, null, 'Removed the workspace logo', 'Logo removed'); };

  /* ── Who can join: private (invited people only) or public (anyone with an account joins as a member) ──
     Each change applies at once with Undo, like Workspace setup. Going public says plainly what a new member gets, with the
     collections open to all members, and suggests reviewing access first; going private keeps everyone who already joined. */
  /** The join link: shown as the product's address; the prototype copies its own working one (#/w/{code}). */
  const joinLink = ws => `${location.href.split('#')[0]}#/w/${ws.code}`;
  /** Collections every member reads (general access All members). */
  const memberKbs = () => D.kbs.filter(k => k.general === 'workspace' && !k.personal && !k.archived);
  function joinHtml(ws) {
    const pub = isPublicWs(ws);
    const choice = choiceGroup({ name: 'set-vis', value: pub ? 'public' : 'private', act: 'set-visibility', cols: 2, options: [
      ['private', 'Invited people only', 'Admins add people or send them an invite link.', 'lock'],
      ['public', 'Anyone with an account', 'They join by themselves and become members.', 'globe'],
    ] });
    if (!pub) return `<div class="set-join">${choice}</div>`;
    const link = field({ id: 'set-join-link', label: 'Join link', desc: 'Share it on your website or in announcements. It opens a page with Join; people sign in or create an account first.',
      control: `<div class="set-url set-url--copy"><span class="set-url__prefix" aria-hidden="true">bomesh.app/w/</span>${input({ id: 'set-join-link', value: ws.code, attrs: 'readonly aria-label="Join link"' })}${iconBtn('copy', 'Copy join link', { size: 'sm', act: 'copy', data: { text: joinLink(ws), msg: 'Join link copied' } })}</div>` });
    return `<div class="set-join">${choice}${link}</div>`;
  }
  /** Visibility applies at once with Undo. It never removes anyone: people who joined stay members until an admin removes them. */
  function setVisibility(ws, next) {
    const prev = ws.visibility || 'private';
    ws.visibility = next;
    audit(next === 'public' ? 'Made the workspace public' : 'Made the workspace private', ws.name); platformLog(next === 'public' ? 'Made the workspace public' : 'Made the workspace private', ws);
    refresh();
    toast(next === 'public' ? `${ws.name} is public. Anyone with an account can join as a member.` : `${ws.name} is private. Only invited people can join.`, { action: { label: 'Undo', run: () => {
      ws.visibility = prev; audit('Undid a change to who can join', ws.name); refresh(); toast('Change undone', { tone: 'accent' });
    } } });
  }
  A['set-visibility'] = el => {
    const ws = curWs(), next = el.dataset.value;
    refresh();   // the cards show the current choice until it's confirmed
    if (next === (isPublicWs(ws) ? 'public' : 'private')) return;
    if (next === 'public') {
      const kbs = memberKbs();
      confirmAction({
        title: `Make ${ws.name} public?`, icon: 'globe', confirm: 'Make public',
        body: `<span>${esc('Anyone with a BoMesh account can join and becomes a member right away.')}</span> <span>${esc(`New members read the ${plural(kbs.length, 'collection')} open to all members, contribute documents for review and use the assistant.`)}</span>`
          + (kbs.length && kbs.length <= 6 ? `<span class="set-vis-names" translate="no">${esc(kbs.map(k => k.name).join(' · '))}</span>` : '')
          + `<span class="set-vis-review"><span>${esc('If any of them shouldn’t reach people outside your organization, review collection access first.')}</span> ${linkBtn('Review collections', { act: 'set-vis-kbs', icon: 'arrow-right' })}</span>`,
        onConfirm: () => setVisibility(ws, 'public'),
      });
      return;
    }
    confirmAction({
      title: `Make ${ws.name} private?`, icon: 'lock', confirm: 'Make private',
      body: `<span>${esc('New people can no longer join by themselves.')}</span> <span>${esc('Everyone who already joined stays a member until an admin removes them.')}</span>`,
      onConfirm: () => setVisibility(ws, 'private'),
    });
  };
  /** Review what new members will read: Collections, filtered to the ones open to all members. */
  A['set-vis-kbs'] = () => { closeModal(); ui('kbList', { sort: 'updated' }).access = 'workspace'; go(studioHref('collections')); };

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
  const SETUP_KEYS = ['template', 'modules', 'spaceTypes', 'workflows', 'mapLevels'];
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

  /** How far this workspace's setup is from its template, in plain counts (own map levels count as one). */
  function setupChanges(ws, tpl) {
    const diff = (a, b) => a.filter(x => !b.includes(x)).length + b.filter(x => !a.includes(x)).length;
    return Object.keys(ws.modules || {}).length + (ws.spaceTypes ? diff(ws.spaceTypes, tpl.spaceTypes) : 0) + (ws.workflows ? diff(ws.workflows, tpl.workflows) : 0) + (ws.mapLevels ? 1 : 0);
  }

  /* ── Knowledge map levels: typed, so a draft with the save bar; saving applies through applySetup (Undo) ── */
  const MAX_LEVELS = 8, MAX_LEVEL_NAME = 30;
  /** Template labels are English vocabulary: show them in the interface language. A workspace's own labels stay as typed. */
  const shownLevels = ws => (ws.mapLevels ? [...ws.mapLevels] : wsTemplate(ws).levels.map(l => tr(l) ?? l));
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const trimmed = list => list.map(s => s.trim());
  const levelsDirty = (f, ws) => !sameList(trimmed(f.list), shownLevels(ws));
  /** The draft starts from the saved levels and follows them (save, Undo, Reset, another language) until someone edits it. */
  function levelsForm() {
    const ws = curWs(), cur = shownLevels(ws); let f = S.ui.setLevels;
    const stale = f && sameList(trimmed(f.list), f.base) && !sameList(f.base, cur);
    if (!f || f.wsId !== ws.id || stale) f = S.ui.setLevels = { wsId: ws.id, base: cur, list: [...cur], touched: {}, tried: false };
    return f;
  }
  function levelErrors(list) {
    const e = {}, seen = new Set();
    trimmed(list).forEach((v, i) => {
      const k = v.toLowerCase();
      if (!v) e[i] = 'Name this level.';
      else if (seen.has(k)) e[i] = 'Each level needs its own name.';
      seen.add(k);
    });
    return e;
  }
  function levelsHtml(ws) {
    const f = levelsForm(), errs = levelErrors(f.list), n = f.list.length;
    const show = i => ((f.tried || f.touched[i]) && errs[i]) || '';
    /* The first four name map depths 1–4; any further ones are extra kinds a collection or folder can pick. */
    const rows = f.list.map((v, i) => {
      const extra = i >= 4, id = `set-lv${i}`;
      return `<li class="set-level">
        <span class="${cx('set-level__num', extra && 'set-level__num--extra')}" aria-hidden="true">${extra ? '–' : i + 1}</span>
        <div class="set-level__field">${field({ id, error: show(i), control: input({ id, bind: `setLevels.list.${i}`, value: v, placeholder: extra ? 'Extra level' : `Level ${i + 1}`, invalid: !!show(i), onEnter: 'set-levels-save',
          attrs: `aria-label="${extra ? 'Extra level name' : `Level ${i + 1} name`}" maxlength="${MAX_LEVEL_NAME}" data-input="set-levels-touch" data-i="${i}"` }) })}</div>
        <div class="set-level__actions">
          ${iconBtn('arrow-up', 'Move up', { size: 'sm', act: 'set-level-move', data: { i, d: -1 }, disabled: i === 0 })}
          ${iconBtn('arrow-down', 'Move down', { size: 'sm', act: 'set-level-move', data: { i, d: 1 }, disabled: i === n - 1 })}
          ${iconBtn('trash', n > 1 ? 'Remove level' : 'Keep at least one level', { size: 'sm', act: 'set-level-rm', data: { i }, disabled: n === 1 })}
        </div>
      </li>`;
    }).join('');
    return `<ol class="set-levels" aria-label="Knowledge map levels">${rows}</ol>
      <div class="row between gap-8">${n < MAX_LEVELS ? btn('Add level', { size: 'sm', icon: 'plus', act: 'set-level-add' }) : '<span></span>'}<span class="t-xs muted num">${n}/${MAX_LEVELS}</span></div>`;
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
    /* Modules held back for a later phase (LATER_PHASE_MODULES) have no switch: nobody can turn them on yet. */
    const modules = `<div class="set-switches">${Object.entries(MODULES).filter(([m]) => !LATER_PHASE_MODULES.has(m)).map(([m, def]) => switchRow({ title: def.label, desc: esc(def.desc), on: hasModule(m, ws), act: 'set-module', data: { m } })).join('')}</div>`;
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
    const levelsBar = levelsDirty(levelsForm(), ws) ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes to knowledge map levels</span>${btn('Discard', { v: 'ghost', act: 'set-levels-discard' })}${btn('Save changes', { v: 'primary', act: 'set-levels-save' })}</div>` : '';
    // The background itself is edited in one dialog (features/atlas.js), also opened from the knowledge map's header.
    const bg = ws.mapBg, bgMeta = bg ? `Strength ${X.mapBg.strengthOf(bg.strength)}% · updated ${relLow(bg.at)}${bg.by ? ` by ${actorName(bg.by)}` : ''}` : 'The map uses the plain canvas.';
    const background = `<div class="mapbg-setting"><span class="mapbg-thumb">${bg ? X.mapBg.backdrop(bg, bg.strength) : ic('image')}</span><div class="grow" style="min-width:0"><div class="medium truncate"${bg?.name ? ' translate="no"' : ''}>${esc(bg ? bg.name || 'Background image' : 'No background')}</div><div class="t-xs muted">${esc(bgMeta)}</div></div>${btn(bg ? 'Change' : 'Add background', { size: 'sm', icon: bg ? 'pencil' : 'image', act: 'map-bg' })}</div>`;
    return `<div class="set-form set-setup">
      ${formSection('Modules', 'Changes apply to everyone right away. Turning a module off hides it; nothing is deleted.', modules)}
      ${spaces ? formSection('Space types', 'How people group members, materials and work.', spaces) : ''}
      ${workflows ? formSection('AI workflows', 'Guided tasks people start from Work and from their spaces.', workflows) : ''}
      ${formSection('Knowledge map levels', 'The first four name levels 1–4 of the map; a collection or folder can use any of them.', levelsHtml(ws))}
      ${formSection('Map background', 'An image behind the knowledge map, for everyone in this workspace. It’s softened so the map stays readable.', background)}
      ${formSection('Template', 'Sets which modules, space types, AI workflows and map levels this workspace starts with.', template + reset)}
    </div>${levelsBar}`;
  }

  const relLow = ts => rel(ts).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase());
  /** Settings' sections are sidebar sub-rows of Settings (pageSections). */
  const sections = () => pageSections('/settings', [{ id: 'general', label: 'General' }, { id: 'setup', label: 'Workspace setup' }]);
  (X.sections ||= {}).settings = () => sections().nav();
  P.settings = ({ query }) => {
    /* Archiving lives under General › Advanced; the old Danger zone link opens it there. */
    if (query.tab === 'danger') ui('setAdv', {}).open = true;
    const s = sections(), tab = s.section(query);
    const head = pageHeader({ title: s.title(query) });
    const body = gate({
      loading: () => `<div class="card stack gap-16" aria-busy="true">${[30, 60, 45].map(w => `<span class="skeleton skeleton--line" style="width:${w}%"></span><span class="skeleton" style="height:36px"></span>`).join('')}</div>`,
      error: () => errorState({ title: 'Settings didn’t load', desc: 'Try again. Your settings haven’t changed.' }),
      ok: () => (tab === 'setup' ? setupHtml() : generalHtml()),
    });
    return `<div class="page page--narrow">${head}${body}</div>`;
  };

  A['set-touch'] = el => { const k = el.dataset.field; const f = form(); if (k && !f.touched[k]) f.touched[k] = true; refresh(); };
  A['set-discard'] = () => { S.ui.setWs = null; refresh(); };
  A['set-save'] = async () => {
    const ws = curWs(), f = form(); if (f.busy || !isDirty(f, ws)) return;
    f.tried = true;
    if (Object.keys(errors(f)).length) { refresh(); $('#set-name')?.focus(); return; }
    f.busy = true; refresh(); await sleep(700);
    const name = f.name.trim();
    audit('Renamed workspace', name);
    ws.name = name;
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
    S.ui.setLevels = null;
    applySetup(w => { w.template = id; SETUP_KEYS.slice(1).forEach(k => delete w[k]); }, 'Changed workspace template', next.label, `${ws.name} now uses the ${next.label} template`);
  };
  A['set-reset'] = () => {
    const tpl = wsTemplate();
    S.ui.setLevels = null;
    applySetup(w => { SETUP_KEYS.slice(1).forEach(k => delete w[k]); }, 'Reset workspace setup', tpl.label, `Back to the ${tpl.label} defaults`);
  };
  A['set-levels-touch'] = el => { const f = levelsForm(), i = el.dataset.i; if (i != null) f.touched[i] = true; refresh(); };
  A['set-level-add'] = () => {
    const f = levelsForm(); if (f.list.length >= MAX_LEVELS) return;
    f.list.push(''); refresh();
    requestAnimationFrame(() => $(`#set-lv${f.list.length - 1}`)?.focus());
  };
  A['set-level-rm'] = el => { const f = levelsForm(); if (f.list.length <= 1) return; f.list.splice(+el.dataset.i, 1); f.touched = {}; refresh(); };
  A['set-level-move'] = el => {
    const f = levelsForm(), i = +el.dataset.i, j = i + +el.dataset.d;
    if (j < 0 || j >= f.list.length) return;
    [f.list[i], f.list[j]] = [f.list[j], f.list[i]]; f.touched = {}; refresh();
    requestAnimationFrame(() => $(`[data-act="set-level-move"][data-i="${j}"][data-d="${el.dataset.d}"]:not(:disabled)`)?.focus());
  };
  A['set-levels-discard'] = () => { S.ui.setLevels = null; refresh(); };
  /** Labels equal to the template's (in English or the interface language) mean "follow the template": nothing is stored. */
  A['set-levels-save'] = () => {
    const ws = curWs(), f = levelsForm(), errs = levelErrors(f.list);
    if (!levelsDirty(f, ws)) return;
    if (Object.keys(errs).length) { f.tried = true; refresh(); $('.set-levels [aria-invalid="true"]')?.focus(); return; }
    const list = f.list.map(s => s.trim()), tpl = wsTemplate(ws).levels, isTpl = sameList(list, tpl) || sameList(list, tpl.map(l => tr(l) ?? l));
    S.ui.setLevels = null;
    applySetup(w => { if (isTpl) delete w.mapLevels; else w.mapLevels = list; }, 'Changed knowledge map levels', list.join(' › '), 'Knowledge map levels saved');
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

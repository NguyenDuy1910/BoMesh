/* Spaces: the list (/spaces) and one space (/space/:id?tab=overview|materials|
   work|queue|people|settings) — courses, research groups, offices, teams and
   projects. Create a space, ask to join, announcements, materials from linked
   knowledge, the space's work and request queue, members and settings.
   Shared: X.spaceMark(sp, size), A['space-ask']({dataset:{space, q?}}). Prefix: sp-. */
(() => {
  'use strict';

  const COLORS = ['#2F6FB5', '#0E7C66', '#4E6B2E', '#B4467A', '#6B4FBF', '#C2620F', '#1F7A8C', '#A23B3B'];
  const WAITING = ['submitted', 'in_review'];
  const CLOSED = ['completed', 'declined', 'withdrawn'];
  const DEFAULT_VIS = { course: 'members', research: 'discoverable', office: 'open', team: 'discoverable', project: 'members' };
  const SVC_FALLBACK = { submitted: ['accent', 'Submitted'], in_review: ['warning', 'In review'], needs_info: ['warning', 'Needs info'], approved: ['success', 'Approved'], declined: ['default', 'Declined'], completed: ['success', 'Completed', 'tertiary'], withdrawn: ['default', 'Withdrawn'] };
  const MAX_NAME = 60;

  /* ── Helpers ── */
  function audit(action, target) {
    D.audit?.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'Spaces', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const spaces = () => D.spaces || (D.spaces = []);
  const personName = id => memberById(id)?.name || Object.values(PERSONAS).find(p => p.id === id)?.name || 'Someone';
  const roleLabel = (sp, key) => spaceType(sp.type).roles.find(r => r[0] === key)?.[1] || key;
  const isStaffRole = (sp, key) => spaceType(sp.type).staff.includes(key);
  const staffCount = sp => sp.members.filter(m => isStaffRole(sp, m.role)).length;
  const defaultRole = sp => spaceType(sp.type).roles[spaceType(sp.type).roles.length - 1][0];
  const leadRole = type => spaceType(type).roles[0][0];
  const memberTotal = sp => Math.max(sp.memberCount || 0, sp.members.length);
  /** How someone outside the space gets in: open (visit and send requests) | enrolled (outside BoMesh) | request (ask the staff). */
  function joinMode(sp) {
    if (sp.visibility === 'open' || spaceType(sp.type).join === 'open') return 'open';
    return spaceType(sp.type).join === 'enrolled' ? 'enrolled' : 'request';
  }
  const myJoinRequest = sp => (sp.joinRequests || []).find(r => r.user === me().id);
  const linkedKbs = sp => (sp.kbs || []).map(kbById).filter(k => k && !k.archived);
  const readableKbs = sp => linkedKbs(sp).filter(canReadKb);
  const editableKbs = sp => linkedKbs(sp).filter(canEditKb);
  const requestTypesOf = sp => (hasModule('requests') ? (D.requestTypes || []).filter(t => t.space === sp.id) : []);
  const catalogOf = sp => requestTypesOf(sp).filter(t => !t.question);
  const questionType = sp => requestTypesOf(sp).find(t => t.question);
  const typeOf = r => (D.requestTypes || []).find(t => t.id === r.type);
  const spaceRequests = sp => (D.svcRequests || []).filter(r => r.space === sp.id);
  const waiting = sp => spaceRequests(sp).filter(r => WAITING.includes(r.status));
  const queueLabel = sp => (catalogOf(sp).length ? 'Requests' : 'Questions');
  function svcChip(st) {
    if (STATUS.svc?.[st]) return status('svc', st);
    const [tone, label, variant = 'soft'] = SVC_FALLBACK[st] || ['default', st];
    return chip(label, { tone, variant, dot: true });
  }
  function worksIn(sp) {
    if (!hasModule('work')) return [];
    if (X.worksVisible) return X.worksVisible({ space: sp.id });
    const staff = isSpaceStaff(sp), member = !!spaceRole(sp);
    return (D.works || []).filter(w => w.space === sp.id && (w.owner === me().id || (w.visibility === 'space' && (staff || (member && (sp.type !== 'course' || w.status === 'published'))))))
      .sort((a, b) => b.updated - a.updated);
  }
  function workRow(w) {
    if (X.workItem) return X.workItem(w, { from: 'space' });
    const icon = X.workIcon?.(w.kind) || WORKFLOWS[w.workflow]?.icon || 'sparkles';
    const st = w.status === 'draft' ? chip('Draft', { size: 'sm' }) : w.status === 'published' ? chip('Published', { tone: 'success', variant: 'tertiary', size: 'sm', dot: true }) : '';
    return item({ lead: itemIcon(icon, 'accent', 'sm'), title: esc(w.title), desc: `${esc(WORK_KINDS[w.kind]?.label || WORKFLOWS[w.workflow]?.label || 'Work')} · ${esc(personName(w.owner))}`, meta: rel(w.updated), trail: st, href: '/work/' + w.id });
  }
  function nameError(name, selfId) {
    const n = (name || '').trim();
    if (!n) return 'Enter a name.';
    if (n.length > MAX_NAME) return `Use ${MAX_NAME} characters or fewer.`;
    const dup = spaces().find(s => !s.archived && s.id !== selfId && s.name.trim().toLowerCase() === n.toLowerCase());
    return dup ? `“${dup.name}” already exists. Choose another name.` : '';
  }

  /** Colored tile with the space type's icon. */
  function spaceMark(sp, size = 36) {
    const t = spaceType(sp?.type), icls = size < 28 ? 'i-xs' : size < 34 ? 'i-sm' : size < 40 ? '' : size < 46 ? 'i-lg' : 'i-xl';
    return `<span class="sp-mark" style="--sp-mark:${size}px;background:${esc(sp?.color || 'var(--accent)')}" aria-hidden="true">${ic(t.icon, icls)}</span>`;
  }
  X.spaceMark = spaceMark;
  /** Items waiting on a space's staff (submitted or in review). */
  X.spaceQueue = sp => waiting(sp);

  /* ── Shared entry points (other modules' actions, called defensively) ── */
  A['space-ask'] = el => {
    const { space = '', q = '' } = el?.dataset || {};
    if (A['chat-ask']) A['chat-ask']({ dataset: { q, space } }); else go('/chat');
  };
  function startWork(workflow, space, docs) {
    if (A['work-start']) A['work-start']({ dataset: { workflow, space, docs } });
    else go(`/work/new?workflow=${workflow}${space ? '&space=' + space : ''}${docs ? '&docs=' + docs : ''}`);
  }
  A['sp-work'] = el => startWork(el.dataset.workflow, el.dataset.space, el.dataset.docs);
  A['sp-request'] = el => {
    const { type, space } = el.dataset;
    if (A['rq-new']) A['rq-new']({ dataset: { type, space } }); else go('/requests/new' + (type ? '?type=' + type : ''));
  };
  A['sp-ask-staff'] = el => {
    const space = el.dataset.space;
    if (A['rq-ask-staff']) A['rq-ask-staff']({ dataset: { space } });
    else { const t = questionType(spaceById(space)); go('/requests/new' + (t ? '?type=' + t.id : '')); }
  };
  /** Staff add materials through Contribute: a reviewer of the base publishes them. */
  A['sp-upload'] = el => { const kb = el.dataset.kb; if (A['contribute']) A['contribute']({ dataset: { kb } }); else go('/knowledge/' + kb); };

  /* ═══════════════════════════ Spaces list ═══════════════════════════ */
  function spaceCard(sp) {
    const t = spaceType(sp.type), role = spaceRole(sp);
    const sub = [sp.code, sp.term].filter(Boolean).join(' · ');
    let cta = '';
    if (role) cta = chip(roleLabel(sp, role), { size: 'sm', tone: isStaffRole(sp, role) ? 'accent' : 'default' });
    else {
      const mode = joinMode(sp);
      if (mode === 'enrolled') cta = '<span class="sp-card__note">Enrolled through the student portal</span>';
      else if (mode === 'open') cta = catalogOf(sp).length ? btn('Send a request', { size: 'sm', icon: 'send', act: 'sp-request', data: { space: sp.id } }) : '';
      else cta = myJoinRequest(sp) ? chip('Requested', { tone: 'warning', icon: 'clock', size: 'sm' }) : btn('Request to join', { size: 'sm', act: 'sp-join', data: { id: sp.id } });
    }
    return `<div class="card card--action sp-card" role="link" tabindex="0" data-act="go" data-to="/space/${sp.id}" aria-label="${esc(sp.name)}">
      <div class="sp-card__top">${spaceMark(sp, 40)}<span class="sp-card__type">${esc(t.label)}</span></div>
      <div class="stack gap-2"><div class="sp-card__name truncate">${esc(sp.name)}</div>${sub ? `<div class="sp-card__sub truncate">${esc(sub)}</div>` : ''}</div>
      <div class="sp-card__desc clamp-2">${esc(sp.desc || t.desc)}</div>
      <div class="sp-card__foot"><span class="row gap-4">${ic('users', 'i-sm')}${plural(memberTotal(sp), 'member')}</span>${cta}</div>
    </div>`;
  }
  function listEmpty(tab, canCreate) {
    if (tab === 'mine') {
      const kinds = spaceTypeIds().map(t => spaceType(t).plural.toLowerCase());
      return emptyState({ icon: 'layers', title: 'You’re not in any spaces yet', desc: `Spaces bring people, materials and work together by ${esc(kinds.join(', ').replace(/, ([^,]*)$/, ' and $1'))}.`, actions: (canCreate ? btn('Create space', { v: 'primary', icon: 'plus', act: 'sp-create' }) : '') + btn('Browse ' + spaceType(spaceTypeIds()[0]).plural.toLowerCase(), { href: '/spaces?tab=' + spaceTypeIds()[0] }), boxed: true });
    }
    const t = spaceType(tab);
    return emptyState({ icon: t.icon, title: `No ${t.plural.toLowerCase()} yet`, desc: esc(t.desc), actions: canCreate ? btn(`Create ${t.label.toLowerCase()}`, { v: 'primary', icon: 'plus', act: 'sp-create', data: { type: tab } }) : '', boxed: true });
  }
  P.spaces = ({ query }) => {
    const types = spaceTypeIds(), mine = mySpaces();
    const tabList = [{ id: 'mine', label: 'Mine' }, ...types.map(t => ({ id: t, label: spaceType(t).plural }))];
    const tab = tabList.some(t => t.id === query.tab) ? query.tab : 'mine';
    const canCreate = can('knowledge.manage') || isAdmin();
    const head = pageHeader({ title: 'Spaces', actions: canCreate ? btn('Create space', { v: 'primary', icon: 'plus', act: 'sp-create', data: { type: tab === 'mine' ? undefined : tab } }) : '' });
    const all = tab === 'mine' ? mine : visibleSpaces().filter(s => s.type === tab).sort((a, b) => (spaceRole(b) ? 1 : 0) - (spaceRole(a) ? 1 : 0) || a.name.localeCompare(b.name));
    const rows = all.filter(s => matchesQ('spList', s.name, s.code, s.desc));
    const toolbar = all.length > 3 || ui('spList').q ? `<div class="toolbar">${searchField({ uiKey: 'spList', placeholder: 'Search spaces' })}</div>` : '';
    const body = gate({
      loading: () => skelCards(6),
      empty: () => listEmpty(tab, canCreate),
      ok: () => (!all.length ? listEmpty(tab, canCreate) : rows.length ? `<div class="grid cols-3">${rows.map(spaceCard).join('')}</div>` : noMatches('spList', [], 'spaces')),
    });
    return `<div class="page">${head}<div class="page-tabs">${tabs(tabList, tab, '/spaces')}</div>${S.pageState === 'empty' ? '' : toolbar}${body}</div>`;
  };

  /* ── Create ── */
  A['sp-create'] = el => {
    const types = spaceTypeIds(), want = el?.dataset?.type;
    S.ui.spCreate = { type: types.includes(want) ? want : types[0], name: '', code: '', desc: '', kbs: {}, newKb: true, touched: false, busy: false };
    openModal('sp-create', {});
  };
  M['sp-create'] = () => {
    const f = ui('spCreate'), err = f.touched ? nameError(f.name) : '';
    const types = spaceTypeIds(), dis = f.busy ? 'disabled' : '';
    const kbs = visibleKbs().filter(k => !k.personal && canEditKb(k));
    const kbChecks = kbs.map(k => checkbox({ label: esc(k.name), checked: !!f.kbs[k.id], act: 'sp-create-kb', data: { id: k.id }, disabled: f.busy })).join('')
      + checkbox({ label: 'Create a new knowledge base for it', checked: f.newKb, act: 'sp-create-kb', data: { id: 'new' }, disabled: f.busy });
    return {
      title: 'Create space', size: 'lg',
      body: `<div class="field sp-types"><span class="label">Type</span>${choiceGroup({ name: 'spc-type', value: f.type, act: 'sp-create-type', options: types.map(t => [t, spaceType(t).label, esc(spaceType(t).desc)]), cols: Math.min(types.length, 3) })}</div>
        <div class="sp-create-row">
          ${field({ id: 'spc-name', label: 'Name', required: true, error: err, control: input({ id: 'spc-name', bind: 'spCreate.name', value: f.name, placeholder: f.type === 'course' ? 'e.g. Computer Vision' : 'e.g. Field robotics', autofocus: true, onEnter: 'sp-create-go', invalid: !!err, attrs: `maxlength="${MAX_NAME}" ${dis}` }) })}
          ${field({ id: 'spc-code', label: 'Code', optional: true, control: input({ id: 'spc-code', bind: 'spCreate.code', value: f.code, placeholder: f.type === 'course' ? 'IT4080' : 'Short name', onEnter: 'sp-create-go', attrs: `maxlength="16" ${dis}` }) })}
        </div>
        ${field({ id: 'spc-desc', label: 'Short description', optional: true, control: input({ id: 'spc-desc', bind: 'spCreate.desc', value: f.desc, placeholder: 'What happens here, in one line', onEnter: 'sp-create-go', attrs: `maxlength="140" ${dis}` }) })}
        <div class="field"><span class="label">Knowledge</span><div class="description">Members can read and ask about linked knowledge bases.</div><div class="stack gap-8 mt-4">${kbChecks}</div></div>`,
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + btn('Create space', { v: 'primary', act: 'sp-create-go', loading: f.busy }),
    };
  };
  A['sp-create-type'] = el => { ui('spCreate').type = el.dataset.value; refreshLayer(); };
  A['sp-create-kb'] = el => { const f = ui('spCreate'), id = el.dataset.id; if (id === 'new') f.newKb = !f.newKb; else f.kbs[id] = !f.kbs[id]; refreshLayer(); };
  A['sp-create-go'] = async () => {
    const f = ui('spCreate'); if (f.busy) return;
    f.touched = true;
    if (nameError(f.name)) { refreshLayer(); $('#spc-name')?.focus(); return; }
    f.busy = true; S.modal.props.guard = true; refreshLayer();
    await sleep(600);
    const name = f.name.trim(), code = f.code.trim(), desc = f.desc.trim(), id = uid('sp');
    const color = COLORS[spaces().length % COLORS.length];
    const kbs = Object.keys(f.kbs).filter(k => f.kbs[k]);
    if (f.newKb) {
      const kb = { id: uid('kb'), name: code ? `${name} · ${code}` : name, desc: desc || `Materials for ${name}.`, color, general: 'restricted', memberRole: null, shares: [{ kind: 'user', id: me().id, role: 'owner' }], updated: Date.now(), created: Date.now(), space: id };
      D.kbs.push(kb); kbs.unshift(kb.id);
    }
    spaces().push({ id, type: f.type, name, code, term: '', desc, color, schedule: '', memberCount: 1, visibility: DEFAULT_VIS[f.type] || 'members', kbs, members: [{ user: me().id, role: leadRole(f.type) }], announcements: [], joinRequests: [], created: Date.now() });
    audit('Created space', name);
    closeModal(); go('/space/' + id); toast(`Created “${name}”`);
  };

  /* ── Ask to join ── */
  A['sp-join'] = el => { S.ui.spJoin = { note: '' }; openModal('sp-join', { id: el.dataset.id }); };
  M['sp-join'] = ({ id }) => {
    const sp = spaceById(id); if (!sp) return { title: 'Space not found', body: '' };
    const leads = sp.members.filter(m => isStaffRole(sp, m.role)).map(m => personName(m.user));
    return {
      title: `Ask to join ${sp.name}`, size: 'sm',
      desc: leads.length ? `${esc(leads.slice(0, 2).join(' and '))} will review your request.` : '',
      body: field({ id: 'spj-note', label: 'Note', optional: true, desc: 'Say who you are and what you’d like to work on.', control: textarea({ id: 'spj-note', bind: 'spJoin.note', value: ui('spJoin').note, rows: 3, attrs: 'maxlength="300"' }) }),
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Send request', { v: 'primary', act: 'sp-join-go' }),
    };
  };
  A['sp-join-go'] = () => {
    const sp = spaceById(S.modal?.props.id); if (!sp) return;
    const user = me().id, req = { id: uid('jr'), user, note: (ui('spJoin').note || '').trim(), at: Date.now() };
    (sp.joinRequests ??= []).push(req);
    audit('Asked to join space', sp.name);
    closeModal(); refresh();
    toast('Request sent', { action: { label: 'Undo', run: () => { sp.joinRequests = sp.joinRequests.filter(r => r !== req); refresh(); } } });
  };
  A['sp-join-cancel'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return;
    sp.joinRequests = (sp.joinRequests || []).filter(r => r.user !== me().id);
    refresh(); toast('Request withdrawn');
  };

  /* ═══════════════════════════ Space page ═══════════════════════════ */
  function unavailable() {
    crumbs([{ label: 'Spaces', to: '/spaces' }, { label: 'Not available' }]);
    return `<div class="page">${emptyState({ icon: 'layers', title: 'This space isn’t available', desc: 'It may have been archived, or it’s private.', actions: btn('Browse spaces', { v: 'primary', href: '/spaces' }), boxed: true })}</div>`;
  }
  function metaLine(sp) { return [spaceType(sp.type).label, sp.code, sp.term, sp.schedule].filter(Boolean).map(esc).join(' · '); }
  function peopleLine(sp, link) {
    const faces = `<span class="avatar-group">${sp.members.slice(0, 4).map(m => avatar(personName(m.user), 'sm')).join('')}</span>${plural(memberTotal(sp), 'member')}`;
    return link ? `<a class="sp-head__people" href="#/space/${sp.id}?tab=people">${faces}</a>` : `<span class="sp-head__people">${faces}</span>`;
  }
  function lockedPage(sp, mode) {
    const head = pageHeader({ title: sp.name, lead: spaceMark(sp, 48), desc: `<span class="sp-head__meta">${metaLine(sp)}</span>${peopleLine(sp, false)}` });
    const pending = myJoinRequest(sp);
    const body = mode === 'enrolled'
      ? emptyState({ icon: spaceType(sp.type).icon, title: 'You’re not enrolled in this course', desc: 'Courses are joined through the student portal. Once you’re enrolled, its materials, quizzes and announcements show up here.', actions: btn('Browse spaces', { href: '/spaces' }), boxed: true })
      : pending
        ? emptyState({ icon: 'clock', title: 'Your request is with the team', desc: `You asked ${esc(rel(pending.at).toLowerCase())}. You’ll get in as soon as someone approves it.`, actions: btn('Withdraw request', { act: 'sp-join-cancel', data: { id: sp.id } }), boxed: true })
        : emptyState({ icon: 'lock', title: 'Join to see materials and work', desc: esc(sp.desc || spaceType(sp.type).desc), actions: btn('Request to join', { v: 'primary', act: 'sp-join', data: { id: sp.id } }), boxed: true });
    return `<div class="page">${head}${body}</div>`;
  }
  function headerActions(sp, { role, staff, manage, visitor }) {
    const ask = v => btn(sp.type === 'course' && !staff ? 'Ask about this course' : 'Ask', { v, icon: 'sparkles', act: 'space-ask', data: { space: sp.id } });
    const newMenu = v => (MENUS['sp-new']({ dataset: { id: sp.id } }).length ? btn('New', { v, icon: 'plus', iconRight: 'chevron-down', menu: 'sp-new', data: { id: sp.id } }) : '');
    if (visitor) return ask('tertiary') + (catalogOf(sp).length ? btn('New request', { v: 'primary', icon: 'plus', act: 'sp-request', data: { space: sp.id } }) : '');
    if (staff || (manage && !role)) return ask('tertiary') + newMenu('primary');
    const qt = questionType(sp);
    return (qt ? btn(sp.type === 'course' ? 'Ask the teaching team' : `Ask ${sp.name}`, { icon: 'message', act: 'sp-ask-staff', data: { space: sp.id } }) : sp.type === 'course' ? '' : newMenu('tertiary')) + ask('primary');
  }
  MENUS['sp-new'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return [];
    const items = (hasModule('work') ? workflowsFor(sp) : []).map(w => ({ label: w.label, icon: w.icon, run: () => startWork(w.id, sp.id) }));
    const extra = [];
    if (canManageSpace(sp)) extra.push({ label: 'Announcement', icon: 'megaphone', run: () => openAnn(sp.id) });
    const kb = editableKbs(sp)[0];
    if (kb && canManageSpace(sp)) extra.push({ label: 'Add materials', icon: 'upload', run: () => A['sp-upload']({ dataset: { kb: kb.id } }) });
    return items.length && extra.length ? [...items, { sep: true }, ...extra] : [...items, ...extra];
  };
  function tabsFor(sp, { staff, manage, visitor }) {
    const t = [{ id: 'overview', label: 'Overview' }];
    if (readableKbs(sp).length || manage || linkedDocs(sp).length) t.push({ id: 'materials', label: 'Materials' });
    if (visitor) return t;
    if (hasModule('work')) t.push({ id: 'work', label: 'Work' });
    if (staff && requestTypesOf(sp).length) { const n = waiting(sp).length; t.push({ id: 'queue', label: queueLabel(sp), count: n || '', alert: n > 0 }); }
    t.push({ id: 'people', label: 'People' });
    if (manage) t.push({ id: 'settings', label: 'Settings' });
    return t;
  }
  P.space = ({ params, query }) => {
    const sp = spaceById(params.id);
    if (!sp || sp.archived || (!spaceRole(sp) && sp.visibility === 'private' && !isAdmin())) return unavailable();
    crumbs([{ label: 'Spaces', to: '/spaces' }, { label: sp.name }]);
    const role = spaceRole(sp), staff = isSpaceStaff(sp), manage = canManageSpace(sp), mode = joinMode(sp);
    const visitor = !role && !manage;
    if (visitor && mode !== 'open') return lockedPage(sp, mode);
    const ctx = { role, staff, manage, visitor };
    const tabList = tabsFor(sp, ctx);
    const tab = tabList.some(t => t.id === query.tab) ? query.tab : 'overview';
    const head = pageHeader({ title: sp.name, lead: spaceMark(sp, 48), desc: `<span class="sp-head__meta">${metaLine(sp)}</span>${peopleLine(sp, !visitor)}`, actions: headerActions(sp, ctx) });
    const body = { overview: overviewTab, materials: materialsTab, work: workTab, queue: queueTab, people: peopleTab, settings: settingsTab }[tab](sp, ctx);
    return `<div class="page">${head}<div class="page-tabs">${tabs(tabList, tab, '/space/' + sp.id)}</div>${body}</div>`;
  };

  /* ── Overview ── */
  function annCard(sp, a, manage) {
    return card(`<div class="sp-ann__head">${avatar(personName(a.by), 'sm')}<div class="grow stack"><span class="sp-ann__by truncate">${esc(personName(a.by))}</span><span class="sp-ann__at">${esc(rel(a.at))}</span></div>${a.pinned ? chip('Pinned', { size: 'sm', tone: 'accent' }) : ''}${manage ? iconBtn('more', 'Announcement options', { size: 'sm', menu: 'sp-ann', data: { id: sp.id, ann: a.id } }) : ''}</div>
      <div class="stack gap-4"><h3 class="sp-ann__title">${esc(a.title)}</h3>${a.text ? `<p class="sp-ann__text">${esc(a.text)}</p>` : ''}</div>`, { cls: 'sp-ann' });
  }
  function announcements(sp, manage) {
    const all = [...(sp.announcements || [])].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.at - a.at);
    const open = ui('spView', { allAnn: {} }).allAnn[sp.id];
    const shown = open ? all : all.slice(0, 3);
    const more = all.length > 3 ? `<div>${linkBtn(open ? 'Show fewer' : `Show all ${all.length}`, { act: 'sp-ann-all', data: { id: sp.id } })}</div>` : '';
    const body = all.length ? `<div class="stack gap-12">${shown.map(a => annCard(sp, a, manage)).join('')}${more}</div>`
      : emptyState({ icon: 'megaphone', title: 'No announcements yet', desc: manage ? 'Post updates members should see first.' : 'Updates from the team will show up here.', actions: manage ? btn('Post announcement', { icon: 'plus', act: 'sp-ann-new', data: { id: sp.id } }) : '', boxed: true, compact: true });
    return section('Announcements', body, { actions: manage && all.length ? btn('Post', { v: 'ghost', size: 'sm', icon: 'plus', act: 'sp-ann-new', data: { id: sp.id } }) : '' });
  }
  function sideList(title, items, actions = '') { return items.length ? section(title, list(items, 'sp-side-list'), { actions }) : ''; }
  function overviewTab(sp, { manage, visitor }) {
    const next = X.upNext ? section('Up next', X.upNextList(X.upNext({ space: sp.id, limit: 5 }), { space: sp.id, empty: emptyState({ icon: 'calendar', title: 'Nothing coming up', desc: 'Deadlines and events for this space show up here.', compact: true, boxed: true }) })) : '';
    const start = !visitor && hasModule('work') ? workflowsFor(sp).map(w => item({ lead: itemIcon(w.icon, 'accent', 'sm'), title: esc(w.label), desc: `<span class="clamp-2">${esc(w.desc)}</span>`, act: 'sp-work', data: { workflow: w.id, space: sp.id } })) : [];
    const catalog = catalogOf(sp).map(t => item({ lead: itemIcon(t.icon || 'clipboard', '', 'sm'), title: esc(t.name), desc: `<span class="clamp-2">${esc(t.desc)}</span>`, act: 'sp-request', data: { type: t.id, space: sp.id } }));
    const kbs = linkedKbs(sp).filter(k => kbRole(k) !== null).map(k => {
      const ok = canReadKb(k), mark = X.kbMark ? X.kbMark(k, 28, !ok) : itemIcon(ok ? 'book' : 'lock', '', 'sm');
      return item({ lead: mark, title: esc(k.name), desc: ok ? plural(docsIn(k.id).length, 'document') : 'Locked', href: '/knowledge/' + k.id });
    });
    const side = sideList(catalog.length ? 'What you can request' : '', catalog)
      + sideList('Get started', start)
      + sideList('Knowledge', kbs, manage ? linkBtn('Manage', { href: `/space/${sp.id}?tab=settings` }) : '')
      + sideList('Collections', spaceCollections(sp).map(c => item({ lead: itemIcon('list', 'accent', 'sm'), title: esc(c.name), desc: plural(c.items.length, 'item'), href: '/knowledge/collections/' + c.id })));
    const target = manage && !readableKbs(sp).some(k => docsIn(k.id).length) && editableKbs(sp)[0];
    const setup = target ? `<div class="mb-24">${alertBox('accent', 'Add materials to get started', 'Members can ask about them and use them in workflows.', btn('Add materials', { size: 'sm', icon: 'upload', act: 'sp-upload', data: { kb: target.id } }))}</div>` : '';
    return gate({ loading: () => skelRows(4), ok: () => `${setup}<div class="sp-overview"><div class="sp-overview__main">${announcements(sp, manage)}${next}</div>${side ? `<aside class="sp-overview__side">${side}</aside>` : ''}</div>` });
  }
  A['sp-ann-all'] = el => { const m = ui('spView', { allAnn: {} }).allAnn; m[el.dataset.id] = !m[el.dataset.id]; refresh(); };

  /* Announcements: post, edit, pin, delete (managers) */
  function openAnn(spId, annId) {
    const a = annId && spaceById(spId)?.announcements.find(x => x.id === annId);
    S.ui.spAnn = { title: a?.title || '', text: a?.text || '', pinned: !!a?.pinned, tried: false };
    openModal('sp-ann', { id: spId, ann: annId || null });
  }
  A['sp-ann-new'] = el => openAnn(el.dataset.id);
  M['sp-ann'] = ({ id, ann }) => {
    const f = ui('spAnn'), sp = spaceById(id);
    const err = f.tried && !f.title.trim() ? 'Enter a title.' : '';
    return {
      title: ann ? 'Edit announcement' : 'Post announcement', desc: ann ? '' : `Everyone in ${esc(sp?.name || 'the space')} sees it on the space page.`,
      body: field({ id: 'spa-title', label: 'Title', required: true, error: err, control: input({ id: 'spa-title', bind: 'spAnn.title', value: f.title, placeholder: 'e.g. Lab moved to Thursday', autofocus: true, invalid: !!err, attrs: 'maxlength="100"' }) })
        + field({ id: 'spa-text', label: 'Message', optional: true, control: textarea({ id: 'spa-text', bind: 'spAnn.text', value: f.text, rows: 4, attrs: 'maxlength="1000"' }) })
        + `<div class="mt-8">${checkbox({ label: 'Pin to the top', checked: f.pinned, act: 'sp-ann-pin-toggle' })}</div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn(ann ? 'Save' : 'Post', { v: 'primary', act: 'sp-ann-save' }),
    };
  };
  A['sp-ann-pin-toggle'] = () => { const f = ui('spAnn'); f.pinned = !f.pinned; refreshLayer(); };
  A['sp-ann-save'] = () => {
    const f = ui('spAnn'), { id, ann } = S.modal.props, sp = spaceById(id); if (!sp) return;
    f.tried = true;
    if (!f.title.trim()) { refreshLayer(); $('#spa-title')?.focus(); return; }
    const data = { title: f.title.trim(), text: f.text.trim(), pinned: f.pinned };
    if (ann) Object.assign(sp.announcements.find(a => a.id === ann) || {}, data);
    else (sp.announcements ??= []).unshift({ id: uid('an'), by: me().id, at: Date.now(), ...data });
    audit(ann ? 'Edited announcement' : 'Posted announcement', `${sp.name}: ${data.title}`);
    closeModal(); refresh(); toast(ann ? 'Announcement updated' : 'Announcement posted');
  };
  MENUS['sp-ann'] = el => {
    const sp = spaceById(el.dataset.id), a = sp?.announcements.find(x => x.id === el.dataset.ann); if (!a) return [];
    return [
      { label: 'Edit', icon: 'pencil', run: () => openAnn(sp.id, a.id) },
      { label: a.pinned ? 'Unpin' : 'Pin to the top', icon: a.pinned ? 'x' : 'arrow-up', run: () => { a.pinned = !a.pinned; refresh(); toast(a.pinned ? 'Pinned' : 'Unpinned'); } },
      { sep: true },
      { label: 'Delete', icon: 'trash', danger: true, run: () => {
        const i = sp.announcements.indexOf(a); sp.announcements.splice(i, 1);
        audit('Deleted announcement', `${sp.name}: ${a.title}`); refresh();
        toast('Announcement deleted', { action: { label: 'Undo', run: () => { sp.announcements.splice(i, 0, a); refresh(); } } });
      } },
    ];
  };

  /* ── Materials ── */
  /** Resources from other knowledge bases that staff linked to this space (doc.contexts), readable by the caller. */
  function linkedDocs(sp) {
    const own = new Set(linkedKbs(sp).map(k => k.id));
    return D.docs.filter(d => (d.contexts || []).includes(sp.id) && !own.has(d.kb) && canOpenRes(d) && isReaderVisible(d)).sort((a, b) => b.updated - a.updated);
  }
  const spaceCollections = sp => visibleCollections().filter(c => c.share === 'space:' + sp.id);
  function materialsTab(sp, { manage }) {
    const uk = 'spMat_' + sp.id, kbs = readableKbs(sp), editable = editableKbs(sp), staff = canManageSpace(sp);
    const workflows = hasModule('work') ? workflowsFor(sp) : [];
    const pick = workflows.length > 0;
    const linked = linkedDocs(sp);
    const linkBtnHtml = staff ? btn('Link resources', { icon: 'link-2', act: 'sp-link-res', data: { id: sp.id } }) : '';
    if (!kbs.length && !linked.length) {
      return emptyState({ icon: 'book', title: 'No materials yet', desc: manage ? 'Link a knowledge base so members can read and ask about its documents.' : 'Nothing has been shared here yet.', actions: (manage ? btn('Link knowledge', { v: 'primary', icon: 'link', href: `/space/${sp.id}?tab=settings` }) : '') + linkBtnHtml, boxed: true });
    }
    const all = kbs.flatMap(k => docsIn(k.id));
    const matches = all.filter(d => matchesQ(uk, d.name));
    const linkedMatches = linked.filter(d => matchesQ(uk, d.name));
    const toolbar = `<div class="toolbar">${searchField({ uiKey: uk, placeholder: 'Search materials' })}<div class="toolbar__end">${linkBtnHtml}${editable.length === 1 ? btn('Add materials', { icon: 'upload', act: 'sp-upload', data: { kb: editable[0].id } }) : ''}</div></div>`;
    const linkedGroup = () => (linkedMatches.length ? `<div class="sp-mat"><div class="sp-mat__head">${itemIcon('link-2', '', 'sm')}<span class="sp-mat__name truncate">Linked from other knowledge bases</span><span class="t-sm muted none">${plural(linked.length, 'resource')}</span></div>${X.res.rows(linkedMatches, d => ({ compact: true, trail: staff ? btn('Unlink', { v: 'ghost', size: 'sm', act: 'sp-unlink-res', data: { id: sp.id, doc: d.id } }) : '' }))}</div>` : '');
    const group = kb => {
      const docs = matches.filter(d => d.kb === kb.id).sort((a, b) => b.updated - a.updated);
      const edit = canEditKb(kb), ids = docs.map(d => d.id);
      if (!docs.length && ui(uk).q) return '';
      const headRow = `<div class="sp-mat__head">${X.kbMark ? X.kbMark(kb, 24) : ''}<a class="sp-mat__name truncate" href="#/knowledge/${kb.id}">${esc(kb.name)}</a><span class="t-sm muted none">${plural(docsIn(kb.id).length, 'document')}</span>${edit && editable.length > 1 ? `<span class="grow"></span>${btn('Add documents', { v: 'ghost', size: 'sm', icon: 'upload', act: 'sp-upload', data: { kb: kb.id } })}` : ''}</div>`;
      if (!docs.length) return `<div class="sp-mat">${headRow}${emptyState({ icon: 'files', title: 'No documents yet', desc: edit ? 'Add slides, readings or past papers. They’re published after review.' : '', actions: edit ? btn('Add documents', { icon: 'upload', act: 'sp-upload', data: { kb: kb.id } }) : '', compact: true, boxed: true })}</div>`;
      const rows = docs.map(d => `<tr class="table__row" data-act="go" data-to="/doc/${d.id}" tabindex="0" ${pick && ui(uk).sel?.[d.id] ? 'aria-selected="true"' : ''}>
        ${pick ? selCheck(uk, d.id, 'Select ' + d.name) : ''}
        <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<span class="cell-title truncate">${esc(d.name)}</span></div></td>
        <td class="table__cell sp-nowrap">${esc(rel(d.updated))}</td>
        ${edit ? `<td class="table__cell">${lifeChip(d, 'sm')}</td>` : ''}
      </tr>`);
      return `<div class="sp-mat">${headRow}${table({ label: kb.name, head: (pick ? selAllCheck(uk, ids) : '') + th('Name') + th('Updated') + (edit ? th('Status') : ''), rows })}</div>`;
    };
    const bar = pick ? bulkBar(uk, btn('Use in a workflow', { v: 'primary', size: 'sm', icon: 'sparkles', iconRight: 'chevron-down', menu: 'sp-use', data: { id: sp.id } })) : '';
    const body = gate({
      loading: () => skelRows(6),
      empty: () => emptyState({ icon: 'book', title: 'No materials yet', desc: 'Nothing has been shared here yet.', boxed: true }),
      ok: () => (matches.length || linkedMatches.length || !ui(uk).q ? `<div class="stack gap-24">${kbs.map(group).join('')}${linkedGroup()}</div>` : noMatches(uk, [], 'documents')),
    });
    return `${S.pageState === 'empty' ? '' : toolbar}${body}${bar}`;
  }
  MENUS['sp-use'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return [];
    const uk = 'spMat_' + sp.id, docs = selIds(uk).join(',');
    return [{ section: 'Start with the selected documents' }, ...workflowsFor(sp).map(w => ({ label: w.label, icon: w.icon, run: () => { ui(uk).sel = {}; startWork(w.id, sp.id, docs); } }))];
  };

  /* Link resources from other knowledge bases (space staff). Access doesn't change: readers still need access to the base. */
  A['sp-link-res'] = el => { const sp = spaceById(el.dataset.id); if (!sp || !canManageSpace(sp)) return; S.ui.spLinkRes = { id: sp.id, q: '', picked: [] }; openModal('sp-link-res', {}); };
  M['sp-link-res'] = () => {
    const f = ui('spLinkRes'), sp = spaceById(f.id), own = new Set(linkedKbs(sp).map(k => k.id));
    const found = catalogSearch(parseCatalogQuery({ q: f.q })).rows.map(x => x.doc).filter(d => isReaderVisible(d) && !own.has(d.kb) && !(d.contexts || []).includes(sp.id)).slice(0, 25);
    const rowsHtml = found.map(d => `<div class="res-pick">${checkbox({ checked: f.picked.includes(d.id), act: 'sp-link-res-pick', data: { id: d.id }, label: `<span class="stack"><span class="medium">${esc(d.name)}</span><span class="t-xs muted">${esc(kindMeta(res(d).kind).label)} · ${esc(res(d).kb?.name || '')}</span></span>` })}</div>`).join('');
    return {
      size: 'md', title: 'Link resources', desc: esc(sp.code ? `${sp.name} · ${sp.code}` : sp.name),
      body: `${input({ id: 'splr-q', bind: 'spLinkRes.q', value: f.q, type: 'search', placeholder: 'Search the catalog', autofocus: true, attrs: 'data-live aria-label="Search the catalog"' })}
        <div class="res-picks mt-12 sp-link-picks">${rowsHtml || `<p class="t-sm muted">${f.q ? 'No resources match.' : 'Nothing left to link.'}</p>`}</div>
        <p class="t-xs muted mt-12">Linked resources show in Materials. They stay in their knowledge base, and access doesn’t change.</p>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn(f.picked.length ? `Link ${plural(f.picked.length, 'resource')}` : 'Link', { v: 'primary', act: 'sp-link-res-go', disabled: !f.picked.length }),
    };
  };
  A['sp-link-res-pick'] = el => { const f = ui('spLinkRes'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; refreshLayer(); };
  A['sp-link-res-go'] = () => {
    const f = ui('spLinkRes'), sp = spaceById(f.id); if (!sp || !canManageSpace(sp) || !f.picked.length) return;
    const docs = f.picked.map(docById).filter(Boolean);
    docs.forEach(d => { d.contexts = [...new Set([...(d.contexts || []), sp.id])]; });
    audit('Linked resources to a space', `${sp.name}: ${docs.map(d => d.name).join(', ')}`); persist(); closeModal(); refresh();
    toast(`Linked ${plural(docs.length, 'resource')} to ${sp.code || sp.name}`, { action: { label: 'Undo', run: () => { docs.forEach(d => { d.contexts = (d.contexts || []).filter(x => x !== sp.id); }); persist(); refresh(); } } });
  };
  A['sp-unlink-res'] = el => {
    const sp = spaceById(el.dataset.id), d = docById(el.dataset.doc); if (!sp || !d || !canManageSpace(sp)) return;
    const prev = [...(d.contexts || [])];
    d.contexts = prev.filter(x => x !== sp.id); audit('Unlinked a resource from a space', `${sp.name}: ${d.name}`); persist(); refresh();
    toast(`Unlinked “${d.name}”`, { action: { label: 'Undo', run: () => { d.contexts = prev; persist(); refresh(); } } });
  };

  /* ── Work ── */
  function workTab(sp, { staff }) {
    const works = worksIn(sp), wf = workflowsFor(sp);
    const newBtn = wf.length ? btn('New', { icon: 'plus', iconRight: 'chevron-down', menu: 'sp-new-work', data: { id: sp.id } }) : '';
    const empty = () => emptyState({ icon: 'sparkles', title: 'No work here yet', desc: staff ? 'Quizzes, guides, reviews and drafts made in this space show up here. Drafts stay private until you publish them.' : 'Things you make here, and work the team shares, show up here.', actions: wf.length ? btn(wf[0].label, { v: 'primary', icon: wf[0].icon, act: 'sp-work', data: { workflow: wf[0].id, space: sp.id } }) : '', boxed: true });
    const body = gate({ loading: () => skelRows(4), empty, ok: () => (works.length ? list(works.map(workRow)) : empty()) });
    return `${works.length && S.pageState !== 'empty' ? `<div class="toolbar"><span class="t-sm muted">${plural(works.length, 'item')}</span><div class="toolbar__end">${newBtn}</div></div>` : ''}${body}`;
  }
  MENUS['sp-new-work'] = el => { const sp = spaceById(el.dataset.id); return sp ? workflowsFor(sp).map(w => ({ label: w.label, icon: w.icon, run: () => startWork(w.id, sp.id) })) : []; };

  /* ── Queue (staff) ── */
  function queueTab(sp) {
    const u = ui('spQueue', { show: 'open' });
    const all = spaceRequests(sp);
    const open = all.filter(r => !CLOSED.includes(r.status)).sort((a, b) => a.created - b.created);
    const closed = all.filter(r => CLOSED.includes(r.status)).sort((a, b) => b.updated - a.updated);
    const rows = u.show === 'closed' ? closed : open;
    const noun = queueLabel(sp).toLowerCase();
    const row = r => {
      const t = typeOf(r), who = personName(r.requester);
      const title = t?.question ? (r.fields?.question || t.name) : (t?.name || 'Request');
      const late = WAITING.includes(r.status) && r.due && r.due < NOW;
      const meta = late ? '<span class="sp-late">Overdue</span>' : esc(rel(r.created));
      return item({ lead: avatar(who), title: esc(title), desc: `${esc(who)} · ${esc(r.id)}`, meta, trail: svcChip(r.status), href: '/requests/' + r.id });
    };
    const toolbar = `<div class="toolbar">${seg({ value: u.show, options: [['open', `Open · ${open.length}`], ['closed', 'Closed']], act: 'sp-queue-show', label: 'Show' })}<div class="toolbar__end">${linkBtn('Open in Requests', { href: '/requests?tab=queue', icon: 'arrow-right' })}</div></div>`;
    const empty = () => emptyState({ icon: 'inbox', title: u.show === 'closed' ? `No closed ${noun} yet` : `No open ${noun}`, desc: u.show === 'closed' ? '' : 'You’re all caught up. New ones show up here and in Requests.', boxed: true, compact: true });
    const body = gate({ loading: () => skelRows(4), empty, ok: () => (rows.length ? list(rows.map(row)) : empty()) });
    return toolbar + body;
  }
  A['sp-queue-show'] = el => { ui('spQueue').show = el.dataset.value; refresh(); };

  /* ── People ── */
  function peopleTab(sp, { manage }) {
    const uk = 'spPeople';
    const order = r => spaceType(sp.type).roles.findIndex(x => x[0] === r);
    const rows = sp.members.filter(m => matchesQ(uk, personName(m.user), memberById(m.user)?.email)).sort((a, b) => order(a.role) - order(b.role) || personName(a.user).localeCompare(personName(b.user)));
    const row = m => {
      const name = personName(m.user), you = m.user === me().id;
      const role = manage ? btn(roleLabel(sp, m.role), { v: 'ghost', size: 'sm', iconRight: 'chevron-down', menu: 'sp-member', data: { id: sp.id, user: m.user }, aria: `aria-label="${esc(name)}: ${esc(roleLabel(sp, m.role))}. Change role"` }) : chip(roleLabel(sp, m.role), { size: 'sm', tone: isStaffRole(sp, m.role) ? 'accent' : 'default' });
      return item({ lead: avatar(name), title: esc(name), titleExtra: you ? chip('You', { size: 'sm' }) : '', desc: esc(memberById(m.user)?.email || ''), trail: role });
    };
    const reqs = manage ? (sp.joinRequests || []) : [];
    const reqSection = reqs.length ? section('Requests to join', list(reqs.map(r => item({ lead: avatar(personName(r.user)), title: esc(personName(r.user)), desc: esc(r.note || 'No note'), meta: esc(rel(r.at)), trail: btn('Decline', { v: 'ghost', size: 'sm', act: 'sp-jr', data: { id: sp.id, req: r.id } }) + btn('Approve', { v: 'secondary', size: 'sm', act: 'sp-jr', data: { id: sp.id, req: r.id, ok: 1 } }) }))), { desc: `Approved people join as ${esc(roleLabel(sp, defaultRole(sp)).toLowerCase())}.` }) : '';
    const shownNote = memberTotal(sp) > sp.members.length ? `Showing ${fmtNum(sp.members.length)} of ${plural(memberTotal(sp), sp.type === 'course' ? 'enrolled member' : 'member')}` : plural(sp.members.length, 'member');
    const toolbar = `<div class="toolbar">${searchField({ uiKey: uk, placeholder: 'Search people' })}<div class="toolbar__end"><span class="t-sm muted hide-sm">${shownNote}</span>${manage ? btn('Add people', { icon: 'user-plus', act: 'sp-add', data: { id: sp.id } }) : ''}</div></div>`;
    const body = gate({ loading: () => skelRows(5), ok: () => (rows.length ? list(rows.map(row)) : noMatches(uk, [], 'people')) });
    return `${reqSection}${reqSection ? '<div class="mt-32"></div>' : ''}${toolbar}${body}`;
  }
  const staffNames = sp => spaceType(sp.type).staff.map(k => roleLabel(sp, k).toLowerCase()).join(' or ');
  function guardLastStaff(sp, user, nextRole) {
    const m = sp.members.find(x => x.user === user);
    if (m && isStaffRole(sp, m.role) && !(nextRole && isStaffRole(sp, nextRole)) && staffCount(sp) <= 1) {
      toast(`${sp.name} needs at least one ${staffNames(sp)}. Add another first.`, { tone: 'danger' });
      return false;
    }
    return true;
  }
  MENUS['sp-member'] = el => {
    const sp = spaceById(el.dataset.id), user = el.dataset.user, m = sp?.members.find(x => x.user === user); if (!m) return [];
    return [{ section: 'Role' },
      ...spaceType(sp.type).roles.map(([k, l]) => ({ label: l, checked: m.role === k, run: () => {
        if (m.role === k || !guardLastStaff(sp, user, k)) return;
        const prev = m.role; m.role = k; audit('Changed space role', `${personName(user)} · ${sp.name}: ${l}`); refresh();
        toast(`${personName(user)} is now ${l.toLowerCase()}`, { action: { label: 'Undo', run: () => { m.role = prev; refresh(); } } });
      } })),
      { sep: true },
      { label: user === me().id ? 'Leave space' : 'Remove from space', icon: 'x', danger: true, run: () => {
        if (!guardLastStaff(sp, user, null)) return;
        const i = sp.members.indexOf(m); sp.members.splice(i, 1); sp.memberCount = Math.max(sp.members.length, (sp.memberCount || 1) - 1);
        audit('Removed from space', `${personName(user)} · ${sp.name}`); refresh();
        toast(user === me().id ? `You left ${sp.name}` : `Removed ${personName(user)}`, { action: { label: 'Undo', run: () => { sp.members.splice(i, 0, m); sp.memberCount = (sp.memberCount || 0) + 1; refresh(); } } });
      } }];
  };
  A['sp-jr'] = el => {
    const sp = spaceById(el.dataset.id), r = sp?.joinRequests?.find(x => x.id === el.dataset.req); if (!r) return;
    const ok = !!el.dataset.ok, name = personName(r.user), m = { user: r.user, role: defaultRole(sp) };
    sp.joinRequests = sp.joinRequests.filter(x => x !== r);
    if (ok) { sp.members.push(m); sp.memberCount = (sp.memberCount || 0) + 1; }
    audit(ok ? 'Approved join request' : 'Declined join request', `${name} · ${sp.name}`); refresh();
    toast(ok ? `${name} joined ${sp.name}` : `Declined ${name}’s request`, { action: { label: 'Undo', run: () => {
      if (ok) { sp.members = sp.members.filter(x => x !== m); sp.memberCount = Math.max(sp.members.length, sp.memberCount - 1); }
      sp.joinRequests.push(r); refresh();
    } } });
  };

  /* Add people */
  A['sp-add'] = el => { const sp = spaceById(el.dataset.id); if (!sp) return; S.ui.spAdd = { q: '', sel: {}, role: defaultRole(sp) }; openModal('sp-add', { id: sp.id }); };
  M['sp-add'] = ({ id }) => {
    const sp = spaceById(id), f = ui('spAdd'); if (!sp) return { title: 'Space not found', body: '' };
    const inSpace = new Set(sp.members.map(m => m.user)), q = f.q.trim().toLowerCase();
    const cands = (D.members || []).filter(p => !inSpace.has(p.id) && p.status !== 'suspended' && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
    const n = Object.values(f.sel).filter(Boolean).length;
    const rows = cands.map(p => `<div class="sp-pick">${checkbox({ label: `${avatar(p.name, 'sm')}<span class="stack sp-pick__text"><span class="medium truncate">${esc(p.name)}</span><span class="t-xs muted truncate">${esc(p.email)}</span></span>`, checked: !!f.sel[p.id], act: 'sp-add-pick', data: { user: p.id } })}</div>`).join('');
    return {
      title: `Add people to ${sp.name}`,
      body: `${field({ id: 'spa-q', label: 'Find people', control: `<div class="search-field sp-add-q">${ic('search')}${input({ id: 'spa-q', bind: 'spAdd.q', value: f.q, placeholder: 'Name or email', autofocus: true, attrs: 'data-live', size: 'sm' })}</div>` })}
        <div class="sp-picks" role="group" aria-label="People">${rows || `<p class="t-sm muted sp-picks__empty">${q ? 'No one matches. Try another name.' : 'Everyone in the workspace is already here.'}</p>`}</div>
        ${field({ id: 'spa-role', label: 'Role', control: select({ id: 'spa-role', bind: 'spAdd.role', value: f.role, options: spaceType(sp.type).roles }) })}`,
      footStart: n ? `<span class="t-sm muted">${plural(n, 'person', 'people')} selected</span>` : '',
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Add', { v: 'primary', act: 'sp-add-go', disabled: !n }),
    };
  };
  A['sp-add-pick'] = el => { const s = ui('spAdd').sel; s[el.dataset.user] = !s[el.dataset.user]; refreshLayer(); };
  A['sp-add-go'] = () => {
    const sp = spaceById(S.modal?.props.id), f = ui('spAdd'); if (!sp) return;
    const added = Object.keys(f.sel).filter(k => f.sel[k] && !sp.members.some(m => m.user === k)).map(user => ({ user, role: f.role }));
    if (!added.length) return;
    sp.members.push(...added); sp.memberCount = (sp.memberCount || 0) + added.length;
    audit('Added people to space', `${sp.name}: ${added.map(m => personName(m.user)).join(', ')}`);
    closeModal(); refresh();
    toast(added.length === 1 ? `Added ${personName(added[0].user)}` : `Added ${plural(added.length, 'person', 'people')}`, { action: { label: 'Undo', run: () => { sp.members = sp.members.filter(m => !added.includes(m)); sp.memberCount = Math.max(sp.members.length, sp.memberCount - added.length); refresh(); } } });
  };

  /* ── Settings ── */
  function setForm(sp) {
    let f = S.ui.spSet;
    if (!f || f.id !== sp.id) f = S.ui.spSet = { id: sp.id, name: sp.name, code: sp.code || '', term: sp.term || '', schedule: sp.schedule || '', desc: sp.desc || '', visibility: sp.visibility || 'members', kbs: [...(sp.kbs || [])], tried: false, busy: false };
    return f;
  }
  const TEXT_FIELDS = ['name', 'code', 'term', 'schedule', 'desc'];
  const isDirty = (f, sp) => TEXT_FIELDS.some(k => f[k].trim() !== (sp[k] || '')) || f.visibility !== (sp.visibility || 'members') || [...f.kbs].sort().join() !== [...(sp.kbs || [])].sort().join();
  function visibilityOptions(sp) {
    const ws = esc(curWs().name), t = spaceType(sp.type);
    const o = [
      ['open', 'Open', `Anyone in ${ws} can open it${catalogOf(sp).length ? ' and send requests' : ''}.`],
      ['discoverable', 'Discoverable', 'Anyone can find it and ask to join.'],
      ['members', 'Listed, members only', t.join === 'enrolled' ? 'People can find it; only enrolled members get in.' : 'People can find it; only members get in.'],
      ['private', 'Private', 'Only members can find it.'],
    ];
    return o;
  }
  function settingsTab(sp) {
    const f = setForm(sp), err = (f.tried || f.name.trim() !== sp.name) ? nameError(f.name, sp.id) : '';
    const live = 'data-live';
    const details = field({ id: 'sps-name', label: 'Name', required: true, error: err, control: input({ id: 'sps-name', bind: 'spSet.name', value: f.name, invalid: !!err, onEnter: 'sp-set-save', attrs: `${live} maxlength="${MAX_NAME}"` }) })
      + `<div class="sp-create-row">${field({ id: 'sps-code', label: 'Code', optional: true, control: input({ id: 'sps-code', bind: 'spSet.code', value: f.code, onEnter: 'sp-set-save', attrs: `${live} maxlength="16"` }) })}${field({ id: 'sps-term', label: spaceType(sp.type).join === 'enrolled' ? 'Term' : 'Period', optional: true, control: input({ id: 'sps-term', bind: 'spSet.term', value: f.term, placeholder: sp.type === 'course' ? 'Semester 1 · 2026–2027' : '', onEnter: 'sp-set-save', attrs: `${live} maxlength="40"` }) })}</div>`
      + field({ id: 'sps-schedule', label: 'Schedule and place', optional: true, control: input({ id: 'sps-schedule', bind: 'spSet.schedule', value: f.schedule, placeholder: 'e.g. Tue 07:00–09:30 · A5-302', onEnter: 'sp-set-save', attrs: `${live} maxlength="80"` }) })
      + field({ id: 'sps-desc', label: 'Description', optional: true, control: textarea({ id: 'sps-desc', bind: 'spSet.desc', value: f.desc, rows: 2, attrs: `${live} maxlength="200"` }) });
    const cands = [...new Set([...(sp.kbs || []), ...visibleKbs().filter(k => !k.personal && canReadKb(k)).map(k => k.id)])].map(kbById).filter(k => k && !k.archived);
    const kbRows = cands.length ? cands.map(k => switchRow({ title: k.name, desc: canReadKb(k) ? plural(docsIn(k.id).length, 'document') : 'You can’t read this one', on: f.kbs.includes(k.id), act: 'sp-set-kb', data: { kb: k.id } })).join('')
      : `<p class="t-sm muted">No knowledge bases to link yet.</p>`;
    const vis = choiceGroup({ name: 'sps-vis', value: f.visibility, act: 'sp-set-vis', options: visibilityOptions(sp) });
    const danger = `<div class="card sp-danger"><div class="card__header"><span class="item-icon item-icon--danger">${ic('archive')}</span><div class="grow"><h3 class="card__title">Archive space</h3><p class="card__description">Hides it for everyone. Linked knowledge bases and saved work stay where they are.</p></div>${btn('Archive', { v: 'danger-soft', icon: 'archive', act: 'sp-archive', data: { id: sp.id } })}</div></div>`;
    const bar = isDirty(f, sp) ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes</span>${btn('Discard', { v: 'ghost', act: 'sp-set-discard', disabled: f.busy })}${btn('Save changes', { v: 'primary', act: 'sp-set-save', loading: f.busy, disabled: f.busy })}</div>` : '';
    return gate({
      loading: () => skelRows(4),
      ok: () => `<div class="sp-settings">
        ${formSection('Details', 'Shown on the space page, in Spaces and in search.', details)}
        ${formSection('Knowledge', 'Members can read and ask about linked knowledge bases. Access to each base still applies.', `<div class="stack gap-4">${kbRows}</div>`)}
        ${formSection('Who can find it', '', vis)}
        ${formSection('Archive', '', danger)}
      </div>${bar}`,
    });
  }
  A['sp-set-kb'] = el => { const f = S.ui.spSet; if (!f) return; const k = el.dataset.kb; f.kbs = f.kbs.includes(k) ? f.kbs.filter(x => x !== k) : [...f.kbs, k]; refresh(); };
  A['sp-set-vis'] = el => { const f = S.ui.spSet; if (f) { f.visibility = el.dataset.value; refresh(); } };
  A['sp-set-discard'] = () => { S.ui.spSet = null; refresh(); };
  A['sp-set-save'] = async () => {
    const f = S.ui.spSet, sp = f && spaceById(f.id); if (!sp || f.busy || !isDirty(f, sp)) return;
    f.tried = true;
    if (nameError(f.name, sp.id)) { refresh(); $('#sps-name')?.focus(); return; }
    f.busy = true; refresh(); await sleep(500);
    TEXT_FIELDS.forEach(k => (sp[k] = f[k].trim()));
    sp.visibility = f.visibility; sp.kbs = [...f.kbs];
    audit('Updated space settings', sp.name);
    S.ui.spSet = null; refresh(); toast('Space updated');
  };
  A['sp-archive'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return;
    confirmAction({
      title: `Archive ${sp.name}?`, danger: true, confirm: 'Archive space', typeText: sp.code || sp.name,
      body: 'Members lose the space page, its announcements and queue. Linked knowledge bases and saved work stay where they are.',
      onConfirm: () => {
        sp.archived = true; S.ui.spSet = null; audit('Archived space', sp.name);
        go('/spaces');
        toast(`Archived ${sp.name}`, { action: { label: 'Undo', run: () => { sp.archived = false; audit('Restored space', sp.name); refresh(); } } });
      },
    });
  };
})();

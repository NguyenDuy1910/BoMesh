/* Spaces: the list (/spaces) and one space (/space/:id?tab=overview|materials|
   work|queue|people|settings) — courses, research groups, offices, teams and
   projects. Create a space, ask to join, announcements, materials from linked
   knowledge, the space's work and request queue (the Requests queue, scoped),
   members, settings (incl. request types). Settings opens from the header gear.
   Shared: X.spaceMark(sp, size), X.spaceLinkedDocs(sp), A['space-ask']({dataset:{space, q?}}). Prefix: sp-. */
(() => {
  'use strict';

  const COLORS = ['#2F6FB5', '#0E7C66', '#4E6B2E', '#B4467A', '#6B4FBF', '#C2620F', '#1F7A8C', '#A23B3B'];
  const DEFAULT_VIS = { course: 'members', research: 'discoverable', office: 'open', team: 'discoverable', project: 'members' };
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
  const requestTypesOf = sp => (hasModule('requests') ? (D.requestTypes || []).filter(t => t.space === sp.id && !t.archived) : []);
  const catalogOf = sp => requestTypesOf(sp).filter(t => !t.question);
  const questionType = sp => requestTypesOf(sp).find(t => t.question);
  const queueLabel = sp => (catalogOf(sp).length ? 'Requests' : 'Questions');
  function worksIn(sp) {
    if (!hasModule('work')) return [];
    if (X.worksVisible) return X.worksVisible({ space: sp.id });
    const staff = isSpaceStaff(sp), member = !!spaceRole(sp);
    return (D.works || []).filter(w => w.space === sp.id && (w.owner === me().id || (w.visibility === 'space' && (staff || (member && (sp.type !== 'course' || w.status === 'published'))))))
      .sort((a, b) => b.updated - a.updated);
  }
  // The one work row; inside a space it doesn't repeat the space's name.
  const workRow = w => X.workItem(w, { from: 'space', hideSpace: true });
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
  A['sp-upload'] = el => { const kb = el.dataset.kb; if (A['contribute']) A['contribute']({ dataset: { kb } }); else go(kbHref(kbById(kb))); };

  /* ═══════════════════════════ Spaces list ═══════════════════════════ */
  /** Card: the name is the link (stretched over the card); the call to action is a sibling above it, never nested inside a control. */
  function spaceCard(sp, tab) {
    const t = spaceType(sp.type), role = spaceRole(sp);
    const sub = [sp.code, sp.term].filter(Boolean).join(' · ');
    let cta = '';
    // In Mine every card is a membership, so only roles that carry responsibility are worth a chip.
    if (role) cta = tab !== 'mine' || isStaffRole(sp, role) ? chip(roleLabel(sp, role), { size: 'sm', tone: isStaffRole(sp, role) ? 'accent' : 'default' }) : '';
    // Admins manage every space without joining: say so instead of inviting them to ask.
    else if (canManageSpace(sp)) cta = chip('Manager', { size: 'sm', tone: 'accent', tip: 'You can manage this space as a workspace admin' });
    else {
      const mode = joinMode(sp);
      if (mode === 'enrolled') cta = '<span class="sp-card__note">Enrolled through the student portal</span>';
      else if (mode === 'open') cta = catalogOf(sp).length ? btn('Send a request', { size: 'sm', icon: 'send', act: 'sp-request', data: { space: sp.id } }) : '';
      else cta = myJoinRequest(sp) ? chip('Requested', { tone: 'warning', icon: 'clock', size: 'sm' }) : btn('Request to join', { size: 'sm', act: 'sp-join', data: { id: sp.id } });
    }
    return `<article class="card card--action sp-card">
      <div class="sp-card__top">${spaceMark(sp, 40)}<span class="sp-card__type">${esc(t.label)}</span></div>
      <div class="stack gap-2"><a class="sp-card__name sp-card__link truncate" href="#/space/${sp.id}">${esc(sp.name)}</a>${sub ? `<div class="sp-card__sub truncate">${esc(sub)}</div>` : ''}</div>
      <div class="sp-card__desc clamp-2">${esc(sp.desc || t.desc)}</div>
      <div class="sp-card__foot"><span class="row gap-4">${ic('users', 'i-sm')}${plural(memberTotal(sp), 'member')}</span>${cta ? `<span class="sp-card__cta">${cta}</span>` : ''}</div>
    </article>`;
  }
  function listEmpty(tab, canCreate, useTabs) {
    if (tab === 'mine') {
      const kinds = spaceTypeIds().map(t => spaceType(t).plural.toLowerCase());
      const browse = useTabs ? btn('Browse ' + spaceType(spaceTypeIds()[0]).plural.toLowerCase(), { href: '/spaces?tab=' + spaceTypeIds()[0] }) : '';
      return emptyState({ icon: 'layers', title: 'You’re not in any spaces yet', desc: `Spaces bring people, materials and work together by ${esc(kinds.join(', ').replace(/, ([^,]*)$/, ' and $1'))}.`, actions: (canCreate ? btn('Create space', { v: 'primary', icon: 'plus', act: 'sp-create' }) : '') + browse, boxed: true });
    }
    const t = spaceType(tab);
    return emptyState({ icon: t.icon, title: `No ${t.plural.toLowerCase()} yet`, desc: esc(t.desc), actions: canCreate ? btn(`Create ${t.label.toLowerCase()}`, { v: 'primary', icon: 'plus', act: 'sp-create', data: { type: tab } }) : '', boxed: true });
  }
  P.spaces = ({ query }) => {
    const types = spaceTypeIds(), mine = mySpaces(), visible = visibleSpaces();
    const canCreate = can('knowledge.manage') || isAdmin();
    // A handful of spaces fits on one screen: yours first, then the rest. Type tabs only pay off with many spaces.
    const useTabs = visible.length >= TOOLS_MIN;
    const tabList = [{ id: 'mine', label: 'Mine' }, ...types.map(t => ({ id: t, label: spaceType(t).plural }))];
    const tab = useTabs && tabList.some(t => t.id === query.tab) ? query.tab : 'mine';
    const head = pageHeader({ title: 'Spaces', actions: canCreate ? btn('Create space', { v: 'primary', icon: 'plus', act: 'sp-create', data: { type: tab === 'mine' ? undefined : tab } }) : '' });
    const byName = (a, b) => (spaceRole(b) ? 1 : 0) - (spaceRole(a) ? 1 : 0) || a.name.localeCompare(b.name);
    const all = !useTabs ? visible : tab === 'mine' ? mine : visible.filter(s => s.type === tab).sort(byName);
    const match = s => matchesQ('spList', s.name, s.code, s.desc);
    const toolbar = needsTools(all.length, 'spList') ? `<div class="toolbar">${searchField({ uiKey: 'spList', placeholder: 'Search spaces' })}</div>` : '';
    const grid = (list, t) => `<div class="grid cols-3">${list.map(s => spaceCard(s, t)).join('')}</div>`;
    const sections = () => {
      const ids = new Set(mine.map(s => s.id));
      const yours = mine.filter(match), others = visible.filter(s => !ids.has(s.id)).sort(byName).filter(match);
      if (!yours.length && !others.length) return noMatches('spList', [], 'spaces');
      // While searching, only sections with matches show.
      const yoursBody = yours.length ? grid(yours, 'mine') : ui('spList').q ? '' : emptyState({ icon: 'layers', title: 'You’re not in any spaces yet', desc: 'Open one below to ask to join or send a request.', compact: true, boxed: true });
      return (yoursBody ? section('Your spaces', yoursBody) : '') + (others.length ? section('Other spaces', grid(others, 'other')) : '');
    };
    const body = gate({
      loading: () => skelCards(6),
      empty: () => listEmpty(tab, canCreate, useTabs),
      ok: () => {
        if (!all.length) return listEmpty(tab, canCreate, useTabs);
        if (!useTabs) return sections();
        const rows = all.filter(match);
        return rows.length ? grid(rows, tab) : noMatches('spList', [], 'spaces');
      },
    });
    return `<div class="page">${head}${useTabs ? `<div class="page-tabs">${tabs(tabList, tab, '/spaces')}</div>` : ''}${S.pageState === 'empty' ? '' : toolbar}${body}</div>`;
  };

  /* ── Create ── */
  A['sp-create'] = el => {
    const types = spaceTypeIds(), want = el?.dataset?.type;
    S.ui.spCreate = { type: types.includes(want) ? want : types[0], name: '', code: '', desc: '', kbs: {}, newKb: true, touched: false, busy: false };
    openModal('sp-create', {});
  };
  /** Code suggestion from the name: initials of up to four words (“Field robotics” → FR). */
  const suggestCode = name => name.trim().split(/\s+/).filter(w => /\w/.test(w)).slice(0, 4).map(w => w[0]).join('').toUpperCase();
  /* Knowledge linking, one pattern in Create and Settings: a Switch to start the space's own base, then a Switch per base to link. */
  const newKbRow = (on, act, o = {}) => switchRow({ id: o.id, title: 'Start a new knowledge base for this space', desc: o.desc || 'Named after the space, owned by you. Members contribute to it.', on, act, disabled: o.disabled });
  const kbRow = (k, on, act, o = {}) => switchRow({ title: k.name, desc: canReadKb(k) ? plural(docsIn(k.id).length, 'document') : 'You can’t read this one', on, act, data: { kb: k.id }, disabled: o.disabled });
  M['sp-create'] = () => {
    const f = ui('spCreate'), err = f.touched ? nameError(f.name) : '';
    const types = spaceTypeIds(), dis = f.busy ? 'disabled' : '', t = spaceType(f.type);
    const kbs = visibleKbs().filter(k => !k.personal && canEditKb(k));
    const linked = kbs.filter(k => f.kbs[k.id]);
    const code = suggestCode(f.name), lead = (t.roles.find(r => r[0] === leadRole(f.type)) || [, 'lead'])[1];
    return {
      title: 'Create space', size: 'lg', icon: t.icon || 'layers',
      desc: 'A shared home for people, knowledge and work. You can change everything later.',
      body: `<div class="field sp-types"><span class="label">What kind of space?</span>${choiceGroup({ name: 'spc-type', value: f.type, act: 'sp-create-type', options: types.map(id => [id, spaceType(id).label, esc(spaceType(id).desc), spaceType(id).icon]), cols: Math.min(types.length, 3) })}</div>
        <div class="sp-create-row">
          ${field({ id: 'spc-name', label: 'Name', required: true, error: err, control: input({ id: 'spc-name', bind: 'spCreate.name', value: f.name, placeholder: f.type === 'course' ? 'e.g. Computer Vision' : 'e.g. Field robotics', autofocus: true, onEnter: 'sp-create-go', invalid: !!err, attrs: `maxlength="${MAX_NAME}" data-live ${dis}` }) })}
          ${field({ id: 'spc-code', label: 'Code', optional: true, desc: 'Shown next to the name.', control: input({ id: 'spc-code', bind: 'spCreate.code', value: f.code, placeholder: code || (f.type === 'course' ? 'IT4080' : 'e.g. FR'), onEnter: 'sp-create-go', attrs: `maxlength="16" ${dis}` }) })}
        </div>
        ${field({ id: 'spc-desc', label: 'Short description', optional: true, control: input({ id: 'spc-desc', bind: 'spCreate.desc', value: f.desc, placeholder: 'What happens here, in one line', onEnter: 'sp-create-go', attrs: `maxlength="140" ${dis}` }) })}
        <div class="field"><span class="label">Knowledge</span><div class="description">Members can read and ask about the knowledge bases linked to the space.</div>
          <div class="stack gap-8 mt-8">${newKbRow(f.newKb, 'sp-create-newkb', { id: 'spc-newkb', disabled: f.busy })}
          ${kbs.length ? disclosure({ path: 'spCreate.showKbs', icon: 'link', title: 'Link existing knowledge bases', summary: linked.length ? esc(linked.length === 1 ? linked[0].name : plural(linked.length, 'knowledge base')) : 'None yet', body: `<div class="stack gap-4">${kbs.map(k => kbRow(k, !!f.kbs[k.id], 'sp-create-kb', { disabled: f.busy })).join('')}</div>` }) : ''}</div></div>`,
      footStart: `You’ll be its ${esc(lead.toLowerCase())}.`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Create space', { v: 'primary', icon: 'plus', act: 'sp-create-go', loading: f.busy }),
    };
  };
  A['sp-create-type'] = el => { ui('spCreate').type = el.dataset.value; refreshLayer(); };
  A['sp-create-newkb'] = () => { const f = ui('spCreate'); f.newKb = !f.newKb; refreshLayer(); };
  A['sp-create-kb'] = el => { const f = ui('spCreate'), id = el.dataset.kb; f.kbs[id] = !f.kbs[id]; refreshLayer(); };
  A['sp-create-go'] = async () => {
    const f = ui('spCreate'); if (f.busy) return;
    f.touched = true;
    if (nameError(f.name)) { refreshLayer(); $('#spc-name')?.focus(); return; }
    f.busy = true; S.modal.props.guard = true; refreshLayer();
    await sleep(600);
    const name = f.name.trim(), code = f.code.trim() || suggestCode(name), desc = f.desc.trim(), id = uid('sp');
    const color = COLORS[spaces().length % COLORS.length];
    const sp = { id, type: f.type, name, code, term: '', desc, color, schedule: '', memberCount: 1, visibility: DEFAULT_VIS[f.type] || 'members', kbs: Object.keys(f.kbs).filter(k => f.kbs[k]), members: [{ user: me().id, role: leadRole(f.type) }], announcements: [], joinRequests: [], created: Date.now() };
    if (f.newKb) sp.kbs.unshift(makeSpaceKb(sp).id);
    spaces().push(sp);
    audit('Created space', name);
    closeModal(); go('/space/' + id); toast(`Created “${name}”`);
  };

  /* ── Ask to join ── */
  A['sp-join'] = el => { S.ui.spJoin = { note: '', busy: false }; openModal('sp-join', { id: el.dataset.id }); };
  /** Who reviews join requests: up to two staff names, else the staff role (“the lead”). */
  const reviewers = sp => { const n = sp.members.filter(m => isStaffRole(sp, m.role)).map(m => personName(m.user)); return n.length ? n.slice(0, 2).join(' and ') : `The ${staffNames(sp)}`; };
  M['sp-join'] = ({ id }) => {
    const sp = spaceById(id); if (!sp) return { title: 'Space not found', body: '' };
    const f = ui('spJoin');
    return {
      title: `Ask to join ${sp.name}`, icon: 'user-plus',
      desc: `${esc(reviewers(sp))} will review it. You’ll get in as soon as it’s approved.`,
      body: field({ id: 'spj-note', label: 'Note', optional: true, desc: 'Say who you are and what you’d like to work on.', control: textarea({ id: 'spj-note', bind: 'spJoin.note', value: f.note, rows: 3, attrs: `maxlength="300" data-autofocus ${f.busy ? 'disabled' : ''}` }) }),
      footStart: 'You can withdraw it any time.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Send request', { v: 'primary', icon: 'send', act: 'sp-join-go', loading: f.busy }),
    };
  };
  A['sp-join-go'] = async () => {
    const sp = spaceById(S.modal?.props.id), f = ui('spJoin'); if (!sp || f.busy) return;
    f.busy = true; refreshLayer(); await sleep(400);
    const user = me().id, req = { id: uid('jr'), user, note: (f.note || '').trim(), at: Date.now() };
    (sp.joinRequests ??= []).push(req);
    audit('Asked to join space', sp.name);
    closeModal(); refresh();
    toast(`Request sent to ${reviewers(sp)}`, { action: { label: 'Undo', run: () => { sp.joinRequests = sp.joinRequests.filter(r => r !== req); refresh(); } } });
  };
  A['sp-join-cancel'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return;
    const prev = sp.joinRequests || [];
    sp.joinRequests = prev.filter(r => r.user !== me().id);
    refresh(); toast('Request withdrawn', { action: { label: 'Undo', run: () => { sp.joinRequests = prev; refresh(); } } });
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
  /** Header: one primary per persona. Visitors send a request, members ask the assistant (people are the fallback),
      staff start work. Office staff work the queue, which is where their space opens. Managers get Settings behind a gear. */
  function headerActions(sp, { role, staff, manage, visitor, newInHeader }) {
    const ask = v => btn('Ask AI', { v, icon: 'sparkles', act: 'space-ask', data: { space: sp.id } });
    const gear = manage ? iconBtn('settings', 'Space settings', { href: `/space/${sp.id}?tab=settings` }) : '';
    if (visitor) return ask('tertiary') + (catalogOf(sp).length ? btn('New request', { v: 'primary', icon: 'plus', act: 'sp-request', data: { space: sp.id } }) : '');
    if (staff || (manage && !role)) return ask('tertiary') + (newInHeader ? newWork(sp) : '') + gear;
    const team = sp.type === 'course' ? 'Ask the teaching team' : sp.type === 'office' ? 'Ask the office' : 'Ask the team';
    return (questionType(sp) ? btn(team, { icon: 'users', act: 'sp-ask-staff', data: { space: sp.id } }) : '') + ask('primary') + gear;
  }
  /** One workflow: a direct button named after it. Several: New ▾. */
  function newWork(sp, v = 'primary') {
    const wf = workflowsFor(sp);
    if (wf.length === 1) return btn(wf[0].label, { v, icon: wf[0].icon, act: 'sp-work', data: { workflow: wf[0].id, space: sp.id } });
    return btn('New', { v, icon: 'plus', iconRight: 'chevron-down', menu: 'sp-new', data: { id: sp.id } });
  }
  MENUS['sp-new'] = el => { const sp = spaceById(el.dataset.id); return sp && hasModule('work') ? workflowsFor(sp).map(w => ({ label: w.label, icon: w.icon, run: () => startWork(w.id, sp.id) })) : []; };
  /** Offices whose staff work a request queue: the queue is their space's main view. */
  const isDesk = (sp, staff) => staff && sp.type === 'office' && requestTypesOf(sp).length > 0;
  function tabsFor(sp, { staff, manage, visitor }) {
    const desk = isDesk(sp, staff), t = [];
    const queue = () => { const n = X.requestQueueCount ? X.requestQueueCount(sp.id) : 0; t.push({ id: 'queue', label: queueLabel(sp), count: n || '', alert: n > 0 }); };
    if (desk) queue();
    t.push({ id: 'overview', label: 'Overview' });
    if (readableKbs(sp).length || manage || linkedDocs(sp).length) t.push({ id: 'materials', label: 'Materials' });
    if (visitor) return t;
    if (hasModule('work')) t.push({ id: 'work', label: 'Work' });
    if (staff && !desk && requestTypesOf(sp).length) queue();
    t.push({ id: 'people', label: 'People' });
    return t;
  }
  P.space = ({ params, query }) => {
    const sp = spaceById(params.id);
    if (!sp || sp.archived || (!spaceRole(sp) && sp.visibility === 'private' && !isAdmin())) return unavailable();
    const role = spaceRole(sp), staff = isSpaceStaff(sp), manage = canManageSpace(sp), mode = joinMode(sp);
    const visitor = !role && !manage;
    if (visitor && mode !== 'open') { crumbs([{ label: 'Spaces', to: '/spaces' }, { label: sp.name }]); return lockedPage(sp, mode); }
    // Settings is a rare admin task: its own page behind the header gear, not a sixth tab.
    if (query.tab === 'settings' && manage) {
      crumbs([{ label: 'Spaces', to: '/spaces' }, { label: sp.name, to: '/space/' + sp.id }, { label: 'Settings' }]);
      return `<div class="page">${pageHeader({ title: 'Space settings', lead: spaceMark(sp, 40), desc: esc(sp.name) })}${settingsTab(sp)}</div>`;
    }
    crumbs([{ label: 'Spaces', to: '/spaces' }, { label: sp.name }]);
    const ctx = { role, staff, manage, visitor };
    ctx.newInHeader = (staff || (manage && !role)) && !isDesk(sp, staff) && hasModule('work') && workflowsFor(sp).length > 0;
    const tabList = tabsFor(sp, ctx);
    const tab = tabList.some(t => t.id === query.tab) ? query.tab : tabList[0].id;
    const head = pageHeader({ title: sp.name, lead: spaceMark(sp, 48), desc: `<span class="sp-head__meta">${metaLine(sp)}</span>${peopleLine(sp, !visitor)}`, actions: headerActions(sp, ctx) });
    const body = { overview: overviewTab, materials: materialsTab, work: workTab, queue: queueTab, people: peopleTab }[tab](sp, ctx);
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
  function overviewTab(sp, { manage, visitor, newInHeader }) {
    // The space's own queue is counted on its tab, so Up next leaves it out (Home still shows it). Empty sections are omitted.
    const upcoming = X.upNext ? X.upNext({ space: sp.id, limit: 5, queue: false }) : [];
    const next = upcoming.length ? section('Up next', X.upNextList(upcoming, { space: sp.id })) : '';
    // Staff start work from the header; members get the same workflows here.
    const start = !visitor && !newInHeader && !isSpaceStaff(sp) && hasModule('work') ? workflowsFor(sp).map(w => item({ lead: itemIcon(w.icon, 'accent', 'sm'), title: esc(w.label), desc: `<span class="clamp-2">${esc(w.desc)}</span>`, act: 'sp-work', data: { workflow: w.id, space: sp.id } })) : [];
    const catalog = catalogOf(sp).map(t => item({ lead: itemIcon(t.icon || 'clipboard', '', 'sm'), title: esc(t.name), desc: `<span class="clamp-2">${esc(t.desc)}</span>`, act: 'sp-request', data: { type: t.id, space: sp.id } }));
    const kbs = linkedKbs(sp).filter(k => kbRole(k) !== null).map(k => {
      const ok = canReadKb(k), mark = X.kbMark ? X.kbMark(k, 28, !ok) : itemIcon(ok ? 'book' : 'lock', '', 'sm');
      return item({ lead: mark, title: esc(k.name), desc: ok ? plural(docsIn(k.id).length, 'document') : 'Locked', href: kbHref(k) });
    });
    const side = sideList(catalog.length ? 'What you can request' : '', catalog)
      + sideList('Get started', start)
      + sideList('Knowledge', kbs)
      + sideList('Collections', spaceCollections(sp).map(c => item({ lead: itemIcon('list', 'accent', 'sm'), title: esc(c.name), desc: plural(c.items.length, 'item'), href: '/knowledge/collections/' + c.id })));
    const target = manage && !readableKbs(sp).some(k => docsIn(k.id).length) && editableKbs(sp)[0];
    const setup = target ? `<div class="mb-24">${alertBox('accent', 'Add materials to get started', 'Members can ask about them and use them in workflows.', btn('Contribute documents', { size: 'sm', icon: 'upload', act: 'sp-upload', data: { kb: target.id } }))}</div>` : '';
    return gate({ loading: () => skelRows(4), ok: () => `${setup}<div class="sp-overview"><div class="sp-overview__main">${next}${announcements(sp, manage)}</div>${side ? `<aside class="sp-overview__side">${side}</aside>` : ''}</div>` });
  }
  A['sp-ann-all'] = el => { const m = ui('spView', { allAnn: {} }).allAnn; m[el.dataset.id] = !m[el.dataset.id]; refresh(); };

  /* Announcements: post, edit, pin, delete (managers) */
  function openAnn(spId, annId) {
    const a = annId && spaceById(spId)?.announcements.find(x => x.id === annId);
    S.ui.spAnn = { title: a?.title || '', text: a?.text || '', pinned: !!a?.pinned, tried: false, busy: false };
    openModal('sp-ann', { id: spId, ann: annId || null });
  }
  A['sp-ann-new'] = el => openAnn(el.dataset.id);
  M['sp-ann'] = ({ id, ann }) => {
    const f = ui('spAnn'), sp = spaceById(id), dis = f.busy ? 'disabled' : '';
    const err = f.tried && !f.title.trim() ? 'Enter a title.' : '';
    return {
      title: ann ? 'Edit announcement' : 'Post announcement', icon: ann ? 'pencil' : 'megaphone',
      desc: ann ? 'Changes show on the space page right away.' : `Everyone in ${esc(sp?.name || 'the space')} sees it first on the space page.`,
      body: field({ id: 'spa-title', label: 'Title', required: true, error: err, control: input({ id: 'spa-title', bind: 'spAnn.title', value: f.title, placeholder: 'e.g. Lab moved to Thursday', autofocus: true, onEnter: 'sp-ann-save', invalid: !!err, attrs: `maxlength="100" ${dis}` }) })
        + field({ id: 'spa-text', label: 'Message', optional: true, control: textarea({ id: 'spa-text', bind: 'spAnn.text', value: f.text, rows: 4, placeholder: 'The details members need: what changes, when, what to do.', attrs: `maxlength="1000" ${dis}` }) })
        + `<div class="mt-16">${switchRow({ id: 'spa-pin', title: 'Pin to the top', desc: 'Stays above newer announcements until you unpin it.', on: f.pinned, act: 'sp-ann-pin-toggle', disabled: f.busy })}</div>`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn(ann ? 'Save changes' : 'Post announcement', { v: 'primary', icon: ann ? 'check' : 'send', act: 'sp-ann-save', loading: f.busy }),
    };
  };
  A['sp-ann-pin-toggle'] = () => { const f = ui('spAnn'); f.pinned = !f.pinned; refreshLayer(); };
  A['sp-ann-save'] = async () => {
    const f = ui('spAnn'), { id, ann } = S.modal.props, sp = spaceById(id); if (!sp || f.busy) return;
    f.tried = true;
    if (!f.title.trim()) { refreshLayer(); $('#spa-title')?.focus(); return; }
    f.busy = true; refreshLayer(); await sleep(350);
    const data = { title: f.title.trim(), text: f.text.trim(), pinned: f.pinned };
    const list = (sp.announcements ??= []), cur = ann && list.find(a => a.id === ann);
    const prev = cur && { title: cur.title, text: cur.text, pinned: cur.pinned };
    let made = null;
    if (cur) Object.assign(cur, data);
    else list.unshift(made = { id: uid('an'), by: me().id, at: Date.now(), ...data });
    audit(ann ? 'Edited announcement' : 'Posted announcement', `${sp.name}: ${data.title}`);
    closeModal(); refresh();
    toast(ann ? 'Announcement updated' : `Posted to ${sp.code || sp.name}`, { action: { label: 'Undo', run: () => { if (cur) Object.assign(cur, prev); else sp.announcements = sp.announcements.filter(a => a !== made); refresh(); } } });
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
  /** Resources from other knowledge bases that staff linked to this space (doc.contexts), readable by the caller. Work's source picker offers them too. */
  function linkedDocs(sp) {
    const own = new Set(linkedKbs(sp).map(k => k.id));
    return D.docs.filter(d => (d.contexts || []).includes(sp.id) && !own.has(d.kb) && canOpenRes(d) && isReaderVisible(d)).sort((a, b) => b.updated - a.updated);
  }
  X.spaceLinkedDocs = linkedDocs;
  const spaceCollections = sp => visibleCollections().filter(c => c.share === 'space:' + sp.id);
  /** Add materials ▾ — the one way in: contribute to the space's base, link a knowledge base, link single documents. */
  function addMaterials(sp, v = 'tertiary') {
    const editable = editableKbs(sp), manage = canManageSpace(sp);
    if (!manage) return editable.length === 1 ? btn('Contribute', { v, icon: 'upload', act: 'sp-upload', data: { kb: editable[0].id } }) : '';
    return btn('Add materials', { v, icon: 'plus', iconRight: 'chevron-down', menu: 'sp-add-mat', data: { id: sp.id } });
  }
  MENUS['sp-add-mat'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return [];
    const editable = editableKbs(sp);
    return [
      ...editable.map(kb => ({ label: editable.length === 1 ? 'Contribute documents' : `Contribute to ${kb.name}`, icon: 'upload', run: () => A['sp-upload']({ dataset: { kb: kb.id } }) })),
      ...(canManageSpace(sp) ? [
        { label: 'Link a knowledge base', icon: 'library', run: () => go(`/space/${sp.id}?tab=settings`) },
        { label: 'Link documents', icon: 'link-2', run: () => A['sp-link-res']({ dataset: { id: sp.id } }) },
      ] : []),
    ];
  };
  function materialsTab(sp, { manage }) {
    const uk = 'spMat_' + sp.id, kbs = readableKbs(sp), staff = canManageSpace(sp);
    const pick = hasModule('work') && workflowsFor(sp).length > 0;
    const linked = linkedDocs(sp);
    if (!kbs.length && !linked.length) {
      return emptyState({ icon: 'book', title: 'No materials yet', desc: manage ? 'Link a knowledge base or single documents so members can read and ask about them.' : 'Nothing has been shared here yet.', actions: addMaterials(sp, 'primary'), boxed: true });
    }
    const all = kbs.flatMap(k => docsIn(k.id));
    const matches = all.filter(d => matchesQ(uk, d.name));
    const linkedMatches = linked.filter(d => matchesQ(uk, d.name));
    const add = addMaterials(sp);
    const search = needsTools(all.length + linked.length, uk) ? searchField({ uiKey: uk, placeholder: 'Search materials' }) : '';
    const toolbar = search || add ? `<div class="toolbar">${search}<div class="toolbar__end">${add}</div></div>` : '';
    // One list component for every group: the shared resource row (trust, Save, ⋯). Selecting rows starts a workflow with them.
    const rowOpts = extra => d => ({ compact: true, hide: ['kb'], select: pick ? uk : undefined, ...(extra ? extra(d) : {}) });
    const head = (lead, name, count) => `<div class="sp-mat__head">${lead}${name}<span class="t-sm muted none">${count}</span></div>`;
    const linkedGroup = () => (linkedMatches.length ? `<section class="sp-mat">${head(itemIcon('link-2', '', 'sm'), '<span class="sp-mat__name truncate">Linked from other knowledge bases</span>', plural(linked.length, 'document'))}${X.res.rows(linkedMatches, rowOpts(d => ({ hide: [], trail: staff ? `<span class="reveal-on-hover">${iconBtn('x', 'Unlink from this space', { size: 'sm', act: 'sp-unlink-res', data: { id: sp.id, doc: d.id } })}</span>` : '' })))}</section>` : '');
    const group = kb => {
      const docs = matches.filter(d => d.kb === kb.id).sort((a, b) => b.updated - a.updated);
      const edit = canEditKb(kb);
      if (!docs.length && ui(uk).q) return '';
      const headRow = head(X.kbMark ? X.kbMark(kb, 24) : '', `<a class="sp-mat__name truncate" href="#${kbHref(kb)}">${esc(kb.name)}</a>`, plural(docsIn(kb.id).length, 'document'));
      if (!docs.length) return `<section class="sp-mat">${headRow}${emptyState({ icon: 'files', title: 'No documents yet', desc: edit ? 'Contribute slides, readings or reports. They’re published after review.' : '', actions: edit ? btn('Contribute', { icon: 'upload', act: 'sp-upload', data: { kb: kb.id } }) : '', compact: true, boxed: true })}</section>`;
      return `<section class="sp-mat">${headRow}${X.res.rows(docs, rowOpts())}</section>`;
    };
    const bar = pick ? bulkBar(uk, btn('Use in a workflow', { v: 'primary', size: 'sm', icon: 'sparkles', iconRight: 'chevron-down', menu: 'sp-use', data: { id: sp.id } })) : '';
    const body = gate({
      loading: () => skelRows(6),
      empty: () => emptyState({ icon: 'book', title: 'No materials yet', desc: 'Nothing has been shared here yet.', boxed: true }),
      ok: () => (matches.length || linkedMatches.length || !ui(uk).q ? `<div class="${cx('sp-mats', pick && selCount(uk) && 'has-sel')}">${kbs.map(group).join('')}${linkedGroup()}</div>` : noMatches(uk, [], 'documents')),
    });
    return `${S.pageState === 'empty' ? '' : toolbar}${body}${bar}`;
  }
  MENUS['sp-use'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return [];
    const uk = 'spMat_' + sp.id, docs = selIds(uk).join(',');
    return [{ section: 'Start with the selected documents' }, ...workflowsFor(sp).map(w => ({ label: w.label, icon: w.icon, run: () => { ui(uk).sel = {}; startWork(w.id, sp.id, docs); } }))];
  };

  /* Dialog pickers: a search field over an option list of rich checkbox rows (lead, title, one meta line). */
  const dlgSearch = (id, bind, value, placeholder) => searchField({ id, bind, value, placeholder, size: 'md', full: true, live: true, autofocus: true, label: placeholder });
  const pickRow = ({ id, lead, title, meta, checked, act, data }) => checkbox({ id, checked, act, data, label: `<span class="sp-opt">${lead}<span class="sp-opt__text"><span class="sp-opt__title truncate">${title}</span><span class="sp-opt__meta truncate">${meta}</span></span></span>` });
  const pickError = err => (err ? `<div class="field-error mt-8" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : '');

  /* Link documents from other knowledge bases (space staff). Access doesn't change: readers still need access to the base. */
  A['sp-link-res'] = el => { const sp = spaceById(el.dataset.id); if (!sp || !canManageSpace(sp)) return; S.ui.spLinkRes = { id: sp.id, q: '', picked: [], err: '' }; openModal('sp-link-res', {}); };
  M['sp-link-res'] = () => {
    const f = ui('spLinkRes'), sp = spaceById(f.id), own = new Set(linkedKbs(sp).map(k => k.id)), n = f.picked.length;
    const found = catalogSearch(parseCatalogQuery({ q: f.q })).rows.map(x => x.doc).filter(d => isReaderVisible(d) && !own.has(d.kb) && !(d.contexts || []).includes(sp.id)).slice(0, 25);
    const rows = found.map(d => pickRow({ id: 'splr-' + d.id, lead: fileIcon(d.type, 'sm'), title: esc(d.name), meta: `${esc(kindMeta(res(d).kind).label)} · ${esc(res(d).kb?.name || '')}`, checked: f.picked.includes(d.id), act: 'sp-link-res-pick', data: { id: d.id } })).join('');
    return {
      size: 'lg', title: 'Link documents', icon: 'link-2',
      desc: 'Show documents from other knowledge bases in Materials and use them in workflows. Who can open them doesn’t change.',
      body: `${dlgSearch('splr-q', 'spLinkRes.q', f.q, 'Search by title or topic')}
        ${rows ? `<div class="option-list sp-options mt-12" id="splr-list" data-keep-scroll role="group" aria-label="Documents">${rows}</div>` : `<p class="t-sm muted sp-options__empty">${f.q ? 'No documents match. Try another word.' : 'Every document you can read is already here.'}</p>`}${pickError(f.err)}`,
      footStart: n ? `${plural(n, 'document')} selected` : 'They stay in their knowledge base.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(n ? `Link ${plural(n, 'document')}` : 'Link documents', { v: 'primary', icon: 'link-2', act: 'sp-link-res-go' }),
    };
  };
  A['sp-link-res-pick'] = el => { const f = ui('spLinkRes'), id = el.dataset.id; f.picked = f.picked.includes(id) ? f.picked.filter(x => x !== id) : [...f.picked, id]; f.err = ''; refreshLayer(); };
  A['sp-link-res-go'] = () => {
    const f = ui('spLinkRes'), sp = spaceById(f.id); if (!sp || !canManageSpace(sp)) return;
    if (!f.picked.length) { f.err = 'Select at least one document.'; refreshLayer(); return; }
    const docs = f.picked.map(docById).filter(Boolean);
    docs.forEach(d => { d.contexts = [...new Set([...(d.contexts || []), sp.id])]; });
    audit('Linked documents to a space', `${sp.name}: ${docs.map(d => d.name).join(', ')}`); persist(); closeModal(); refresh();
    toast(`Linked ${plural(docs.length, 'document')} to ${sp.code || sp.name}`, { action: { label: 'Undo', run: () => { docs.forEach(d => { d.contexts = (d.contexts || []).filter(x => x !== sp.id); }); persist(); refresh(); } } });
  };
  A['sp-unlink-res'] = el => {
    const sp = spaceById(el.dataset.id), d = docById(el.dataset.doc); if (!sp || !d || !canManageSpace(sp)) return;
    const prev = [...(d.contexts || [])];
    d.contexts = prev.filter(x => x !== sp.id); audit('Unlinked a document from a space', `${sp.name}: ${d.name}`); persist(); refresh();
    toast(`Unlinked “${d.name}”`, { action: { label: 'Undo', run: () => { d.contexts = prev; persist(); refresh(); } } });
  };

  /* ── Work ── (the same work row as /work, without the space's name) */
  function workTab(sp, { staff, newInHeader }) {
    const works = worksIn(sp), wf = workflowsFor(sp);
    const starts = wf.slice(0, 2).map((w, i) => btn(w.label, { v: i || newInHeader ? 'tertiary' : 'primary', icon: w.icon, act: 'sp-work', data: { workflow: w.id, space: sp.id } })).join('') + (wf.length > 2 ? btn('More', { v: 'ghost', iconRight: 'chevron-down', menu: 'sp-new', data: { id: sp.id } }) : '');
    const empty = () => emptyState({ icon: 'sparkles', title: 'No work here yet', desc: staff ? 'What you make from this space’s materials shows up here. Drafts stay private until you share or send them for review.' : 'Things you make here, and work the team shares, show up here.', actions: starts, boxed: true });
    const body = gate({ loading: () => skelRows(4), empty, ok: () => (works.length ? list(works.map(workRow), 'work-list') : empty()) });
    // Where the header has no New (members, office staff), work starts here.
    const newBtn = !newInHeader && wf.length && works.length && S.pageState !== 'empty' ? `<div class="toolbar"><div class="toolbar__end">${newWork(sp, 'tertiary')}</div></div>` : '';
    return newBtn + body;
  }

  /* ── Queue (staff): the Requests queue, scoped to this space ── */
  const queueTab = sp => (X.requestQueue ? X.requestQueue(sp.id) : '');
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
    // Search appears for the space's real size (not just who's loaded), so anyone in it can be found; no "showing x of y" dead end.
    const search = needsTools(memberTotal(sp), uk) ? searchField({ uiKey: uk, placeholder: 'Search people' }) : '';
    const add = manage ? btn('Add people', { icon: 'user-plus', act: 'sp-add', data: { id: sp.id } }) : '';
    const toolbar = search || add ? `<div class="toolbar">${search}<div class="toolbar__end">${add}</div></div>` : '';
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
  A['sp-add'] = el => { const sp = spaceById(el.dataset.id); if (!sp) return; S.ui.spAdd = { q: '', sel: {}, role: defaultRole(sp), err: '' }; openModal('sp-add', { id: sp.id }); };
  M['sp-add'] = ({ id }) => {
    const sp = spaceById(id), f = ui('spAdd'); if (!sp) return { title: 'Space not found', body: '' };
    const inSpace = new Set(sp.members.map(m => m.user)), q = f.q.trim().toLowerCase();
    const cands = (D.members || []).filter(p => !inSpace.has(p.id) && p.status !== 'suspended' && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)));
    const n = Object.values(f.sel).filter(Boolean).length;
    const rows = cands.map(p => pickRow({ id: 'spa-p-' + p.id, lead: avatar(p.name, 'sm'), title: esc(p.name), meta: esc(p.email), checked: !!f.sel[p.id], act: 'sp-add-pick', data: { user: p.id } })).join('');
    return {
      title: `Add people to ${sp.name}`, icon: 'user-plus',
      desc: 'They can open the space, its materials and its work right away.',
      body: `${dlgSearch('spa-q', 'spAdd.q', f.q, 'Search by name or email')}
        ${rows ? `<div class="option-list sp-options mt-12" id="spa-list" data-keep-scroll role="group" aria-label="People">${rows}</div>` : `<p class="t-sm muted sp-options__empty">${q ? 'No one matches. Try another name.' : 'Everyone in the workspace is already here.'}</p>`}${pickError(f.err)}
        <div class="field sp-role-field mt-16"><span class="label" id="spa-role">Add as</span>${seg({ value: f.role, options: spaceType(sp.type).roles, act: 'sp-add-role', label: 'Add as' })}</div>`,
      footStart: n ? `${plural(n, 'person', 'people')} selected` : 'You can change roles later.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(n ? `Add ${plural(n, 'person', 'people')}` : 'Add people', { v: 'primary', icon: 'user-plus', act: 'sp-add-go' }),
    };
  };
  A['sp-add-pick'] = el => { const f = ui('spAdd'); f.sel[el.dataset.user] = !f.sel[el.dataset.user]; f.err = ''; refreshLayer(); };
  A['sp-add-role'] = el => { ui('spAdd').role = el.dataset.value; refreshLayer(); };
  A['sp-add-go'] = () => {
    const sp = spaceById(S.modal?.props.id), f = ui('spAdd'); if (!sp) return;
    const added = Object.keys(f.sel).filter(k => f.sel[k] && !sp.members.some(m => m.user === k)).map(user => ({ user, role: f.role }));
    if (!added.length) { f.err = 'Select at least one person.'; refreshLayer(); return; }
    sp.members.push(...added); sp.memberCount = (sp.memberCount || 0) + added.length;
    audit('Added people to space', `${sp.name}: ${added.map(m => personName(m.user)).join(', ')}`);
    closeModal(); refresh();
    toast(added.length === 1 ? `Added ${personName(added[0].user)}` : `Added ${plural(added.length, 'person', 'people')}`, { action: { label: 'Undo', run: () => { sp.members = sp.members.filter(m => !added.includes(m)); sp.memberCount = Math.max(sp.members.length, sp.memberCount - added.length); refresh(); } } });
  };

  /* ── Settings ── */
  function setForm(sp) {
    let f = S.ui.spSet;
    if (!f || f.id !== sp.id) f = S.ui.spSet = { id: sp.id, name: sp.name, code: sp.code || '', term: sp.term || '', schedule: sp.schedule || '', desc: sp.desc || '', visibility: sp.visibility || 'members', kbs: [...(sp.kbs || [])], newKb: false, tried: false, busy: false };
    return f;
  }
  const TEXT_FIELDS = ['name', 'code', 'term', 'schedule', 'desc'];
  const isDirty = (f, sp) => TEXT_FIELDS.some(k => f[k].trim() !== (sp[k] || '')) || f.visibility !== (sp.visibility || 'members') || f.newKb || [...f.kbs].sort().join() !== [...(sp.kbs || [])].sort().join();
  const ownKb = sp => linkedKbs(sp).find(k => k.space === sp.id);
  /** The space's own knowledge base (Create, or later from Settings). */
  function makeSpaceKb(sp, { name = sp.name, code = sp.code, desc = sp.desc } = {}) {
    const kb = { id: uid('kb'), name: code ? `${name} · ${code}` : name, desc: desc || `Materials for ${name}.`, color: sp.color, general: 'restricted', memberRole: null, shares: [{ kind: 'user', id: me().id, role: 'owner' }], updated: Date.now(), created: Date.now(), space: sp.id };
    D.kbs.push(kb);
    return kb;
  }
  function visibilityOptions(sp) {
    const ws = esc(curWs().name), t = spaceType(sp.type);
    return [
      ['open', 'Open', `Anyone in ${ws} can open it${catalogOf(sp).length ? ' and send requests' : ''}.`],
      ['discoverable', 'Discoverable', 'Anyone can find it and ask to join.'],
      ['members', 'Listed, members only', t.join === 'enrolled' ? 'People can find it; only enrolled members get in.' : 'People can find it; only members get in.'],
      ['private', 'Private', 'Only members can find it.'],
    ];
  }
  /** Request types: what people can ask this office or team for. Saved from a dialog; delete is immediate with Undo. */
  const takesRequests = sp => hasModule('requests') && sp.type !== 'course';
  function requestTypesSection(sp) {
    const ts = catalogOf(sp);
    const rows = ts.map(t => item({ lead: itemIcon(t.icon || 'clipboard', '', 'sm'), title: esc(t.name), desc: esc([slaWords(t.sla), plural((t.fields || []).length, 'field'), t.checks?.length && plural(t.checks.length, 'rule check')].filter(Boolean).join(' · ')), trail: `<span class="reveal-on-hover">${iconBtn('more', `Options for ${t.name}`, { size: 'sm', menu: 'sp-rt', data: { id: t.id } })}</span>` }));
    const add = btn('New request type', { icon: 'plus', act: 'sp-rt-new', data: { id: sp.id } });
    return ts.length ? `${list(rows)}<div class="mt-12">${add}</div>` : `<div class="stack gap-12"><p class="t-sm muted">${esc(sp.name)} doesn’t take requests yet. Add a type and it shows up in Requests → New request.</p><div>${add}</div></div>`;
  }
  const slaWords = d => (d <= 1 ? 'Next working day' : `${d} working days`);
  function settingsTab(sp) {
    const f = setForm(sp), err = (f.tried || f.name.trim() !== sp.name) ? nameError(f.name, sp.id) : '';
    const live = 'data-live';
    const details = field({ id: 'sps-name', label: 'Name', required: true, error: err, control: input({ id: 'sps-name', bind: 'spSet.name', value: f.name, invalid: !!err, onEnter: 'sp-set-save', attrs: `${live} maxlength="${MAX_NAME}"` }) })
      + `<div class="sp-create-row">${field({ id: 'sps-code', label: 'Code', optional: true, control: input({ id: 'sps-code', bind: 'spSet.code', value: f.code, onEnter: 'sp-set-save', attrs: `${live} maxlength="16"` }) })}${field({ id: 'sps-term', label: spaceType(sp.type).join === 'enrolled' ? 'Term' : 'Dates', optional: true, control: input({ id: 'sps-term', bind: 'spSet.term', value: f.term, placeholder: sp.type === 'course' ? 'Semester 1 · 2026–2027' : 'e.g. Oct 2026 – Mar 2027', onEnter: 'sp-set-save', attrs: `${live} maxlength="40"` }) })}</div>`
      + field({ id: 'sps-schedule', label: 'Schedule and place', optional: true, control: input({ id: 'sps-schedule', bind: 'spSet.schedule', value: f.schedule, placeholder: 'e.g. Tue 07:00–09:30 · A5-302', onEnter: 'sp-set-save', attrs: `${live} maxlength="80"` }) })
      + field({ id: 'sps-desc', label: 'Description', optional: true, control: textarea({ id: 'sps-desc', bind: 'spSet.desc', value: f.desc, rows: 2, attrs: `${live} maxlength="200"` }) });
    // Same pattern as Create: a Switch for the space's own base (until it has one), then a Switch per base to link.
    const cands = [...new Set([...(sp.kbs || []), ...visibleKbs().filter(k => !k.personal && canReadKb(k)).map(k => k.id)])].map(kbById).filter(k => k && !k.archived);
    const row = k => kbRow(k, f.kbs.includes(k.id), 'sp-set-kb');
    const saved = cands.filter(k => (sp.kbs || []).includes(k.id)), rest = cands.filter(k => !(sp.kbs || []).includes(k.id));
    const picked = rest.filter(k => f.kbs.includes(k.id)).length;
    const more = rest.length ? disclosure({ path: 'spSet.moreKbs', icon: 'link', title: 'Link existing knowledge bases', summary: picked ? `${fmtNum(picked)} selected` : `${fmtNum(rest.length)} available`, body: `<div class="stack gap-4">${rest.map(row).join('')}</div>` }) : '';
    const kbRows = (ownKb(sp) ? '' : newKbRow(f.newKb, 'sp-set-newkb', { desc: 'Named after the space, owned by you. Members contribute to it.' })) + saved.map(row).join('') + (more ? `<div class="mt-8">${more}</div>` : '');
    const vis = choiceGroup({ name: 'sps-vis', value: f.visibility, act: 'sp-set-vis', options: visibilityOptions(sp) });
    const danger = `<div class="card sp-danger"><div class="card__header"><span class="item-icon item-icon--danger">${ic('archive')}</span><div class="grow"><h3 class="card__title">Archive space</h3><p class="card__description">Hides it for everyone. Linked knowledge bases and saved work stay where they are.</p></div>${btn('Archive', { v: 'danger-soft', icon: 'archive', act: 'sp-archive', data: { id: sp.id } })}</div></div>`;
    const bar = isDirty(f, sp) ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes</span>${btn('Discard', { v: 'ghost', act: 'sp-set-discard', disabled: f.busy })}${btn('Save changes', { v: 'primary', act: 'sp-set-save', loading: f.busy })}</div>` : '';
    return gate({
      loading: () => skelRows(4),
      ok: () => `<div class="sp-settings">
        ${formSection('Details', 'Shown on the space page, in Spaces and in search.', details)}
        ${formSection('Knowledge', 'Members can read and ask about linked knowledge bases. Access to each base still applies.', `<div class="stack gap-4">${kbRows || '<p class="t-sm muted">No knowledge bases to link yet.</p>'}</div>`)}
        ${takesRequests(sp) ? formSection('Requests', 'What people can ask for, and how soon you usually answer. Changes apply right away.', requestTypesSection(sp)) : ''}
        ${formSection('Who can find it', '', vis)}
        ${formSection('Archive', '', danger)}
      </div>${bar}`,
    });
  }
  A['sp-set-newkb'] = () => { const f = S.ui.spSet; if (!f) return; f.newKb = !f.newKb; refresh(); };
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
    if (f.newKb && !ownKb(sp)) sp.kbs.unshift(makeSpaceKb(sp).id);
    audit('Updated space settings', sp.name);
    S.ui.spSet = null; refresh(); toast('Space updated');
  };
  /* Archiving hides the space from everyone who depends on it, so it asks first (no typed name: that's for workspaces). */
  A['sp-archive'] = el => {
    const sp = spaceById(el.dataset.id); if (!sp) return;
    confirmAction({
      title: `Archive ${sp.name}?`, danger: true, confirm: 'Archive space',
      body: 'Members lose the space page, its announcements and queue. Linked knowledge bases and saved work stay where they are.',
      onConfirm: () => {
        sp.archived = true; S.ui.spSet = null; audit('Archived space', sp.name);
        go('/spaces');
        toast(`Archived ${sp.name}`, { action: { label: 'Undo', run: () => { sp.archived = false; audit('Restored space', sp.name); refresh(); } } });
      },
    });
  };

  /* Request types (office / team Settings) */
  const SLA_OPTS = [['1', 'Next day'], ['2', '2 days'], ['3', '3 days'], ['5', '5 days']];
  function openRt(spId, t) {
    S.ui.spRt = { space: spId, id: t?.id || '', name: t?.name || '', desc: t?.desc || '', sla: String(t?.sla || 2), tried: false };
    openModal('sp-rt', {});
  }
  A['sp-rt-new'] = el => openRt(el.dataset.id);
  M['sp-rt'] = () => {
    const f = ui('spRt'), t = f.id && (D.requestTypes || []).find(x => x.id === f.id), err = f.tried && !f.name.trim() ? 'Name what people can ask for.' : '';
    const form = t ? `<p class="t-sm muted mt-16">${esc([plural((t.fields || []).length, 'field'), t.checks?.length && plural(t.checks.length, 'rule check')].filter(Boolean).join(' · '))} stay as they are.</p>` : `<p class="t-sm muted mt-16">People describe what they need in one Details field. The assistant checks your space’s policies before they send.</p>`;
    return {
      title: t ? 'Edit request type' : 'New request type', icon: 'clipboard', size: 'md',
      desc: 'It shows up in Requests → New request, and requests land in this space’s queue.',
      body: field({ id: 'sprt-name', label: 'Name', required: true, error: err, control: input({ id: 'sprt-name', bind: 'spRt.name', value: f.name, placeholder: 'e.g. New laptop', autofocus: true, onEnter: 'sp-rt-save', invalid: !!err, attrs: 'maxlength="60" data-live' }) })
        + field({ id: 'sprt-desc', label: 'What it’s for', optional: true, control: textarea({ id: 'sprt-desc', bind: 'spRt.desc', value: f.desc, rows: 2, placeholder: 'One line people read before they choose it.', attrs: 'maxlength="160"' }) })
        + `<div class="field mt-16"><span class="label" id="sprt-sla">Usual turnaround</span>${seg({ value: f.sla, options: SLA_OPTS, act: 'sp-rt-sla', label: 'Usual turnaround' })}<div class="description">Working days. Staff see it as the SLA in their queue.</div></div>${form}`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(t ? 'Save changes' : 'Add request type', { v: 'primary', icon: t ? 'check' : 'plus', act: 'sp-rt-save' }),
    };
  };
  A['sp-rt-sla'] = el => { ui('spRt').sla = el.dataset.value; refreshLayer(); };
  A['sp-rt-save'] = () => {
    const f = ui('spRt'), sp = spaceById(f.space); if (!sp || !canManageSpace(sp)) return;
    f.tried = true;
    const name = f.name.trim();
    if (!name) { refreshLayer(); $('#sprt-name')?.focus(); return; }
    const list = (D.requestTypes ??= []), cur = f.id && list.find(x => x.id === f.id);
    const data = { name, desc: f.desc.trim(), sla: +f.sla };
    if (cur) {
      const prev = { name: cur.name, desc: cur.desc, sla: cur.sla };
      Object.assign(cur, data); audit('Edited a request type', `${sp.name}: ${name}`); closeModal(); refresh();
      toast('Request type updated', { action: { label: 'Undo', run: () => { Object.assign(cur, prev); refresh(); } } });
    } else {
      const t = { id: uid('rt'), space: sp.id, icon: 'clipboard', fee: null, fields: [{ id: 'details', label: 'Details', type: 'textarea', required: true }], checks: [], ...data };
      list.push(t); audit('Added a request type', `${sp.name}: ${name}`); closeModal(); refresh();
      toast(`People can now request “${name}”`, { action: { label: 'Undo', run: () => { D.requestTypes = D.requestTypes.filter(x => x !== t); refresh(); } } });
    }
  };
  MENUS['sp-rt'] = el => {
    const t = (D.requestTypes || []).find(x => x.id === el.dataset.id); if (!t) return [];
    return [
      { label: 'Edit', icon: 'pencil', run: () => openRt(t.space, t) },
      { sep: true },
      // Requests already sent keep going; the type just leaves the catalog.
      { label: 'Delete', icon: 'trash', danger: true, run: () => { t.archived = true; audit('Deleted a request type', t.name); refresh(); toast(`Deleted “${t.name}”`, { action: { label: 'Undo', run: () => { delete t.archived; refresh(); } } }); } },
    ];
  };
})();

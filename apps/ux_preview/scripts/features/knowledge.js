/* Manage → Knowledge bases (/bases, /bases/:id): the governed homes their
   owners and editors look after — access, the sources that feed them and their
   details — plus create, share and request access. Readers never navigate bases:
   a base's documents are a Browse filter (kbHref), and locked bases offer
   Request access from Browse (kb-locked). Adding documents goes through
   Contribute (contribute.js); review, publishing and the document inventory
   live in Manage → Documents (curation.js). */
(() => {
  'use strict';

  const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
  const SORTS = { updated: 'Recently updated', name: 'Name', docs: 'Most documents' };
  const COLORS = ['#B4467A', '#C2620F', '#2F6FB5', '#0E7C66', '#6B4FBF', '#1F7A8C', '#4E6B2E', '#A23B3B'];

  /* ── Helpers ── */
  function audit(action, target, type = 'Knowledge') {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type, target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const accessKey = kb => kb.personal ? 'private' : kb.general;
  /** { icon, label, long } in the one access vocabulary (KB_ACCESS in core/lifecycle.js). */
  function kbAccess(kb) {
    if (kb.personal) return { icon: 'user', label: 'Only you', long: 'Only you can see this.' };
    const key = KB_ACCESS[kb.general] ? kb.general : 'restricted', a = KB_ACCESS[key];
    return { icon: a.icon, label: a.label, long: kbAccessDesc(key, kbSpace(kb)?.name) };
  }
  const accessChip = kb => { const a = kbAccess(kb); return chip(a.label, { icon: a.icon, size: 'sm', tip: a.long }); };
  function kbMark(kb, size = 36, locked = false) {
    const st = `--kb-mark:${size}px;${!locked && !kb.personal ? `background:${kb.color || COLORS[0]}` : ''}`;
    const icls = size < 28 ? 'i-xs' : size < 36 ? 'i-sm' : '';
    if (locked) return `<span class="kb-mark kb-mark--muted" style="${st}" aria-hidden="true">${ic('lock', icls)}</span>`;
    if (kb.personal) return `<span class="kb-mark kb-mark--muted" style="${st}" aria-hidden="true">${ic('user', icls)}</span>`;
    return `<span class="kb-mark" style="${st}" aria-hidden="true">${esc((kb.name.trim()[0] || 'K').toUpperCase())}</span>`;
  }
  X.kbMark = kbMark;
  X.kbAccess = kbAccess;
  const shareName = s => s.kind === 'group' ? (groupById(s.id)?.name || 'Group') : (memberById(s.id)?.name || 'Someone');
  const shareLead = (s, size = 'md') => s.kind === 'group' ? itemIcon('users', '', size === 'sm' ? 'sm' : '') : avatar(shareName(s), size);
  const covers = (s, userId) => s.kind === 'user' ? s.id === userId : !!memberById(userId)?.groups.includes(s.id);
  const myRequest = kb => D.requests.find(r => r.kb === kb.id && r.user === me().id && r.status === 'pending');
  function ownersLabel(kb) {
    const o = kb.shares.filter(s => s.role === 'owner').map(shareName);
    return o.length ? 'Owned by ' + o.slice(0, 2).join(', ') + (o.length > 2 ? ` and ${o.length - 2} more` : '') : 'Owned by workspace admins';
  }
  function nameError(name, selfId) {
    const n = (name || '').trim();
    if (!n) return 'Enter a name.';
    if (n.length > 60) return 'Use 60 characters or fewer.';
    const dup = D.kbs.find(k => !k.archived && k.id !== selfId && k.name.trim().toLowerCase() === n.toLowerCase());
    return dup ? `“${dup.name}” already exists. Choose another name.` : '';
  }
  /** The role a demo persona holds as stored on the base: its `access` map entry, or `memberRole` for the Member persona. */
  const storedRole = (kb, key) => (kb.access ? kb.access[key] : key === 'member' ? kb.memberRole : undefined);
  /** Keep the demo personas' roles in step with sharing changes (every persona of this workspace, or only `userIds`).
      Best share covering them wins; otherwise general access, then membership of the owning space (members read its materials). */
  function syncPersonas(kb, userIds) {
    if (!kb || kb.personal) return;
    const sp = kb.space && spaceById(kb.space);
    personasForWs().forEach(key => {
      const id = PERSONAS[key].id;
      if (userIds && !userIds.includes(id)) return;
      const best = kb.shares.filter(x => covers(x, id)).sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role])[0];
      const role = best ? best.role
        : kb.general === 'workspace' ? 'viewer'
          : kb.general === 'private' ? null
            : sp?.members?.some(m => m.user === id) ? 'viewer'
              : storedRole(kb, key) == null ? null : 'none';
      setPersonaKbRole(kb, id, role);
    });
  }
  /** Sync the personas a share covers (all personas when no share is given). */
  const syncShare = (kb, s) => syncPersonas(kb, s ? personasForWs().map(k => PERSONAS[k].id).filter(id => covers(s, id)) : null);
  X.kbSyncPersonas = syncPersonas;
  const snapRoles = kb => ({ memberRole: kb.memberRole, access: kb.access ? { ...kb.access } : null });
  const restoreRoles = (kb, r) => { kb.memberRole = r.memberRole; if (r.access) kb.access = r.access; };
  /** The space that owns a base (Spaces module on only). */
  const kbSpace = kb => (hasModule('spaces') && kb.space ? spaceById(kb.space) : null);
  const spaceChip = sp => chip(sp.code || sp.name, { icon: spaceType(sp.type).icon, size: 'sm', tip: `${spaceType(sp.type).label} · ${sp.name}` });

  /* ═══════════════════════════ Manage → Knowledge bases ═══════════════════════════ */
  function sortKbs(rows, by) {
    const cmp = { updated: (a, b) => b.updated - a.updated, name: (a, b) => a.name.localeCompare(b.name), docs: (a, b) => docsIn(b.id).length - docsIn(a.id).length }[by] || ((a, b) => b.updated - a.updated);
    return [...rows].sort(cmp);
  }
  /** People who decide a base's access requests here: its owners, unless they manage People (workspace admins decide in People → Requests). */
  const decidesHere = kb => kbRole(kb) === 'owner' && !can('user.manage');
  /** One base: what it holds and, for owners who decide here, the access requests waiting on them. */
  function kbCard(kb) {
    const sp = kbSpace(kb), reqs = decidesHere(kb) ? pendingRequests().filter(r => r.kb === kb.id).length : 0;
    const top = `<div class="kb-card__top">${kbMark(kb, 36)}<span class="kb-card__chips">${sp ? spaceChip(sp) : ''}${accessChip(kb)}</span></div>`;
    const text = `<div class="stack gap-2"><div class="kb-card__name truncate">${esc(kb.name)}</div><div class="kb-card__desc truncate">${esc(kb.desc || 'No description')}</div></div>`;
    const end = reqs ? chip(plural(reqs, 'access request'), { tone: 'warning', icon: 'user-plus', size: 'sm' }) : `<span class="truncate">Updated ${rel(kb.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase())}</span>`;
    return `<a class="card card--action kb-card" href="#${kbManageHref(kb)}">${top}${text}<div class="kb-card__foot"><span class="row gap-4">${ic('files', 'i-sm')}${plural(docsIn(kb.id).length, 'document')}</span>${end}</div></a>`;
  }
  P.kbList = () => {
    if (!canManageKbs()) return noAccessPage();
    const u = ui('kbList', { sort: 'updated' }), canCreate = can('knowledge.manage'), all = managedKbs();
    crumbs([{ label: 'Knowledge bases' }]);
    const head = pageHeader({ title: 'Knowledge bases', desc: 'Who can see each one, the sources that feed it and its details. People find the documents in Knowledge.', actions: canCreate ? btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'kb-create' }) : '' });
    const rows = sortKbs(all.filter(k => matchesQ('kbList', k.name, k.desc) && (!u.access || accessKey(k) === u.access)), u.sort);
    // Search, access filter and sort only once there are enough bases to need them (or one is in use).
    const tools = needsTools(all.length, 'kbList', ['access']);
    const toolbar = !tools ? '' : `<div class="toolbar">${searchField({ uiKey: 'kbList', placeholder: 'Search knowledge bases' })}${filterButton('Access', 'kbList', 'access', KB_ACCESS_OPTIONS)}${clearFilters('kbList', ['access'])}<div class="toolbar__end">${btn(SORTS[u.sort], { v: 'ghost', size: 'sm', icon: 'sort', menu: 'kb-sort', aria: `aria-label="Sort: ${esc(SORTS[u.sort])}"` })}</div></div>`;
    const empty = () => emptyState({ icon: 'book', title: 'Create your first knowledge base', desc: 'A knowledge base decides who can see a team’s or a topic’s documents. Add files or connect a source next.', actions: canCreate ? btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'kb-create' }) : '', boxed: true });
    const body = gate({
      loading: () => skelCards(6),
      empty,
      ok: () => !all.length ? empty() : rows.length ? `<div class="grid cols-3">${rows.map(kbCard).join('')}</div>` : noMatches('kbList', ['access'], 'knowledge bases'),
    });
    return `<div class="page">${head}${S.pageState === 'empty' ? '' : toolbar}${body}</div>`;
  };
  MENUS['kb-sort'] = () => [{ section: 'Sort by' }, ...Object.entries(SORTS).map(([v, l]) => ({ label: l, checked: ui('kbList').sort === v, run: () => { ui('kbList').sort = v; refresh(); } }))];

  /* ── Create ── */
  /** Spaces a new base can belong to: the ones the caller runs. */
  const ownSpaces = () => (hasModule('spaces') ? (D.spaces || []).filter(s => !s.archived && canManageSpace(s)) : []);
  A['kb-create'] = () => { S.ui.kbCreate = { name: '', desc: '', access: 'workspace', space: '', touched: false, busy: false }; openModal('kb-create', {}); };
  M['kb-create'] = () => {
    const f = ui('kbCreate'), err = nameError(f.name), dis = f.busy ? 'disabled' : '';
    const shown = f.touched || (f.name.trim() && err.includes('exists')) ? err : '';
    const sp = f.space ? spaceById(f.space) : null, spaces = ownSpaces();
    const access = Object.entries(KB_ACCESS).map(([k, a]) => [k, a.label, esc(kbAccessDesc(k, sp?.name)), a.icon]);
    return {
      title: 'Create knowledge base', icon: 'book', size: 'lg',
      desc: 'A home for a team’s or a topic’s documents. Add files or connect a source next.',
      body: `<div class="kn-form">${spaces.length ? `<div class="kb-create-row">` : ''}${field({ id: 'kbc-name', label: 'Name', required: true, error: shown, counter: `<span class="counter">${f.name.length}/60</span>`, control: input({ id: 'kbc-name', bind: 'kbCreate.name', value: f.name, placeholder: 'e.g. Payments runbooks', autofocus: true, onEnter: 'kb-create-go', invalid: !!shown, attrs: `data-live maxlength="60" ${dis}` }) })}
        ${spaces.length ? field({ id: 'kbc-space', label: 'Space', optional: true, desc: 'Its members can read it, even when restricted.', control: select({ id: 'kbc-space', bind: 'kbCreate.space', value: f.space, change: 'kb-create-space', options: [['', 'No space'], ...spaces.map(s => [s.id, s.code ? `${s.name} · ${s.code}` : s.name])], attrs: dis }) }) + '</div>' : ''}
        ${field({ id: 'kbc-desc', label: 'Description', optional: true, desc: 'Tells people what they can ask about.', control: input({ id: 'kbc-desc', bind: 'kbCreate.desc', value: f.desc, placeholder: 'e.g. Runbooks for the payment rails', onEnter: 'kb-create-go', attrs: `maxlength="200" ${dis}` }) })}
        <div class="field"><span class="label">Who can see it</span>${choiceGroup({ name: 'kbc-access', value: f.access, act: 'kb-create-access', options: access, cols: 3 })}</div></div>`,
      footStart: 'You’ll be its owner. You can change access any time.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'kb-create-go', loading: f.busy }),
    };
  };
  A['kb-create-space'] = () => refreshLayer();
  A['kb-create-access'] = el => { ui('kbCreate').access = el.dataset.value; refreshLayer(); };
  A['kb-create-go'] = async () => {
    const f = ui('kbCreate'); if (f.busy) return;
    f.touched = true;
    if (nameError(f.name)) { refreshLayer(); $('#kbc-name')?.focus(); return; }
    f.busy = true; S.modal.props.guard = true; refreshLayer();
    await sleep(700);
    const name = f.name.trim();
    const sp = f.space ? spaceById(f.space) : null;
    const kb = { id: uid('kb'), name, desc: f.desc.trim(), color: sp?.color || COLORS[D.kbs.length % COLORS.length], general: f.access, access: {}, shares: [{ kind: 'user', id: me().id, role: 'owner' }], updated: Date.now(), created: Date.now(), ...(sp ? { space: sp.id } : {}) };
    D.kbs.push(kb); syncPersonas(kb);
    if (sp && !(sp.kbs ||= []).includes(kb.id)) sp.kbs.push(kb.id);
    audit('Created knowledge base', name);
    closeModal(); go(kbManageHref(kb));
    toast(`Created “${name}”`, { action: { label: 'Contribute', run: () => A['contribute']?.({ dataset: { kb: kb.id } }) } });
  };

  /* ═══════════════════════════ One managed base ═══════════════════════════ */
  /** Owners: access, sources, settings. Editors: the sources that feed it. Its documents are managed in Manage → Documents. */
  function tabsFor(kb) {
    const own = kbRole(kb) === 'owner', t = [];
    if (own) t.push({ id: 'access', label: 'Access', count: pendingRequests().filter(r => r.kb === kb.id).length || '', alert: true });
    t.push({ id: 'sources', label: 'Sources', count: D.sources.filter(s => s.kb === kb.id).length });
    if (own) t.push({ id: 'settings', label: 'Settings' });
    return t;
  }
  function unavailable() {
    crumbs([{ label: 'Knowledge bases', to: '/bases' }, { label: 'Not available' }]);
    return `<div class="page">${emptyState({ icon: 'book', title: 'This knowledge base isn’t available', desc: 'It may have been archived, or you don’t manage it.', actions: btn('Go to Knowledge bases', { v: 'primary', href: '/bases' }), boxed: true })}</div>`;
  }
  P.kbDetail = ({ params, query }) => {
    const kb = kbById(params.id);
    if (!kb || kb.archived || kb.personal || !canEditKb(kb)) return unavailable();
    crumbs([{ label: 'Knowledge bases', to: '/bases' }, { label: kb.name }]);
    const tabList = tabsFor(kb), tab = tabList.some(t => t.id === query.tab) ? query.tab : tabList[0].id;
    // Its documents: the inventory in Manage → Documents for reviewers, otherwise what readers see in Browse.
    // When the review alert shows, its action already leads to Documents, so the header doesn't repeat it (it moves to ⋯).
    const alert = reviewAlert(kb);
    const actions = (alert ? '' : btn('View documents', { icon: 'files', href: docsHrefOf(kb) }))
      + (MENUS['kb-more']({ dataset: { kb: kb.id } }).length ? iconBtn('more', 'More', { menu: 'kb-more', data: { kb: kb.id } }) : '');
    const sp = kbSpace(kb);
    // The owning unit only adds information when it isn't the base's own name ("Payments Platform" owned by Payments Platform).
    const owner = ownerOfKb(kb) === kb.name ? '' : ownerOfKb(kb), topics = (kb.topics || []).map(t => `<a class="res-topic" href="#${X.res.topicHref(t)}">${esc(topicName(t))}</a>`).join('');
    const sub = [kb.desc ? esc(kb.desc) : '', owner || topics ? `<span class="kb-head__meta">${owner ? `<span class="row gap-4 t-sm muted">${ic('building', 'i-sm')}${esc(owner)}</span>` : ''}${topics ? `<span class="res-topics">${topics}</span>` : ''}</span>` : ''].filter(Boolean).join('<br>');
    const head = pageHeader({ title: kb.name, desc: sub, lead: kbMark(kb, 40), extra: accessChip(kb) + (sp ? `<a class="kb-space-link" href="#/space/${esc(sp.id)}">${spaceChip(sp)}</a>` : ''), actions });
    const body = tab === 'sources' ? sourcesTab(kb) : tab === 'settings' ? settingsTab(kb) : accessTab(kb);
    return `<div class="page">${head}${alert}${tabList.length > 1 ? `<div class="page-tabs">${tabs(tabList, tab, kbManageHref(kb))}</div>` : ''}${body}</div>`;
  };
  const docsHrefOf = kb => (can('knowledge.manage') && canReviewKb(kb) ? `/documents?tab=all&kb=${kb.id}` : kbHref(kb));
  /** Rare actions only: access and archiving live in their own tabs (Access, Settings), so they aren't repeated here. */
  MENUS['kb-more'] = el => {
    const kb = kbById(el.dataset.kb); if (!kb) return [];
    const onSources = S.cur.r.page === 'kbDetail' && (S.cur.query.tab || tabsFor(kb)[0].id) === 'sources';
    return [
      reviewAlert(kb) && { label: 'View documents', icon: 'files', run: () => go(docsHrefOf(kb)) },
      can('source.manage') && !onSources && { label: 'Connect source', icon: 'plug', run: () => connect(kb.id) },
      // The link people can open: its documents in Browse.
      { label: 'Copy link', icon: 'link', run: () => copyText(location.href.split('#')[0] + '#' + kbHref(kb), 'Link copied') },
    ].filter(Boolean);
  };
  function connect(kbId) {
    if (A['src-connect']) A['src-connect']({ dataset: { kb: kbId } });
    else goThen('/sources', () => toast('Connect a source from here', { tone: 'accent' }));
  }
  A['kb-connect'] = el => connect(el.dataset.kb);

  /** For the base's reviewers: what's waiting in Manage → Documents, with the task as the action. */
  function reviewAlert(kb) {
    if (!can('knowledge.manage') || !canReviewKb(kb)) return '';
    const docs = curatedDocs().filter(d => d.kb === kb.id);
    const n = docs.filter(d => stageOf(d) === 'review').length, m = docs.filter(d => lifecycleOf(d).key === 'failed').length;
    if (!n && !m) return '';
    const title = [n && `${plural(n, 'submission')} waiting for review`, m && `${plural(m, 'document')} couldn’t be published`].filter(Boolean).join(' · ');
    const actions = (m ? btn('Fix publishing', { v: n ? 'ghost' : 'secondary', size: 'sm', href: `/documents?tab=all&kb=${kb.id}&life=attention` }) : '')
      + (n ? btn(`Review ${fmtNum(n)}`, { v: 'secondary', size: 'sm', href: `/documents?tab=review&kb=${kb.id}` }) : '');
    return `<div class="mb-12">${alertBox(m ? 'warning' : 'accent', title, '', actions, { icon: m ? 'alert' : 'clock' })}</div>`;
  }

  /* ── Sources tab ── */
  function srcLine(s) {
    if (s.status === 'syncing' && s.progress) return `Syncing ${s.progress.done} of ${s.progress.total} documents`;
    const last = s.last?.at ? `Last synced ${rel(s.last.at).toLowerCase()}` : 'Not synced yet';
    const next = s.status === 'paused' || !s.schedule?.on || s.schedule?.freq === 'manual' ? 'Syncs manually' : s.next ? `Next ${relFuture(s.next)}` : '';
    return [last, next].filter(Boolean).join(' · ');
  }
  function sourcesTab(kb) {
    const srcs = D.sources.filter(s => s.kb === kb.id), manage = can('source.manage');
    const empty = () => emptyState({ icon: 'plug', title: 'No sources connected', desc: manage ? 'Connect Google Drive or Confluence to keep this knowledge base up to date.' : 'Documents here are added by hand. Ask an admin to connect a source.', actions: manage ? btn('Connect source', { v: 'primary', icon: 'plug', act: 'kb-connect', data: { kb: kb.id } }) : '', boxed: true });
    return gate({
      loading: () => skelRows(3), empty,
      // The tab already counts the sources: the toolbar only offers connecting another.
      ok: () => !srcs.length ? empty() : (manage ? `<div class="toolbar"><div class="toolbar__end">${btn('Connect source', { size: 'sm', icon: 'plug', act: 'kb-connect', data: { kb: kb.id } })}</div></div>` : '')
        + list(srcs.map(s => item({ lead: appIcon(s.app, 'lg'), title: esc(s.name), titleExtra: X.src?.statusChip ? X.src.statusChip(s) : status('source', s.status), desc: esc(srcLine(s)), meta: esc((s.scope || []).join(', ')), trail: manage ? ic('chevron-right', 'muted') : '', act: manage ? 'kb-src-open' : undefined, data: { id: s.id } }))),
    });
  }
  A['kb-src-open'] = el => { if (A['src-open']) A['src-open']({ dataset: { id: el.dataset.id } }); else go('/sources'); };

  /* ── Access tab ── */
  /** An access request in the owner's words: who, the role they asked for, then their reason. */
  function requestRow(r) {
    const who = memberById(r.user)?.name || 'Someone', role = KB_ROLES[r.role === 'editor' ? 'editor' : 'viewer'];
    return item({
      lead: avatar(who), title: esc(who), titleExtra: chip(role.label, { size: 'sm', tip: role.desc }),
      desc: `${r.note ? `<span class="kb-req__note">“${esc(r.note)}”</span>` : ''}<span class="kb-req__when">${esc(rel(r.at))}</span>`,
      trail: btn('Deny', { size: 'sm', v: 'ghost', act: 'kb-req-deny', data: { id: r.id } }) + btn('Approve', { size: 'sm', v: 'secondary', act: 'kb-req-approve', data: { id: r.id } }),
      cls: 'kb-req',
    });
  }
  /** Owners decide their base's requests here; workspace admins decide every request in People → Requests, so they get a link. */
  function requestsHtml(kb, reqs) {
    if (!reqs.length) return '';
    if (!decidesHere(kb)) return `<div class="mb-16">${alertBox('warning', `${plural(reqs.length, 'person', 'people')} asked for access`, 'You decide access requests for every knowledge base in People.', btn('Open requests', { v: 'secondary', size: 'sm', href: '/people?tab=requests' }), { icon: 'user-plus' })}</div>`;
    return section('Requests', list(reqs.map(requestRow)));
  }
  function accessTab(kb) {
    const st = ui('kbAccess-' + kb.id, { err: null });
    const reqs = pendingRequests().filter(r => r.kb === kb.id), a = kbAccess(kb);
    const general = list([item({
      lead: itemIcon(a.icon), title: esc(a.label), desc: esc(a.long), cls: 'kb-general',
      trail: select({ id: 'kb-general', value: kb.general, options: KB_ACCESS_OPTIONS, change: 'kb-general', size: 'sm', cls: 'kb-select', label: 'General access', attrs: `data-kb="${kb.id}"` }),
    })]);
    const row = s => {
      const key = s.kind + ':' + s.id, isMe = s.kind === 'user' && s.id === me().id;
      const sub = s.kind === 'group' ? plural(groupMembers(s.id).length, 'member') : (memberById(s.id)?.email || '');
      const err = st.err?.key === key ? `<span class="field-error mt-4" role="alert">${ic('alert-circle')}<span>${esc(st.err.msg)}</span></span>` : '';
      return item({
        lead: shareLead(s), title: esc(shareName(s)) + (isMe ? ' <span class="muted" style="font-weight:400">(you)</span>' : ''), desc: esc(sub) + err,
        trail: select({ id: 'kb-role-' + key.replace(':', '-'), value: s.role, options: KB_ROLE_OPTIONS, change: 'kb-role', size: 'sm', cls: 'kb-select', label: 'Role for ' + shareName(s), attrs: `data-kb="${kb.id}" data-key="${key}"` }) + iconBtn('x', 'Remove ' + shareName(s), { size: 'sm', act: 'kb-unshare', data: { kb: kb.id, key } }),
        cls: 'kb-share-row',
      });
    };
    return gate({
      loading: () => skelRows(4),
      ok: () => `<div class="kb-narrow">
        ${requestsHtml(kb, reqs)}
        ${section('General access', general)}
        ${section('People and groups', kb.shares.length ? list(kb.shares.map(row)) : emptyState({ icon: 'users', title: 'Not shared with anyone yet', desc: 'Share it to give people edit or owner rights.', boxed: true, compact: true }), { desc: 'Workspace admins can always manage every knowledge base.', actions: btn('Share', { v: 'secondary', size: 'sm', icon: 'user-plus', act: 'kb-share', data: { kb: kb.id } }) })}
      </div>`,
    });
  }
  A['kb-general'] = el => {
    const kb = kbById(el.dataset.kb), prev = kb.general, roles = snapRoles(kb);
    kb.general = el.value; syncShare(kb); kb.updated = Date.now(); refresh();
    audit('Changed general access', kb.name);
    toast(kbAccess(kb).long, { action: { label: 'Undo', run: () => { kb.general = prev; restoreRoles(kb, roles); refresh(); toast('Access restored'); } } });
  };
  A['kb-role'] = el => {
    const kb = kbById(el.dataset.kb), st = ui('kbAccess-' + kb.id), s = kb.shares.find(x => x.kind + ':' + x.id === el.dataset.key); if (!s) return;
    if (s.role === 'owner' && el.value !== 'owner' && kb.shares.filter(x => x.role === 'owner').length === 1) { st.err = { key: el.dataset.key, msg: 'Every knowledge base needs an owner. Make someone else an owner first.' }; refresh(); return; }
    st.err = null; s.role = el.value; syncShare(kb, s); refresh();
    audit(`Changed role to ${KB_ROLES[s.role].label}`, `${shareName(s)} → ${kb.name}`);
    toast(`${shareName(s)} is now ${s.role === 'owner' ? 'an owner' : 'a' + (s.role === 'editor' ? 'n editor' : ' viewer')}`);
  };
  A['kb-unshare'] = el => {
    const kb = kbById(el.dataset.kb), st = ui('kbAccess-' + kb.id), key = el.dataset.key, s = kb.shares.find(x => x.kind + ':' + x.id === key); if (!s) return;
    if (s.role === 'owner' && kb.shares.filter(x => x.role === 'owner').length === 1) { st.err = { key, msg: 'You can’t remove the last owner. Make someone else an owner first.' }; refresh(); return; }
    st.err = null;
    const remove = () => {
      const i = kb.shares.indexOf(s); if (i < 0) return;
      kb.shares.splice(i, 1); syncShare(kb, s); refresh();
      audit('Removed access', `${shareName(s)} → ${kb.name}`);
      toast(`Removed ${shareName(s)}`, { action: { label: 'Undo', run: () => { kb.shares.splice(i, 0, s); syncShare(kb, s); refresh(); toast(`Restored ${shareName(s)}`); } } });
    };
    if (s.kind === 'user' && s.id === me().id) confirmAction({ title: 'Remove your access?', body: isAdmin() ? 'You’ll still manage it as a workspace admin.' : 'You won’t be able to open it unless someone shares it again.', confirm: 'Remove', danger: true, onConfirm: remove });
    else remove();
  };
  function applyApproval(r) {
    const kb = kbById(r.kb); if (!kb) return;
    const role = r.role === 'editor' ? 'editor' : 'viewer', have = kb.shares.find(s => s.kind === 'user' && s.id === r.user);
    if (!have) kb.shares.push({ kind: 'user', id: r.user, role });
    else if (ROLE_RANK[have.role] < ROLE_RANK[role]) have.role = role;
    syncShare(kb, { kind: 'user', id: r.user });
  }
  A['kb-req-approve'] = el => {
    const r = D.requests.find(x => x.id === el.dataset.id); if (!r) return;
    if (A['req-approve']) A['req-approve']({ dataset: { id: r.id } });
    else { r.status = 'approved'; r.decided = Date.now(); audit('Approved access request', `${memberById(r.user)?.name} → ${kbById(r.kb)?.name}`, 'People'); toast(`Approved ${memberById(r.user)?.name || 'request'}`); }
    if (r.status === 'approved') applyApproval(r);
    refresh();
  };
  A['kb-req-deny'] = el => {
    const r = D.requests.find(x => x.id === el.dataset.id); if (!r) return;
    if (A['req-deny']) A['req-deny']({ dataset: { id: r.id } });
    else { r.status = 'denied'; r.decided = Date.now(); audit('Denied access request', `${memberById(r.user)?.name} → ${kbById(r.kb)?.name}`, 'People'); toast(`Denied ${memberById(r.user)?.name || 'request'}`); }
    refresh();
  };

  /* ── Share modal ── */
  A['kb-share'] = el => { S.ui.kbShare = { kb: el.dataset.kb, q: '', picked: [], role: 'viewer', busy: false, touched: false }; openModal('kb-share', {}); };
  function shareOptions() {
    const f = ui('kbShare'), kb = kbById(f.kb), q = f.q.trim().toLowerCase();
    const taken = new Set([...kb.shares.map(s => s.kind + ':' + s.id), ...f.picked]);
    const groups = D.groups.map(g => ({ key: 'group:' + g.id, kind: 'group', id: g.id, sub: plural(groupMembers(g.id).length, 'member') }));
    const people = D.members.filter(m => m.status === 'active').map(m => ({ key: 'user:' + m.id, kind: 'user', id: m.id, sub: m.email }));
    return [...groups, ...people].filter(o => !taken.has(o.key) && (!q || shareName(o).toLowerCase().includes(q) || o.sub.toLowerCase().includes(q))).slice(0, 6);
  }
  M['kb-share'] = () => {
    const f = ui('kbShare'), kb = kbById(f.kb), opts = shareOptions(), dis = f.busy ? 'disabled' : '';
    const err = f.touched && !f.picked.length ? 'Add at least one person or group.' : '';
    const picked = f.picked.map(k => { const [kind, id] = k.split(':'); const s = { kind, id }; return `<span class="chip chip--soft chip--accent kb-pick">${esc(shareName(s))}<button type="button" data-act="kb-share-unpick" data-key="${k}" aria-label="Remove ${esc(shareName(s))}" ${dis}>${ic('x', 'i-xs')}</button></span>`; }).join('');
    const results = opts.length
      ? list(opts.map(o => item({ lead: shareLead(o, 'sm'), title: esc(shareName(o)), desc: esc(o.sub), trail: ic('plus', 'i-sm muted'), act: 'kb-share-pick', data: { key: o.key } })), 'kb-share-list')
      : `<p class="kb-share-none">${f.q.trim() ? `No one called “${esc(f.q.trim())}” in this workspace.` : 'Everyone already has access.'}</p>`;
    return {
      title: `Share ${kb.name}`, icon: 'user-plus',
      desc: 'Give people or groups access. They can open it right away.',
      body: `<div class="kn-form"><div class="field"><label class="label" for="kbs-q">People or groups</label>${picked ? `<div class="kb-picks">${picked}</div>` : ''}${searchField({ id: 'kbs-q', act: 'kb-share-q', value: f.q, placeholder: 'Search by name or email', label: 'People or groups', size: 'md', full: true, enter: 'kb-share-enter', autofocus: !f.busy })}${err ? `<div class="field-error" id="kbs-q-err" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : ''}${results}</div>
        <div class="field"><span class="label" id="kbs-role-l">Role</span>${seg({ value: f.role, options: Object.entries(KB_ROLES).map(([v, r]) => [v, r.label, r.icon]), act: 'kb-share-role', label: 'Role', full: true })}<div class="description">${esc(KB_ROLES[f.role].desc)}</div></div></div>`,
      footStart: 'Admins can always manage it.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn(f.picked.length > 1 ? `Share with ${f.picked.length}` : 'Share', { v: 'primary', icon: 'user-plus', act: 'kb-share-go', loading: f.busy }),
    };
  };
  A['kb-share-q'] = el => { ui('kbShare').q = el.value; refreshLayer(); };
  A['kb-share-role'] = el => { const f = ui('kbShare'); if (f.busy) return; f.role = el.dataset.value; refreshLayer(); };
  A['kb-share-pick'] = el => { const f = ui('kbShare'); f.picked.push(el.dataset.key); f.q = ''; f.touched = false; refreshLayer(); $('#kbs-q')?.focus(); };
  A['kb-share-unpick'] = el => { const f = ui('kbShare'); f.picked = f.picked.filter(k => k !== el.dataset.key); refreshLayer(); $('#kbs-q')?.focus(); };
  A['kb-share-enter'] = () => { const o = shareOptions()[0]; if (o && ui('kbShare').q.trim()) A['kb-share-pick']({ dataset: { key: o.key } }); else A['kb-share-go'](); };
  A['kb-share-go'] = async () => {
    const f = ui('kbShare'), kb = kbById(f.kb); if (f.busy) return;
    if (!f.picked.length) { f.touched = true; refreshLayer(); $('#kbs-q')?.focus(); return; }
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(600);
    const added = f.picked.map(k => { const [kind, id] = k.split(':'); return { kind, id, role: f.role }; }), roles = snapRoles(kb);
    added.forEach(s => { kb.shares.push(s); syncShare(kb, s); });
    audit(`Shared knowledge base with ${added.map(shareName).join(', ')}`, kb.name);
    closeModal(); refresh();
    toast(`Shared with ${added.length === 1 ? shareName(added[0]) : plural(added.length, 'person or group', 'people and groups')}`, { action: { label: 'Undo', run: () => { kb.shares = kb.shares.filter(s => !added.includes(s)); restoreRoles(kb, roles); refresh(); } } });
  };

  /* ── Settings tab ── */
  function settingsTab(kb) {
    const key = 'kbSet-' + kb.id, f = ui(key, { name: kb.name, desc: kb.desc || '', touched: false, busy: false });
    const err = nameError(f.name, kb.id), shown = f.touched || (f.name.trim() && err.includes('exists')) ? err : '';
    const dirty = f.name.trim() !== kb.name || f.desc.trim() !== (kb.desc || '');
    const n = docsIn(kb.id).length;
    return gate({
      loading: () => skelRows(3),
      ok: () => `<div class="kb-narrow stack gap-16">
        ${card(formSection('Details', 'Shown in Browse filters and when people choose what to ask about.',
          field({ id: 'kbs-name', label: 'Name', required: true, error: shown, counter: `<span class="counter">${f.name.length}/60</span>`, control: input({ id: 'kbs-name', bind: key + '.name', value: f.name, invalid: !!shown, onEnter: 'kb-set-save', attrs: `data-live maxlength="60" data-kb="${kb.id}" ${f.busy ? 'disabled' : ''}` }) })
          + field({ id: 'kbs-desc', label: 'Description', optional: true, counter: `<span class="counter">${f.desc.length}/200</span>`, control: textarea({ id: 'kbs-desc', bind: key + '.desc', value: f.desc, rows: 3, attrs: `data-live maxlength="200" ${f.busy ? 'disabled' : ''}` }) })), { cls: 'card--lg' })}
        ${card(formSection('Archive knowledge base', `${n ? `Removes it and its ${plural(n, 'document')} from answers and search for everyone.` : 'Removes it for everyone.'} You can undo right after.`,
          `<div>${btn('Archive knowledge base', { v: 'danger-soft', icon: 'archive', act: 'kb-archive', data: { kb: kb.id } })}</div>`), { cls: 'card--lg' })}
        ${dirty ? `<div class="savebar"><span class="savebar__text">Unsaved changes</span>${btn('Discard', { v: 'ghost', act: 'kb-set-discard', data: { kb: kb.id }, disabled: f.busy })}${btn('Save', { v: 'primary', act: 'kb-set-save', data: { kb: kb.id }, loading: f.busy })}</div>` : ''}
      </div>`,
    });
  }
  A['kb-set-discard'] = el => { const kb = kbById(el.dataset.kb); S.ui['kbSet-' + kb.id] = { name: kb.name, desc: kb.desc || '', touched: false, busy: false }; refresh(); };
  A['kb-set-save'] = async el => {
    const kb = kbById(el.dataset.kb), f = ui('kbSet-' + kb.id); if (f.busy) return;
    f.touched = true;
    if (nameError(f.name, kb.id)) { refresh(); $('#kbs-name')?.focus(); return; }
    if (f.name.trim() === kb.name && f.desc.trim() === (kb.desc || '')) { refresh(); return; }
    f.busy = true; refresh(); await sleep(600);
    kb.name = f.name.trim(); kb.desc = f.desc.trim(); kb.updated = Date.now();
    S.ui['kbSet-' + kb.id] = { name: kb.name, desc: kb.desc, touched: false, busy: false };
    audit('Updated knowledge base details', kb.name);
    refresh(); toast('Changes saved');
  };
  /** Archiving is reversible: it happens at once, with Undo (no confirmation). */
  A['kb-archive'] = el => {
    const kb = kbById(el.dataset.kb); if (!kb) return;
    kb.archived = true; audit('Archived knowledge base', kb.name); go('/bases');
    toast(`Archived “${kb.name}”`, { action: { label: 'Undo', run: () => { kb.archived = false; audit('Restored knowledge base', kb.name); go(kbManageHref(kb, 'settings')); toast(`Restored “${kb.name}”`); } } });
  };

  /* ═══════════════════════════ Request access ═══════════════════════════ */
  /** What a locked base offers its viewer: Request access, or that the request is pending. */
  const requestAction = (kb, { v = 'secondary', size = 'sm' } = {}) => (myRequest(kb) ? chip('Pending', { tone: 'warning', icon: 'clock', size }) : btn('Request access', { v, size, icon: 'lock', act: 'kb-request', data: { kb: kb.id } }));
  /** Browse filtered to a base the caller can't read: who owns it and how to ask. */
  X.kbLocked = kb => emptyState({
    icon: 'lock', title: myRequest(kb) ? 'Your request is with the owners' : `${kb.name} isn’t shared with you`,
    desc: myRequest(kb) ? `You asked ${rel(myRequest(kb).at).toLowerCase()}. Its documents appear here as soon as it’s approved.` : `${esc(ownersLabel(kb))}. Ask for access to search and read its documents.`,
    actions: requestAction(kb, { v: 'primary', size: '' }), boxed: true, compact: true,
  });
  /** Restricted knowledge (from Browse): the bases people can see exist but can't open, each with Request access. */
  A['kb-locked'] = () => openModal('kb-locked', {});
  M['kb-locked'] = () => {
    const locked = visibleKbs().filter(k => kbRole(k) === 'none');
    return {
      size: 'md', title: 'Restricted knowledge bases', icon: 'lock',
      desc: 'Their documents stay hidden until the owners share them with you.',
      body: locked.length ? list(locked.map(kb => item({ lead: kbMark(kb, 32, true), title: esc(kb.name), desc: esc(kb.desc || ownersLabel(kb)), trail: requestAction(kb) }))) : `<p class="muted">Every knowledge base is shared with you.</p>`,
      foot: btn('Close', { v: 'ghost', act: 'close-modal' }),
    };
  };
  A['kb-request'] = el => { S.ui.kbReq = { kb: el.dataset.kb, role: 'viewer', note: '', touched: false, busy: false }; openModal('kb-request', {}); };
  M['kb-request'] = () => {
    const f = ui('kbReq'), kb = kbById(f.kb), err = f.touched && !f.note.trim() ? 'Tell the owners why you need access.' : '', dis = f.busy ? 'disabled' : '';
    return {
      size: 'md', title: 'Request access', icon: 'lock',
      desc: `Ask the owners of ${esc(kb.name)} to share it with you.`,
      body: `<div class="kn-form"><div class="field kb-req-access"><span class="label">Access you need</span>${choiceGroup({ name: 'kbr-role', value: f.role, act: 'kb-req-role', cols: 2, options: ['viewer', 'editor'].map(k => [k, KB_ROLES[k].label, esc(KB_ROLES[k].desc), KB_ROLES[k].icon]) })}</div>
        ${field({ id: 'kbr-note', label: 'Reason', required: true, error: err, desc: 'The owners see this with your request.', control: textarea({ id: 'kbr-note', bind: 'kbReq.note', value: f.note, rows: 3, placeholder: 'e.g. I need the settlement cut-off times for an incident review', invalid: !!err, attrs: `maxlength="300" data-autofocus data-input="kn-revalidate" data-form="kbReq" ${dis}` }) })}</div>`,
      footStart: `${ic('users', 'i-sm')}<span>${esc(ownersLabel(kb))}</span>`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Send request', { v: 'primary', icon: 'send', act: 'kb-req-send', loading: f.busy }),
    };
  };
  A['kb-req-role'] = el => { ui('kbReq').role = el.dataset.value; refreshLayer(); };
  A['kb-req-send'] = async () => {
    const f = ui('kbReq'), kb = kbById(f.kb); if (f.busy) return;
    f.touched = true;
    if (!f.note.trim()) { refreshLayer(); $('#kbr-note')?.focus(); return; }
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(700);
    const req = { id: uid('req'), user: me().id, kb: kb.id, role: f.role, note: f.note.trim(), at: Date.now(), status: 'pending' };
    D.requests.unshift(req);
    audit('Requested access', kb.name, 'People');
    closeModal(); refresh();
    toast(`Request sent to the owners of ${kb.name}`, { action: { label: 'Undo', run: () => { const i = D.requests.indexOf(req); if (i >= 0) D.requests.splice(i, 1); refresh(); } } });
  };
})();

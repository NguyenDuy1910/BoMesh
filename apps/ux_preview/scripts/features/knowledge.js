/* Knowledge Studio → Collections (/studio?tab=collections, /studio/collections/:id): the governed homes their owners and
   editors look after — their Contents (the folder structure Home draws, the documents in it, and folders with their own
   access), access, the sources that feed them and their details — plus create, share and request access. Readers never
   navigate bases: a base's documents are a Browse filter (kbHref), and locked bases offer Request access from Browse
   (kb-locked). Adding documents goes through Contribute (contribute.js); review, publishing fixes and the cross-collection
   registry live in Knowledge Studio → Review and Documents (curation.js). */
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

  /* ═══════════════════════════ Manage → Collections ═══════════════════════════ */
  function sortKbs(rows, by) {
    const cmp = { updated: (a, b) => b.updated - a.updated, name: (a, b) => a.name.localeCompare(b.name), docs: (a, b) => docsIn(b.id).length - docsIn(a.id).length }[by] || ((a, b) => b.updated - a.updated);
    return [...rows].sort(cmp);
  }
  /** People who decide a base's access requests here: its owners, unless they manage People (workspace admins decide in People → Requests). */
  const decidesHere = kb => kbRole(kb) === 'owner' && !can('user.manage');
  /** The topics a base mostly holds (its documents' own topics, else the ones set on the base): up to two names. */
  function topTopics(kb, n = 2) {
    const tally = new Map();
    docsIn(kb.id).forEach(d => (d.topics || []).forEach(id => tally.set(id, (tally.get(id) || 0) + 1)));
    const ids = tally.size ? [...tally].sort((a, b) => b[1] - a[1]).map(([id]) => id) : kb.topics || [];
    return ids.filter(id => topicById(id)).slice(0, n).map(topicName);
  }
  /** Documents that live in another base but are linked into this one (kb.links: document ids; no copy, no grant). */
  const linkedCount = kb => (kb.links || []).filter(id => { const d = docById(id); return d && !d.archived && d.kb !== kb.id; }).length;
  /** One base: what it holds and, for owners who decide here, the access requests waiting on them. */
  function kbCard(kb) {
    const sp = kbSpace(kb), reqs = decidesHere(kb) ? pendingRequests().filter(r => r.kb === kb.id).length : 0;
    const top = `<div class="kb-card__top">${kbMark(kb, 36)}<span class="kb-card__chips">${sp ? spaceChip(sp) : ''}${accessChip(kb)}</span></div>`;
    const topics = topTopics(kb), linked = linkedCount(kb);
    const about = topics.length ? `<div class="kb-card__topics truncate" data-tip="Topics it mostly holds">${ic('tag', 'i-xs')}<span class="truncate" translate="no">${esc(topics.join(' · '))}</span></div>` : '';
    const text = `<div class="stack gap-2"><div class="kb-card__name truncate">${esc(kb.name)}</div><div class="kb-card__desc truncate">${esc(kb.desc || 'No description')}</div>${about}</div>`;
    const end = reqs ? chip(plural(reqs, 'access request'), { tone: 'warning', icon: 'user-plus', size: 'sm' }) : `<span class="truncate">Updated ${rel(kb.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase())}</span>`;
    const nFolders = (D.folders || []).filter(f => f.kb === kb.id && canReadFolder(f.id)).length;
    const count = `<span class="row gap-4">${ic('files', 'i-sm')}${plural(docsIn(kb.id).length, 'document')}${nFolders ? `<span class="muted">${esc(` · ${plural(nFolders, 'folder')}`)}</span>` : ''}${linked ? `<span class="muted" data-tip="Documents from other collections shown here without a copy">${esc(` · ${fmtNum(linked)} linked`)}</span>` : ''}</span>`;
    return `<a class="card card--action kb-card" href="#${kbManageHref(kb)}">${top}${text}<div class="kb-card__foot">${count}${end}</div></a>`;
  }
  /** Knowledge Studio → Collections (the Studio owns the header and its Create action). */
  function basesTab() {
    const u = ui('kbList', { sort: 'updated' }), canCreate = can('knowledge.manage'), all = managedKbs();
    const rows = sortKbs(all.filter(k => matchesQ('kbList', k.name, k.desc) && (!u.access || accessKey(k) === u.access)), u.sort);
    // Search, access filter and sort only once there are enough bases to need them (or one is in use).
    const tools = needsTools(all.length, 'kbList', ['access']);
    const toolbar = !tools ? '' : `<div class="toolbar">${searchField({ uiKey: 'kbList', placeholder: 'Search collections' })}${filterButton('Access', 'kbList', 'access', KB_ACCESS_OPTIONS)}${clearFilters('kbList', ['access'])}<div class="toolbar__end">${btn(SORTS[u.sort], { v: 'ghost', size: 'sm', icon: 'sort', menu: 'kb-sort', aria: `aria-label="Sort: ${esc(SORTS[u.sort])}"` })}</div></div>`;
    const empty = () => emptyState({ icon: 'book', title: 'Create your first collection', desc: 'A collection decides who can read a team’s or a function’s documents. Sources and uploads land in one.', actions: canCreate ? btn('Create collection', { v: 'primary', icon: 'plus', act: 'kb-create' }) : '', boxed: true });
    const body = gate({
      loading: () => skelCards(6),
      empty,
      ok: () => !all.length ? empty() : rows.length ? `<div class="grid cols-3">${rows.map(kbCard).join('')}</div>` : noMatches('kbList', ['access'], 'collections'),
    });
    return `${S.pageState === 'empty' ? '' : toolbar}${body}`;
  }
  X.kb = { ...(X.kb || {}), tab: basesTab };
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
      title: 'Create collection', icon: 'book', size: 'lg',
      desc: 'A home for a team’s or a topic’s documents. Add files or connect a source next.',
      body: `<div class="kn-form">${spaces.length ? `<div class="kb-create-row">` : ''}${field({ id: 'kbc-name', label: 'Name', required: true, error: shown, counter: `<span class="counter">${f.name.length}/60</span>`, control: input({ id: 'kbc-name', bind: 'kbCreate.name', value: f.name, placeholder: 'e.g. Payments runbooks', autofocus: true, onEnter: 'kb-create-go', invalid: !!shown, attrs: `data-live maxlength="60" ${dis}` }) })}
        ${spaces.length ? field({ id: 'kbc-space', label: 'Space', optional: true, desc: 'Its members can read it, even when restricted.', control: select({ id: 'kbc-space', bind: 'kbCreate.space', value: f.space, change: 'kb-create-space', options: [['', 'No space'], ...spaces.map(s => [s.id, s.code ? `${s.name} · ${s.code}` : s.name])], attrs: dis }) }) + '</div>' : ''}
        ${field({ id: 'kbc-desc', label: 'Description', optional: true, desc: 'Tells people what they can ask about.', control: input({ id: 'kbc-desc', bind: 'kbCreate.desc', value: f.desc, placeholder: 'e.g. Runbooks for the payment rails', onEnter: 'kb-create-go', attrs: `maxlength="200" ${dis}` }) })}
        <div class="field"><span class="label">Who can see it</span>${choiceGroup({ name: 'kbc-access', value: f.access, act: 'kb-create-access', options: access, cols: 3 })}</div></div>`,
      footStart: 'You’ll be its owner. You can change access any time.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal', disabled: f.busy }) + btn('Create collection', { v: 'primary', icon: 'plus', act: 'kb-create-go', loading: f.busy }),
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
    audit('Created collection', name);
    closeModal(); go(kbManageHref(kb));
    toast(`Created “${name}”`, { action: { label: 'Contribute', run: () => A['contribute']?.({ dataset: { kb: kb.id } }) } });
  };

  /* ═══════════════════════════ One managed base ═══════════════════════════ */
  /** Contents (its folders and documents) for everyone who edits it; owners also get Access; Sources for all. Its name and
      description are edited in place on the header and archiving is in ⋯, so there's no Settings tab. */
  function tabsFor(kb) {
    const own = kbRole(kb) === 'owner', t = [{ id: 'contents', label: 'Contents' }];
    if (own) t.push({ id: 'access', label: 'Access', count: pendingRequests().filter(r => r.kb === kb.id).length || '', alert: true });
    t.push({ id: 'sources', label: 'Sources', count: D.sources.filter(s => s.kb === kb.id).length });
    return t;
  }
  function unavailable() {
    crumbs([{ label: 'Knowledge Studio', to: studioHref('collections') }, { label: 'Not available' }]);
    return `<div class="page">${emptyState({ icon: 'book', title: 'This collection isn’t available', desc: 'It may have been archived, or you don’t manage it.', actions: btn('Go to Collections', { v: 'primary', href: studioHref('collections') }), boxed: true })}</div>`;
  }
  P.kbDetail = ({ params, query }) => {
    const kb = kbById(params.id);
    if (!kb || kb.archived || kb.personal || !canEditKb(kb)) return unavailable();
    crumbs([{ label: 'Knowledge Studio', to: '/studio' }, { label: 'Collections', to: studioHref('collections') }, { label: kb.name }]);
    const tabList = tabsFor(kb), tab = tabList.some(t => t.id === query.tab) ? query.tab : tabList[0].id;
    const folder = tab === 'contents' && folderById(query.folder)?.kb === kb.id && canReadFolder(query.folder) ? folderById(query.folder) : null;
    // One primary: adding documents, into the folder on screen (they go through Review like every contribution).
    const add = contributionTargets().includes(kb) ? btn('Add documents', { v: 'primary', icon: 'upload', act: 'contribute', data: { kb: kb.id, folder: folder?.id || '' } }) : '';
    const actions = add + (MENUS['kb-more']({ dataset: { kb: kb.id } }).length ? iconBtn('more', 'More', { menu: 'kb-more', data: { kb: kb.id } }) : '');
    const sp = kbSpace(kb);
    // The owning unit only adds information when it isn't the base's own name ("Payments Platform" owned by Payments Platform).
    const owner = ownerOfKb(kb) === kb.name ? '' : ownerOfKb(kb), topics = (kb.topics || []).map(t => `<a class="res-topic" href="#${X.res.topicHref(t)}">${esc(topicName(t))}</a>`).join('');
    // Its owners rename it on the title and describe it on the line under it (each applies at once, with Undo); everyone
    // else reads them.
    const own = kbRole(kb) === 'owner', r = S.ui[KR]?.id === kb.id ? S.ui[KR] : null, dd = S.ui[KD]?.id === kb.id ? S.ui[KD] : null;
    const descHtml = own ? editableTitle({ id: 'kb-desc', tag: 'span', cls: cx('kb-desc-edit', !kb.desc && !dd && 'is-empty'), value: dd ? dd.val : kb.desc || addDesc(), editing: !!dd, edit: 'kb-describe', commit: 'kb-describe-done', cancel: 'kb-describe-cancel', label: 'Edit description', maxlength: 200, placeholder: 'e.g. Runbooks for the payment rails', data: { kb: kb.id } })
      : kb.desc ? esc(kb.desc) : '';
    const sub = [descHtml, owner || topics ? `<span class="kb-head__meta">${owner ? `<span class="row gap-4 t-sm muted">${ic('building', 'i-sm')}${esc(owner)}</span>` : ''}${topics ? `<span class="res-topics">${topics}</span>` : ''}</span>` : ''].filter(Boolean).join('<br>');
    const heading = own ? editableTitle({ id: 'kb-name', value: r ? r.val : kb.name, editing: !!r, edit: 'kb-rename', commit: 'kb-rename-done', cancel: 'kb-rename-cancel', tag: 'h1', cls: 'page-hero__title', label: 'Rename collection', maxlength: 60, error: r?.err || '', data: { kb: kb.id } }) : '';
    const head = pageHeader({ title: kb.name, heading, desc: sub, lead: kbMark(kb, 40), extra: accessChip(kb) + (sp ? `<a class="kb-space-link" href="#/space/${esc(sp.id)}">${spaceChip(sp)}</a>` : ''), actions });
    const body = tab === 'sources' ? sourcesTab(kb) : tab === 'access' ? accessTab(kb) : contentsTab(kb, folder);
    return `<div class="page">${head}${reviewAlert(kb)}${tabList.length > 1 ? contextBar(tabs(tabList, tab, kbManageHref(kb))) : ''}${body}</div>`;
  };
  /* ── Rename: the title itself (owners) ── */
  const KR = 'kbRename';
  A['kb-rename'] = el => { const kb = kbById(el.dataset.kb); if (!kb || kbRole(kb) !== 'owner') return; S.ui[KR] = { id: kb.id, val: kb.name, err: '' }; refresh(); };
  A['kb-rename-cancel'] = () => { if (!S.ui[KR]) return; S.ui[KR] = null; refresh(); };
  /** Enter or leaving the title. Idempotent; an empty or unchanged name just closes it. */
  A['kb-rename-done'] = el => {
    const r = S.ui[KR], kb = r && kbById(r.id); if (!kb) return;
    const name = el.value.trim();
    if (!name || name === kb.name) { S.ui[KR] = null; refresh(); return; }
    const err = nameError(name, kb.id);
    if (err) { Object.assign(r, { val: el.value, err }); refresh(); return; }
    const before = kb.name;
    S.ui[KR] = null; kb.name = name; kb.updated = Date.now();
    audit('Renamed collection', `${before} → ${name}`); refresh();
    toast(`Renamed to “${name}”`, { action: { label: 'Undo', run: () => { kb.name = before; audit('Undid a rename', `${name} → ${before}`); refresh(); } } });
  };
  /* ── Describe: the line under the title (owners) ── */
  const KD = 'kbDescEdit';
  A['kb-describe'] = el => { const kb = kbById(el.dataset.kb); if (!kb || kbRole(kb) !== 'owner') return; S.ui[KD] = { id: kb.id, val: kb.desc || '' }; refresh(); };
  A['kb-describe-cancel'] = () => { if (!S.ui[KD]) return; S.ui[KD] = null; refresh(); };
  /** Enter or leaving it. Idempotent; emptying it removes the description. */
  A['kb-describe-done'] = el => {
    const r = S.ui[KD], kb = r && kbById(r.id); if (!kb) return;
    const v = el.value.trim(), before = kb.desc || '';
    S.ui[KD] = null;
    if (v === before) { refresh(); return; }
    kb.desc = v; kb.updated = Date.now();
    audit('Updated collection details', kb.name); refresh();
    toast(v ? 'Description updated' : 'Description removed', { action: { label: 'Undo', run: () => { kb.desc = before; refresh(); } } });
  };
  /** Rare actions only: contents and access live in their own tabs, so they aren't repeated here. */
  MENUS['kb-more'] = el => {
    const kb = kbById(el.dataset.kb); if (!kb) return [];
    return [
      // Every document with its processing and publication, for its reviewers; what readers see for everyone.
      can('knowledge.manage') && canReviewKb(kb) && { label: 'Open in Documents', icon: 'files', run: () => go(docsHref('all', { kb: kb.id })) },
      { label: 'Open in Knowledge', icon: 'book', run: () => go(kbHref(kb)) },
      can('source.manage') && X.src?.openWizard && { label: 'Add source', icon: 'plug', run: () => X.src.openWizard({ kb: kb.id }) },
      // The link people can open: its documents in Browse.
      { label: 'Copy link', icon: 'link', run: () => copyText(location.href.split('#')[0] + '#' + kbHref(kb), 'Link copied') },
      // Archiving is reversible (Undo), so it's a plain menu item, not a form of its own.
      kbRole(kb) === 'owner' && { sep: true },
      kbRole(kb) === 'owner' && { label: 'Archive collection', icon: 'archive', danger: true, run: () => A['kb-archive']({ dataset: { kb: kb.id } }) },
    ].filter(Boolean);
  };

  /** For the base's reviewers: what's waiting in Documents → Processing (submissions to process first, what couldn't be
      processed) and Review, with the next task as the action. */
  function reviewAlert(kb) {
    if (!can('knowledge.manage') || !canReviewKb(kb)) return '';
    const docs = curatedDocs().filter(d => d.kb === kb.id);
    const n = docs.filter(readyToReview).length, p = docs.filter(d => isCandidate(d) && processingOf(d) === 'pending').length, m = docs.filter(d => lifecycleOf(d).key === 'failed' || (isCandidate(d) && processingOf(d) === 'failed')).length;
    if (!n && !p && !m) return '';
    const title = [p && `${plural(p, 'submission')} waiting to be processed`, n && `${plural(n, 'submission')} waiting for review`, m && `${plural(m, 'document')} couldn’t be processed`].filter(Boolean).join(' · ');
    const actions = (p || m ? btn(p ? 'Process' : 'See what failed', { v: n ? 'ghost' : 'secondary', size: 'sm', href: docsHref('processing', { kb: kb.id, ...(p ? {} : { state: 'failed' }) }) }) : '')
      + (n ? btn(`Review ${fmtNum(n)}`, { v: 'secondary', size: 'sm', href: docsHref('review', { kb: kb.id }) }) : '');
    return `<div class="mb-12">${alertBox(m ? 'warning' : 'accent', title, '', actions, { icon: m ? 'alert' : 'clock' })}</div>`;
  }

  /* ═══════════════ Contents: the collection's folders and documents ═══════════════
     Its structure (what Home's map draws) and its documents in one place: a folder tree beside the open folder's folders and
     documents. Folders are made, described, moved and removed here, documents are moved between them, and a folder can take
     its own access (core/catalog.js, canReadFolder). Decisions, processing and the cross-collection list of documents stay
     in Documents; this view is about where things live and who reads them. */
  const CK = kb => 'kbContents-' + kb.id;
  /** What Contents lists: every document its reviewers curate (any stage), only the published ones for its other editors —
      never inside a folder the caller can't read. */
  const contentDocs = kb => D.docs.filter(d => d.kb === kb.id && !d.archived && canReadFolder(docFolder(d)) && (canReviewKb(kb) || isPublishedStage(d)));
  const subFolders = (kb, parent) => foldersIn(kb.id, parent).filter(f => canReadFolder(f.id));
  const depthOf = f => (f ? folderPath(f.id).length + 1 : 1);
  function countUnder(docs, f) {
    if (!f) return docs.length;
    const set = new Set(folderSubtree(f.id));
    return docs.filter(d => set.has(docFolder(d))).length;
  }
  /** Its kind's icon (as on Home), or a lock when it has its own access. */
  const folderIcon = f => (f.own ? 'lock' : levelIcon(levelOf(f, depthOf(f)), depthOf(f)));
  const where = (kb, f) => [kb.name, ...folderPath(f?.id).map(x => x.name)].join(' › ');

  function contentsTree(kb, sel, docs) {
    const u = ui('kbTree-' + kb.id, { open: {} }), onPath = new Set(folderPath(sel?.id).map(f => f.id));
    const node = (f, depth) => {
      const id = f?.id || '', kids = subFolders(kb, f?.id || null), open = !f || (u.open[id] ?? onPath.has(id)), isSel = (sel?.id || '') === id;
      const chev = f && kids.length
        ? `<button type="button" class="st-row__chev" data-act="kb-tree-toggle" data-kb="${kb.id}" data-id="${esc(id)}" aria-expanded="${open}" aria-label="${esc(`${open ? 'Collapse' : 'Expand'} ${f.name}`)}">${ic(open ? 'chevron-down' : 'chevron-right', 'i-sm')}</button>`
        : '<span class="st-row__chev" aria-hidden="true"></span>';
      const lead = f ? `<span class="st-row__icon" aria-hidden="true">${ic(folderIcon(f), 'i-sm')}</span>` : kbMark(kb, 20);
      const row = `<div class="${cx('st-row', isSel && 'is-selected', !f && 'st-row--root')}" style="--depth:${depth}">${chev}<button type="button" class="st-row__main" data-act="kb-folder" data-kb="${kb.id}" data-id="${esc(id)}" ${isSel ? 'aria-current="true"' : ''}>${lead}<span class="st-row__name" translate="no" data-tip="${esc(f ? f.name : kb.name)}">${esc(f ? f.name : kb.name)}</span><span class="st-row__count num">${fmtNum(countUnder(docs, f))}</span></button></div>`;
      return `<li>${row}${open && kids.length ? `<ul class="st-group">${kids.map(k => node(k, depth + 1)).join('')}</ul>` : ''}</li>`;
    };
    return `<nav class="st-side" aria-label="Folders"><ul class="st-tree">${node(null, 0)}</ul></nav>`;
  }
  /** One line: who reads what's here, and where that is decided — with the one access action that fits. */
  function accessLine(kb, f) {
    const who = X.whoCanSee(kb, f?.id), own = kbRole(kb) === 'owner', names = who.detail ? `<span class="muted"> · ${esc(who.detail)}</span>` : '';
    const line = (icon, text, action = '') => `<div class="st-access">${ic(icon, 'i-sm')}<span class="grow">${text}</span>${action}</div>`;
    if (!f) return line(who.icon, `${esc(who.label)}${names}`, own ? btn('Manage access', { v: 'ghost', size: 'sm', href: kbManageHref(kb, 'access') }) : '');
    if (who.via === f) return line('lock', `<span class="medium">${esc(`Own access: ${who.detail || 'no one yet'}`)}</span><span class="muted" aria-hidden="true"> · </span><span>${esc(`Other readers of ${kb.name} don’t see it.`)}</span>`, own ? btn('Manage access', { v: 'ghost', size: 'sm', act: 'kb-folder-access', data: { id: f.id } }) : '');
    if (who.via) return line('lock', `${esc(who.label)}${names} · <button type="button" class="link" data-act="kb-folder" data-kb="${kb.id}" data-id="${esc(who.via.id)}">${esc('set there')}</button>`);
    return line(who.icon, `${esc(`Same as the collection: ${who.label}`)}`, own ? btn('Restrict access', { v: 'ghost', size: 'sm', icon: 'lock', act: 'kb-folder-access', data: { id: f.id } }) : '');
  }
  function contentsTab(kb, f) {
    return gate({ loading: () => skelRows(6), ok: () => { const docs = contentDocs(kb); return `<div class="st-panes">${contentsTree(kb, f, docs)}${contentsMain(kb, f, docs)}</div>`; } });
  }
  function contentsMain(kb, f, docs) {
    const k = CK(kb), u = ui(k, { q: '', sel: {} }), edit = canEditKb(kb), q = (u.q || '').trim(), qf = fold(q);
    // Searching looks through the whole collection and says where each match lives.
    const kids = q ? (D.folders || []).filter(x => x.kb === kb.id && canReadFolder(x.id) && fold(x.name).includes(qf)) : subFolders(kb, f?.id || null);
    const here = q ? docs.filter(d => fold(docTitle(d)).includes(qf)) : docs.filter(d => docFolder(d) === (f?.id || null));
    const live = new Set(here.map(d => d.id));
    u.sel = Object.fromEntries(Object.entries(u.sel || {}).filter(([id, on]) => on && live.has(id)));
    const trail = [{ id: '', name: kb.name }, ...folderPath(f?.id)];
    const crumbs = trail.length > 1 ? `<nav class="st-crumbs" aria-label="Location">${trail.slice(0, -1).map(x => `<button type="button" class="st-crumb" data-act="kb-folder" data-kb="${kb.id}" data-id="${esc(x.id)}" translate="no">${esc(x.name)}</button>`).join(`<span aria-hidden="true">${ic('chevron-right', 'i-xs')}</span>`)}</nav>` : '';
    const nDocs = countUnder(docs, f), nFolders = (f ? folderSubtree(f.id).length - 1 : (D.folders || []).filter(x => x.kb === kb.id).length);
    const counts = [plural(nDocs, 'document'), nFolders ? plural(nFolders, 'folder') : ''].filter(Boolean).join(' · ');
    const more = f && edit ? iconBtn('more', 'Folder actions', { size: 'sm', menu: 'kb-folder-more', data: { id: f.id, ctx: 'head' } }) : '';
    const newFolder = edit ? btn('New folder', { v: 'secondary', size: 'sm', icon: 'folder-plus', act: 'kb-folder-new', data: { kb: kb.id, parent: f?.id || '' } }) : '';
    // The page header already names the collection: its top level shows only what's in it. A folder's editors rename it on
    // its title, describe it under it and change its kind from the meta line — each applies at once, with Undo.
    const rn = f && S.ui[FR]?.id === f.id ? S.ui[FR] : null;
    const name = !f ? '' : edit ? editableTitle({ id: 'kbf-title', value: rn ? rn.val : f.name, editing: !!rn, edit: 'kb-folder-rename', commit: 'kb-folder-rename-done', cancel: 'kb-folder-rename-cancel', cls: 'st-head__title', label: 'Rename folder', maxlength: 80, error: rn?.err || '', data: { id: f.id } })
      : `<h2 class="st-head__title" translate="no">${esc(f.name)}</h2>`;
    const title = f ? `<div class="st-head__name">${name}</div>${more}` : `<p class="st-head__meta">${esc(`Top level · ${counts}`)}</p>`;
    const kind = !f ? '' : edit && mapLevels().length > 1
      ? `<button type="button" class="st-head__kind" data-menu="kb-folder-kind" data-id="${esc(f.id)}" aria-haspopup="menu" aria-expanded="false" data-tip="${esc('Change its kind')}">${esc(levelOf(f, depthOf(f)))}${ic('chevron-down', 'i-xs')}</button>`
      : `<span>${esc(levelOf(f, depthOf(f)))}</span>`;
    const fd = f && S.ui[FD]?.id === f.id ? S.ui[FD] : null;
    const desc = !f ? '' : edit ? `<p class="st-head__desc">${editableTitle({ id: 'kbf-desc', tag: 'span', cls: cx('kb-desc-edit', !f.desc && !fd && 'is-empty'), value: fd ? fd.val : f.desc || addDesc(), editing: !!fd, edit: 'kb-folder-describe', commit: 'kb-folder-describe-done', cancel: 'kb-folder-describe-cancel', label: 'Edit description', maxlength: 200, placeholder: 'Shown on Home when someone selects it', data: { id: f.id } })}</p>`
      : f.desc ? `<p class="st-head__desc" translate="no">${esc(f.desc)}</p>` : '';
    const head = `<div class="st-head">${crumbs}<div class="st-head__row">${title}<span class="grow"></span>${newFolder}</div>${desc}${f ? `<p class="st-head__meta">${kind}<span aria-hidden="true"> · </span><span>${esc(counts)}</span></p>` : ''}${accessLine(kb, f)}</div>`;
    const tools = here.length + kids.length > 12 || q ? `<div class="toolbar st-tools">${searchField({ uiKey: k, placeholder: `Search ${kb.name}` })}</div>` : '';
    if (!kids.length && !here.length) {
      const empty = q ? emptyState({ icon: 'search', title: `Nothing called “${q}”`, desc: 'Search looks through every folder of this collection.', compact: true })
        : emptyState({ icon: 'folder-open', title: f ? 'This folder is empty' : 'Nothing here yet', desc: edit ? 'Add documents here, or make a folder to organise them.' : 'Documents added here show up for everyone who can read it.', compact: true });
      return `<section class="st-main" aria-label="${esc(f ? f.name : kb.name)}">${head}${tools}<div class="st-empty">${empty}</div></section>`;
    }
    const fRow = x => {
      const sub = [q ? where(kb, folderById(x.parent)) : levelOf(x, depthOf(x)), plural(countUnder(docs, x), 'document'), x.own ? 'Own access' : ''].filter(Boolean).join(' · ');
      return `<tr class="table__row st-frow" data-act="kb-folder" data-kb="${kb.id}" data-id="${x.id}" tabindex="0">
        <td class="table__cell table__cell--check"></td>
        <td class="table__cell table__cell--primary"><div class="row gap-12"><span class="st-ficon" aria-hidden="true">${ic(folderIcon(x), 'i-sm')}</span><div class="grow"><div class="cell-title truncate" translate="no">${esc(x.name)}</div><div class="cell-sub truncate">${esc(sub)}</div></div></div></td>
        <td class="table__cell"></td>
        <td class="table__cell table__cell--hide-sm"></td>
        <td class="table__cell table__cell--actions">${edit ? `<span class="reveal-on-hover">${iconBtn('more', 'Folder actions', { size: 'sm', menu: 'kb-folder-more', data: { id: x.id } })}</span>` : ''}</td></tr>`;
    };
    const dRow = d => {
      const sub = q ? where(kb, folderById(docFolder(d))) : res(d).topics.slice(0, 2).map(topicName).join(' · ');
      return `<tr class="table__row" data-act="cur-doc" data-id="${d.id}" tabindex="0" ${u.sel[d.id] ? 'aria-selected="true"' : ''}>
        ${edit ? selCheck(k, d.id, 'Select ' + docTitle(d)) : '<td class="table__cell table__cell--check"></td>'}
        <td class="table__cell table__cell--primary"><div class="row gap-12">${fileIcon(d.type)}<div class="grow"><div class="cell-title truncate" data-tip="${esc(d.name)}">${esc(d.name)}</div>${sub ? `<div class="cell-sub truncate">${esc(sub)}</div>` : ''}</div></div></td>
        <td class="table__cell">${lifeChip(d, 'sm')}</td>
        <td class="table__cell table__cell--hide-sm muted cur-nowrap" data-tip="${esc(fmtDateTime(d.updated))}">${rel(d.updated)}</td>
        <td class="table__cell table__cell--actions">${edit ? `<span class="reveal-on-hover">${iconBtn('more', 'More actions', { size: 'sm', menu: 'kb-doc', data: { id: d.id } })}</span>` : ''}</td></tr>`;
    };
    const rows = [...kids.map(fRow), ...[...here].sort((a, b) => b.updated - a.updated).map(dRow)];
    const head2 = `${edit && here.length ? selAllCheck(k, here.map(d => d.id)) : th('', 'table__column--check')}${th('Name')}${th('Status')}${th('Updated', 'table__column--hide-sm')}${th('<span class="sr-only">Actions</span>', 'table__column--actions')}`;
    const bulk = bulkBar(k, btn('Move to…', { v: 'ghost', size: 'sm', icon: 'folder', act: 'kb-bulk-move', data: { kb: kb.id } }));
    return `<section class="st-main" aria-label="${esc(f ? f.name : kb.name)}">${head}${tools}${table({ label: 'Folders and documents', head: head2, rows })}</section>${bulk}`;
  }
  A['kb-folder'] = el => { const kb = kbById(el.dataset.kb); if (kb) ui(CK(kb)).q = ''; setQuery({ tab: 'contents', folder: el.dataset.id || '' }); };
  A['kb-tree-toggle'] = el => { const u = ui('kbTree-' + el.dataset.kb, { open: {} }); u.open[el.dataset.id] = el.getAttribute('aria-expanded') !== 'true'; refresh(); };
  A['kb-bulk-move'] = el => { const kb = kbById(el.dataset.kb); if (kb) A['doc-move']({ dataset: { ids: selIds(CK(kb)).join(',') } }); };
  /** A document row's ⋯ (the row opens its details): moving is what Contents is for; the rest is in the details. */
  MENUS['kb-doc'] = el => {
    const d = docById(el.dataset.id); if (!d) return [];
    return [
      { label: 'Details', icon: 'info', run: () => A['cur-doc']({ dataset: { id: d.id } }) },
      { label: 'Move to…', icon: 'folder', run: () => A['doc-move']({ dataset: { id: d.id } }) },
      canOpenRes(d) && { label: 'Open', icon: 'file-text', run: () => go('/doc/' + d.id) },
    ].filter(Boolean);
  };
  /** A folder's ⋯. On its own page the title renames it, the line under it describes it and the access line restricts it,
      so the menu holds only moving and removing; a row's ⋯ also offers Rename (opens the folder, its title ready to type). */
  MENUS['kb-folder-more'] = el => {
    const f = folderById(el.dataset.id), kb = f && kbById(f.kb); if (!f || !canEditKb(kb)) return [];
    const own = kbRole(kb) === 'owner', row = el.dataset.ctx !== 'head';
    return [
      row && { label: 'Rename', icon: 'pencil', run: () => { S.ui[FR] = { id: f.id, val: f.name, err: '' }; setQuery({ tab: 'contents', folder: f.id }); requestAnimationFrame(() => { const i = $('#kbf-title'); i?.focus(); i?.select(); }); } },
      { label: 'Move to…', icon: 'folder', run: () => A['kb-folder-move']({ dataset: { id: f.id } }) },
      own && row && { label: f.own ? 'Manage access…' : 'Restrict access…', icon: 'lock', run: () => A['kb-folder-access']({ dataset: { id: f.id } }) },
      { sep: true },
      { label: 'Remove folder', icon: 'trash', danger: true, run: () => A['kb-folder-remove']({ dataset: { id: f.id } }) },
    ].filter(Boolean);
  };
  /** The quiet "Add a description" an empty description shows to the people who may write one (localized here: the
      editable text itself is never translated). */
  const addDesc = () => tr('Add a description') ?? 'Add a description';
  /* ── A folder's description, under its title (editors) ── */
  const FD = 'kbFolderDesc';
  A['kb-folder-describe'] = el => { const f = folderById(el.dataset.id); if (!f || !canEditKb(kbById(f.kb))) return; S.ui[FD] = { id: f.id, val: f.desc || '' }; refresh(); };
  A['kb-folder-describe-cancel'] = () => { if (!S.ui[FD]) return; S.ui[FD] = null; refresh(); };
  /** Enter or leaving it. Idempotent; emptying it removes the description. */
  A['kb-folder-describe-done'] = el => {
    const r = S.ui[FD], f = r && folderById(r.id); if (!f) return;
    const v = el.value.trim(), before = f.desc || '';
    S.ui[FD] = null;
    if (v === before) { refresh(); return; }
    const kb = kbById(f.kb);
    if (v) f.desc = v; else delete f.desc;
    audit('Updated folder', `${kb.name} › ${f.name}`); refresh();
    toast(v ? 'Description updated' : 'Description removed', { action: { label: 'Undo', run: () => { if (before) f.desc = before; else delete f.desc; refresh(); } } });
  };
  /** A folder's kind (Home's label and icon for it): its level's by default, or another of the workspace's map levels. */
  MENUS['kb-folder-kind'] = el => {
    const f = folderById(el.dataset.id), kb = f && kbById(f.kb); if (!f || !canEditKb(kb)) return [];
    const byDepth = levelOf(null, depthOf(f)), set = level => {
      const before = f.level; if ((before || '') === (level || '')) return;
      if (level) f.level = level; else delete f.level;
      audit('Updated folder', `${kb.name} › ${f.name}`); refresh();
      toast(`“${f.name}” is shown as ${levelOf(f, depthOf(f))}`, { action: { label: 'Undo', run: () => { if (before) f.level = before; else delete f.level; refresh(); } } });
    };
    return [{ section: 'Shown on Home as' }, { label: `${byDepth} (its level)`, checked: !f.level || f.level === byDepth, run: () => set('') },
      ...mapLevels().filter(l => l !== byDepth).map(l => ({ label: l, checked: f.level === l, run: () => set(l) }))];
  };
  /* ── Rename a folder: its title (editors of the collection) ── */
  const FR = 'kbFolderRename';
  A['kb-folder-rename'] = el => { const f = folderById(el.dataset.id); if (!f || !canEditKb(kbById(f.kb))) return; S.ui[FR] = { id: f.id, val: f.name, err: '' }; refresh(); };
  A['kb-folder-rename-cancel'] = () => { if (!S.ui[FR]) return; S.ui[FR] = null; refresh(); };
  /** Enter or leaving the title. Idempotent; an empty or unchanged name just closes it. */
  A['kb-folder-rename-done'] = el => {
    const r = S.ui[FR], f = r && folderById(r.id); if (!f) return;
    const name = el.value.trim();
    if (!name || name === f.name) { S.ui[FR] = null; refresh(); return; }
    const err = folderNameError({ ...f, parent: f.parent || null, name });
    if (err) { Object.assign(r, { val: el.value, err }); refresh(); return; }
    const kb = kbById(f.kb), before = f.name;
    S.ui[FR] = null; f.name = name; kb.updated = Date.now();
    audit('Renamed folder', `${kb.name} › ${before} → ${name}`); refresh();
    toast(`Renamed to “${name}”`, { action: { label: 'Undo', run: () => { f.name = before; refresh(); } } });
  };

  /* ── New folder: its name and description (afterwards the folder's own page edits them in place) ── */
  const FK = 'kbFolder';
  A['kb-folder-new'] = el => { S.ui[FK] = { kb: el.dataset.kb, parent: el.dataset.parent || null, name: '', desc: '', touched: false }; openModal('kb-folder', {}); };
  function folderNameError(f) {
    const n = (f.name || '').trim();
    if (!n) return 'Enter a name.';
    if (n.length > 80) return 'Use 80 characters or fewer.';
    const dup = (D.folders || []).find(x => x.kb === f.kb && (x.parent || null) === (f.parent || null) && x.id !== f.id && x.name.trim().toLowerCase() === n.toLowerCase());
    return dup ? `“${dup.name}” is already here. Choose another name.` : '';
  }
  M['kb-folder'] = () => {
    const f = ui(FK), kb = kbById(f.kb), parent = folderById(f.parent);
    const err = folderNameError(f), shown = f.touched || err.includes('already') ? err : '';
    return {
      title: 'New folder', icon: 'folder', size: 'md',
      desc: `In ${esc(where(kb, parent))}`,
      body: `<div class="kn-form">${field({ id: 'kbf-name', label: 'Name', required: true, error: shown, control: input({ id: 'kbf-name', bind: FK + '.name', value: f.name, placeholder: 'e.g. Chargebacks', autofocus: true, onEnter: 'kb-folder-go', invalid: !!shown, attrs: 'data-live maxlength="80"' }) })}
        ${field({ id: 'kbf-desc-new', label: 'Description', optional: true, desc: 'Shown on Home when someone selects it.', control: input({ id: 'kbf-desc-new', bind: FK + '.desc', value: f.desc, placeholder: 'e.g. Evidence packs and reason codes for card disputes', onEnter: 'kb-folder-go', attrs: 'maxlength="200"' }) })}</div>`,
      footStart: `${ic(X.whoCanSee(kb, parent?.id).icon, 'i-sm')}<span>${esc(`Readable by: ${X.whoCanSee(kb, parent?.id).label}`)}</span>`,
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Create folder', { v: 'primary', icon: 'folder-plus', act: 'kb-folder-go' }),
    };
  };
  A['kb-folder-go'] = () => {
    const f = ui(FK), kb = kbById(f.kb); f.touched = true;
    if (folderNameError(f)) { refreshLayer(); $('#kbf-name')?.focus(); return; }
    const vals = { name: f.name.trim(), ...(f.desc.trim() ? { desc: f.desc.trim() } : {}) };
    const sibs = foldersIn(kb.id, f.parent || null), x = { id: uid('f'), kb: kb.id, parent: f.parent || null, order: Math.max(-1, ...sibs.map(s => s.order ?? 0)) + 1, ...vals };
    (D.folders ||= []).push(x); kb.updated = Date.now();
    closeModal(); refresh();
    audit('Created folder', `${kb.name} › ${x.name}`);
    toast(`Created “${x.name}”`, { action: { label: 'Open', run: () => setQuery({ tab: 'contents', folder: x.id }) } });
  };

  /* ── Move a folder (inside its collection: a folder is part of its collection's structure) ── */
  A['kb-folder-move'] = el => { const f = folderById(el.dataset.id); if (!f) return; setPath('docMove', { to: '', q: '', tried: false }); openModal('kb-folder-move', { id: f.id }); };
  M['kb-folder-move'] = ({ id }) => {
    const f = folderById(id), kb = kbById(f.kb), mv = X.move;
    const dests = mv.destinations({ kb: kb.id, exclude: folderSubtree(f.id) }), current = mv.destKey(kb.id, f.parent);
    return {
      title: `Move “${f.name}”`, icon: 'folder', size: 'md', desc: `With everything in it · in ${esc(where(kb, folderById(f.parent)))}`,
      body: mv.destPicker({ dests, current, f: ui('docMove'), noun: 'folder', act: 'doc-move-pick' }),
      footStart: 'You can undo right after.',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn('Move', { v: 'primary', icon: 'folder', act: 'kb-folder-move-go' }),
    };
  };
  A['kb-folder-move-go'] = () => {
    const f = folderById(S.modal.props.id), m = ui('docMove'), to = X.move.destOf(m.to);
    if (!to.kb) { m.tried = true; refreshLayer(); return; }
    const before = { parent: f.parent, order: f.order };
    f.parent = to.folder?.id || null; f.order = Math.max(-1, ...foldersIn(f.kb, f.parent).filter(x => x !== f).map(x => x.order ?? 0)) + 1;
    closeModal(); refresh();
    const dest = X.move.destLabel(to);
    audit('Moved folder', `${f.name} → ${dest}`);
    toast(`Moved “${f.name}” to ${dest}`, { action: { label: 'Undo', run: () => { Object.assign(f, before); refresh(); } } });
  };

  /* ── Remove a folder: what's in it moves up a level (documents are never deleted with a folder) ── */
  A['kb-folder-remove'] = el => {
    const f = folderById(el.dataset.id); if (!f) return;
    const kb = kbById(f.kb), up = folderById(f.parent), kids = (D.folders || []).filter(x => x.parent === f.id), docs = D.docs.filter(d => d.folder === f.id);
    const run = () => {
      const at = D.folders.indexOf(f), was = { kids: kids.map(x => [x, x.parent]), docs: docs.map(d => [d, d.folder]) };
      kids.forEach(x => { x.parent = f.parent || null; }); docs.forEach(d => { d.folder = f.parent || undefined; }); D.folders.splice(at, 1);
      if (S.cur.query.folder === f.id) setQuery({ folder: f.parent || '' }); else refresh();
      audit('Removed folder', `${kb.name} › ${f.name}`);
      const moved = [docs.length && plural(docs.length, 'document'), kids.length && plural(kids.length, 'folder')].filter(Boolean).join(' and ');
      toast(`Removed “${f.name}”${moved ? `. Its ${moved} moved to ${up ? up.name : kb.name}` : ''}`, { action: { label: 'Undo', run: () => { D.folders.splice(at, 0, f); was.kids.forEach(([x, p]) => { x.parent = p; }); was.docs.forEach(([d, p]) => { d.folder = p; }); refresh(); } } });
    };
    // Its own access goes with it: what's inside would then be read by everyone who reads the level above. Say so first.
    if (f.own && (docs.length || kids.length)) {
      const who = X.whoCanSee(kb, f.parent);
      confirmAction({ title: `Remove “${f.name}”?`, body: `What’s in it moves to ${up ? up.name : kb.name} and loses this folder’s own access: ${who.label} will be able to read it.`, confirm: 'Remove folder', danger: true, onConfirm: run });
    } else run();
  };

  /* ── A folder's own access (inheritAccess = false) ── */
  const FA = 'kbFA';
  A['kb-folder-access'] = el => {
    const f = folderById(el.dataset.id), kb = f && kbById(f.kb); if (!f || kbRole(kb) !== 'owner') return;
    // Restricting starts from the collection's owners (and you), so whoever manages it keeps reading it.
    const start = f.own ? f.own.shares.map(s => ({ ...s })) : kb.shares.filter(s => s.role === 'owner').map(s => ({ ...s }));
    if (!isAdmin() && !start.some(coversMe)) start.push({ kind: 'user', id: me().id, role: 'owner' });
    S.ui[FA] = { id: f.id, shares: start, q: '', tried: false };
    openModal('kb-folder-access', {});
  };
  function faOptions() {
    const f = ui(FA), q = f.q.trim().toLowerCase(), taken = new Set(f.shares.map(s => s.kind + ':' + s.id));
    const groups = D.groups.map(g => ({ kind: 'group', id: g.id, sub: plural(groupMembers(g.id).length, 'member') }));
    const people = D.members.filter(m => m.status === 'active').map(m => ({ kind: 'user', id: m.id, sub: m.email }));
    return [...groups, ...people].filter(o => !taken.has(o.kind + ':' + o.id) && (!q || shareName(o).toLowerCase().includes(q) || o.sub.toLowerCase().includes(q))).slice(0, 5);
  }
  M['kb-folder-access'] = () => {
    const f = ui(FA), folder = folderById(f.id), kb = kbById(folder.kb), up = folderById(folder.parent);
    const err = f.tried && !f.shares.length ? 'Add at least one person or group.' : '';
    const rows = f.shares.map((s, i) => item({
      lead: shareLead(s, 'sm'), title: esc(shareName(s)), cls: 'kb-share-row',
      trail: select({ id: 'kbfa-role-' + i, value: s.role, options: KB_ROLE_OPTIONS, change: 'kb-fa-role', size: 'sm', cls: 'kb-select', label: 'Role for ' + shareName(s), attrs: `data-i="${i}"` }) + iconBtn('x', 'Remove ' + shareName(s), { size: 'sm', act: 'kb-fa-remove', data: { i } }),
    }));
    const opts = faOptions(), results = f.q.trim() ? (opts.length ? list(opts.map(o => item({ lead: shareLead(o, 'sm'), title: esc(shareName(o)), desc: esc(o.sub), trail: ic('plus', 'i-sm muted'), act: 'kb-fa-pick', data: { key: o.kind + ':' + o.id } })), 'kb-share-list') : `<p class="kb-share-none">${esc(`No one called “${f.q.trim()}” in this workspace.`)}</p>`) : '';
    return {
      title: folder.own ? `Who can read “${folder.name}”` : `Give “${folder.name}” its own access`, icon: 'lock', size: 'md',
      desc: esc(`Only the people and groups below read this folder and everything in it. People who can read ${up ? up.name : kb.name} don’t see inside unless they’re added here. Workspace admins always can.`),
      body: `<div class="kn-form"><div class="field"><span class="label">People and groups</span>${rows.length ? list(rows) : ''}${err ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(err)}</span></div>` : ''}</div>
        <div class="field">${searchField({ id: 'kbfa-q', act: 'kb-fa-q', value: f.q, placeholder: 'Add people or groups', label: 'Add people or groups', size: 'md', full: true })}${results}</div></div>`,
      footStart: folder.own ? btn('Use the collection’s access', { v: 'ghost', act: 'kb-fa-inherit' }) : '',
      foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(folder.own ? 'Save' : 'Restrict folder', { v: 'primary', icon: 'lock', act: 'kb-fa-go' }),
    };
  };
  A['kb-fa-q'] = el => { ui(FA).q = el.value; refreshLayer(); };
  A['kb-fa-pick'] = el => { const f = ui(FA), [kind, id] = el.dataset.key.split(':'); f.shares.push({ kind, id, role: 'viewer' }); f.q = ''; refreshLayer(); $('#kbfa-q')?.focus(); };
  A['kb-fa-remove'] = el => { ui(FA).shares.splice(+el.dataset.i, 1); refreshLayer(); };
  A['kb-fa-role'] = el => { const s = ui(FA).shares[+el.dataset.i]; if (s) s.role = el.value; };
  A['kb-fa-go'] = () => {
    const f = ui(FA), folder = folderById(f.id), kb = kbById(folder.kb);
    if (!f.shares.length) { f.tried = true; refreshLayer(); return; }
    const before = folder.own ? { shares: folder.own.shares.map(s => ({ ...s })) } : null;
    folder.own = { shares: f.shares.map(s => ({ ...s })) };
    closeModal(); refresh();
    audit(before ? 'Changed folder access' : 'Restricted folder', `${kb.name} › ${folder.name}`);
    toast(before ? 'Access saved' : `Only the people you added can read “${folder.name}” now`, { action: { label: 'Undo', run: () => { if (before) folder.own = before; else delete folder.own; refresh(); } } });
  };
  A['kb-fa-inherit'] = () => {
    const folder = folderById(ui(FA).id), kb = kbById(folder.kb), before = folder.own;
    delete folder.own; closeModal(); refresh();
    audit('Folder uses collection access', `${kb.name} › ${folder.name}`);
    toast(`“${folder.name}” has the same access as ${folderById(folder.parent)?.name || kb.name} again: ${X.whoCanSee(kb, folder.parent).label}`, { action: { label: 'Undo', run: () => { folder.own = before; refresh(); } } });
  };

  /* ── Sources tab ── */
  function srcLine(s) {
    if (s.status === 'syncing' && s.progress) return `Syncing ${s.progress.done} of ${s.progress.total} documents`;
    const last = s.last?.at ? `Last synced ${rel(s.last.at).toLowerCase()}` : 'Not synced yet';
    const next = s.status === 'paused' || !s.schedule?.on || s.schedule?.freq === 'manual' ? 'Syncs manually' : s.next ? `Next ${relFuture(s.next)}` : '';
    return [last, next].filter(Boolean).join(' · ');
  }
  function sourcesTab(kb) {
    const srcs = D.sources.filter(s => s.kb === kb.id), manage = can('source.manage');
    // Add source reuses a connected account (straight to picking folders; ones already synced elsewhere are marked), see sources.js.
    const add = (v, size) => X.src?.addBtn?.({ kb: kb.id, v, size }) || '';
    const empty = () => emptyState({ icon: 'plug', title: 'No sources yet', desc: manage ? 'Keep this collection in sync with Google Drive or Confluence.' : 'Documents here are added by hand. Ask an admin to add a source.', actions: manage ? add('primary') : '', boxed: true });
    return gate({
      loading: () => skelRows(3), empty,
      ok: () => !srcs.length ? empty() : (manage ? `<div class="toolbar"><div class="toolbar__end">${add('secondary', 'sm')}</div></div>` : '')
        + list(srcs.map(s => item({ lead: appIcon(s.app, 'lg'), title: esc(s.name), titleExtra: X.src?.statusChip ? X.src.statusChip(s) : status('source', s.status), desc: esc(srcLine(s)), meta: esc((s.scope || []).join(', ')), trail: manage ? ic('chevron-right', 'muted') : '', act: manage ? 'kb-src-open' : undefined, data: { id: s.id } }))),
    });
  }
  A['kb-src-open'] = el => { if (A['src-open']) A['src-open']({ dataset: { id: el.dataset.id } }); else go(studioHref('sources')); };

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
    if (!decidesHere(kb)) return `<div class="mb-16">${alertBox('warning', `${plural(reqs.length, 'person', 'people')} asked for access`, 'You decide access requests for every collection in People.', btn('Open access requests', { v: 'secondary', size: 'sm', href: '/people?tab=requests' }), { icon: 'user-plus' })}</div>`;
    return section('Access requests', list(reqs.map(requestRow)));
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
        ${section('People and groups', kb.shares.length ? list(kb.shares.map(row)) : emptyState({ icon: 'users', title: 'Not shared with anyone yet', desc: 'Share it to give people edit or owner rights.', boxed: true, compact: true }), { desc: ownFolders(kb).length ? 'They reach every folder except the ones below. Workspace admins can always manage every collection.' : 'Workspace admins can always manage every collection.', actions: btn('Share', { v: 'secondary', size: 'sm', icon: 'user-plus', act: 'kb-share', data: { kb: kb.id } }) })}
        ${ownFoldersSection(kb)}
      </div>`,
    });
  }
  /** Folders of this collection with their own access (the caller can read), outermost first. */
  const ownFolders = kb => (D.folders || []).filter(f => f.kb === kb.id && f.own && canReadFolder(f.id)).sort((a, b) => depthOf(a) - depthOf(b) || a.name.localeCompare(b.name));
  /** Where the collection's access stops: each folder that decides its own, who reads it, and a way to change it. */
  function ownFoldersSection(kb) {
    const own = ownFolders(kb); if (!own.length) return '';
    return section('Folders with their own access', list(own.map(f => item({
      lead: itemIcon('lock'), title: `<span translate="no">${esc(f.name)}</span>`, desc: esc(`${where(kb, folderById(f.parent))} · ${X.whoCanSee(kb, f.id).detail || 'No one yet'}`),
      trail: btn('Manage', { v: 'secondary', size: 'sm', act: 'kb-folder-access', data: { id: f.id } }), cls: 'kb-share-row',
    }))), { desc: 'Only the people added to each folder read it; the people above don’t reach inside.' });
  }
  A['kb-general'] = el => {
    const kb = kbById(el.dataset.kb), prev = kb.general, roles = snapRoles(kb);
    kb.general = el.value; syncShare(kb); kb.updated = Date.now(); refresh();
    audit('Changed general access', kb.name);
    toast(kbAccess(kb).long, { action: { label: 'Undo', run: () => { kb.general = prev; restoreRoles(kb, roles); refresh(); toast('Access restored'); } } });
  };
  A['kb-role'] = el => {
    const kb = kbById(el.dataset.kb), st = ui('kbAccess-' + kb.id), s = kb.shares.find(x => x.kind + ':' + x.id === el.dataset.key); if (!s) return;
    if (s.role === 'owner' && el.value !== 'owner' && kb.shares.filter(x => x.role === 'owner').length === 1) { st.err = { key: el.dataset.key, msg: 'Every collection needs an owner. Make someone else an owner first.' }; refresh(); return; }
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
    audit(`Shared collection with ${added.map(shareName).join(', ')}`, kb.name);
    closeModal(); refresh();
    toast(`Shared with ${added.length === 1 ? shareName(added[0]) : plural(added.length, 'person or group', 'people and groups')}`, { action: { label: 'Undo', run: () => { kb.shares = kb.shares.filter(s => !added.includes(s)); restoreRoles(kb, roles); refresh(); } } });
  };

  /** Archiving is reversible: it happens at once, with Undo (no confirmation). */
  A['kb-archive'] = el => {
    const kb = kbById(el.dataset.kb); if (!kb) return;
    kb.archived = true; audit('Archived collection', kb.name); go(studioHref('collections'));
    toast(`Archived “${kb.name}”`, { action: { label: 'Undo', run: () => { kb.archived = false; audit('Restored collection', kb.name); go(kbManageHref(kb)); toast(`Restored “${kb.name}”`); } } });
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
      size: 'md', title: 'Restricted collections', icon: 'lock',
      desc: 'Their documents stay hidden until the owners share them with you.',
      body: locked.length ? list(locked.map(kb => item({ lead: kbMark(kb, 32, true), title: esc(kb.name), desc: esc(kb.desc || ownersLabel(kb)), trail: requestAction(kb) }))) : `<p class="muted">Every collection is shared with you.</p>`,
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

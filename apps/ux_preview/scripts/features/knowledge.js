/* Knowledge: knowledge base list, detail (documents, sources, access,
   settings), create, upload, share, request access and ask. Document-level
   helpers (row, drawer, processing, move, archive) live in documents.js. */
(() => {
  'use strict';

  const ROLES = [['viewer', 'Viewer'], ['editor', 'Editor'], ['owner', 'Owner']];
  const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
  const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
  const ROLE_DESC = { viewer: 'Can search and read documents.', editor: 'Can also add, move and archive documents.', owner: 'Can also manage access and settings.' };
  const SORTS = { updated: 'Recently updated', name: 'Name', docs: 'Most documents' };
  const COLORS = ['#B4467A', '#C2620F', '#2F6FB5', '#0E7C66', '#6B4FBF', '#1F7A8C', '#4E6B2E', '#A23B3B'];
  const UPLOAD_OK = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'md', 'html', 'zip'];
  const MAX_BYTES = 100 * 1048576;
  const SAMPLES = [
    { name: 'Q4 Sales Kickoff.pptx', size: 8.4 * 1048576 }, { name: 'Pricing FAQ.docx', size: 214e3 }, { name: 'Meeting notes.txt', size: 12e3 },
    { name: 'Archive 2025.zip', size: 46.2 * 1048576 }, { name: 'Product demo.mov', size: 182 * 1048576 },
  ];

  /* ── Helpers ── */
  function audit(action, target, type = 'Knowledge') {
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type, target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
  }
  const accessKey = kb => kb.personal ? 'private' : kb.general;
  function kbAccess(kb) {
    if (kb.personal) return { icon: 'user', label: 'Only you', long: 'Only you can see this.' };
    if (kb.general === 'workspace') return { icon: 'globe', label: 'Everyone', long: `Everyone in ${curWs().name} can find it and ask about it.` };
    if (kb.general === 'private') return { icon: 'lock', label: 'Owners only', long: 'Only owners can find it.' };
    const sp = kbSpace(kb);
    return { icon: 'lock', label: 'Restricted', long: sp ? `Members of ${sp.name} and the people and groups below can find it.` : 'Only the people and groups below can find it.' };
  }
  const accessChip = kb => { const a = kbAccess(kb); return chip(a.label, { icon: a.icon, size: 'sm' }); };
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
  const docsKey = id => 'kbdocs-' + id;

  /* ═══════════════════════════ Knowledge list ═══════════════════════════ */
  function sortKbs(rows, by) {
    const cmp = { updated: (a, b) => b.updated - a.updated, name: (a, b) => a.name.localeCompare(b.name), docs: (a, b) => docsIn(b.id).length - docsIn(a.id).length }[by] || ((a, b) => b.updated - a.updated);
    return [...rows].sort((a, b) => (b.personal ? 1 : 0) - (a.personal ? 1 : 0) || cmp(a, b));
  }
  function kbCard(kb) {
    const locked = kbRole(kb) === 'none';
    const sp = kbSpace(kb);
    const top = `<div class="kb-card__top">${kbMark(kb, 36, locked)}<span class="kb-card__chips">${sp ? spaceChip(sp) : ''}${accessChip(kb)}</span></div>`;
    const text = `<div class="stack gap-2"><div class="kb-card__name truncate">${esc(kb.name)}</div><div class="kb-card__desc truncate">${esc(kb.desc || 'No description')}</div></div>`;
    if (locked) {
      const cta = myRequest(kb) ? chip('Pending', { tone: 'warning', icon: 'clock', size: 'sm' }) : btn('Request access', { size: 'sm', icon: 'lock', act: 'kb-request', data: { kb: kb.id } });
      return `<div class="card card--action kb-card" role="link" tabindex="0" data-act="go" data-to="/knowledge/${kb.id}" aria-label="${esc(kb.name)}, locked">${top}${text}<div class="kb-card__foot"><span class="truncate">${esc(ownersLabel(kb))}</span>${cta}</div></div>`;
    }
    return `<a class="card card--action kb-card" href="#/knowledge/${kb.id}">${top}${text}<div class="kb-card__foot"><span class="row gap-4">${ic('files', 'i-sm')}${plural(docsIn(kb.id).length, 'document')}</span><span class="truncate">Updated ${rel(kb.updated).replace(/^(Just now|Yesterday)$/, m => m.toLowerCase())}</span></div></a>`;
  }
  function listEmpty(canCreate) {
    return canCreate
      ? emptyState({ icon: 'book', title: 'Create your first knowledge base', desc: 'Group documents by team or topic, then add files or connect a source.', actions: btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'kb-create' }), boxed: true })
      : emptyState({ icon: 'book', title: 'Nothing has been shared with you yet', desc: 'Upload your own files to ask about them. Only you can see My files.', actions: btn('Upload to My files', { v: 'primary', icon: 'upload', act: 'kb-upload', data: { kb: visibleKbs().find(k => k.personal)?.id || '' } }), boxed: true });
  }
  P.kbList = () => {
    const u = ui('kbList', { sort: 'updated' });
    const canCreate = can('knowledge.manage');
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'Knowledge bases' }]);
    const head = X.res.hubHeader('bases', { actions: canCreate ? btn('Create knowledge base', { v: 'primary', icon: 'plus', act: 'kb-create' }) : '' });
    const rows = sortKbs(visibleKbs().filter(k => matchesQ('kbList', k.name, k.desc) && (!u.access || accessKey(k) === u.access)), u.sort);
    const toolbar = `<div class="toolbar">${searchField({ uiKey: 'kbList', placeholder: 'Search knowledge bases' })}${filterButton('Access', 'kbList', 'access', [['workspace', 'Everyone'], ['restricted', 'Restricted'], ['private', 'Private']])}${clearFilters('kbList', ['access'])}<div class="toolbar__end">${btn(SORTS[u.sort], { v: 'ghost', size: 'sm', icon: 'sort', menu: 'kb-sort', aria: `aria-label="Sort: ${esc(SORTS[u.sort])}"` })}</div></div>`;
    const body = gate({
      loading: () => skelCards(6),
      empty: () => listEmpty(canCreate),
      ok: () => rows.length ? `<div class="grid cols-3">${rows.map(kbCard).join('')}</div>` : noMatches('kbList', ['access'], 'knowledge bases'),
    });
    return `<div class="page">${head}${S.pageState === 'empty' ? '' : toolbar}${body}</div>`;
  };
  MENUS['kb-sort'] = () => [{ section: 'Sort by' }, ...Object.entries(SORTS).map(([v, l]) => ({ label: l, checked: ui('kbList').sort === v, run: () => { ui('kbList').sort = v; refresh(); } }))];

  /* ── Create ── */
  /** Spaces a new base can belong to: the ones the caller runs. */
  const ownSpaces = () => (hasModule('spaces') ? (D.spaces || []).filter(s => !s.archived && canManageSpace(s)) : []);
  A['kb-create'] = () => { S.ui.kbCreate = { name: '', desc: '', access: 'workspace', space: '', touched: false, busy: false }; openModal('kb-create', {}); };
  M['kb-create'] = () => {
    const f = ui('kbCreate'), err = nameError(f.name);
    const shown = f.touched || (f.name.trim() && err.includes('exists')) ? err : '';
    return {
      title: 'Create knowledge base',
      body: field({ id: 'kbc-name', label: 'Name', required: true, error: shown, counter: `<span class="counter">${f.name.length}/60</span>`, control: input({ id: 'kbc-name', bind: 'kbCreate.name', value: f.name, placeholder: 'e.g. Customer Support', autofocus: true, onEnter: 'kb-create-go', invalid: !!shown, attrs: `data-live maxlength="60" ${f.busy ? 'disabled' : ''}` }) })
        + field({ id: 'kbc-desc', label: 'Description', optional: true, desc: 'Tells people what they can ask about.', control: textarea({ id: 'kbc-desc', bind: 'kbCreate.desc', value: f.desc, rows: 2, attrs: `maxlength="200" ${f.busy ? 'disabled' : ''}` }) })
        + (ownSpaces().length ? field({ id: 'kbc-space', label: 'Space', optional: true, desc: 'Its members can read it, even when access is restricted.', control: select({ id: 'kbc-space', bind: 'kbCreate.space', value: f.space, change: 'kb-create-space', options: [['', 'No space'], ...ownSpaces().map(s => [s.id, s.code ? `${s.name} · ${s.code}` : s.name])], attrs: f.busy ? 'disabled' : '' }) }) : '')
        + `<div class="field mt-16"><span class="label">Who can see it</span>${choiceGroup({ name: 'kbc-access', value: f.access, act: 'kb-create-access', options: [['workspace', `Everyone in ${curWs().name}`, 'Anyone can find it and ask about it.'], ['restricted', f.space ? 'Space members and people I add' : 'Only people I add', 'Share it with people and groups after it’s created.'], ['private', 'Only me', 'Keep it private until you’re ready.']] })}</div>`,
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + btn('Create', { v: 'primary', act: 'kb-create-go', loading: f.busy }),
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
    closeModal(); go('/knowledge/' + kb.id); toast(`Created “${name}”`);
  };

  /* ═══════════════════════════ Knowledge base detail ═══════════════════════════ */
  function tabsFor(kb) {
    const t = [{ id: 'documents', label: 'Resources', count: canEditKb(kb) ? docsIn(kb.id).length : readerDocs(kb).length }];
    if (kb.personal) return t;
    if (canEditKb(kb)) t.push({ id: 'sources', label: 'Sources', count: D.sources.filter(s => s.kb === kb.id).length });
    if (kbRole(kb) === 'owner') t.push({ id: 'access', label: 'Access', count: pendingRequests().filter(r => r.kb === kb.id).length || '', alert: true }, { id: 'settings', label: 'Settings' });
    return t;
  }
  function unavailable() {
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'Knowledge bases', to: '/knowledge/bases' }, { label: 'Not available' }]);
    return `<div class="page">${emptyState({ icon: 'book', title: 'This knowledge base isn’t available', desc: 'It may have been archived, or it isn’t shared with you.', actions: btn('Go to Knowledge bases', { v: 'primary', href: '/knowledge/bases' }), boxed: true })}</div>`;
  }
  P.kbDetail = ({ params, query }) => {
    const kb = kbById(params.id);
    if (!kb || kb.archived || kbRole(kb) === null) return unavailable();
    crumbs([{ label: 'Knowledge', to: '/knowledge' }, { label: 'Knowledge bases', to: '/knowledge/bases' }, { label: kb.name }]);
    const role = kbRole(kb);
    if (role === 'none') {
      const pending = myRequest(kb);
      return `<div class="page">${pageHeader({ title: kb.name, desc: esc(kb.desc || ''), lead: kbMark(kb, 40, true), extra: accessChip(kb) })}${emptyState({ icon: 'lock', title: pending ? 'Your request is with the owners' : 'You don’t have access yet', desc: pending ? `You asked ${rel(pending.at).toLowerCase()}. You can open it as soon as it’s approved.` : `${esc(ownersLabel(kb))}. Ask for access to search and read its documents.`, actions: pending ? chip('Pending', { tone: 'warning', icon: 'clock' }) : btn('Request access', { v: 'primary', icon: 'lock', act: 'kb-request', data: { kb: kb.id } }), boxed: true })}</div>`;
    }
    const tabList = tabsFor(kb);
    const tab = tabList.some(t => t.id === query.tab) ? query.tab : 'documents';
    const edit = canEditKb(kb), hasDocs = docsIn(kb.id).length > 0;
    const actions = (hasDocs ? btn('Ask', { v: 'primary', icon: 'sparkles', act: 'kb-ask', data: { kb: kb.id } }) : '')
      + (edit && (hasDocs || tab !== 'documents') ? btn('Add files', { icon: 'upload', act: 'kb-upload', data: { kb: kb.id } }) : '')
      + (MENUS['kb-more']({ dataset: { kb: kb.id } }).length ? iconBtn('more', 'More', { menu: 'kb-more', data: { kb: kb.id } }) : '');
    const sp = kbSpace(kb);
    const owner = ownerOfKb(kb), topics = (kb.topics || []).map(t => `<a class="res-topic" href="#${X.res.topicHref(t)}">${esc(topicName(t))}</a>`).join('');
    const sub = [kb.desc ? esc(kb.desc) : '', owner || topics ? `<span class="kb-head__meta">${owner ? `<span class="row gap-4 t-sm muted">${ic('building', 'i-sm')}${esc(owner)}</span>` : ''}${topics ? `<span class="res-topics">${topics}</span>` : ''}</span>` : ''].filter(Boolean).join('<br>');
    const head = pageHeader({ title: kb.name, desc: sub, lead: kbMark(kb, 40), extra: accessChip(kb) + (sp ? `<a class="kb-space-link" href="#/space/${esc(sp.id)}">${spaceChip(sp)}</a>` : ''), actions });
    const body = tab === 'sources' ? sourcesTab(kb) : tab === 'access' ? accessTab(kb) : tab === 'settings' ? settingsTab(kb) : docsTab(kb);
    return `<div class="page">${head}${tabList.length > 1 ? `<div class="page-tabs">${tabs(tabList, tab, '/knowledge/' + kb.id)}</div>` : ''}${body}</div>`;
  };
  MENUS['kb-more'] = el => {
    const kb = kbById(el.dataset.kb); if (!kb) return [];
    const owner = kbRole(kb) === 'owner' && !kb.personal;
    return [
      can('source.manage') && !kb.personal && { label: 'Connect source', icon: 'plug', run: () => connect(kb.id) },
      { label: 'Copy link', icon: 'link', run: () => copyText(location.href.split('#')[0] + '#/knowledge/' + kb.id, 'Link copied') },
      owner && { label: 'Manage access', icon: 'users', run: () => go(`/knowledge/${kb.id}?tab=access`) },
      owner && { sep: true },
      owner && { label: 'Archive', icon: 'archive', danger: true, run: () => A['kb-archive']({ dataset: { kb: kb.id } }) },
    ].filter(Boolean);
  };
  function connect(kbId) {
    if (A['src-connect']) A['src-connect']({ dataset: { kb: kbId } });
    else goThen('/sources', () => toast('Connect a source from here', { tone: 'accent' }));
  }
  A['kb-connect'] = el => connect(el.dataset.kb);

  /* ── Ask ── */
  A['kb-ask'] = el => {
    const { kb, doc } = el.dataset;
    if (!doc) { if (A['chat-ask']) A['chat-ask']({ dataset: { q: '', kb } }); else go('/chat'); return; }
    S.ui.kbAsk = { q: '' }; openModal('kb-ask', { kb, doc });
  };
  M['kb-ask'] = ({ doc }) => {
    const d = docById(doc), f = ui('kbAsk');
    const sugg = ['Summarize this document', 'What are the key points?', 'What does it say I need to do?'];
    return {
      title: 'Ask about this document', desc: esc(d?.name || ''),
      body: field({ id: 'kb-ask-q', label: 'Your question', control: input({ id: 'kb-ask-q', bind: 'kbAsk.q', value: f.q, placeholder: 'What do you want to know?', autofocus: true, onEnter: 'kb-ask-go' }) })
        + `<div class="kb-suggest mt-12">${sugg.map(q => btn(q, { v: 'outline', size: 'sm', act: 'kb-ask-go', data: { q } })).join('')}</div>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn('Ask', { v: 'primary', icon: 'send', act: 'kb-ask-go' }),
    };
  };
  A['kb-ask-go'] = el => {
    const q = (el.dataset.q || ui('kbAsk').q || '').trim();
    if (!q) { $('#kb-ask-q')?.focus(); return; }
    const { kb, doc } = S.modal.props, d = docById(doc); closeModal();
    if (A['chat-ask']) A['chat-ask']({ dataset: { q: `About “${d?.name}”: ${q}`, kb, doc } }); else go('/chat');
  };

  /* ── Documents tab ── */
  function docsEmpty(kb) {
    if (!canEditKb(kb)) return emptyState({ icon: 'file-text', title: 'No resources yet', desc: 'The owners haven’t added anything here yet.', boxed: true });
    const src = can('source.manage') && !kb.personal ? btn('Connect source', { icon: 'plug', act: 'kb-connect', data: { kb: kb.id } }) : '';
    return emptyState({ icon: 'upload', title: 'Add files', desc: kb.personal ? 'Upload files to ask about them. Only you can see them.' : 'Upload files or connect a source. Documents become searchable once processed.', actions: btn('Add files', { v: 'primary', icon: 'upload', act: 'kb-upload', data: { kb: kb.id } }) + src, boxed: true });
  }
  /** What readers of a base see: usable resources only (no pipeline states). */
  const readerDocs = kb => docsIn(kb.id).filter(isReaderVisible);
  const READER_SORTS = { updated: 'Recently updated', title: 'Title A–Z', popular: 'Most opened' };
  function readerTab(kb) {
    const key = 'kbres-' + kb.id, u = ui(key, { sort: 'updated', page: 1 }), all = readerDocs(kb), toks = tokens(u.q || '');
    const cmp = { updated: (a, b) => b.updated - a.updated, title: (a, b) => a.name.localeCompare(b.name), popular: (a, b) => (b.views || 0) - (a.views || 0) }[u.sort] || ((a, b) => b.updated - a.updated);
    const rows = all.filter(d => !toks.length || scoreRes(d, toks) > 0).sort(cmp);
    return gate({
      loading: () => skelRows(8),
      empty: () => docsEmpty(kb),
      ok: () => {
        if (!all.length) return docsEmpty(kb);
        const toolbar = `<div class="toolbar">${searchField({ uiKey: key, placeholder: 'Search this knowledge base' })}${linkBtn('Browse with filters', { href: catalogHref({ filters: { kb: [kb.id] } }), icon: 'arrow-right' })}<div class="toolbar__end">${btn(READER_SORTS[u.sort], { v: 'ghost', size: 'sm', icon: 'sort', menu: 'kb-res-sort', data: { kb: kb.id }, aria: `aria-label="Sort: ${esc(READER_SORTS[u.sort])}"` })}</div></div>`;
        if (!rows.length) return toolbar + noMatches(key, [], 'resources');
        return toolbar + X.res.rows(paginate(rows, key, 20), { q: u.q || '' }) + pager(rows.length, key, 20);
      },
    });
  }
  MENUS['kb-res-sort'] = el => { const u = ui('kbres-' + el.dataset.kb); return [{ section: 'Sort by' }, ...Object.entries(READER_SORTS).map(([v, l]) => ({ label: l, checked: u.sort === v, run: () => { u.sort = v; u.page = 1; refresh(); } }))]; };
  function docsTab(kb) {
    if (!canEditKb(kb)) return readerTab(kb);
    const key = docsKey(kb.id), edit = true, { STATUS_OPTS, TYPE_OPTS, typeGroup } = X.docOpts;
    const u = ui(key, { sort: { key: 'updated', dir: 'desc' }, page: 1, sel: {} });
    const all = docsIn(kb.id);
    const failed = all.filter(d => d.status === 'failed'), waiting = all.filter(d => ['pending', 'outdated'].includes(d.status));
    const rows = applySort(all.filter(d => matchesQ(key, d.name, X.docSub(d)) && (!u.st || d.status === u.st) && (!u.type || typeGroup(d) === u.type)), key, X.docSorters);
    return gate({
      loading: () => skelRows(8),
      empty: () => docsEmpty(kb),
      ok: () => {
        if (!all.length) return docsEmpty(kb);
        const toolbar = `<div class="toolbar">${searchField({ uiKey: key, placeholder: 'Search documents' })}${filterButton('Status', key, 'st', STATUS_OPTS)}${filterButton('Type', key, 'type', TYPE_OPTS)}${clearFilters(key, ['st', 'type'])}<span class="toolbar__end t-sm muted num">${plural(rows.length, 'document')}</span></div>`;
        const parts = [failed.length && `${plural(failed.length, 'document')} couldn’t be processed`, waiting.length && (failed.length ? `${fmtNum(waiting.length)} waiting` : `${plural(waiting.length, 'document')} waiting to be processed`)].filter(Boolean);
        const notice = edit && parts.length ? `<div class="mb-12">${alertBox(failed.length ? 'danger' : 'accent', parts.join(' · '), '', (failed.length && u.st !== 'failed' ? btn('Review', { size: 'sm', v: 'ghost', act: 'kb-show-failed', data: { kb: kb.id } }) : '') + (waiting.length ? btn('Process now', { size: 'sm', v: 'secondary', icon: 'play', act: 'kb-process-waiting', data: { kb: kb.id } }) : ''))}</div>` : '';
        if (!rows.length) return toolbar + notice + noMatches(key, ['st', 'type'], 'documents');
        const page = paginate(rows, key, 15);
        const ids = new Set(all.map(d => d.id)); const sel = selIds(key).filter(id => ids.has(id));
        const bulk = edit && sel.length ? bulkBar(key, btn('Reprocess', { v: 'ghost', size: 'sm', icon: 'retry', act: 'kb-bulk-process', data: { kb: kb.id } }) + (kb.personal ? '' : btn('Move', { v: 'ghost', size: 'sm', icon: 'folder', act: 'doc-move', data: { ids: sel.join(',') } })) + btn('Archive', { v: 'ghost', size: 'sm', icon: 'archive', act: 'kb-bulk-archive', data: { kb: kb.id } })) : '';
        return toolbar + notice + table({ label: 'Documents', head: X.docHead(key, edit ? page.map(d => d.id) : null), rows: page.map(d => X.docRow(d, { uiKey: key, select: edit })), foot: pager(rows.length, key, 15) }) + bulk;
      },
    });
  }
  const selectedDocs = kbId => { const ids = new Set(docsIn(kbId).map(d => d.id)); return selIds(docsKey(kbId)).filter(id => ids.has(id)).map(docById); };
  A['kb-show-failed'] = el => { const u = ui(docsKey(el.dataset.kb)); u.st = 'failed'; u.page = 1; refresh(); };
  A['kb-process-waiting'] = el => { const docs = docsIn(el.dataset.kb).filter(d => ['pending', 'outdated'].includes(d.status)); X.processDocs(docs, { msg: `Processing ${plural(docs.length, 'document')}` }); };
  A['kb-bulk-process'] = el => {
    const docs = selectedDocs(el.dataset.kb); ui(docsKey(el.dataset.kb)).sel = {};
    if (!X.processDocs(docs, { msg: `Reprocessing ${plural(docs.length, 'document')}` })) { refresh(); toast('These files can’t be reprocessed', { tone: 'danger' }); }
  };
  A['kb-bulk-archive'] = el => X.archiveDocs(selectedDocs(el.dataset.kb));

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
      ok: () => !srcs.length ? empty() : `<div class="toolbar"><span class="t-sm muted">${plural(srcs.length, 'source')} ${srcs.length === 1 ? 'feeds' : 'feed'} this knowledge base</span>${manage ? `<div class="toolbar__end">${btn('Connect source', { size: 'sm', icon: 'plug', act: 'kb-connect', data: { kb: kb.id } })}</div>` : ''}</div>`
        + list(srcs.map(s => item({ lead: appIcon(s.app, 'lg'), title: esc(s.name), titleExtra: status('source', s.status), desc: esc(srcLine(s)), meta: esc((s.scope || []).join(', ')), trail: manage ? ic('chevron-right', 'muted') : '', act: manage ? 'kb-src-open' : undefined, data: { id: s.id } }))),
    });
  }
  A['kb-src-open'] = el => { if (A['src-open']) A['src-open']({ dataset: { id: el.dataset.id } }); else go('/sources'); };

  /* ── Access tab ── */
  function accessTab(kb) {
    const st = ui('kbAccess-' + kb.id, { err: null });
    const reqs = pendingRequests().filter(r => r.kb === kb.id);
    const general = list([item({
      lead: itemIcon(kb.general === 'workspace' ? 'globe' : 'lock'), title: esc(kbAccess(kb).label), desc: esc(kbAccess(kb).long),
      trail: select({ id: 'kb-general', value: kb.general, options: [['workspace', `Everyone in ${curWs().name}`], ['restricted', 'Only people added'], ['private', 'Only owners']], change: 'kb-general', size: 'sm', cls: 'kb-select', label: 'General access', attrs: `data-kb="${kb.id}"` }),
    })]);
    const row = s => {
      const key = s.kind + ':' + s.id, isMe = s.kind === 'user' && s.id === me().id;
      const sub = s.kind === 'group' ? plural(groupMembers(s.id).length, 'member') : (memberById(s.id)?.email || '');
      const err = st.err?.key === key ? `<span class="field-error mt-4" role="alert">${ic('alert-circle')}<span>${esc(st.err.msg)}</span></span>` : '';
      return item({
        lead: shareLead(s), title: esc(shareName(s)) + (isMe ? ' <span class="muted" style="font-weight:400">(you)</span>' : ''), desc: esc(sub) + err,
        trail: select({ id: 'kb-role-' + key.replace(':', '-'), value: s.role, options: ROLES, change: 'kb-role', size: 'sm', cls: 'kb-select', label: 'Role for ' + shareName(s), attrs: `data-kb="${kb.id}" data-key="${key}"` }) + iconBtn('x', 'Remove ' + shareName(s), { size: 'sm', act: 'kb-unshare', data: { kb: kb.id, key } }),
      });
    };
    return gate({
      loading: () => skelRows(4),
      ok: () => `<div class="kb-narrow">
        ${reqs.length ? section('Requests', list(reqs.map(r => { const who = memberById(r.user)?.name || 'Someone'; return item({ lead: avatar(who), title: esc(who), titleExtra: chip(r.role === 'editor' ? 'Edit' : 'View', { size: 'sm' }), desc: `${r.note ? `“${esc(r.note)}” · ` : ''}${rel(r.at)}`, trail: btn('Deny', { size: 'sm', v: 'ghost', act: 'kb-req-deny', data: { id: r.id } }) + btn('Approve', { size: 'sm', v: 'secondary', act: 'kb-req-approve', data: { id: r.id } }) }); }))) : ''}
        ${section('General access', general)}
        ${section('People and groups', kb.shares.length ? list(kb.shares.map(row)) : emptyState({ icon: 'users', title: 'Not shared with anyone yet', desc: 'Share it to give people edit or owner rights.', boxed: true, compact: true }), { desc: 'Workspace admins can always manage every knowledge base.', actions: btn('Share', { v: 'secondary', icon: 'user-plus', act: 'kb-share', data: { kb: kb.id } }) })}
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
    audit(`Changed role to ${ROLE_LABEL[s.role]}`, `${shareName(s)} → ${kb.name}`);
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
    else { r.status = 'approved'; r.decided = Date.now(); audit('Approved access request', `${memberById(r.user)?.name} → ${kbById(r.kb)?.name}`, 'People & access'); toast(`Approved ${memberById(r.user)?.name || 'request'}`); }
    if (r.status === 'approved') applyApproval(r);
    refresh();
  };
  A['kb-req-deny'] = el => {
    const r = D.requests.find(x => x.id === el.dataset.id); if (!r) return;
    if (A['req-deny']) A['req-deny']({ dataset: { id: r.id } });
    else { r.status = 'denied'; r.decided = Date.now(); audit('Denied access request', `${memberById(r.user)?.name} → ${kbById(r.kb)?.name}`, 'People & access'); toast(`Denied ${memberById(r.user)?.name || 'request'}`); }
    refresh();
  };

  /* ── Share modal ── */
  A['kb-share'] = el => { S.ui.kbShare = { kb: el.dataset.kb, q: '', picked: [], role: 'viewer', busy: false }; openModal('kb-share', {}); };
  function shareOptions() {
    const f = ui('kbShare'), kb = kbById(f.kb), q = f.q.trim().toLowerCase();
    const taken = new Set([...kb.shares.map(s => s.kind + ':' + s.id), ...f.picked]);
    const groups = D.groups.map(g => ({ key: 'group:' + g.id, kind: 'group', id: g.id, sub: plural(groupMembers(g.id).length, 'member') }));
    const people = D.members.filter(m => m.status === 'active').map(m => ({ key: 'user:' + m.id, kind: 'user', id: m.id, sub: m.email }));
    return [...groups, ...people].filter(o => !taken.has(o.key) && (!q || shareName(o).toLowerCase().includes(q) || o.sub.toLowerCase().includes(q))).slice(0, 6);
  }
  M['kb-share'] = () => {
    const f = ui('kbShare'), kb = kbById(f.kb), opts = shareOptions();
    const picked = f.picked.map(k => { const [kind, id] = k.split(':'); const s = { kind, id }; return `<span class="chip chip--soft chip--default kb-pick">${esc(shareName(s))}<button type="button" data-act="kb-share-unpick" data-key="${k}" aria-label="Remove ${esc(shareName(s))}">${ic('x', 'i-xs')}</button></span>`; }).join('');
    const results = opts.length
      ? list(opts.map(o => item({ lead: shareLead(o, 'sm'), title: esc(shareName(o)), desc: esc(o.sub), act: 'kb-share-pick', data: { key: o.key } })), 'kb-share-list')
      : `<p class="t-sm muted">${f.q.trim() ? `No one called “${esc(f.q.trim())}” in this workspace.` : 'Everyone already has access.'}</p>`;
    return {
      title: `Share ${kb.name}`,
      body: `<div class="field"><label class="label" for="kbs-q">People or groups</label>${picked ? `<div class="row wrap gap-6">${picked}</div>` : ''}<div class="search-field kb-share-q">${ic('search')}<input class="input" id="kbs-q" type="search" value="${esc(f.q)}" placeholder="Search by name or email" data-input="kb-share-q" data-enter="kb-share-enter" autocomplete="off" data-autofocus ${f.busy ? 'disabled' : ''}></div>${results}</div>`
        + field({ id: 'kbs-role', label: 'Role', desc: ROLE_DESC[f.role], control: select({ id: 'kbs-role', bind: 'kbShare.role', value: f.role, options: ROLES, change: 'kb-share-role' }) }),
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + btn(f.picked.length ? `Share with ${f.picked.length}` : 'Share', { v: 'primary', act: 'kb-share-go', disabled: !f.picked.length, loading: f.busy }),
    };
  };
  A['kb-share-q'] = el => { ui('kbShare').q = el.value; refreshLayer(); };
  A['kb-share-role'] = () => refreshLayer();
  A['kb-share-pick'] = el => { const f = ui('kbShare'); f.picked.push(el.dataset.key); f.q = ''; refreshLayer(); $('#kbs-q')?.focus(); };
  A['kb-share-unpick'] = el => { const f = ui('kbShare'); f.picked = f.picked.filter(k => k !== el.dataset.key); refreshLayer(); $('#kbs-q')?.focus(); };
  A['kb-share-enter'] = () => { const o = shareOptions()[0]; if (o && ui('kbShare').q.trim()) A['kb-share-pick']({ dataset: { key: o.key } }); else if (ui('kbShare').picked.length) A['kb-share-go'](); };
  A['kb-share-go'] = async () => {
    const f = ui('kbShare'), kb = kbById(f.kb); if (f.busy || !f.picked.length) return;
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(600);
    const added = f.picked.map(k => { const [kind, id] = k.split(':'); return { kind, id, role: f.role }; });
    added.forEach(s => { kb.shares.push(s); syncShare(kb, s); });
    audit(`Shared knowledge base with ${added.map(shareName).join(', ')}`, kb.name);
    closeModal(); refresh(); toast(`Shared with ${added.length === 1 ? shareName(added[0]) : plural(added.length, 'person or group', 'people and groups')}`);
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
        ${card(formSection('Details', 'Shown on the Knowledge page and when people choose what to ask about.',
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
  A['kb-archive'] = el => {
    const kb = kbById(el.dataset.kb), n = docsIn(kb.id).length;
    confirmAction({
      title: `Archive ${kb.name}?`, body: `${n ? `Its ${plural(n, 'document')} will stop appearing in answers for everyone.` : 'It will disappear for everyone.'}`,
      confirm: 'Archive', danger: true, typeText: kb.name,
      onConfirm: () => {
        kb.archived = true; audit('Archived knowledge base', kb.name); go('/knowledge/bases');
        toast(`Archived “${kb.name}”`, { action: { label: 'Undo', run: () => { kb.archived = false; refresh(); toast(`Restored “${kb.name}”`); } } });
      },
    });
  };

  /* ═══════════════════════════ Request access ═══════════════════════════ */
  A['kb-request'] = el => { S.ui.kbReq = { kb: el.dataset.kb, role: 'viewer', note: '', touched: false, busy: false }; openModal('kb-request', {}); };
  M['kb-request'] = () => {
    const f = ui('kbReq'), kb = kbById(f.kb), err = f.touched && !f.note.trim() ? 'Tell the owners why you need access.' : '';
    return {
      size: 'sm', title: 'Request access', desc: `${esc(kb.name)} · ${esc(ownersLabel(kb))}`,
      body: `<div class="field"><span class="label">Access you need</span>${choiceGroup({ name: 'kbr-role', value: f.role, act: 'kb-req-role', options: [['viewer', 'View', 'Search and read its documents.'], ['editor', 'Edit', 'Also add and organize documents.']] })}</div>`
        + `<div class="mt-16">${field({ id: 'kbr-note', label: 'Reason', required: true, error: err, desc: 'The owners see this with your request.', control: textarea({ id: 'kbr-note', bind: 'kbReq.note', value: f.note, rows: 3, placeholder: 'e.g. I need the renewal terms for a customer call', invalid: !!err, attrs: f.busy ? 'disabled' : '' }) })}</div>`,
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + btn('Send request', { v: 'primary', act: 'kb-req-send', loading: f.busy }),
    };
  };
  A['kb-req-role'] = el => { ui('kbReq').role = el.dataset.value; refreshLayer(); };
  A['kb-req-send'] = async () => {
    const f = ui('kbReq'), kb = kbById(f.kb); if (f.busy) return;
    f.touched = true;
    if (!f.note.trim()) { refreshLayer(); $('#kbr-note')?.focus(); return; }
    f.busy = true; S.modal.props.guard = true; refreshLayer(); await sleep(700);
    D.requests.unshift({ id: uid('req'), user: me().id, kb: kb.id, role: f.role, note: f.note.trim(), at: Date.now(), status: 'pending' });
    audit('Requested access', kb.name, 'People & access');
    closeModal(); refresh(); toast(`Request sent to the owners of ${kb.name}`);
  };

  /* ═══════════════════════════ Upload ═══════════════════════════ */
  function fileEntry(name, size) {
    const ext = (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
    const err = !UPLOAD_OK.includes(ext) ? 'This file type isn’t supported' : size > MAX_BYTES ? 'Larger than 100 MB' : '';
    return { id: uid('f'), name, size, type: ext || 'file', err, pct: 0 };
  }
  const uploadTargets = () => visibleKbs().filter(canEditKb);
  /** A['kb-upload']({dataset:{kb}}). Without kb, the dialog asks where to add the files. */
  A['kb-upload'] = el => {
    const kb = kbById(el?.dataset?.kb);
    const target = kb && canEditKb(kb) ? kb : uploadTargets()[0];
    if (!target) { toast('You can’t add files to any knowledge base', { tone: 'danger' }); return; }
    S.ui.kbUpload = { kb: target.id, pick: !kb, files: [], busy: false };
    openModal('kb-upload', {});
  };
  M['kb-upload'] = () => {
    const f = ui('kbUpload'), kb = kbById(f.kb);
    const valid = f.files.filter(x => !x.err), skipped = f.files.length - valid.length;
    const have = new Set(f.files.map(x => x.name));
    const dest = f.pick && !f.busy ? `<div class="mb-16">${field({ id: 'kbu-kb', label: 'Add to', control: select({ id: 'kbu-kb', bind: 'kbUpload.kb', value: f.kb, options: uploadTargets().map(k => [k.id, k.name]), change: 'kb-up-dest' }) })}</div>` : '';
    const drop = f.busy ? '' : `<button type="button" class="kb-drop" id="kb-drop" data-act="kb-up-browse" aria-describedby="kb-drop-hint"><span class="kb-drop__icon">${ic('upload', 'i-lg')}</span><span class="medium">Drop files here or <span class="text-accent">browse</span></span><span class="description" id="kb-drop-hint">PDF, Word, Excel, PowerPoint, text and ZIP · up to 100 MB each</span></button><input type="file" multiple id="kb-up-input" class="sr-only" tabindex="-1" aria-hidden="true" accept="${UPLOAD_OK.map(x => '.' + x).join(',')}" data-change="kb-up-files">`;
    const row = x => item({
      lead: fileIcon(x.type), title: esc(x.name),
      desc: x.err ? `<span class="field-error">${ic('alert-circle')}<span>${esc(x.err)}</span></span>` : f.busy ? `<span class="row gap-8">${`<span class="grow">${progress(x.pct, x.pct >= 100 ? 'success' : '', 'Upload progress')}</span>`}<span class="num t-xs muted kb-pct">${Math.round(x.pct)}%</span></span>` : fmtSize(x.size),
      trail: f.busy ? (x.err ? '<span class="t-xs muted">Skipped</span>' : x.pct >= 100 ? ic('check-circle', 'text-success') : '') : iconBtn('x', 'Remove ' + x.name, { size: 'sm', act: 'kb-up-remove', data: { id: x.id } }),
    });
    const samples = SAMPLES.filter(s => !have.has(s.name));
    const sampleHtml = f.busy || !samples.length ? '' : `<div class="mt-16"><div class="t-label mb-8">Or try a sample file</div><div class="row wrap gap-6">${samples.map(s => btn(s.name, { v: 'outline', size: 'sm', icon: 'plus', act: 'kb-up-sample', data: { name: s.name } })).join('')}</div></div>`;
    return {
      size: 'lg', title: kb.personal && !f.pick ? 'Upload to My files' : 'Add files', desc: f.pick ? '' : kb.personal ? 'Only you can see these files.' : `To ${esc(kb.name)}`,
      body: dest + drop + (f.files.length ? `<div class="${f.busy ? '' : 'mt-16'}">${list(f.files.map(row))}</div>` : '') + sampleHtml,
      footStart: skipped && !f.busy ? `<span class="t-sm muted">${plural(skipped, 'file')} will be skipped</span>` : '',
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + btn(valid.length ? `Upload ${plural(valid.length, 'file')}` : 'Upload', { v: 'primary', icon: 'upload', act: 'kb-up-go', disabled: !valid.length, loading: f.busy }),
    };
  };
  A['kb-up-dest'] = () => refreshLayer();
  A['kb-up-browse'] = () => $('#kb-up-input')?.click();
  A['kb-up-files'] = el => { const f = ui('kbUpload'); [...(el.files || [])].forEach(x => f.files.push(fileEntry(x.name, x.size))); refreshLayer(); };
  A['kb-up-sample'] = el => { const s = SAMPLES.find(x => x.name === el.dataset.name); if (s) { ui('kbUpload').files.push(fileEntry(s.name, s.size)); refreshLayer(); } };
  A['kb-up-remove'] = el => { const f = ui('kbUpload'); f.files = f.files.filter(x => x.id !== el.dataset.id); refreshLayer(); $('#kb-drop')?.focus(); };
  document.addEventListener('dragover', e => { const z = e.target.closest?.('#kb-drop'); if (!z) return; e.preventDefault(); z.classList.add('is-drag'); });
  document.addEventListener('dragleave', e => { const z = e.target.closest?.('#kb-drop'); if (z && !z.contains(e.relatedTarget)) z.classList.remove('is-drag'); });
  document.addEventListener('drop', e => {
    const z = e.target.closest?.('#kb-drop'); if (!z) return; e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return;
    files.forEach(x => ui('kbUpload').files.push(fileEntry(x.name, x.size))); refreshLayer();
  });
  A['kb-up-go'] = () => {
    const f = ui('kbUpload'); if (f.busy) return;
    const valid = f.files.filter(x => !x.err); if (!valid.length) return;
    f.busy = true; S.modal.props.guard = true; refreshLayer();
    const timer = setInterval(() => {
      if (S.modal?.name !== 'kb-upload') { clearInterval(timer); return; }
      valid.forEach(x => { x.pct = Math.min(100, x.pct + 6 + Math.random() * (x.size > 2e7 ? 8 : 24)); });
      refreshLayer();
      if (valid.every(x => x.pct >= 100)) { clearInterval(timer); setTimeout(() => uploadDone(f, valid), 300); }
    }, 140);
  };
  function uploadDone(f, valid) {
    const kb = kbById(f.kb); closeModal();
    const docs = valid.map(x => ({
      id: uid('d'), kb: kb.id, name: x.name, type: x.type, size: Math.round(x.size), status: 'pending', source: 'upload', updated: Date.now(),
      addedBy: kb.personal ? 'You' : me().name, pages: Math.max(1, Math.round(x.size / 9e4) % 60 || 4), passages: Math.round(18 + (x.size % 240)), fresh: true,
      error: x.type === 'zip' ? 'This ZIP file is password-protected. Upload it without a password, or upload the files inside it.' : '',
    }));
    D.docs.push(...docs); kb.updated = Date.now();
    audit(docs.length === 1 ? 'Uploaded a document' : `Uploaded ${plural(docs.length, 'document')}`, kb.name);
    const u = ui(docsKey(kb.id), { sort: { key: 'updated', dir: 'desc' }, page: 1, sel: {} }); u.page = 1;
    if (S.cur.path === '/knowledge/' + kb.id) { if (S.cur.query.tab && S.cur.query.tab !== 'documents') setQuery({ tab: '' }); else refresh(); }
    else if (S.cur.path === '/knowledge/browse' || S.cur.path === '/knowledge/library') refresh();
    else go('/knowledge/' + kb.id);
    // Uploading only adds documents to the inventory; an explicit processing run makes them searchable.
    toast(`Uploaded ${plural(docs.length, 'file')} · waiting to process`, { tone: 'accent', action: { label: 'Process now', run: () => X.processDocs(docs.filter(d => D.docs.includes(d) && d.status === 'pending'), { msg: `Processing ${plural(docs.length, 'document')}` }) } });
  }
})();

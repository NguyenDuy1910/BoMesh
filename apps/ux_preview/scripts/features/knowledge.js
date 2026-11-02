/* Knowledge: knowledge base list, detail (resources, sources, access,
   settings), create, share, request access and ask. Adding documents goes
   through Contribute (contribute.js); review, publishing and the document
   inventory live in Manage → Documents (curation.js). */
(() => {
  'use strict';

  const ROLES = [['viewer', 'Viewer'], ['editor', 'Editor'], ['owner', 'Owner']];
  const ROLE_LABEL = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
  const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
  const ROLE_DESC = { viewer: 'Can search and read documents.', editor: 'Can also edit document details.', owner: 'Can also review submissions and manage access and settings.' };
  const SORTS = { updated: 'Recently updated', name: 'Name', docs: 'Most documents' };
  const COLORS = ['#B4467A', '#C2620F', '#2F6FB5', '#0E7C66', '#6B4FBF', '#1F7A8C', '#4E6B2E', '#A23B3B'];

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
      : emptyState({ icon: 'book', title: 'Nothing has been shared with you yet', desc: 'Upload your own files to ask about them. Only you can see My files.', actions: btn('Upload to My files', { v: 'primary', icon: 'upload', act: 'contribute', data: { private: '1' } }), boxed: true });
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
    const t = [{ id: 'documents', label: 'Resources', count: readerDocs(kb).length }];
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
    const hasDocs = readerDocs(kb).length > 0;
    const actions = (hasDocs ? btn('Ask', { v: 'primary', icon: 'sparkles', act: 'kb-ask', data: { kb: kb.id } }) : '')
      + (hasDocs || tab !== 'documents' ? addBtn(kb) : '')
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

  /* ── Resources tab ── */
  /** Adding documents: contributors submit to a shared base for review; My files is private and needs no review. */
  function addBtn(kb, { v = 'secondary', label = 'Contribute' } = {}) {
    if (kb.personal) return btn('Upload', { v, icon: 'upload', act: 'contribute', data: { private: '1' } });
    return canContribute() && kb.contribute !== false && canReadKb(kb) ? btn(label, { v, icon: 'upload', act: 'contribute', data: { kb: kb.id } }) : '';
  }
  function docsEmpty(kb) {
    const add = addBtn(kb, { v: 'primary', label: 'Add documents' });
    if (kb.personal) return emptyState({ icon: 'upload', title: 'No files yet', desc: 'Upload files to ask about them. Only you can see them.', actions: add, boxed: true });
    const src = can('source.manage') && kbRole(kb) === 'owner' ? btn('Connect source', { icon: 'plug', act: 'kb-connect', data: { kb: kb.id } }) : '';
    return emptyState({ icon: 'file-text', title: 'Nothing published yet', desc: add ? 'Add documents to share them. A reviewer checks them before they’re published here.' : 'The owners haven’t published anything here yet.', actions: add + src, boxed: true });
  }
  /** What a base shows: published, usable resources (My files: all of the owner's files). */
  const readerDocs = kb => (kb.personal ? docsIn(kb.id) : docsIn(kb.id).filter(isReaderVisible));
  /** For the base's reviewers: what's waiting in Manage → Documents. */
  function reviewAlert(kb) {
    if (kb.personal || !can('knowledge.manage') || !canReviewKb(kb)) return '';
    const docs = curatedDocs().filter(d => d.kb === kb.id);
    const n = docs.filter(d => stageOf(d) === 'review').length, m = docs.filter(d => lifecycleOf(d).key === 'failed').length;
    if (!n && !m) return '';
    const to = m ? `/documents?tab=all&kb=${kb.id}&life=attention` : `/documents?tab=review&kb=${kb.id}`;
    const title = [n && `${fmtNum(n)} in review`, m && `${fmtNum(m)} couldn’t be published`].filter(Boolean).join(' · ');
    return `<div class="mb-12">${alertBox(m ? 'warning' : 'accent', title, '', btn('Manage in Documents', { v: 'secondary', size: 'sm', href: to }), { icon: m ? 'alert' : 'clock' })}</div>`;
  }
  const READER_SORTS = { updated: 'Recently updated', title: 'Title A–Z', popular: 'Most opened' };
  function docsTab(kb) {
    const key = 'kbres-' + kb.id, u = ui(key, { sort: 'updated', page: 1 }), all = readerDocs(kb), toks = tokens(u.q || '');
    const cmp = { updated: (a, b) => b.updated - a.updated, title: (a, b) => a.name.localeCompare(b.name), popular: (a, b) => (b.views || 0) - (a.views || 0) }[u.sort] || ((a, b) => b.updated - a.updated);
    const rows = all.filter(d => !toks.length || scoreRes(d, toks) > 0).sort(cmp);
    return gate({
      loading: () => skelRows(8),
      empty: () => docsEmpty(kb),
      ok: () => {
        const alert = reviewAlert(kb);
        if (!all.length) return alert + docsEmpty(kb);
        const browse = kb.personal ? '' : linkBtn('Browse with filters', { href: catalogHref({ filters: { kb: [kb.id] } }), icon: 'arrow-right' });
        const toolbar = `<div class="toolbar">${searchField({ uiKey: key, placeholder: kb.personal ? 'Search my files' : 'Search this knowledge base' })}${browse}<div class="toolbar__end">${btn(READER_SORTS[u.sort], { v: 'ghost', size: 'sm', icon: 'sort', menu: 'kb-res-sort', data: { kb: kb.id }, aria: `aria-label="Sort: ${esc(READER_SORTS[u.sort])}"` })}</div></div>`;
        if (!rows.length) return alert + toolbar + noMatches(key, [], 'resources');
        return alert + toolbar + X.res.rows(paginate(rows, key, 20), { q: u.q || '' }) + pager(rows.length, key, 20);
      },
    });
  }
  MENUS['kb-res-sort'] = el => { const u = ui('kbres-' + el.dataset.kb); return [{ section: 'Sort by' }, ...Object.entries(READER_SORTS).map(([v, l]) => ({ label: l, checked: u.sort === v, run: () => { u.sort = v; u.page = 1; refresh(); } }))]; };

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
})();

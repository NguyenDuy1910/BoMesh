/* Shares — every URL BoMesh hands someone (database_architecture.md › Resource shares; api_design.md › Shares).
   A SHARE points at a document, a collection, a space or a conversation. For knowledge and spaces it grants nothing: whoever
   opens it must already be able to read the target, otherwise the landing offers Request access. A conversation is
   owner-private, so a live share is what lets its audience read it — the live conversation, read-only, every answer and
   source re-filtered for the reader (chat.js). A share's URL is /s/{share id}, so it can be copied again any time
   ("Copy link" reuses your live one). An INVITE grants a role in the workspace, a space or a collection: its URL carries a
   secret token (/s/{token}) shown once when it is made; Reset link revokes it and makes a new one with the same settings.
   Revoking is final. Accepting re-checks that the invite's creator may still grant its role (SHARE_CREATOR_NOT_ALLOWED).
   D.resourceShares (per workspace): { id, ws, kind: share|invite, target: { type: workspace|kb|doc|space|conversation, id },
   role, audience: workspace|people|anyone, recipients, expires, maxUses, uses, by, at, lastUsed, revoked, token }. The
   prototype keeps an invite's token to resolve it; the backend stores only its SHA-256.
   The landing /s/:token (P.share) works signed out (sign in or create an account, then back here), resolves the share and
   opens the target, offers Accept (invites) or Request access (shares you can't open yet), or says why it doesn't work.
   Exports X.shares = { url, create, revoke, liveFor, copyShare, sharedWithMe, newAccount }. Dialog M['sh-invite']. Prefix: sh-. */
(() => {
  'use strict';

  /* Prototype accounts: someone who creates an account to accept an invite becomes a persona (guest-…), and workspaces a
     persona joined through an invite stay joined after a reload. Restored here, before boot() hydrates the session. */
  DATA_KEYS.push('shareAccounts');
  const savedAccounts = (() => { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null')?.data?.global?.shareAccounts || null; } catch { return null; } })();
  D.shareAccounts = savedAccounts || { people: {}, joins: {} };
  Object.entries(D.shareAccounts.people).forEach(([k, p]) => { PERSONAS[k] ??= clone(p); });
  Object.entries(D.shareAccounts.joins).forEach(([k, ids]) => ids.forEach(id => { const p = PERSONAS[k]; if (p && !p.workspaces.includes(id)) p.workspaces.push(id); }));
  function saveAccounts() {
    const people = Object.fromEntries(Object.keys(PERSONAS).filter(k => k.startsWith('guest-')).map(k => [k, clone(PERSONAS[k])]));
    D.shareAccounts = { people, joins: D.shareAccounts.joins };
    persist();
  }

  /* Demo shares. Finx: an invite anyone can accept, one that expired, one that was used up, and one whose creator can no
     longer invite people (a knowledge owner, not an admin). Northwind: Ben Walker shared a conversation with Minh. */
  const DEMO = { invite: 'finx-join-7Qm2', expired: 'finx-old-K9d1', used: 'finx-full-P3x8', invalid: 'finx-lead-Z4w6' };
  const invite = (id, token, by, at, expires, maxUses, uses) => ({ id, ws: 'ws-finx', kind: 'invite', target: { type: 'workspace', id: 'ws-finx' }, role: 'r-member', audience: 'anyone', recipients: [], expires, maxUses, uses, by, at, lastUsed: uses ? at + HOUR : null, revoked: null, token });
  seedWorkspace('ws-finx', () => {
    D.resourceShares ??= [
      invite('sh-fx-1', DEMO.invite, 'u-fx-lan', ago(DAY), NOW + 6 * DAY, 25, 3),
      invite('sh-fx-2', DEMO.expired, 'u-fx-lan', ago(32 * DAY), ago(2 * DAY), null, 11),
      invite('sh-fx-3', DEMO.used, 'u-fx-lan', ago(10 * DAY), NOW + 20 * DAY, 5, 5),
      invite('sh-fx-4', DEMO.invalid, 'u-fx-ha', ago(3 * DAY), NOW + 4 * DAY, null, 0),
    ];
  });
  seedWorkspace('ws-northwind', () => {
    D.resourceShares ??= [{ id: 'sh-nw-c9', ws: 'ws-northwind', kind: 'share', target: { type: 'conversation', id: 'c9' }, role: null, audience: 'people', recipients: ['u-minh'], expires: null, maxUses: null, uses: 0, by: 'u-ben', at: ago(2 * DAY), lastUsed: null, revoked: null, token: null }];
  });
  X.demoShares = DEMO;

  /* ── Model ── */
  const shares = () => (D.resourceShares ??= []);
  const sameTarget = (a, b) => a.type === b.type && a.id === b.id;
  /** ACTIVE · EXPIRED · EXHAUSTED · REVOKED (Share.state). */
  function stateOf(s) {
    if (s.revoked) return 'revoked';
    if (s.expires && s.expires <= Date.now()) return 'expired';
    if (s.maxUses && s.uses >= s.maxUses) return 'exhausted';
    return 'active';
  }
  const live = s => stateOf(s) === 'active';
  /** The address people open: the prototype's own page + #/s/{key} (the product: its origin + Share.uri). */
  const url = (s, token) => `${location.href.split('#')[0]}#/s/${s.kind === 'share' ? s.id : token}`;
  function audit(action, target) { D.audit?.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action, type: 'People', target, outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' }); }
  /** CreateShare. Returns { share, token } — an invite's token exists only in this answer. */
  function create({ kind, target, role = null, audience, recipients = [], expires = null, maxUses = null }) {
    const token = kind === 'invite' ? Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10) : null;
    const share = { id: uid('sh'), ws: S.ws, kind, target, role, audience: audience || (kind === 'invite' ? 'anyone' : 'workspace'), recipients, expires, maxUses, uses: 0, by: me().id, at: Date.now(), lastUsed: null, revoked: null, token };
    shares().push(share);
    audit(kind === 'invite' ? 'Created an invite link' : 'Shared a link', targetName(share) || curWs().name);
    persist();
    return { share, token };
  }
  /** DeleteShare: revoking is final; the URL stops working everywhere. */
  function revoke(s) { if (!s || s.revoked) return; s.revoked = Date.now(); audit(s.kind === 'invite' ? 'Revoked an invite link' : 'Stopped sharing a link', targetName(s) || curWs().name); persist(); }
  /** Your live share of a target (any audience, or one audience). */
  const liveFor = (target, audience) => shares().find(s => s.kind === 'share' && sameTarget(s.target, target) && (!audience || s.audience === audience) && s.by === me().id && live(s));
  /** Copy link on a document, collection or space: a share to the workspace, made once and copied again after. It grants nothing. */
  async function copyShare(type, id) {
    const target = { type, id }, share = liveFor(target, 'workspace') || create({ kind: 'share', target }).share;
    await copyText(url(share), 'Link copied. Only people who can already open it will see it.');
  }
  /** Is this conversation shared with me (a live share whose audience includes me)? */
  const sharedWithMe = convId => shares().find(s => s.kind === 'share' && sameTarget(s.target, { type: 'conversation', id: convId }) && live(s) && (s.audience === 'workspace' || s.recipients.includes(me().id)));
  X.shares = { url, create, revoke, liveFor, copyShare, sharedWithMe, save: saveAccounts };
  A['sh-copy'] = el => copyShare(el.dataset.type, el.dataset.id);

  /* ── Targets and roles (read inside the share's own workspace) ── */
  function inWs(id, fn) { const prev = S.ws; S.ws = id; try { return fn(); } finally { S.ws = prev; } }
  const wsName = id => D.workspaces.find(w => w.id === id)?.name || 'this workspace';
  /** What a share points at, for the caller: { type, name, path, canRead, mine (already holds the invite's role) }. */
  function targetOf(s) {
    const t = s.target;
    if (t.type === 'workspace') return { type: t.type, name: wsName(s.ws), path: homeRoute(), canRead: true, mine: true };
    if (t.type === 'kb') { const kb = kbById(t.id); return kb && !kb.archived ? { type: t.type, kb, name: kb.name, path: kbHref(kb), canRead: canReadKb(kb), mine: KB_ROLE_RANK[kbRole(kb) || 'none'] >= KB_ROLE_RANK[s.role || 'viewer'] } : null; }
    if (t.type === 'doc') { const d = docById(t.id); return d && !d.archived ? { type: t.type, kb: kbById(d.kb), name: docTitle(d), path: '/doc/' + d.id, canRead: canSeeDoc(d) } : null; }
    if (t.type === 'space') {
      const sp = hasModule('spaces') ? spaceById(t.id) : null; if (!sp || sp.archived) return null;
      const role = spaceRole(sp);
      return { type: t.type, sp, name: sp.name, path: '/space/' + sp.id, canRead: !!role || canManageSpace(sp) || spaceType(sp.type).join === 'open', mine: !!role };
    }
    // A conversation: the share itself is what lets its audience read it (checked in resolve).
    if (t.type === 'conversation') { const conv = convById(t.id); return conv ? { type: t.type, name: conv.title, path: '/chat/' + conv.id, canRead: true } : null; }
    return null;
  }
  function targetName(s) { return inWs(s.ws, () => targetOf(s)?.name || ''); }
  /** Roles an invite can grant at a scope: workspace roles whose permissions you hold (no escalation), space roles, collection roles. */
  function rolesFor(type, id) {
    if (type === 'workspace') return D.roles.filter(r => r.perms.every(p => can(p))).map(r => [r.id, r.name]);
    if (type === 'space') return spaceType(spaceById(id)?.type).roles;
    return [['viewer', KB_ROLES.viewer.label], ['editor', KB_ROLES.editor.label]];
  }
  const roleName = s => inWs(s.ws, () => (rolesFor(s.target.type, s.target.id).find(r => r[0] === s.role) || [, roleById(s.role)?.name || s.role])[1]);
  const personLabel = (wsId, userId) => inWs(wsId, () => memberById(userId)?.name) || Object.values(PERSONAS).find(p => p.id === userId)?.name || 'Someone';
  /** May the invite's creator still grant its role there? (setIamPolicy on the scope, and the role passes require_grantable.) */
  function creatorAllowed(s) {
    const m = memberById(s.by); if (!m || m.status !== 'active') return false;
    const perms = roleById(m.roleId)?.perms || [], admin = perms.includes('tenant.manage'), t = s.target;
    if (t.type === 'workspace') return perms.includes('user.manage') && (roleById(s.role)?.perms || []).every(p => perms.includes(p));
    if (t.type === 'space') { const sp = spaceById(t.id); return !!sp && (admin || spaceType(sp.type).staff.includes(spaceRole(sp, s.by))); }
    const kb = kbById(t.id); return !!kb && (admin || kb.shares.some(x => x.kind === 'user' && x.id === s.by && x.role === 'owner'));
  }

  /* ── Resolve (shares:resolve) and accept (shares:accept) ── */
  function find(key) {
    for (const w of D.workspaces) {
      const s = inWs(w.id, () => shares().find(x => x.ws === w.id && (x.kind === 'share' ? x.id === key : x.token === key)));
      if (s) return s;
    }
    return null;
  }
  const isMemberOf = wsId => !!me().workspaces?.includes(wsId);
  /** ShareResolution: { share, kind, name (only when you can open it, or an invite's scope), ws, role, canOpen, canAccept, reason }. */
  function resolve(key) {
    const s = find(key); if (!s) return { reason: 'NOT_FOUND' };
    return inWs(s.ws, () => {
      const r = { share: s, kind: s.kind, ws: s.ws, wsName: wsName(s.ws), by: personLabel(s.ws, s.by), canOpen: false, canAccept: false, reason: '' };
      const t = targetOf(s), st = stateOf(s), member = isMemberOf(s.ws);
      if (s.kind === 'invite') { r.name = t?.name || ''; r.role = roleName(s); }
      if (!t) r.reason = 'NOT_FOUND';
      else if (st !== 'active') r.reason = st.toUpperCase();
      else if (s.kind === 'share') {
        if (!member) r.reason = 'NOT_WORKSPACE_MEMBER';
        else if (s.audience === 'people' && s.by !== me().id && !s.recipients.includes(me().id)) r.reason = 'NOT_IN_AUDIENCE';
        else if (!t.canRead) r.reason = 'NO_ACCESS';
        else Object.assign(r, { canOpen: true, name: t.name, path: t.path });
      } else if (t.type === 'workspace' ? member : !member) {
        r.reason = member ? 'ALREADY_MEMBER' : 'NOT_WORKSPACE_MEMBER';
        if (member) Object.assign(r, { canOpen: true, path: t.path });
      } else if (t.type !== 'workspace' && t.mine) Object.assign(r, { reason: 'ALREADY_MEMBER', canOpen: t.canRead, path: t.path });
      else if (!creatorAllowed(s)) r.reason = 'SHARE_CREATOR_NOT_ALLOWED';
      else r.canAccept = true;
      r.target = t;
      return r;
    });
  }
  /** Accept an invite: the membership (workspace invites), then the role at the scope; uses one only when it granted something. */
  function accept(key) {
    const r = resolve(key); if (!r.canAccept) return r;
    const s = r.share, p = me();
    inWs(s.ws, () => {
      if (s.target.type === 'workspace') {
        if (!memberById(p.id)) D.members.push({ id: p.id, name: p.name, email: p.email, roleId: s.role, status: 'active', groups: [], joined: Date.now(), lastActive: Date.now() });
        p.workspaces.push(s.ws);
        if (S.persona.startsWith('guest-')) p.perms = [...(roleById(s.role)?.perms || [])];
        else (D.shareAccounts.joins[S.persona] ||= []).push(s.ws);
      } else if (s.target.type === 'space') {
        const sp = spaceById(s.target.id); sp.members.push({ user: p.id, role: s.role }); sp.memberCount = (sp.memberCount || 0) + 1;
      } else {
        kbById(s.target.id).shares.push({ kind: 'user', id: p.id, role: s.role });
      }
      s.uses += 1; s.lastUsed = Date.now();
      audit('Joined with an invite link', r.name);
    });
    saveAccounts();
    return resolve(key);
  }
  /** Open what a share points at, inside its workspace. Replaces /s/… in history, so Back doesn't land on it again. */
  function openTarget(r) {
    if (S.ws !== r.ws) { S.ws = r.ws; S.ui = {}; (D.wsOpened ??= {})[r.ws] = Date.now(); applyTheme(); }
    S.signedIn = true; persist();
    history.replaceState(null, '', '#' + r.path); render();
  }

  /* ── /s/:token ── */
  const shUi = key => { const u = ui('sh', {}); if (u.key !== key) Object.assign(u, { key, busy: false, requested: false }); return u; };
  const nextOf = key => encodeURIComponent('/s/' + key);
  const signedAs = key => `<p class="au-foot">${X.sentence('Signed in as {0} · {1}', `<span class="medium" translate="no">${esc(me().email)}</span>`, linkBtn('Use another account', { act: 'sh-switch', data: { key } }))}</p>`;
  const homeBtn = () => btn('Go to BoMesh', { v: 'secondary', size: 'lg', full: true, act: 'sh-home' });
  const mark = (icon, warn) => `<span class="${cx('au-mark', warn && 'au-mark--warn')}">${ic(icon)}</span>`;
  const page = (icon, warn, title, sub, actions, foot = '') => X.authPage(`${mark(icon, warn)}<h1 class="t-title au-title">${esc(title)}</h1><p class="muted au-sub">${sub}</p><div class="sh-actions">${actions}</div>${foot}`);
  /** "You’re invited to join Finx Workspace as Member." — which scope and role (a resolution never names who made the invite). */
  const strong = v => `<strong translate="no">${esc(v)}</strong>`;
  const inviteLine = r => r.target?.type === 'workspace'
    ? X.sentence('You’re invited to join {0} as {1}.', strong(r.name), esc(r.role))
    : X.sentence('You’re invited to {0} in {1} as {2}.', strong(r.name), esc(r.wsName), esc(r.role));
  const DEAD = {
    NOT_FOUND: ['This link doesn’t work', 'Check that you copied all of it, or ask whoever sent it for a new one.'],
    REVOKED: ['This link was turned off', 'Whoever made it turned it off. Ask them for a new one.'],
    EXPIRED: ['This link has expired', 'Ask whoever sent it for a new one.'],
    EXHAUSTED: ['This invite link was used up', 'It was used as many times as allowed. Ask whoever sent it for a new one.'],
    SHARE_CREATOR_NOT_ALLOWED: ['This invite is no longer valid', 'Whoever made it can no longer invite people here. Ask an admin for a new invite.'],
  };
  P.share = ({ params }) => {
    const key = params.token, u = shUi(key);
    if (!S.signedIn) {
      return page('link', false, 'Sign in to open this link', 'Links open for people with a BoMesh account. If you were invited, create one with any email.',
        btn('Sign in', { v: 'primary', size: 'lg', full: true, href: `/signin?next=${nextOf(key)}` }) + btn('Create account', { v: 'secondary', size: 'lg', full: true, href: `/signup?next=${nextOf(key)}` }));
    }
    const r = resolve(key);
    if (r.canOpen) {
      setTimeout(() => { if (r.reason === 'ALREADY_MEMBER') toast(`You’re already in ${r.name || r.wsName}`, { tone: 'accent' }); openTarget(r); });
      return '';
    }
    const foot = signedAs(key);
    if (DEAD[r.reason]) return page('clock', true, DEAD[r.reason][0], esc(DEAD[r.reason][1]), homeBtn(), foot);
    if (r.canAccept) {
      return page('user-plus', false, `Join ${r.name}`, inviteLine(r),
        btn('Accept invite', { v: 'primary', size: 'lg', full: true, icon: 'check', act: 'sh-accept', data: { key }, loading: u.busy, disabled: u.busy }), foot);
    }
    if (r.reason === 'NOT_WORKSPACE_MEMBER') {
      return r.kind === 'invite'
        ? page('building', true, `Join ${r.wsName} first`, `${inviteLine(r)} <span>${esc(`It’s for people in ${r.wsName}. Ask whoever sent it for an invite to the workspace.`)}</span>`, homeBtn(), foot)
        : page('building', true, `This link is for people in ${r.wsName}`, 'Use the account you have there, or ask whoever sent it for an invite.', btn('Use another account', { v: 'primary', size: 'lg', full: true, act: 'sh-switch', data: { key } }), foot);
    }
    if (r.reason === 'NOT_IN_AUDIENCE') return page('lock', true, 'This link wasn’t shared with you', 'Only the people it was shared with can open it. Ask whoever sent it to share it with you.', homeBtn(), foot);
    // NO_ACCESS: the target stays unnamed. A collection or a space can be asked for; a document's collection is never revealed.
    const t = r.target, canAsk = t.type === 'space' ? spaceType(t.sp.type).join === 'request' : t.type === 'kb';
    const pending = u.requested || inWs(r.ws, () => t.kb ? D.requests.some(q => q.kb === t.kb.id && q.user === me().id && q.status === 'pending') : (t.sp?.joinRequests || []).some(q => q.user === me().id));
    const action = !canAsk ? homeBtn()
      : pending ? btn('Request sent', { v: 'secondary', size: 'lg', full: true, icon: 'check', disabled: true, tip: 'You’ll get a notification when someone approves it.' })
        : btn('Request access', { v: 'primary', size: 'lg', full: true, icon: 'send', act: 'sh-request', data: { key }, loading: u.busy, disabled: u.busy });
    return page('lock', true, 'You don’t have access yet', esc(canAsk ? `It’s in ${r.wsName}, but you can’t open it. Ask for access and you’ll get a notification when someone approves it.` : `It’s in ${r.wsName}, but you can’t open it. Ask whoever sent it to add you.`), action, foot);
  };
  A['sh-accept'] = async el => {
    const key = el.dataset.key, u = shUi(key); if (u.busy) return;
    u.busy = true; refresh(); await sleep(600); u.busy = false;
    const r = accept(key);
    if (!r.canOpen) { refresh(); return; }
    toast(`You joined ${r.name || r.wsName}`);
    openTarget(r);
  };
  A['sh-request'] = async el => {
    const key = el.dataset.key, u = shUi(key), r = resolve(key); if (u.busy || r.reason !== 'NO_ACCESS') return;
    u.busy = true; refresh(); await sleep(500);
    inWs(r.ws, () => {
      const t = r.target;
      if (t.kb) D.requests.push({ id: uid('req'), user: me().id, kb: t.kb.id, role: 'viewer', note: 'Opened a shared link.', at: Date.now(), status: 'pending' });
      else (t.sp.joinRequests ||= []).push({ id: uid('jr'), user: me().id, note: 'Opened a shared link.', at: Date.now() });
    });
    Object.assign(u, { busy: false, requested: true }); persist(); refresh();
    toast('Request sent. You’ll get a notification when someone approves it.');
  };
  A['sh-switch'] = el => { S.signedIn = false; persist(); go(`/signin?next=${nextOf(el.dataset.key)}`); };
  A['sh-home'] = () => { const mine = workspacesForMe(); if (!mine.length) go('/workspaces'); else enterWorkspace(mine.some(w => w.id === S.ws) ? S.ws : mine[0].id, { quiet: true }); };

  /** Create account from a link: the new account is a persona here, signed in and sent back to the link. */
  X.shares.newAccount = ({ name, email }) => {
    const key = 'guest-' + Math.random().toString(36).slice(2, 7);
    PERSONAS[key] = { id: uid('u'), name: name.trim(), email: email.trim().toLowerCase(), role: 'Member', label: name.trim().split(/\s+/)[0], perms: [], workspaces: [] };
    S.persona = key; S.signedIn = true; S.ui.prefs = null;
    saveAccounts();
  };

  /* ── Invite links: one dialog per scope (People → Members, a space's People, a collection's Access) ── */
  const EXPIRY = [['1', '1 day'], ['7', '7 days'], ['30', '30 days'], ['', 'No expiry']];
  const USES = [['', 'No limit'], ['1', '1 person'], ['10', '10 people'], ['50', '50 people']];
  const scopeName = (type, id) => type === 'workspace' ? curWs().name : type === 'space' ? spaceById(id)?.name : kbById(id)?.name;
  const scopeTarget = (type, id) => ({ type, id: type === 'workspace' ? S.ws : id });
  const invites = f => shares().filter(s => s.kind === 'invite' && sameTarget(s.target, scopeTarget(f.type, f.id)) && live(s)).sort((a, b) => b.at - a.at);
  const defaultRole = (type, id) => { const rs = rolesFor(type, id); return type === 'workspace' ? (rs.find(r => r[0] === 'r-member') || rs[0])[0] : type === 'space' ? rs[rs.length - 1][0] : 'viewer'; };
  const inv = () => ui('shInv');
  A['sh-invite'] = el => {
    const { type, id = '' } = el.dataset;
    S.ui.shInv = { type, id, role: defaultRole(type, id), expires: '7', max: '', made: null };
    S.ui.shInv.step = invites(S.ui.shInv).length ? 'list' : 'new';
    openModal('sh-invite');
  };
  const usesLine = s => (s.maxUses ? `${fmtNum(s.uses)} of ${fmtNum(s.maxUses)} used` : s.uses ? `Used ${plural(s.uses, 'time')}` : 'Not used yet');
  const expiresLine = s => (s.expires ? `Expires ${fmtDate(s.expires)}` : 'Never expires');
  M['sh-invite'] = () => {
    const f = inv(), name = scopeName(f.type, f.id) || '';
    const desc = esc(f.type === 'workspace' ? `Anyone with the link can join ${name} with the role you choose. They sign in, or create an account, first.` : `People in ${curWs().name} who open the link join ${name} with the role you choose.`);
    if (f.step === 'made') {
      const s = shares().find(x => x.id === f.made.id);
      return {
        title: 'Copy your invite link', icon: 'link', tone: 'success',
        desc: 'Copy it now: for security, BoMesh shows an invite link only once. Reset it later to get a new one.',
        body: `<div class="input-group input-group--suffix sh-url">${input({ id: 'sh-url', value: f.made.url, attrs: 'readonly', cls: 'mono' })}<span class="input-group__suffix">${iconBtn('copy', 'Copy link', { size: 'sm', act: 'sh-made-copy' })}</span></div>
          <p class="t-sm muted mt-8">${esc(`${roleName(s)} · ${s.maxUses ? `Up to ${plural(s.maxUses, 'person', 'people')}` : 'No limit'} · ${expiresLine(s)}`)}</p>`,
        foot: btn('Done', { v: 'ghost', act: 'close-modal' }) + btn('Copy link', { v: 'primary', icon: 'copy', act: 'sh-made-copy' }),
      };
    }
    if (f.step === 'list') {
      const rows = invites(f).map(s => item({
        lead: itemIcon('link', '', 'sm'), title: esc(roleName(s)), desc: `<span class="sh-line">${esc(`${usesLine(s)} · ${expiresLine(s)}`)}</span><span class="sh-line">${esc(`${personLabel(s.ws, s.by)} · ${rel(s.at)}`)}</span>`,
        trail: iconBtn('more', 'Link actions', { size: 'sm', menu: 'sh-inv-row', data: { id: s.id } }),
      }));
      return {
        title: 'Invite links', icon: 'link', desc,
        body: `<div class="field"><span class="label">Active links</span>${list(rows)}<div class="description">A link shows only when it’s made. To share one again, reset it.</div></div>`,
        foot: btn('Close', { v: 'ghost', act: 'close-modal' }) + btn('New link', { v: 'primary', icon: 'plus', act: 'sh-inv-step', data: { step: 'new' } }),
      };
    }
    return {
      title: 'New invite link', icon: 'link', desc,
      body: `<div class="sh-form">${field({ id: 'sh-role', label: 'Role', desc: f.type === 'workspace' ? esc(roleById(f.role)?.desc || '') : '', control: select({ id: 'sh-role', value: f.role, options: rolesFor(f.type, f.id), change: 'sh-inv-set', label: 'Role', attrs: 'data-key="role"' }) })}
        <div class="sh-form__row">${field({ id: 'sh-exp', label: 'Expires after', control: select({ id: 'sh-exp', value: f.expires, options: EXPIRY, change: 'sh-inv-set', label: 'Expires after', attrs: 'data-key="expires"' }) })}
        ${field({ id: 'sh-max', label: 'People who can join', control: select({ id: 'sh-max', value: f.max, options: USES, change: 'sh-inv-set', label: 'People who can join', attrs: 'data-key="max"' }) })}</div></div>`,
      foot: (invites(f).length ? btn('Back', { v: 'ghost', act: 'sh-inv-step', data: { step: 'list' } }) : btn('Cancel', { v: 'ghost', act: 'close-modal' })) + btn('Create link', { v: 'primary', icon: 'link', act: 'sh-inv-create' }),
    };
  };
  A['sh-inv-step'] = el => { inv().step = el.dataset.step; refreshLayer(); };
  A['sh-inv-set'] = el => { inv()[el.dataset.key] = el.value; refreshLayer(); };
  function made(share, token) { Object.assign(inv(), { step: 'made', made: { id: share.id, url: url(share, token) } }); refreshLayer(); }
  A['sh-inv-create'] = () => {
    const f = inv();
    const { share, token } = create({ kind: 'invite', target: scopeTarget(f.type, f.id), role: f.role, expires: f.expires ? Date.now() + +f.expires * DAY : null, maxUses: f.max ? +f.max : null });
    made(share, token);
  };
  A['sh-made-copy'] = () => copyText(inv().made?.url, 'Invite link copied');
  MENUS['sh-inv-row'] = el => {
    const s = shares().find(x => x.id === el.dataset.id); if (!s) return [];
    return [
      { label: 'Reset link', icon: 'refresh', run: () => {
        // Reset = revoke + a new invite with the same settings (the old URL stops working).
        revoke(s);
        const left = s.expires ? Math.max(DAY, s.expires - s.at) : null;
        const { share, token } = create({ kind: 'invite', target: s.target, role: s.role, expires: left && Date.now() + left, maxUses: s.maxUses });
        made(share, token);
      } },
      { sep: true },
      { label: 'Revoke link', icon: 'x-circle', danger: true, run: () => {
        revoke(s);
        const f = inv(); if (!invites(f).length) f.step = 'new';
        refreshLayer(); toast('Link revoked. It no longer works.');
      } },
    ];
  };
})();

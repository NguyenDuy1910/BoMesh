(() => {
  'use strict';
  /* Connections: the app accounts BoMesh signs in with. Reconnect, test,
     connect and disconnect accounts; sources that depend on an account
     resume or pause through the sync engine (X.src, features/sources.js).
     Secrets (tokens) are never stored or shown. */

  const appName = key => APPS[key]?.name || 'App';
  const provider = app => APPS[app]?.provider || (app === 'gdrive' ? 'Google' : 'Atlassian');
  const usedBy = acc => D.sources.filter(s => s.account === acc.id);
  const audit = (action, target) => X.src?.audit(action, target);
  const signInFailed = () => S.pageState === 'error';

  /* ── Account primitives (shared with the connect-source wizard) ── */
  const siteName = v => (v || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.atlassian\.net$/i, '').toLowerCase();
  function confErrors(c) {
    const e = {}, site = siteName(c.site);
    if (!c.site.trim()) e.site = 'Enter your Confluence site.';
    else if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(site)) e.site = 'Use just the site name, like “northwind”.';
    else if (D.accounts.some(a => a.app === 'confluence' && a.label === site + '.atlassian.net')) e.site = 'This site is already connected.';
    if (!c.email.trim()) e.email = 'Enter the email you use for Confluence.';
    else if (!EMAIL_RE.test(c.email.trim())) e.email = 'Enter a valid email, like you@company.com.';
    if (!c.token.trim()) e.token = 'Paste your API token.';
    return e;
  }
  /** Site, email and API token fields. confPath is the S.ui path of {site,email,token}; errors live beside it as `cerr`. */
  function confForm(confPath, conf, errs, onEnter) {
    const errPath = confPath.replace(/\.conf$/, '.cerr');
    const f = (k, label, o) => field({ id: 'acc-c-' + k, label, required: true, error: errs[k], desc: o.desc || '', control: input({ id: 'acc-c-' + k, bind: `${confPath}.${k}`, value: conf[k], placeholder: o.ph, type: o.type || 'text', invalid: !!errs[k], onEnter, attrs: `data-f="${k}" data-errs="${errPath}" data-input="acc-c-input"`, autocomplete: o.type === 'password' ? 'new-password' : 'off' }) });
    return `<div class="stack gap-12">${f('site', 'Site', { ph: 'yourcompany.atlassian.net' })}${f('email', 'Email', { ph: 'you@company.com', type: 'email' })}${f('token', 'API token', { ph: 'Paste your token', type: 'password', desc: 'Create one in your Atlassian account settings. BoMesh stores it encrypted and never shows it again.' })}</div>`;
  }
  A['acc-c-input'] = el => {
    const errs = getPath(el.dataset.errs), k = el.dataset.f; if (!errs?.[k]) return;
    const e = confErrors(getPath(el.dataset.bind.replace(/\.\w+$/, '')))[k] || '';
    if (e !== errs[k]) { errs[k] = e; refreshLayer(); }
  };
  async function confVerify(c) {
    await sleep(1000);
    if (c.token.trim().toLowerCase() === 'bad' || signInFailed()) return { err: 'Confluence rejected this token. Check it and try again.' };
    const label = siteName(c.site) + '.atlassian.net';
    const acc = { id: uid('acc'), app: 'confluence', label, user: c.email.trim(), status: 'connected', connected: Date.now(), checked: Date.now() };
    D.accounts.push(acc); audit('Connected an account', label);
    return { acc };
  }
  /** Simulated Google sign-in. isLive() is checked after the wait so a cancelled sign-in creates nothing. */
  async function googleSignIn(isLive = () => true) {
    await sleep(1600);
    if (!isLive() || signInFailed()) return null;
    let acc = D.accounts.find(a => a.app === 'gdrive' && a.label === me().email);
    if (!acc) { acc = { id: uid('acc'), app: 'gdrive', label: me().email, user: me().email, status: 'connected', connected: Date.now(), checked: Date.now() }; D.accounts.push(acc); audit('Connected an account', acc.label); }
    acc.status = 'connected'; acc.checked = Date.now();
    return acc;
  }
  /** Sign-in fixed: the account works again and its waiting sources resume syncing. */
  function reconnect(acc) {
    acc.status = 'connected'; acc.checked = Date.now(); acc.connected = Date.now();
    audit('Reconnected an account', acc.label);
    return X.src.resumeAccount(acc);
  }
  function reconnectMsg(acc, fixed) {
    if (!fixed.length) return `${appName(acc.app)} reconnected`;
    return `${appName(acc.app)} reconnected. Syncing ${fixed[0].name}${fixed.length > 1 ? ` and ${plural(fixed.length - 1, 'other source')}` : ''}…`;
  }
  X.acc = { confForm, confErrors, confVerify, googleSignIn, reconnect, reconnectMsg };

  /* Transient flags never survive a reload. */
  window.addEventListener('load', () => D.accounts.forEach(a => delete a.checking));

  /* ═══════════════ Page ═══════════════ */
  P.connections = () => {
    X.src?.boot();
    const live = S.pageState === 'live' && !S.navLoading;
    const empty = !S.navLoading && (S.pageState === 'empty' || (S.pageState === 'live' && !D.accounts.length));
    const broken = live && D.accounts.some(a => a.status === 'expired');
    const actions = empty ? '' : btn('Connect account', { v: broken ? 'secondary' : 'primary', icon: 'plus', act: 'acc-connect' });
    const none = () => emptyState({ icon: 'key', title: 'No accounts connected', desc: 'Connect Google Drive or Confluence so sources can sync.', actions: btn('Connect account', { v: 'primary', icon: 'plus', act: 'acc-connect' }), boxed: true });
    const body = gate({
      loading: () => skelRows(3),
      empty: none,
      ok: () => {
        if (!D.accounts.length) return none();
        const head = th('Account') + th('Status') + th('Used by') + th('Last checked') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
        return table({ label: 'Connected accounts', head, rows: D.accounts.map(accRow) });
      },
    });
    return `<div class="page">${pageHeader({ title: 'Connections', desc: 'Accounts BoMesh uses to read your apps.', actions })}${body}</div>`;
  };
  function accRow(a) {
    const used = usedBy(a);
    const st = a.checking ? `<span class="row gap-6 t-sm muted">${spinner('sm')}Checking…</span>` : status('account', a.status);
    const usedCell = used.length ? linkBtn(plural(used.length, 'source'), { act: 'acc-sources', data: { id: a.id } }) : '<span class="muted">Not used</span>';
    const main = a.status === 'expired'
      ? btn('Reconnect', { v: 'primary', size: 'sm', act: 'acc-reconnect', data: { id: a.id } })
      : btn('Test connection', { size: 'sm', act: 'acc-test', data: { id: a.id }, disabled: a.checking, cls: 'acc-test-inline' });
    return `<tr class="table__row">
      <td class="table__cell table__cell--primary"><div class="row gap-12">${appIcon(a.app)}<div class="stack src-min"><span class="cell-title truncate">${esc(a.label)}</span><span class="cell-sub truncate">${esc(appName(a.app))}${a.user !== a.label ? ' · ' + esc(a.user) : ''}</span></div></div></td>
      <td class="table__cell">${st}</td>
      <td class="table__cell">${usedCell}</td>
      <td class="table__cell table__cell--hide-sm muted">${rel(a.checked)}</td>
      <td class="table__cell table__cell--actions src-actions"><div class="row gap-4">${main}${iconBtn('more', 'More actions', { size: 'sm', menu: 'acc-row', data: { id: a.id } })}</div></td></tr>`;
  }
  MENUS['acc-row'] = el => {
    const a = accById(el.dataset.id); if (!a) return [];
    return [
      { label: 'Test connection', icon: 'refresh', disabled: a.checking, run: () => A['acc-test']({ dataset: { id: a.id } }) },
      { label: 'Reconnect', icon: 'log-in', run: () => A['acc-reconnect']({ dataset: { id: a.id } }) },
      { label: 'Connect a source', icon: 'plug', disabled: a.status !== 'connected', run: () => X.src.openWizard({ app: a.app, acc: a.id }) },
      { sep: true },
      { label: 'Disconnect', icon: 'trash', danger: true, run: () => A['acc-disconnect']({ dataset: { id: a.id } }) },
    ];
  };
  A['acc-sources'] = el => { const a = accById(el.dataset.id); if (!a) return; Object.assign(ui('srcList', {}), { q: a.label, status: '', page: 1 }); go('/sources'); };
  A['acc-test'] = async el => {
    const a = accById(el.dataset.id); if (!a || a.checking) return;
    a.checking = true; refresh(); await sleep(1000);
    if (!D.accounts.includes(a)) return;
    a.checking = false; a.checked = Date.now();
    if (a.status === 'expired') toast(`${appName(a.app)} access expired. Reconnect to resume syncing.`, { tone: 'danger', action: { label: 'Reconnect', run: () => A['acc-reconnect']({ dataset: { id: a.id } }) } });
    else toast(`${a.label} works`);
    refresh();
  };
  A['acc-disconnect'] = el => {
    const a = accById(el.dataset.id); if (!a) return; const used = usedBy(a);
    const body = used.length
      ? `${esc(used.map(s => s.name).join(', '))} will pause until you choose another account. Synced documents stay.`
      : 'BoMesh stops using this sign-in. You can connect it again anytime.';
    confirmAction({ title: `Disconnect ${a.label}?`, body, confirm: 'Disconnect', danger: true, onConfirm: () => {
      const paused = X.src.detachAccount(a);
      D.accounts.splice(D.accounts.indexOf(a), 1);
      audit('Disconnected an account', a.label);
      toast(paused.length ? `Disconnected ${a.label}. ${plural(paused.length, 'source')} paused.` : `Disconnected ${a.label}`);
      refresh();
    } });
  };

  /* ═══════════════ Reconnect (simulated sign-in) ═══════════════ */
  A['acc-reconnect'] = el => {
    const id = el?.dataset?.id; const acc = accById(id) || accById(srcById(id)?.account);
    if (!acc) { toast('This account is no longer connected', { tone: 'danger' }); return; }
    X.src.boot();
    if (acc.status === 'connected') { const fixed = reconnect(acc); toast(reconnectMsg(acc, fixed)); refresh(); return; }
    openModal('acc-reconnect', { id: acc.id, phase: 'idle' });
  };
  M['acc-reconnect'] = p => {
    const acc = accById(p.id); if (!acc) return { title: 'Account removed', body: '', foot: btn('Close', { act: 'close-modal' }) };
    const prov = provider(acc.app), title = `Reconnect ${appName(acc.app)}`;
    if (p.phase === 'waiting') return { size: 'md', title, noClose: true, body: `<div class="src-wait" role="status">${spinner('lg')}<div class="t-subheading">Finish signing in with ${prov}</div><p class="description">Sign in as ${esc(acc.user)}, then come back here.</p></div>`, foot: btn('Cancel', { act: 'acc-rc-cancel' }) };
    const used = usedBy(acc);
    const err = p.phase === 'error' ? `<div class="mb-12">${alertBox('danger', '', `${prov} didn’t confirm the sign-in. Try again.`)}</div>` : '';
    return {
      size: 'md', title, icon: appIcon(acc.app, 'lg'),
      body: `${err}${list([item({ title: esc(acc.label), desc: used.length ? 'Used by ' + esc(used.map(s => s.name).join(', ')) : 'Not used by any source', trail: status('account', acc.status) })])}<p class="description mt-12">Synced documents stay searchable. Syncing resumes once you sign in.</p>`,
      foot: btn('Cancel', { act: 'close-modal' }) + btn(p.phase === 'error' ? 'Try again' : `Continue with ${prov}`, { v: 'primary', iconRight: 'external', act: 'acc-rc-go' }),
    };
  };
  A['acc-rc-go'] = async () => {
    const p = S.modal?.props; if (!p) return;
    const t = p.t = uid('t'); p.phase = 'waiting'; p.guard = true; refreshLayer();
    await sleep(1600);
    if (S.modal?.name !== 'acc-reconnect' || S.modal.props.t !== t) return;
    if (signInFailed()) { p.phase = 'error'; p.guard = false; refreshLayer(); return; }
    const acc = accById(p.id); closeModal(); if (!acc) return;
    const fixed = reconnect(acc);
    toast(reconnectMsg(acc, fixed), fixed.length ? { action: { label: 'View', run: () => X.src.open(fixed[0].id) } } : {});
    refresh();
  };
  A['acc-rc-cancel'] = () => { const p = S.modal?.props; if (!p) return; p.t = null; p.phase = 'idle'; p.guard = false; refreshLayer(); };

  /* ═══════════════ Connect an account ═══════════════ */
  A['acc-connect'] = el => {
    if (!can('source.manage')) return;
    const d = el?.dataset || {};
    S.ui.accNew = { app: APPS[d.app] && d.app !== 'upload' ? d.app : 'gdrive', fixed: !!d.app, src: d.src || '', conf: { site: '', email: '', token: '' }, cerr: {}, phase: 'idle', busy: false, t: null };
    openModal('acc-connect');
  };
  M['acc-connect'] = () => {
    const f = S.ui.accNew; if (!f) return { title: 'Connect account', body: '' };
    const prov = provider(f.app);
    if (f.phase === 'waiting') return { size: 'md', title: 'Connect account', noClose: true, body: `<div class="src-wait" role="status">${spinner('lg')}<div class="t-subheading">Finish signing in with ${prov}</div><p class="description">A ${prov} window opened. Come back here when you’re done.</p></div>`, foot: btn('Cancel', { act: 'acc-new-cancel' }) };
    const apps = D.pConnectors.filter(c => c.key !== 'upload' && c.status === 'enabled');
    const pick = f.fixed ? '' : `<div class="field src-choices"><span class="label">App</span>${choiceGroup({ name: 'acc-app', value: f.app, options: apps.map(c => [c.key, c.name, esc(c.auth || '')]), act: 'acc-new-app', cols: 2 })}</div>`;
    const err = f.phase === 'error' ? alertBox('danger', '', `${prov} didn’t confirm the sign-in. Try again.`) : '';
    const form = f.app === 'confluence' ? confForm('accNew.conf', f.conf, f.cerr, 'acc-new-go') : '<p class="description">You’ll sign in with Google in a new window. BoMesh only reads the folders you choose.</p>';
    return {
      size: 'md', title: f.fixed ? `Connect ${appName(f.app)} account` : 'Connect account',
      body: `<div class="stack gap-16">${err}${pick}${form}</div>`,
      foot: btn('Cancel', { act: 'close-modal', disabled: f.busy }) + (f.app === 'gdrive' ? btn('Continue with Google', { v: 'primary', iconRight: 'external', act: 'acc-new-go' }) : btn('Verify and connect', { v: 'primary', act: 'acc-new-go', loading: f.busy })),
    };
  };
  A['acc-new-app'] = el => { const f = ui('accNew'); f.app = el.dataset.value; f.cerr = {}; f.phase = 'idle'; refreshLayer(); };
  A['acc-new-cancel'] = () => { const f = ui('accNew'); f.t = null; f.phase = 'idle'; f.busy = false; guard(false); refreshLayer(); };
  const guard = on => { if (S.modal?.name === 'acc-connect') S.modal.props.guard = on; };
  A['acc-new-go'] = async () => {
    const f = S.ui.accNew; if (!f || f.busy) return;
    const t = f.t = uid('t');
    let acc = null;
    if (f.app === 'gdrive') {
      f.phase = 'waiting'; f.busy = true; guard(true); refreshLayer();
      acc = await googleSignIn(() => S.ui.accNew === f && f.t === t && S.modal?.name === 'acc-connect');
      if (S.ui.accNew !== f || f.t !== t || S.modal?.name !== 'acc-connect') return;
      f.busy = false; guard(false);
      if (!acc) { f.phase = 'error'; refreshLayer(); return; }
    } else {
      f.cerr = confErrors(f.conf); const bad = Object.keys(f.cerr);
      if (bad.length) { refreshLayer(); $('#acc-c-' + bad[0])?.focus(); return; }
      f.busy = true; guard(true); refreshLayer();
      const res = await confVerify(f.conf);
      if (S.ui.accNew !== f || S.modal?.name !== 'acc-connect') return;
      f.busy = false; guard(false);
      if (res.err) { f.cerr = { token: res.err }; refreshLayer(); $('#acc-c-token')?.focus(); return; }
      acc = res.acc;
    }
    closeModal(); S.ui.accNew = null;
    const s = srcById(f.src);
    if (s) X.src.attach(s, acc);
    else toast(`Connected ${acc.label}`, { action: { label: 'Connect source', run: () => X.src.openWizard({ app: acc.app, acc: acc.id }) } });
    refresh();
  };
})();

/* Auth: sign in (/signin), create account (/signup), workspace chooser (/workspaces).
   Mock rules: any persona email (or its local part as username) + password "demo". */
(() => {
  'use strict';

  /* When each workspace was last opened (persisted so the chooser can sort and label). */
  D.wsOpened ??= { 'ws-northwind': ago(2 * HOUR), 'ws-nwfin': ago(6 * DAY) };
  DATA_KEYS.push('wsOpened');

  const GOOGLE = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.7-4.9h-4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.8l4-3z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c1-2.8 3.6-4.9 6.7-4.9z"/></svg>';
  const brand = () => `<div class="row au-brand"><div class="brand grow"><span class="brand__mark">${ic('layers', 'i-sm')}</span>BoMesh</div>${X.lang.picker()}</div>`;
  const signinUi = () => ui('auSignin', { id: '', pw: '', show: false, err: {}, busy: '', demo: false });
  const signupUi = () => ui('auSignup', { name: '', email: '', pw: '', show: false, terms: false, err: {}, busy: false });
  const wsUi = () => ui('auWs', { fresh: false, email: '', busy: false, checks: 0 });

  /** Persona id for an email, or for a username (the email's local part). */
  function personaFor(identifier) {
    const v = identifier.trim().toLowerCase();
    return Object.keys(PERSONAS).find(k => { const e = PERSONAS[k].email.toLowerCase(); return e === v || e.split('@')[0] === v; });
  }
  const accountExists = email => { const v = email.trim().toLowerCase(); return Object.values(PERSONAS).some(p => p.email.toLowerCase() === v) || D.members.some(m => String(m.email || '').toLowerCase() === v); };

  /** field() plus an error line that may contain an action (field() escapes its error text). */
  function fieldWithError(o, msg, action = '') {
    const html = field(o);
    return msg ? html.replace(/<\/div>$/, `<div class="field-error" id="${o.id}-err" role="alert">${ic('alert-circle')}<span>${esc(msg)}${action ? ' ' + action : ''}</span></div></div>`) : html;
  }
  /** Password input with a show/hide icon button. */
  function passwordInput({ id, bind, value, show, act, onEnter, autocomplete, invalid, live }) {
    return `<div class="input-group input-group--suffix au-pw">${input({ id, bind, value, type: show ? 'text' : 'password', onEnter, autocomplete, invalid, attrs: live ? 'data-live' : '' })}<span class="input-group__suffix">${iconBtn(show ? 'eye-off' : 'eye', show ? 'Hide password' : 'Show password', { size: 'sm', act })}</span></div>`;
  }

  /* ── Sign in ── */
  function proof() {
    return `<figure class="au-proof">
      <div class="card au-proof__card" aria-hidden="true">
        <div class="au-proof__q">What’s the meal allowance for international travel?</div>
        <div class="au-proof__a"><span class="au-proof__ai">${ic('sparkles', 'i-sm')}</span><p>The allowance is <strong>USD 75 per day</strong><span class="cite">1</span>. Keep receipts for lodging and transport<span class="cite">2</span>.</p></div>
        <div class="row gap-8 wrap au-proof__sources"><span class="au-source">${fileIcon('pdf', 'sm')}<span class="truncate">Travel Policy.pdf</span><span class="muted">p. 8</span></span><span class="au-source">${fileIcon('xlsx', 'sm')}<span class="truncate">Expense limits.xlsx</span></span></div>
      </div>
      <figcaption class="au-proof__caption">Answers from your company’s knowledge, with sources you can check.</figcaption>
    </figure>`;
  }

  /** A person's role in one workspace, from that workspace's own membership (not their job title or platform role). */
  function wsRoleOf(p, wsId) {
    const store = DB.ws[wsId] || DB.ws['ws-northwind'];
    const m = store?.members?.find(x => x.id === p.id);
    return store?.roles?.find(r => r.id === m?.roleId)?.name || (p.perms.includes('tenant.manage') ? 'Workspace admin' : 'Member');
  }
  /** Demo accounts as one-click identities (fills the form; password is always “demo”). Folded away: a prototype aid, not a way in.
      Each shows its role and workspace, so testers can tell the admins (and the platform operator) apart. */
  function demoAccounts() {
    const wsName = id => D.workspaces.find(w => w.id === id)?.name || '';
    const people = ['member', 'admin', 'operator', 'engineer', 'lead', 'analyst', 'wsadmin'].filter(k => PERSONAS[k]);
    const line = k => { const p = PERSONAS[k]; return k === 'operator' ? 'Platform admin · Platform console' : `${wsRoleOf(p, p.workspaces?.[0])} · ${wsName(p.workspaces?.[0])}`; };
    const grid = `<div class="au-demo__grid">${people.map(k => { const p = PERSONAS[k], on = signinUi().id.trim().toLowerCase() === p.email.toLowerCase(); return `<button type="button" class="au-demo__btn" aria-pressed="${on}" data-act="au-demo" data-p="${k}" data-tip="${esc(p.email)}">${avatar(p.name, 'xs')}<span class="au-demo__text"><span class="au-demo__name truncate">${esc(p.name)}</span><span class="au-demo__ws truncate">${esc(line(k))}</span></span></button>`; }).join('')}</div>`;
    return `<div class="au-demo">${disclosure({ path: 'auSignin.demo', icon: 'users', title: 'Try a demo account', summary: 'Password <span class="mono">demo</span>', body: grid })}</div>`;
  }

  P.signin = () => {
    const s = signinUi(), e = s.err, busy = !!s.busy;
    return `<div class="auth au-page">
      <main class="auth__form"><div class="auth__form-inner">
        ${brand()}
        <h1 class="t-title au-title">Sign in</h1>
        <p class="muted au-sub">Welcome back. Pick up where your team left off.</p>
        ${field({ id: 'au-id', label: 'Email or username', error: e.id, control: input({ id: 'au-id', bind: 'auSignin.id', value: s.id, placeholder: 'name@company.com', onEnter: 'au-signin', autocomplete: 'username', invalid: !!e.id, autofocus: true }) })}
        ${field({ id: 'au-pw', label: 'Password', error: e.pw, control: passwordInput({ id: 'au-pw', bind: 'auSignin.pw', value: s.pw, show: s.show, act: 'au-signin-show', onEnter: 'au-signin', autocomplete: 'current-password', invalid: !!e.pw }) })}
        <div class="row end au-forgot">${linkBtn('Forgot password?', { act: 'au-forgot' })}</div>
        ${e.form ? `<div class="au-form-error">${alertBox('danger', e.form)}</div>` : ''}
        ${btn('Sign in', { v: 'primary', size: 'lg', full: true, act: 'au-signin', loading: s.busy === 'pw', disabled: busy, id: 'au-submit' })}
        <div class="au-or" role="separator"><span>or</span></div>
        ${btn('Continue with Google', { v: 'outline', size: 'lg', full: true, act: 'au-google', loading: s.busy === 'google', disabled: busy, cls: 'au-google' }).replace('<span>', GOOGLE + '<span>')}
        <p class="au-foot">New to BoMesh? ${linkBtn('Create account', { href: '/signup' })}</p>
        ${demoAccounts()}
      </div></main>
      <aside class="auth__aside au-aside">${proof()}</aside>
    </div>`;
  };

  function validateSignin(s) {
    const e = {}, id = s.id.trim();
    if (!id) e.id = 'Enter your email or username.';
    else if (id.includes('@') && !EMAIL_RE.test(id)) e.id = 'Enter a full email address, like name@company.com.';
    else if (!id.includes('@') && id.length < 3) e.id = 'Usernames have at least 3 characters.';
    if (!s.pw) e.pw = 'Enter your password.';
    return e;
  }
  /** Signed in as persona `pid`: straight in when they belong to one workspace, else choose. */
  function enterAs(pid) {
    const s = signinUi(); s.busy = ''; s.pw = ''; s.err = {}; s.show = false;
    S.persona = pid; S.ui.prefs = null; S.signedIn = true;
    Object.assign(wsUi(), { fresh: false, checks: 0 });
    const mine = workspacesForMe();
    if (mine.length === 1) { enterWorkspace(mine[0].id, { quiet: true }); return; }
    persist();
    go('/workspaces');
  }
  A['au-signin'] = async () => {
    const s = signinUi(); if (s.busy) return;
    s.err = validateSignin(s);
    if (s.err.id || s.err.pw) { refresh(); $(s.err.id ? '#au-id' : '#au-pw')?.focus(); return; }
    s.busy = 'pw'; refresh();
    await sleep(700);
    const pid = personaFor(s.id);
    if (!pid || s.pw !== 'demo') { s.busy = ''; s.pw = ''; s.err = { form: 'Email or password is incorrect' }; refresh(); $('#au-pw')?.focus(); return; }
    enterAs(pid);
  };
  A['au-google'] = async () => {
    const s = signinUi(); if (s.busy) return;
    s.err = {}; s.busy = 'google'; refresh();
    await sleep(900);
    enterAs(S.persona);
  };
  A['au-signin-show'] = () => { const s = signinUi(); s.show = !s.show; refresh(); $('#au-pw')?.focus(); };
  A['au-forgot'] = () => {
    const s = signinUi();
    if (!s.id.trim()) { s.err = { id: 'Enter your email or username first.' }; refresh(); $('#au-id')?.focus(); return; }
    toast('If an account exists, we sent a reset link.', { tone: 'accent' });
  };
  /** Fill the form with a demo account and hand focus to Sign in, so Enter (or one click) finishes. */
  A['au-demo'] = el => { const s = signinUi(), p = PERSONAS[el?.dataset?.p] || PERSONAS.member; s.id = p.email; s.pw = 'demo'; s.err = {}; refresh(); $('#au-submit')?.focus(); };

  /* ── Create account ── */
  const PW_RULES = [
    [pw => pw.length >= 8, 'At least 8 characters', true],
    [pw => /[A-Za-z]/.test(pw) && /\d/.test(pw), 'Letters and numbers', true],
    [pw => pw.length >= 12 || /[^A-Za-z0-9]/.test(pw), 'A symbol or 12+ characters for extra strength', false],
  ];
  function strength(pw) {
    if (!pw) return null;
    const score = PW_RULES.filter(([t]) => t(pw)).length + (pw.length >= 12 && /[^A-Za-z0-9]/.test(pw) ? 1 : 0);
    return [['danger', 'Weak'], ['danger', 'Weak'], ['warning', 'Fair'], ['success', 'Good'], ['success', 'Strong']][score].concat(score * 25);
  }

  P.signup = () => {
    const f = signupUi(), e = f.err, st = strength(f.pw);
    /* The checklist appears once there's a password to check; before that one line says what's needed. */
    const meter = f.pw ? `<div class="au-strength" aria-live="polite">
      <div class="row gap-8">${progress(st[2], st[0], 'Password strength')}<span class="t-xs medium au-strength__label">${st[1]}</span></div>
      <ul class="au-rules">${PW_RULES.map(([t, label]) => { const ok = t(f.pw); return `<li class="${ok ? 'is-ok' : ''}">${ic(ok ? 'check-circle' : 'circle-dashed', 'i-sm')}${esc(label)}</li>`; }).join('')}</ul>
    </div>` : '';
    return `<div class="auth auth--single au-page">
      <main class="auth__form"><div class="auth__form-inner au-narrow">
        ${brand()}
        <h1 class="t-title au-title">Create your account</h1>
        <p class="muted au-sub">Use your work email. If a workspace admin invited you, use the address the invite went to.</p>
        ${field({ id: 'su-name', label: 'Full name', error: e.name, control: input({ id: 'su-name', bind: 'auSignup.name', value: f.name, placeholder: 'Kevin Ng', autocomplete: 'name', autofocus: true, invalid: !!e.name, onEnter: 'au-signup' }) })}
        ${fieldWithError({ id: 'su-email', label: 'Work email', control: input({ id: 'su-email', bind: 'auSignup.email', value: f.email, type: 'email', placeholder: 'name@company.com', autocomplete: 'email', invalid: !!e.email, onEnter: 'au-signup' }) }, e.email, e.dup ? linkBtn('Sign in instead', { act: 'au-signin-instead' }) : '')}
        ${field({ id: 'su-pw', label: 'Password', error: e.pw, desc: f.pw || e.pw ? '' : 'At least 8 characters, with letters and numbers.', control: passwordInput({ id: 'su-pw', bind: 'auSignup.pw', value: f.pw, show: f.show, act: 'au-signup-show', onEnter: 'au-signup', autocomplete: 'new-password', invalid: !!e.pw, live: true }) + meter })}
        <div class="au-terms">${checkbox({ id: 'su-terms', label: 'I agree to the terms of service and privacy policy', checked: f.terms, bind: 'auSignup.terms' })}
          ${e.terms ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(e.terms)}</span></div>` : ''}</div>
        ${btn('Create account', { v: 'primary', size: 'lg', full: true, act: 'au-signup', loading: f.busy, disabled: f.busy })}
        <p class="au-foot">Already have an account? ${linkBtn('Sign in', { href: '/signin' })}</p>
      </div></main>
    </div>`;
  };
  A['au-signup-show'] = () => { const f = signupUi(); f.show = !f.show; refresh(); $('#su-pw')?.focus(); };
  A['au-signin-instead'] = () => { const s = signinUi(); s.id = signupUi().email.trim(); s.pw = ''; s.err = {}; go('/signin'); };
  A['au-signup'] = async () => {
    const f = signupUi(); if (f.busy) return;
    const e = {}, email = f.email.trim();
    if (!f.name.trim()) e.name = 'Enter your name.';
    if (!EMAIL_RE.test(email)) e.email = 'Enter an email like name@company.com.';
    else if (accountExists(email)) { e.email = 'An account already uses this email.'; e.dup = true; }
    if (!PW_RULES.filter(r => r[2]).every(([t]) => t(f.pw))) e.pw = 'Use at least 8 characters with letters and numbers.';
    if (!f.terms) e.terms = 'Accept the terms to continue.';
    f.err = e; refresh();
    const first = e.name ? '#su-name' : e.email ? '#su-email' : e.pw ? '#su-pw' : e.terms ? '#su-terms' : '';
    if (first) { $(first)?.focus(); return; }
    f.busy = true; refresh();
    await sleep(800);
    Object.assign(wsUi(), { fresh: true, email: email.toLowerCase(), checks: 0, busy: false });
    S.signedIn = false; persist();
    Object.assign(f, { name: '', email: '', pw: '', show: false, terms: false, err: {}, busy: false });
    go('/workspaces');
    toast('Account created');
  };

  /* ── Choose a workspace ── */
  const roleIn = ws => wsRoleOf(me(), ws.id);
  const isArchived = ws => D.pWorkspaces.find(x => x.id === ws.id)?.status === 'archived';
  const opened = ws => D.wsOpened[ws.id] || 0;
  /** “Last opened 5 h ago” / “Last opened Sep 27”: lower-case relative words, keep month names as written. */
  const openedLabel = t => { const r = rel(t); return `Last opened ${/^\p{Lu}\p{Ll}+ \d/u.test(r) ? r : r.toLowerCase()}`; };

  P.workspaces = () => {
    const w = wsUi();
    if (!w.fresh && !S.signedIn) { setTimeout(() => { history.replaceState(null, '', '#/signin'); render(); }); return ''; }
    const email = w.fresh ? w.email : me().email;
    let body;
    if (w.fresh) {
      body = emptyState({ icon: 'building', title: 'No workspace yet', desc: `When a workspace admin adds or invites <strong>${esc(email)}</strong>, the workspace shows up here.`, actions: btn('Check again', { v: 'primary', icon: 'refresh', act: 'au-ws-check', loading: w.busy, disabled: w.busy }), boxed: true });
    } else {
      const all = workspacesForMe().sort((a, b) => opened(b) - opened(a));
      const mixed = new Set(all.map(ws => wsTemplateId(ws))).size > 1;   // the template only helps tell workspaces apart when they differ
      const rows = all.filter(ws => matchesQ('auWs', ws.name, ws.code, roleIn(ws), wsTemplate(ws).label));
      const items = rows.map(ws => isArchived(ws)
        ? item({ lead: wsMark(ws, 36), title: esc(ws.name), titleExtra: status('ws', 'archived'), desc: 'Archived. Ask a platform admin to restore it.', cls: 'au-ws-off' })
        : item({ lead: wsMark(ws, 36), title: esc(ws.name), titleExtra: mixed ? chip(wsTemplate(ws).label, { size: 'sm' }) : '', desc: `${esc(roleIn(ws))} · ${plural(ws.members, 'member')}`, meta: opened(ws) ? esc(openedLabel(opened(ws))) : '', trail: ic('chevron-right', 'au-chev'), act: 'au-ws-enter', data: { id: ws.id } }));
      const console_ = isOperator() ? `<div class="au-group"><div class="t-label au-group__label">Administration</div>${list([item({ lead: `<span class="ws-mark au-console-mark" style="width:36px;height:36px">${ic('layers', 'i-sm')}</span>`, title: 'Platform console', desc: 'Workspaces, users, connectors and system health', trail: ic('chevron-right', 'au-chev'), act: 'au-console' })])}</div>` : '';
      body = `${needsTools(all.length, 'auWs') ? `<div class="mb-12">${searchField({ uiKey: 'auWs', placeholder: 'Search workspaces' })}</div>` : ''}
        ${rows.length ? list(items) : noMatches('auWs', [], 'workspaces')}${console_}`;
    }
    return `<div class="auth auth--single au-page">
      <main class="auth__form"><div class="auth__form-inner au-ws">
        ${brand()}
        <h1 class="t-title au-title">${w.fresh ? 'Welcome to BoMesh' : 'Choose a workspace'}</h1>
        <p class="muted au-sub au-who">Signed in as <span class="medium au-who__email">${esc(email)}</span> · ${linkBtn('Sign out', { act: 'au-signout' })}</p>
        ${body}
      </div></main>
    </div>`;
  };
  A['au-ws-enter'] = el => { S.signedIn = true; enterWorkspace(el.dataset.id, { quiet: true }); };
  A['au-console'] = () => { S.signedIn = true; persist(); go('/p/workspaces'); };
  A['au-ws-check'] = async () => {
    const w = wsUi(); if (w.busy) return;
    w.busy = true; refresh();
    await sleep(800);
    w.busy = false; w.checks++;
    if (w.checks >= 2) {
      Object.assign(w, { fresh: false, checks: 0 });
      S.persona = 'member'; S.ui.prefs = null; S.signedIn = true; persist();
      toast(`You were added to ${D.workspaces[0].name}`);
    } else toast('Not yet. No workspace has added or invited you.', { tone: 'accent' });
    refresh();
  };
  A['au-signout'] = () => {
    Object.assign(wsUi(), { fresh: false, checks: 0, busy: false });
    S.signedIn = false; persist(); go('/signin');
    toast('Signed out', { tone: 'accent' });
  };
})();

/* Auth: sign in (/signin), create account (/signup), password reset (/password-reset, /password-reset/:token),
   workspace chooser (/workspaces) with the public workspaces you can join, and a public workspace's own address (/w/:code).
   Mock rules: any persona email (or its local part as username) + password "demo" (or the password last set by a reset). */
(() => {
  'use strict';

  /* When each workspace was last opened (persisted so the chooser can sort and label). */
  D.wsOpened ??= { 'ws-northwind': ago(2 * HOUR), 'ws-nwfin': ago(6 * DAY) };
  DATA_KEYS.push('wsOpened');

  const GOOGLE = '<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.7-4.9h-4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.3 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.8l4-3z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c1-2.8 3.6-4.9 6.7-4.9z"/></svg>';
  const brand = () => `<div class="au-brand"><div class="brand"><span class="brand__mark">${ic('layers', 'i-sm')}</span>BoMesh</div></div>`;
  /** The brand panel's illustration: layered documents (a page with a marked passage under a focus ring, a page behind it,
      a small chart in front) joined to a network of concept nodes. Decorative; colours and motion live in auth.css. */
  const ART = `<svg class="au-art" viewBox="0 0 520 420" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
    <defs>
      <pattern id="au-art-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle class="au-art__dot" cx="2" cy="2" r="1.1"/></pattern>
      <radialGradient id="au-art-fade"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <mask id="au-art-mask"><rect width="520" height="420" fill="url(#au-art-fade)"/></mask>
      <filter id="au-art-shadow" x="-30%" y="-30%" width="160%" height="170%"><feDropShadow class="au-art__shadow" dx="0" dy="14" stdDeviation="16"/></filter>
    </defs>
    <rect width="520" height="420" fill="url(#au-art-dots)" mask="url(#au-art-mask)"/>
    <circle class="au-art__orbit" cx="290" cy="214" r="178"/>
    <circle class="au-art__orbit" cx="290" cy="214" r="116"/>
    <g class="au-art__float au-art__float--late"><g transform="rotate(7 366 176)" filter="url(#au-art-shadow)">
      <rect class="au-art__paper" x="290" y="62" width="156" height="200" rx="16"/>
      <rect class="au-art__tile--blue" x="308" y="82" width="26" height="26" rx="8"/><rect class="au-art__glyph--blue" x="316" y="90" width="10" height="10" rx="3"/>
      <rect class="au-art__ink-strong" x="344" y="86" width="70" height="7" rx="3.5"/><rect class="au-art__ink" x="344" y="99" width="46" height="5" rx="2.5"/>
      <rect class="au-art__ink" x="308" y="128" width="120" height="5" rx="2.5"/><rect class="au-art__ink" x="308" y="142" width="104" height="5" rx="2.5"/>
      <rect class="au-art__ink" x="308" y="156" width="116" height="5" rx="2.5"/><rect class="au-art__ink" x="308" y="170" width="70" height="5" rx="2.5"/>
    </g></g>
    <g transform="rotate(-3 266 218)" filter="url(#au-art-shadow)">
      <rect class="au-art__paper" x="168" y="96" width="196" height="244" rx="18"/>
      <rect class="au-art__tile--peach" x="188" y="116" width="30" height="30" rx="9"/><path class="au-art__glyph--peach" d="M197 124h8l5 5v9a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2z"/>
      <rect class="au-art__ink-strong" x="228" y="121" width="92" height="8" rx="4"/><rect class="au-art__ink" x="228" y="135" width="58" height="6" rx="3"/>
      <rect class="au-art__ink" x="188" y="168" width="156" height="6" rx="3"/><rect class="au-art__ink" x="188" y="184" width="140" height="6" rx="3"/>
      <rect class="au-art__ink" x="188" y="200" width="150" height="6" rx="3"/>
      <rect class="au-art__mark" x="184" y="214" width="132" height="16" rx="5"/><rect class="au-art__mark-ink" x="190" y="219" width="120" height="6" rx="3"/>
      <rect class="au-art__ink" x="188" y="240" width="146" height="6" rx="3"/><rect class="au-art__ink" x="188" y="256" width="122" height="6" rx="3"/>
      <rect class="au-art__ink" x="188" y="272" width="98" height="6" rx="3"/>
      <rect class="au-art__ink" x="188" y="306" width="40" height="14" rx="7"/><rect class="au-art__ink" x="234" y="306" width="54" height="14" rx="7"/>
    </g>
    <g class="au-art__float"><g transform="rotate(-7 146 300)" filter="url(#au-art-shadow)">
      <rect class="au-art__paper" x="70" y="246" width="152" height="112" rx="14"/>
      <rect class="au-art__ink-strong" x="86" y="262" width="56" height="6" rx="3"/><rect class="au-art__ink" x="86" y="274" width="36" height="5" rx="2.5"/>
      <rect class="au-art__bar--soft" x="88" y="314" width="16" height="28" rx="4"/><rect class="au-art__bar--blue" x="112" y="300" width="16" height="42" rx="4"/>
      <rect class="au-art__bar--soft" x="136" y="320" width="16" height="22" rx="4"/><rect class="au-art__bar--violet" x="160" y="292" width="16" height="50" rx="4"/>
      <rect class="au-art__bar--soft" x="184" y="308" width="16" height="34" rx="4"/>
    </g></g>
    <path class="au-art__link au-art__link--quiet" d="M78 92 Q 54 150 104 186"/>
    <path class="au-art__link au-art__link--quiet" d="M458 60 Q 526 180 478 300"/>
    <path class="au-art__link" d="M313 227 C 250 120, 160 70, 78 92"/>
    <path class="au-art__link" d="M313 227 C 360 160, 400 86, 458 60"/>
    <path class="au-art__link" d="M313 227 C 380 250, 420 300, 478 300"/>
    <path class="au-art__link" d="M313 227 C 330 300, 360 362, 404 378"/>
    <circle class="au-art__lens" cx="313" cy="227" r="30"/>
    <circle class="au-art__halo au-art__halo--violet" cx="78" cy="92" r="22"/>
    <circle class="au-art__halo au-art__halo--peach" cx="478" cy="300" r="22"/>
    <circle class="au-art__node au-art__node--violet" cx="78" cy="92" r="15"/>
    <circle class="au-art__node au-art__node--blue" cx="458" cy="60" r="13"/>
    <circle class="au-art__node au-art__node--peach" cx="478" cy="300" r="15"/>
    <g class="au-art__icon" transform="translate(70.8 84.8) scale(0.6)"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></g>
    <g class="au-art__icon" transform="translate(451.4 53.4) scale(0.55)"><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r=".5"/></g>
    <g class="au-art__icon" transform="translate(470.8 292.8) scale(0.6)"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></g>
    <circle class="au-art__node au-art__node--amber" cx="404" cy="378" r="6"/>
    <circle class="au-art__node au-art__node--blue" cx="104" cy="186" r="5"/>
    <circle class="au-art__node au-art__node--violet" cx="313" cy="227" r="6"/>
    <rect class="au-art__spark" x="150" y="50" width="10" height="10" rx="2" transform="rotate(45 155 55)"/>
    <circle class="au-art__ring" cx="236" cy="380" r="6"/>
  </svg>`;
  const aside = () => `<aside class="auth__aside au-aside">${ART}</aside>`;
  /** Every auth page: the brand bar, the centred content and a footer; `art` adds the brand panel (sign-in pages). */
  const shell = (inner, { art = false, cls = '' } = {}) => `<div class="auth${art ? '' : ' auth--single'} au-page">
      <main class="auth__form">${brand()}<div class="auth__form-inner${cls ? ' ' + cls : ''}">${inner}</div><footer class="au-legal">© ${new Date().getFullYear()} BoMesh</footer></main>
      ${art ? aside() : ''}
    </div>`;
  const signinUi = () => ui('auSignin', { id: '', pw: '', show: false, err: {}, busy: '', demo: false, notice: '' });
  const signupUi = () => ui('auSignup', { name: '', email: '', pw: '', show: false, terms: false, err: {}, busy: false });
  const wsUi = () => ui('auWs', { fresh: false, email: '', name: '', busy: false, checks: 0 });

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
  function passwordInput({ id, bind, value, show, act, onEnter, autocomplete, invalid, live, autofocus }) {
    return `<div class="input-group input-group--suffix au-pw">${input({ id, bind, value, type: show ? 'text' : 'password', onEnter, autocomplete, invalid, autofocus, attrs: live ? 'data-live' : '' })}<span class="input-group__suffix">${iconBtn(show ? 'eye-off' : 'eye', show ? 'Hide password' : 'Show password', { size: 'sm', act })}</span></div>`;
  }

  /* ── Sign in ── */
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
    const people = ['member', 'admin', 'operator', 'engineer', 'lead', 'analyst', 'wsadmin', 'applicant'].filter(k => PERSONAS[k]);
    const line = k => { const p = PERSONAS[k], ws = p.workspaces?.[0] || p.joins?.[0]; return k === 'operator' ? 'Platform admin · Platform console' : `${wsRoleOf(p, ws)} · ${wsName(ws)}`; };
    const grid = `<div class="au-demo__grid">${people.map(k => { const p = PERSONAS[k], on = signinUi().id.trim().toLowerCase() === p.email.toLowerCase(); return `<button type="button" class="au-demo__btn" aria-pressed="${on}" data-act="au-demo" data-p="${k}" data-tip="${esc(p.email)}">${avatar(p.name, 'xs')}<span class="au-demo__text"><span class="au-demo__name truncate">${esc(p.name)}</span><span class="au-demo__ws truncate">${esc(line(k))}</span></span></button>`; }).join('')}</div>`;
    return `<div class="au-demo">${disclosure({ path: 'auSignin.demo', icon: 'users', title: 'Try a demo account', summary: 'Password <span class="mono">demo</span>', body: grid })}</div>`;
  }

  /** A link someone was sent (/s/…) or a public workspace's address (/w/…): signing in or creating an account returns there. */
  const linkNext = q => (/^\/[sw]\/[^/?#]+$/.test(q?.next || '') ? q.next : '');
  const withNext = (path, q) => (linkNext(q) ? `${path}?next=${encodeURIComponent(linkNext(q))}` : path);

  P.signin = ({ query }) => {
    const s = signinUi(), e = s.err, busy = !!s.busy;
    const pw = field({ id: 'au-pw', label: 'Password', error: e.pw, control: passwordInput({ id: 'au-pw', bind: 'auSignin.pw', value: s.pw, show: s.show, act: 'au-signin-show', onEnter: 'au-signin', autocomplete: 'current-password', invalid: !!e.pw, autofocus: !!(s.notice && s.id) }) + linkBtn('Forgot password?', { act: 'au-forgot', cls: 'au-forgot' }) }).replace('<div class="field">', '<div class="field au-pwfield">');
    return shell(`<h1 class="t-title au-title">Sign in</h1>
        ${query.reason === 'expired'
          ? `<div class="au-notice">${alertBox('accent', 'Your session expired', 'Sign in again to go back to where you were.', '', { icon: 'clock' })}</div>`
          : s.notice === 'reset' ? `<div class="au-notice">${alertBox('success', 'Password changed', 'You’re signed out on every device. Sign in with your new password.', '', { icon: 'check-circle' })}</div>`
            : linkNext(query) ? `<p class="muted au-sub">${linkNext(query).startsWith('/w/') ? 'Sign in to join the workspace.' : 'Sign in to open the link you were sent.'}</p>`
              : '<p class="muted au-sub">Welcome back. Sign in to continue to your workspace.</p>'}
        <div class="au-form">
          ${field({ id: 'au-id', label: 'Email or username', error: e.id, control: input({ id: 'au-id', bind: 'auSignin.id', value: s.id, placeholder: 'name@company.com', onEnter: 'au-signin', autocomplete: 'username', invalid: !!e.id, autofocus: !(s.notice && s.id) }) })}
          ${pw}
          ${e.form ? `<div class="au-form-error">${alertBox('danger', e.form)}</div>` : ''}
          ${btn('Sign in', { v: 'primary', size: 'lg', full: true, act: 'au-signin', loading: s.busy === 'pw', disabled: busy, id: 'au-submit' })}
        </div>
        <div class="au-or" role="separator"><span>or</span></div>
        ${btn('Continue with Google', { v: 'outline', size: 'lg', full: true, act: 'au-google', loading: s.busy === 'google', disabled: busy, cls: 'au-google' }).replace('<span>', GOOGLE + '<span>')}
        <p class="au-foot">New to BoMesh? ${linkBtn('Create account', { href: withNext('/signup', query) })}</p>
        ${demoAccounts()}`, { art: true });
  };

  function validateSignin(s) {
    const e = {}, id = s.id.trim();
    if (!id) e.id = 'Enter your email or username.';
    else if (id.includes('@') && !EMAIL_RE.test(id)) e.id = 'Enter a full email address, like name@company.com.';
    else if (!id.includes('@') && id.length < 3) e.id = 'Usernames have at least 3 characters.';
    if (!s.pw) e.pw = 'Enter your password.';
    return e;
  }
  /** Signed in as persona `pid`: back to `?next=` when it's a link someone was sent (/s/…), or when the same person signs in
      again after their session expired; otherwise straight in when they belong to one workspace, else choose. */
  function enterAs(pid) {
    const s = signinUi(); s.busy = ''; s.pw = ''; s.err = {}; s.show = false; s.notice = '';
    const next = S.cur.query.next, link = linkNext(S.cur.query);
    const back = link || (S.cur.query.reason === 'expired' && pid === S.persona && /^\/(?![/\\])/.test(next || '') ? next : '');
    S.persona = pid; S.ui.prefs = null; S.signedIn = true;
    Object.assign(wsUi(), { fresh: false, checks: 0 });
    if (back) { persist(); go(back); return; }
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
    if (!pid || (s.pw !== 'demo' && s.pw !== D.pwChanged[pid])) { s.busy = ''; s.pw = ''; s.err = { form: 'Email or password is incorrect' }; refresh(); $('#au-pw')?.focus(); return; }
    enterAs(pid);
  };
  A['au-google'] = async () => {
    const s = signinUi(); if (s.busy) return;
    s.err = {}; s.busy = 'google'; refresh();
    await sleep(900);
    enterAs(S.persona);
  };
  A['au-signin-show'] = () => { const s = signinUi(); s.show = !s.show; refresh(); $('#au-pw')?.focus(); };
  /** Forgot password: the reset page, with the email carried over when that's what was typed (a username isn't sent anywhere). */
  A['au-forgot'] = () => {
    const s = signinUi(), id = s.id.trim(); s.notice = '';
    Object.assign(resetUi(), { email: EMAIL_RE.test(id) ? id : '', err: '', sent: false, busy: false });
    go('/password-reset');
  };
  /** Fill the form with a demo account and hand focus to Sign in, so Enter (or one click) finishes. */
  A['au-demo'] = el => { const s = signinUi(), p = PERSONAS[el?.dataset?.p] || PERSONAS.member; s.id = p.email; s.pw = 'demo'; s.err = {}; refresh(); $('#au-submit')?.focus(); };

  /* ── Password reset (auth_contract.md › Password reset) ──
     SendPasswordReset answers the same whether or not the email has an account, so the page never says which.
     A link works once, for 30 minutes (password_reset_tokens); setting the password ends every session of the account.
     The prototype has no mail: the confirmation offers a clearly marked shortcut to the link instead. */
  D.resetTokens ??= [];
  D.pwChanged ??= {};
  DATA_KEYS.push('resetTokens', 'pwChanged');
  const RESET_TTL = 30 * 60 * 1000;
  const resetUi = () => ui('auReset', { email: '', err: '', sent: false, busy: false });
  const newPwUi = () => ui('auNewPw', { token: '', pw: '', pw2: '', show: false, tried: false, busy: false, failed: false });
  const tokenOf = t => D.resetTokens.find(x => x.token === t);
  const tokenOk = r => !!r && !r.used && r.expires > Date.now();
  const newToken = (email, expires) => {
    const r = { token: Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10), email, pid: personaFor(email), expires };
    D.resetTokens.push(r); persist(); return r;
  };
  /** A link landing or status page: one centred column. Reset pages are part of signing in, so they keep the brand panel. */
  const authPage = inner => shell(inner, { cls: 'au-narrow' });
  const resetPage = inner => shell(inner, { art: true });
  const backToSignin = () => `<p class="au-foot">${linkBtn('Back to sign in', { href: '/signin' })}</p>`;
  /** A sentence with marked-up parts: localized as a whole (word order differs by language), then filled. */
  const sentence = (tpl, ...parts) => (tr(tpl) ?? tpl).replace(/\{(\d)\}/g, (_, n) => parts[n]);
  X.authPage = authPage; X.sentence = sentence;
  const who = email => `<span class="medium au-who__email" translate="no">${esc(email)}</span>`;

  P.passwordReset = () => {
    const f = resetUi();
    if (f.sent) {
      const known = accountExists(f.email), link = D.resetTokens.filter(r => r.email === f.email.toLowerCase()).pop();
      const proto = `<div class="au-proto"><span class="au-proto__label">Prototype</span><p class="t-sm muted"><span>No email is sent here.</span>${known && link ? '' : ' <span>No account uses this address, so no link was made.</span>'}</p>
        ${known && link ? `<div class="row gap-12 wrap">${linkBtn('Open the link', { href: '/password-reset/' + link.token })}${linkBtn('Try an expired link', { act: 'au-reset-expired' })}</div>` : ''}</div>`;
      return resetPage(`<span class="au-mark">${ic('mail')}</span>
        <h1 class="t-title au-title">Check your email</h1>
        <p class="muted au-sub">${sentence('If an account uses {0}, we sent it a link to choose a new password. The link works once, for 30 minutes.', who(f.email))}</p>
        ${btn('Back to sign in', { v: 'primary', size: 'lg', full: true, href: '/signin' })}
        <p class="au-foot">${sentence('No email? Check spam, or {0}.', linkBtn('send it again', { act: 'au-reset-again', loading: f.busy }))}</p>
        ${proto}`);
    }
    return resetPage(`<h1 class="t-title au-title">Reset your password</h1>
      <p class="muted au-sub">Enter the email you sign in with. We’ll send you a link to choose a new password.</p>
      <div class="au-form">
        ${field({ id: 'pr-email', label: 'Email', error: f.err, control: input({ id: 'pr-email', bind: 'auReset.email', value: f.email, type: 'email', placeholder: 'name@company.com', autocomplete: 'email', autofocus: true, invalid: !!f.err, onEnter: 'au-reset-send' }) })}
        ${btn('Send reset link', { v: 'primary', size: 'lg', full: true, act: 'au-reset-send', loading: f.busy, disabled: f.busy })}
      </div>
      ${backToSignin()}`);
  };
  /** SendPasswordReset: only a malformed email is refused; the answer is the same for every well-formed one. */
  async function sendReset() {
    const f = resetUi(); if (f.busy) return;
    const email = f.email.trim().toLowerCase();
    f.err = !email ? 'Enter your email.' : !EMAIL_RE.test(email) ? 'Enter an email like name@company.com.' : '';
    if (f.err) { refresh(); $('#pr-email')?.focus(); return; }
    f.busy = true; refresh(); await sleep(700);
    if (accountExists(email)) newToken(email, Date.now() + RESET_TTL);
    const again = f.sent;
    Object.assign(f, { email, sent: true, busy: false }); refresh();
    if (again) toast('Sent again. Use the newest email.', { tone: 'accent' });
  }
  A['au-reset-send'] = sendReset;
  A['au-reset-again'] = sendReset;
  /** Prototype shortcut: a link that has already run out, to show what someone sees then. */
  A['au-reset-expired'] = () => { const r = newToken(resetUi().email, Date.now() - 60 * 1000); go('/password-reset/' + r.token); };

  P.passwordResetToken = ({ params }) => {
    let f = newPwUi(); if (f.token !== params.token) f = S.ui.auNewPw = { token: params.token, pw: '', pw2: '', show: false, tried: false, busy: false, failed: false };
    const r = tokenOf(params.token);
    if (f.failed || !tokenOk(r)) {
      return resetPage(`<span class="au-mark au-mark--warn">${ic('clock')}</span>
        <h1 class="t-title au-title">This link doesn’t work anymore</h1>
        <p class="muted au-sub">Reset links work once, for 30 minutes. Ask for a new one and use the newest email.</p>
        ${btn('Send a new link', { v: 'primary', size: 'lg', full: true, act: 'au-reset-new', data: { email: r?.email || '' } })}
        ${backToSignin()}`);
    }
    const e = f.tried ? pwErrors(f) : {}, st = strength(f.pw);
    const meter = f.pw ? `<div class="au-strength" aria-live="polite"><div class="row gap-8">${progress(st[2], st[0], 'Password strength')}<span class="t-xs medium au-strength__label">${st[1]}</span></div></div>` : '';
    return resetPage(`<h1 class="t-title au-title">Choose a new password</h1>
      <p class="muted au-sub">${sentence('For {0}. Saving it signs you out on every device.', who(r.email))}</p>
      <div class="au-form">
        ${field({ id: 'np-pw', label: 'New password', error: e.pw, desc: e.pw ? '' : 'At least 8 characters, with letters and numbers.', control: passwordInput({ id: 'np-pw', bind: 'auNewPw.pw', value: f.pw, show: f.show, act: 'au-newpw-show', onEnter: 'au-newpw-save', autocomplete: 'new-password', invalid: !!e.pw, live: true, autofocus: true }) + meter })}
        ${field({ id: 'np-pw2', label: 'Confirm new password', error: e.pw2, control: input({ id: 'np-pw2', bind: 'auNewPw.pw2', value: f.pw2, type: f.show ? 'text' : 'password', onEnter: 'au-newpw-save', autocomplete: 'new-password', invalid: !!e.pw2, attrs: f.tried ? 'data-live' : '' }) })}
        ${btn('Save new password', { v: 'primary', size: 'lg', full: true, act: 'au-newpw-save', loading: f.busy, disabled: f.busy })}
      </div>
      ${backToSignin()}`);
  };
  function pwErrors(f) {
    const e = {};
    if (!PW_RULES.filter(x => x[2]).every(([t]) => t(f.pw))) e.pw = 'Use at least 8 characters with letters and numbers.';
    if (!f.pw2) e.pw2 = 'Type the new password again.';
    else if (f.pw2 !== f.pw) e.pw2 = 'The passwords don’t match.';
    return e;
  }
  A['au-newpw-show'] = () => { const f = newPwUi(); f.show = !f.show; refresh(); $('#np-pw')?.focus(); };
  /** From a dead link: when it says whose it was, the new link is sent right away; otherwise the email form. */
  A['au-reset-new'] = el => {
    const email = el.dataset.email || '';
    Object.assign(resetUi(), { email, err: '', sent: false, busy: false });
    go('/password-reset');
    if (email) sendReset();
  };
  /** ResetPassword: the token is checked again on save (it may run out while the form is open); success ends every session. */
  A['au-newpw-save'] = async () => {
    const f = newPwUi(); if (f.busy) return;
    f.tried = true; const e = pwErrors(f);
    if (e.pw || e.pw2) { refresh(); $(e.pw ? '#np-pw' : '#np-pw2')?.focus(); return; }
    f.busy = true; refresh(); await sleep(700);
    const r = tokenOf(f.token);
    if (!tokenOk(r)) { Object.assign(f, { busy: false, failed: true }); refresh(); return; }
    r.used = Date.now();
    if (r.pid) { D.pwChanged[r.pid] = f.pw; if (r.pid === S.persona) S.signedIn = false; }
    persist();
    S.ui.auNewPw = null;
    Object.assign(signinUi(), { id: r.email, pw: '', err: {}, busy: '', show: false, notice: 'reset' });
    go('/signin');
  };

  /* ── Session expired: sign in again in place ──
     The page underneath stays exactly as it was (no reload, nothing re-requested until the person is back). The same person
     signing in closes the dialog and the page refreshes its data; another account starts clean on Home; the full page is a
     fallback that returns here afterwards. Not dismissable: every way out is an explicit choice. */
  const expiredUi = () => ui('auExpired', { id: '', pw: '', show: false, err: {}, busy: '' });
  M.sessionExpired = () => {
    const s = expiredUi(), e = s.err, busy = !!s.busy;
    return {
      size: 'sm', guard: true, noClose: true, icon: 'clock', title: 'Your session expired',
      desc: 'Sign in again to pick up where you left off. This page stays open.',
      body: `<div class="au-reauth">
        ${btn('Continue with Google', { v: 'outline', size: 'lg', full: true, act: 'au-reauth-google', loading: s.busy === 'google', disabled: busy, cls: 'au-google' }).replace('<span>', GOOGLE + '<span>')}
        <div class="au-or" role="separator"><span>or</span></div>
        ${field({ id: 'ax-id', label: 'Email or username', error: e.id, control: input({ id: 'ax-id', bind: 'auExpired.id', value: s.id, onEnter: 'au-reauth', autocomplete: 'username', invalid: !!e.id, autofocus: !s.id }) })}
        ${field({ id: 'ax-pw', label: 'Password', error: e.pw, control: passwordInput({ id: 'ax-pw', bind: 'auExpired.pw', value: s.pw, show: s.show, act: 'au-reauth-show', onEnter: 'au-reauth', autocomplete: 'current-password', invalid: !!e.pw, autofocus: !!s.id }) })}
        ${e.form ? `<div class="au-form-error">${alertBox('danger', e.form)}</div>` : ''}
        ${btn('Sign in', { v: 'primary', size: 'lg', full: true, act: 'au-reauth', loading: s.busy === 'pw', disabled: busy, id: 'ax-submit' })}
        <p class="au-foot">${linkBtn('Use the full sign-in page', { act: 'au-reauth-page' })} · ${linkBtn('Sign out', { act: 'au-reauth-signout' })}</p>
      </div>`,
    };
  };
  /** Prototype trigger: the session ends while you work (the dialog opens over the current page). */
  X.expireSession = () => { Object.assign(expiredUi(), { id: me().email, pw: '', show: false, err: {}, busy: '' }); openModal('sessionExpired'); };
  /** Signed in again from the dialog as persona `pid`. */
  function resumeAs(pid) {
    Object.assign(expiredUi(), { pw: '', show: false, err: {}, busy: '' });
    if (pid === S.persona) { closeModal(); return; }   // same person: the page stays, its data reloads
    S.modal = null; S.ui = {}; enterAs(pid);         // another account: nothing of the previous one stays; Home
  }
  A['au-reauth'] = async () => {
    const s = expiredUi(); if (s.busy) return;
    s.err = validateSignin(s);
    if (s.err.id || s.err.pw) { refreshLayer(); $(s.err.id ? '#ax-id' : '#ax-pw')?.focus(); return; }
    s.busy = 'pw'; refreshLayer();
    await sleep(700);
    const pid = personaFor(s.id);
    if (!pid || s.pw !== 'demo') { s.busy = ''; s.pw = ''; s.err = { form: 'Email or password is incorrect' }; refreshLayer(); $('#ax-pw')?.focus(); return; }
    resumeAs(pid);
  };
  A['au-reauth-google'] = async () => {
    const s = expiredUi(); if (s.busy) return;
    s.err = {}; s.busy = 'google'; refreshLayer();
    await sleep(900);
    resumeAs(S.persona);
  };
  A['au-reauth-show'] = () => { const s = expiredUi(); s.show = !s.show; refreshLayer(); $('#ax-pw')?.focus(); };
  /** Fallback: the full sign-in page explains why, then returns to this address. */
  A['au-reauth-page'] = () => {
    const back = S.cur.full;
    Object.assign(signinUi(), { id: expiredUi().id, pw: '', err: {}, busy: '' });
    S.modal = null; S.signedIn = false; persist();
    go(`/signin?next=${encodeURIComponent(back)}&reason=expired`);
  };
  A['au-reauth-signout'] = () => { S.modal = null; S.signedIn = false; persist(); go('/signin'); toast('Signed out', { tone: 'accent' }); };

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

  P.signup = ({ query }) => {
    const f = signupUi(), e = f.err, st = strength(f.pw);
    /* The checklist appears once there's a password to check; before that one line says what's needed. */
    const meter = f.pw ? `<div class="au-strength" aria-live="polite">
      <div class="row gap-8">${progress(st[2], st[0], 'Password strength')}<span class="t-xs medium au-strength__label">${st[1]}</span></div>
      <ul class="au-rules">${PW_RULES.map(([t, label]) => { const ok = t(f.pw); return `<li class="${ok ? 'is-ok' : ''}">${ic(ok ? 'check-circle' : 'circle-dashed', 'i-sm')}${esc(label)}</li>`; }).join('')}</ul>
    </div>` : '';
    return shell(`<h1 class="t-title au-title">Create your account</h1>
        <p class="muted au-sub">${linkNext(query).startsWith('/w/') ? 'Create an account with any email to join the workspace.' : linkNext(query) ? 'Create an account to open the link you were sent.' : 'Invited by a workspace admin? Use the email the invite went to.'}</p>
        <div class="au-form">
          ${field({ id: 'su-name', label: 'Full name', error: e.name, control: input({ id: 'su-name', bind: 'auSignup.name', value: f.name, placeholder: 'Kevin Ng', autocomplete: 'name', autofocus: true, invalid: !!e.name, onEnter: 'au-signup' }) })}
          ${fieldWithError({ id: 'su-email', label: 'Email', control: input({ id: 'su-email', bind: 'auSignup.email', value: f.email, type: 'email', placeholder: 'name@company.com', autocomplete: 'email', invalid: !!e.email, onEnter: 'au-signup' }) }, e.email, e.dup ? linkBtn('Sign in instead', { act: 'au-signin-instead' }) : '')}
          ${field({ id: 'su-pw', label: 'Password', error: e.pw, desc: f.pw || e.pw ? '' : 'At least 8 characters, with letters and numbers.', control: passwordInput({ id: 'su-pw', bind: 'auSignup.pw', value: f.pw, show: f.show, act: 'au-signup-show', onEnter: 'au-signup', autocomplete: 'new-password', invalid: !!e.pw, live: true }) + meter })}
          <div class="au-terms">${checkbox({ id: 'su-terms', label: 'I agree to the terms of service and privacy policy', checked: f.terms, bind: 'auSignup.terms' })}
            ${e.terms ? `<div class="field-error" role="alert">${ic('alert-circle')}<span>${esc(e.terms)}</span></div>` : ''}</div>
          ${btn('Create account', { v: 'primary', size: 'lg', full: true, act: 'au-signup', loading: f.busy === true, disabled: !!f.busy })}
        </div>
        <div class="au-or" role="separator"><span>or</span></div>
        ${btn('Continue with Google', { v: 'outline', size: 'lg', full: true, act: 'au-signup-google', loading: f.busy === 'google', disabled: !!f.busy, cls: 'au-google' }).replace('<span>', GOOGLE + '<span>')}
        <p class="t-xs muted au-google-terms">By continuing with Google, you agree to the terms of service and privacy policy.</p>
        <p class="au-foot">Already have an account? ${linkBtn('Sign in', { href: withNext('/signin', query) })}</p>`, { art: true });
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
    created(f.name.trim(), email);
  };
  /** Google creates the account on first sign-in (auth_contract.md › Session creation: an unknown Google email gets a new
      user), so sign-up offers it too; an email that already has an account just signs in. */
  A['au-signup-google'] = async () => {
    const f = signupUi(); if (f.busy) return;
    f.err = {}; f.busy = 'google'; refresh();
    await sleep(900);
    const email = EMAIL_RE.test(f.email.trim()) ? f.email.trim() : 'new.member@gmail.com';
    const pid = personaFor(email);
    if (pid) { f.busy = false; enterAs(pid); return; }
    created(f.name.trim() || email.split('@')[0], email);
  };
  /** A new account: back to the link it was opened from (an invite then offers Accept), else choose a workspace to join. */
  function created(name, email) {
    const f = signupUi(), link = linkNext(S.cur.query);
    Object.assign(f, { name: '', email: '', pw: '', show: false, terms: false, err: {}, busy: false });
    if (link) { X.shares.newAccount({ name, email }); go(link); toast('Account created'); return; }
    Object.assign(wsUi(), { fresh: true, email: email.toLowerCase(), name, checks: 0, busy: false });
    S.signedIn = false; persist();
    go('/workspaces');
    toast('Account created');
  }

  /* ── Choose a workspace ── */
  const roleIn = ws => wsRoleOf(me(), ws.id);
  const isArchived = ws => D.pWorkspaces.find(x => x.id === ws.id)?.status === 'archived';
  const opened = ws => D.wsOpened[ws.id] || 0;
  /** “Last opened 5 h ago” / “Last opened Sep 27”: lower-case relative words, keep month names as written. */
  const openedLabel = t => { const r = rel(t); return `Last opened ${/^\p{Lu}\p{Ll}+ \d/u.test(r) ? r : r.toLowerCase()}`; };

  /** Public workspaces the account can join as a member (ListWorkspaces, visibility = PUBLIC): name, member count, Join.
      With no workspace yet, joining is what the page is for: the group leads the page as *Join a workspace*. */
  function publicGroup(fresh, none) {
    const pub = publicWorkspacesToJoin(fresh ? null : me()), w = wsUi(); if (!pub.length) return '';
    const rows = pub.map(ws => item({ lead: wsMark(ws, 36), title: esc(ws.name), desc: esc(plural(ws.members, 'member')), trail: btn('Join', { v: 'secondary', size: 'sm', act: 'au-ws-join', data: { id: ws.id }, loading: w.joining === ws.id, disabled: !!w.joining }) }));
    return `<div class="au-group${none ? ' au-group--lead' : ''}"><div class="t-label au-group__label">${none ? 'Join a workspace' : 'Public workspaces'}</div>${list(rows)}<p class="t-xs muted au-group__note">Anyone with a BoMesh account can join these and becomes a member.</p></div>`;
  }
  /** In no workspace: join a public one when there is one, with waiting for an admin as a quiet line below; otherwise
      the wait itself is the page, with Check again as its one action. */
  function noWorkspace(fresh) {
    const w = wsUi(), pub = publicGroup(fresh, true);
    const check = v => btn('Check again', { v, size: v === 'primary' ? undefined : 'sm', icon: 'refresh', act: 'au-ws-check', loading: w.busy, disabled: w.busy });
    return pub ? `${pub}<div class="au-wait"><span>Waiting for an admin to add you?</span>${check('ghost')}</div>`
      : emptyState({ icon: 'building', title: 'You’re not in a workspace yet', desc: 'When a workspace admin adds or invites you, it shows up here.', actions: check('primary'), boxed: true });
  }
  P.workspaces = () => {
    const w = wsUi();
    if (!w.fresh && !S.signedIn) { setTimeout(() => { history.replaceState(null, '', '#/signin'); render(); }); return ''; }
    const email = w.fresh ? w.email : me().email;
    const all = w.fresh ? [] : workspacesForMe().sort((a, b) => opened(b) - opened(a));
    const console_ = !w.fresh && isOperator() ? `<div class="au-group"><div class="t-label au-group__label">Administration</div>${list([item({ lead: `<span class="ws-mark au-console-mark" style="width:36px;height:36px">${ic('layers', 'i-sm')}</span>`, title: 'Platform console', desc: 'Workspaces, users, connectors and system health', trail: ic('chevron-right', 'au-chev'), act: 'au-console' })])}</div>` : '';
    let body;
    if (!all.length) body = noWorkspace(w.fresh) + console_;
    else {
      const mixed = new Set(all.map(ws => wsTemplateId(ws))).size > 1;   // the template only helps tell workspaces apart when they differ
      const rows = all.filter(ws => matchesQ('auWs', ws.name, ws.code, roleIn(ws), wsTemplate(ws).label));
      const items = rows.map(ws => isArchived(ws)
        ? item({ lead: wsMark(ws, 36), title: esc(ws.name), titleExtra: status('ws', 'archived'), desc: 'Archived. Ask a platform admin to restore it.', cls: 'au-ws-off' })
        : item({ lead: wsMark(ws, 36), title: esc(ws.name), titleExtra: mixed ? chip(wsTemplate(ws).label, { size: 'sm' }) : '', desc: `${esc(roleIn(ws))} · ${plural(ws.members, 'member')}`, meta: opened(ws) ? esc(openedLabel(opened(ws))) : '', trail: ic('chevron-right', 'au-chev'), act: 'au-ws-enter', data: { id: ws.id } }));
      body = `${needsTools(all.length, 'auWs') ? `<div class="mb-12">${searchField({ uiKey: 'auWs', placeholder: 'Search workspaces' })}</div>` : ''}
        ${rows.length ? list(items) : noMatches('auWs', [], 'workspaces')}${console_}${publicGroup(false, false)}`;
    }
    return shell(`<h1 class="t-title au-title">${all.length ? 'Choose a workspace' : 'Welcome to BoMesh'}</h1>
        <div class="au-sub au-who"><p class="au-who__text"><span class="t-xs muted">Signed in as</span><span class="medium au-who__email" translate="no">${esc(email)}</span></p>${btn('Sign out', { v: 'tertiary', size: 'sm', icon: 'logout', act: 'au-signout' })}</div>
        ${body}`, { cls: 'au-ws' });
  };
  A['au-ws-enter'] = el => { S.signedIn = true; enterWorkspace(el.dataset.id, { quiet: true }); };
  /** Join a public workspace as a member and go straight in. A brand-new account becomes signed in first. */
  A['au-ws-join'] = async el => {
    const w = wsUi(), id = el.dataset.id; if (w.joining) return;
    w.joining = id; refresh(); await sleep(600); w.joining = '';
    if (w.fresh) { X.shares.newAccount({ name: w.name || w.email.split('@')[0], email: w.email }); Object.assign(w, { fresh: false, checks: 0 }); }
    joinAndEnter(id);
  };
  /** Joined: straight in. Home's welcome card greets a new member when it's due; otherwise a toast confirms the join. */
  function joinAndEnter(id) {
    const ws = D.workspaces.find(x => x.id === id);
    if (!joinWorkspace(id)) { refresh(); return; }
    S.signedIn = true;
    enterWorkspace(id, { quiet: true });
    if (!X.home.welcomes()) toast(`You joined ${ws.name}`);
  }

  /* ── A public workspace's own address: /w/:code ──
     Signed out: sign in or create an account (any email), then back here. Signed in: the workspace (name, description, what a
     member can do) with Join as the one action; already in: straight in. Private or unknown: the same "doesn't work" answer. */
  P.joinWorkspace = ({ params }) => {
    const code = params.code, next = encodeURIComponent('/w/' + code), w = wsUi();
    if (!S.signedIn) {
      return authPage(`<span class="au-mark">${ic('globe')}</span><h1 class="t-title au-title">Sign in to join</h1>
        <p class="muted au-sub">Public workspaces are open to anyone with a BoMesh account. Sign in, or create an account with any email, then join.</p>
        <div class="sh-actions">${btn('Sign in', { v: 'primary', size: 'lg', full: true, href: `/signin?next=${next}` })}${btn('Create account', { v: 'secondary', size: 'lg', full: true, href: `/signup?next=${next}` })}</div>`);
    }
    const ws = D.workspaces.find(x => x.code === code && x.status !== 'archived');
    if (ws && me().workspaces?.includes(ws.id)) { setTimeout(() => { toast(`You’re already in ${ws.name}`, { tone: 'accent' }); enterWorkspace(ws.id, { quiet: true }); }); return ''; }
    const foot = `<p class="au-foot">${sentence('Signed in as {0} · {1}', `<span class="medium" translate="no">${esc(me().email)}</span>`, linkBtn('Use another account', { act: 'au-join-switch', data: { code } }))}</p>`;
    if (!ws || !isPublicWs(ws)) {
      return authPage(`<span class="au-mark au-mark--warn">${ic('clock')}</span><h1 class="t-title au-title">This link doesn’t work</h1>
        <p class="muted au-sub">Check that you copied all of it, or ask whoever sent it for a new one.</p>
        <div class="sh-actions">${btn('Go to BoMesh', { v: 'secondary', size: 'lg', full: true, act: 'sh-home' })}</div>${foot}`);
    }
    const can_ = [['book', 'Read the knowledge open to all members'], ['sparkles', 'Ask the assistant, with sources you can check'], ['upload', 'Contribute documents for review'], ['x-circle', 'Leave any time from your account menu']];
    return authPage(`<div class="au-join">
        <div class="au-join__head">${wsMark(ws, 48)}<div class="au-join__id"><h1 class="t-title au-join__name" translate="no">${esc(ws.name)}</h1>${chip('Public workspace', { size: 'sm', icon: 'globe' })}</div></div>
        ${ws.description ? `<p class="au-join__desc" translate="no">${esc(ws.description)}</p>` : ''}
        <div class="au-join__can"><div class="t-label">As a member you can</div><ul class="au-join__list">${can_.map(([icon, t]) => `<li>${ic(icon, 'i-sm')}<span>${esc(t)}</span></li>`).join('')}</ul></div>
        ${btn(`Join ${ws.name}`, { v: 'primary', size: 'lg', full: true, icon: 'user-plus', act: 'au-join', data: { id: ws.id }, loading: w.joining === ws.id, disabled: !!w.joining })}
      </div>${foot}`);
  };
  A['au-join'] = async el => {
    const w = wsUi(), id = el.dataset.id; if (w.joining) return;
    w.joining = id; refresh(); await sleep(600); w.joining = '';
    joinAndEnter(id);
  };
  A['au-join-switch'] = el => { S.signedIn = false; persist(); go(`/signin?next=${encodeURIComponent('/w/' + el.dataset.code)}`); };
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

/* Assistant (/assistant) — how the workspace assistant answers and what
   people see when they start a chat. Edits are a local draft with a live
   preview; Publish writes D.assistant (read by the chat home). Workspaces
   with role starters (D.assistant.roleStarters) set starters per role. */
(() => {
  'use strict';

  const MAX_INS = 2000, MAX_WELCOME = 60, MAX_STARTERS = 3;
  const STYLES = [
    ['short', 'Short', 'A few sentences for quick lookups.'],
    ['balanced', 'Balanced', 'The answer first, then key details.'],
    ['detailed', 'Detailed', 'Thorough, with steps and context.'],
  ];
  const roleLabel = r => PERSONAS[r]?.label || r;

  const draft = () => (S.ui.asst ??= clone(D.assistant));
  const meta = () => ui('asstMeta', { tried: false, touched: {}, busy: false, role: '' });
  /** Roles with their own starters, or null when everyone shares one list. */
  const rolesOf = a => (a.roleStarters ? Object.keys(a.roleStarters) : null);
  function curRole(a) {
    const roles = rolesOf(a); if (!roles) return '';
    const m = meta();
    if (!roles.includes(m.role)) m.role = roles.includes(S.persona) ? S.persona : roles[0];
    return m.role;
  }
  const startersOf = (a, role) => (role ? a.roleStarters[role] : a.starters);
  /** Error/touched key of a starter field; ids stay per visible list. */
  const sk = (role, i, f) => `${role ? role + '-' : ''}st${i}${f}`;
  const pairs = list => list.map(s => [s.title, s.prompt]);
  const key = a => JSON.stringify([a.instructions, a.style, !!a.citations, !!a.caps?.analyze, !!a.caps?.files, a.welcome, pairs(a.starters), a.roleStarters ? Object.entries(a.roleStarters).map(([r, l]) => [r, pairs(l)]) : null]);
  const dirty = () => key(draft()) !== key(D.assistant);

  function errors(a) {
    const e = {};
    if (a.instructions.length > MAX_INS) e.instructions = `Shorten by ${fmtNum(a.instructions.length - MAX_INS)} characters.`;
    if (!a.welcome.trim()) e.welcome = 'Enter a welcome message.';
    else if (a.welcome.length > MAX_WELCOME) e.welcome = `Keep it to ${MAX_WELCOME} characters.`;
    (rolesOf(a) || ['']).forEach(role => startersOf(a, role).forEach((s, i) => {
      if (!s.title.trim()) e[sk(role, i, 't')] = 'Add a title.';
      if (!s.prompt.trim()) e[sk(role, i, 'p')] = 'Add the prompt it sends.';
    }));
    return e;
  }
  const counter = (n, max) => `<span class="${cx('counter', n > max && 'asst-over')}">${fmtNum(n)}/${fmtNum(max)}</span>`;
  const liveAttrs = (k, extra = '') => `data-input="asst-touch" data-field="${k}" ${extra}`;

  /* ── Form ── */
  function startersHtml(a, show) {
    const role = curRole(a), list = startersOf(a, role), n = list.length, base = role ? `asst.roleStarters.${role}` : 'asst.starters';
    const rows = list.map((s, i) => `<div class="asst-starter" role="group" aria-label="Starter ${i + 1}">
      <span class="asst-starter__n" aria-hidden="true">${i + 1}</span>
      <div class="asst-starter__fields">
        ${field({ id: `asst-st${i}t`, label: 'Title', error: show(sk(role, i, 't')), control: input({ id: `asst-st${i}t`, bind: `${base}.${i}.title`, value: s.title, placeholder: 'Find a policy', invalid: !!show(sk(role, i, 't')), attrs: liveAttrs(sk(role, i, 't'), 'maxlength="40"') }) })}
        ${field({ id: `asst-st${i}p`, label: 'Prompt', error: show(sk(role, i, 'p')), control: input({ id: `asst-st${i}p`, bind: `${base}.${i}.prompt`, value: s.prompt, placeholder: 'What does our travel policy say about per diem?', invalid: !!show(sk(role, i, 'p')), attrs: liveAttrs(sk(role, i, 'p'), 'maxlength="160"') }) })}
      </div>
      <div class="asst-starter__actions">
        ${iconBtn('arrow-up', 'Move up', { size: 'sm', act: 'asst-st-move', data: { i, d: -1 }, disabled: i === 0 })}
        ${iconBtn('arrow-down', 'Move down', { size: 'sm', act: 'asst-st-move', data: { i, d: 1 }, disabled: i === n - 1 })}
        ${iconBtn('trash', 'Remove starter', { size: 'sm', act: 'asst-st-rm', data: { i } })}
      </div>
    </div>`).join('');
    const roles = rolesOf(a);
    const picker = roles ? `<div class="asst-roles">${seg({ value: role, options: roles.map(r => [r, roleLabel(r)]), act: 'asst-role', label: 'Starters for' })}</div>` : '';
    return `<div class="row between mt-8"><span class="label">${roles ? 'Starters by role' : 'Starters'}</span><span class="t-xs muted">${n}/${MAX_STARTERS}</span></div>
      ${picker}
      ${n ? `<div class="asst-starters">${rows}</div>` : `<p class="t-sm muted">No starters. ${roles ? `${esc(roleLabel(role))}s see` : 'People see'} only the welcome message.</p>`}
      <div>${btn('Add starter', { size: 'sm', icon: 'plus', act: 'asst-st-add', disabled: n >= MAX_STARTERS })}</div>`;
  }
  function formHtml(a, show) {
    const ins = card(field({
      id: 'asst-ins', error: show('instructions'),
      desc: 'Who it serves, what to prioritise, what to avoid.', counter: show('instructions') ? '' : counter(a.instructions.length, MAX_INS),
      control: textarea({ id: 'asst-ins', bind: 'asst.instructions', value: a.instructions, rows: 7, invalid: !!show('instructions'), attrs: liveAttrs('instructions', 'aria-label="Instructions"') }),
    }), { title: 'Instructions' });

    const style = card(`<div class="asst-style">${choiceGroup({ name: 'asst-style', value: a.style, options: STYLES, act: 'asst-style', cols: 3 })}</div>`, { title: 'Answer style' });

    const caps = card(`<div class="asst-switches">
      ${switchRow({ title: 'Search company knowledge', desc: 'Always on. Answers come from your knowledge.', on: true, disabled: true })}
      ${switchRow({ title: 'Cite sources', desc: 'Every claim links to the passage it came from.', on: a.citations, act: 'asst-cap', data: { k: 'citations' } })}
      ${switchRow({ title: 'Analyze files and data', desc: 'Read spreadsheets and calculate.', on: a.caps.analyze, act: 'asst-cap', data: { k: 'analyze' } })}
      ${switchRow({ title: 'Create files', desc: 'Produce documents and spreadsheets.', on: a.caps.files, act: 'asst-cap', data: { k: 'files' } })}
    </div>`, { title: 'Capabilities' });

    const home = card(`${field({
      id: 'asst-welcome', label: 'Welcome message', required: true, error: show('welcome'), counter: show('welcome') ? '' : counter(a.welcome.length, MAX_WELCOME),
      control: input({ id: 'asst-welcome', bind: 'asst.welcome', value: a.welcome, placeholder: 'What can I help you find?', invalid: !!show('welcome'), attrs: liveAttrs('welcome') }),
    })}${startersHtml(a, show)}`, { title: 'Chat home', desc: rolesOf(a) ? 'What people see when they start a new chat. Each role gets its own starters.' : 'What people see when they start a new chat.' });

    return `<div class="asst-form">${ins}${style}${caps}${home}</div>`;
  }

  /* ── Live preview ── */
  const cite = (a, n) => (a.citations ? `<sup class="asst-cite">${n}</sup>` : '');
  function sampleAnswer(a) {
    if (a.style === 'short') return `<p>Domestic trips get $75 a day and international trips $110 a day for meals.${cite(a, 1)}</p>`;
    const core = `<p>Per diem covers meals and incidentals on business trips.${cite(a, 1)}</p><ul><li>Domestic: $75 a day</li><li>International: $110 a day${cite(a, 1)}</li><li>Travel days are paid at 75%</li></ul>`;
    if (a.style === 'balanced') return core;
    return `${core}<p class="asst-prev__sub">How to claim</p><ol><li>Log the trip in Concur within 30 days.${cite(a, 2)}</li><li>Attach receipts only for lodging.</li><li>Your manager approves; Finance pays in the next cycle.</li></ol><p>For exceptions, ask Finance before you travel.</p>`;
  }
  function previewHtml(a) {
    const w = a.welcome.trim(), role = curRole(a);
    const tiles = startersOf(a, role).filter(s => s.title.trim() || s.prompt.trim());
    const homeHtml = `<div class="asst-prev__home">
      <div class="${cx('asst-prev__welcome', !w && 'is-empty')}">${esc(w || 'Welcome message')}</div>
      <div class="asst-prev__composer"><span class="truncate">Ask anything…</span><span class="row gap-6">${a.caps.analyze ? ic('paperclip', 'i-sm') : ''}<span class="asst-prev__send">${ic('arrow-up', 'i-sm')}</span></span></div>
      ${tiles.length ? `<div class="asst-prev__tiles">${tiles.map(s => `<div class="asst-prev__tile"><div class="medium truncate">${esc(s.title.trim() || 'Untitled')}</div><div class="t-xs muted truncate">${esc(s.prompt.trim() || '—')}</div></div>`).join('')}</div>` : ''}
    </div>`;
    const answer = `<div class="asst-prev__chat">
      <div class="asst-prev__q">What’s our per diem?</div>
      <div class="asst-prev__a">${sampleAnswer(a)}${a.citations ? `<div class="asst-prev__sources">${chip('1 Travel & Expense Policy.pdf', { size: 'sm', icon: 'file-text' })}${a.style === 'detailed' ? chip('2 Expense How-to.docx', { size: 'sm', icon: 'file-text' }) : ''}</div>` : ''}</div>
    </div>`;
    return `<aside class="asst-preview" aria-label="Preview">
      <div class="card asst-prev">
        <div class="row between"><span class="t-label">Preview</span><span class="t-xs muted">${role ? `As a ${esc(roleLabel(role).toLowerCase())} sees it` : 'As members see it'}</span></div>
        ${homeHtml}
        <hr class="separator">
        <div class="t-xs muted">Sample answer · ${esc(STYLES.find(s => s[0] === a.style)?.[1] || '')}</div>
        ${answer}
      </div>
    </aside>`;
  }

  P.assistant = () => {
    const head = pageHeader({ title: 'Assistant', desc: 'How it answers and what people see first.' });
    const body = gate({
      loading: () => `<div class="asst-layout"><div class="stack gap-16">${skelCards(2)}</div><div class="card"><span class="skeleton" style="height:280px"></span></div></div>`,
      error: () => errorState({ title: 'Assistant settings didn’t load' }),
      ok: () => {
        const a = draft(), m = meta(), errs = errors(a);
        const show = k => (errs[k] && (m.tried || m.touched[k] || k === 'instructions') ? errs[k] : '');
        const nErr = Object.keys(errs).length;
        const bar = dirty() ? `<div class="savebar" role="region" aria-label="Unsaved changes"><span class="savebar__text">Unsaved changes${m.tried && nErr ? ` · ${plural(nErr, 'field')} to fix` : ''}</span>${btn('Discard', { v: 'ghost', act: 'asst-discard', disabled: m.busy })}${btn('Publish', { v: 'primary', act: 'asst-publish', loading: m.busy, disabled: m.busy })}</div>` : '';
        return `<div class="asst-layout">${formHtml(a, show)}${previewHtml(a)}</div>${bar}`;
      },
    });
    return `<div class="page">${head}${body}</div>`;
  };

  const shownStarters = () => { const a = draft(); return startersOf(a, curRole(a)); };
  A['asst-touch'] = el => { const k = el.dataset.field; if (k) meta().touched[k] = true; refresh(); };
  A['asst-style'] = el => { draft().style = el.dataset.value; refresh(); };
  A['asst-role'] = el => { meta().role = el.dataset.value; refresh(); };
  A['asst-cap'] = el => { const a = draft(), k = el.dataset.k; if (k === 'citations') a.citations = !a.citations; else a.caps[k] = !a.caps[k]; refresh(); };
  A['asst-st-add'] = () => {
    const s = shownStarters(); if (s.length >= MAX_STARTERS) return;
    s.push({ title: '', prompt: '' }); refresh();
    requestAnimationFrame(() => $(`#asst-st${s.length - 1}t`)?.focus());
  };
  A['asst-st-rm'] = el => { shownStarters().splice(+el.dataset.i, 1); meta().touched = {}; refresh(); };
  A['asst-st-move'] = el => {
    const s = shownStarters(), i = +el.dataset.i, j = i + +el.dataset.d;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]]; meta().touched = {}; refresh();
    requestAnimationFrame(() => $(`[data-act="asst-st-move"][data-i="${j}"][data-d="${el.dataset.d}"]:not(:disabled)`)?.focus());
  };
  A['asst-discard'] = () => { S.ui.asst = clone(D.assistant); S.ui.asstMeta = null; refresh(); toast('Changes discarded', { tone: 'accent' }); };
  A['asst-publish'] = async () => {
    const a = draft(), m = meta(); if (m.busy) return;
    const errs = Object.keys(errors(a));
    if (errs.length) {
      m.tried = true;
      const roles = rolesOf(a), bad = roles?.find(r => errs.some(k => k.startsWith(r + '-st')));
      if (bad && !errs.some(k => k.startsWith(m.role + '-st'))) m.role = bad;
      refresh(); $('.asst-form [aria-invalid="true"]')?.focus(); return;
    }
    m.busy = true; refresh(); await sleep(700);
    const next = clone(a), trim = l => l.map(s => ({ title: s.title.trim(), prompt: s.prompt.trim() }));
    next.welcome = next.welcome.trim();
    next.starters = trim(next.starters);
    if (next.roleStarters) Object.keys(next.roleStarters).forEach(r => { next.roleStarters[r] = trim(next.roleStarters[r]); });
    Object.assign(D.assistant, next);
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action: 'Updated assistant setup', type: 'Settings', target: 'Assistant', outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
    const role = m.role;
    S.ui.asst = clone(D.assistant); S.ui.asstMeta = null; meta().role = role;
    refresh(); toast('Assistant published', { action: { label: 'Open chat', run: () => go('/chat') } });
  };
})();

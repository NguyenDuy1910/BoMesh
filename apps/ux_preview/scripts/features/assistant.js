/* Assistant (/assistant) — how the workspace assistant answers and what
   people see when they start a chat. Edits are a local draft with a live
   preview; Publish writes D.assistant (read by the chat home and Home).
   Starters: `starters` is what everyone sees; `audienceStarters[roleOrGroupId]`
   gives a real workspace role or group its own list (a group list wins over a role list).
   Exports: X.assistantStarters(userId?) — the starters one person sees. */
(() => {
  'use strict';

  const MAX_INS = 2000, MAX_WELCOME = 60, MAX_STARTERS = 3;
  const STYLES = [
    ['short', 'Short', 'A few sentences for quick lookups.'],
    ['balanced', 'Balanced', 'The answer first, then key details.'],
    ['detailed', 'Detailed', 'Thorough, with steps and context.'],
  ];
  /** '' = Everyone; otherwise a role id (People › Roles) or a group id (People › Groups). */
  const audName = id => (!id ? 'Everyone' : roleById(id)?.name || groupById(id)?.name || id);
  const isGroup = id => !!groupById(id);

  const draft = () => (S.ui.asst ??= clone(D.assistant));
  const meta = () => ui('asstMeta', { tried: false, touched: {}, busy: false, aud: '' });
  const own = (a, aud) => !!aud && !!a.audienceStarters?.[aud];
  /** The audience being edited ('' when it has no own list any more). */
  function curAud(a) { const m = meta(); if (m.aud && !roleById(m.aud) && !groupById(m.aud)) m.aud = ''; return m.aud; }
  const startersOf = (a, aud) => (own(a, aud) ? a.audienceStarters[aud] : a.starters);
  /** Error/touched key of a starter field; ids stay per visible list. */
  const sk = (aud, i, f) => `${aud ? aud + '-' : ''}st${i}${f}`;
  const pairs = list => list.map(s => [s.title, s.prompt]);
  const audLists = a => Object.entries(a.audienceStarters || {}).sort(([x], [y]) => x.localeCompare(y));
  const key = a => JSON.stringify([a.instructions, a.style, !!a.citations, !!a.caps?.analyze, !!a.caps?.files, a.welcome, pairs(a.starters), audLists(a).map(([r, l]) => [r, pairs(l)])]);
  const dirty = () => key(draft()) !== key(D.assistant);

  /** The starters one person sees: their first group with its own list, else their role's, else Everyone's. */
  X.assistantStarters = (userId = me().id) => {
    const a = D.assistant, m = memberById(userId), lists = a?.audienceStarters || {};
    const g = m?.groups?.find(id => lists[id]?.length);
    return (g && lists[g]) || (m && lists[m.roleId]) || a?.starters || [];
  };

  function errors(a) {
    const e = {};
    if (a.instructions.length > MAX_INS) e.instructions = `Shorten by ${fmtNum(a.instructions.length - MAX_INS)} characters.`;
    if (!a.welcome.trim()) e.welcome = 'Enter a welcome message.';
    else if (a.welcome.length > MAX_WELCOME) e.welcome = `Keep it to ${MAX_WELCOME} characters.`;
    ['', ...Object.keys(a.audienceStarters || {})].forEach(aud => startersOf(a, aud).forEach((s, i) => {
      if (!s.title.trim()) e[sk(aud, i, 't')] = 'Add a title.';
      if (!s.prompt.trim()) e[sk(aud, i, 'p')] = 'Add the prompt it sends.';
    }));
    return e;
  }
  const counter = (n, max) => `<span class="${cx('counter', n > max && 'asst-over')}">${fmtNum(n)}/${fmtNum(max)}</span>`;
  const liveAttrs = (k, extra = '') => `data-input="asst-touch" data-field="${k}" ${extra}`;

  /* ── Form ── */
  /** "Starters for" picker: Everyone, then roles and groups (a select, so it doesn't grow with the workspace). */
  function audiencePicker(a, aud) {
    const opt = (id, name) => `<option value="${esc(id)}" ${id === aud ? 'selected' : ''}>${esc(name)}${own(a, id) ? ` · ${esc(plural(a.audienceStarters[id].length, 'starter'))}` : ''}</option>`;
    return `<select class="select asst-aud" id="asst-aud" data-change="asst-aud" aria-label="Starters for">${opt('', 'Everyone')}
      <optgroup label="Roles">${D.roles.map(r => opt(r.id, r.name)).join('')}</optgroup>
      ${D.groups.length ? `<optgroup label="Groups">${D.groups.map(g => opt(g.id, g.name)).join('')}</optgroup>` : ''}</select>`;
  }
  /** Who sees the list being edited, in one line. */
  function audienceNote(a, aud) {
    const n = Object.keys(a.audienceStarters || {}).length;
    if (!aud) return n ? `Shown to anyone whose role or groups don’t have their own (${plural(n, 'role or group', 'roles or groups')} do).` : 'Shown to everyone in the workspace.';
    if (!own(a, aud)) return `${isGroup(aud) ? `Members of ${audName(aud)}` : `People with the ${audName(aud)} role`} see Everyone’s starters.`;
    return isGroup(aud) ? `Shown to members of ${audName(aud)}. A group’s starters win over a role’s.` : `Shown to people with the ${audName(aud)} role, unless one of their groups has its own.`;
  }
  function startersHtml(a, show) {
    const aud = curAud(a), mine = own(a, aud), list = startersOf(a, aud), n = list.length, base = mine ? `asst.audienceStarters.${aud}` : 'asst.starters';
    const rows = list.map((s, i) => `<div class="asst-starter" role="group" aria-label="Starter ${i + 1}">
      <div class="asst-starter__fields">
        ${field({ id: `asst-st${i}t`, label: 'Title', error: show(sk(aud, i, 't')), control: input({ id: `asst-st${i}t`, bind: `${base}.${i}.title`, value: s.title, placeholder: 'Find a policy', invalid: !!show(sk(aud, i, 't')), attrs: liveAttrs(sk(aud, i, 't'), 'maxlength="40"') }) })}
        ${field({ id: `asst-st${i}p`, label: 'Prompt', error: show(sk(aud, i, 'p')), control: input({ id: `asst-st${i}p`, bind: `${base}.${i}.prompt`, value: s.prompt, placeholder: 'What does our travel policy say about per diem?', invalid: !!show(sk(aud, i, 'p')), attrs: liveAttrs(sk(aud, i, 'p'), 'maxlength="160"') }) })}
      </div>
      <div class="asst-starter__actions">
        ${iconBtn('arrow-up', 'Move up', { size: 'sm', act: 'asst-st-move', data: { i, d: -1 }, disabled: i === 0 })}
        ${iconBtn('arrow-down', 'Move down', { size: 'sm', act: 'asst-st-move', data: { i, d: 1 }, disabled: i === n - 1 })}
        ${iconBtn('trash', 'Remove starter', { size: 'sm', act: 'asst-st-rm', data: { i } })}
      </div>
    </div>`).join('');
    const head = `<div class="asst-aud-row"><label class="label" for="asst-aud">Starters for</label>${audiencePicker(a, aud)}${mine ? linkBtn('Use Everyone’s instead', { act: 'asst-aud-reset' }) : ''}</div>
      <p class="t-xs muted asst-aud-note">${esc(audienceNote(a, aud))}</p>`;
    if (aud && !mine) return `${head}<div class="asst-aud-empty">${btn(`Give ${audName(aud)} their own starters`, { size: 'sm', icon: 'plus', act: 'asst-aud-own' })}</div>`;
    return `${head}
      ${n ? `<div class="asst-starters">${rows}</div>` : `<p class="t-sm muted">No starters. ${aud ? esc(audName(aud)) : 'People'} see only the welcome message.</p>`}
      <div class="row between gap-8">${n < MAX_STARTERS ? btn('Add starter', { size: 'sm', icon: 'plus', act: 'asst-st-add' }) : '<span></span>'}<span class="t-xs muted num">${n}/${MAX_STARTERS}</span></div>`;
  }
  function formHtml(a, show) {
    const ins = card(field({
      id: 'asst-ins', error: show('instructions'),
      desc: 'Who it serves, what to prioritise, what to avoid.', counter: show('instructions') ? '' : counter(a.instructions.length, MAX_INS),
      control: textarea({ id: 'asst-ins', bind: 'asst.instructions', value: a.instructions, rows: 7, invalid: !!show('instructions'), attrs: liveAttrs('instructions', 'aria-label="Instructions"') }),
    }), { title: 'Instructions' });

    const style = card(`<div class="asst-style">${choiceGroup({ name: 'asst-style', value: a.style, options: STYLES, act: 'asst-style', cols: 3 })}</div>`, { title: 'Answer style' });

    /* Rarely changed: capabilities sit behind a disclosure under what people see. Searching knowledge is always on. */
    const capOn = [a.citations, a.caps.analyze, a.caps.files].filter(Boolean).length;
    const caps = disclosure({
      path: 'asstMeta.caps', icon: 'sliders', title: 'Capabilities',
      summary: capOn === 3 ? 'All on' : capOn ? `${capOn} of 3 on` : 'All off',
      body: `<p class="t-sm muted asst-caps__note">Answers always come from your company knowledge.</p><div class="asst-switches">
      ${switchRow({ title: 'Cite sources', desc: 'Every claim links to the passage it came from.', on: a.citations, act: 'asst-cap', data: { k: 'citations' } })}
      ${switchRow({ title: 'Analyze files and data', desc: 'Read spreadsheets and calculate.', on: a.caps.analyze, act: 'asst-cap', data: { k: 'analyze' } })}
      ${switchRow({ title: 'Create files', desc: 'Produce documents and spreadsheets.', on: a.caps.files, act: 'asst-cap', data: { k: 'files' } })}
    </div>`,
    });

    const home = card(`${field({
      id: 'asst-welcome', label: 'Welcome message', required: true, error: show('welcome'), counter: show('welcome') ? '' : counter(a.welcome.length, MAX_WELCOME),
      control: input({ id: 'asst-welcome', bind: 'asst.welcome', value: a.welcome, placeholder: 'What can I help you find?', invalid: !!show('welcome'), attrs: liveAttrs('welcome') }),
    })}${startersHtml(a, show)}`, { title: 'Chat home', desc: 'What people see when they start a new chat.' });

    return `<div class="asst-form">${ins}${style}${home}${caps}</div>`;
  }

  /* ── Live preview ── */
  const cite = (a, n) => (a.citations ? `<sup class="asst-cite">${n}</sup>` : '');
  function sampleAnswer(a) {
    if (a.style === 'short') return `<p>Domestic trips get $75 a day and international trips $110 a day for meals.${cite(a, 1)}</p>`;
    const core = `<p>Per diem covers meals and incidentals on business trips.${cite(a, 1)}</p><ul><li>Domestic: $75 a day</li><li>International: $110 a day${cite(a, 1)}</li><li>Travel days are paid at 75%</li></ul>`;
    if (a.style === 'balanced') return core;
    return `${core}<p class="asst-prev__sub">How to claim</p><ol><li>Log the trip in Concur within 30 days.${cite(a, 2)}</li><li>Attach receipts only for lodging.</li><li>Your manager approves; Finance pays in the next cycle.</li></ol><p>For exceptions, ask Finance before you travel.</p>`;
  }
  /** The preview body (inline on wide screens, in a drawer on phones and tablets). */
  function previewBody(a) {
    const w = a.welcome.trim(), aud = curAud(a);
    const tiles = startersOf(a, aud).filter(s => s.title.trim() || s.prompt.trim());
    const homeHtml = `<div class="asst-prev__home">
      <div class="${cx('asst-prev__welcome', !w && 'is-empty')}">${esc(w || 'Welcome message')}</div>
      <div class="asst-prev__composer"><span class="truncate">Ask anything…</span><span class="row gap-6">${a.caps.analyze ? ic('paperclip', 'i-sm') : ''}<span class="asst-prev__send">${ic('arrow-up', 'i-sm')}</span></span></div>
      ${tiles.length ? `<div class="asst-prev__tiles">${tiles.map(s => `<div class="asst-prev__tile"><div class="medium truncate">${esc(s.title.trim() || 'Untitled')}</div><div class="t-xs muted truncate">${esc(s.prompt.trim() || '—')}</div></div>`).join('')}</div>` : ''}
    </div>`;
    const answer = `<div class="asst-prev__chat">
      <div class="asst-prev__q">What’s our per diem?</div>
      <div class="asst-prev__a">${sampleAnswer(a)}${a.citations ? `<div class="asst-prev__sources">${chip('1 Travel & Expense Policy.pdf', { size: 'sm', icon: 'file-text' })}${a.style === 'detailed' ? chip('2 Expense How-to.docx', { size: 'sm', icon: 'file-text' }) : ''}</div>` : ''}</div>
    </div>`;
    return `<div class="row between gap-8"><span class="t-label asst-prev__title">${ic('eye', 'i-sm')}Live preview</span><span class="t-xs muted truncate">${esc(aud ? `As ${audName(aud)} sees it` : 'As everyone sees it')}</span></div>
        ${homeHtml}
        <hr class="separator">
        <div class="t-xs muted">Sample answer · ${esc(STYLES.find(s => s[0] === a.style)?.[1] || '')}</div>
        ${answer}`;
  }
  const previewHtml = a => `<aside class="asst-preview" aria-label="Preview"><div class="card asst-prev">${previewBody(a)}</div></aside>`;
  DR['asst-preview'] = () => ({ title: 'Preview', desc: 'What people see with your unpublished changes.', body: `<div class="asst-prev asst-prev--sheet">${previewBody(draft())}</div>`, foot: btn('Back to editing', { v: 'primary', act: 'close-drawer' }) });

  P.assistant = () => {
    /* Below 1024 px the preview sits behind one button (it would otherwise come after the whole form). */
    const head = pageHeader({ title: 'Assistant', desc: 'How it answers and what people see first.', actions: S.pageState === 'live' && !S.navLoading ? btn('Preview', { v: 'secondary', icon: 'eye', act: 'asst-preview-open', cls: 'asst-prev-open' }) : '' });
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

  const shownStarters = () => { const a = draft(); return startersOf(a, curAud(a)); };
  A['asst-preview-open'] = () => openDrawer('asst-preview', {});
  A['asst-touch'] = el => { const k = el.dataset.field; if (k) meta().touched[k] = true; refresh(); };
  A['asst-style'] = el => { draft().style = el.dataset.value; refresh(); };
  A['asst-aud'] = el => { meta().aud = el.value; refresh(); };
  /** Give the picked role or group its own list, starting from Everyone's (draft until Publish). */
  A['asst-aud-own'] = () => { const a = draft(), aud = meta().aud; if (!aud) return; (a.audienceStarters ??= {})[aud] = clone(a.starters); refresh(); };
  A['asst-aud-reset'] = () => { const a = draft(), aud = meta().aud; if (a.audienceStarters) delete a.audienceStarters[aud]; meta().touched = {}; refresh(); };
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
      const bad = Object.keys(a.audienceStarters || {}).find(r => errs.some(k => k.startsWith(r + '-st')));
      if (bad && !errs.some(k => k.startsWith((m.aud ? m.aud + '-' : '') + 'st'))) m.aud = bad;
      refresh(); $('.asst-form [aria-invalid="true"]')?.focus(); return;
    }
    m.busy = true; refresh(); await sleep(700);
    const next = clone(a), trim = l => l.map(s => ({ title: s.title.trim(), prompt: s.prompt.trim() }));
    next.welcome = next.welcome.trim();
    next.starters = trim(next.starters);
    if (next.audienceStarters) Object.keys(next.audienceStarters).forEach(r => { next.audienceStarters[r] = trim(next.audienceStarters[r]); });
    Object.assign(D.assistant, next);
    D.audit.unshift({ id: uid('ev'), at: Date.now(), actor: me().id, action: 'Updated assistant setup', type: 'Settings', target: 'Assistant', outcome: 'success', ip: '10.4.12.30', device: 'Chrome on macOS' });
    const aud = m.aud;
    S.ui.asst = clone(D.assistant); S.ui.asstMeta = null; meta().aud = aud;
    refresh(); toast('Assistant published', { action: { label: 'Open chat', run: () => go('/chat') } });
  };
})();

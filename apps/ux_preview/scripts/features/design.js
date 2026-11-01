/* Design system gallery (/design). Every example is rendered by the real
   builders in core/ui.js and overlays.js, so the page always reflects the code. */
(() => {
  'use strict';

  const SECTIONS = [
    ['ds-foundations', 'Foundations'], ['ds-buttons', 'Buttons'], ['ds-chips', 'Chips & status'], ['ds-forms', 'Form controls'],
    ['ds-navigation', 'Navigation'], ['ds-data', 'Data display'], ['ds-feedback', 'Feedback'], ['ds-evidence', 'Evidence'],
  ];
  const COLOR_GROUPS = [
    ['Surfaces', ['background', 'surface', 'surface-secondary', 'surface-tertiary', 'default', 'overlay', 'field-background']],
    ['Text and lines', ['foreground', 'muted', 'border', 'separator', 'focus']],
    ['Accent and status', ['accent', 'accent-soft', 'success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft']],
    ['Evidence', ['evidence', 'evidence-strong']],
  ];
  const TYPE = [
    ['t-display', 'Display', '28/36 · 600'], ['t-title', 'Title', '20/28 · 600'], ['t-heading', 'Heading', '16/24 · 600'],
    ['t-subheading', 'Subheading', '14/20 · 600'], ['t-body', 'Body', '14/20 · 400'], ['t-sm', 'Small', '13/18 · 400'],
    ['t-xs', 'Caption', '12/16 · 400'], ['t-label', 'Label', '12/16 · 500 · muted'], ['t-num', 'Number', '24/32 · 600 · tabular'],
  ];
  const ROWS = [
    { id: 'r1', name: 'Employee Handbook 2026.pdf', type: 'pdf', kb: 'HR Policies', size: 3.4e6, updated: ago(2 * DAY), status: 'ready' },
    { id: 'r2', name: 'Travel & Expense Policy.pdf', type: 'pdf', kb: 'HR Policies', size: 1.2e6, updated: ago(3 * HOUR), status: 'processing' },
    { id: 'r3', name: 'Security baseline.docx', type: 'docx', kb: 'IT & Security', size: 860e3, updated: ago(40 * DAY), status: 'outdated' },
    { id: 'r4', name: 'Pipeline export Sept.xlsx', type: 'xlsx', kb: 'Sales', size: 2.1e6, updated: ago(5 * DAY), status: 'failed' },
    { id: 'r5', name: 'Onboarding deck.pptx', type: 'pptx', kb: 'People Ops', size: 9.8e6, updated: ago(12 * DAY), status: 'ready' },
  ];
  const PAGE_ITEMS = Array.from({ length: 23 }, (_, i) => `Meeting notes ${String(i + 1).padStart(2, '0')}.md`);
  const ds = () => ui('ds', { name: 'HR Policies', desc: 'Employee handbook, leave, travel and benefits.', role: 'viewer', vis: 'workspace', seg: 'list', sw1: true, sw2: false, c1: true, c2: false, tabP: 'all', tabS: 'documents', cite: 1, loading: false, pinned: false });

  const demo = (title, body, cls = '') => card(body, { title, cls: cx('ds-demo', cls) });
  const row = (html, cls = '') => `<div class="row gap-8 wrap ${cls}">${html}</div>`;
  const press = label => ({ act: 'ds-press', data: { label } });

  /* ── Foundations ── */
  function foundations() {
    // Resolve each token to its computed color (tokens contain calc() with the background tint).
    const probe = document.body.appendChild(Object.assign(document.createElement('i'), { hidden: true }));
    const resolve = t => { probe.style.color = `var(--${t})`; return getComputedStyle(probe).color; };
    const swatch = t => { const v = resolve(t); return `<div class="ds-swatch"><span class="ds-swatch__chip" style="background:var(--${t})"></span><span class="ds-swatch__name mono">--${t}</span><span class="ds-swatch__val truncate" title="${esc(v)}">${esc(v)}</span></div>`; };
    const colors = COLOR_GROUPS.map(([g, ts]) => `<div class="ds-group"><div class="t-label">${esc(g)}</div><div class="ds-swatches">${ts.map(swatch).join('')}</div></div>`).join('');
    probe.remove();
    const type = `<div class="ds-type">${TYPE.map(([c, l, m]) => `<div class="ds-type__row"><span class="${c} truncate">${c === 't-num' ? '18,420' : 'Grounded answers you can check'}</span><span class="ds-type__meta"><span class="medium">${l}</span><span class="mono">.${c}</span><span>${m}</span></span></div>`).join('')}</div>`;
    const radius = `<div class="ds-tiles">${['sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'].map(r => `<div class="ds-tile"><span class="ds-radius" style="border-radius:var(--radius-${r})"></span><span class="mono t-xs">--radius-${r}</span></div>`).join('')}<div class="ds-tile"><span class="ds-radius" style="border-radius:var(--field-radius)"></span><span class="mono t-xs">--field-radius</span></div></div>`;
    const shadows = `<div class="ds-tiles">${['surface-shadow', 'field-shadow', 'overlay-shadow'].map(s => `<div class="ds-tile"><span class="ds-shadow" style="box-shadow:var(--${s})"></span><span class="mono t-xs">--${s}</span></div>`).join('')}</div>`;
    const spacing = `<div class="ds-space">${[2, 4, 6, 8, 12, 16, 20, 24, 32].map(n => `<div class="ds-space__row"><span class="mono t-xs">.gap-${n}</span><span class="ds-space__bar" style="width:${n * 4}px"></span><span class="t-xs muted">${n}px</span></div>`).join('')}</div>`;
    return section('Foundations', `<div class="stack gap-16">
      ${demo('Background', `<p class="muted t-sm mb-12">HeroUI “Base”: every neutral (canvas, surfaces, borders, text) takes the chosen hue and tint. Accent, status and evidence colors don’t change.</p>${bgPicker('ds-bg', true)}`)}
      ${demo('Color tokens', `${alertBox('default', '', `Values for the <strong>${resolvedTheme()}</strong> theme and <strong>${esc(BACKGROUNDS.find(b => b[0] === S.bg)?.[1] || '')}</strong> background, read live from CSS. Components only use these tokens.`)}${colors}`)}
      ${demo('Typography', type)}
      <div class="grid cols-2">${demo('Radius', radius)}${demo('Shadows', shadows)}</div>
      ${demo('Spacing', spacing)}
    </div>`, { id: 'ds-foundations', desc: 'HeroUI theme tokens. Colors, type, radius, shadow and spacing come only from here.' });
  }

  /* ── Buttons ── */
  function buttons() {
    const d = ds();
    const variants = ['primary', 'secondary', 'tertiary', 'ghost', 'outline', 'danger', 'danger-soft'];
    return section('Buttons', `<div class="stack gap-16">
      ${demo('Variants', row(variants.map(v => btn(v[0].toUpperCase() + v.slice(1).replace('-', ' '), { v, ...press(v) })).join('')))}
      ${demo('Sizes', `<div class="stack gap-12">${row(['sm', 'md', 'lg'].map(s => btn(`Size ${s}`, { v: 'primary', size: s, ...press('Size ' + s) })).join(''))}${row(['sm', 'md', 'lg'].map(s => btn(`Size ${s}`, { size: s, ...press('Size ' + s) })).join(''))}</div>`)}
      ${demo('Content and states', `<div class="stack gap-12">
        ${row(btn('New chat', { v: 'primary', icon: 'plus', ...press('New chat') }) + btn('Continue', { iconRight: 'arrow-right', ...press('Continue') }) + btn('Options', { iconRight: 'chevron-down', menu: 'ds-menu' }) + iconBtn('more', 'More actions', press('More actions')) + iconBtn('pencil', 'Rename', { v: 'tertiary', ...press('Rename') }) + iconBtn('trash', 'Delete', { v: 'danger-soft', ...press('Delete') }) + linkBtn('Link button', press('Link button')))}
        ${row(btn(d.loading ? 'Saving' : 'Save changes', { v: 'primary', loading: d.loading, disabled: d.loading, act: 'ds-load' }) + btn('Loading', { loading: true, disabled: true }) + btn('Disabled', { v: 'primary', disabled: true }) + btn('Disabled', { disabled: true }))}
        <div class="ds-narrow">${btn('Full width', { v: 'secondary', full: true, ...press('Full width') })}</div>
      </div>`)}
    </div>`, { id: 'ds-buttons', desc: 'Pills. One primary per region; secondary actions are tertiary, ghost or outline; destructive is danger.' });
  }

  /* ── Chips & status ── */
  function chips() {
    const tones = ['default', 'accent', 'success', 'warning', 'danger'], variants = ['soft', 'primary', 'tertiary', 'outline'];
    const matrix = `<div class="ds-matrix" style="--cols:${variants.length}"><span></span>${variants.map(v => `<span class="t-label">${v}</span>`).join('')}${tones.map(t => `<span class="t-label">${t}</span>${variants.map(v => `<span>${chip(t[0].toUpperCase() + t.slice(1), { tone: t, variant: v })}</span>`).join('')}`).join('')}</div>`;
    const extras = row(chip('Small', { size: 'sm' }) + chip('Default') + chip('Large', { size: 'lg' }) + chip('Verified', { tone: 'success', icon: 'shield-check' }) + chip('Syncing', { tone: 'accent', dot: true, live: true }) + chip('Preview', { variant: 'outline', size: 'sm' }) + '<span class="badge">3</span><span class="badge badge--accent">12</span><span class="badge badge--danger">!</span><span class="badge-dot"></span>' + kbd('⌘K') + kbd('Esc'));
    const vocab = kv(Object.entries(STATUS).map(([kind, vals]) => [kind, row(Object.keys(vals).map(v => status(kind, v)).join(''), 'gap-6')]));
    return section('Chips & status', `<div class="stack gap-16">
      ${demo('Tones × variants', matrix)}
      ${demo('Sizes, icons, badges, keys', extras)}
      ${demo('Status vocabulary', `<p class="t-sm muted mb-12">Every <span class="mono">status(kind, value)</span> entry. Healthy steady states stay quiet.</p>${vocab}`)}
    </div>`, { id: 'ds-chips', desc: 'Short labels for state and category. Status uses one plain-language vocabulary.' });
  }

  /* ── Form controls ── */
  function forms() {
    const d = ds();
    const left = `
      ${field({ id: 'ds-name', label: 'Knowledge base name', required: true, desc: 'Visible to everyone with access.', control: input({ id: 'ds-name', bind: 'ds.name', value: d.name }) })}
      ${field({ id: 'ds-email', label: 'Work email', error: 'Enter an email like name@company.com.', control: input({ id: 'ds-email', value: 'linh.tran@', invalid: true }) })}
      ${field({ id: 'ds-desc', label: 'Description', optional: true, control: textarea({ id: 'ds-desc', bind: 'ds.desc', value: d.desc, rows: 3, attrs: 'data-live maxlength="160"' }), counter: `<span class="counter">${d.desc.length}/160</span>` })}
      ${field({ id: 'ds-mail', label: 'With icon', control: `<div class="input-group">${ic('mail')}${input({ id: 'ds-mail', placeholder: 'name@company.com', type: 'email' })}</div>` })}
      <div class="field"><span class="label">Sizes</span><div class="stack gap-8">${input({ id: 'ds-in-sm', size: 'sm', placeholder: 'Small' })}${input({ id: 'ds-in-md', placeholder: 'Medium' })}${input({ id: 'ds-in-lg', size: 'lg', placeholder: 'Large' })}</div></div>`;
    const right = `
      ${field({ id: 'ds-role', label: 'Role', control: select({ id: 'ds-role', bind: 'ds.role', value: d.role, options: [['viewer', 'Viewer'], ['editor', 'Editor'], ['owner', 'Owner']] }) })}
      ${field({ id: 'dsSearch-q', label: 'Search field', control: searchField({ uiKey: 'dsSearch', placeholder: 'Search documents' }) })}
      <div class="field"><span class="label">Switch</span>${switchRow({ title: 'Show work steps', desc: 'Display how each answer was found.', on: d.sw1, act: 'ds-switch', data: { k: 'sw1' } })}<div class="row gap-12 mt-8">${switchCtl({ on: d.sw2, act: 'ds-switch', data: { k: 'sw2' }, label: 'Inline switch' })}<span class="t-sm">Inline</span>${switchCtl({ on: true, disabled: true, label: 'Disabled switch' })}<span class="t-sm muted">Disabled</span></div></div>
      <fieldset class="fieldset"><legend class="fieldset__legend">Checkbox</legend>${checkbox({ label: 'Checked', checked: d.c1, bind: 'ds.c1' })}${checkbox({ label: 'Unchecked', checked: d.c2, bind: 'ds.c2' })}${checkbox({ label: 'Indeterminate', indeterminate: true })}${checkbox({ label: 'Disabled', disabled: true })}</fieldset>
      <fieldset class="fieldset"><legend class="fieldset__legend">Choice group</legend>${choiceGroup({ name: 'ds-vis', value: d.vis, act: 'ds-choice', cols: 2, options: [['private', 'Private', 'Only people you invite'], ['workspace', 'Workspace', 'Everyone in Northwind']] })}</fieldset>
      <div class="field"><span class="label">Segmented</span><div>${seg({ value: d.seg, act: 'ds-seg', label: 'View', options: [['list', 'List', 'list'], ['grid', 'Grid', 'grid'], ['table', 'Table', 'table']] })}</div></div>`;
    return section('Form controls', demo('Fields', `<div class="grid cols-2 ds-forms"><div>${left}</div><div>${right}</div></div>`), { id: 'ds-forms', desc: 'Visible labels, help below the control, inline errors that say how to fix it.' });
  }

  /* ── Navigation ── */
  function navigation() {
    const d = ds();
    const per = 5, shown = paginate(PAGE_ITEMS, 'dsPage', per);
    const bc = `<nav class="breadcrumbs" aria-label="Breadcrumb example"><span>Knowledge</span>${ic('chevron-right')}<span>HR Policies</span>${ic('chevron-right')}<span aria-current="page">Employee Handbook 2026.pdf</span></nav>`;
    return section('Navigation', `<div class="stack gap-16">
      ${demo('Tabs', `<div class="stack gap-16"><div><div class="t-label mb-8">Primary</div>${tabs([{ id: 'all', label: 'All', count: 24 }, { id: 'docs', label: 'Documents', count: 18 }, { id: 'sources', label: 'Sources', count: 2, alert: true }], d.tabP, '', { variant: 'primary', act: 'ds-tab-p' })}</div>
        <div><div class="t-label mb-8">Secondary</div>${tabs([{ id: 'documents', label: 'Documents', icon: 'file-text', count: 18 }, { id: 'sources', label: 'Sources', icon: 'plug' }, { id: 'access', label: 'Access', icon: 'users' }, { id: 'settings', label: 'Settings', icon: 'settings' }], d.tabS, '', { act: 'ds-tab-s' })}</div></div>`)}
      <div class="grid cols-2 ds-start">
        ${demo('Breadcrumbs', bc)}
        ${demo('Pagination', `${list(shown.map(n => item({ lead: fileIcon('md', 'sm'), title: esc(n) })), 'list--plain')}${pager(PAGE_ITEMS.length, 'dsPage', per)}`)}
      </div>
    </div>`, { id: 'ds-navigation', desc: 'Tabs switch views of one record; breadcrumbs show where a detail page lives.' });
  }

  /* ── Data display ── */
  function dataDisplay() {
    const u = 'dsTable';
    const rows = applySort(ROWS, u, { name: r => r.name.toLowerCase() });
    const head = selAllCheck(u, ROWS.map(r => r.id)) + sortHead('Name', 'name', u) + th('Knowledge base') + sortHead('Size', 'size', u, 'table__column--num') + sortHead('Updated', 'updated', u) + th('Status') + th('<span class="sr-only">Actions</span>', 'table__column--actions');
    const trs = rows.map(r => `<tr class="table__row" data-act="ds-row" data-id="${r.id}" tabindex="0">${selCheck(u, r.id, 'Select ' + r.name)}<td class="table__cell table__cell--primary"><span class="row gap-8">${fileIcon(r.type, 'sm')}<span class="truncate medium">${esc(r.name)}</span></span></td><td class="table__cell table__cell--hide-sm ds-nowrap">${esc(r.kb)}</td><td class="table__cell table__cell--num num ds-nowrap">${fmtSize(r.size)}</td><td class="table__cell ds-nowrap">${rel(r.updated)}</td><td class="table__cell">${status('doc', r.status)}</td><td class="table__cell table__cell--actions">${iconBtn('more', 'Actions for ' + r.name, { size: 'sm', menu: 'ds-menu' })}</td></tr>`);
    const tbl = table({ head, rows: trs, label: 'Documents example' }) + bulkBar(u, btn('Archive', { size: 'sm', icon: 'archive', act: 'ds-bulk' }));
    const items = list([
      item({ lead: itemIcon('book', 'accent'), title: 'HR Policies', titleExtra: chip('Owner', { size: 'sm' }), desc: '128 documents · Updated 2 h ago', trail: ic('chevron-right', 'muted'), ...press('HR Policies') }),
      item({ lead: avatar('Tuan Le'), title: 'Tuan Le', desc: 'tuan.le@northwind.com', meta: '3 h ago', trail: status('member', 'active'), ...press('Tuan Le') }),
      item({ lead: appIcon('gdrive'), title: 'Sales Enablement', desc: 'Google Drive · 412 files', trail: status('source', 'reconnect'), unread: true, ...press('Sales Enablement') }),
    ]);
    const spark = [12, 18, 15, 22, 19, 26, 31, 28, 34, 38];
    const stats = `<div class="grid cols-4">
      ${statCard({ icon: 'message', label: 'Questions', value: fmtNum(18420), meta: 'Last 30 days', tone: 'accent', extra: sparkline(spark) })}
      ${statCard({ icon: 'check-circle', label: 'Answered with sources', value: '94%', meta: '+2 pts vs last month', tone: 'success' })}
      ${statCard({ icon: 'alert', label: 'Needs attention', value: '3', meta: 'Open to review', tone: 'warning', act: 'ds-press', data: { label: 'Needs attention' } })}
      ${statCard({ icon: 'file-text', label: 'Documents', value: fmtNum(2481), meta: '12 processing' })}
    </div>`;
    const ids = `<div class="stack gap-16">
      ${row(['xs', 'sm', 'md', 'lg', 'xl'].map(s => avatar('Linh Tran', s)).join('') + `<span class="avatar-group">${['Minh Pham', 'Linh Tran', 'Alex Rivera', 'An Nguyen'].map(n => avatar(n, 'sm')).join('')}</span>`, 'gap-12')}
      ${row(D.workspaces.map(w => wsMark(w, 28)).join('') + ['book', 'shield', 'users', 'alert', 'x-circle'].map((i, k) => itemIcon(i, ['', 'accent', 'success', 'warning', 'danger'][k])).join(''), 'gap-12')}
      ${row(['pdf', 'docx', 'xlsx', 'pptx', 'md', 'csv'].map(t => fileIcon(t)).join('') + fileIcon('pdf', 'lg') + fileIcon('xlsx', 'sm'), 'gap-12')}
      ${row(Object.keys(APPS).map(k => `<span class="row gap-6 t-sm">${appIcon(k)}${esc(APPS[k].name)}</span>`).join(''), 'gap-16')}
    </div>`;
    const prog = `<div class="stack gap-12">${[[72, ''], [100, 'success'], [48, 'warning'], [18, 'danger']].map(([v, t]) => `<div class="row gap-12">${progress(v, t)}<span class="t-xs num muted ds-pct">${v}%</span></div>`).join('')}
      <div class="row gap-12">${progress(40, '', 'Loading').replace('class="progress-bar ', 'class="progress-bar progress-bar--indeterminate ')}<span class="t-xs muted ds-pct">Busy</span></div>
      <div class="meter" role="img" aria-label="Storage by type"><span style="width:52%;background:var(--accent)"></span><span style="width:24%;background:var(--warning)"></span><span style="width:12%;background:var(--danger)"></span></div>
      <div class="chart-legend"><span><i></i>Documents</span><span><i style="--c:var(--warning)"></i>Sheets</span><span><i style="--c:var(--danger)"></i>Slides</span></div></div>`;
    const charts = `<div class="stack gap-12">${bars([320, 410, 380, 460, 520, 490, 610, 580, 640, 720, 690, 760], { height: 120, labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] })}${sparkline([4, 6, 5, 9, 7, 11, 10, 14], { tone: 'success', height: 40 })}</div>`;
    return section('Data display', `<div class="stack gap-16">
      ${demo('Table', `<p class="t-sm muted">Sort by Name, Size or Updated; select rows to show the bulk bar. Rows stack into cards below 760 px.</p>${tbl}`, 'ds-demo--flat')}
      <div class="grid cols-2">${demo('List', items, 'ds-demo--flat')}${demo('Key–value', kv([['Owner', `<span class="row gap-8">${avatar('Linh Tran', 'xs')}Linh Tran</span>`], ['Source', `<span class="row gap-8">${appIcon('gdrive', 'sm')}Google Drive</span>`], ['Updated', rel(ago(2 * HOUR))], ['Size', fmtSize(3.4e6)], ['Status', status('doc', 'ready')]]))}</div>
      ${stats}
      <div class="grid cols-2">${demo('Avatars and icons', ids)}${demo('Progress and meter', prog)}</div>
      ${demo('Charts', charts)}
    </div>`, { id: 'ds-data', desc: 'Tables for records, lists for short collections, cards for metrics.' });
  }

  /* ── Feedback ── */
  function feedback() {
    const alerts = `<div class="stack gap-8">
      ${alertBox('default', 'Heads up', 'Indexing runs every night at 02:00.')}
      ${alertBox('accent', 'New connector available', 'Confluence can now sync page trees.', btn('Set up', { size: 'sm', ...press('Set up') }))}
      ${alertBox('success', 'Changes saved', 'The assistant uses the new instructions.')}
      ${alertBox('warning', '2 documents need attention', 'Upload readable copies to make them searchable.')}
      ${alertBox('danger', 'Sales Enablement stopped syncing', 'Reconnect Google Drive to resume updates.', btn('Reconnect', { size: 'sm', v: 'danger-soft', ...press('Reconnect') }))}
      ${alertBox('accent', 'Solid alert', 'Use sparingly, for page-level notices.', '', { soft: false })}
    </div>`;
    const states = `<div class="grid cols-2">${emptyState({ icon: 'upload', title: 'Add your first documents', desc: 'Upload files or connect a source.', actions: btn('Upload files', { v: 'primary', size: 'sm', ...press('Upload files') }), boxed: true, compact: true })}${errorState()}</div>`;
    const skel = `<div class="stack gap-16">${skelRows(3)}<div class="row gap-12"><span class="skeleton skeleton--circle" style="width:36px;height:36px"></span><div class="grow stack gap-6"><span class="skeleton skeleton--title" style="width:40%"></span><span class="skeleton skeleton--line" style="width:70%"></span></div></div><div class="row gap-16">${spinner('sm')}${spinner()}${spinner('lg')}</div></div>`;
    const overlays = `<div class="stack gap-12">
      ${row(btn('Success toast', { act: 'ds-toast', data: { t: 'success' } }) + btn('Error toast', { act: 'ds-toast', data: { t: 'danger' } }) + btn('Info toast', { act: 'ds-toast', data: { t: 'accent' } }) + btn('Toast with undo', { act: 'ds-toast', data: { t: 'undo' } }))}
      ${row(btn('Open modal', { icon: 'maximize', act: 'ds-modal' }) + btn('Open drawer', { icon: 'panel-right', act: 'ds-drawer' }) + btn('Confirm', { act: 'ds-confirm' }) + btn('Typed confirm', { v: 'danger-soft', act: 'ds-confirm', data: { typed: 1 } }) + btn('Open menu', { iconRight: 'chevron-down', menu: 'ds-menu' }) + btn('Hover for tooltip', { v: 'ghost', tip: 'Tooltips name icon-only buttons', ...press('Hover for tooltip') }))}
    </div>`;
    return section('Feedback', `<div class="stack gap-16">
      ${demo('Alerts', alerts)}
      ${demo('Empty and error states', states)}
      ${demo('Loading', skel)}
      ${demo('Overlays', overlays)}
    </div>`, { id: 'ds-feedback', desc: 'Every mutation toasts; every async region has loading, empty and error states with a next step.' });
  }

  /* ── Evidence ── */
  function evidence() {
    const n = ds().cite;
    const cite = k => `<button type="button" class="cite" data-act="ds-cite" data-n="${k}" aria-pressed="${n === k}" aria-label="Source ${k}">${k}</button>`;
    return section('Evidence', `<div class="grid cols-2 ds-start">
      ${demo('Grounded answer', `<p class="ds-answer">The international meal allowance is <strong>USD 75 per day</strong>${cite(1)}. Lodging and transport still need receipts${cite(2)}.</p>${row(chip('Travel Policy.pdf · p. 8', { icon: 'file-text', variant: 'tertiary' }) + chip('Expense limits.xlsx', { icon: 'table', variant: 'tertiary' }))}`)}
      ${demo('Cited passage', `<div class="row gap-8">${fileIcon(n === 1 ? 'pdf' : 'xlsx', 'sm')}<span class="medium truncate">${n === 1 ? 'Travel Policy.pdf' : 'Expense limits.xlsx'}</span><span class="t-xs muted">${n === 1 ? 'Page 8' : 'Sheet 2'}</span></div>
        <p class="ds-passage">${n === 1 ? 'Section 4.2 — Meals. Employees travelling internationally receive <mark class="evidence is-focus">a fixed meal allowance of USD 75 per calendar day</mark>, paid with the next payroll.' : 'Category limits apply per trip. <mark class="evidence is-focus">Lodging and ground transport are reimbursed against itemised receipts</mark>; meals follow the daily allowance.'}</p>`)}
    </div>`, { id: 'ds-evidence', desc: 'Amber is reserved for evidence: citation markers and the passages they point to.' });
  }

  P.design = () => {
    const dark = resolvedTheme() === 'dark';
    return `<div class="ds" id="ds-scroll" data-keep-scroll>
      <header class="ds-top"><div class="ds-top__inner">
        ${btn('Back to app', { v: 'ghost', size: 'sm', icon: 'arrow-left', href: S.signedIn ? '/chat' : '/signin' })}
        <span class="grow"></span>
        ${btn(dark ? 'Light theme' : 'Dark theme', { size: 'sm', icon: dark ? 'sun' : 'moon', act: 'ds-theme' })}
      </div></header>
      <div class="ds-wrap">
        ${pageHeader({ title: 'BoMesh design system', desc: 'HeroUI v3 components as built in <span class="mono">ui.js</span>. Every example is live.' })}
        <div class="ds-layout">
          <nav class="ds-nav" aria-label="Design system sections">${SECTIONS.map(([id, l]) => `<button type="button" class="ds-nav__link" data-act="ds-jump" data-id="${id}">${esc(l)}</button>`).join('')}</nav>
          <div class="ds-main">${foundations()}${buttons()}${chips()}${forms()}${navigation()}${dataDisplay()}${feedback()}${evidence()}</div>
        </div>
      </div>
    </div>`;
  };

  /* Scroll spy: mark the section currently at the top of the page. */
  AFTER.design = () => {
    const sc = $('#ds-scroll'); if (!sc) return;
    const spy = () => {
      const edge = sc.getBoundingClientRect().top + 120;
      let cur = SECTIONS[0][0];
      for (const [id] of SECTIONS) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top <= edge) cur = id; }
      if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1][0];
      $$('.ds-nav__link', sc).forEach(b => (b.dataset.id === cur ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    };
    sc.addEventListener('scroll', spy, { passive: true });
    spy();
  };

  /* ── Actions ── */
  A['ds-theme'] = () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
  A['ds-bg'] = el => setBackground(el.dataset.value);
  A['ds-jump'] = el => document.getElementById(el.dataset.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  A['ds-press'] = el => toast(`“${el.dataset.label || 'Button'}” pressed`, { tone: 'accent', duration: 1800 });
  A['ds-load'] = async () => { const d = ds(); if (d.loading) return; d.loading = true; refresh(); await sleep(1200); d.loading = false; refresh(); toast('Changes saved'); };
  A['ds-switch'] = el => { const d = ds(); d[el.dataset.k] = !d[el.dataset.k]; refresh(); };
  A['ds-choice'] = el => { ds().vis = el.dataset.value; refresh(); };
  A['ds-seg'] = el => { ds().seg = el.dataset.value; refresh(); };
  A['ds-tab-p'] = el => { ds().tabP = el.dataset.value; refresh(); };
  A['ds-tab-s'] = el => { ds().tabS = el.dataset.value; refresh(); };
  A['ds-cite'] = el => { ds().cite = +el.dataset.n; refresh(); };
  A['ds-row'] = el => openDrawer('ds-drawer', { id: el.dataset.id });
  A['ds-bulk'] = () => {
    const ids = selIds('dsTable'); ui('dsTable').sel = {}; refresh();
    toast(`Archived ${plural(ids.length, 'document')}`, { action: { label: 'Undo', run: () => { ui('dsTable').sel = Object.fromEntries(ids.map(id => [id, true])); refresh(); toast('Restored'); } } });
  };
  A['ds-toast'] = el => {
    const t = el.dataset.t;
    if (t === 'success') toast('Changes saved');
    else if (t === 'danger') toast('Couldn’t save. Check your connection and try again.', { tone: 'danger' });
    else if (t === 'accent') toast('Sync started. This can take a few minutes.', { tone: 'accent' });
    else toast('Archived 3 documents', { action: { label: 'Undo', run: () => toast('Restored 3 documents') } });
  };
  A['ds-modal'] = () => { setPath('dsModal.reason', ''); openModal('ds-modal'); };
  A['ds-modal-ok'] = () => { closeModal(); toast('Archived 3 documents', { action: { label: 'Undo', run: () => toast('Restored 3 documents') } }); };
  A['ds-drawer'] = () => openDrawer('ds-drawer', { id: 'r1' });
  A['ds-confirm'] = el => confirmAction(el.dataset.typed
    ? { title: 'Delete HR Policies?', body: 'Its 128 documents stop appearing in answers. This can’t be undone.', confirm: 'Delete', danger: true, typeText: 'HR Policies', onConfirm: () => toast('Deleted HR Policies') }
    : { title: 'Publish instructions?', body: 'Everyone in the workspace gets answers with the new instructions.', confirm: 'Publish', onConfirm: () => toast('Instructions published') });

  M['ds-modal'] = () => ({
    size: 'sm', title: 'Archive 3 documents?', desc: 'HR Policies',
    body: `${alertBox('warning', 'They stop appearing in answers', 'You can restore them for 30 days.')}<div class="mt-16">${field({ id: 'ds-reason', label: 'Reason', optional: true, control: textarea({ id: 'ds-reason', bind: 'dsModal.reason', value: getPath('dsModal.reason') || '', rows: 2 }) })}</div>`,
    foot: btn('Cancel', { act: 'close-modal' }) + btn('Archive', { v: 'danger', act: 'ds-modal-ok' }),
  });
  DR['ds-drawer'] = ({ id }) => {
    const r = ROWS.find(x => x.id === id) || ROWS[0];
    return {
      title: r.name, desc: esc(r.kb), lead: fileIcon(r.type, 'lg'),
      headActions: iconBtn('download', 'Download', press('Download')),
      body: `<div class="drawer__section"><div class="drawer__section-title">Details</div>${kv([['Status', status('doc', r.status)], ['Size', fmtSize(r.size)], ['Updated', rel(r.updated)], ['Owner', `<span class="row gap-8">${avatar('Linh Tran', 'xs')}Linh Tran</span>`]])}</div>
        <div class="drawer__section"><div class="drawer__section-title">Used in answers</div>${list([item({ lead: itemIcon('message', '', 'sm'), title: 'What is the travel meal allowance?', meta: '2 h ago' }), item({ lead: itemIcon('message', '', 'sm'), title: 'Do I need receipts for taxis?', meta: 'Yesterday' })])}</div>`,
      footStart: btn('Archive', { v: 'danger-soft', act: 'ds-modal' }),
      foot: btn('Close', { act: 'close-drawer' }) + btn('Open document', { v: 'primary', ...press('Open document') }),
    };
  };
  MENUS['ds-menu'] = () => {
    const d = ds();
    return [
      { section: 'Document' },
      { label: 'Open details', icon: 'file-text', run: () => openDrawer('ds-drawer', { id: 'r1' }) },
      { label: 'Copy link', icon: 'copy', meta: '⌘C', run: () => toast('Link copied') },
      { label: 'Pinned', icon: 'paperclip', checked: d.pinned, run: () => { d.pinned = !d.pinned; toast(d.pinned ? 'Pinned' : 'Unpinned'); } },
      { label: 'Move to…', icon: 'folder', disabled: true },
      { sep: true },
      { label: 'Archive', icon: 'archive', danger: true, run: () => toast('Archived', { action: { label: 'Undo', run: () => toast('Restored') } }) },
    ];
  };
})();

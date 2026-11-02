'use strict';
/* Component builders. Every screen composes from these; each returns an HTML
   string that maps to a HeroUI component (see styles/components.css).
   Interaction is declarative: data-act="name" → A[name](el, event),
   data-menu="name" → MENUS[name](el), data-bind="bucket.field" → S.ui. */

const ic = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const spinner = (size = '') => `<span class="spinner ${size ? 'spinner--' + size : ''}" aria-hidden="true"></span>`;

/** Button. v: primary | secondary | tertiary | ghost | outline | danger | danger-soft. size: sm | md | lg. */
function btn(label, o = {}) {
  const { v = 'tertiary', size, icon, iconRight, act, data, disabled, loading, tip, id, cls, type = 'button', aria = '', href, menu, full, muted } = o;
  const c = cx('button', 'button--' + v, size && size !== 'md' && 'button--' + size, !label && 'button--icon-only', full && 'button--full-width', muted && 'button--muted', cls);
  const inner = (icon ? ic(icon) : '') + (label ? `<span>${esc(label)}</span>` : '') + (iconRight ? ic(iconRight) : '') + (loading ? spinner() : '');
  const a = [act && `data-act="${act}"`, menu && `data-menu="${menu}" aria-haspopup="menu" aria-expanded="false"`, dataAttrs(data),
    disabled && (href ? 'aria-disabled="true"' : 'disabled'), tip && `data-tip="${esc(tip)}"`, !label && tip && `aria-label="${esc(tip)}"`,
    id && `id="${id}"`, loading && 'aria-busy="true"', aria].filter(Boolean).join(' ');
  if (href) return `<a href="#${href}" class="${c}" ${a}>${inner}</a>`;
  return `<button type="${type}" class="${c}" ${a}>${inner}</button>`;
}
const iconBtn = (icon, tip, o = {}) => btn('', { v: 'ghost', icon, tip, muted: true, ...o });
const linkBtn = (label, o = {}) => o.href ? `<a class="link-button" href="#${o.href}">${esc(label)}${o.icon ? ic(o.icon, 'i-sm') : ''}</a>` : `<button type="button" class="link-button" ${o.act ? `data-act="${o.act}"` : ''} ${dataAttrs(o.data)}>${esc(label)}${o.icon ? ic(o.icon, 'i-sm') : ''}</button>`;

/** Chip. tone: default | accent | success | warning | danger. variant: soft (default) | primary | tertiary | outline. */
function chip(label, o = {}) {
  const { tone = 'default', variant = 'soft', icon, dot, live, size, tip } = o;
  return `<span class="${cx('chip', 'chip--' + tone, 'chip--' + variant, size && 'chip--' + size, live && 'chip--live')}" ${tip ? `data-tip="${esc(tip)}"` : ''}>${icon ? ic(icon) : dot ? '<span class="chip__dot"></span>' : ''}${esc(label)}</span>`;
}
/* Status vocabulary — one place, plain language. Healthy steady states are quiet (tertiary). */
const STATUS = {
  doc: { ready: ['success', 'Ready', 'tertiary'], processing: ['accent', 'Processing', 'soft', 1], pending: ['default', 'Waiting'], failed: ['danger', 'Failed'], outdated: ['warning', 'Needs update'], unsupported: ['default', 'Not searchable'] },
  source: { healthy: ['success', 'Up to date', 'tertiary'], syncing: ['accent', 'Syncing', 'soft', 1], failed: ['danger', 'Sync failed'], reconnect: ['danger', 'Reconnect needed'], paused: ['default', 'Paused'] },
  account: { connected: ['success', 'Connected', 'tertiary'], expired: ['danger', 'Reconnect needed'], error: ['warning', 'Can’t reach'], disabled: ['default', 'Disabled'] },
  run: { queued: ['accent', 'Queued', 'soft', 1], running: ['accent', 'In progress', 'soft', 1], completed: ['success', 'Completed', 'tertiary'], partial: ['warning', 'Completed with issues'], failed: ['danger', 'Failed'], cancelled: ['default', 'Cancelled'] },
  member: { active: ['success', 'Active', 'tertiary'], suspended: ['danger', 'Suspended'], invited: ['accent', 'Invited'] },
  request: { pending: ['warning', 'Pending'], approved: ['success', 'Approved'], denied: ['default', 'Denied'] },
  outcome: { success: ['success', 'Succeeded', 'tertiary'], failure: ['danger', 'Failed'] },
  ws: { active: ['success', 'Active', 'tertiary'], suspended: ['danger', 'Suspended'], new: ['accent', 'Setting up'] },
  service: { operational: ['success', 'Operational', 'tertiary'], degraded: ['warning', 'Degraded'], down: ['danger', 'Outage'] },
  connector: { builtin: ['default', 'Built in'], enabled: ['success', 'Enabled', 'tertiary'], disabled: ['default', 'Disabled'], unavailable: ['default', 'Not available'] },
};
function status(kind, value) {
  const s = STATUS[kind]?.[value];
  if (!s) return chip(String(value || '—'));
  const [tone, label, variant = 'soft', live] = s;
  return chip(label, { tone, variant, dot: true, live: !!live });
}

/** Avatar with a soft, name-stable tone (HeroUI Avatar soft fallback). */
const AV_TONES = ['accent', 'success', 'warning', 'danger', 'default'];
function avatar(name, size = 'md') {
  const tone = AV_TONES[hashOf(name) % AV_TONES.length];
  return `<span class="avatar avatar--${tone} ${size !== 'md' ? 'avatar--' + size : ''}" aria-hidden="true">${esc(initials(name))}</span>`;
}
function wsMark(ws, size = 28) { return `<span class="ws-mark" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px;${ws.color ? `background:${ws.color}` : ''}" aria-hidden="true">${esc((ws.name || '?')[0])}</span>`; }
const FILE_KIND = { pdf: 'pdf', doc: 'doc', docx: 'doc', md: 'text', txt: 'text', html: 'text', json: 'text', xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ppt: 'slide', pptx: 'slide', png: 'text', zip: 'text' };
function fileIcon(type, size = '') { const t = String(type || 'file').toLowerCase(); return `<span class="file-icon file-icon--${FILE_KIND[t] || 'text'} ${size ? 'file-icon--' + size : ''}" aria-hidden="true">${esc(t.toUpperCase().slice(0, 4))}</span>`; }
const APPS = {
  gdrive: { name: 'Google Drive', glyph: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path fill="#F5B400" d="M8.1 3h7.8l6.6 11.4h-7.8z"/><path fill="#2B7DE9" d="M22.5 14.4 18.6 21H5.4l3.9-6.6z"/><path fill="#1E9E5A" d="M8.1 3 1.5 14.4 5.4 21l6.6-11.4z"/></svg>` },
  confluence: { name: 'Confluence', glyph: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path fill="#1868DB" d="M3.2 16.9c-.3.4-.6 1-.8 1.4-.2.4-.1.9.3 1.1l4 2.5c.4.3 1 .1 1.2-.3.2-.3.4-.8.7-1.3 1.6-2.7 3.3-2.4 6.3-1l4 1.9c.5.2 1 0 1.2-.5l1.9-4.3c.2-.4 0-1-.5-1.2-.9-.4-2.6-1.2-4.1-1.9-5.6-2.7-10.4-2.5-14.2 3.6z"/><path fill="#1868DB" opacity=".75" d="M20.8 7.1c.3-.4.6-1 .8-1.4.2-.4.1-.9-.3-1.1l-4-2.5c-.4-.3-1-.1-1.2.3-.2.3-.4.8-.7 1.3-1.6 2.7-3.3 2.4-6.3 1l-4-1.9c-.5-.2-1 0-1.2.5L2 7.6c-.2.4 0 1 .5 1.2.9.4 2.6 1.2 4.1 1.9 5.6 2.7 10.4 2.5 14.2-3.6z"/></svg>` },
  upload: { name: 'File upload', glyph: s => `<svg class="i" style="width:${Math.round(s * .8)}px;height:${Math.round(s * .8)}px;color:var(--muted)" aria-hidden="true"><use href="#i-upload"/></svg>` },
  sharepoint: { name: 'SharePoint', glyph: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><circle cx="11" cy="8" r="6" fill="#036C70"/><circle cx="16" cy="13" r="5" fill="#1A9BA1"/><circle cx="11.5" cy="17.5" r="4" fill="#37C6D0"/></svg>` },
  notion: { name: 'Notion', glyph: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" fill="#fff" stroke="#111" stroke-width="1.6"/><path d="M8 7.5v9M8 7.5l8 9M16 7.5v9" stroke="#111" stroke-width="1.8" fill="none"/></svg>` },
  slack: { name: 'Slack', glyph: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><rect x="9.5" y="2" width="3.5" height="9" rx="1.75" fill="#36C5F0"/><rect x="13" y="9.5" width="9" height="3.5" rx="1.75" fill="#2EB67D"/><rect x="11" y="13" width="3.5" height="9" rx="1.75" fill="#ECB22E"/><rect x="2" y="11" width="9" height="3.5" rx="1.75" fill="#E01E5A"/></svg>` },
  github: { name: 'GitHub', provider: 'GitHub', url: 'https://github.com/finx', glyph: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path fill="#1F2328" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/></svg>` },
  jira: { name: 'Jira', provider: 'Atlassian', url: 'https://finx.atlassian.net/browse', glyph: s => `<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path fill="#1868DB" d="M21.6 11.3 12.7 2.4 12 1.7 5.3 8.4 2.4 11.3a1 1 0 0 0 0 1.4l6.1 6.1L12 22.3l6.7-6.7.1-.1 2.8-2.8a1 1 0 0 0 0-1.4zM12 15l-3-3 3-3 3 3z"/></svg>` },
  website: { name: 'Website', provider: 'the website', url: 'https://www.example.com', glyph: s => `<svg class="i" style="width:${Math.round(s * .8)}px;height:${Math.round(s * .8)}px;color:var(--muted)" aria-hidden="true"><use href="#i-globe"/></svg>` },
};
function appIcon(key, size = '') { const px = size === 'lg' ? 24 : size === 'sm' ? 16 : 20; return `<span class="app-icon ${size ? 'app-icon--' + size : ''}" aria-hidden="true">${APPS[key]?.glyph(px) || ''}</span>`; }
const kbd = k => `<kbd class="kbd">${esc(k)}</kbd>`;
const itemIcon = (icon, tone = '', size = '') => `<span class="item-icon ${tone ? 'item-icon--' + tone : ''} ${size ? 'item-icon--' + size : ''}" aria-hidden="true">${ic(icon)}</span>`;

/* ── Layout ── */
/** Page header: title, one-line description, primary actions on the right. */
function pageHeader({ title, desc = '', actions = '', extra = '', lead = '' }) {
  return `<header class="page-header">${lead ? `<div class="page-header__lead">${lead}</div>` : ''}<div class="page-header__body"><div class="page-header__title-row"><h1 class="page-header__title">${esc(title)}</h1>${extra}</div>${desc ? `<p class="page-header__description">${desc}</p>` : ''}</div>${actions ? `<div class="page-header__actions">${actions}</div>` : ''}</header>`;
}
/** Breadcrumbs shown in the topbar. Call from a page renderer: crumbs([{label, to}, …]). */
function crumbs(list) { S.crumbs = list; return ''; }
function section(title, body, { desc = '', actions = '', id = '' } = {}) {
  return `<section class="section" ${id ? `id="${id}"` : ''}><div class="section__header"><div class="grow"><h2 class="section__title">${esc(title)}</h2>${desc ? `<p class="section__description">${desc}</p>` : ''}</div>${actions ? `<div class="row gap-8">${actions}</div>` : ''}</div>${body}</section>`;
}
/** Settings-style row: label column + controls column. */
function formSection(title, desc, body) { return `<div class="form-section"><div><h3 class="form-section__title">${esc(title)}</h3>${desc ? `<p class="form-section__description">${desc}</p>` : ''}</div><div class="stack">${body}</div></div>`; }
/** Card. Pass title for a header; body is raw HTML. */
function card(body, { title = '', desc = '', actions = '', cls = '', foot = '', icon = '' } = {}) {
  const head = title ? `<div class="card__header">${icon}<div class="grow"><h3 class="card__title">${esc(title)}</h3>${desc ? `<p class="card__description">${desc}</p>` : ''}</div>${actions ? `<div class="row gap-4 none">${actions}</div>` : ''}</div>` : '';
  return `<div class="${cx('card', cls)}">${head}${body}${foot ? `<div class="card__footer">${foot}</div>` : ''}</div>`;
}
/** KPI card (HeroUI CRM). tone colors the icon only. */
function statCard({ icon, label, value, meta = '', tone = '', act, data, extra = '' }) {
  const tag = act ? 'button' : 'div';
  return `<${tag} class="card stat ${act ? 'card--action' : ''}" ${act ? `type="button" data-act="${act}"` : ''} ${dataAttrs(data)}><div class="stat__label"><span class="stat__icon ${tone ? 'stat__icon--' + tone : ''}">${ic(icon, 'i-sm')}</span>${esc(label)}</div><div class="stat__value">${value}</div>${meta ? `<div class="stat__meta">${meta}</div>` : ''}${extra}</${tag}>`;
}
/** List item (ListBox row). act makes the whole row interactive. */
function item({ lead = '', title, titleExtra = '', desc = '', meta = '', trail = '', act, data, href, cls = '', unread }) {
  const inner = `${lead ? `<span class="item__lead">${lead}</span>` : ''}<span class="item__body"><span class="item__title"><span class="truncate">${title}</span>${titleExtra}</span>${desc ? `<span class="item__desc">${desc}</span>` : ''}</span>${meta ? `<span class="item__meta">${meta}</span>` : ''}${trail ? `<span class="item__trail">${trail}</span>` : ''}`;
  const c = cx('item', unread && 'item--unread', cls);
  if (href) return `<a class="${c}" href="#${href}">${inner}</a>`;
  if (act) return `<div class="${c}" role="button" tabindex="0" data-act="${act}" ${dataAttrs(data)}>${inner}</div>`;
  return `<div class="${c}">${inner}</div>`;
}
const list = (items, cls = '') => `<div class="list ${cls}">${items.join('')}</div>`;
function kv(pairs) { return `<dl class="kv">${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`; }
const separator = () => '<hr class="separator">';

/** Alert. tone: default | accent | success | warning | danger. */
function alertBox(tone, title, desc = '', actions = '', { soft = true, icon } = {}) {
  const icn = icon || { default: 'info', accent: 'info', success: 'check-circle', warning: 'alert', danger: 'alert-circle' }[tone];
  return `<div class="${cx('alert', 'alert--' + tone, soft && 'alert--soft')}" role="${tone === 'danger' ? 'alert' : 'status'}"><span class="alert__indicator">${ic(icn)}</span><div class="alert__content">${title ? `<div class="alert__title">${esc(title)}</div>` : ''}${desc ? `<div class="alert__description">${desc}</div>` : ''}</div>${actions ? `<div class="alert__actions">${actions}</div>` : ''}</div>`;
}
function emptyState({ icon = 'inbox', title, desc = '', actions = '', tone = '', boxed = false, compact = false }) {
  return `<div class="${cx('empty-state', boxed && 'empty-state--boxed', compact && 'empty-state--compact')}" role="status"><div class="empty-state__icon ${tone ? 'empty-state__icon--' + tone : ''}">${ic(icon, 'i-lg')}</div><div class="empty-state__title">${esc(title)}</div>${desc ? `<div class="empty-state__description">${desc}</div>` : ''}${actions ? `<div class="empty-state__actions">${actions}</div>` : ''}</div>`;
}
function errorState({ title = 'This didn’t load', desc = 'Check your connection and try again. Nothing was lost.', boxed = true } = {}) {
  return emptyState({ icon: 'alert-circle', tone: 'danger', title, desc: esc(desc), actions: btn('Try again', { icon: 'retry', act: 'retry-load' }), boxed });
}
function skelRows(n = 6) {
  return `<div class="table-root" aria-busy="true" aria-label="Loading"><div class="table__scroll" style="background:var(--surface);margin-top:36px">${Array.from({ length: n }, (_, i) => `<div class="row gap-12" style="padding:14px 16px;${i ? 'border-top:1px solid var(--separator)' : ''}"><span class="skeleton" style="width:32px;height:32px;border-radius:8px"></span><div class="grow stack gap-6"><span class="skeleton skeleton--line" style="width:${30 + (i * 17) % 35}%"></span><span class="skeleton skeleton--line" style="width:${18 + (i * 11) % 20}%;height:10px"></span></div><span class="skeleton skeleton--line hide-sm" style="width:72px"></span></div>`).join('')}</div></div>`;
}
function skelCards(n = 6) { return `<div class="grid cols-3" aria-busy="true">${Array.from({ length: n }, () => `<div class="card"><span class="skeleton" style="width:36px;height:36px;border-radius:10px"></span><span class="skeleton skeleton--line" style="width:60%"></span><span class="skeleton skeleton--line" style="width:85%;height:10px"></span></div>`).join('')}</div>`; }
function progress(value, tone = '', label = 'Progress') { return `<div class="progress-bar ${tone ? 'progress-bar--' + tone : ''}" role="progressbar" aria-label="${esc(label)}" aria-valuenow="${Math.round(value)}" aria-valuemin="0" aria-valuemax="100"><span class="progress-bar__fill" style="width:${Math.max(2, Math.min(100, value))}%"></span></div>`; }

/** Wrap a data region in the prototype page state (live | loading | empty | error). */
function gate({ ok, loading, empty, error }) {
  const st = S.navLoading ? 'loading' : S.pageState;
  if (st === 'loading') return loading ? loading() : skelRows();
  if (st === 'error') return error ? error() : errorState();
  if (st === 'empty' && empty) return empty();
  return ok();
}

/* ── Forms ── */
/** Labelled field. control is the input HTML; error replaces the description. */
function field({ id, label, desc = '', error = '', required, optional, control, counter = '' }) {
  return `<div class="field">${label ? `<label class="label" for="${id}">${esc(label)}${required ? '<span class="label__req" aria-hidden="true">*</span>' : ''}${optional ? '<span class="label__opt">(optional)</span>' : ''}</label>` : ''}${control}${error ? `<div class="field-error" id="${id}-err" role="alert">${ic('alert-circle')}<span>${esc(error)}</span></div>` : (desc || counter) ? `<div class="row between gap-12"><div class="description" id="${id}-desc">${desc}</div>${counter}</div>` : ''}</div>`;
}
/** Text input bound to S.ui by dotted path (data-bind). attrs:'data-live' re-renders on each keystroke. */
function input({ id, bind, value = '', placeholder = '', type = 'text', attrs = '', cls = '', autofocus, onEnter, invalid, size, autocomplete = 'off' }) {
  return `<input class="${cx('input', size && 'input--' + size, cls)}" id="${id}" name="${id}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${bind ? `data-bind="${bind}"` : ''} ${onEnter ? `data-enter="${onEnter}"` : ''} ${autofocus ? 'data-autofocus' : ''} ${invalid ? `aria-invalid="true" aria-describedby="${id}-err"` : ''} autocomplete="${esc(autocomplete)}" ${attrs}>`;
}
function textarea({ id, bind, value = '', placeholder = '', rows = 4, attrs = '', invalid }) {
  return `<textarea class="textarea" id="${id}" name="${id}" rows="${rows}" placeholder="${esc(placeholder)}" ${bind ? `data-bind="${bind}"` : ''} ${invalid ? `aria-invalid="true" aria-describedby="${id}-err"` : ''} ${attrs}>${esc(value)}</textarea>`;
}
/** Native select (HeroUI Select visuals). options: [[value,label],…]. change → A[change](el). */
function select({ id, bind, value, options, attrs = '', cls = '', change, size, label }) {
  return `<select class="${cx('select', size && 'select--' + size, cls)}" id="${id}" ${bind ? `data-bind="${bind}"` : ''} ${change ? `data-change="${change}"` : ''} ${label ? `aria-label="${esc(label)}"` : ''} ${attrs}>${options.map(o => { const [v, l] = Array.isArray(o) ? o : [o.value, o.label]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`;
}
function switchCtl({ id, on, act, data, disabled, label }) {
  return `<button type="button" role="switch" class="switch" ${id ? `id="${id}"` : ''} aria-checked="${!!on}" ${label ? `aria-label="${esc(label)}"` : ''} ${act ? `data-act="${act}"` : ''} ${dataAttrs(data)} ${disabled ? 'disabled' : ''}></button>`;
}
/** Label + description on the left, switch on the right. */
function switchRow({ title, desc = '', ...o }) { return `<div class="switch-row"><div class="grow"><div class="medium">${esc(title)}</div>${desc ? `<div class="description mt-4">${desc}</div>` : ''}</div>${switchCtl({ label: title, ...o })}</div>`; }
function checkbox({ id, label = '', checked, act, data, bind, aria, indeterminate, disabled }) {
  return `<label class="checkbox"><input type="checkbox" ${id ? `id="${id}"` : ''} ${checked ? 'checked' : ''} ${indeterminate ? 'data-indeterminate' : ''} ${act ? `data-act="${act}"` : ''} ${bind ? `data-bind="${bind}"` : ''} ${dataAttrs(data)} ${aria ? `aria-label="${esc(aria)}"` : ''} ${disabled ? 'disabled' : ''}><span class="checkbox__control">${ic('check')}</span>${label ? `<span class="checkbox__label">${label}</span>` : ''}</label>`;
}
/** Radio cards: options [[value, title, desc], …]. Selecting fires A[act] with data-value. */
function choiceGroup({ name, value, options, act, data, cols = 1 }) {
  return `<div class="choice-group" role="radiogroup" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${options.map(([v, t, d]) => `<label class="choice"><input type="radio" name="${name}" value="${esc(v)}" ${String(v) === String(value) ? 'checked' : ''} data-change="${act}" data-value="${esc(v)}" ${dataAttrs(data)}><span class="radio__control" aria-hidden="true"></span><span class="grow"><span class="choice__title">${esc(t)}</span>${d ? `<span class="choice__desc" style="display:block">${d}</span>` : ''}</span></label>`).join('')}</div>`;
}
/** Segmented toggle (HeroUI ToggleButtonGroup). options: [[value,label],…]. */
function seg({ value, options, act, data, label = '', full }) {
  return `<div class="toggle-group ${full ? 'toggle-group--full' : ''}" role="group" ${label ? `aria-label="${esc(label)}"` : ''}>${options.map(o => { const [v, l, icon] = Array.isArray(o) ? o : [o, o]; return `<button type="button" aria-pressed="${String(v) === String(value)}" data-act="${act}" data-value="${esc(v)}" ${dataAttrs(data)}>${icon ? ic(icon, 'i-sm') : ''}${esc(l)}</button>`; }).join('')}</div>`;
}
/** Color swatch picker (HeroUI ColorSwatchPicker). options: [[value, label, cssColor], …]; fires A[act] with data-value. */
function swatchPicker({ value, options, act, label = '', labelled = false }) {
  return `<div class="color-swatch-picker ${labelled ? 'color-swatch-picker--labelled' : ''}" role="radiogroup" ${label ? `aria-label="${esc(label)}"` : ''}>${options.map(([v, l, color]) => {
    const on = String(v) === String(value);
    const sw = `<button type="button" role="radio" class="color-swatch-picker__item" aria-checked="${on}" aria-label="${esc(l)}" ${labelled ? '' : `data-tip="${esc(l)}"`} data-act="${act}" data-value="${esc(v)}"><span class="color-swatch-picker__swatch" style="background:${color}"></span>${on ? `<span class="color-swatch-picker__indicator">${ic('check')}</span>` : ''}</button>`;
    return labelled ? `<span class="color-swatch-picker__option">${sw}<span>${esc(l)}</span></span>` : sw;
  }).join('')}</div>`;
}
/** Tabs as links (deep-linkable `base?tab=id`). variant: primary (pill) | secondary (underline). */
function tabs(items, active, base, { variant = 'secondary', act } = {}) {
  return `<nav class="tabs ${variant === 'secondary' ? 'tabs--secondary' : ''}" aria-label="Sections"><div class="tabs__list" role="tablist">${items.map(t => {
    const sel = t.id === active;
    const inner = `${t.icon ? ic(t.icon, 'i-sm') : ''}${esc(t.label)}${t.count != null && t.count !== '' ? `<span class="${t.alert ? 'badge badge--accent' : 'tabs__count'}">${fmtNum(t.count)}</span>` : ''}`;
    return act ? `<button type="button" role="tab" class="tabs__tab" aria-selected="${sel}" data-act="${act}" data-value="${t.id}">${inner}</button>`
      : `<a role="tab" class="tabs__tab" href="#${base}?tab=${t.id}" aria-selected="${sel}">${inner}</a>`;
  }).join('')}</div></nav>`;
}

/* ── Collections: search, filters, sort, select, paging ── */
function searchField({ uiKey, placeholder = 'Search', id }) {
  const q = ui(uiKey).q || ''; id = id || uiKey + '-q';
  return `<div class="search-field">${ic('search')}<input class="input input--sm" id="${id}" type="search" placeholder="${esc(placeholder)}" value="${esc(q)}" data-input="ui-q" data-ui="${uiKey}" aria-label="${esc(placeholder)}" autocomplete="off">${q ? `<span class="search-field__clear">${iconBtn('x', 'Clear search', { size: 'sm', act: 'ui-clear-q', data: { ui: uiKey } })}</span>` : ''}</div>`;
}
/** Single-select filter (dropdown). options: [[value,label],…]; '' = any. */
function filterButton(label, uiKey, fieldName, options) {
  const v = ui(uiKey)[fieldName] || ''; const cur = options.find(o => o[0] === v);
  return `<button type="button" class="${cx('filter-button', v && 'is-set')}" data-menu="filter" data-ui="${uiKey}" data-field="${fieldName}" data-opts="${esc(JSON.stringify(options))}" data-label="${esc(label)}" aria-haspopup="menu" aria-expanded="false">${v ? '' : ic('filter')}${esc(label)}${v ? `: ${esc(cur?.[1] || v)}` : ''}${ic('chevron-down')}</button>`;
}
function clearFilters(uiKey, fields) { const u = ui(uiKey); return fields.some(f => u[f]) || u.q ? btn('Clear', { v: 'ghost', size: 'sm', act: 'ui-clear', data: { ui: uiKey, fields: fields.join(',') } }) : ''; }
function matchesQ(uiKey, ...texts) { const q = (ui(uiKey).q || '').trim().toLowerCase(); return !q || texts.some(t => String(t ?? '').toLowerCase().includes(q)); }
function sortHead(label, key, uiKey, cls = '') {
  const s = ui(uiKey).sort; const dir = s?.key === key ? s.dir : null;
  return `<th class="table__column ${cls}" ${dir ? `aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button" class="table__sort" data-act="sort" data-ui="${uiKey}" data-key="${key}">${esc(label)}${ic(dir === 'asc' ? 'arrow-up' : dir === 'desc' ? 'arrow-down' : 'chevrons')}</button></th>`;
}
const th = (label, cls = '') => `<th class="table__column ${cls}">${label}</th>`;
function applySort(rows, uiKey, getters = {}) {
  const s = ui(uiKey).sort; if (!s) return rows;
  const g = getters[s.key] || (r => r[s.key]);
  return [...rows].sort((a, b) => { const x = g(a), y = g(b); const c = typeof x === 'string' ? x.localeCompare(y) : (x ?? 0) - (y ?? 0); return s.dir === 'asc' ? c : -c; });
}
/** Table shell. head: <th> cells HTML; rows: <tr class="table__row"> HTML. stack: card rows on narrow widths. */
function table({ head, rows, stack = true, foot = '', label = '' }) {
  return `<div class="${cx('table-root', stack && 'table--stack')}"><div class="table__scroll"><table class="table__content" ${label ? `aria-label="${esc(label)}"` : ''}><thead class="table__head"><tr>${head}</tr></thead><tbody class="table__body">${rows.join('')}</tbody></table></div></div>${foot}`;
}
const selCount = uiKey => Object.values(ui(uiKey).sel || {}).filter(Boolean).length;
const selIds = uiKey => Object.entries(ui(uiKey).sel || {}).filter(([, v]) => v).map(([k]) => k);
function selCheck(uiKey, id, label = 'Select row') { return `<td class="table__cell table__cell--check">${checkbox({ checked: !!ui(uiKey).sel?.[id], act: 'sel-toggle', data: { ui: uiKey, id }, aria: label })}</td>`; }
function selAllCheck(uiKey, ids) { const n = ids.filter(id => ui(uiKey).sel?.[id]).length; return `<th class="table__column table__column--check">${checkbox({ checked: n && n === ids.length, indeterminate: n && n < ids.length, act: 'sel-all', data: { ui: uiKey, ids: ids.join(',') }, aria: 'Select all' })}</th>`; }
/** Floating bulk-action bar; render when selCount(uiKey) > 0. */
function bulkBar(uiKey, actions) { const n = selCount(uiKey); return n ? `<div class="bulk-bar" role="toolbar" aria-label="Bulk actions"><span class="bulk-bar__count">${n} selected</span>${actions}${iconBtn('x', 'Clear selection', { size: 'sm', act: 'sel-clear', data: { ui: uiKey }, cls: 'button--ghost' })}</div>` : ''; }
function paginate(rows, uiKey, per = 20) { const u = ui(uiKey); const pages = Math.max(1, Math.ceil(rows.length / per)); u.page = Math.min(u.page || 1, pages); return rows.slice((u.page - 1) * per, u.page * per); }
function pager(total, uiKey, per = 20) {
  const p = ui(uiKey).page || 1; const pages = Math.ceil(total / per);
  const range = total ? `${fmtNum((p - 1) * per + 1)}–${fmtNum(Math.min(total, p * per))} of ${fmtNum(total)}` : '0 results';
  return `<div class="table-foot"><span class="num">${range}</span>${pages > 1 ? `<div class="pagination">${btn('', { v: 'ghost', size: 'sm', icon: 'chevron-left', tip: 'Previous page', act: 'ui-page', data: { ui: uiKey, page: p - 1 }, disabled: p <= 1 })}${btn('', { v: 'ghost', size: 'sm', icon: 'chevron-right', tip: 'Next page', act: 'ui-page', data: { ui: uiKey, page: p + 1 }, disabled: p >= pages })}</div>` : ''}</div>`;
}
/** Empty result for a filtered collection, with a clear action. */
function noMatches(uiKey, fields, what = 'items') { return emptyState({ icon: 'search', title: `No ${what} match`, desc: 'Try another word or clear the filters.', actions: btn('Clear filters', { act: 'ui-clear', data: { ui: uiKey, fields: fields.join(',') } }), boxed: true, compact: true }); }

/* ── Charts (inline SVG, theme-aware) ── */
function bars(values, { height = 120, labels = [], fmt = fmtNum, highlightLast = true } = {}) {
  const max = Math.max(...values, 1), w = 100 / values.length;
  return `<svg class="chart" viewBox="0 0 100 ${height}" preserveAspectRatio="none" height="${height}" role="img" aria-label="Bar chart">${values.map((v, i) => { const h = Math.max(1.5, (v / max) * (height - 4)); const hi = highlightLast ? i === values.length - 1 : true; return `<rect x="${i * w + w * 0.18}" y="${height - h}" width="${w * 0.64}" height="${h}" rx="0.8" fill="${hi ? 'var(--accent)' : 'color-mix(in oklab, var(--accent) 35%, transparent)'}"><title>${esc(labels[i] || '')} ${fmt(v)}</title></rect>`; }).join('')}</svg>`;
}
function sparkline(values, { height = 36, tone = 'accent' } = {}) {
  const max = Math.max(...values, 1), min = Math.min(...values, 0), n = values.length;
  const pts = values.map((v, i) => [(i / Math.max(1, n - 1)) * 100, height - 2 - ((v - min) / Math.max(1, max - min)) * (height - 4)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' ');
  const color = `var(--${tone === 'accent' ? 'accent' : tone})`;
  return `<svg class="chart" viewBox="0 0 100 ${height}" preserveAspectRatio="none" height="${height}" aria-hidden="true"><path d="${d} L100 ${height} L0 ${height} Z" fill="color-mix(in oklab, ${color} 12%, transparent)"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`;
}

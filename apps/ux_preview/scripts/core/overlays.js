'use strict';
/* Overlays: modal, drawer, popover, dropdown menu, toast, command palette,
   tooltip, confirm. All render into #layer from state (S.modal, S.drawer,
   S.popover, S.menu, S.palette), so a full re-render never loses an open
   overlay. Toasts live in their own persistent live region (#toasts).

   M[name](props)  → { title, desc, icon, head, body, foot, footStart, size: sm|md|lg|xl|preview, guard, after(dialogEl) } — after runs once the dialog is in the DOM (highlighting, scrolling)
   DR[name](props) → { title, desc, lead, headActions, body, foot, footStart, size: md|lg|xl }
   PO[name](triggerEl) → { title?, body, foot?, width? } — inline filters and small pickers (trigger: data-popover="name")
   MENUS[name](triggerEl) → [{ label, icon, meta, danger, checked, disabled, run } | { section } | { sep: true }] */

function renderLayer(fromRender) {
  const snap = fromRender ? null : snapshotFocus('#layer');
  let h = '', after = null;
  if (S.drawer) {
    const d = DR[S.drawer.name]?.(S.drawer.props || {}) || { title: 'Missing panel', body: '' };
    h += `<div class="${cx('backdrop', d.clear && 'backdrop--clear')}" data-act="close-drawer" data-anim="drawer-bd"></div><aside class="${cx('drawer__dialog', d.size && d.size !== 'md' && 'drawer__dialog--' + d.size)}" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-anim="drawer:${S.drawer.name}">
      <header class="drawer__header">${d.lead || ''}<div class="grow"><h2 class="drawer__heading" id="drawer-title">${esc(d.title)}</h2>${d.desc ? `<p class="drawer__description">${d.desc}</p>` : ''}</div><div class="drawer__header-actions">${d.headActions || ''}${iconBtn('x', 'Close', { act: 'close-drawer' })}</div></header>
      <div class="drawer__body" id="drawer-body" data-keep-scroll>${d.body}</div>${d.foot || d.footStart ? `<footer class="drawer__footer">${d.footStart ? `<div class="drawer__footer-start row gap-8">${d.footStart}</div>` : ''}${d.foot || ''}</footer>` : ''}</aside>`;
  }
  if (S.modal) {
    const m = M[S.modal.name]?.(S.modal.props || {}) || { title: 'Missing dialog', body: '' };
    S.modal.guard = !!(m.guard || S.modal.props?.guard); after = m.after || null;
    // icon: an icon name (or ready HTML) shown as a tinted tile; tone: accent (default) · success · warning · danger · default.
    const mIcon = m.icon ? (String(m.icon).includes('<') ? m.icon : ic(m.icon)) : '';
    h += `<div class="backdrop" data-anim="modal-bd"></div><div class="modal__container" data-act="modal-scrim"><div class="${cx('modal__dialog', m.size && m.size !== 'md' && 'modal__dialog--' + m.size)}" role="${m.alert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="modal-title" ${m.desc ? 'aria-describedby="modal-desc"' : ''} data-anim="modal:${S.modal.name}">
      <header class="${cx('modal__header', mIcon && 'modal__header--icon')}">${mIcon ? `<span class="${cx('modal__icon', 'modal__icon--' + (m.tone || 'accent'))}" aria-hidden="true">${mIcon}</span>` : ''}<div class="grow"><h2 class="modal__heading" id="modal-title">${esc(m.title)}</h2>${m.desc ? `<p class="modal__description" id="modal-desc">${m.desc}</p>` : ''}</div>${m.noClose ? '' : `<span class="modal__close">${iconBtn('x', 'Close', { act: m.closeAct || 'close-modal', size: 'sm' })}</span>`}</header>
      ${m.head ? `<div class="modal__head">${m.head}</div>` : ''}
      ${m.body ? `<div class="modal__body" id="modal-body" data-keep-scroll>${m.body}</div>` : '<div style="height:16px"></div>'}${m.foot || m.footStart ? `<footer class="modal__footer">${m.footStart ? `<div class="modal__footer-start row gap-8">${m.footStart}</div>` : ''}${m.foot || ''}</footer>` : ''}</div></div>`;
  }
  if (S.palette) h += paletteHtml();
  if (S.popover) h += popoverHtml();
  if (S.menu) {
    h += `<div class="menu" role="menu" id="menu" data-anim="menu:${S.menu.key}" style="left:${S.menu.x}px;top:${S.menu.y}px">${S.menu.items.map((it, i) =>
      it.sep ? '<div class="menu-separator" role="separator"></div>'
        : it.section ? `<div class="menu-section">${esc(it.section)}</div>`
          : `<button type="button" class="${cx('menu-item', it.danger && 'menu-item--danger')}" role="${it.checked != null ? 'menuitemradio' : 'menuitem'}" ${it.checked != null ? `aria-checked="${!!it.checked}"` : ''} data-mi="${i}" ${it.disabled ? 'disabled' : ''}>${it.html || ((it.icon ? ic(it.icon) : '') + `<span class="grow truncate">${esc(it.label)}</span>` + (it.meta ? `<span class="menu-item__meta">${esc(it.meta)}</span>` : ''))}${it.checked ? `<span class="menu-item__check">${ic('check')}</span>` : ''}</button>`).join('')}</div>`;
  }
  const layer = $('#layer');
  const before = new Set($$('[data-anim]', layer).map(e => e.dataset.anim));
  const focusSnap = snap || snapshotFocus('#layer');
  layer.innerHTML = h;
  $$('[data-anim]', layer).forEach(el => before.has(el.dataset.anim) && el.classList.add('settled'));
  if (S.menu) positionMenu();
  if (S.popover) positionPopover();
  restoreFocus(focusSnap, '#layer');
  if (after) after($('#layer .modal__dialog'));
}
function snapshotFocus(scope) {
  const root = $(scope), a = document.activeElement;
  const inside = a && root?.contains(a);
  const s = { id: inside ? a.id : null, scroll: {} };
  // Controls without an id (checkbox rows in option lists, chips…) are found again by their action + data key.
  if (inside && !a.id && a.dataset?.act) s.key = ['act', 'id', 'value'].filter(k => a.dataset[k] != null).map(k => `[data-${k}="${CSS.escape(a.dataset[k])}"]`).join('');
  try { if (s.id && a.selectionStart != null) { s.s = a.selectionStart; s.e = a.selectionEnd; } } catch (_) { }
  $$('[data-keep-scroll]', root || document).forEach(el => { if (el.id) s.scroll[el.id] = el.scrollTop; });
  s.lists = $$('.option-list', root || document).map(el => el.scrollTop);
  return s;
}
function restoreFocus(s, scope) {
  for (const [id, top] of Object.entries(s.scroll || {})) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
  $$(`${scope} .option-list`).forEach((el, i) => { if (s.lists?.[i]) el.scrollTop = s.lists[i]; });
  if (s.id) {
    const el = document.getElementById(s.id);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      // email/number inputs have no selection API: re-assign the value so the caret lands at the end.
      try { if (s.s != null) el.setSelectionRange(s.s, s.e); else if ('value' in el && el.tagName === 'INPUT') { const v = el.value; el.value = ''; el.value = v; } } catch (_) { }
    }
  } else if (s.key) $(`${scope} ${s.key}`)?.focus({ preventScroll: true });
  $$(`${scope} input[data-indeterminate]`).forEach(el => (el.indeterminate = true));
}
function frameRect() { return $('#frame').getBoundingClientRect(); }
function positionMenu() {
  const m = $('#menu'); if (!m) return; const fr = frameRect(); const r = m.getBoundingClientRect();
  if (r.right > fr.right - 8) m.style.left = Math.max(8, S.menu.anchorRight - r.width) + 'px';
  if (r.bottom > fr.bottom - 8) m.style.top = Math.max(8, S.menu.anchorTop - r.height - 6) + 'px';
}
function focusFirst(sel) {
  requestAnimationFrame(() => {
    const root = $(sel); if (!root) return;
    // Fallback: the dialog itself (not its first button), so a drawer without fields doesn't open with the Close tooltip showing.
    const t = root.querySelector('[data-autofocus]') || root.querySelector('.modal__body input:not([type=hidden]):not([disabled]):not([readonly]):not([type=checkbox]):not([type=radio]),.modal__body textarea,.drawer__body input:not([type=checkbox]):not([type=radio]):not([disabled]):not([readonly])') || root.querySelector('.modal__footer .button--primary:not(:disabled),.modal__footer .button--danger:not(:disabled)') || root.querySelector('.modal__body button:not(:disabled),.modal__body input:not(:disabled)');
    if (t) t.focus(); else { root.setAttribute('tabindex', '-1'); root.focus({ preventScroll: true }); }
  });
}

/* ── Modal / drawer API (focus returns to the trigger on close) ── */
let _returnFocus = null;
function openModal(name, props = {}) { if (!S.modal && !S.drawer) _returnFocus = document.activeElement; S.menu = null; S.modal = { name, props }; renderLayer(); focusFirst('#layer .modal__dialog'); }
function closeModal() { S.modal = null; renderLayer(); if (!S.drawer) returnFocus(); else focusFirst('#layer .drawer__dialog'); }
function openDrawer(name, props = {}) { if (!S.modal && !S.drawer) _returnFocus = document.activeElement; S.menu = null; S.drawer = { name, props }; renderLayer(); focusFirst('#layer .drawer__dialog'); }
function closeDrawer() { S.drawer = null; renderLayer(); returnFocus(); }
function returnFocus() { const t = _returnFocus; _returnFocus = null; if (t && document.body.contains(t)) t.focus({ preventScroll: true }); }
const refreshLayer = () => renderLayer();

/* ── Toast: toast(msg, { tone: success|danger|accent, action: { label, run }, duration }) ──
   One persistent polite live region (#toasts, outside #layer) whose children are added and removed individually, so screen
   readers announce each message once. Timers pause while the pointer or focus is in the region (Undo never vanishes mid-reach). */
let _toastN = 0, _toastPaused = false;
function toastRegion() {
  let r = $('#toasts'); if (r) return r;
  r = document.createElement('div'); r.id = 'toasts'; r.className = 'toast-region'; r.setAttribute('role', 'status'); r.setAttribute('aria-live', 'polite');
  const pause = on => { _toastPaused = on; S.toasts.forEach(t => (on ? toastStop(t) : toastStart(t))); };
  r.addEventListener('pointerenter', () => pause(true)); r.addEventListener('pointerleave', () => !r.contains(document.activeElement) && pause(false));
  r.addEventListener('focusin', () => pause(true)); r.addEventListener('focusout', e => !r.contains(e.relatedTarget) && !r.matches(':hover') && pause(false));
  ($('#frame') || document.body).append(r); return r;
}
function toastStart(t) { clearTimeout(t.timer); t.started = Date.now(); t.timer = setTimeout(() => dismissToast(t.id), t.left); }
function toastStop(t) { clearTimeout(t.timer); if (t.started) t.left = Math.max(1500, t.left - (Date.now() - t.started)); t.started = 0; }
function toast(msg, o = {}) {
  const t = { id: 't' + (++_toastN), msg, tone: o.tone || 'success', action: o.action, left: o.duration || (o.action ? 8000 : 4000) };
  const region = toastRegion();
  while (S.toasts.length >= 3) dismissToast(S.toasts[0].id);
  S.toasts.push(t);
  const el = document.createElement('div'); el.className = 'toast'; el.id = 'toast-' + t.id;
  el.innerHTML = `${ic(t.tone === 'danger' ? 'alert-circle' : t.tone === 'accent' ? 'info' : 'check-circle', 'toast__icon--' + t.tone)}<span class="toast__message">${esc(msg)}</span>${t.action ? btn(t.action.label, { v: 'ghost', size: 'sm', act: 'toast-action', data: { id: t.id }, cls: 'toast__action' }) : ''}${iconBtn('x', 'Dismiss', { size: 'sm', act: 'toast-close', data: { id: t.id } })}`;
  region.append(el);
  if (!_toastPaused) toastStart(t);
}
function dismissToast(id) {
  const t = S.toasts.find(x => x.id === id); if (!t) return;
  clearTimeout(t.timer); S.toasts = S.toasts.filter(x => x !== t);
  const el = document.getElementById('toast-' + id); if (!el) return;
  const had = el.contains(document.activeElement);
  el.remove();
  if (!S.toasts.length) _toastPaused = false;
  if (had) ($('#main') || document.body).focus?.({ preventScroll: true });
}

/* ── Confirm: confirmAction({ title, body, confirm, danger, typeText, onConfirm, delay }) ──
   The primary stays enabled; with typeText, pressing it before the text matches shows an inline error instead. */
function confirmAction(p) { setPath('confirm.text', ''); setPath('confirm.err', ''); openModal('confirm', p); }
M.confirm = p => {
  const typed = getPath('confirm.text') || '', err = getPath('confirm.err') || '';
  return {
    size: 'sm', title: p.title, alert: !!p.danger, icon: p.icon || (p.danger ? 'alert' : 'help'), tone: p.danger ? 'danger' : 'accent',
    body: `${p.body ? `<p class="muted">${p.body}</p>` : ''}${p.typeText ? `<div class="mt-16">${field({ id: 'confirm-text', label: `Type ${p.typeText} to confirm`, error: err, control: input({ id: 'confirm-text', bind: 'confirm.text', value: typed, autofocus: true, onEnter: 'confirm-ok', invalid: !!err, attrs: 'data-input="confirm-typed"', cls: 'mono' }) })}</div>` : ''}`,
    foot: btn('Cancel', { v: 'ghost', act: 'close-modal' }) + btn(p.confirm || 'Confirm', { v: p.danger ? 'danger' : 'primary', act: 'confirm-ok', loading: p.busy, id: 'confirm-ok' }),
  };
};
/* Clear the error as soon as the text matches (no re-render per keystroke otherwise, so the caret never jumps). */
A['confirm-typed'] = el => { if (getPath('confirm.err') && el.value === S.modal?.props?.typeText) { setPath('confirm.err', ''); refreshLayer(); } };
A['confirm-ok'] = async () => {
  const p = S.modal.props; if (p.busy) return;
  if (p.typeText && (getPath('confirm.text') || '') !== p.typeText) { setPath('confirm.err', `Type ${p.typeText} exactly to confirm.`); refreshLayer(); $('#confirm-text')?.focus(); return; }
  p.busy = true; refreshLayer(); await sleep(p.delay ?? 500); S.modal = null; renderLayer(); returnFocus(); await p.onConfirm?.();
};

/* ── Popover: PO[name](trigger) → { title?, body, foot?, width? } ──
   For inline filters and small pickers that stay open while you work in them (checkbox toggles call refreshLayer() or
   refresh()). Trigger: <button data-popover="name" data-…>. The open popover is re-anchored to its trigger after every
   render — found again by data-popover plus the same data-* values — and closes on outside click, Escape (focus returns
   to the trigger) or navigation. On phones (#frame < 680 px) it renders as a bottom sheet with a Done button. */
const isPhone = () => ($('#frame')?.clientWidth || innerWidth) < 680;
function popoverSel(el) {
  return Object.entries(el.dataset).filter(([k]) => !['tip', 'tipSide'].includes(k)).map(([k, v]) => `[data-${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}="${CSS.escape(v)}"]`).join('');
}
function popoverTrigger() { const p = S.popover; if (!p) return null; const t = p.trigger; if (t?.isConnected) return t; p.trigger = $(p.sel) || null; return p.trigger; }
function openPopover(trigger) {
  S.menu = null; tipHide();
  S.popover = { name: trigger.dataset.popover, sel: popoverSel(trigger), trigger };
  renderLayer();
  requestAnimationFrame(() => { const r = $('#popover'); (r?.querySelector('[data-autofocus],input:not([type=checkbox]):not([type=radio]),button:not(.popover__close),input,select') || r)?.focus({ preventScroll: true }); });
}
function closePopover(refocus = true) {
  const t = popoverTrigger(); S.popover = null; renderLayer();
  $$('[aria-haspopup="dialog"][aria-expanded="true"]').forEach(x => x.setAttribute('aria-expanded', 'false'));
  if (refocus && t?.isConnected) t.focus({ preventScroll: true });
}
function popoverHtml() {
  const t = popoverTrigger(), def = t && PO[S.popover.name]?.(t);
  if (!def) { S.popover = null; return ''; }
  t.setAttribute('aria-expanded', 'true');
  const sheet = isPhone();
  const head = def.title || sheet ? `<div class="popover__header"><h2 class="popover__title" id="popover-title">${esc(def.title || '')}</h2>${sheet ? '' : iconBtn('x', 'Close', { size: 'sm', act: 'popover-close', cls: 'popover__close' })}</div>` : '';
  const foot = def.foot || sheet ? `<div class="popover__footer">${def.foot || ''}${sheet ? btn('Done', { v: 'primary', act: 'popover-close', cls: 'popover__done' }) : ''}</div>` : '';
  return `${sheet ? '<div class="backdrop" data-act="popover-close" data-anim="popover-bd"></div>' : ''}<div class="${cx('popover', sheet && 'popover--sheet')}" id="popover" role="dialog" ${def.title ? 'aria-labelledby="popover-title"' : `aria-label="${esc(t.getAttribute('aria-label') || t.textContent.trim())}"`} tabindex="-1" data-anim="popover:${S.popover.name}" style="${def.width && !sheet ? `width:${def.width}px` : ''}">${head}<div class="popover__body" id="popover-body" data-keep-scroll>${def.body}</div>${foot}</div>`;
}
function positionPopover() {
  const el = $('#popover'), t = popoverTrigger(); if (!el || !t || el.classList.contains('popover--sheet')) return;
  const fr = frameRect(), r = t.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  let x = r.left - fr.left, y = r.bottom - fr.top + 6;
  if (x + w > fr.width - 8) x = Math.max(8, r.right - fr.left - w);
  if (y + h > fr.height - 8 && r.top - fr.top - h - 6 > 8) y = r.top - fr.top - h - 6;
  el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px';
}
A['popover-close'] = () => closePopover(true);

/* ── Menus ── */
function openMenu(trigger, items, key) {
  const fr = frameRect(); const r = trigger.getBoundingClientRect();
  S.menu = { key: key || 'm', items, x: r.left - fr.left, y: r.bottom - fr.top + 4, anchorRight: r.right - fr.left, anchorTop: r.top - fr.top, trigger };
  trigger.setAttribute('aria-expanded', 'true');
  renderLayer(); requestAnimationFrame(() => $('#menu .menu-item:not([disabled])')?.focus());
}
function closeMenu(refocus) { const t = S.menu?.trigger; S.menu = null; renderLayer(); t?.setAttribute('aria-expanded', 'false'); if (refocus && t && document.body.contains(t)) t.focus(); }
MENUS.filter = el => {
  const { ui: uiKey, field: f } = el.dataset; const opts = JSON.parse(el.dataset.opts); const v = ui(uiKey)[f] || '';
  return [{ label: 'Any ' + el.dataset.label.toLowerCase(), checked: !v, run: () => { ui(uiKey)[f] = ''; ui(uiKey).page = 1; refresh(); } }, { sep: true },
    ...opts.map(([val, label]) => ({ label, checked: v === val, run: () => { ui(uiKey)[f] = val; ui(uiKey).page = 1; refresh(); } }))];
};

/* ── Command palette: one search for everything the caller may open ──
   Same vocabulary and Enter default as Home's box: an exact page or action match ranks first; then "Search documents" leads,
   unless the text reads like a question (isQuestion), when "Ask AI" does. Empty: pages that aren't in the sidebar first. */
function paletteResults(raw) {
  const q = raw.trim(), fq = fold(q), out = [];
  const add = (group, items) => items.length && out.push({ group, items });
  const m = s => !q || fold(s).includes(fq);
  /** Word-start match on the label or its translation ("inb" → Inbox, "dark" → Switch to dark mode). */
  const strong = s => !!q && [s, tr(s) || ''].some(x => (' ' + fold(x)).includes(' ' + fq));
  if (S.cur.r.mode === 'platform') {
    add('Workspaces', D.pWorkspaces.filter(w => m(w.name)).slice(0, 6).map(w => ({ label: w.name, icon: 'building', meta: plural(w.members, 'member'), run: () => goThen('/p/workspaces', () => A['pws-open']?.({ dataset: { id: w.id } })) })));
    add('Users', q ? D.pUsers.filter(u => m(u.name) || m(u.email)).slice(0, 5).map(u => ({ label: u.name, icon: 'user', meta: u.email, run: () => goThen('/p/users', () => A['pu-open']?.({ dataset: { id: u.id } })) })) : []);
    add('Go to', PLATFORM_NAV.filter(n => m(n.label)).map(n => ({ label: n.label, icon: n.icon, run: () => go(n.to) })));
    return out;
  }
  const unread = X.inboxUnread?.() || 0;
  // Off-sidebar destinations lead (Inbox, All conversations), then the sidebar's own pages.
  const pages = [...MORE_PAGES.map(p => (p.to === '/inbox' && unread ? { ...p, meta: `${unread} unread` } : p)), ...memberNav(), ...(hasModule('spaces') ? [{ label: 'Spaces', to: '/spaces', icon: 'layers' }] : []), ...MANAGE_NAV.filter(n => (n.show ? n.show() : can(n.perm))), ...(isOperator() ? [{ label: 'Platform console', to: '/p/workspaces', icon: 'layers' }] : [])].filter(n => n.to);
  const goTo = pages.filter(p => m(p.label) || m(tr(p.label) || '')).sort((a, b) => strong(b.label) - strong(a.label)).slice(0, q ? 6 : 4).map(p => ({ label: p.label, icon: p.icon, meta: p.meta, run: () => go(p.to), hit: strong(p.label) }));
  const actions = [
    { label: 'New chat', icon: 'message-plus', run: () => go('/chat') },
    canContribute() && { label: 'Contribute a document', icon: 'upload', run: () => A['contribute']?.() },
    { label: 'New collection', icon: 'list-plus', run: () => A['col-new']?.() },
    can('knowledge.manage') && { label: 'Create knowledge base', icon: 'book', run: () => goThen('/bases', () => A['kb-create']?.()) },
    isAdmin() && X.homeFeatured && { label: 'Edit featured documents', icon: 'sliders', run: () => X.homeFeatured() },
    can('source.manage') && { label: 'Connect a source', icon: 'plug', run: () => goThen('/sources', () => A['src-connect']?.()) },
    can('user.manage') && { label: 'Add people', icon: 'user-plus', run: () => goThen('/people', () => A['member-add']?.()) },
    { label: resolvedTheme() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', icon: resolvedTheme() === 'dark' ? 'sun' : 'moon', run: () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark') },
    { label: 'Appearance', icon: 'palette', meta: themeLabel(), run: () => X.appearance.open() },
    { label: S.lang === 'vi' ? 'Switch to English' : 'Switch to Vietnamese (Tiếng Việt)', icon: 'globe', run: () => X.lang.change(S.lang === 'vi' ? 'en' : 'vi') },
  ].filter(Boolean).filter(a => m(a.label) || m(tr(a.label) || '')).map(a => ({ ...a, hit: strong(a.label) }));
  if (!q) {
    add('Go to', goTo);
    add('Recent conversations', myConvs().sort((a, b) => b.at - a.at).slice(0, 3).map(c => ({ label: c.title, icon: 'message', meta: rel(c.at), run: () => go('/chat/' + c.id) })));
    add('Actions', actions.slice(0, 4));
    return out;
  }
  const question = isQuestion(q);
  const hits = question ? [] : [...goTo, ...actions].filter(x => x.hit).slice(0, 3);
  add('Best match', hits);
  const search = { label: `Search documents for “${q}”`, icon: 'search', meta: 'Knowledge', run: () => go(catalogHref({ q })) };
  const ask = { label: `Ask AI “${q}”`, icon: 'sparkles', meta: 'Answer with sources', run: () => A['chat-ask']?.({ dataset: { q } }) };
  add('Search or ask', question ? [ask, search] : [search, ask]);
  add('Documents', catalogSearch(parseCatalogQuery({ q })).rows.slice(0, 5).map(({ doc: d }) => ({ label: bareName(d.name), icon: kindMeta(res(d).kind).icon, meta: kbById(d.kb)?.name || '', run: () => go('/doc/' + d.id + '?q=' + encodeURIComponent(q)) })));
  add('Conversations', myConvs().filter(c => m(c.title)).slice(0, 4).map(c => ({ label: c.title, icon: 'message', meta: rel(c.at), run: () => go('/chat/' + c.id) })));
  add('Collections', visibleCollections().filter(c => m(c.name)).slice(0, 3).map(c => ({ label: c.name, icon: 'list', meta: plural(c.items.length, 'item'), run: () => go('/knowledge/collections/' + c.id) })));
  // A base opens its documents in Knowledge; a locked one asks for access.
  add('Knowledge bases', visibleKbs().filter(k => m(k.name)).slice(0, 4).map(k => ({ label: k.name, icon: k.personal ? 'user' : kbRole(k) === 'none' ? 'lock' : 'book', meta: kbRole(k) === 'none' ? 'Request access' : plural(docsIn(k.id).length, 'document'), run: () => (kbRole(k) === 'none' ? A['kb-request']?.({ dataset: { kb: k.id } }) : go(kbHref(k))) })));
  if (hasModule('spaces')) add('Spaces', visibleSpaces().filter(s => m(s.name) || m(s.code || '')).slice(0, 5).map(s => ({ label: s.name, icon: spaceType(s.type).icon, meta: [s.code, spaceType(s.type).label].filter(Boolean).join(' · '), run: () => go('/space/' + s.id) })));
  if (hasModule('work')) add('Work', (D.works || []).filter(w => (w.owner === me().id || w.visibility === 'space' && spaceRole(spaceById(w.space))) && m(w.title)).slice(0, 4).map(w => ({ label: w.title, icon: WORKFLOWS[w.workflow]?.icon || 'sparkles', meta: spaceById(w.space)?.name || '', run: () => go('/work/' + w.id) })));
  if (can('user.manage')) add('People', D.members.filter(p => m(p.name) || m(p.email)).slice(0, 4).map(p => ({ label: p.name, icon: 'user', meta: roleById(p.roleId)?.name, run: () => goThen('/people', () => A['member-open']?.({ dataset: { id: p.id } })) })));
  add('Go to', goTo.filter(x => !hits.includes(x)));
  add('Actions', actions.filter(x => !hits.includes(x)));
  add('More', [{ label: `See all results for “${q}”`, icon: 'list', run: () => go('/search?q=' + encodeURIComponent(q)) }]);
  return out;
}
/** Touch devices and phones get a full-screen palette with a Cancel button and no keyboard hints. */
const coarse = () => matchMedia('(hover: none), (pointer: coarse)').matches || isPhone();
function paletteHtml() {
  const p = S.palette; const groups = paletteResults(p.q); let n = 0; const flat = [];
  p.sel = Math.min(p.sel, Math.max(0, groups.reduce((a, g) => a + g.items.length, 0) - 1));
  const listHtml = groups.map(g => `<div class="palette__group" role="presentation">${esc(g.group)}</div>` + g.items.map(it => { const i = n++; flat.push(it); return `<button type="button" class="palette__item" role="option" id="pi-${i}" aria-selected="${i === p.sel}" data-pi="${i}">${ic(it.icon)}<span class="grow truncate">${esc(it.label)}</span>${it.meta ? `<span class="palette__item-meta truncate">${esc(it.meta)}</span>` : ''}${i === p.sel ? kbd('↵') : ''}</button>`; }).join('')).join('');
  p.flat = flat;
  const touch = coarse();
  const ph = S.cur.r.mode === 'platform' ? 'Search workspaces, users, pages…' : 'Search, ask or go to…';
  return `<div class="backdrop" data-act="palette-close" data-anim="palette-bd"></div><div class="${cx('palette', touch && 'palette--touch')}" role="dialog" aria-modal="true" aria-label="Search" data-anim="palette"><div class="palette__input">${ic('search', 'i-lg')}<input id="palette-q" type="search" placeholder="${ph}" value="${esc(p.q)}" autocomplete="off" enterkeyhint="go" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant="pi-${p.sel}">${touch ? btn('Cancel', { v: 'ghost', size: 'sm', act: 'palette-close' }) : kbd('Esc')}</div><div class="palette__list" id="palette-list" role="listbox" aria-label="Results">${flat.length ? listHtml : emptyState({ icon: 'search', title: 'No matches', desc: 'Try a different word.', compact: true })}</div><div class="palette__foot"><span>${kbd('↑')} ${kbd('↓')} to move</span><span>${kbd('↵')} to open</span><span>${kbd('Esc')} to close</span></div></div>`;
}
function openPalette(q = '') { S.menu = null; _returnFocus = document.activeElement; S.palette = { q, sel: 0 }; renderLayer(); requestAnimationFrame(() => $('#palette-q')?.focus()); }
function closePalette() { S.palette = null; renderLayer(); returnFocus(); }
A.palette = () => openPalette();
A['palette-close'] = () => closePalette();

/* ── Tooltip (body-level so scroll containers never clip it) ── */
let _tipTrigger = null, _tipTimer = 0;
function tipNode() { let n = $('#tooltip'); if (!n) { n = document.createElement('div'); n.id = 'tooltip'; n.className = 'tooltip'; n.setAttribute('role', 'tooltip'); n.hidden = true; document.body.append(n); } return n; }
function tipHide() { clearTimeout(_tipTimer); if (_tipTrigger?.getAttribute('aria-describedby') === 'tooltip') _tipTrigger.removeAttribute('aria-describedby'); _tipTrigger = null; const n = $('#tooltip'); if (n) { n.classList.remove('is-open'); n.hidden = true; } }
function tipShow(trigger, immediate) {
  const text = (trigger.dataset.tip || '').trim(); if (!text) return;
  tipHide(); _tipTrigger = trigger;
  const paint = () => {
    if (_tipTrigger !== trigger || !trigger.isConnected) return;
    const n = tipNode(); n.textContent = text; n.hidden = false;
    const a = trigger.getBoundingClientRect(), t = n.getBoundingClientRect(), right = trigger.dataset.tipSide === 'right';
    let left = right ? a.right + 8 : a.left + (a.width - t.width) / 2, top = right ? a.top + (a.height - t.height) / 2 : a.top - t.height - 8;
    if (top < 8) top = a.bottom + 8;
    n.style.left = Math.round(Math.min(Math.max(8, left), innerWidth - t.width - 8)) + 'px'; n.style.top = Math.round(top) + 'px';
    if (!trigger.hasAttribute('aria-describedby') && trigger.hasAttribute('aria-label') && trigger.getAttribute('aria-label') !== text) trigger.setAttribute('aria-describedby', 'tooltip');
    requestAnimationFrame(() => n.classList.add('is-open'));
  };
  if (immediate) paint(); else _tipTimer = setTimeout(paint, 350);
}
document.addEventListener('pointerover', e => { const t = e.target.closest?.('[data-tip]'); if (t && t !== _tipTrigger && !(e.relatedTarget && t.contains(e.relatedTarget))) tipShow(t); });
document.addEventListener('pointerout', e => { const t = e.target.closest?.('[data-tip]'); if (t && t === _tipTrigger && !(e.relatedTarget && t.contains(e.relatedTarget))) tipHide(); });
document.addEventListener('focusin', e => { const t = e.target.closest?.('[data-tip]'); if (t && e.target.matches(':focus-visible')) tipShow(t, true); });
document.addEventListener('focusout', tipHide);
['pointerdown', 'scroll'].forEach(ev => document.addEventListener(ev, tipHide, true));
window.addEventListener('hashchange', tipHide);

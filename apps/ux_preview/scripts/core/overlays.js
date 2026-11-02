'use strict';
/* Overlays: modal, drawer, dropdown menu, toast, command palette, tooltip,
   confirm. All render into #layer from state (S.modal, S.drawer, S.menu,
   S.palette, S.toasts), so a full re-render never loses an open overlay.

   M[name](props)  → { title, desc, icon, body, foot, footStart, size: sm|md|lg|xl, guard }
   DR[name](props) → { title, desc, lead, headActions, body, foot, footStart, size: md|lg|xl }
   MENUS[name](triggerEl) → [{ label, icon, meta, danger, checked, disabled, run } | { section } | { sep: true }] */

function renderLayer(fromRender) {
  const snap = fromRender ? null : snapshotFocus('#layer');
  let h = '';
  if (S.drawer) {
    const d = DR[S.drawer.name]?.(S.drawer.props || {}) || { title: 'Missing panel', body: '' };
    h += `<div class="backdrop" data-act="close-drawer" data-anim="drawer-bd"></div><aside class="${cx('drawer__dialog', d.size && d.size !== 'md' && 'drawer__dialog--' + d.size)}" role="dialog" aria-modal="true" aria-labelledby="drawer-title" data-anim="drawer:${S.drawer.name}">
      <header class="drawer__header">${d.lead || ''}<div class="grow"><h2 class="drawer__heading" id="drawer-title">${esc(d.title)}</h2>${d.desc ? `<p class="drawer__description">${d.desc}</p>` : ''}</div><div class="drawer__header-actions">${d.headActions || ''}${iconBtn('x', 'Close', { act: 'close-drawer' })}</div></header>
      <div class="drawer__body" id="drawer-body" data-keep-scroll>${d.body}</div>${d.foot || d.footStart ? `<footer class="drawer__footer">${d.footStart ? `<div class="drawer__footer-start row gap-8">${d.footStart}</div>` : ''}${d.foot || ''}</footer>` : ''}</aside>`;
  }
  if (S.modal) {
    const m = M[S.modal.name]?.(S.modal.props || {}) || { title: 'Missing dialog', body: '' };
    S.modal.guard = !!(m.guard || S.modal.props?.guard);
    h += `<div class="backdrop" data-anim="modal-bd"></div><div class="modal__container" data-act="modal-scrim"><div class="${cx('modal__dialog', m.size && m.size !== 'md' && 'modal__dialog--' + m.size)}" role="${m.alert ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="modal-title" data-anim="modal:${S.modal.name}">
      <header class="modal__header">${m.icon ? `<span class="modal__icon">${m.icon}</span>` : ''}<div class="grow"><h2 class="modal__heading" id="modal-title">${esc(m.title)}</h2>${m.desc ? `<p class="modal__description">${m.desc}</p>` : ''}</div>${m.noClose ? '' : `<span class="modal__close">${iconBtn('x', 'Close', { act: m.closeAct || 'close-modal', size: 'sm' })}</span>`}</header>
      ${m.head ? `<div class="modal__head">${m.head}</div>` : ''}
      ${m.body ? `<div class="modal__body" id="modal-body" data-keep-scroll>${m.body}</div>` : '<div style="height:16px"></div>'}${m.foot || m.footStart ? `<footer class="modal__footer">${m.footStart ? `<div class="modal__footer-start row gap-8">${m.footStart}</div>` : ''}${m.foot || ''}</footer>` : ''}</div></div>`;
  }
  if (S.palette) h += paletteHtml();
  if (S.menu) {
    h += `<div class="menu" role="menu" id="menu" data-anim="menu:${S.menu.key}" style="left:${S.menu.x}px;top:${S.menu.y}px">${S.menu.items.map((it, i) =>
      it.sep ? '<div class="menu-separator" role="separator"></div>'
        : it.section ? `<div class="menu-section">${esc(it.section)}</div>`
          : `<button type="button" class="${cx('menu-item', it.danger && 'menu-item--danger')}" role="${it.checked != null ? 'menuitemradio' : 'menuitem'}" ${it.checked != null ? `aria-checked="${!!it.checked}"` : ''} data-mi="${i}" ${it.disabled ? 'disabled' : ''}>${it.html || ((it.icon ? ic(it.icon) : '') + `<span class="grow truncate">${esc(it.label)}</span>` + (it.meta ? `<span class="menu-item__meta">${esc(it.meta)}</span>` : ''))}${it.checked ? `<span class="menu-item__check">${ic('check')}</span>` : ''}</button>`).join('')}</div>`;
  }
  h += `<div class="toast-region" role="status" aria-live="polite">${S.toasts.map(t => `<div class="toast" data-anim="toast:${t.id}">${ic(t.tone === 'danger' ? 'alert-circle' : t.tone === 'accent' ? 'info' : 'check-circle', 'toast__icon--' + t.tone)}<span class="toast__message">${esc(t.msg)}</span>${t.action ? btn(t.action.label, { v: 'ghost', size: 'sm', act: 'toast-action', data: { id: t.id }, cls: 'button--secondary' }) : ''}${iconBtn('x', 'Dismiss', { size: 'sm', act: 'toast-close', data: { id: t.id } })}</div>`).join('')}</div>`;
  const layer = $('#layer');
  const before = new Set($$('[data-anim]', layer).map(e => e.dataset.anim));
  const focusSnap = snap || snapshotFocus('#layer');
  layer.innerHTML = h;
  $$('[data-anim]', layer).forEach(el => before.has(el.dataset.anim) && el.classList.add('settled'));
  if (S.menu) positionMenu();
  restoreFocus(focusSnap, '#layer');
}
function snapshotFocus(scope) {
  const root = $(scope), a = document.activeElement;
  const s = { id: a && root?.contains(a) ? a.id : null, scroll: {} };
  try { if (s.id && a.selectionStart != null) { s.s = a.selectionStart; s.e = a.selectionEnd; } } catch (_) { }
  $$('[data-keep-scroll]', root || document).forEach(el => { if (el.id) s.scroll[el.id] = el.scrollTop; });
  return s;
}
function restoreFocus(s, scope) {
  for (const [id, top] of Object.entries(s.scroll || {})) { const el = document.getElementById(id); if (el) el.scrollTop = top; }
  if (s.id) {
    const el = document.getElementById(s.id);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      // email/number inputs have no selection API: re-assign the value so the caret lands at the end.
      try { if (s.s != null) el.setSelectionRange(s.s, s.e); else if ('value' in el && el.tagName === 'INPUT') { const v = el.value; el.value = ''; el.value = v; } } catch (_) { }
    }
  }
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
    const t = root.querySelector('[data-autofocus]') || root.querySelector('.modal__body input:not([type=hidden]):not([disabled]):not([readonly]):not([type=checkbox]):not([type=radio]),.modal__body textarea,.drawer__body input:not([type=checkbox]):not([type=radio]):not([disabled]):not([readonly])') || root.querySelector('.modal__footer .button--primary:not(:disabled),.modal__footer .button--danger:not(:disabled)') || root.querySelector('.modal__body button:not(:disabled),.modal__body input:not(:disabled)') || root.querySelector('button');
    t?.focus();
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

/* ── Toast: toast(msg, { tone: success|danger|accent, action: { label, run }, duration }) ── */
let _toastN = 0;
function toast(msg, o = {}) {
  const t = { id: 't' + (++_toastN), msg, tone: o.tone || 'success', action: o.action };
  S.toasts = [...S.toasts.slice(-2), t]; renderLayer();
  setTimeout(() => { S.toasts = S.toasts.filter(x => x.id !== t.id); renderLayer(); }, o.duration || (o.action ? 6500 : 3800));
}

/* ── Confirm: confirmAction({ title, body, confirm, danger, typeText, onConfirm, delay }) ── */
function confirmAction(p) { setPath('confirm.text', ''); openModal('confirm', p); }
M.confirm = p => {
  const typed = getPath('confirm.text') || '';
  const blocked = p.typeText && typed !== p.typeText;
  return {
    size: 'sm', title: p.title, alert: !!p.danger,
    body: `${p.body ? `<p class="muted">${p.body}</p>` : ''}${p.typeText ? `<div class="mt-16">${field({ id: 'confirm-text', label: `Type ${p.typeText} to confirm`, control: input({ id: 'confirm-text', bind: 'confirm.text', value: typed, autofocus: true, attrs: 'data-live', cls: 'mono' }) })}</div>` : ''}`,
    foot: btn('Cancel', { act: 'close-modal' }) + btn(p.confirm || 'Confirm', { v: p.danger ? 'danger' : 'primary', act: 'confirm-ok', disabled: blocked, loading: p.busy, id: 'confirm-ok' }),
  };
};
A['confirm-ok'] = async () => { const p = S.modal.props; p.busy = true; refreshLayer(); await sleep(p.delay ?? 500); S.modal = null; renderLayer(); returnFocus(); await p.onConfirm?.(); };

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

/* ── Command palette: one search for everything the caller may open ── */
function paletteResults(q) {
  q = q.trim().toLowerCase(); const out = [];
  const add = (group, items) => items.length && out.push({ group, items });
  const m = s => !q || String(s).toLowerCase().includes(q);
  if (S.cur.r.mode === 'platform') {
    add('Workspaces', D.pWorkspaces.filter(w => m(w.name)).slice(0, 6).map(w => ({ label: w.name, icon: 'building', meta: plural(w.members, 'member'), run: () => goThen('/p/workspaces', () => A['pws-open']?.({ dataset: { id: w.id } })) })));
    add('Users', q ? D.pUsers.filter(u => m(u.name) || m(u.email)).slice(0, 5).map(u => ({ label: u.name, icon: 'user', meta: u.email, run: () => goThen('/p/users', () => A['pu-open']?.({ dataset: { id: u.id } })) })) : []);
    add('Go to', PLATFORM_NAV.filter(n => m(n.label)).map(n => ({ label: n.label, icon: n.icon, run: () => go(n.to) })));
    return out;
  }
  if (q) add('Ask', [{ label: `Ask “${q}”`, icon: 'sparkles', run: () => A['chat-ask']?.({ dataset: { q } }) }]);
  add('Conversations', myConvs().filter(c => m(c.title)).slice(0, q ? 5 : 3).map(c => ({ label: c.title, icon: 'message', meta: rel(c.at), run: () => go('/chat/' + c.id) })));
  if (q) add('Resources', catalogSearch(parseCatalogQuery({ q })).rows.slice(0, 5).map(({ doc: d }) => ({ label: d.name, icon: kindMeta(res(d).kind).icon, meta: kbById(d.kb)?.name || '', run: () => go('/doc/' + d.id + '?q=' + encodeURIComponent(q)) })));
  if (q) add('Browse', [{ label: `Browse knowledge for “${q}”`, icon: 'filter', run: () => go(catalogHref({ q })) }]);
  add('Collections', visibleCollections().filter(c => m(c.name)).slice(0, q ? 3 : 2).map(c => ({ label: c.name, icon: 'list', meta: plural(c.items.length, 'item'), run: () => go('/knowledge/collections/' + c.id) })));
  add('Knowledge bases', visibleKbs().filter(k => m(k.name)).slice(0, q ? 4 : 2).map(k => ({ label: k.name, icon: k.personal ? 'user' : 'book', meta: plural(docsIn(k.id).length, 'document'), run: () => go('/knowledge/' + k.id) })));
  if (q && can('user.manage')) add('People', D.members.filter(p => m(p.name) || m(p.email)).slice(0, 4).map(p => ({ label: p.name, icon: 'user', meta: roleById(p.roleId)?.name, run: () => goThen('/people', () => A['member-open']?.({ dataset: { id: p.id } })) })));
  const pages = [...memberNav(), ...(hasModule('spaces') ? [{ label: 'Spaces', to: '/spaces', icon: 'layers' }] : []), ...MANAGE_NAV.filter(n => can(n.perm)), ...(isOperator() ? [{ label: 'Platform console', to: '/p/workspaces', icon: 'layers' }] : [])].filter(n => n.to);
  if (hasModule('spaces')) add('Spaces', visibleSpaces().filter(s => m(s.name) || m(s.code || '')).slice(0, q ? 5 : 3).map(s => ({ label: s.name, icon: spaceType(s.type).icon, meta: [s.code, spaceType(s.type).label].filter(Boolean).join(' · '), run: () => go('/space/' + s.id) })));
  if (q && hasModule('work')) add('Work', (D.works || []).filter(w => (w.owner === me().id || w.visibility === 'space' && spaceRole(spaceById(w.space))) && m(w.title)).slice(0, 4).map(w => ({ label: w.title, icon: WORKFLOWS[w.workflow]?.icon || 'sparkles', meta: spaceById(w.space)?.name || '', run: () => go('/work/' + w.id) })));
  add('Go to', pages.filter(p => m(p.label)).slice(0, q ? 6 : 4).map(p => ({ label: p.label, icon: p.icon, run: () => go(p.to) })));
  add('Actions', [
    { label: 'New chat', icon: 'message-plus', run: () => go('/chat') },
    can('knowledge.manage') && { label: 'Create knowledge base', icon: 'book', run: () => goThen('/knowledge/bases', () => A['kb-create']?.()) },
    { label: 'New collection', icon: 'list-plus', run: () => A['col-new']?.() },
    can('source.manage') && { label: 'Connect a source', icon: 'plug', run: () => goThen('/sources', () => A['src-connect']?.()) },
    can('user.manage') && { label: 'Add people', icon: 'user-plus', run: () => goThen('/people', () => A['member-add']?.()) },
    { label: resolvedTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', icon: resolvedTheme() === 'dark' ? 'sun' : 'moon', run: () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark') },
  ].filter(Boolean).filter(a => m(a.label)));
  if (q) add('More', [{ label: `See all results for “${q}”`, icon: 'search', run: () => go('/search?q=' + encodeURIComponent(q)) }]);
  return out;
}
function paletteHtml() {
  const p = S.palette; const groups = paletteResults(p.q); let n = 0; const flat = [];
  const listHtml = groups.map(g => `<div class="palette__group" role="presentation">${esc(g.group)}</div>` + g.items.map(it => { const i = n++; flat.push(it); return `<button type="button" class="palette__item" role="option" id="pi-${i}" aria-selected="${i === p.sel}" data-pi="${i}">${ic(it.icon)}<span class="grow truncate">${esc(it.label)}</span>${it.meta ? `<span class="palette__item-meta truncate">${esc(it.meta)}</span>` : ''}</button>`; }).join('')).join('');
  p.flat = flat;
  const ph = S.cur.r.mode === 'platform' ? 'Search workspaces, users, pages…' : 'Search or ask anything…';
  return `<div class="backdrop" data-act="palette-close" data-anim="palette-bd"></div><div class="palette" role="dialog" aria-modal="true" aria-label="Search" data-anim="palette"><div class="palette__input">${ic('search', 'i-lg')}<input id="palette-q" placeholder="${ph}" value="${esc(p.q)}" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant="pi-${p.sel}">${kbd('Esc')}</div><div class="palette__list" id="palette-list" role="listbox">${flat.length ? listHtml : emptyState({ icon: 'search', title: 'No matches', desc: 'Try a different word.', compact: true })}</div><div class="palette__foot"><span>${kbd('↑')} ${kbd('↓')} to move</span><span>${kbd('↵')} to open</span></div></div>`;
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

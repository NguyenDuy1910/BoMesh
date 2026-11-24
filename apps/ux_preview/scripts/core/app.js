'use strict';
/* Render loop + event delegation. A state change calls refresh(); the page
   is re-rendered from S/D while focus, caret and marked scroll positions are
   preserved. Entry animations play once per element (data-anim). */

function render() {
  const cur = parseHash(); S.cur = cur;
  const changed = cur.path !== S.lastPath;
  if (changed) {
    S.lastPath = cur.path; S.pageState = 'live'; S.menu = null; S.navOpen = false; S.palette = null; S.drawer = null; S.modal = null; S.popover = null;
    if (cur.r.simLoad && !S.visited.has(cur.path)) { S.navLoading = true; setTimeout(() => { S.navLoading = false; render(); }, 380); }
    S.visited.add(cur.path);
  }
  if (!S.signedIn && cur.r.mode !== 'auth' && cur.r.mode !== 'proto') { history.replaceState(null, '', '#/signin'); return render(); }
  // A workspace you aren't in (a visitor who left, an account that hasn't joined yet) opens the workspace chooser instead.
  if (cur.r.mode === 'workspace' && !me().workspaces?.includes(S.ws)) { history.replaceState(null, '', '#/workspaces'); return render(); }
  const snap = snapshotFocus('#app');
  const app = $('#app');
  const denied = cur.r.perm && !can(cur.r.perm);
  const moduleOff = cur.r.module && !hasModule(cur.r.module);
  S.crumbs = null; S.topbarEnd = ''; S.head = null;
  let html;
  try {
    const fn = P[cur.r.page];
    // A module held back for a later phase shows what's coming instead of "turned off".
    html = denied ? noAccessPage() : moduleOff ? (LATER_PHASE_MODULES.has(cur.r.module) ? comingSoonPage(cur.r.module) : moduleOffPage(cur.r.module)) : fn ? fn({ params: cur.params, query: cur.query }) : `<div class="page">${emptyState({ icon: 'alert', title: 'Screen not available', desc: esc(cur.r.page) })}</div>`;
  } catch (err) {
    console.error(err);
    html = `<div class="page">${errorState({ title: 'Something went wrong on this page', desc: String(err.message || err) })}</div>`;
  }
  if (cur.r.mode === 'auth' || cur.r.mode === 'proto') {
    app.className = ''; app.innerHTML = html;
  } else {
    app.className = cx('app', S.collapsed && 'is-collapsed', S.navOpen && 'is-nav-open');
    app.innerHTML = sidebar() + `<main class="main" id="main">${topbar()}<div class="${cx('main__scroll', cur.r.bare && 'main__scroll--bare')}" id="scroll" data-keep-scroll>${html}</div></main>` + (S.navOpen ? '<div class="sidebar-backdrop" data-act="nav-close"></div>' : '');
  }
  renderLayer(true);
  renderProto();
  if (!changed) restoreFocus(snap, '#app');
  else { const sc = $('#scroll'); if (sc) sc.scrollTop = 0; $$('#app input[data-indeterminate]').forEach(el => (el.indeterminate = true)); }
  syncOverflow(changed); syncHeader();
  if (S.popover) positionPopover();   // after scroll positions are restored, so it stays on its trigger
  document.title = (S.head?.title || cur.r.title || 'BoMesh') + ' · BoMesh';
  try { AFTER[cur.r.page]?.({ params: cur.params, query: cur.query, changed }); } catch (e) { console.error(e); }
  if (changed) { const af = $('#app [data-autofocus]'); if (af) af.focus(); }
  persist();
}
const refresh = () => render();
/** Scrollable strips (tabs; any [data-overflow]) get an edge fade on the side that has more; the current tab stays in view. */
function syncOverflow(reveal) {
  $$('[data-overflow]').forEach(el => {
    if (reveal) { const cur = el.querySelector('[aria-current="page"],[aria-selected="true"],[aria-pressed="true"]'); if (cur && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, cur.offsetLeft - el.clientWidth / 2 + cur.offsetWidth / 2); }
    overflowEdges(el);
  });
}
function overflowEdges(el) {
  const more = el.scrollWidth - el.clientWidth > 1;
  el.classList.toggle('is-fade-start', more && el.scrollLeft > 1);
  el.classList.toggle('is-fade-end', more && el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
}
/** Scrollers that carry a page's content (most pages scroll #scroll; chat, work items and the reader scroll their own pane). */
const PAGE_SCROLLERS = '#scroll, #chat-scroll, #work-scroll, #rdr-scroll';
document.addEventListener('scroll', e => { if (e.target.matches?.(PAGE_SCROLLERS)) syncHeader(); else if (e.target.matches?.('[data-overflow]')) overflowEdges(e.target); }, true);
/** CompactHeader state from the page's scroll: `is-scrolled` once content passes under the top row (it draws a hairline unless a
    sticky ContextualToolbar sits right below it), `is-past-hero` once an entity page's identity block has left the view (the top
    row then shows its title). */
function syncHeader() {
  const main = $('#main'); if (!main) return;
  main.classList.toggle('is-scrolled', $$(PAGE_SCROLLERS).some(s => s.scrollTop > 2));
  const hero = $('#page-hero'), sc = hero?.closest('[data-keep-scroll]'); if (!sc) return;
  main.classList.toggle('is-past-hero', hero.getBoundingClientRect().bottom <= sc.getBoundingClientRect().top + 8);
}

/* ── Generic actions ── */
A['close-modal'] = () => closeModal();
A['close-drawer'] = () => closeDrawer();
A['modal-scrim'] = (el, e) => { if (e.target === el && !S.modal?.guard && !S.modal?.props?.guard) closeModal(); };
/** Desktop: expanded ↔ icon rail (remembered). Below 1024 px: open/close the off-canvas sidebar. Focus stays on the control that
    toggles it (the sidebar's own button when it opens, the top row's menu button when it closes). */
A['nav-toggle'] = () => {
  const narrow = narrowFrame();
  if (narrow) S.navOpen = !S.navOpen; else S.collapsed = !S.collapsed;
  refresh();
  (narrow && !S.navOpen ? $('#topbar-menu') : $('#sidebar-toggle'))?.focus();
};
A['nav-close'] = () => { S.navOpen = false; refresh(); $('#topbar-menu')?.focus(); };
A.go = el => go(el.dataset.to);
A['retry-load'] = () => { S.pageState = 'live'; S.navLoading = true; refresh(); setTimeout(() => { S.navLoading = false; refresh(); }, 600); };
A.sort = el => { const u = ui(el.dataset.ui); const k = el.dataset.key; u.sort = u.sort?.key === k ? (u.sort.dir === 'asc' ? { key: k, dir: 'desc' } : null) : { key: k, dir: 'asc' }; refresh(); };
A['ui-clear-q'] = el => { const u = ui(el.dataset.ui); u.q = ''; u.page = 1; refresh(); $('#' + el.dataset.ui + '-q')?.focus(); };
/** searchField's × (and Escape): empty the input and replay the input event, so uiKey / bind / act handlers all see it. */
function clearSearchInput(inp) { if (!inp) return; inp.value = ''; inp.focus(); inp.dispatchEvent(new Event('input', { bubbles: true })); }
A['search-clear'] = el => clearSearchInput(el.closest('.search-field')?.querySelector('input'));
A['ui-clear'] = el => { const u = ui(el.dataset.ui); (el.dataset.fields || '').split(',').filter(Boolean).forEach(f => (u[f] = '')); u.q = ''; u.page = 1; refresh(); };
A['ui-page'] = el => { ui(el.dataset.ui).page = +el.dataset.page; refresh(); $('#scroll')?.scrollTo({ top: 0 }); };
A['ui-toggle'] = el => { const p = el.dataset.path; setPath(p, !getPath(p)); S.modal || S.drawer ? refreshLayer() : refresh(); };
A['sel-toggle'] = (el, e) => { e?.stopPropagation(); const u = ui(el.dataset.ui); u.sel = u.sel || {}; u.sel[el.dataset.id] = !u.sel[el.dataset.id]; refresh(); };
A['sel-all'] = (el, e) => { e?.stopPropagation(); const u = ui(el.dataset.ui); const ids = el.dataset.ids.split(',').filter(Boolean); const all = ids.every(id => u.sel?.[id]); u.sel = all ? {} : Object.fromEntries(ids.map(id => [id, true])); refresh(); };
A['sel-clear'] = el => { ui(el.dataset.ui).sel = {}; refresh(); };
A['toast-close'] = el => dismissToast(el.dataset.id);
A['toast-action'] = el => { const t = S.toasts.find(t => t.id === el.dataset.id); dismissToast(el.dataset.id); t?.action?.run(); };
A.copy = el => copyText(el.dataset.text || '', el.dataset.msg || 'Copied');

/* ── Event delegation ── */
document.addEventListener('click', e => {
  const mi = e.target.closest('[data-mi]');
  if (mi && S.menu) { const it = S.menu.items[+mi.dataset.mi]; closeMenu(false); it?.run?.(); return; }
  const pi = e.target.closest('[data-pi]');
  if (pi && S.palette) { const it = S.palette.flat[+pi.dataset.pi]; S.palette = null; renderLayer(); it?.run(); return; }
  if (S.menu && !e.target.closest('#menu')) { const same = e.target.closest('[data-menu]') === S.menu.trigger; closeMenu(false); if (same) return; }
  if (S.popover && !e.target.closest('#popover')) {
    const tg = e.target.closest('[data-popover]'), same = tg && tg === popoverTrigger();
    // A click outside closes the popover; the trigger itself toggles it. Clicks on the sheet backdrop are handled by its data-act.
    if (!e.target.closest('[data-act="popover-close"]')) { closePopover(same); if (same) return; }
  }
  const po = e.target.closest('[data-popover]');
  if (po && !po.disabled && !e.target.closest('#popover')) { e.preventDefault(); e.stopPropagation(); if (PO[po.dataset.popover]) openPopover(po); return; }
  const m = e.target.closest('[data-menu]');
  if (m && !m.disabled) { e.preventDefault(); e.stopPropagation(); const items = MENUS[m.dataset.menu]?.(m); if (items?.length) openMenu(m, items, m.dataset.menu + ':' + (m.dataset.id || '')); return; }
  const a = e.target.closest('[data-act]');
  if (!a || a.matches('input[type=radio]')) return;
  // Form controls inside an interactive row act on themselves, not the row.
  const ctl = e.target.closest('input,select,textarea,label');
  if (ctl && ctl !== a && !ctl.dataset.act && a.contains(ctl)) return;
  if (a.matches(':disabled,[aria-disabled="true"]')) { e.preventDefault(); return; }
  if (A[a.dataset.act]) { if (a.tagName === 'A' || a.type === 'submit') e.preventDefault(); A[a.dataset.act](a, e); }
  else console.warn('No action registered:', a.dataset.act);
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'palette-q') { S.palette.q = el.value; S.palette.sel = 0; renderLayer(); return; }
  if (el.dataset.bind) { setPath(el.dataset.bind, el.type === 'checkbox' ? el.checked : el.value); if (el.dataset.live != null) el.closest('#layer') ? refreshLayer() : refresh(); }
  if (el.dataset.input === 'ui-q') { const u = ui(el.dataset.ui); u.q = el.value; u.page = 1; refresh(); return; }
  if (el.dataset.input && A[el.dataset.input]) A[el.dataset.input](el, e);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.tagName === 'SELECT' && el.dataset.bind) setPath(el.dataset.bind, el.value);
  if (el.dataset.change && A[el.dataset.change]) A[el.dataset.change](el, e);
});
document.addEventListener('keydown', e => {
  const k = e.key;
  const inApp = ['workspace', 'platform'].includes(S.cur?.r.mode);
  if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'k') { e.preventDefault(); if (inApp) S.palette ? closePalette() : openPalette(); return; }
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && k.toLowerCase() === 'o') { e.preventDefault(); if (inApp) A['chat-new']?.(); return; }
  if ((e.metaKey || e.ctrlKey) && k === '\\') { e.preventDefault(); if (inApp && !S.modal) A['nav-toggle'](); return; }
  if (S.palette) {
    const n = S.palette.flat?.length || 0;
    if (k === 'Escape') { e.preventDefault(); closePalette(); return; }
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); S.palette.sel = (S.palette.sel + (k === 'ArrowDown' ? 1 : -1) + n) % Math.max(n, 1); renderLayer(); $('#pi-' + S.palette.sel)?.scrollIntoView({ block: 'nearest' }); return; }
    if (k === 'Enter') { e.preventDefault(); const it = S.palette.flat?.[S.palette.sel]; S.palette = null; renderLayer(); it?.run(); return; }
    return;
  }
  if (S.popover && !S.menu && k === 'Escape') { e.preventDefault(); closePopover(true); return; }
  if (k === 'Escape' && e.target.matches?.('.search-field input') && e.target.value) { e.preventDefault(); clearSearchInput(e.target); return; }
  // A click-to-edit title (editableTitle) cancels on Escape before anything else (a dialog it sits in stays open).
  if (k === 'Escape' && e.target.dataset?.esc && A[e.target.dataset.esc]) { e.preventDefault(); A[e.target.dataset.esc](e.target, e); return; }
  if (S.menu) {
    const items = $$('#menu .menu-item:not([disabled])'); const i = items.indexOf(document.activeElement);
    if (k === 'Escape' || k === 'Tab') { e.preventDefault(); closeMenu(true); return; }
    if (k === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); return; }
    if (k === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); return; }
    if (k === 'Home') { e.preventDefault(); items[0]?.focus(); return; }
    if (k === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); return; }
    return;
  }
  if (k === 'Escape') {
    if (S.modal) { if (!S.modal.guard && !S.modal.props?.guard) closeModal(); return; }
    if (S.drawer) { closeDrawer(); return; }
    if (S.navOpen) { A['nav-close'](); return; }
    if (A['esc-page']?.()) return;
  }
  if (k === 'Tab' && (S.modal || S.drawer)) {
    const root = $(S.modal ? '#layer .modal__dialog' : '#layer .drawer__dialog'); if (!root) return;
    const f = $$('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])', root).filter(x => x.offsetParent !== null);
    if (!f.length) return; const first = f[0], last = f[f.length - 1];
    if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  const t = e.target;
  if (k === 'Enter' && t.dataset?.enter && !e.shiftKey && !e.isComposing) { e.preventDefault(); A[t.dataset.enter]?.(t, e); return; }
  if ((k === 'Enter' || k === ' ') && t.matches?.('[data-act][role="button"],tr[data-act],.card--action[data-act]:not(button)')) { e.preventDefault(); A[t.dataset.act]?.(t, e); }
});
/* data-blur="name" → A[name](el) when the person leaves the field (editableTitle commits there too, so A[name] must be
   idempotent). A press elsewhere blurs first: then it runs after that press's click, so its re-render doesn't swallow the
   click. A re-render also blurs the field it replaces — that isn't the person leaving, so a field gone by then is skipped. */
let pointerDown = false;
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', () => setTimeout(() => { pointerDown = false; }), true);
document.addEventListener('focusout', e => {
  const el = e.target; if (!el.dataset?.blur || !A[el.dataset.blur]) return;
  const run = () => A[el.dataset.blur](el, e);
  if (!pointerDown) { setTimeout(() => { if (el.isConnected) run(); }); return; }
  let done = false; const once = () => { if (!done) { done = true; run(); } };
  document.addEventListener('click', once, { once: true }); setTimeout(once, 500);
});
window.addEventListener('hashchange', render);
/* Crossing 1024 px swaps the rail for the off-canvas sidebar (and back): re-render so its markup and labels match. */
let lastNarrow = null;
window.addEventListener('resize', () => {
  if (S.menu) closeMenu(false); if (S.popover) renderLayer(); syncOverflow(false);
  const n = narrowFrame(); if (lastNarrow !== null && n !== lastNarrow && S.cur && !['auth', 'proto'].includes(S.cur.r.mode)) refresh(); lastNarrow = n;
});

/* ── Boot (runs after every feature module registered its pages) ── */
function boot() {
  hydrate();
  applyTheme(); applyLang();
  syncMemberships();
  if (!PERSONAS[S.persona].workspaces?.includes(S.ws)) S.ws = PERSONAS[S.persona].workspaces?.[0] || S.ws;
  if (!location.hash) history.replaceState(null, '', S.signedIn ? '#' + homeRoute() : '#/signin');
  render();
}

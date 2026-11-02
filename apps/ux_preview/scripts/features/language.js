'use strict';
/* Language — personal interface-language setting (core/i18n.js does the
   localizing). Entry points: Preferences, account menu, sign-in pages,
   command palette and the prototype bar. Content keeps its own language. */
(() => {
  const OPTIONS = () => UI_LANGS.map(([code, native, en]) => [code, native === en ? native : `${native} — ${en}`]);

  /** Select used by Preferences (immediate, like Appearance). */
  const field_ = () => field({
    id: 'pref-lang', label: 'Language',
    desc: 'Menus, buttons and messages. Documents, answers and workspace names stay in the language they were written in.',
    control: select({ id: 'pref-lang', value: S.lang, options: OPTIONS(), change: 'lang-select', label: 'Language', attrs: 'translate="no"' }),
  });
  /** Compact picker for pages without the shell (sign-in, sign-up, workspace choice). */
  const picker = () => `<label class="lang-picker">${ic('globe', 'i-sm')}<span class="sr-only">Language</span>${select({ id: 'lang-picker', value: S.lang, options: UI_LANGS.map(([c, n]) => [c, n]), change: 'lang-select', size: 'sm', label: 'Language', attrs: 'translate="no"' })}</label>`;
  const items = () => UI_LANGS.map(([code, native, en]) => ({ html: `<span class="grow" translate="no">${esc(native)}</span>${native !== en ? `<span class="menu-item__meta" translate="no">${esc(en)}</span>` : ''}`, checked: S.lang === code, run: () => change(code) }));

  function change(code) {
    const before = S.lang; if (code === before) return;
    setLang(code);
    // Written in English; the active dictionary localizes the toast like any other copy.
    toast(code === 'vi' ? 'Language changed to Tiếng Việt' : 'Language changed to English', { tone: 'accent', action: { label: 'Undo', run: () => setLang(before) } });
  }

  MENUS.lang = () => [{ section: 'Language' }, ...items()];
  X.lang = {
    field: field_, picker, items,
    /** Account menu entry: opens the language list at the same trigger. */
    menuItem: () => ({ html: `${ic('globe')}<span class="grow">Language</span><span class="menu-item__meta" translate="no">${esc(langName())}</span>`, run: () => { const tg = $('[data-menu="me"]'); if (tg) setTimeout(() => openMenu(tg, MENUS.lang(), 'lang'), 0); } }),
    change,
  };
  A['lang-select'] = el => change(el.value);
  A['lang-toggle'] = () => change(S.lang === 'vi' ? 'en' : 'vi');
})();

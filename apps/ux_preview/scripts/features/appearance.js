'use strict';
/* Appearance — one personal theme for the whole interface (HeroUI Theme
   Builder dimensions: mode, theme, accent, base tint, radius, font).
   The drawer has a clear backdrop so the app behind it re-themes live.
   Entry points: account menu, Preferences, prototype bar, design system. */
(() => {
  const fontStack = id => FONTS.find(f => f[0] === id)?.[2] || '';

  /** Mini preview of a named theme, drawn from its own colours. */
  function themeCard(t, on) {
    const p = themePreview(t);
    const style = `--tp-bg:${p.bg};--tp-surface:${p.surface};--tp-line:${p.line};--tp-text:${p.text};--tp-muted:${p.muted};--tp-accent:${p.accent};--tp-ink:${p.ink};--tp-r:${p.radius}rem;font-family:${esc(p.font)}`;
    return `<button type="button" class="theme-card" aria-pressed="${on}" data-act="look-theme" data-value="${t.id}" aria-label="${esc(t.label)} theme">
      <span class="theme-card__preview" style="${style}" aria-hidden="true">
        <span class="theme-card__side"><i></i><i class="is-on"></i><i></i></span>
        <span class="theme-card__panel"><b>Aa</b><span class="theme-card__line"></span><span class="theme-card__line theme-card__line--short"></span><span class="theme-card__row"><span class="theme-card__btn"></span><span class="theme-card__chip"></span></span></span>
      </span>
      <span class="theme-card__meta"><span class="theme-card__name">${esc(t.label)}</span><span class="theme-card__note">${esc(t.note)}</span></span>
      ${on ? `<span class="theme-card__check">${ic('check')}</span>` : ''}
    </button>`;
  }
  const gallery = () => `<div class="theme-gallery">${THEMES.map(t => themeCard(t, S.look.theme === t.id)).join('')}</div>`;

  function controls() {
    const L = S.look, custom = L.accent === 'custom';
    const accents = swatchPicker({ value: L.accent, act: 'look-accent', label: 'Accent color', options: [...ACCENTS.map(([id, l]) => [id, l, accentColor({ ...L, accent: id })]), ['custom', 'Custom hue', `conic-gradient(from 0deg, oklch(65% 0.17 0), oklch(65% 0.17 60), oklch(65% 0.17 120), oklch(65% 0.17 180), oklch(65% 0.17 240), oklch(65% 0.17 300), oklch(65% 0.17 360))`]] });
    const hue = custom ? `<div class="hue-field mt-12"><label class="t-xs muted" for="look-hue">Hue <span class="mono" id="look-hue-val">${Math.round(L.hue)}°</span></label><input id="look-hue" class="hue-slider" type="range" min="0" max="360" step="1" value="${Math.round(L.hue)}" data-input="look-hue-live" data-change="look-hue"></div>` : '';
    const fonts = `<div class="font-options" role="group" aria-label="Font">${FONTS.map(([id, l]) => `<button type="button" class="font-option" aria-pressed="${L.font === id}" data-act="look-font" data-value="${id}" style="font-family:${esc(fontStack(id))}"><span class="font-option__sample">Aa</span><span class="font-option__name">${esc(l)}</span></button>`).join('')}</div>`;
    return `<div class="stack gap-20 appearance">
      <div class="field"><span class="label">Mode</span>${seg({ value: S.theme, options: [['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'System', 'monitor']], act: 'look-mode', label: 'Mode', full: true })}</div>
      <div class="field"><div class="row"><span class="label grow">Theme</span><span class="t-xs muted">${S.look.theme === 'custom' ? 'Custom' : esc(themeLabel())}</span></div>${gallery()}</div>
      <hr class="separator">
      <h3 class="t-subheading">Customize</h3>
      <div class="field"><span class="label">Accent color</span>${accents}${hue}<div class="description">Buttons, links, selection, focus rings and highlights.</div></div>
      <div class="field"><span class="label">Background tint</span>${seg({ value: L.base, options: BASES.map(([id, l]) => [id, l]), act: 'look-base', label: 'Background tint', full: true })}<div class="description">How much the accent colors the canvas, cards, borders and text.</div></div>
      <div class="field"><span class="label">Corner radius</span>${seg({ value: L.radius, options: RADII.map(([id, l]) => [id, l === 'Extra large' ? 'XL' : l]), act: 'look-radius', label: 'Corner radius', full: true })}</div>
      <div class="field"><span class="label">Font</span>${fonts}</div>
      ${alertBox('default', '', 'Status colors (success, warning, danger) and cited-evidence highlights keep their meaning in every theme.', '', { icon: 'info' })}
    </div>`;
  }

  DR.appearance = () => {
    FONTS.forEach(f => ensureFont(f[0]));
    return {
      title: 'Appearance', clear: true,
      desc: 'Changes the whole app right away. Saved for you on this device.',
      body: controls(),
      footStart: btn('Reset to BoMesh', { v: 'ghost', icon: 'refresh', act: 'look-reset' }),
      foot: btn('Done', { v: 'primary', act: 'close-drawer' }),
    };
  };

  /** Compact current-theme summary (Preferences, account menu). */
  X.appearance = {
    open: () => { if (S.modal) closeModal(); openDrawer('appearance'); },
    dot: () => `<span class="theme-dot" style="background:${accentColor()}" aria-hidden="true"></span>`,
    detail: () => `${{ light: 'Light', dark: 'Dark', system: 'System' }[S.theme]} mode · ${accentOf().label} accent · ${FONTS.find(f => f[0] === S.look.font)?.[1] || ''}`,
    gallery,
    /** Account menu / prototype bar: mode + a Theme entry that opens the drawer. */
    menuItems: () => [
      { section: 'Appearance' },
      ...[['light', 'Light', 'sun'], ['dark', 'Dark', 'moon'], ['system', 'Match system', 'monitor']].map(([v, l, i]) => ({ label: l, icon: i, checked: S.theme === v, run: () => setTheme(v) })),
      { html: `<span class="i theme-dot" style="background:${accentColor()}" aria-hidden="true"></span><span class="grow">Theme and colors…</span><span class="menu-item__meta">${esc(themeLabel())}</span>`, run: () => X.appearance.open() },
    ],
  };

  /** Theme change from outside the drawer: toast with undo. */
  function withUndo(fn, label) {
    const before = { ...S.look };
    fn();
    toast(label, { tone: 'accent', action: { label: 'Undo', run: () => { S.look = before; applyTheme(); persist(); refresh(); } } });
  }

  A['look-open'] = () => X.appearance.open();
  A['look-mode'] = el => setTheme(el.dataset.value);
  A['look-theme'] = el => {
    const t = themeById(el.dataset.value); if (!t) return;
    if (S.drawer?.name === 'appearance') setThemePreset(t.id);
    else withUndo(() => setThemePreset(t.id), `Theme changed to ${t.label}`);
  };
  A['look-accent'] = el => setLook({ accent: el.dataset.value });
  A['look-hue-live'] = el => { S.look.hue = +el.value; S.look.accent = 'custom'; applyTheme(); const v = $('#look-hue-val'); if (v) v.textContent = `${el.value}°`; };
  A['look-hue'] = el => setLook({ accent: 'custom', hue: +el.value });
  A['look-base'] = el => setLook({ base: el.dataset.value });
  A['look-radius'] = el => setLook({ radius: el.dataset.value });
  A['look-font'] = el => setLook({ font: el.dataset.value });
  A['look-reset'] = () => { const before = { ...S.look }; resetLook(); toast('Appearance reset to BoMesh', { action: { label: 'Undo', run: () => { S.look = before; applyTheme(); persist(); refresh(); } } }); };
})();

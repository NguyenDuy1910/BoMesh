'use strict';
/* Interface language — a personal setting (English | Tiếng Việt).
   Screens are written in English; when another language is active, a
   MutationObserver localizes every rendered node before paint using the
   language's dictionary (scripts/i18n/<lang>.js):
     exact:    "Save"                → "Lưu"
     patterns: "Updated {0}"         → "Cập nhật {0}" ({n} captures runtime values,
                                        which are themselves localized when known)
   Text nodes plus placeholder / aria-label / title / data-tip / alt are
   covered. Numbers, dates, relative times and "N things" counters come from
   util.js formatters (uiLocale, rel, plural).
   Content is never translated: documents, answers, quotes, user input and
   workspace data (knowledge base, topic and document names) stay in the
   language they were written in. Mark extra content with translate="no". */

/** [code, native name, English name] */
const UI_LANGS = [['en', 'English', 'English'], ['vi', 'Tiếng Việt', 'Vietnamese']];
S.lang = 'en';

const SKIP_SEL = '[translate="no"], .chat-answer, .chat-bubble, .doc-page, .doc-note, .chat-cite__quote, .home-suggest__chip, .chat-starter__prompt, script, style, textarea, code, pre, [contenteditable="true"]';
const ATTRS = ['placeholder', 'aria-label', 'title', 'data-tip', 'alt'];
/** Chrome where a word is always interface copy, even if a workspace record has the same name. */
const CHROME_SEL = '.sidebar, .topbar, .menu, .palette, .tabs, [role="tablist"], .page-header, .modal__heading, .drawer__heading, #proto-root, .button, .toggle-group';
const _dicts = {};
let _names = null, _namesWs = null;
/** Names authored in the workspace (topics, knowledge bases, spaces, collections, documents): content, never translated. */
function workspaceNames() {
  if (_namesWs === S.ws && _names) return _names;
  const w = DB.ws[S.ws] || {}, set = new Set();
  ['domains', 'topics', 'kbs', 'spaces', 'collections', 'docs', 'groups'].forEach(k => (Array.isArray(w[k]) ? w[k] : []).forEach(o => { const n = o?.name || o?.label || o?.title; if (n) set.add(String(n).trim()); }));
  _namesWs = S.ws; return (_names = set);
}

function i18nDict(lang) {
  if (_dicts[lang]) return _dicts[lang];
  const src = lang === 'vi' && typeof I18N_VI !== 'undefined' ? I18N_VI : null;
  if (!src) return null;
  const exact = new Map(), patterns = [];
  const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [k, v] of Object.entries(src)) {
    if (!v) continue;
    const key = k.replace(/\s+/g, ' ').trim();
    if (!/\{\d+\}/.test(key)) { exact.set(key, v); continue; }
    // A placeholder glued to a word ("need{1}", "document{1}") is an English plural suffix: optional, and dropped in translation.
    const suffix = new Set([...key.matchAll(/[a-z]{2}\{(\d+)\}/g)].map(x => +x[1]));
    const parts = key.split(/(\{\d+\})/), order = [];
    const re = parts.map(p => { const m = /^\{(\d+)\}$/.exec(p); if (m) { order.push(+m[1]); return suffix.has(+m[1]) ? '([a-z]{0,2})' : '([\\s\\S]+?)'; } return reEsc(p); }).join('');
    const lits = parts.filter(p => p && !/^\{\d+\}$/.test(p)).map(p => p.trim()).filter(Boolean);
    const lit = lits.sort((a, b) => b.length - a.length)[0] || '';
    // Patterns must carry real words: "{0} in {1}" would rewrite any sentence containing "in".
    const letters = lits.join('').replace(/[^A-Za-z]/g, '').length, open = /^\{\d+\}/.test(key) && /\{\d+\}$/.test(key);
    if (letters < (open ? 8 : 3)) continue;
    const to = suffix.size ? v.replace(/\{(\d+)\}/g, (all, n) => (suffix.has(+n) ? '' : all)).replace(/\s+([.,;:!?])/g, '$1').replace(/\s{2,}/g, ' ') : v;
    patterns.push({ re: new RegExp('^' + re + '$'), order, to, lit, weight: key.replace(/\{\d+\}/g, '').length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
  return (_dicts[lang] = { exact, patterns, memo: new Map() });
}

/** Localize one string (null when there's nothing to change). */
function tr(text, depth = 0) {
  const d = i18nDict(S.lang); if (!d || text == null) return null;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(text)); const core = m[2].replace(/\s+/g, ' ');
  if (!core || !/[A-Za-z]/.test(core)) return null;
  let out = d.memo.get(core);
  if (out === undefined) {
    out = d.exact.get(core) ?? null;
    if (out == null) {
      for (const p of d.patterns) {
        if (!core.includes(p.lit)) continue;
        const mm = p.re.exec(core); if (!mm) continue;
        const vals = {}; p.order.forEach((n, i) => { const v = mm[i + 1]; vals[n] = depth < 2 && !workspaceNames().has(v.trim()) ? (tr(v, depth + 1) ?? v) : v; });
        out = p.to.replace(/\{(\d+)\}/g, (_, n) => vals[n] ?? '');
        break;
      }
    }
    // "Guide · Product Documentation": localize each part on its own (names stay as written).
    if (out == null && depth < 2 && core.includes(' · ')) {
      const segs = core.split(' · '), done = segs.map(s => (workspaceNames().has(s.trim()) ? null : tr(s, depth + 1)));
      if (done.some(x => x != null)) out = segs.map((s, i) => done[i] ?? s).join(' · ');
    }
    d.memo.set(core, out);
  }
  return out == null ? null : m[1] + out + m[3];
}

function localizeText(node) {
  const p = node.parentElement; if (!p || p.closest(SKIP_SEL)) return;
  const v = node.nodeValue.trim();
  if (v && workspaceNames().has(v) && !p.closest(CHROME_SEL)) return;
  const r = tr(node.nodeValue); if (r != null && r !== node.nodeValue) node.nodeValue = r;
}
function localizeAttrs(el) {
  if (el.closest(SKIP_SEL) && !el.matches('textarea')) return;
  for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const r = tr(v); if (r != null && r !== v) el.setAttribute(a, r); } }
}
/** Localize a subtree in place (no-op in English). */
function localize(root) {
  if (S.lang === 'en' || !root) return;
  if (root.nodeType === 3) return localizeText(root);
  if (root.nodeType !== 1) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) localizeText(n);
  localizeAttrs(root);
  root.querySelectorAll(ATTRS.map(a => `[${a}]`).join(',')).forEach(localizeAttrs);
}
new MutationObserver(muts => {
  if (S.lang === 'en') return;
  _names = null; // workspace records may have changed since the last render
  for (const m of muts) m.addedNodes.forEach(localize);
}).observe(document.documentElement, { childList: true, subtree: true });

const langName = (code = S.lang) => (UI_LANGS.find(l => l[0] === code) || UI_LANGS[0])[1];
function applyLang() { document.documentElement.lang = S.lang; }
/** Switch the interface language: re-render so every screen is rebuilt in it. */
function setLang(code) {
  if (!UI_LANGS.some(l => l[0] === code) || code === S.lang) return;
  S.lang = code; applyLang(); persist(); refresh(); localize(document.body);
}

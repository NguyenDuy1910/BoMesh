import { useSyncExternalStore } from "react";

import { LANGUAGE_STORAGE_KEY } from "@/lib/theme";

/**
 * Interface language — a personal setting (English | Tiếng Việt), ported
 * from the UX preview (`scripts/core/i18n.js`).
 *
 * Screens are written in English; when another language is active a
 * MutationObserver localizes every rendered node before paint using that
 * language's dictionary (`src/i18n/<lang>.ts`, loaded lazily):
 *   exact:    "Save"         → "Lưu"
 *   patterns: "Updated {0}"  → "Cập nhật {0}" ({n} captures runtime values,
 *                              which are themselves localized when known)
 * Text nodes plus placeholder / aria-label / title / data-tip / alt are
 * covered, including later React updates of the same node. Every change is
 * reversible: switching back to English restores the original strings.
 *
 * Content is never translated: documents, answers, quotes, user input and
 * workspace data stay in the language they were written in. Mark content
 * with `translate="no"`.
 */

export type Language = "en" | "vi";

export interface LanguageOption {
  code: Language;
  /** Name in the language itself. */
  native: string;
  /** English name. */
  english: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: "en", native: "English", english: "English" },
  { code: "vi", native: "Tiếng Việt", english: "Vietnamese" },
];

const SKIP_SEL =
  '[translate="no"], .chat-answer, .chat-bubble, .doc-page, .doc-note, .chat-cite__quote, .home-suggest__chip, .chat-starter__prompt, script, style, textarea, code, pre, [contenteditable="true"]';
const ATTRS = ["placeholder", "aria-label", "title", "data-tip", "alt"] as const;

interface Pattern {
  re: RegExp;
  order: number[];
  to: string;
  lit: string;
  weight: number;
}
interface Dictionary {
  exact: Map<string, string>;
  patterns: Pattern[];
  memo: Map<string, string | null>;
  nouns: Record<string, string>;
}

const dictionaries: Partial<Record<Language, Dictionary>> = {};

function isLanguage(v: unknown): v is Language {
  return v === "en" || v === "vi";
}

/** Compile a source dictionary into exact entries and placeholder patterns. */
function compile(src: Record<string, string>, nouns: Record<string, string>): Dictionary {
  const exact = new Map<string, string>();
  const patterns: Pattern[] = [];
  const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const [k, v] of Object.entries(src)) {
    if (!v) continue;
    const key = k.replace(/\s+/g, " ").trim();
    if (!/\{\d+\}/.test(key)) {
      exact.set(key, v);
      continue;
    }
    // A placeholder glued to a word ("need{1}", "document{1}") is an English plural suffix: optional, and dropped in translation.
    const suffix = new Set([...key.matchAll(/[a-z]{2}\{(\d+)\}/g)].map((x) => Number(x[1])));
    const parts = key.split(/(\{\d+\})/);
    const order: number[] = [];
    const re = parts
      .map((p) => {
        const m = /^\{(\d+)\}$/.exec(p);
        if (m) {
          order.push(Number(m[1]));
          return suffix.has(Number(m[1])) ? "([a-z]{0,2})" : "([\\s\\S]+?)";
        }
        return reEsc(p);
      })
      .join("");
    const lits = parts
      .filter((p) => p && !/^\{\d+\}$/.test(p))
      .map((p) => p.trim())
      .filter(Boolean);
    const lit = lits.sort((a, b) => b.length - a.length)[0] ?? "";
    // Patterns must carry real words: "{0} in {1}" would rewrite any sentence containing "in".
    const letters = lits.join("").replace(/[^A-Za-z]/g, "").length;
    const open = /^\{\d+\}/.test(key) && /\{\d+\}$/.test(key);
    if (letters < (open ? 8 : 3)) continue;
    const to = suffix.size
      ? v
          .replace(/\{(\d+)\}/g, (all, n: string) => (suffix.has(Number(n)) ? "" : all))
          .replace(/\s+([.,;:!?])/g, "$1")
          .replace(/\s{2,}/g, " ")
      : v;
    patterns.push({ re: new RegExp("^" + re + "$"), order, to, lit, weight: key.replace(/\{\d+\}/g, "").length });
  }
  patterns.sort((a, b) => b.weight - a.weight);
  return { exact, patterns, memo: new Map(), nouns };
}

async function loadDictionary(lang: Language): Promise<Dictionary | null> {
  if (lang === "en") return null;
  if (!dictionaries[lang]) {
    // Lazy: the ~3,700-entry dictionary is a separate chunk that only Vietnamese sessions download.
    const mod = await import("@/i18n/vi");
    dictionaries[lang] = compile(mod.VI, mod.VI_NOUNS);
  }
  return dictionaries[lang] ?? null;
}

/* ── State ── */

let current: Language = "en";
let started = false;
const listeners = new Set<() => void>();
const changeListeners = new Set<(lang: Language) => void>();

function storedLanguage(): Language | null {
  const v = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  return isLanguage(v) ? v : null;
}

/** Whether this device has an explicit language (else the account's saved one may apply). */
export function hasStoredLanguage(): boolean {
  return typeof window !== "undefined" && storedLanguage() !== null;
}

export function getLanguage(): Language {
  return current;
}

const activeDictionary = () => (current === "en" ? null : (dictionaries[current] ?? null));

/** Localize one string; null when there's nothing to change. */
export function tr(text: string | null | undefined, depth = 0): string | null {
  const d = activeDictionary();
  if (!d || text == null) return null;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(String(text))!;
  const core = m[2].replace(/\s+/g, " ");
  if (!core || !/[A-Za-z]/.test(core)) return null;
  let out = d.memo.get(core);
  if (out === undefined) {
    out = d.exact.get(core) ?? null;
    if (out == null) {
      for (const p of d.patterns) {
        if (!core.includes(p.lit)) continue;
        const mm = p.re.exec(core);
        if (!mm) continue;
        const vals: Record<number, string> = {};
        p.order.forEach((n, i) => {
          const v = mm[i + 1];
          vals[n] = depth < 2 ? (tr(v, depth + 1) ?? v) : v;
        });
        out = p.to.replace(/\{(\d+)\}/g, (_, n: string) => vals[Number(n)] ?? "");
        break;
      }
    }
    // "Guide · Product Documentation": localize each part on its own.
    if (out == null && depth < 2 && core.includes(" · ")) {
      const segs = core.split(" · ");
      const done = segs.map((s) => tr(s, depth + 1));
      if (done.some((x) => x != null)) out = segs.map((s, i) => done[i] ?? s).join(" · ");
    }
    d.memo.set(core, out);
  }
  return out == null ? null : m[1] + out + m[3];
}

/** Counter noun for `plural()`: the active language's word for a singular English noun, if it has one. */
export function uiNoun(one: string): string | undefined {
  return activeDictionary()?.nouns[one];
}

/* ── DOM localizer (reversible) ── */

/** What a node said in English and what we wrote over it. */
const textState = new WeakMap<Text, { source: string; shown: string }>();
const attrState = new WeakMap<Element, Map<string, { source: string; shown: string }>>();

function localizeText(node: Text) {
  const p = node.parentElement;
  if (!p || p.closest(SKIP_SEL)) return;
  const value = node.nodeValue ?? "";
  const known = textState.get(node);
  if (known && value === known.shown) return;
  const r = tr(value);
  if (r != null && r !== value) {
    textState.set(node, { source: value, shown: r });
    node.nodeValue = r;
  } else if (known) textState.delete(node);
}

function localizeAttr(el: Element, attr: string) {
  const value = el.getAttribute(attr);
  if (!value) return;
  let states = attrState.get(el);
  const known = states?.get(attr);
  if (known && value === known.shown) return;
  const r = tr(value);
  if (r != null && r !== value) {
    if (!states) attrState.set(el, (states = new Map()));
    states.set(attr, { source: value, shown: r });
    el.setAttribute(attr, r);
  } else states?.delete(attr);
}

function localizeAttrs(el: Element) {
  if (el.closest(SKIP_SEL) && !el.matches("textarea")) return;
  for (const a of ATTRS) localizeAttr(el, a);
}

/** Localize a subtree in place (no-op in English). */
function localize(root: Node | null) {
  if (current === "en" || !root) return;
  if (root.nodeType === Node.TEXT_NODE) return localizeText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) localizeText(n as Text);
  const el = root as Element;
  localizeAttrs(el);
  el.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(",")).forEach(localizeAttrs);
}

/** Put every string we localized back to its English source. */
function revert(root: Element) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n as Text;
    const known = textState.get(t);
    if (known && t.nodeValue === known.shown) t.nodeValue = known.source;
    textState.delete(t);
  }
  const revertEl = (el: Element) => {
    const states = attrState.get(el);
    if (!states) return;
    for (const [attr, s] of states) if (el.getAttribute(attr) === s.shown) el.setAttribute(attr, s.source);
    attrState.delete(el);
  };
  revertEl(root);
  root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(",")).forEach(revertEl);
}

let observer: MutationObserver | null = null;

function observe() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    if (current === "en") return;
    for (const m of mutations) {
      if (m.type === "childList") m.addedNodes.forEach(localize);
      else if (m.type === "characterData") localizeText(m.target as Text);
      else if (m.type === "attributes" && m.attributeName) {
        const el = m.target as Element;
        if (!el.closest(SKIP_SEL) || el.matches("textarea")) localizeAttr(el, m.attributeName);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
}

function emit() {
  for (const l of listeners) l();
}

async function activate(lang: Language) {
  if (lang !== "en") await loadDictionary(lang);
  const before = current;
  current = lang;
  document.documentElement.lang = lang;
  if (lang === "en") {
    if (before !== "en") revert(document.documentElement);
  } else {
    observe();
    localize(document.body);
    const title = document.querySelector("title");
    if (title) localize(title);
  }
  emit();
}

/**
 * Starts the localizer with this device's language. Called once by the root
 * providers after hydration (the server renders English).
 */
export function startLocalizer(): void {
  if (started) return;
  started = true;
  const lang = storedLanguage() ?? "en";
  if (lang !== "en") void activate(lang);
  else document.documentElement.lang = "en";
  window.addEventListener("storage", (e) => {
    if (e.key !== LANGUAGE_STORAGE_KEY) return;
    const next = storedLanguage() ?? "en";
    if (next !== current) void activate(next);
  });
}

/**
 * Switch the interface language. `origin: "user"` notifies change listeners
 * (the shell saves it to the account); `"sync"` applies the account's value.
 */
export async function setLanguage(lang: Language, origin: "user" | "sync" = "user"): Promise<void> {
  if (!isLanguage(lang)) return;
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  if (lang !== current) await activate(lang);
  if (origin === "user") for (const l of changeListeners) l(lang);
}

/** Called for user-made language changes (not account sync). */
export function onLanguageChange(fn: (lang: Language) => void): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

export function languageName(code: Language = current): string {
  return (LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]).native;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The active interface language and its setter. */
export function useLanguage(): [Language, (lang: Language) => void] {
  const lang = useSyncExternalStore(subscribe, getLanguage, () => "en" as Language);
  return [lang, (next) => void setLanguage(next)];
}

import { VI_NOUNS } from "@/i18n/nouns";
import { messages, type Messages } from "@/i18n/messages";

/**
 * Interface language: Vietnamese only, for now (a later phase designs multilingual support).
 *
 * Every interface string is written in Vietnamese where it renders (components, or the catalog `src/i18n/messages`
 * read with `useMessages()`), so the server and the first paint already show Vietnamese; nothing rewrites the page.
 *
 * The one translation left is text the server sends in English (error messages, field violations): `tr()` looks it up
 * in `src/i18n/vi.ts` (exact strings and `{0}` patterns). That dictionary loads in the background on startup
 * (`preloadServerText`); until it has, `tr()` returns null and callers show the server's text.
 *
 * Content is never translated: documents, answers, quotes, user input and workspace data stay as written.
 */

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
}

let dictionary: Dictionary | null = null;
let loading: Promise<void> | null = null;

/** Compile the dictionary into exact entries and placeholder patterns. */
function compile(src: Record<string, string>): Dictionary {
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
  return { exact, patterns, memo: new Map() };
}

/** Start loading the server-text dictionary (a separate chunk); idempotent. Called once at startup. */
export function preloadServerText(): Promise<void> {
  loading ??= import("@/i18n/vi").then((mod) => {
    dictionary = compile(mod.VI);
  });
  return loading;
}

/** Vietnamese for English text the server sent (an error message, a field violation); null when unknown. */
export function tr(text: string | null | undefined, depth = 0): string | null {
  const d = dictionary;
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
    d.memo.set(core, out);
  }
  return out == null ? null : m[1] + out + m[3];
}

/** Server text in Vietnamese when known, else as sent. */
export const serverText = (text: string): string => tr(text) ?? text;

/** Counter noun for `plural()`: the Vietnamese word for a singular English noun, if it has one. */
export function uiNoun(one: string): string | undefined {
  return VI_NOUNS[one];
}

/** The interface message catalog. */
export function useMessages(): Messages {
  return messages;
}

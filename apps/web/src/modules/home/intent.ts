/**
 * Home's box (preview `home.js` hero): what the text most likely means and the
 * options the combobox offers for it. Pure, so the ranking is testable.
 */

const QUESTION = /^(how|what|when|where|why|who|which|can|could|do|does|did|is|are|should|tell me|explain|summari[sz]e)\b/i;

/** Text that reads like a question defaults to Ask; anything else to finding documents. */
export const isQuestion = (q: string) => /\?\s*$/.test(q) || QUESTION.test(q.trim());

/** "Good morning" / "Good afternoon" / "Good evening" for the local hour. */
export function greeting(hour = new Date().getHours()): string {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** How Home addresses someone: the given name (last word for three-part Vietnamese names, else the first; never a bare number). */
export function callName(name: string | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  return parts.length >= 3 && /\p{L}/u.test(last) ? last : (parts[0] ?? "");
}

export interface DocHit {
  /** Bare item ID. */
  id: string;
  title: string;
  /** File name or extension for the file tile. */
  fileName: string;
  mime: string;
  kindLabel: string;
}

export interface PastQuestion {
  /** Bare conversation ID. */
  id: string;
  title: string;
  at?: string;
}

export type HomeOption =
  | { kind: "ask"; q: string; group?: string }
  | { kind: "find"; q: string; group?: undefined }
  | { kind: "doc"; q: string; doc: DocHit; group: "Documents" }
  | { kind: "conv"; conv: PastQuestion; group: "You asked" | "Continue a conversation" };

export interface OptionInput {
  text: string;
  /** Catalog search hits for the text (already scoped and permission-filtered). */
  docs: readonly DocHit[];
  /** The caller's conversations, most recent first. */
  questions: readonly PastQuestion[];
  /** Role-aware suggested questions. */
  starters: readonly string[];
  /** Folds and tokenizes text the way the catalog highlights it. */
  tokens: (q: string) => string[];
  fold: (s: string) => string;
}

/**
 * Typed text: both actions (the likely one first), up to four matching documents and two earlier
 * questions. Empty text: three recent questions, then suggested questions not already asked.
 */
export function homeOptions({ text, docs, questions, starters, tokens, fold }: OptionInput): HomeOption[] {
  const q = text.trim();
  if (q) {
    const ask: HomeOption = { kind: "ask", q };
    const find: HomeOption = { kind: "find", q };
    const out: HomeOption[] = isQuestion(q) ? [ask, find] : [find, ask];
    for (const doc of docs.slice(0, 4)) out.push({ kind: "doc", q, doc, group: "Documents" });
    const toks = tokens(q);
    if (toks.length)
      for (const conv of questions.filter((c) => toks.every((t) => fold(c.title).includes(t))).slice(0, 2)) out.push({ kind: "conv", conv, group: "You asked" });
    return out;
  }
  const recent = questions.slice(0, 3);
  const out: HomeOption[] = recent.map((conv) => ({ kind: "conv", conv, group: "Continue a conversation" }));
  const seen = new Set(recent.map((c) => fold(c.title)));
  for (const s of starters.filter((s) => !seen.has(fold(s))).slice(0, 4 - Math.min(recent.length, 2))) out.push({ kind: "ask", q: s, group: "Ask" });
  return out;
}

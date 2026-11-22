/**
 * Sources of a stored answer (`Message.citations`, conversation_loop.md
 * "Citations in an answer").
 *
 * The server lists the cited passages once each, in first-use order, and the
 * text carries one `[n]` per *document* in that same order — so grouping the
 * passages by document numbers them. Answers saved before per-document
 * numbering used one number per passage: when the text has as many distinct
 * markers as passages but fewer documents, each old number resolves to its
 * passage's document (an alias). Citations the reader can no longer open
 * (`available: false`, nothing else set) keep their number but no document.
 *
 * Pure and dependency-free so it runs under `node --test`.
 */

import type { AnswerSource } from "./turn.ts";

export interface StoredCitation {
  passage?: string;
  item?: string;
  displayName?: string;
  pageNumber?: number;
  excerpt?: string;
  available: boolean;
  /** The cited document has a newer revision than the answer (computed on read). */
  outdated?: boolean;
  /** That newer revision's create time. */
  updateTime?: string;
}

const MARKER = /\[(\d{1,3})\]/g;

/** Distinct `[n]` numbers in the text, in order of first appearance. */
export function markerNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MARKER)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function sourcesFromCitations(text: string, citations: readonly StoredCitation[]): AnswerSource[] {
  // One entry per citation, then one group per document (unavailable ones stay separate).
  const groups: AnswerSource[] = [];
  const groupOf: AnswerSource[] = [];
  for (const c of citations) {
    let group = c.available && c.item ? groups.find((g) => g.item === c.item) : undefined;
    if (!group) {
      group = { n: groups.length + 1, item: c.available ? c.item ?? "" : "", title: c.displayName ?? "", passages: [], available: c.available };
      groups.push(group);
    }
    if (c.available && c.outdated) {
      group.outdated = true;
      group.updateTime = c.updateTime;
    }
    if (c.available && c.passage) group.passages.push({ passage: c.passage, page: c.pageNumber, excerpt: c.excerpt });
    groupOf.push(group);
  }
  const markers = markerNumbers(text);
  const perPassage = groups.length < citations.length && markers.length > groups.length && Math.max(0, ...markers) <= citations.length;
  if (perPassage) {
    // Each old number is its passage's position; a document answers to all of them.
    for (const group of groups) group.n = 0;
    citations.forEach((_, i) => {
      const group = groupOf[i]!;
      if (!group.n) group.n = i + 1;
      else group.aliases = [...(group.aliases ?? []), i + 1];
    });
  }
  return groups;
}

/** Sources the reader can open that changed after the answer was written, most recent change first (preview `changedSources`). */
export function changedSources(sources: readonly AnswerSource[]): AnswerSource[] {
  return sources.filter((s) => s.available && s.outdated).sort((a, b) => (b.updateTime ?? "").localeCompare(a.updateTime ?? ""));
}

export type Freshness =
  /** The latest attempt relies on sources that changed: offer Update answer. */
  | { kind: "outdated"; changed: AnswerSource[] }
  /** An earlier attempt, written before its sources changed: offer the latest. */
  | { kind: "earlier" }
  /** The latest attempt replaced one whose sources had changed: name what it was updated from. */
  | { kind: "updated"; from: AnswerSource }
  | null;

/**
 * What to say above the shown attempt of an answer (preview `freshnessHtml`). `attempts` are oldest first, the last one is
 * the latest; only a settled latest attempt is ever offered an update.
 */
export function answerFreshness(attempts: readonly { sources: readonly AnswerSource[]; state: string }[], index: number): Freshness {
  const last = attempts.length - 1;
  const shown = attempts[index];
  if (!shown) return null;
  if (index < last) return changedSources(shown.sources).length ? { kind: "earlier" } : null;
  if (shown.state !== "COMPLETED") return null;
  const changed = changedSources(shown.sources);
  if (changed.length) return { kind: "outdated", changed };
  const before = last > 0 ? changedSources(attempts[last - 1]!.sources) : [];
  return before.length ? { kind: "updated", from: before[0]! } : null;
}

/** Number → source, aliases included. */
export function sourceLookup(sources: readonly AnswerSource[]): Map<number, AnswerSource> {
  const map = new Map<number, AnswerSource>();
  for (const s of sources) {
    map.set(s.n, s);
    for (const a of s.aliases ?? []) map.set(a, s);
  }
  return map;
}

/** Answer text for the clipboard: links, emphasis, markers and table rows removed (preview `plain`). */
export function plainAnswer(text: string): string {
  return String(text || "")
    .replace(/\[([^\]]+)\]\((?:[^)\s]*)\)/g, "$1")
    .replace(/\*\*|\*/g, "")
    .replace(/\s?\[\d+\]/g, "")
    .replace(/^\|.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A short conversation title from the first question (preview `makeTitle`). */
export function makeTitle(question: string): string {
  const words = question.replace(/\s+/g, " ").trim().split(" ");
  let title = words.slice(0, 6).join(" ").replace(/[?.!,:;]+$/, "");
  if (words.length > 6) title += "…";
  return title.charAt(0).toUpperCase() + title.slice(1);
}

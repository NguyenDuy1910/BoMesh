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

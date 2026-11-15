import { CircleDashed, Clock, StickyNote, Tag, User, type LucideIcon } from "lucide-react";

import type { Item, Topic } from "@/modules/knowledge/api";
import { fold, type Resource } from "@/modules/knowledge/model";

import type { TopicCorrection } from "./api";

/**
 * Knowledge Studio → Documents → Issues and Quality (preview `features/governance.js`), and the topics'
 * pure helpers: signals over the API. Scope = published documents in shared collections the caller can edit.
 */

/* ═══════════════ Scope ═══════════════ */

/** Published documents the caller looks after (editor/owner on a shared collection; personal ones are excluded upstream). */
export const inScope = (r: Resource) => r.editable && !r.isPersonal && !r.deleted && r.item.document?.publicationState === "PUBLISHED";

const issues = (item: Item) => item.document?.qualityIssues ?? [];
const hasIssue = (item: Item, kind: string) => issues(item).some((i) => i.kind === kind);

/** One line above each queue: what it finds and what to do about it (counts live on the queue chooser). */
export const QUEUE_HINT = {
  problems: "Couldn’t be processed, or changed at the source since it was. Each row shows its fix; select several to process them again together.",
  reverify: "Verification expired or never happened. Verify what’s still right.",
  details: "Documents without a topic, owner or summary are harder to find. Fill in what’s missing.",
  duplicates: "Near-identical documents compete in answers. Compare each pair and keep one.",
} as const;

/* ═══════════════ Re-verification due ═══════════════ */

/** A document that changed at its source is a publishing state (Documents → Issues), not a trust check. */
export type ReasonKey = "expired" | "never";

export const REASONS: Readonly<Record<ReasonKey, { label: string; icon: LucideIcon; rank: number }>> = {
  expired: { label: "Verification expired", icon: Clock, rank: 0 },
  never: { label: "Never verified", icon: CircleDashed, rank: 1 },
};

export interface ReviewEntry {
  r: Resource;
  reason: ReasonKey;
  note: string;
  /** Next review time (ms) when known. */
  due: number | null;
}

/** Why a document needs its owner to re-verify it, else null. */
export function reviewEntry(r: Resource): ReviewEntry | null {
  const doc = r.item.document;
  if (doc?.indexingState === "OUTDATED" || hasIssue(r.item, "CHANGED_AT_SOURCE")) return null;
  const dueIso = doc?.verification?.nextReviewTime;
  const due = dueIso ? Date.parse(dueIso) : null;
  if (r.trust.state === "review" || hasIssue(r.item, "REVIEW_DUE")) return { r, reason: "expired", note: r.trust.note, due };
  if (r.trust.state === "unverified" && doc?.indexingState === "SUCCEEDED") return { r, reason: "never", note: r.trust.note, due: null };
  return null;
}

export function reviewEntries(pool: readonly Resource[]): ReviewEntry[] {
  return pool
    .map(reviewEntry)
    .filter((x): x is ReviewEntry => !!x)
    .sort((a, b) => REASONS[a.reason].rank - REASONS[b.reason].rank || (a.due ?? 9e15) - (b.due ?? 9e15) || a.r.title.localeCompare(b.r.title));
}

/* ═══════════════ Missing details ═══════════════ */

export type GapKey = "topic" | "owner" | "summary";

export const GAPS: Readonly<Record<GapKey, { label: string; icon: LucideIcon; noun: string }>> = {
  topic: { label: "No topic", icon: Tag, noun: "a topic" },
  owner: { label: "No owner", icon: User, noun: "an owner" },
  summary: { label: "No summary", icon: StickyNote, noun: "a summary" },
};

export const GAP_KEYS = Object.keys(GAPS) as GapKey[];

export interface DetailEntry {
  r: Resource;
  gaps: GapKey[];
}

export function gapsOf(r: Resource): GapKey[] {
  const out: GapKey[] = [];
  if (!r.topics.length) out.push("topic");
  if (!r.owner) out.push("owner");
  if (!r.summary.trim()) out.push("summary");
  return out;
}

export const detailEntries = (pool: readonly Resource[]): DetailEntry[] => pool.map((r) => ({ r, gaps: gapsOf(r) })).filter((x) => x.gaps.length);

/* ═══════════════ Possible duplicates ═══════════════ */

export interface DuplicatePair {
  /** Sorted pair of item IDs. */
  key: string;
  /** Newer copy (kept by default). */
  keep: Resource;
  dup: Resource;
  reason: string;
}

/** Pairs from `POSSIBLE_DUPLICATE` issues (deduplicated a↔b); the newer copy is kept by default. */
export function duplicatePairs(pool: readonly Resource[], visible: ReadonlyMap<string, Resource>): DuplicatePair[] {
  const pairs = new Map<string, DuplicatePair>();
  for (const a of pool) {
    for (const issue of issues(a.item)) {
      if (issue.kind !== "POSSIBLE_DUPLICATE" || !issue.relatedItem) continue;
      const b = visible.get(issue.relatedItem);
      if (!b || b.deleted || b.name === a.name) continue;
      const key = [a.id, b.id].sort().join("|");
      if (pairs.has(key)) continue;
      const [keep, dup] = Date.parse(a.updated ?? "") >= Date.parse(b.updated ?? "") ? [a, b] : [b, a];
      pairs.set(key, { key, keep, dup, reason: "Processing found nearly identical text" });
    }
  }
  return [...pairs.values()];
}

/** Case/diacritics-insensitive substring match over several fields. */
export function matches(q: string, ...fields: (string | undefined | null)[]): boolean {
  const needle = fold(q.trim());
  return !needle || fields.some((f) => !!f && fold(f).includes(needle));
}

/* ═══════════════ Topics ═══════════════ */

/** Collapses whitespace in a typed name. */
export const cleanName = (s: string) => s.trim().replace(/\s+/g, " ");

const live = (t: Topic) => t.state === "ACTIVE";

/** Active domains, in API order. */
export const activeDomains = (topics: readonly Topic[]) => topics.filter((t) => t.kind === "DOMAIN" && live(t));

/** Active topics of a domain. */
export const topicsOf = (topics: readonly Topic[], domain: string) => topics.filter((t) => t.kind === "TOPIC" && live(t) && t.parentTopic === domain);

/** A same-level name clash among active topics (`parent` null = domains), ignoring `except`. */
export function nameTaken(topics: readonly Topic[], name: string, parent: string | null, except?: string): boolean {
  const n = fold(name);
  return topics.some(
    (t) => live(t) && t.name !== except && (parent ? t.kind === "TOPIC" && t.parentTopic === parent : t.kind === "DOMAIN") && fold(t.displayName ?? "") === n,
  );
}

export interface TopicCounts {
  topic: (name: string) => number;
  review: (name: string) => number;
  domain: (name: string) => number;
  reviewDomain: (name: string) => number;
}

/**
 * Published / in-review counts. Topics use the server's `documentCount` / `inReviewCount`;
 * domains count distinct documents (and open submissions) tagged with any of their topics.
 * Callers may read only some documents, so a domain never shows less than its busiest topic.
 */
export function topicCounts(topics: readonly Topic[], published: readonly Item[], inReview: readonly (readonly string[])[]): TopicCounts {
  const byName = new Map(topics.map((t) => [t.name ?? "", t]));
  const domainOf = (name: string) => {
    const t = byName.get(name);
    return t?.kind === "TOPIC" ? (t.parentTopic ?? "") : name;
  };
  const tally = (lists: readonly (readonly string[])[]) => {
    const out = new Map<string, number>();
    for (const list of lists) for (const d of new Set(list.map(domainOf).filter(Boolean))) out.set(d, (out.get(d) ?? 0) + 1);
    return out;
  };
  const busiest = (pick: (t: Topic) => number | undefined) => {
    const out = new Map<string, number>();
    for (const t of topics) {
      const d = t.kind === "TOPIC" ? t.parentTopic : t.name;
      if (d && live(t)) out.set(d, Math.max(out.get(d) ?? 0, pick(t) ?? 0));
    }
    return out;
  };
  const docDomains = tally(published.map((it) => it.document?.topics ?? []));
  const reviewDomains = tally(inReview);
  const docFloor = busiest((t) => t.documentCount);
  const reviewFloor = busiest((t) => t.inReviewCount);
  return {
    topic: (name) => byName.get(name)?.documentCount ?? 0,
    review: (name) => byName.get(name)?.inReviewCount ?? 0,
    domain: (name) => Math.max(docDomains.get(name) ?? 0, docFloor.get(name) ?? 0),
    reviewDomain: (name) => Math.max(reviewDomains.get(name) ?? 0, reviewFloor.get(name) ?? 0),
  };
}

/** Published documents per collection tagged with any of `topics` (a topic, or a domain and its topics), busiest first. */
export function distribution(published: readonly Resource[], topics: readonly string[]): { base: NonNullable<Resource["base"]>; n: number }[] {
  const want = new Set(topics);
  const m = new Map<string, { base: NonNullable<Resource["base"]>; n: number }>();
  for (const r of published) {
    if (!r.base || !r.topics.some((t) => want.has(t))) continue;
    const cur = m.get(r.base.name);
    if (cur) cur.n += 1;
    else m.set(r.base.name, { base: r.base, n: 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n);
}

/* ═══════════════ Topics → Suggestions ═══════════════ */

/** Words that say nothing about a topic on their own (titles are full of them). */
const PHRASE_STOP = new Set(["the", "and", "for", "with", "from", "about", "into", "guide", "policy", "procedure", "template", "notes", "report", "update", "draft", "final", "sop", "quy trình", "hướng dẫn", "biểu mẫu", "giao dịch", "tài liệu"]);

/**
 * Candidate keywords in a title (preview `phrasesOf`), in its own spelling, lower-case: two-word phrases, plus single
 * words in an English title (a Vietnamese syllable alone means little) and acronyms in any title (NAPAS). A pair never
 * borrows a word from a stop phrase ("giao dịch", "hướng dẫn"): "soát giao" means nothing. Numbers and versions don't count.
 */
export function phrasesOf(title: string): string[] {
  const raw = title.replace(/\.[a-z0-9]{1,5}$/i, "").normalize("NFC");
  const vi = /[^\u0000-\u007f]/.test(raw.replace(/[—–’“”]/g, ""));
  const orig = raw.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? [];
  const words = orig.map((w) => w.toLowerCase()).filter((w) => !/^(v?\d+|\d{4})$/.test(w));
  const used = new Set(words.flatMap((w, i) => (PHRASE_STOP.has(`${w} ${words[i + 1]}`) ? [i, i + 1] : [])));
  const ok = (w: string, i: number) => w.length >= 3 && !PHRASE_STOP.has(w) && !used.has(i);
  const pairs = words
    .slice(1)
    .map((b, i) => [i, words[i], b] as const)
    .filter(([i, a, b]) => ok(a, i) && ok(b, i + 1))
    .map(([, a, b]) => `${a} ${b}`);
  const singles = vi ? orig.filter((w) => /^[A-Z]{3,}$/.test(w)).map((w) => w.toLowerCase()) : words.filter((w, i) => w.length >= 4 && ok(w, i));
  return [...new Set([...pairs, ...singles])];
}

/** A phrase the corrected titles share: `n` titles carry it; `elsewhere` = the other topic it is a keyword or synonym of. */
export interface PhraseHit {
  text: string;
  n: number;
  elsewhere: string;
}

export interface CorrectionSuggestion {
  topic: Topic;
  corrections: TopicCorrection[];
  /** The assistant's topics the reviewers removed (topic names). */
  from: string[];
  /** Keyword candidates: shared by two or more titles and no topic's keyword yet (at most four). */
  phrases: PhraseHit[];
  /** Words in those titles that are another topic's keyword: why the assistant filed them there (at most three). */
  misled: PhraseHit[];
}

/** A topic's keywords and synonyms (they count alike when classifying). */
export const topicSignals = (t: Topic) => [...(t.keywords ?? []), ...(t.synonyms ?? [])];

/**
 * What open corrections suggest, per active topic reviewers moved documents to (preview `correctionSuggestions`),
 * biggest group first. A correction without a visible title counts toward its group but gives no phrases.
 */
export function correctionSuggestions(corrections: readonly TopicCorrection[], topics: readonly Topic[]): CorrectionSuggestion[] {
  const leaves = topics.filter((t) => t.kind === "TOPIC" && live(t));
  const byName = new Map(leaves.map((t) => [t.name ?? "", t]));
  const by = new Map<string, TopicCorrection[]>();
  for (const c of corrections) {
    const from = c.fromTopics ?? [];
    for (const to of new Set(c.toTopics ?? [])) {
      if (from.includes(to) || !byName.has(to)) continue;
      const list = by.get(to);
      if (list) list.push(c);
      else by.set(to, [c]);
    }
  }
  /** Folded keyword or synonym → the topics that carry it. */
  const owners = new Map<string, string[]>();
  for (const t of leaves) for (const k of new Set(topicSignals(t).map(fold))) owners.set(k, [...(owners.get(k) ?? []), t.name ?? ""]);
  return [...by]
    .map(([name, cs]) => {
      const topic = byName.get(name)!;
      const own = new Set([...topicSignals(topic), topic.displayName ?? ""].map(fold));
      const count = new Map<string, number>();
      for (const c of cs) for (const p of phrasesOf(c.itemDisplayName ?? "")) count.set(p, (count.get(p) ?? 0) + 1);
      const all = [...count]
        .filter(([p]) => !own.has(fold(p)))
        .map(([text, n]) => ({ text, n, elsewhere: owners.get(fold(text))?.find((o) => o !== name) ?? "" }))
        .sort((a, b) => b.n - a.n || b.text.split(" ").length - a.text.split(" ").length || a.text.localeCompare(b.text));
      const from = [...new Set(cs.flatMap((c) => (c.fromTopics ?? []).filter((f) => !(c.toTopics ?? []).includes(f))))];
      return {
        topic,
        corrections: cs,
        from,
        phrases: all.filter((p) => !p.elsewhere && p.n >= 2).slice(0, 4),
        misled: all.filter((p) => p.elsewhere).slice(0, 3),
      };
    })
    .sort((a, b) => b.corrections.length - a.corrections.length);
}

/** The corrections whose titles contain `phrase` (they taught it). */
export const correctionsWith = (corrections: readonly TopicCorrection[], phrase: string) => corrections.filter((c) => fold(c.itemDisplayName ?? "").includes(fold(phrase)));

/** Documents carrying one topic the assistant applied, for Topics to confirm. */
export interface ConfirmGroup {
  topic: Topic;
  docs: Item[];
}

/** Assistant-applied topics (`document.assistantTopics`) that are active topics, with the documents carrying them, biggest first. */
export function confirmGroups(items: readonly Item[], topics: readonly Topic[]): ConfirmGroup[] {
  const active = new Map(topics.filter(live).map((t) => [t.name ?? "", t]));
  const by = new Map<string, Item[]>();
  for (const it of items) {
    for (const name of new Set(it.document?.assistantTopics ?? [])) {
      if (!active.has(name)) continue;
      const list = by.get(name);
      if (list) list.push(it);
      else by.set(name, [it]);
    }
  }
  return [...by]
    .map(([name, docs]) => ({ topic: active.get(name)!, docs }))
    .sort((a, b) => b.docs.length - a.docs.length || (a.topic.displayName ?? "").localeCompare(b.topic.displayName ?? ""));
}

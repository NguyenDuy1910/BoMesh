import { CircleDashed, Clock, RefreshCw, StickyNote, Tag, User, type LucideIcon } from "lucide-react";

import { fmtNum, plural } from "@/lib/format";
import type { Item, Topic } from "@/modules/knowledge/api";
import { fold, type Resource } from "@/modules/knowledge/model";

/**
 * Manage → Documents › Quality and Topics (preview `features/governance.js`): pure signals over
 * the API. Scope = published documents in shared knowledge bases the caller can edit.
 */

/* ═══════════════ Scope ═══════════════ */

/** Published documents the caller looks after (editor/owner on a shared base; personal bases are excluded upstream). */
export const inScope = (r: Resource) => r.editable && !r.isPersonal && !r.deleted && r.item.document?.publicationState === "PUBLISHED";

const issues = (item: Item) => item.document?.qualityIssues ?? [];
const hasIssue = (item: Item, kind: string) => issues(item).some((i) => i.kind === kind);

/* ═══════════════ Due for re-verification ═══════════════ */

export type ReasonKey = "source" | "expired" | "never";

export const REASONS: Readonly<Record<ReasonKey, { label: string; icon: LucideIcon; rank: number }>> = {
  source: { label: "Changed at source", icon: RefreshCw, rank: 0 },
  expired: { label: "Verification expired", icon: Clock, rank: 1 },
  never: { label: "Never verified", icon: CircleDashed, rank: 2 },
};

export interface ReviewEntry {
  r: Resource;
  reason: ReasonKey;
  note: string;
  /** Next review time (ms) when known. */
  due: number | null;
}

/** Why a document needs its owner's attention, else null. */
export function reviewEntry(r: Resource): ReviewEntry | null {
  const doc = r.item.document;
  const dueIso = doc?.verification?.nextReviewTime;
  const due = dueIso ? Date.parse(dueIso) : null;
  if (doc?.indexingState === "OUTDATED" || hasIssue(r.item, "CHANGED_AT_SOURCE")) {
    return { r, reason: "source", note: "The original changed at the source. Answers use the previous version until it’s reprocessed.", due };
  }
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

/* ═══════════════ Summary line ═══════════════ */

export function qualitySummary(pool: readonly Resource[], rv: number, dt: number, dp: number): string {
  if (!pool.length) return "You don’t look after any published documents yet.";
  const kbs = new Set(pool.map((r) => r.base?.name ?? "")).size;
  if (!rv && !dt && !dp) return `${plural(pool.length, "published document")} across ${plural(kbs, "knowledge base")} — all verified, described and unique.`;
  return `${plural(rv, "document")} due for re-verification, ${fmtNum(dt)} missing details and ${plural(dp, "possible duplicate")} across ${plural(kbs, "knowledge base")} you look after.`;
}

export const QUALITY_SEGS = ["reverify", "details", "duplicates"] as const;
export type QualitySeg = (typeof QUALITY_SEGS)[number];

/** `?seg=` (legacy `review` → reverify); unknown → the first segment with work, else reverify. */
export function resolveSeg(raw: string, counts: Readonly<Record<QualitySeg, number>>): QualitySeg {
  const want = raw === "review" ? "reverify" : raw;
  if ((QUALITY_SEGS as readonly string[]).includes(want)) return want as QualitySeg;
  return QUALITY_SEGS.find((k) => counts[k]) ?? "reverify";
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

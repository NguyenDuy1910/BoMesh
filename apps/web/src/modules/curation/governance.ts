import { CircleDashed, Clock, StickyNote, Tag, User, type LucideIcon } from "lucide-react";

import { fmtNum } from "@/lib/format";
import type { Concept, Item } from "@/modules/knowledge/api";
import { fold, type Resource } from "@/modules/knowledge/model";
import {
  classSchemes,
  conceptLabel,
  conceptsOf,
  descendantsOf,
  normLabel,
  resourceKey,
  schemeOfConcept,
  topConcepts,
  type Taxonomy,
} from "@/modules/knowledge/taxonomy";

import type { ConceptChange, ConceptLabel, ConceptReclassification, ConceptSchemeViolation, ConceptSchemeWarning, SharedLabel } from "./taxonomyApi";

/**
 * Knowledge Studio → Documents → Issues and Quality (preview `features/governance.js`), and Classification's pure
 * helpers (preview `features/masterdata.js`): signals over the API. Scope = published documents in shared collections
 * the caller can edit (the server filters in `./docFilter`).
 */

const issues = (item: Item) => item.document?.qualityIssues ?? [];
const hasIssue = (item: Item, kind: string) => issues(item).some((i) => i.kind === kind);

/** One line above each queue: what it finds and what to do about it (counts live on the queue chooser). */
export const QUEUE_HINT = {
  reverify: "Xác minh đã hết hạn hoặc chưa từng có. Hãy xác minh những gì vẫn đúng.",
  details: "Tài liệu thiếu phân loại, người phụ trách hoặc tóm tắt sẽ khó tìm và khó tin cậy hơn. Hãy bổ sung phần còn thiếu.",
  duplicates: "Các tài liệu gần giống nhau cạnh tranh trong câu trả lời. Hãy so sánh từng cặp và giữ lại một.",
} as const;

/* ═══════════════ Re-verification due ═══════════════ */

/** A document that changed at its source is a publishing state (Documents → Issues), not a trust check. */
export type ReasonKey = "expired" | "never";

export const REASONS: Readonly<Record<ReasonKey, { label: string; icon: LucideIcon; rank: number }>> = {
  expired: { label: "Xác minh đã hết hạn", icon: Clock, rank: 0 },
  never: { label: "Chưa từng xác minh", icon: CircleDashed, rank: 1 },
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

export type GapKey = "concept" | "owner" | "summary";

export const GAPS: Readonly<Record<GapKey, { label: string; icon: LucideIcon; noun: string }>> = {
  concept: { label: "Thiếu phân loại", icon: Tag, noun: "phân loại" },
  owner: { label: "Chưa có chủ sở hữu", icon: User, noun: "chủ sở hữu" },
  summary: { label: "Chưa có tóm tắt", icon: StickyNote, noun: "tóm tắt" },
};

export const GAP_KEYS = Object.keys(GAPS) as GapKey[];

export interface DetailEntry {
  r: Resource;
  gaps: GapKey[];
}

/** Classification schemes that require a label (`cardinality.min` > 0). */
export const requiredSchemes = (t: Taxonomy) => classSchemes(t).filter((s) => (s.cardinality?.min ?? 0) > 0);

/** The names of the schemes that require a label: Missing details' server filter (`conceptGap`). */
export const requiredSchemeNames = (t: Taxonomy): string[] => requiredSchemes(t).map((s) => s.name ?? "");

/** What a document lacks (preview `metadataGaps`): a classification (nothing accepted, or nothing accepted in a scheme
 *  that requires a label), an owner, a summary. */
export function gapsOf(r: Resource, t: Taxonomy): GapKey[] {
  const out: GapKey[] = [];
  const mine = new Set(r.concepts.map(schemeOfConcept));
  if (!mine.size || requiredSchemes(t).some((s) => !mine.has(s.name ?? ""))) out.push("concept");
  if (!r.owner) out.push("owner");
  if (!r.summary.trim()) out.push("summary");
  return out;
}

export const detailEntries = (pool: readonly Resource[], t: Taxonomy): DetailEntry[] => pool.map((r) => ({ r, gaps: gapsOf(r, t) })).filter((x) => x.gaps.length);

/** Case/diacritics-insensitive substring match over several fields. */
export function matches(q: string, ...fields: (string | undefined | null)[]): boolean {
  const needle = fold(q.trim());
  return !needle || fields.some((f) => !!f && fold(f).includes(needle));
}

/* ═══════════════ Classification (Studio › Phân loại) ═══════════════ */

/** Collapses whitespace in a typed name or label. */
export const cleanLabel = (s: string) => s.trim().replace(/\s+/g, " ");

/** A concept ID (`conceptId`, skos:notation): lower-case letters, digits and hyphens, starting with a letter. */
export const NOTATION_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** A notation made from a name (preview `newNotation`), unique among `taken`. */
export function newNotation(name: string, taken: ReadonlySet<string>): string {
  const base = (fold(name).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "concept").replace(/^[^a-z]+/, "c-").slice(0, 56);
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}-${i}`;
  return n;
}

/** Every notation a scheme's concepts hold (retired ones included: notations are never reused). */
export const schemeNotations = (t: Taxonomy, scheme: string): Set<string> => new Set(conceptsOf(t, scheme, { deprecated: true }).map((c) => resourceKey(c.name)));

/** The concept of `scheme` (other than `except`) whose preferred label is `name`, compared as the backend does. */
export function nameClash(t: Taxonomy, scheme: string, name: string, except = ""): Concept | undefined {
  const k = normLabel(name);
  return conceptsOf(t, scheme).find((c) => c.name !== except && (c.prefLabels ?? []).some((l) => normLabel(l.text) === k));
}

/** A label's field on Concept, by kind. */
export const LABEL_FIELD = { PREF: "prefLabels", ALT: "altLabels", HIDDEN: "hiddenLabels" } as const;
export type LabelKind = keyof typeof LABEL_FIELD;
export const LABEL_KIND_TEXT: Readonly<Record<LabelKind, string>> = { PREF: "Nhãn chính", ALT: "Nhãn thay thế", HIDDEN: "Nhãn ẩn" };

/** `labels` without the one `{languageCode, text}`. */
export const withoutLabel = (labels: readonly ConceptLabel[] | undefined, languageCode: string, text: string): ConceptLabel[] =>
  (labels ?? []).filter((l) => !(l.languageCode === languageCode && normLabel(l.text) === normLabel(text)));

/** Related concepts both ways (the relation is stored once per pair). */
export function relatedOf(t: Taxonomy, c: Concept): string[] {
  const name = c.name ?? "";
  const back = conceptsOf(t, schemeOfConcept(name))
    .filter((o) => o.related?.includes(name))
    .map((o) => o.name ?? "");
  return [...new Set([...(c.related ?? []), ...back])].filter((r) => t.byName.has(r));
}

/** Levels from the top through the longest same-scheme path (a top concept is 1). */
export function depthOf(t: Taxonomy, name: string, seen: ReadonlySet<string> = new Set()): number {
  const c = t.byName.get(name);
  if (!c || seen.has(name)) return 0;
  const next = new Set(seen).add(name);
  const ps = (c.broader ?? []).filter((b) => t.byName.has(b));
  return 1 + (ps.length ? Math.max(...ps.map((p) => depthOf(t, p, next))) : 0);
}

/** Labels shared within `scheme`'s working copy (W1, a warning with fixes) and with other schemes (W2, informational). */
export function sharedLabelsOf(shared: readonly SharedLabel[], scheme: string): { within: SharedLabel[]; across: SharedLabel[] } {
  const inScheme = (l: SharedLabel) => (l.concepts ?? []).some((c) => (c.scheme || schemeOfConcept(c.concept ?? "")) === scheme);
  return { within: shared.filter((l) => !l.crossScheme && inScheme(l)), across: shared.filter((l) => l.crossScheme && inScheme(l)) };
}

/* ── Publish and Version history ── */

/** What a working-copy change is called (Publish, Version history; preview `KIND`). */
export function changeKindText(c: ConceptChange): string {
  switch (c.kind) {
    case "ADDED":
      return "Đã thêm";
    case "RELABELED":
      return "Đổi nhãn";
    case "REDEFINED":
      return "Đổi định nghĩa";
    case "MOVED":
      return "Đã chuyển";
    case "DEPRECATED":
      return (c.replacedBy?.length ?? 0) === 1 ? "Đã gộp" : (c.replacedBy?.length ?? 0) > 1 ? "Tách" : "Ngừng dùng";
    case "THRESHOLDS":
      return "Đổi ngưỡng";
    case "SETTINGS":
      return "Đổi thiết lập";
    default:
      return "Đổi nhóm";
  }
}
export const changeTone = (c: ConceptChange): "success" | "warning" | "default" => (c.kind === "ADDED" ? "success" : c.kind === "DEPRECATED" ? "warning" : "default");

/** A blocking problem, said of its concept (preview `checkScheme` errors). */
export const VIOLATION_TEXT: Readonly<Record<NonNullable<ConceptSchemeViolation["invariant"]>, string>> = {
  DEFINITION_REQUIRED: "chưa có định nghĩa hoặc tên tiếng Việt",
  BROADER_CYCLE: "là tổ tiên của chính nó: các khái niệm cha dẫn ngược về nó",
  RELATED_IN_HIERARCHY: "liên quan với một khái niệm nằm trên hoặc dưới nó",
  MAX_DEPTH: "nằm sâu hơn số cấp trục phân loại cho phép",
  DEPRECATION: "đã ngừng dùng nhưng còn khái niệm con, hoặc được thay bằng một khái niệm đã ngừng dùng hoặc không còn",
  DISJOINT_LABELS: "dùng cùng một nhãn cho hai loại nhãn",
};

/** Warnings as the Publish dialog lists them: shared labels and missing scope notes gathered into one line each. */
export function warningLines(t: Taxonomy, scheme: string, warnings: readonly ConceptSchemeWarning[]): { text: string; names?: string; conflicts?: boolean }[] {
  const shared = warnings.filter((w) => w.kind === "SHARED_LABEL").length;
  const noScope = [...new Set(warnings.filter((w) => w.kind === "MISSING_SCOPE_NOTE").flatMap((w) => w.concepts ?? []))];
  const tops = warnings.some((w) => w.kind === "TOP_CONCEPT_COUNT") ? topConcepts(t, scheme).length : 0;
  return [
    ...(shared ? [{ text: `${fmtNum(shared)} nhãn dùng chung cho hai khái niệm trở lên`, conflicts: true }] : []),
    ...(noScope.length ? [{ text: "Chưa có phạm vi:", names: noScope.map((c) => conceptLabel(t, c)).join(", ") }] : []),
    ...(tops ? [{ text: `${fmtNum(tops)} khái niệm gốc; 8–20 sẽ dễ duyệt hơn` }] : []),
  ];
}

/** What publishing does to documents (`reclassification`), in words; one line when nothing is classified again. */
export function impactLines(t: Taxonomy, r: ConceptReclassification | undefined): string[] {
  const name = (c: string | undefined) => `“${conceptLabel(t, c)}”`;
  const names = (cs: readonly string[] | undefined) => (cs ?? []).map((c) => conceptLabel(t, c)).join(", ");
  const lines = [
    r?.remappedCount ? `${fmtNum(r.remappedCount)} nhãn được ánh xạ lại sang khái niệm thay thế` : "",
    ...(r?.rerank ?? []).map((x) => `Tài liệu của ${name(x.concept)} được phân loại lại giữa ${names(x.among)}`),
    ...(r?.rerunParents ?? []).map((x) => `Tài liệu của ${name(x.parent)} được xếp lại vào ${names(x.among)} khi phù hợp`),
    r?.thresholdsChanged ? "Nhãn do máy gán được xếp lại theo ngưỡng mới, không cần hỏi trợ lý" : "",
  ].filter(Boolean);
  return lines.length ? lines : ["Không tài liệu nào phải phân loại lại: tên, nhãn và định nghĩa được áp dụng ngay."];
}

/* ── Gợi ý: labels awaiting review ── */

/** One card of Labels awaiting review: documents the classifier suggested `concept` for, without those of its narrower
 *  concepts that have their own card (`except`: the facet counts a concept with everything under it). */
export interface SuggestedGroup {
  concept: string;
  scheme: string;
  /** Documents (exact without `except`; otherwise at least this many). */
  n: number;
  except: string[];
}

/**
 * Cards from the `document.suggestedConcepts` facet (concept → documents, hierarchical), most documents first (preview
 * `pendingByConcept`). A concept whose count is all its narrower cards' documents gets no card of its own.
 */
export function suggestedGroups(t: Taxonomy, counts: ReadonlyMap<string, number>): SuggestedGroup[] {
  const shown = [...counts].filter(([c, n]) => n > 0 && t.byName.has(c)).map(([c]) => c);
  const out: SuggestedGroup[] = [];
  for (const concept of shown) {
    const under = new Set(descendantsOf(t, concept));
    const inner = shown.filter((o) => under.has(o));
    // Only the closest ones: a filter on a concept already covers everything under it.
    const except = inner.filter((o) => !inner.some((p) => p !== o && descendantsOf(t, p).includes(o)));
    const n = (counts.get(concept) ?? 0) - except.reduce((a, o) => a + (counts.get(o) ?? 0), 0);
    if (n > 0) out.push({ concept, scheme: schemeOfConcept(concept), n, except });
  }
  return out.sort((a, b) => b.n - a.n || conceptLabel(t, a.concept).localeCompare(conceptLabel(t, b.concept)));
}

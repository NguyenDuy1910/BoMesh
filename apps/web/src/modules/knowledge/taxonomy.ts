import { categoryColor } from "@/lib/tones";

import type { Concept, ConceptScheme, DocumentApplicability, DocumentConcept } from "./api";

/**
 * The workspace taxonomy (`item_model.md` §4.13; preview `core/catalog.js` “Taxonomy”): concept schemes, each a
 * poly-hierarchy of concepts (a concept may sit under several broader ones). CLASSIFICATION schemes file documents and are
 * Browse facets; AUTHORITY schemes (org units, programs) only describe documents (issuer, applicability) and members.
 * Built from the working copy ListConcepts returns: drafts are shown in Studio only, readers see published concepts.
 * Pure functions over full resource names (`workspaces/{w}/conceptSchemes/{s}/concepts/{c}`).
 */

export interface Taxonomy {
  /** Every scheme, in tab order (`position`). */
  schemes: readonly ConceptScheme[];
  /** Concept name → concept (drafts and deprecated ones included, so old assignments still resolve). */
  byName: ReadonlyMap<string, Concept>;
  /** Scheme name → its concepts in API order (deleted drafts left out). */
  byScheme: ReadonlyMap<string, readonly Concept[]>;
  /** Concept name → its live narrower concepts (a child with several parents is under each). */
  narrower: ReadonlyMap<string, readonly Concept[]>;
}

const lastSegment = (name: string | undefined) => (name ? name.slice(name.lastIndexOf("/") + 1) : "");

/** The ID (code/notation) of a scheme or concept name. */
export const resourceKey = lastSegment;

/** The scheme name of a concept name (`…/conceptSchemes/{s}`). */
export function schemeOfConcept(concept: string): string {
  const at = concept.indexOf("/concepts/");
  return at < 0 ? "" : concept.slice(0, at);
}

/** A concept's full name from its scheme name and notation. */
export const conceptNameOf = (scheme: string, notation: string) => `${scheme}/concepts/${notation}`;

const byPosition = (a: ConceptScheme, b: ConceptScheme) => (a.position ?? 99) - (b.position ?? 99);

export function buildTaxonomy(schemes: readonly ConceptScheme[], concepts: readonly Concept[]): Taxonomy {
  const byName = new Map<string, Concept>();
  const byScheme = new Map<string, Concept[]>();
  const narrower = new Map<string, Concept[]>();
  for (const s of schemes) byScheme.set(s.name ?? "", []);
  for (const c of concepts) {
    if (!c.name || c.state === "DELETED") continue;
    byName.set(c.name, c);
    const scheme = schemeOfConcept(c.name);
    (byScheme.get(scheme) ?? byScheme.set(scheme, []).get(scheme)!).push(c);
    if (c.state === "DEPRECATED") continue;
    for (const b of c.broader ?? []) (narrower.get(b) ?? narrower.set(b, []).get(b)!).push(c);
  }
  return { schemes: [...schemes].sort(byPosition), byName, byScheme, narrower };
}

export const EMPTY_TAXONOMY: Taxonomy = buildTaxonomy([], []);

/* ── Schemes ── */

export const isClassification = (s: ConceptScheme | undefined) => !!s && s.purpose !== "AUTHORITY";
/** Classification schemes (what documents are filed under), in tab order. */
export const classSchemes = (t: Taxonomy) => t.schemes.filter(isClassification);
/** Authority lists (org units, programs): issuers, applicability and member affiliation — never a classification target. */
export const authoritySchemes = (t: Taxonomy) => t.schemes.filter((s) => s.purpose === "AUTHORITY");
/** The lowest-position classification scheme: Home's cards and Browse's pill bar. */
export const firstScheme = (t: Taxonomy): ConceptScheme | null => classSchemes(t)[0] ?? null;
/** A scheme by full name or bare ID. */
export const schemeByName = (t: Taxonomy, scheme: string | undefined): ConceptScheme | undefined =>
  scheme ? t.schemes.find((s) => s.name === scheme || lastSegment(s.name) === scheme) : undefined;
export const schemeLabel = (s: ConceptScheme | undefined) => s?.displayName || "Trục phân loại";

/** Icon names (`domainIcon.ts`) per well-known scheme ID; others draw layers. */
const SCHEME_ICONS: Readonly<Record<string, string>> = {
  domain: "layers",
  function: "briefcase",
  "document-type": "file-text",
  audience: "users",
  "org-unit": "building",
  program: "graduation",
  subject: "layers",
};
export const schemeIconName = (scheme: string | undefined) => SCHEME_ICONS[lastSegment(scheme)] ?? "layers";

/* ── Concepts ── */

export const conceptState = (c: Concept | undefined) => c?.state ?? "PUBLISHED";
const isLive = (c: Concept) => c.state !== "DEPRECATED" && c.state !== "DELETED";

/** A concept's preferred label (Vietnamese first): content, never translated. */
export function conceptLabel(t: Taxonomy, name: string | undefined): string {
  const c = name ? t.byName.get(name) : undefined;
  if (!c) return "Khái niệm chưa đặt tên";
  return c.displayName || c.prefLabels?.find((l) => l.languageCode === "vi")?.text || c.prefLabels?.[0]?.text || lastSegment(c.name);
}

/** A scheme's concepts (the working copy: drafts and published); `deprecated` adds the retired ones. */
export const conceptsOf = (t: Taxonomy, scheme: string, { deprecated = false } = {}): Concept[] =>
  (t.byScheme.get(schemeByName(t, scheme)?.name ?? scheme) ?? []).filter((c) => deprecated || isLive(c));
export const narrowerOf = (t: Taxonomy, name: string): readonly Concept[] => t.narrower.get(name) ?? [];
export const topConcepts = (t: Taxonomy, scheme: string) => conceptsOf(t, scheme).filter((c) => !c.broader?.length);

/** Every broader concept, through every parent (the closure). */
export function ancestorsOf(t: Taxonomy, name: string): string[] {
  const out: string[] = [];
  const seen = new Set([name]);
  const queue = [...(t.byName.get(name)?.broader ?? [])];
  while (queue.length) {
    const b = queue.shift()!;
    if (seen.has(b)) continue;
    seen.add(b);
    out.push(b);
    queue.push(...(t.byName.get(b)?.broader ?? []));
  }
  return out;
}

/** Every live narrower concept, at any depth. */
export function descendantsOf(t: Taxonomy, name: string): string[] {
  const out: string[] = [];
  const seen = new Set([name]);
  const queue = narrowerOf(t, name).map((c) => c.name ?? "");
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    queue.push(...narrowerOf(t, n).map((c) => c.name ?? ""));
  }
  return out;
}

/** A concept with everything broader: a document filed under it counts under each of them. */
export const conceptLineage = (t: Taxonomy, name: string) => [name, ...ancestorsOf(t, name)];

/** The path through each concept's first parent, top first: ["IT", "AI & học máy", "Thị giác máy tính"]. */
export function conceptPath(t: Taxonomy, name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let c = t.byName.get(name); c?.name && !seen.has(c.name); c = c.broader?.[0] ? t.byName.get(c.broader[0]) : undefined) {
    seen.add(c.name);
    out.unshift(conceptLabel(t, c.name));
  }
  return out.length ? out : [conceptLabel(t, name)];
}
export const conceptPathText = (t: Taxonomy, name: string) => conceptPath(t, name).join(" › ");

/** The top concept above it through first parents (itself when it is one). */
export function conceptTop(t: Taxonomy, name: string): string {
  let c = t.byName.get(name);
  const seen = new Set<string>();
  while (c?.broader?.length && c.name && !seen.has(c.name)) {
    seen.add(c.name);
    const up = t.byName.get(c.broader[0]);
    if (!up) break;
    c = up;
  }
  return c?.name ?? name;
}

/** How a concept is drawn (preview `conceptLook`). */
export interface ConceptLook {
  /** Icon name: its own, else the nearest broader one's, else its scheme's for a top concept; absent = a tag. */
  icon?: string;
  /** CSS color of its top concept: the stored one, else a stable hashed one, so a branch reads as one family. */
  color: string;
}

export function conceptLook(t: Taxonomy, name: string): ConceptLook {
  const c = t.byName.get(name);
  const topName = conceptTop(t, name);
  const top = t.byName.get(topName);
  const color = top?.color || categoryColor(lastSegment(topName));
  const inherited = c?.icon || ancestorsOf(t, name).map((a) => t.byName.get(a)?.icon).find(Boolean);
  return { icon: inherited || (c?.broader?.length ? undefined : schemeIconName(schemeOfConcept(name))), color };
}

/** Concepts a document may be filed under in a scheme: published, and not a top concept with narrower ones when the
 *  scheme rolls documents up instead (`assignTopConcepts` false). */
export function assignableConcepts(t: Taxonomy, scheme: string): Concept[] {
  const s = schemeByName(t, scheme);
  return conceptsOf(t, scheme).filter(
    (c) => conceptState(c) === "PUBLISHED" && (s?.assignTopConcepts !== false || !!c.broader?.length || !narrowerOf(t, c.name ?? "").length),
  );
}

export interface LabelOf {
  kind: "PREF" | "ALT" | "HIDDEN";
  languageCode: string;
  text: string;
}
/** Every label of a concept, in every language. */
export const conceptLabels = (c: Concept | undefined): LabelOf[] =>
  !c
    ? []
    : [
        ...(c.prefLabels ?? []).map((l) => ({ kind: "PREF" as const, ...l })),
        ...(c.altLabels ?? []).map((l) => ({ kind: "ALT" as const, ...l })),
        ...(c.hiddenLabels ?? []).map((l) => ({ kind: "HIDDEN" as const, ...l })),
      ];

/** The label key the backend compares (`normalized`): NFC, lower case, collapsed whitespace, surrounding punctuation
 *  stripped; diacritics kept (khoa ≠ khóa). */
export const normLabel = (s: string) =>
  String(s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .trim();

/* ── A document's assignments (`document.concepts`; reads omit REJECTED) ── */

/** Assignments whose concept still resolves. */
export const docAssignments = (t: Taxonomy, concepts: readonly DocumentConcept[] | undefined) =>
  (concepts ?? []).filter((a) => a.concept && t.byName.has(a.concept));

/** The concepts a document is filed under (ACCEPTED). */
export const acceptedConcepts = (concepts: readonly DocumentConcept[] | undefined): string[] =>
  (concepts ?? []).filter((a) => a.state !== "SUGGESTED" && a.concept).map((a) => a.concept!);

/** What the classifier proposed and nobody confirmed yet. */
export const suggestedConcepts = (concepts: readonly DocumentConcept[] | undefined): string[] =>
  (concepts ?? []).filter((a) => a.state === "SUGGESTED" && a.concept).map((a) => a.concept!);

export interface SchemeAssignments {
  scheme: ConceptScheme;
  /** Primary first, then accepted, then suggested. */
  items: DocumentConcept[];
}

/** Assignments per classification scheme, in tab order; every scheme listed even when empty. */
export function assignmentsByScheme(t: Taxonomy, concepts: readonly DocumentConcept[] | undefined): SchemeAssignments[] {
  const all = docAssignments(t, concepts);
  const rank = (a: DocumentConcept) => (a.primary ? 0 : a.state === "SUGGESTED" ? 2 : 1);
  return classSchemes(t).map((scheme) => ({
    scheme,
    items: all.filter((a) => schemeOfConcept(a.concept!) === scheme.name).sort((a, b) => rank(a) - rank(b)),
  }));
}

/* ── Thông tin văn bản: `document.issuance` + `document.applicability` ── */

export const APPLICABILITY_LEVELS: Readonly<Record<NonNullable<DocumentApplicability["level"]>, string>> = {
  INSTITUTION: "Toàn trường",
  UNIT: "Đơn vị",
  PROGRAM: "Ngành",
  COHORT: "Khóa",
};

/** Who a document applies to, in words: “Toàn trường”, “Khoa CNTT, Khoa Cơ khí”, “Công nghệ thông tin · khóa 2022”. */
export function applicabilityText(t: Taxonomy, a: DocumentApplicability | undefined): string {
  if (!a?.level) return "";
  if (a.level === "INSTITUTION") return APPLICABILITY_LEVELS.INSTITUTION;
  const names = [...(a.units ?? []), ...(a.programs ?? [])].map((n) => conceptLabel(t, n));
  return [names.join(", "), a.cohorts?.length ? `khóa ${a.cohorts.join(", ")}` : ""].filter(Boolean).join(" · ");
}

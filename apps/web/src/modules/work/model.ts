import type { Schema } from "@/lib/api/client";
import { plural } from "@/lib/format";

import { kindMeta, type WorkKind, type WorkflowId } from "./kinds";

/**
 * Pure Work model: statuses, summaries, generation instructions, and the
 * Markdown shapes the study guide and quiz renderers read and write.
 */

export type Artifact = Schema<"Artifact">;
export type Citation = Schema<"Citation">;
export type ReviewCell = Schema<"EvidenceReviewCell">;
export type ReviewEntry = Schema<"EvidenceReviewOption">;

const tail = (name: string | undefined | null) => (name ?? "").split("/").pop() ?? "";

/* ═══════════════ Status ═══════════════ */

export interface WorkStatus {
  label: string;
  tone: "accent" | "success" | "warning" | "danger" | "default";
  variant?: "soft" | "primary" | "tertiary";
  live?: boolean;
}

/**
 * Preview statuses (generating · draft · ready · published) on the API's `state` and `audience`:
 * a DRAFT shared with its space is "ready for review"; a QUIZ shared with its space is published;
 * a staff quiz still private is a draft only the teaching team sees.
 */
export function workStatus(a: Artifact, { staffQuiz = false }: { staffQuiz?: boolean } = {}): WorkStatus {
  if (a.state === "GENERATING") return { label: "Generating", tone: "accent", variant: "soft", live: true };
  if (a.state === "FAILED") return { label: "Failed", tone: "danger" };
  const shared = a.audience === "SPACE";
  if (a.kind === "DRAFT") return shared ? { label: "Ready", tone: "success", variant: "tertiary" } : { label: "Draft", tone: "default" };
  if (a.kind === "QUIZ") {
    if (shared) return { label: "Published", tone: "accent" };
    if (staffQuiz) return { label: "Draft", tone: "default" };
  }
  return { label: "Ready", tone: "success", variant: "tertiary" };
}

/** One line for lists (preview `kind.summary`). */
export function workSummary(a: Artifact): string {
  const meta = kindMeta(a.kind);
  if (a.kind === "EVIDENCE_REVIEW") {
    const r = a.evidenceReview;
    const synth = r?.synthesis ? " · synthesized" : "";
    return `${plural(r?.options?.length ?? 0, "source")} · ${plural(r?.criteria?.length ?? 0, "criterion", "criteria")}${synth}`;
  }
  const n = a.sourceItems?.length ?? 0;
  const base = n ? `${meta.label} · ${plural(n, "source")}` : meta.label;
  if (a.kind === "DRAFT" && a.audience === "SPACE") return `${base} · review requested`;
  return base;
}

export const isOwnerOf = (a: Artifact, memberName: string) => !!a.owner && a.owner === memberName;

/* ═══════════════ Documents and citations ═══════════════ */

/** Reader deep link (wave-2 contract: `/doc/<itemId>?q=&page=&passage=&from=`). */
export function citationHref(c: Pick<Citation, "item" | "pageNumber" | "passage" | "excerpt">, from?: string): string {
  const q = new URLSearchParams();
  if (c.pageNumber) q.set("page", String(c.pageNumber));
  if (c.passage) q.set("passage", tail(c.passage));
  if (from) q.set("from", from);
  const s = q.toString();
  return `/doc/${tail(c.item)}${s ? `?${s}` : ""}`;
}

export const docHref = (item: string) => `/doc/${tail(item)}`;

/** "“quote” — Name, page 3" (preview Copy citation). */
export function citationText(c: Citation): string {
  const where = [c.displayName || "Document", c.pageNumber ? `page ${c.pageNumber}` : ""].filter(Boolean).join(", ");
  return c.excerpt ? `“${c.excerpt}” — ${where}` : where;
}

/* ═══════════════ Evidence review ═══════════════ */

export const DEFAULT_CRITERIA = ["Method", "Dataset", "Result", "Limitations"] as const;
export const SUGGESTED_CRITERIA = ["Cost", "Operations effort", "Data residency", "Risks"] as const;
export const MAX_SOURCE_CHOICES = [4, 6, 8] as const;

/** A matrix key (1–64 letters, digits, `_` or `-`) from a label, unique among `taken`. */
export function entryKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base =
    label
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "c";
  let key = base;
  for (let i = 2; used.has(key); i++) key = `${base}-${i}`;
  return key;
}

/** Criteria entries for labels, in order. */
export function criteriaOf(labels: readonly string[]): ReviewEntry[] {
  const out: ReviewEntry[] = [];
  for (const label of labels) out.push({ key: entryKey(label, out.map((e) => e.key)), displayName: label });
  return out;
}

/** A matrix row per document; the key is the item ID so a row links back to its document. */
export const optionOf = (doc: { name?: string; displayName?: string }): ReviewEntry => ({ key: tail(doc.name), displayName: doc.displayName || "Untitled" });

/** The document a row stands for, when its key is one of the review's source items. */
export function optionDoc(a: Artifact, key: string): string | null {
  return (a.sourceItems ?? []).find((s) => tail(s) === key) ?? null;
}

export function cellOf(a: Artifact, option: string, criterion: string): ReviewCell | undefined {
  return a.evidenceReview?.cells?.find((c) => c.option === option && c.criterion === criterion);
}

export const reviewGenerating = (a: Artifact) => (a.evidenceReview?.cells ?? []).some((c) => c.state === "GENERATING");

/* ═══════════════ Draft options ═══════════════ */

export type DraftType = "decision" | "proposal" | "litreview" | "announcement" | "email";
export const DRAFT_TYPES: ReadonlyArray<readonly [DraftType, string, string]> = [
  ["decision", "Decision record", "Context, options, decision and consequences — like an ADR."],
  ["proposal", "Proposal", "Background, objectives and a plan grounded in your sources."],
  ["litreview", "Evidence summary", "What your sources say, compared side by side."],
  ["announcement", "Announcement", "A clear notice for a team, project or course."],
  ["email", "Email", "A short message that summarises your sources."],
];
export const draftTypeLabel = (t: string) => (DRAFT_TYPES.find((x) => x[0] === t) ?? DRAFT_TYPES[0])[1];
/** The draft type this device asked for (from the stored recipe's instructions); the API doesn't keep it. */
export function recipeDraftType(artifact: string | undefined): DraftType | undefined {
  const text = artifact ? (loadRecipe(artifact)?.instructions ?? "") : "";
  return DRAFT_TYPES.find(([, label]) => text.startsWith(`Write a ${label.toLowerCase()}:`))?.[0];
}
/** Quick "Ask for changes" chips per draft type (preview `drRender`). */
export function draftQuickAsks(type: DraftType | undefined): readonly string[] {
  if (type === "proposal") return ["Shorter", "More formal", "Add a cost breakdown"];
  if (type === "decision") return ["Shorter", "Longer", "Add a rollout timeline"];
  if (type === "announcement" || type === "email") return ["Shorter", "Friendlier", "More formal"];
  return ["Shorter", "Longer", "More formal"];
}
export const TONES = [
  ["formal", "Formal"],
  ["neutral", "Neutral"],
  ["friendly", "Friendly"],
] as const;
export const LENGTHS = [
  ["short", "Short"],
  ["medium", "Medium"],
  ["long", "Long"],
] as const;
export type Tone = (typeof TONES)[number][0];
export type Length = (typeof LENGTHS)[number][0];

/** Default draft type for a space type (preview `defaultType`). */
export function defaultDraftType(spaceType: string | undefined, docNames: readonly string[] = []): DraftType {
  if (docNames.some((n) => /^ADR-\d+/i.test(n))) return "decision";
  if (spaceType === "course") return "announcement";
  if (spaceType === "research" || spaceType === "project") return "litreview";
  return "email";
}

/** Draft options with the preview's defaults filled in (`drOptions`): type from the space/sources, tone from the type. */
export function withDraftDefaults(o: WorkOptions, spaceType: string | undefined, docNames: readonly string[]): WorkOptions {
  const type = o.type ?? defaultDraftType(spaceType, docNames);
  return { ...o, type, tone: o.tone ?? (type === "announcement" || type === "email" ? "neutral" : "formal"), length: o.length ?? "medium" };
}

/* ═══════════════ New-work options → generation instructions ═══════════════ */

export interface WorkOptions {
  /* review */
  criteria?: string[];
  maxPapers?: number;
  /* draft */
  type?: DraftType;
  tone?: Tone;
  length?: Length;
  /** Review this draft builds on (artifact ID). */
  fromReview?: string;
  /* study guide */
  depth?: "quick" | "full";
  check?: boolean;
  /* quiz */
  count?: number;
  mix?: "easy" | "balanced" | "hard";
}

/** Instructions the assistant receives with CreateArtifact (`generationInstructions`). */
export function generationInstructions(kind: WorkKind, o: WorkOptions, { staffQuiz = false, extra = "" }: { staffQuiz?: boolean; extra?: string } = {}): string | undefined {
  const lines: string[] = [];
  if (kind === "DRAFT") {
    const t = DRAFT_TYPES.find((x) => x[0] === (o.type ?? "email")) ?? DRAFT_TYPES[4];
    lines.push(`Write a ${t[1].toLowerCase()}: ${t[2]}`, `Tone: ${o.tone ?? "formal"}. Length: ${o.length ?? "medium"}.`);
  } else if (kind === "STUDY_GUIDE") {
    const sections = ["## In one paragraph", "## Key terms", ...(o.depth === "quick" ? [] : ["## Worked example"]), ...(o.check === false ? [] : ["## Check yourself"])];
    lines.push(
      o.depth === "quick" ? "A quick summary: a paragraph and the key terms." : "A full guide: summary, key terms and a worked example.",
      `Use exactly these Markdown sections, in order: ${sections.join(", ")}.`,
      o.check === false ? "" : "Under “Check yourself”, a few open questions to test understanding.",
    );
  } else if (kind === "QUIZ") {
    const mix = { easy: "mostly easy", balanced: "a balanced mix of easy, medium and hard", hard: "mostly challenging" }[o.mix ?? "balanced"];
    lines.push(
      `${o.count ?? (staffQuiz ? 8 : 5)} multiple-choice questions, ${mix}; 4 answers each (A–D), exactly one correct.`,
      "Format: a “## Questions” section with numbered questions, each followed by its answers as “A. …” to “D. …” on their own lines;",
      "then a “## Answer key” section with one line per question: “1. B — one-sentence explanation”.",
      staffQuiz ? "The quiz is for students; the teaching team reviews it before publishing." : "It is a private practice quiz.",
    );
  }
  if (extra) lines.push(extra);
  const text = lines.filter(Boolean).join("\n");
  return text || undefined;
}

/* ═══════════════ Default titles (preview `kind.title(ctx)`) ═══════════════ */

const stripExt = (n: string) => n.replace(/\.[a-z0-9]{1,5}$/i, "");
/** "W3 — Sorting & searching.pdf" → "Sorting & searching". */
function docTopic(name: string) {
  const base = stripExt(name);
  return /^(.{1,16}?)\s+—\s+(.+)$/.exec(base)?.[2] ?? base;
}
function topicsLine(names: readonly string[]) {
  if (names.length === 1) return docTopic(names[0]);
  const short = names.slice(0, 2).map((n) => docTopic(n).split(" & ")[0].replace(/\s*\(.*?\)\s*/g, " ").trim());
  return short.join(" & ") + (names.length > 2 ? ` +${names.length - 2}` : "");
}

export function defaultTitle(kind: WorkKind, { spaceName, docNames, options, staffQuiz }: { spaceName?: string; docNames: readonly string[]; options: WorkOptions; staffQuiz?: boolean }): string {
  if (kind === "EVIDENCE_REVIEW") return spaceName ? `${spaceName} — evidence matrix` : "Evidence matrix";
  if (kind === "DRAFT") return `${draftTypeLabel(options.type ?? "email")}${spaceName ? ` — ${spaceName}` : ""}`;
  if (!docNames.length) return kindMeta(kind).label;
  if (kind === "STUDY_GUIDE") return `${topicsLine(docNames)} — study guide`;
  return staffQuiz ? `Quiz — ${topicsLine(docNames)}` : `Practice — ${topicsLine(docNames)}`;
}

/* ═══════════════ Retry recipe ═══════════════ */

/**
 * What a generation was started with, kept on this device so "Try again" can
 * start the same work after a failure (`generationInstructions` is input-only).
 */
export interface Recipe {
  kind: WorkKind;
  workflow: WorkflowId;
  title: string;
  /** The generation operation (its `error` explains a failure). */
  operation?: string;
  space?: string;
  sources: string[];
  instructions?: string;
  options?: ReviewEntry[];
  criteria?: ReviewEntry[];
}

const recipeKey = (artifact: string) => `bomesh.work.recipe.${tail(artifact)}`;
export function saveRecipe(artifact: string, recipe: Recipe) {
  try {
    localStorage.setItem(recipeKey(artifact), JSON.stringify(recipe));
  } catch {
    /* storage full or blocked: Try again falls back to the artifact's own fields */
  }
}
export function loadRecipe(artifact: string): Recipe | null {
  try {
    const raw = localStorage.getItem(recipeKey(artifact));
    return raw ? (JSON.parse(raw) as Recipe) : null;
  } catch {
    return null;
  }
}
export function dropRecipe(artifact: string) {
  try {
    localStorage.removeItem(recipeKey(artifact));
  } catch {
    /* ignore */
  }
}

/** The recipe to start an artifact again: the stored one, else its own kind, title, space, sources and matrix. */
export function recipeOf(a: Artifact): Recipe {
  const stored = a.name ? loadRecipe(a.name) : null;
  if (stored) return stored;
  const kind = (a.kind === "FILE" || !a.kind ? "DRAFT" : a.kind) as WorkKind;
  return {
    kind,
    workflow: kind,
    title: a.displayName ?? "",
    space: a.space,
    sources: a.sourceItems ?? [],
    options: a.evidenceReview?.options,
    criteria: a.evidenceReview?.criteria,
  };
}

/* ═══════════════ Markdown text ═══════════════ */

export function wordCount(markdown: string | undefined | null): number {
  return String(markdown ?? "")
    .replace(/[#>*_`|-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/* ── Study guide: one section per heading ── */

export interface GuideSection {
  id: string;
  title: string;
  body: string;
}

/** Splits a guide into its sections: the shallowest heading level used at least twice (a lone `#` title is not a section). */
export function guideSections(markdown: string): GuideSection[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const levels = lines.map((l) => /^(#{1,3})\s+\S/.exec(l)?.[1].length ?? 0).filter(Boolean);
  const level = [1, 2, 3].find((n) => levels.filter((x) => x === n).length > 1) ?? (levels.length ? Math.min(...levels) : 0);
  const out: GuideSection[] = [];
  let cur: GuideSection | null = null;
  for (const line of lines) {
    const m = level ? /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (m && m[1].length === level) {
      cur = { id: `s${out.length + 1}`, title: m[2].replace(/\*\*/g, ""), body: "" };
      out.push(cur);
    } else if (m && m[1].length < level) {
      continue; // the document title above the sections
    } else if (cur) cur.body += `${line}\n`;
    else if (line.trim()) {
      cur = { id: "s0", title: "", body: `${line}\n` };
      out.push(cur);
    }
  }
  return out.map((s) => ({ ...s, body: s.body.trim() })).filter((s) => s.title || s.body);
}

/* ── Quiz: numbered questions, A–D answers, an answer key ── */

export interface QuizQuestion {
  id: string;
  q: string;
  options: string[];
  /** Index of the correct answer; −1 when the key doesn't name it. */
  answer: number;
  explain: string;
}

const KEYS = "ABCD";
const strip = (s: string) => s.replace(/\*\*|__/g, "").trim();

/**
 * Reads a quiz the assistant wrote in Markdown. Returns `null` when the text
 * doesn't look like a multiple-choice quiz, so the page shows it as text.
 */
export function parseQuiz(markdown: string): QuizQuestion[] | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const keyStart = lines.findIndex((l) => /^\s*(#{1,6}\s*)?(\*\*)?\s*answer(s| key)\b/i.test(l));
  const body = keyStart >= 0 ? lines.slice(0, keyStart) : lines;
  const keyLines = keyStart >= 0 ? lines.slice(keyStart + 1) : [];
  const qs: QuizQuestion[] = [];
  let cur: QuizQuestion | null = null;
  for (const raw of body) {
    const line = raw.trim();
    if (!line) continue;
    const opt = /^[-*]?\s*\(?([A-Da-d])[.)]\s+(.+)$/.exec(line);
    if (opt && cur && cur.options.length < 4) {
      let text = strip(opt[2]);
      if (/[✓✔]|\(correct\)/i.test(text)) {
        cur.answer = cur.options.length;
        text = text.replace(/\s*([✓✔]|\(correct\))\s*/gi, " ").trim();
      }
      cur.options.push(text);
      continue;
    }
    const q = /^(?:#{1,6}\s*)?(?:\*\*)?\s*(?:Q(?:uestion)?\s*)?(\d+)[.):]\s*(?:\*\*)?\s*(.+)$/i.exec(line);
    if (q) {
      cur = { id: `q${q[1]}`, q: strip(q[2]), options: [], answer: -1, explain: "" };
      qs.push(cur);
      continue;
    }
    const inline = /^(?:\*\*)?\s*(?:correct\s+)?answer\s*[:：]\s*(?:\*\*)?\s*\(?([A-D])\b[).]?\s*(?:[—–:-]\s*)?(.*)$/i.exec(line);
    if (inline && cur) {
      cur.answer = KEYS.indexOf(inline[1].toUpperCase());
      if (inline[2]) cur.explain = strip(inline[2]);
      continue;
    }
    const explain = /^(?:\*\*)?\s*explanation\s*[:：]\s*(?:\*\*)?\s*(.+)$/i.exec(line);
    if (explain && cur) cur.explain = strip(explain[1]);
  }
  for (const raw of keyLines) {
    const m = /^\s*[-*]?\s*(?:\*\*)?\s*(?:Q(?:uestion)?\s*)?(\d+)\s*[.):]?\s*(?:\*\*)?\s*[:–—-]?\s*\(?([A-Da-d])\b[).]?\s*(?:\*\*)?\s*(?:[—–:-]\s*)?(.*)$/i.exec(raw);
    if (!m) continue;
    const q = qs.find((x) => x.id === `q${m[1]}`);
    if (!q) continue;
    q.answer = KEYS.indexOf(m[2].toUpperCase());
    if (m[3]) q.explain = strip(m[3]);
  }
  const valid = qs.filter((q) => q.q && q.options.length >= 2);
  return valid.length && valid.length === qs.length ? valid : null;
}

/** The canonical Markdown a quiz is stored as after a person edits it. */
export function serializeQuiz(qs: readonly QuizQuestion[]): string {
  const questions = qs.map((q, i) => [`${i + 1}. ${q.q}`, ...q.options.map((o, j) => `   ${KEYS[j]}. ${o}`)].join("\n")).join("\n\n");
  const key = qs.map((q, i) => `${i + 1}. ${q.answer >= 0 ? KEYS[q.answer] : "?"}${q.explain ? ` — ${q.explain}` : ""}`).join("\n");
  return `## Questions\n\n${questions}\n\n## Answer key\n\n${key}\n`;
}

export const QUIZ_KEYS = KEYS;

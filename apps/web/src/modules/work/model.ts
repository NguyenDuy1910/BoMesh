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
 * Preview `statusChip(w)` on the API's `state` and `audience`. Generated work carries no chip; a DRAFT moves
 * Draft (private) → In review (shared with its space); a QUIZ shared with its space is Published for the
 * teaching team, and a staff quiz still private is a Draft. `null` = no chip.
 */
export function workStatus(a: Artifact, { staffQuiz = false }: { staffQuiz?: boolean } = {}): WorkStatus | null {
  if (a.state === "GENERATING") return { label: "Đang tạo", tone: "accent", variant: "soft", live: true };
  if (a.state === "FAILED") return { label: "Lỗi", tone: "danger" };
  const shared = a.audience === "SPACE";
  if (a.kind === "DRAFT") return shared ? { label: "Chờ duyệt", tone: "accent" } : { label: "Bản nháp", tone: "default" };
  if (a.kind === "QUIZ" && staffQuiz) return shared ? { label: "Đã công bố", tone: "accent" } : { label: "Bản nháp", tone: "default" };
  return null;
}

/** One line for lists (preview `kind.summary`). `kind: false` drops the kind label when a status chip already says it. */
export function workSummary(a: Artifact, { kind = true }: { kind?: boolean } = {}): string {
  const meta = kindMeta(a.kind);
  if (a.kind === "EVIDENCE_REVIEW") {
    const r = a.evidenceReview;
    const synth = r?.synthesis ? "· đã tổng hợp" : "";
    return `${plural(r?.options?.length ?? 0, "source")} · ${plural(r?.criteria?.length ?? 0, "criterion")}${synth}`;
  }
  const n = a.sourceItems?.length ?? 0;
  return [kind ? meta.label : "", n ? plural(n, "source") : ""].filter(Boolean).join(" · ");
}

/** Evidence review: the source items that are compared (matrix rows) and those read only for context. */
export function reviewSources(a: Artifact): { compared: string[]; context: string[] } {
  const rows = new Set((a.evidenceReview?.options ?? []).map((o) => o.key));
  const compared: string[] = [];
  const context: string[] = [];
  for (const s of a.sourceItems ?? []) (rows.has(tail(s)) ? compared : context).push(s);
  return { compared, context };
}

/** One count per kind, said the same way in the header and the Sources panel (preview `sourceLine`). */
export function sourceLine(a: Artifact): string {
  if (a.kind === "EVIDENCE_REVIEW") {
    const n = a.evidenceReview?.options?.length ?? 0;
    const c = reviewSources(a).context.length;
    return `${plural(n, "source")} compared${c ? ` · ${plural(c, "tài liệu ngữ cảnh")}` : ""}`;
  }
  return plural((a.sourceItems?.length ?? 0) + (a.hiddenSourceCount ?? 0), "source");
}

/* ═══════════════ Documents ═══════════════ */

export const docHref = (item: string) => `/doc/${tail(item)}`;

/* ═══════════════ Evidence review ═══════════════ */

/* Defaults follow the space: research groups and courses compare papers; teams and projects compare options. */
const RESEARCH_CRITERIA = ["Phương thức", "Tập dữ liệu", "Kết quả", "Hạn chế"] as const;
const OPTION_CRITERIA = ["Chi phí", "Công sức vận hành", "Rủi ro"] as const;
const MORE_CRITERIA = ["Lưu trú dữ liệu", "Bảo mật", "Hỗ trợ từ nhà cung cấp"] as const;
const comparesPapers = (spaceType: string | undefined) => spaceType === "research" || spaceType === "course";
/** The criteria a new review starts with in a space of this type (preview `criteriaFor`). */
export const criteriaFor = (spaceType: string | undefined): string[] => [...(comparesPapers(spaceType) ? RESEARCH_CRITERIA : OPTION_CRITERIA)];
/** More criteria to offer (preview `suggestionsFor`). */
export const suggestionsFor = (spaceType: string | undefined): string[] => [...new Set([...(comparesPapers(spaceType) ? OPTION_CRITERIA : RESEARCH_CRITERIA), ...MORE_CRITERIA])];
/** A comparison stays readable up to this many rows; the New work flow says so before generating. */
export const MAX_REVIEW_SOURCES = 8;

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
export const optionOf = (doc: { name?: string; displayName?: string }): ReviewEntry => ({ key: tail(doc.name), displayName: doc.displayName || "Chưa đặt tên" });

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
  ["decision", "Hồ sơ quyết định", "Bối cảnh, phương án, quyết định và hệ quả — như một ADR."],
  ["proposal", "Đề xuất", "Bối cảnh, mục tiêu và kế hoạch dựa trên các nguồn bạn chọn."],
  ["litreview", "Tóm tắt bằng chứng", "Nội dung các nguồn nói gì, so sánh song song."],
  ["announcement", "Thông báo", "Thông báo rõ ràng cho một nhóm, dự án hoặc khóa học."],
  ["email", "Email", "Một tin nhắn ngắn tóm tắt các nguồn bạn chọn."],
];
export const draftTypeLabel = (t: string) => (DRAFT_TYPES.find((x) => x[0] === t) ?? DRAFT_TYPES[0])[1];
/** The noun the generation instructions name a draft type by (`Write a {noun}:`); stable, never the display label, so saved recipes keep parsing. */
const DRAFT_NOUN: Readonly<Record<DraftType, string>> = { decision: "decision record", proposal: "proposal", litreview: "evidence summary", announcement: "announcement", email: "email" };
/** The draft type this device asked for (from the stored recipe's instructions); the API doesn't keep it. */
export function recipeDraftType(artifact: string | undefined): DraftType | undefined {
  const text = artifact ? (loadRecipe(artifact)?.instructions ?? "") : "";
  return DRAFT_TYPES.find(([id]) => text.startsWith(`Write a ${DRAFT_NOUN[id]}:`))?.[0];
}
/** Quick "Ask for changes" chips per draft type (preview `drRender`). */
export function draftQuickAsks(type: DraftType | undefined): readonly string[] {
  if (type === "proposal") return ["Ngắn hơn", "Trang trọng hơn", "Thêm bảng phân tích chi phí"];
  if (type === "decision") return ["Ngắn hơn", "Dài hơn", "Thêm lộ trình triển khai"];
  if (type === "announcement" || type === "email") return ["Ngắn hơn", "Thân thiện hơn", "Trang trọng hơn"];
  return ["Ngắn hơn", "Dài hơn", "Trang trọng hơn"];
}
export const TONES = [
  ["formal", "Trang trọng"],
  ["neutral", "Trung tính"],
  ["friendly", "Thân thiện"],
] as const;
export const LENGTHS = [
  ["short", "Ngắn gọn"],
  ["medium", "Vừa"],
  ["long", "Dài"],
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
    lines.push(`Write a ${DRAFT_NOUN[t[0]]}: ${t[2]}`, `Tone: ${o.tone ?? "formal"}. Length: ${o.length ?? "medium"}.`);
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
function docSubject(name: string) {
  const base = stripExt(name);
  return /^(.{1,16}?)\s+—\s+(.+)$/.exec(base)?.[2] ?? base;
}
function subjectsLine(names: readonly string[]) {
  if (names.length === 1) return docSubject(names[0]);
  const short = names.slice(0, 2).map((n) => docSubject(n).split(" & ")[0].replace(/\s*\(.*?\)\s*/g, " ").trim());
  return short.join(" & ") + (names.length > 2 ? ` +${names.length - 2}` : "");
}

export function defaultTitle(kind: WorkKind, { spaceName, docNames, options, staffQuiz }: { spaceName?: string; docNames: readonly string[]; options: WorkOptions; staffQuiz?: boolean }): string {
  if (kind === "EVIDENCE_REVIEW") return spaceName ? `${spaceName} — tổng hợp bằng chứng` : "Tổng hợp bằng chứng";
  if (kind === "DRAFT") return `${draftTypeLabel(options.type ?? "email")}${spaceName ? ` — ${spaceName}` : ""}`;
  if (!docNames.length) return kindMeta(kind).label;
  if (kind === "STUDY_GUIDE") return `${subjectsLine(docNames)} — tài liệu ôn tập`;
  return staffQuiz ? `Bài kiểm tra — ${subjectsLine(docNames)}` : `Luyện tập — ${subjectsLine(docNames)}`;
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

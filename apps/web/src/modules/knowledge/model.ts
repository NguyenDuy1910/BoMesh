import {
  Archive,
  BookOpen,
  Calendar,
  ChartColumn,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  ClipboardList,
  Clock,
  Copy,
  Cpu,
  Database,
  EyeOff,
  File,
  FileText,
  FlaskConical,
  GraduationCap,
  Key,
  List,
  LoaderCircle,
  Megaphone,
  Monitor,
  Pencil,
  RefreshCw,
  Route,
  Shield,
  ShieldCheck,
  Sparkles,
  StickyNote,
  Table,
  Target,
  Terminal,
  User,
  type LucideIcon,
} from "lucide-react";

import { fmtDate } from "@/lib/format";

import type { Contribution, Item, ItemContent, SearchItemsFacet, SearchItemsRequest, SearchItemsResult, Topic } from "./api";

/**
 * The knowledge resource model (preview `core/catalog.js` + `core/lifecycle.js`)
 * mapped onto `/api/v1` Items: resource types, formats, topics, trust, the one
 * lifecycle label people see, and Browse's URL state ↔ SearchItems request.
 * Pure functions only: components read through `toResource()`.
 */

/* ═══════════════ Resource types (platform registry; workspace settings.documentTypes rename them) ═══════════════ */

export interface KindMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
  group: string;
}

export const RESOURCE_KINDS: Readonly<Record<string, KindMeta>> = {
  policy: { label: "Policy", plural: "Policies", icon: Shield, group: "Policies & procedures" },
  procedure: { label: "Procedure", plural: "Procedures", icon: Route, group: "Policies & procedures" },
  form: { label: "Form or checklist", plural: "Forms & checklists", icon: ClipboardList, group: "Policies & procedures" },
  guide: { label: "Guide", plural: "Guides", icon: BookOpen, group: "Policies & procedures" },
  calendar: { label: "Calendar", plural: "Calendars", icon: Calendar, group: "Policies & procedures" },
  faq: { label: "FAQ", plural: "FAQs", icon: CircleHelp, group: "Policies & procedures" },
  handbook: { label: "Handbook", plural: "Handbooks", icon: BookOpen, group: "Policies & procedures" },
  announcement: { label: "Announcement", plural: "Announcements", icon: Megaphone, group: "Policies & procedures" },
  syllabus: { label: "Syllabus", plural: "Syllabi", icon: List, group: "Teaching & learning" },
  lecture: { label: "Lecture slides", plural: "Lecture slides", icon: Monitor, group: "Teaching & learning" },
  lab: { label: "Lab or exercise", plural: "Labs & exercises", icon: Terminal, group: "Teaching & learning" },
  assignment: { label: "Assignment", plural: "Assignments", icon: Pencil, group: "Teaching & learning" },
  exam: { label: "Past exam", plural: "Past exams", icon: CircleCheck, group: "Teaching & learning" },
  paper: { label: "Paper", plural: "Papers", icon: FileText, group: "Research" },
  thesis: { label: "Thesis", plural: "Theses", icon: GraduationCap, group: "Research" },
  dataset: { label: "Dataset", plural: "Datasets", icon: Database, group: "Research" },
  protocol: { label: "Protocol", plural: "Protocols", icon: FlaskConical, group: "Research" },
  report: { label: "Report", plural: "Reports", icon: ChartColumn, group: "Research" },
  contract: { label: "Contract", plural: "Contracts", icon: Key, group: "Business" },
  spec: { label: "Technical reference", plural: "Technical references", icon: Cpu, group: "Business" },
  playbook: { label: "Playbook", plural: "Playbooks", icon: Target, group: "Business" },
  template: { label: "Template", plural: "Templates", icon: Copy, group: "Business" },
  sheet: { label: "Spreadsheet", plural: "Spreadsheets", icon: Table, group: "Business" },
  notes: { label: "Notes", plural: "Notes", icon: StickyNote, group: "Reference" },
  reference: { label: "Reference", plural: "References", icon: File, group: "Reference" },
};

/** Ordered [pattern, kind]; first match wins. Only for documents without a `documentType` yet. */
const KIND_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bfaq\b/i, "faq"], [/syllabus/i, "syllabus"], [/calendar/i, "calendar"], [/^notice|announcement|release notes|results? (are|for)|opens? /i, "announcement"],
  [/thesis/i, "thesis"], [/dataset/i, "dataset"], [/protocol/i, "protocol"], [/ et al\.| & [A-Z][a-z]+ (19|20)\d\d|survey/i, "paper"],
  [/^w\d\d\b|lecture|slides/i, "lecture"], [/^lab\b|\blab \d/i, "lab"], [/assignment|project brief/i, "assignment"], [/midterm|final exam|past exam|exam \d{4}/i, "exam"],
  [/template/i, "template"], [/agreement|\bnda\b|addendum|\bsow\b|order form|terms of service|\bdpa\b|\bmsa\b/i, "contract"],
  [/api reference|changelog|architecture|spec\b|error codes|rate limits|glossary|\badr-\d+/i, "spec"],
  [/playbook|battlecard|pitch|\bscript|case study|brief|objection|selling|sequences|kit\b|qbr deck/i, "playbook"],
  [/form\b|checklist|application\b/i, "form"], [/procedure|process|how to|runbook/i, "procedure"], [/policy|regulation|code of conduct|requirement|\brules\b|guidelines|standard\b/i, "policy"],
  [/guide|handbook|overview|explained/i, "guide"], [/notes|minutes|interview/i, "notes"], [/report|analysis|review\b/i, "report"],
];

export function inferKind(title: string, ext: string): string {
  for (const [re, kind] of KIND_RULES) if (re.test(title)) return kind;
  return ["xlsx", "xls", "csv", "tsv"].includes(ext) ? "sheet" : "reference";
}

/** Workspace document types (`settings.documentTypes`) as `{ key → label }`. */
export type DocumentTypeLabels = ReadonlyMap<string, string>;

export function kindMeta(kind: string, labels?: DocumentTypeLabels): KindMeta {
  const known = RESOURCE_KINDS[kind];
  const label = labels?.get(kind) ?? known?.label ?? (kind ? kind[0].toUpperCase() + kind.slice(1).replace(/[_-]+/g, " ") : RESOURCE_KINDS.reference.label);
  return known ? { ...known, label } : { label, plural: label, icon: File, group: "Reference" };
}

/* ═══════════════ Formats (what the file is, not what it's for) ═══════════════ */

export type FormatKey = "pdf" | "word" | "sheet" | "slides" | "text" | "image" | "archive" | "other";

export const FORMATS: Readonly<Record<FormatKey, { label: string; mimes: readonly string[] }>> = {
  pdf: { label: "PDF", mimes: ["application/pdf"] },
  word: { label: "Word", mimes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"] },
  sheet: { label: "Spreadsheet", mimes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "text/csv", "text/tab-separated-values"] },
  slides: { label: "Slides", mimes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-powerpoint"] },
  text: { label: "Text", mimes: ["text/markdown", "text/plain", "text/html", "application/json", "text/x-rst", "application/xml", "application/yaml"] },
  image: { label: "Image", mimes: ["image/png", "image/jpeg"] },
  archive: { label: "Archive", mimes: ["application/zip"] },
  other: { label: "Other", mimes: [] },
};

const EXT_FORMAT: Readonly<Record<string, FormatKey>> = {
  pdf: "pdf", doc: "word", docx: "word", xls: "sheet", xlsx: "sheet", csv: "sheet", tsv: "sheet", ppt: "slides", pptx: "slides",
  md: "text", markdown: "text", txt: "text", html: "text", htm: "text", json: "text", rst: "text", xml: "text", yaml: "text", yml: "text",
  png: "image", jpg: "image", jpeg: "image", zip: "archive",
};

export function formatOf(ext: string, mime?: string): FormatKey {
  if (EXT_FORMAT[ext]) return EXT_FORMAT[ext];
  const base = (mime ?? "").split(";")[0].trim();
  for (const [key, f] of Object.entries(FORMATS) as [FormatKey, (typeof FORMATS)[FormatKey]][]) if (f.mimes.includes(base)) return key;
  return "other";
}

/** Tone of the blank preview tile per format (`doc-thumb--<tone>`). */
export const FORMAT_TONE: Readonly<Partial<Record<FormatKey, "danger" | "accent" | "success" | "warning">>> = {
  pdf: "danger",
  word: "accent",
  sheet: "success",
  slides: "warning",
};

export const LANGS: Readonly<Record<string, string>> = { en: "English", vi: "Vietnamese" };
export const languageName = (code: string) => LANGS[code.split("-")[0]] ?? code;

/* ═══════════════ Topics (workspace taxonomy: domain → topic) ═══════════════ */

export interface TopicNode extends Topic {
  id: string;
  children: (Topic & { id: string })[];
}

const lastSegment = (name: string | undefined) => (name ? name.slice(name.lastIndexOf("/") + 1) : "");

/** Domains with their topics (active only), in API order. */
export function topicTree(topics: readonly Topic[]): TopicNode[] {
  const live = topics.filter((t) => !t.state || t.state === "ACTIVE");
  return live
    .filter((t) => t.kind === "DOMAIN")
    .map((d) => ({
      ...d,
      id: lastSegment(d.name),
      children: live.filter((t) => t.kind === "TOPIC" && t.parentTopic === d.name).map((t) => ({ ...t, id: lastSegment(t.name) })),
    }));
}

/** Topic name → display name. */
export function topicNames(topics: readonly Topic[]): Map<string, string> {
  return new Map(topics.map((t) => [t.name ?? "", t.displayName ?? "Untitled topic"]));
}

/* ═══════════════ Trust (verification + freshness) ═══════════════ */

export type TrustState = "verified" | "review" | "unverified" | "personal";

export const TRUST: Readonly<Record<TrustState, { tone: "success" | "warning" | "default"; label: string; icon: LucideIcon; desc: string }>> = {
  verified: { tone: "success", label: "Verified", icon: ShieldCheck, desc: "An owner confirmed it is accurate and current." },
  review: { tone: "warning", label: "Review due", icon: Clock, desc: "It may be out of date. Check with the owner before relying on it." },
  unverified: { tone: "default", label: "Not verified", icon: CircleDashed, desc: "No owner has confirmed it yet." },
  personal: { tone: "default", label: "Your file", icon: User, desc: "Only you can see it." },
};

export interface Trust {
  state: TrustState;
  /** Why: "Verified by … on …", "Verification expired …", "The original changed at the source…". Uses `verifierName` when known. */
  note: string;
  verifier?: string;
  verifyTime?: string;
  nextReviewTime?: string;
}

/** Trust of a document. Outdated at the source or past its review date → Review due. */
export function trustOf(item: Item, { personal = false, verifierName }: { personal?: boolean; verifierName?: string } = {}): Trust {
  if (personal) return { state: "personal", note: TRUST.personal.desc };
  const doc = item.document;
  const v = doc?.verification;
  const who = verifierName || "an owner";
  const base = { verifier: v?.verifier, verifyTime: v?.verifyTime, nextReviewTime: v?.nextReviewTime };
  if (doc?.indexingState === "OUTDATED") {
    return { state: "review", ...base, note: "The original changed at the source. Answers use the previous version until it’s reprocessed." };
  }
  const expired = v?.nextReviewTime && Date.parse(v.nextReviewTime) < Date.now();
  if (v?.state === "REVIEW_DUE" || (v?.state === "VERIFIED" && expired)) {
    return { state: "review", ...base, note: v?.nextReviewTime ? `Verification expired ${fmtDate(v.nextReviewTime)}.` : TRUST.review.desc };
  }
  if (v?.state === "VERIFIED") {
    const due = v.nextReviewTime ? ` · next review ${fmtDate(v.nextReviewTime)}` : "";
    return { state: "verified", ...base, note: `Verified by ${who} on ${fmtDate(v.verifyTime)}${due}.` };
  }
  return { state: "unverified", note: "No owner has confirmed this resource yet." };
}

/* ═══════════════ Lifecycle (one label for people; DOCUMENT_LIFECYCLE.md) ═══════════════ */

export type LifecycleKey =
  | "analyzing"
  | "review"
  | "changes"
  | "rejected"
  | "withdrawn"
  | "queued"
  | "publishing"
  | "published"
  | "update"
  | "failed"
  | "merged"
  | "stored"
  | "unpublished"
  | "archived";

export interface LifecycleMeta {
  tone: "default" | "accent" | "success" | "warning" | "danger";
  label: string;
  icon: LucideIcon;
  desc: string;
  live?: boolean;
  quiet?: boolean;
}

export const LIFECYCLE: Readonly<Record<LifecycleKey, LifecycleMeta>> = {
  analyzing: { tone: "accent", label: "Analyzing", icon: Sparkles, live: true, desc: "Reading the file and suggesting a type, topics and a knowledge base." },
  review: { tone: "accent", label: "In review", icon: Clock, desc: "A reviewer will check it before it’s published." },
  changes: { tone: "warning", label: "Changes requested", icon: Pencil, desc: "A reviewer asked for changes before it can be published." },
  rejected: { tone: "danger", label: "Not approved", icon: CircleX, desc: "It won’t be published." },
  withdrawn: { tone: "default", label: "Withdrawn", icon: Archive, desc: "You withdrew it. Reviewers don’t see it anymore." },
  queued: { tone: "default", label: "Waiting to publish", icon: Clock, desc: "Approved. It becomes searchable once it’s published." },
  publishing: { tone: "accent", label: "Publishing", icon: LoaderCircle, live: true, desc: "It will be searchable in a few minutes." },
  published: { tone: "success", label: "Published", icon: CircleCheck, quiet: true, desc: "Searchable and available to the assistant." },
  update: { tone: "warning", label: "Update available", icon: RefreshCw, desc: "The original changed. Answers use the previous version until it’s republished." },
  failed: { tone: "danger", label: "Couldn’t publish", icon: CircleAlert, desc: "It was approved but couldn’t be made searchable." },
  merged: { tone: "success", label: "Published as new version", icon: CircleCheck, quiet: true, desc: "It replaced the earlier version of the document." },
  stored: { tone: "default", label: "Stored, not searchable", icon: File, desc: "This file type can’t be searched. People can still download it." },
  unpublished: { tone: "default", label: "Unpublished", icon: EyeOff, desc: "Removed from search and answers. Reviewers can publish it again." },
  archived: { tone: "default", label: "Archived", icon: Archive, desc: "Removed from the library." },
};

const INDEXING_TO_LIFE: Readonly<Record<string, LifecycleKey>> = {
  PENDING: "queued",
  RUNNING: "publishing",
  SUCCEEDED: "published",
  OUTDATED: "update",
  FAILED: "failed",
  UNSUPPORTED: "stored",
};

const CONTRIBUTION_TO_LIFE: Readonly<Record<string, LifecycleKey>> = {
  ANALYZING: "analyzing",
  IN_REVIEW: "review",
  CHANGES_REQUESTED: "changes",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",
};

/** Lifecycle key of a document and/or its contribution. An open contribution decides; otherwise the item's states do. */
export function lifecycleKey({ item, contribution }: { item?: Item | null; contribution?: Contribution | null }): LifecycleKey {
  if (contribution?.state && CONTRIBUTION_TO_LIFE[contribution.state]) return CONTRIBUTION_TO_LIFE[contribution.state];
  if (contribution?.state === "APPROVED" && contribution.kind === "NEW_REVISION") return "merged";
  if (!item) return contribution?.state === "APPROVED" ? "published" : "review";
  if (item.state === "DELETED") return "archived";
  const doc = item.document;
  if (doc?.publicationState === "UNPUBLISHED") return "unpublished";
  if (doc?.contentState === "FAILED") return "failed";
  if (doc?.contentState === "PENDING") return "queued";
  return INDEXING_TO_LIFE[doc?.indexingState ?? "PENDING"] ?? "published";
}

/** Groups for filters: [key, label, lifecycle keys]. */
export const LIFE_GROUPS: ReadonlyArray<readonly [string, string, readonly LifecycleKey[]]> = [
  ["review", "In review", ["analyzing", "review"]],
  ["changes", "Changes requested", ["changes"]],
  ["attention", "Needs attention", ["failed", "queued", "update"]],
  ["publishing", "Publishing", ["publishing"]],
  ["published", "Published", ["published", "stored", "merged"]],
  ["rejected", "Not approved", ["rejected"]],
  ["unpublished", "Unpublished", ["unpublished"]],
];

/* ═══════════════ Resource view model ═══════════════ */

export interface ModelContext {
  /** Bare workspace ID. */
  workspaceId: string;
  /** The caller's PERSONAL collection name ("My files"). */
  personalCollection?: string;
  documentTypes?: DocumentTypeLabels;
  /** Topic name → display name. */
  topicNames?: ReadonlyMap<string, string>;
  /** Collection name → display name (knowledge bases, `ancestors` facet values, item ancestors). */
  collectionNames?: ReadonlyMap<string, string>;
}

export interface ResourceSource {
  /** `upload` or the source's resource name. */
  key: string;
  /** `upload` for uploads; for synced files the source name (the shell's AppIcon resolves a connector by source). */
  isUpload: boolean;
  path: string;
  url: string;
}

export interface Resource {
  item: Item;
  /** Full item name. */
  name: string;
  /** Bare item ID (routes: `/doc/{id}`). */
  id: string;
  /** Display name without a file extension. */
  title: string;
  fileName: string;
  /** Lower-case extension ("pdf"). */
  ext: string;
  mime: string;
  format: FormatKey;
  kind: string;
  kindMeta: KindMeta;
  /** Topic names (resource names). */
  topics: string[];
  /** The knowledge base (root collection) or the parent collection when the root isn't known. */
  base: { name: string; id: string; displayName: string } | null;
  isPersonal: boolean;
  /** Member resource name accountable for the content. */
  owner?: string;
  source: ResourceSource;
  summary: string;
  language: string;
  updated?: string;
  sizeBytes: number;
  trust: Trust;
  lifecycle: LifecycleKey;
  /** Has a searchable rendition (passages, Ask). */
  readable: boolean;
  /** Caller can edit (from `access`; confirm with testIamPermissions for actions). */
  editable: boolean;
  deleted: boolean;
  thumbnailUri?: string;
}

/** The knowledge base an item lives in: the root ancestor (FULL view) else the parent when known. */
function baseOf(item: Item, ctx: ModelContext): Resource["base"] {
  const root = item.ancestors?.[0];
  const name = root?.name || item.parentItem || "";
  if (!name) return null;
  const displayName = root?.displayName || ctx.collectionNames?.get(name) || "";
  return { name, id: lastSegment(name), displayName };
}

/** Everything the knowledge UI shows about a document. Cheap; call freely. */
export function toResource(item: Item, ctx: ModelContext, extra: { contribution?: Contribution | null; verifierName?: string } = {}): Resource {
  const doc = item.document;
  const fileName = doc?.fileName || item.displayName || "";
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(fileName)?.[1] ?? "").toLowerCase();
  const title = (item.displayName || fileName).replace(/\.[a-z0-9]{1,5}$/i, "");
  const kind = doc?.documentType && doc.documentType !== "markdown" ? doc.documentType : inferKind(title, ext);
  const base = baseOf(item, ctx);
  const isPersonal = !!ctx.personalCollection && (base?.name === ctx.personalCollection || item.parentItem === ctx.personalCollection);
  const origin = doc?.origin;
  const index = doc?.indexingState;
  return {
    item,
    name: item.name ?? "",
    id: lastSegment(item.name),
    title,
    fileName,
    ext,
    mime: doc?.mimeType ?? "",
    format: formatOf(ext, doc?.mimeType),
    kind,
    kindMeta: kindMeta(kind, ctx.documentTypes),
    topics: doc?.topics ?? [],
    base: base && isPersonal ? { ...base, displayName: base.displayName || "My files" } : base,
    isPersonal,
    owner: doc?.owner,
    source: {
      key: origin?.source || "upload",
      isUpload: !origin?.source,
      path: origin?.path ?? "",
      url: origin?.externalUri ?? "",
    },
    summary: doc?.summary ?? "",
    language: doc?.languageCode || "en",
    updated: item.updateTime,
    sizeBytes: Number(doc?.sizeBytes ?? 0),
    trust: trustOf(item, { personal: isPersonal, verifierName: extra.verifierName }),
    lifecycle: lifecycleKey({ item, contribution: extra.contribution }),
    readable: index === "SUCCEEDED" || index === "OUTDATED",
    editable: item.access === "EDITOR" || item.access === "OWNER",
    deleted: item.state === "DELETED",
    thumbnailUri: doc?.thumbnailUri,
  };
}

/** Pipeline states only editors can act on (preview `statusChip`); `null` for healthy/readable documents. */
export function indexStatusOf(r: Resource): "pending" | "processing" | "failed" | "unsupported" | null {
  if (!r.editable || r.isPersonal) return null;
  const s = r.item.document?.indexingState;
  if (r.item.document?.contentState === "FAILED" || s === "FAILED") return "failed";
  if (s === "RUNNING") return "processing";
  if (s === "PENDING") return "pending";
  if (s === "UNSUPPORTED") return "unsupported";
  return null;
}

/* ═══════════════ Browse: facets, URL state ↔ SearchItems ═══════════════ */

export type FacetId = "topic" | "kind" | "owner" | "src" | "kb" | "trust" | "upd" | "fmt";

export interface FacetDef {
  id: FacetId;
  label: string;
  /** SearchItems facet field; `null` when computed locally (Updated). */
  field: string | null;
  single?: boolean;
}

/**
 * Browse dimensions backed by SearchItems. Missing vs the preview: Space (no item ↔ space
 * facet; space materials aren't searchable) and Language (`document.languageCode` is a facet
 * but not a filter field). See the knowledge-core report.
 */
export const FACETS: readonly FacetDef[] = [
  { id: "topic", label: "Topic", field: "document.topics" },
  { id: "kind", label: "Type", field: "document.documentType" },
  { id: "owner", label: "Owner", field: "document.owner" },
  { id: "src", label: "Source", field: "document.origin.source" },
  { id: "kb", label: "Knowledge base", field: "ancestors" },
  { id: "trust", label: "Trust", field: "document.verification.state" },
  { id: "upd", label: "Updated", field: null, single: true },
  { id: "fmt", label: "Format", field: "document.mimeType" },
];

export const UPDATED_WINDOWS: ReadonlyArray<readonly [string, string, number]> = [
  ["7d", "Past week", 7],
  ["30d", "Past month", 30],
  ["365d", "Past year", 365],
];

export const SORTS_CATALOG = { relevance: "Best match", updated: "Recently updated", title: "Title A–Z" } as const;
export type CatalogSort = keyof typeof SORTS_CATALOG;

export interface CatalogParams {
  q: string;
  /** "" = default (relevance with a query, else updated). */
  sort: CatalogSort | "";
  view: "grid" | "list";
  /** Facet id → selected values (bare IDs for topics, bases, owners, sources; keys otherwise). */
  filters: Partial<Record<FacetId, string[]>>;
  /** "Only documents I saved". */
  saved?: boolean;
}

type QueryLike = URLSearchParams | Readonly<Record<string, string | undefined>>;
const read = (q: QueryLike, key: string) => (q instanceof URLSearchParams ? q.get(key) : q[key]) ?? "";

/** URL query → catalog params. Multi-value facets are comma lists (preview `parseCatalogQuery`). */
export function parseCatalogQuery(query: QueryLike): CatalogParams {
  const sort = read(query, "sort");
  const p: CatalogParams = {
    q: read(query, "q").trim(),
    sort: sort in SORTS_CATALOG ? (sort as CatalogSort) : "",
    view: read(query, "view") === "list" ? "list" : "grid",
    filters: {},
  };
  for (const f of FACETS) {
    const values = read(query, f.id).split(",").filter(Boolean);
    if (values.length) p.filters[f.id] = f.single ? [values[0]] : values;
  }
  if (read(query, "saved") === "1") p.saved = true;
  return p;
}

/** Catalog params → query record (empty values dropped) for `router.replace`/hrefs. */
export function catalogQueryOf(p: Partial<CatalogParams>): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.q) out.q = p.q;
  if (p.sort) out.sort = p.sort;
  if (p.view === "list") out.view = "list";
  if (p.saved) out.saved = "1";
  for (const f of FACETS) {
    const v = p.filters?.[f.id];
    if (v?.length) out[f.id] = v.join(",");
  }
  return out;
}

/** `/knowledge?…` (Browse) for a params patch, e.g. `catalogHref({ filters: { topic: [topicId] } })`. */
export function catalogHref(p: Partial<CatalogParams> = {}): string {
  const qs = new URLSearchParams(catalogQueryOf(p)).toString();
  return "/knowledge" + (qs ? `?${qs}` : "");
}

export const activeFilterCount = (p: CatalogParams) =>
  Object.values(p.filters).reduce((n, v) => n + (v?.length ?? 0), 0) + (p.saved ? 1 : 0);

const TRUST_STATE: Readonly<Record<string, string>> = { verified: "VERIFIED", review: "REVIEW_DUE", unverified: "UNVERIFIED" };
const TRUST_KEY: Readonly<Record<string, TrustState>> = { VERIFIED: "verified", REVIEW_DUE: "review", UNVERIFIED: "unverified" };

/** AIP-160 string literal. */
const lit = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The AIP-160 clause for one facet's selected values (OR within a facet). */
function facetClause(id: FacetId, values: readonly string[], ws: string, topics?: readonly Topic[]): string {
  const any = (parts: string[]) => (parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0] ?? "");
  switch (id) {
    case "topic": {
      // Selecting a domain matches everything under it (preview topicLineage).
      const names = new Set<string>();
      for (const v of values) {
        const name = `workspaces/${ws}/topics/${v}`;
        names.add(name);
        for (const t of topics ?? []) if (t.parentTopic === name && t.name) names.add(t.name);
      }
      return any([...names].map((n) => `document.topics:${lit(n)}`));
    }
    case "kind":
      return any(values.map((v) => `document.documentType = ${lit(v)}`));
    case "owner":
      return any(values.map((v) => `document.owner = ${lit(`workspaces/${ws}/members/${v}`)}`));
    case "src":
      return any(values.map((v) => `document.origin.source = ${lit(v === "upload" ? "" : `workspaces/${ws}/sources/${v}`)}`));
    case "kb":
      return any(values.map((v) => `ancestors:${lit(`workspaces/${ws}/items/${v}`)}`));
    case "trust":
      return any(values.filter((v) => TRUST_STATE[v]).map((v) => `document.verification.state = ${TRUST_STATE[v]}`));
    case "fmt":
      return any(values.flatMap((v) => (FORMATS[v as FormatKey]?.mimes ?? []).map((m) => `document.mimeType = ${lit(m)}`)));
    case "upd": {
      const days = UPDATED_WINDOWS.find((w) => w[0] === values[0])?.[2];
      return days ? `updateTime >= ${lit(new Date(Date.now() - days * 86_400_000).toISOString())}` : "";
    }
  }
}

/** AIP-160 filter for the selected facets (AND across facets); `base` adds extra clauses (e.g. a subtree). */
export function catalogFilter(p: CatalogParams, ws: string, { topics, base }: { topics?: readonly Topic[]; base?: string } = {}): string {
  const clauses = FACETS.map((f) => (p.filters[f.id]?.length ? facetClause(f.id, p.filters[f.id]!, ws, topics) : "")).filter(Boolean);
  if (base) clauses.unshift(base);
  return clauses.join(" AND ");
}

export const ORDER_BY: Readonly<Record<CatalogSort, string>> = { relevance: "", updated: "updateTime desc", title: "displayName" };

/** SearchItems request for Browse (facets disjunctive, snippets + passages for previews). */
export function catalogSearchRequest(
  p: CatalogParams,
  ws: string,
  options: { topics?: readonly Topic[]; base?: string; pageSize?: number; pageToken?: string; facets?: boolean } = {},
): SearchItemsRequest {
  const sort = p.sort || (p.q ? "relevance" : "updated");
  return {
    query: p.q || undefined,
    filter: catalogFilter(p, ws, options) || undefined,
    orderBy: ORDER_BY[sort] || undefined,
    facetSpecs:
      options.facets === false
        ? undefined
        : FACETS.filter((f) => f.field).map((f) => ({ field: f.field!, limit: f.id === "topic" ? 100 : 30, excludedFromFilter: true })),
    contentSearchSpec: p.q ? { snippets: true, passages: 1 } : undefined,
    pageSize: options.pageSize ?? 30,
    pageToken: options.pageToken,
  };
}

export interface FacetOption {
  value: string;
  label: string;
  count: number;
  on: boolean;
}

/**
 * API facets → `{ facetId: options }` with bare-ID values, preview labels and selected
 * values kept (count 0) so people can always deselect them. Formats are grouped by family.
 */
export function facetOptions(
  facets: readonly SearchItemsFacet[] | undefined,
  p: CatalogParams,
  labels: { kind?: (key: string) => string; owner?: (name: string) => string; source?: (name: string) => string } = {},
): Partial<Record<FacetId, FacetOption[]>> {
  const out: Partial<Record<FacetId, FacetOption[]>> = {};
  for (const def of FACETS) {
    const counts = new Map<string, { label: string; count: number }>();
    const add = (value: string, label: string, count: number) => {
      const prev = counts.get(value);
      counts.set(value, { label: prev?.label || label, count: (prev?.count ?? 0) + count });
    };
    const api = facets?.find((f) => f.field === def.field);
    for (const v of api?.values ?? []) {
      const raw = v.value ?? "";
      const n = v.documentCount ?? 0;
      switch (def.id) {
        case "topic":
        case "kb":
          add(lastSegment(raw), v.displayName || "Untitled", n);
          break;
        case "owner":
          add(raw ? lastSegment(raw) : "—", raw ? labels.owner?.(raw) || v.displayName || "Owner" : "No owner", n);
          break;
        case "src":
          add(raw ? lastSegment(raw) : "upload", raw ? labels.source?.(raw) || v.displayName || "Source" : "Uploaded files", n);
          break;
        case "kind":
          add(raw, labels.kind?.(raw) || v.displayName || raw, n);
          break;
        case "trust":
          if (TRUST_KEY[raw]) add(TRUST_KEY[raw], TRUST[TRUST_KEY[raw]].label, n);
          break;
        case "fmt": {
          const key = formatOf("", raw);
          add(key, FORMATS[key].label, n);
          break;
        }
      }
    }
    if (def.id === "upd") for (const [key, label] of UPDATED_WINDOWS) add(key, label, 0);
    for (const v of p.filters[def.id] ?? []) if (!counts.has(v)) add(v, v, 0);
    const opts = [...counts].map(([value, x]) => ({ value, label: x.label, count: x.count, on: !!p.filters[def.id]?.includes(value) }));
    if (def.id !== "upd") opts.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    out[def.id] = opts;
  }
  return out;
}

/** Highlighted snippet (the API marks matches with `<b>…</b>` or `<mark>`); `null` when none. */
export function snippetOf(result: SearchItemsResult): string | null {
  return result.snippets?.[0] || null;
}

/** The best passage of a search hit: `{ where: "Page 2", text }`. */
export function passageOf(result: SearchItemsResult): { where: string; text: string; passage?: string } | null {
  const p = result.passages?.[0];
  if (!p?.text) return null;
  return { where: p.pageNumber ? `Page ${p.pageNumber}` : "", text: p.text, passage: p.passage };
}

/** Lowercase and strip diacritics ("Lịch" → "lich"); used for local highlighting. */
export const fold = (s: string) =>
  s.toLowerCase().replace(/[^\u0000-\u007f]/g, (c) => (c === "đ" ? "d" : c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0) || c));

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i if in is it me my of on or our the their to was we what when where which who why will with you your about this that these those there any all after before".split(" "),
);

/** Query words worth highlighting (folded, no stop words). */
export const tokens = (q: string) =>
  fold(q)
    .replace(/[“”"]/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));

/** Splits text into plain and matching parts for `<mark class="srch-hl">` rendering (accent-insensitive). */
export function markParts(text: string, q: string): { text: string; hit: boolean }[] {
  const toks = tokens(q);
  if (!toks.length || !text) return [{ text, hit: false }];
  const folded = fold(text);
  const marks: [number, number][] = [];
  for (const t of toks) {
    let i = folded.indexOf(t);
    while (i >= 0) {
      marks.push([i, i + t.length]);
      i = folded.indexOf(t, i + t.length);
    }
  }
  if (!marks.length) return [{ text, hit: false }];
  marks.sort((a, b) => a[0] - b[0]);
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (e <= at) continue;
    const start = Math.max(s, at);
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, e), hit: true });
    at = e;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}

/* ═══════════════ Contribute (document_contract.md "Formats") ═══════════════ */

/** Knowledge formats the API accepts in a member's PERSONAL collection (images are attachments only; archives only into STANDARD collections). */
export const CONTRIBUTE_TYPES = ["pdf", "docx", "xlsx", "pptx", "txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "rst", "xml", "yaml", "yml"] as const;
/** Upload limit (`FILE_TOO_LARGE` above it). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Why a file can't be contributed, or "" when it can. */
export function fileProblem(file: { name: string; size: number }): string {
  const ext = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  if (!(CONTRIBUTE_TYPES as readonly string[]).includes(ext)) return "This file type isn’t supported";
  if (file.size > MAX_UPLOAD_BYTES) return "Larger than 100 MB";
  if (!file.size) return "This file is empty";
  return "";
}

/* ═══════════════ Glance: what a card preview shows (preview `X.res.glance` / `preview`) ═══════════════ */

export interface GlanceBlock {
  kind: "p" | "li" | "row";
  text: string;
  page: number;
  heading: string;
  /** Table cells for `row` blocks. */
  cells?: string[];
}

export interface GlanceSection {
  title: string;
  page: number;
  blocks: GlanceBlock[];
}

export interface Glance {
  layout: "text" | "sheet" | "slides";
  sections: GlanceSection[];
  blocks: GlanceBlock[];
  /** First page image (sheets, slides) — a signed, short-lived URL. */
  pageImage?: string;
  count: number;
  /** "6 pages", "4 slides", "Spreadsheet". */
  extent: string;
  /** The opening paragraph (card "what it's for" when there is no summary). */
  opening: string;
}

const cellsOf = (line: string) =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split(/\s*\|\s*|\t/)
    .map((c) => c.trim());

/** Builds the glance of a document from its reader content; `null` without readable content. */
export function glanceOf(content: ItemContent | undefined, format: FormatKey): Glance | null {
  const elements = content?.elements ?? [];
  if (!elements.length) return null;
  const blocks: GlanceBlock[] = [];
  const sections: GlanceSection[] = [];
  let heading = "";
  let pages = 1;
  for (const el of elements) {
    const page = el.pageNumber ?? 1;
    pages = Math.max(pages, page);
    const text = (el.text ?? "").trim();
    if (!text) continue;
    if (el.kind === "HEADING") {
      heading = text;
      continue;
    }
    const push = (b: GlanceBlock) => {
      blocks.push(b);
      let s = sections.find((x) => x.title === b.heading);
      if (!s) sections.push((s = { title: b.heading, page: b.page, blocks: [] }));
      s.blocks.push(b);
    };
    if (el.kind === "LIST") {
      for (const line of text.split(/\n+/)) {
        const item = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
        if (item) push({ kind: "li", text: item, page, heading });
      }
    } else if (el.kind === "TABLE") {
      const rows = text.split(/\n+/).filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l));
      const head = rows[0] ? cellsOf(rows[0]) : [];
      for (const line of rows.slice(1)) {
        const cells = cellsOf(line);
        push({ kind: "row", text: cells.map((c, i) => (head[i] ? `${head[i]}: ${c}` : c)).join(" · "), page, heading, cells: head.length ? cells : undefined });
      }
    } else if (el.kind === "PARAGRAPH" || el.kind === "CODE") {
      push({ kind: "p", text, page, heading });
    }
  }
  const layout = format === "sheet" ? "sheet" : format === "slides" ? "slides" : "text";
  const first = [...(content?.pageAssets ?? [])].sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))[0];
  pages = Math.max(pages, content?.pageAssets?.length ?? 0);
  return {
    layout,
    sections,
    blocks,
    pageImage: first?.imageUri,
    count: pages,
    extent: layout === "sheet" ? "Spreadsheet" : `${pages} ${layout === "slides" ? (pages === 1 ? "slide" : "slides") : pages === 1 ? "page" : "pages"}`,
    opening: blocks.find((b) => b.kind === "p")?.text ?? "",
  };
}

/** Sections people open each kind of document for (matched against its own section titles; nothing invented). */
const KEY_SECTION: Readonly<Record<string, RegExp>> = {
  procedure: /step|how|process|checklist/i,
  guide: /step|how|getting started|key/i,
  handbook: /how|key|work/i,
  playbook: /key|play|talk|step|pitch|how/i,
  form: /step|checklist|require|week|before/i,
  notes: /decision|action|outcome|next/i,
  report: /finding|result|recommend|conclusion|key|summary/i,
  policy: /rule|require|limit|approv|eligib|entitle|allowance|pay|retention/i,
  spec: /endpoint|event|schema|object|decision|error|limit|auth|retention|component|code|variant|definition/i,
  contract: /term|obligation|fee|payment|termination/i,
  calendar: /date|deadline|schedule/i,
};
const INTRO = /^(overview|purpose|welcome|introduction|summary|about|context|background|parties)$/i;

/** The best block for a query (most query words). */
function matchBlock(g: Glance, toks: string[]): GlanceBlock | null {
  let best: GlanceBlock | null = null;
  let bestN = 0;
  for (const b of g.blocks) {
    const low = fold(b.text);
    const n = toks.filter((t) => low.includes(t)).length;
    if (n > bestN) {
      best = b;
      bestN = n;
    }
  }
  return best;
}

/**
 * The section a card preview shows: where the search matches (unless the title already explains it);
 * else the section this kind of document is opened for, skipping the introduction; else the first.
 */
export function focusSection(g: Glance, kind: string, q: string, title: string): { section: GlanceSection; hit: GlanceBlock | null } | null {
  const toks = tokens(q);
  const titleHit = toks.length > 0 && toks.every((t) => fold(title).includes(t));
  const hit = toks.length && !titleHit ? matchBlock(g, toks) : null;
  if (hit) {
    const section = g.sections.find((s) => s.title === hit.heading);
    if (section) return { section, hit };
  }
  const re = KEY_SECTION[kind];
  const score = (s: GlanceSection, i: number) =>
    (re?.test(s.title) ? 4 : 0) +
    (s.blocks.some((b) => b.kind === "li" || b.kind === "row") ? 2 : 0) +
    (s.blocks.some((b) => /\d/.test(b.text)) ? 1 : 0) -
    (INTRO.test(s.title) && g.sections.length > 1 ? 3 : 0) -
    i * 0.01;
  const best = g.sections.map((s, i) => [s, score(s, i)] as const).sort((a, b) => b[1] - a[1])[0];
  return best ? { section: best[0], hit: null } : null;
}

/** Clip at a word boundary with an ellipsis. */
export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);

import { Copy, File, History, Shield, type LucideIcon } from "lucide-react";

import { resourceId } from "@/lib/api/client";
import type { StudioSectionId } from "@/lib/navigation";
import { serverText } from "@/lib/i18n";
import { fileExt } from "@/components/ui/FileIcon";
import type { DocumentConcept } from "@/modules/knowledge/api";
import { docTypeOf, lifecycleKey, type DocTypeId, type LifecycleKey } from "@/modules/knowledge/model";

import type { Contribution, Item } from "./api";
import { canProcess, changedAtSource, isCandidate, processingOf, publicationOf, type ProcessingKey, type PublicationKey } from "./lifecycle";

/**
 * Knowledge Studio view model (preview `features/curation.js` + `core/lifecycle.js`): sections and their
 * addresses, Documents' views, flags, confidence badges, quick replies, document rows (publication and
 * processing apart, `./lifecycle`) and the operations every document row offers.
 */

/* ═══════════════ Sections and addresses ═══════════════ */

export const STUDIO_BASE = "/studio";

/** `/studio?tab=…&…` (empty values are left out). */
export function studioHref(tab: StudioSectionId, params: Readonly<Record<string, string | undefined | null>> = {}): string {
  const q = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `${STUDIO_BASE}?${q.toString()}`;
}

/* ═══════════════ Documents' views ═══════════════ */

/**
 * Documents' views (`?view=`), as page tabs in the order work flows: All (the registry, with its Quality filter),
 * Processing (what isn't processed yet: new documents' submissions first, then documents) and Review (submissions
 * ready to decide). Processing counts quietly, Review what waits for a decision; All carries no count. The preview's
 * sync batches have no endpoint and are left out of Review. Named by `m.studio.documentViews[view]`.
 */
export const DOC_VIEWS = ["all", "processing", "review"] as const;
export type DocView = (typeof DOC_VIEWS)[number];

/** All's Quality filter (`?quality=`): the lists that keep published knowledge right, each row with its fix. Named by `m.studio.quality[part]`. */
export const QUALITY_PARTS = ["reverify", "details", "duplicates"] as const;
export type QualityPart = (typeof QUALITY_PARTS)[number];

/**
 * Items per Documents view and per Quality list: `review` (ready to decide), `processing` (not processed yet), of which
 * `waiting` waits on the caller (submissions, failures, changes at the source) and `submissions` are new documents'
 * submissions.
 */
export type DocCounts = Readonly<Record<"review" | "processing" | "waiting" | "submissions" | QualityPart, number>>;

/** What a Documents view counts (All carries no count). */
export const viewCount = (c: DocCounts, view: DocView) => (view === "all" ? 0 : c[view]);

/** Every Quality list's items (All's Quality button). */
export const qualityCount = (c: DocCounts) => c.reverify + c.details + c.duplicates;

/** `/studio?tab=documents&view=…` (preview `docsHref`). */
export const docsHref = (view: DocView = "all", params: Readonly<Record<string, string | undefined | null>> = {}) => studioHref("documents", { view, ...params });

/** `/studio?tab=taxonomy&view=…` (preview `taxonomyHref`): `view` = a scheme ID (its tree; `node` = a concept ID) or
 *  `suggestions`; without one, Classification opens its first scheme. */
export const taxonomyHref = (view?: string, params: Readonly<Record<string, string | undefined | null>> = {}) => studioHref("taxonomy", { view, ...params });

/**
 * The open Documents view: `?view=`, else Review when `?sel=` names a submission or Review has entries, else
 * Processing while something there waits on the caller, else All.
 */
export function docView(query: { view?: string | null; sel?: string | null }, counts: DocCounts): DocView {
  if (DOC_VIEWS.some((v) => v === query.view)) return query.view as DocView;
  if (query.sel || counts.review) return "review";
  return counts.waiting ? "processing" : "all";
}

/** All's Quality list: `?quality=`, else none. */
export const qualityOf = (quality: string | null | undefined): QualityPart | "" => QUALITY_PARTS.find((p) => p === quality) ?? "";

/** The Quality list with something in it (an address that names none), else Re-verification due. */
export const firstQualityPart = (counts: DocCounts | undefined): QualityPart => QUALITY_PARTS.find((p) => counts?.[p]) ?? "reverify";

/** What keeps documents from people: Review, and what waits on the caller in Processing (the Studio landing). */
export const decisionCount = (c: Pick<DocCounts, "review" | "waiting">) => c.review + c.waiting;

/* ═══════════════ Submissions ═══════════════ */

export type FlagType = "duplicate" | "version" | "personal" | "format";

/** Blocking risks are labelled chips (`chip`); informational signals stay a small icon with a tooltip. */
export const FLAG_META: Readonly<Record<FlagType, { icon: LucideIcon; label: string; tone: "warning" | "accent" | "danger" | "default"; chip: boolean }>> = {
  duplicate: { icon: Copy, label: "Có thể trùng lặp", tone: "warning", chip: true },
  personal: { icon: Shield, label: "Dữ liệu cá nhân", tone: "danger", chip: true },
  version: { icon: History, label: "Phiên bản mới", tone: "accent", chip: false },
  format: { icon: File, label: "Không tra cứu được", tone: "default", chip: false },
};

const FLAG_OF: Readonly<Record<string, FlagType>> = {
  DUPLICATE: "duplicate",
  NEW_REVISION: "version",
  PERSONAL_DATA: "personal",
  UNSEARCHABLE_FORMAT: "format",
};

export interface Flag {
  type: FlagType;
  /** Related item name when the caller can see it. */
  related?: string;
}

export function flagsOf(c: Contribution): Flag[] {
  const out: Flag[] = (c.flags ?? []).flatMap((f) => (f.kind && FLAG_OF[f.kind] ? [{ type: FLAG_OF[f.kind], related: f.relatedItem || undefined }] : []));
  // A NEW_REVISION is a new version even when the server didn't flag it.
  if (c.kind === "NEW_REVISION" && !out.some((f) => f.type === "version")) out.unshift({ type: "version", related: c.replacesItem });
  return out;
}

export const hasFlag = (c: Contribution, type: FlagType) => flagsOf(c).some((f) => f.type === type);
export const isAnalyzing = (c: Contribution) => c.state === "ANALYZING";

export const QUEUE_FILTERS = [
  ["all", "Tất cả"],
  ["flagged", "Đã gắn cờ"],
  ["version", "Phiên bản mới"],
  ["sync", "Từ nguồn dữ liệu"],
] as const;
export type QueueFilter = (typeof QUEUE_FILTERS)[number][0];

export const QUEUE_FILTER_FN: Readonly<Record<QueueFilter, (c: Contribution) => boolean>> = {
  all: () => true,
  flagged: (c) => flagsOf(c).length > 0,
  version: (c) => c.kind === "NEW_REVISION",
  sync: (c) => c.origin === "SOURCE",
};

/** Search and filters appear once a list is long enough to need them (or one is in use). */
export const MANY = 6;

/** The last event (what the queue shows as "· 2 hours ago"). */
export function lastEvent(c: Contribution): { kind: string; at: string; message?: string; actor?: string } {
  const evs = (c.events ?? []).filter((e) => e.kind !== "ANALYZED");
  const e = evs.at(-1);
  return e ? { kind: e.kind ?? "", at: e.createTime ?? c.updateTime ?? "", message: e.message, actor: e.actor } : { kind: "SUBMITTED", at: c.createTime ?? "" };
}

/** The collection a submission goes to: its target, else the assistant's suggestion. */
export const targetOf = (c: Contribution) => c.targetCollection || c.suggestions?.collection || "";

/** Revision number from a revision name (`…/revisions/3` → 3). */
export function versionOf(revision: string | undefined): number | null {
  const n = Number(resourceId(revision));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const QUICK_REPLIES = {
  changes: [
    "Hãy xóa dữ liệu cá nhân (họ tên, điểm số, số định danh) rồi gửi lại.",
    "Hãy thêm ghi chú ngắn về nội dung và đối tượng của tài liệu.",
    "Hãy tải lên phiên bản cuối dưới dạng PDF.",
  ],
  decline: [
    "Tài liệu này đã được công bố. Hãy dùng tài liệu hiện có.",
    "Không công bố được tài liệu có bản quyền.",
    "Tài liệu chứa dữ liệu cá nhân không được chia sẻ.",
    "Tài liệu không thuộc kho tài liệu này.",
  ],
} as const;

/* ═══════════════ Documents: rows ═══════════════ */

/** A failed document whose file is locked (password-protected): it needs a new file, not a retry. */
export const isLocked = (item: Item | null | undefined) => /password/i.test(item?.document?.indexingError?.message ?? "");

/** Where a document came from: a source, a member's contribution, or an editor's upload (Documents' Origin). */
export type OriginKey = "contrib" | "upload" | string;

/** One Documents row: a document in a collection the caller curates, or a submission that isn't published. */
export interface DocRow {
  /** Bare item ID (stable key; candidates keep their ID when approved). */
  id: string;
  item: Item | null;
  /** The latest contribution about this document, if any. */
  contribution: Contribution | null;
  lifecycle: LifecycleKey;
  /** Publication and processing, apart (`./lifecycle`): either can be where a document stopped. */
  publication: PublicationKey;
  processing: ProcessingKey;
  title: string;
  fileName: string;
  ext: string;
  mime: string;
  /** Collection name (full) and display name. */
  base: string;
  baseName: string;
  /** Member who contributed it (submissions) or created it (uploads). */
  contributor?: string;
  /** Source resource name for synced files. */
  source?: string;
  /** `contrib`, `upload` or the source name. */
  origin: OriginKey;
  /** The file class (`itemType`). */
  type: DocTypeId;
  /** Its concept assignments (`document.concepts`, ACCEPTED and SUGGESTED): a submission's are what the assistant
   *  chose for its candidate while processing it. */
  assignments: DocumentConcept[];
  owner?: string;
  updated: string;
}

/** The item's lifecycle, with a published document that changed at its source counted as Changed at the source. */
export function itemLifecycle(item: Item): LifecycleKey {
  const k = lifecycleKey({ item });
  return k === "published" && changedAtSource(item) ? "update" : k;
}

export function rowOf(item: Item | null, contribution: Contribution | null, baseNames: ReadonlyMap<string, string>): DocRow {
  const fileName = item?.document?.fileName || item?.displayName || "";
  const ext = fileExt({ name: fileName });
  const title = (item?.displayName || fileName || "Tài liệu chưa đặt tên").replace(/\.[a-z0-9]{1,5}$/i, "");
  const open = !!contribution && contribution.state !== "APPROVED" && contribution.state !== "WITHDRAWN";
  const base = open ? targetOf(contribution) : item?.ancestors?.[0]?.name || item?.parentItem || "";
  const source = item?.document?.origin?.source || contribution?.source || undefined;
  const contributor = contribution?.origin === "MEMBER" ? contribution.contributor : undefined;
  const states = { item, contribution: open ? contribution : null };
  return {
    id: resourceId(item?.name || contribution?.item || contribution?.name),
    item,
    contribution,
    lifecycle: open ? lifecycleKey({ contribution }) : item ? itemLifecycle(item) : lifecycleKey({ contribution }),
    publication: publicationOf(states),
    processing: processingOf(states),
    title,
    fileName,
    ext,
    mime: item?.document?.mimeType ?? "",
    base,
    baseName: baseNames.get(base) || item?.ancestors?.[0]?.displayName || "",
    contributor: contributor || (source ? undefined : item?.creator),
    source,
    origin: source ? source : contributor ? "contrib" : "upload",
    type: docTypeOf(item?.itemType),
    assignments: item?.document?.concepts ?? [],
    owner: item?.document?.owner,
    updated: (open ? contribution.updateTime : item?.updateTime) || item?.updateTime || "",
  };
}

/**
 * A processing state in one line under its chip (preview `procLine`): why it isn't processed, what's happening, what
 * went wrong — or what it's ready for.
 */
export function processingLine(r: DocRow): string {
  const submission = isCandidate(r.contribution);
  switch (r.processing) {
    case "pending":
      return submission ? "Chuyển sang Chờ duyệt sau khi xử lý xong" : "Tìm kiếm không thấy tài liệu này";
    case "processing":
      return "Đang đọc, phân loại, cho phép tra cứu…";
    case "ready":
      return r.publication === "published" ? `Tra cứu được · v${versionOf(r.item?.document?.revision) ?? 1}` : submission ? "Chờ duyệt" : "Sẵn sàng công bố";
    case "failed":
      return (r.item?.document?.indexingError?.message && serverText(r.item.document.indexingError.message)) || "Dừng giữa chừng";
    case "outdated":
      return "Phiên bản trước đang được dùng để trả lời";
    case "unsupported":
      return "Chỉ tải xuống";
  }
}

/** Operations by lifecycle (preview `OPS`/`opsFor`): the main fix, secondary ones and the tail. */
export type DocOp =
  | "review"
  | "process"
  | "retry"
  | "replace"
  | "update"
  | "source"
  | "republish"
  | "unpublish"
  | "edit"
  | "move"
  | "open"
  | "download"
  | "changes"
  | "decline"
  | "archive";

/** Fixes a row shows as a visible button (actionable states only); everything else lives in ⋯. */
const ROW_FIX: Readonly<Partial<Record<DocOp, true>>> = { process: true, retry: true, replace: true, update: true, republish: true, source: true };
export const isRowFix = (op: DocOp) => !!ROW_FIX[op];

const LIVE: readonly LifecycleKey[] = ["published", "update", "stored", "queued", "failed", "publishing"];

/** Publish: unpublished documents only (processing is apart; a run never publishes). */
export const canPublishRow = (r: DocRow) => !!r.item?.name && r.publication === "unpublished";
export const canUnpublishRow = (r: DocRow) => !!r.item && r.item.document?.publicationState === "PUBLISHED" && LIVE.includes(r.lifecycle);
/** In review, the open contribution locks the item (the API refuses to archive it). */
export const canArchiveRow = (r: DocRow) => !!r.item?.name && LIVE.includes(r.lifecycle);

/**
 * What processing a document needs, if anything it can have: Process (not processed yet), Process again (failed, or
 * outdated), Process the update (changed at its source); a password-locked file needs a new one instead.
 */
export function processOp(row: DocRow): DocOp | undefined {
  if (!canProcess(row)) return undefined;
  const synced = !!row.source;
  if (row.processing === "pending") return "process";
  if (row.processing === "failed") return isLocked(row.item) ? (synced ? "source" : "replace") : "retry";
  if (row.processing === "outdated") return synced && changedAtSource(row.item) ? "update" : "retry";
  return undefined;
}

/**
 * The row's fix: a new document's submission is processed first (Process, or Process again), then reviewed — its ⋯
 * adds Request changes and Decline while it waits, so one that can't be processed still gets an answer; another
 * submission is reviewed; otherwise processing decides (`processOp`), and an unpublished document that's processed is
 * published.
 */
export function opsFor(row: DocRow): { main: DocOp; more: DocOp[]; tail: DocOp[] } {
  const k = row.lifecycle;
  if (isCandidate(row.contribution)) {
    const fix = processOp(row);
    const main: DocOp = row.processing === "processing" ? "open" : fix === "process" || fix === "retry" ? fix : row.processing === "failed" || row.processing === "pending" ? "open" : "review";
    const waiting = main !== "review";
    const more = [main !== "open" && !!row.item && "open", waiting && "changes", waiting && "decline"].filter(Boolean) as DocOp[];
    return { main, more, tail: row.item ? ["download"] : [] };
  }
  const live = LIVE.includes(k);
  const unpublished = row.publication === "unpublished";
  const hasItem = !!row.item;
  const settled = row.publication === "published" || unpublished;
  const main: DocOp =
    k === "analyzing" || k === "review" ? "review" : settled && hasItem ? (processOp(row) ?? (unpublished ? "republish" : "open")) : hasItem ? "open" : "review";
  const editable = live || unpublished;
  const more = [
    main !== "open" && hasItem && "open",
    unpublished && main !== "republish" && "republish",
    editable && hasItem && "edit",
    editable && hasItem && "move",
    canUnpublishRow(row) && "unpublish",
  ].filter(Boolean) as DocOp[];
  const tail = [hasItem && "download", canArchiveRow(row) && "archive"].filter(Boolean) as DocOp[];
  return { main, more, tail };
}

/** "A", "A and B", "A, B and 3 others". */
export function names(list: readonly string[], plural: (n: number, one: string) => string): string {
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, 2).join(", ")} và ${plural(list.length - 2, "other")}`;
}

/** A document name is one line: whitespace (pasted line breaks too) collapses before comparing and sending. */
export const cleanName = (s: string): string => s.replace(/\s+/g, " ").trim();

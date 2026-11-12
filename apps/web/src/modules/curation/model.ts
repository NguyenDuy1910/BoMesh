import { Copy, File, History, Shield, type LucideIcon } from "lucide-react";

import { resourceId } from "@/lib/api/client";
import type { StudioSectionId } from "@/lib/navigation";
import { fileExt } from "@/components/ui/FileIcon";
import { inferKind, lifecycleKey, type LifecycleKey } from "@/modules/knowledge/model";

import type { Contribution, Item } from "./api";

/**
 * Knowledge Studio view model (preview `features/curation.js` + `core/lifecycle.js`): sections and their
 * addresses, the Review queues, flags, confidence badges, quick replies, the Documents flow strip and the
 * lifecycle operations every document row offers.
 */

/* ═══════════════ Sections and addresses ═══════════════ */

export const STUDIO_BASE = "/studio";

/** `/studio?tab=…&…` (empty values are left out). */
export function studioHref(tab: StudioSectionId, params: Readonly<Record<string, string | undefined | null>> = {}): string {
  const q = new URLSearchParams({ tab });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return `${STUDIO_BASE}?${q.toString()}`;
}

/* ═══════════════ Review queues ═══════════════ */

export type QueueGroup = "publish" | "keep";

/**
 * Review queues backed by the API, in chooser order. The preview's Sync batches (first-sync holds grouped by reason)
 * and Topics to confirm (low-confidence classification) have no endpoint and are left out.
 */
export const QUEUES = [
  { id: "submissions", label: "Submissions", group: "publish" },
  { id: "problems", label: "Publishing problems", group: "publish" },
  { id: "reverify", label: "Re-verification due", group: "keep" },
  { id: "details", label: "Missing details", group: "keep" },
  { id: "duplicates", label: "Possible duplicates", group: "keep" },
] as const satisfies readonly { id: string; label: string; group: QueueGroup }[];

export type QueueId = (typeof QUEUES)[number]["id"];
export const QUEUE_IDS: readonly QueueId[] = QUEUES.map((q) => q.id);
export const KEEP_QUEUES: readonly QueueId[] = QUEUES.filter((q) => q.group === "keep").map((q) => q.id);
export const QUEUE_GROUPS: readonly (readonly [QueueGroup, string])[] = [
  ["publish", "To publish"],
  ["keep", "To keep right"],
];

export type QueueCounts = Readonly<Record<QueueId, number>>;

export const reviewQueueHref = (queue: QueueId, params: Readonly<Record<string, string | undefined>> = {}) => studioHref("review", { queue, ...params });

/**
 * The open queue: `?queue=` (legacy `?seg=`, Knowledge health's `tab=details|duplicates`, `quality` → the first To keep
 * right queue with items), a `?sel=` of a submission, else the first queue with items.
 */
export function resolveQueue(query: { queue?: string | null; seg?: string | null; tab?: string | null; sel?: string | null }, counts: QueueCounts): QueueId {
  let q = query.queue || query.seg || (query.tab === "details" || query.tab === "duplicates" ? query.tab : "");
  if (q === "review") q = "reverify";
  if (q === "quality") q = KEEP_QUEUES.find((k) => counts[k]) ?? "reverify";
  if ((QUEUE_IDS as readonly string[]).includes(q)) return q as QueueId;
  if (query.sel) return "submissions";
  return QUEUE_IDS.find((k) => counts[k]) ?? "submissions";
}

/** The To publish decisions (what the Studio badge and landing count). */
export const decisionCount = (c: Pick<QueueCounts, "submissions" | "problems">) => c.submissions + c.problems;

/* ═══════════════ Submissions ═══════════════ */

export type FlagType = "duplicate" | "version" | "personal" | "format";

/** Blocking risks are labelled chips (`chip`); informational signals stay a small icon with a tooltip. */
export const FLAG_META: Readonly<Record<FlagType, { icon: LucideIcon; label: string; tone: "warning" | "accent" | "danger" | "default"; chip: boolean }>> = {
  duplicate: { icon: Copy, label: "Possible duplicate", tone: "warning", chip: true },
  personal: { icon: Shield, label: "Personal data", tone: "danger", chip: true },
  version: { icon: History, label: "New version", tone: "accent", chip: false },
  format: { icon: File, label: "Can’t be searched", tone: "default", chip: false },
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
  ["all", "All"],
  ["flagged", "Flagged"],
  ["version", "New versions"],
  ["sync", "From sources"],
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

/** Document type key: the reviewer-relevant kind ("markdown" is a format, not a type). */
export function suggestedKind(c: Contribution, item: Item | null): string {
  const t = c.suggestions?.documentType;
  if (t && t !== "markdown") return t;
  const name = item?.document?.fileName || item?.displayName || "";
  return inferKind(name.replace(/\.[a-z0-9]{1,5}$/i, ""), fileExt({ name }));
}

export const confLevel = (c: number) => {
  const p = Math.round(c * 100);
  return p >= 80 ? "hi" : p >= 60 ? "mid" : "lo";
};

/** Revision number from a revision name (`…/revisions/3` → 3). */
export function versionOf(revision: string | undefined): number | null {
  const n = Number(resourceId(revision));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const QUICK_REPLIES = {
  changes: [
    "Please remove personal data (names, grades, ID numbers) and resubmit.",
    "Please add a short note on what this covers and who it’s for.",
    "Please upload the final version as a PDF.",
  ],
  decline: [
    "This is already published. Use the existing document instead.",
    "We can’t publish copyrighted material.",
    "It contains personal data that can’t be shared.",
    "It doesn’t belong in this collection.",
  ],
} as const;

/* ═══════════════ Documents: the flow strip ═══════════════ */

/** The Studio's stages, left to right, then the two off-ramps: [key, label, lifecycle keys]. */
export const FLOW_GROUPS = [
  ["review", "In review", ["analyzing", "review", "changes"]],
  ["publishing", "Publishing", ["publishing"]],
  ["published", "Published", ["published", "stored", "merged"]],
  ["attention", "Needs attention", ["failed", "queued", "update"]],
  ["closed", "Not published", ["rejected", "unpublished"]],
] as const satisfies readonly (readonly [string, string, readonly LifecycleKey[]])[];

export type FlowKey = (typeof FLOW_GROUPS)[number][0];
/** Older addresses (?life=changes…) land on the group that now holds them. */
export const FLOW_ALIAS: Readonly<Record<string, FlowKey>> = { changes: "review", rejected: "closed", unpublished: "closed" };

export function flowOf(raw: string | null | undefined): FlowKey | "" {
  const v = FLOW_ALIAS[raw ?? ""] ?? raw ?? "";
  return FLOW_GROUPS.some(([k]) => k === v) ? (v as FlowKey) : "";
}

export const flowKeys = (group: FlowKey): readonly LifecycleKey[] => FLOW_GROUPS.find(([k]) => k === group)?.[2] ?? [];

export const FLOW_TIPS: Readonly<Record<FlowKey, string>> = {
  review: "Being classified, waiting for a reviewer, or back with the contributor.",
  publishing: "Approved and being made searchable.",
  published: "Searchable, and used in answers for everyone who can read its collection.",
  attention: "Couldn’t publish, waiting to publish, or changed at the source. Each row shows its fix; Review → Publishing problems fixes them together.",
  closed: "Declined by a reviewer or unpublished. Kept with their history.",
};

/** Approved documents that stopped on the way to people (Review → Publishing problems). */
export const PROBLEM_KEYS: readonly LifecycleKey[] = ["failed", "update", "queued"];
export const PROBLEM_OPTS: readonly (readonly [LifecycleKey, string])[] = [
  ["failed", "Couldn’t publish"],
  ["update", "Changed at the source"],
  ["queued", "Waiting to publish"],
];

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
  kind: string;
  topics: string[];
  owner?: string;
  updated: string;
}

/** The item's lifecycle, with a published document that changed at its source counted as Update available. */
export function itemLifecycle(item: Item): LifecycleKey {
  const k = lifecycleKey({ item });
  const changed = (item.document?.qualityIssues ?? []).some((i) => i.kind === "CHANGED_AT_SOURCE");
  return k === "published" && changed ? "update" : k;
}

export function rowOf(item: Item | null, contribution: Contribution | null, baseNames: ReadonlyMap<string, string>): DocRow {
  const fileName = item?.document?.fileName || item?.displayName || "";
  const ext = fileExt({ name: fileName });
  const title = (item?.displayName || fileName || "Untitled document").replace(/\.[a-z0-9]{1,5}$/i, "");
  const open = !!contribution && contribution.state !== "APPROVED" && contribution.state !== "WITHDRAWN";
  const base = open ? targetOf(contribution) : item?.ancestors?.[0]?.name || item?.parentItem || "";
  const docType = item?.document?.documentType;
  const source = item?.document?.origin?.source || contribution?.source || undefined;
  const contributor = contribution?.origin === "MEMBER" ? contribution.contributor : undefined;
  return {
    id: resourceId(item?.name || contribution?.item || contribution?.name),
    item,
    contribution,
    lifecycle: open ? lifecycleKey({ contribution }) : item ? itemLifecycle(item) : lifecycleKey({ contribution }),
    title,
    fileName,
    ext,
    mime: item?.document?.mimeType ?? "",
    base,
    baseName: baseNames.get(base) || item?.ancestors?.[0]?.displayName || "",
    contributor: contributor || (source ? undefined : item?.creator),
    source,
    origin: source ? source : contributor ? "contrib" : "upload",
    kind: docType && docType !== "markdown" ? docType : inferKind(title, ext),
    topics: open ? (contribution.suggestions?.topics ?? []) : (item?.document?.topics ?? []),
    owner: item?.document?.owner,
    updated: (open ? contribution.updateTime : item?.updateTime) || item?.updateTime || "",
  };
}

/** Operations by lifecycle (preview `OPS`/`opsFor`): the main fix, secondary ones and the tail. */
export type DocOp = "review" | "publish" | "retry" | "replace" | "update" | "source" | "republish" | "unpublish" | "edit" | "move" | "open" | "download" | "archive";

/** Fixes a row shows as a visible button (actionable states only); everything else lives in ⋯. */
const ROW_FIX: Readonly<Partial<Record<DocOp, true>>> = { publish: true, retry: true, replace: true, update: true, republish: true, source: true };
export const isRowFix = (op: DocOp) => !!ROW_FIX[op];

const LIVE: readonly LifecycleKey[] = ["published", "update", "stored", "queued", "failed", "publishing"];

export const canPublishRow = (r: DocRow) => !!r.item && (["unpublished", "queued", "update"].includes(r.lifecycle) || (r.lifecycle === "failed" && !isLocked(r.item)));
export const canUnpublishRow = (r: DocRow) => !!r.item && r.item.document?.publicationState === "PUBLISHED" && LIVE.includes(r.lifecycle);
/** In review, the open contribution locks the item (the API refuses to archive it). */
export const canArchiveRow = (r: DocRow) => !!r.item?.name && LIVE.includes(r.lifecycle);

export function opsFor(row: DocRow): { main: DocOp; more: DocOp[]; tail: DocOp[] } {
  const k = row.lifecycle;
  const live = LIVE.includes(k);
  const synced = !!row.source;
  const map: Partial<Record<LifecycleKey, DocOp>> = {
    analyzing: "review",
    review: "review",
    queued: "publish",
    failed: isLocked(row.item) ? (synced ? "source" : "replace") : "retry",
    update: synced ? "update" : "replace",
    unpublished: "republish",
  };
  const hasItem = !!row.item;
  const main = map[k] ?? (hasItem ? "open" : "review");
  const more = [main !== "open" && hasItem && "open", live && hasItem && "edit", live && hasItem && "move", canUnpublishRow(row) && "unpublish"].filter(Boolean) as DocOp[];
  const tail = [hasItem && "download", canArchiveRow(row) && "archive"].filter(Boolean) as DocOp[];
  return { main, more, tail };
}

/** "A", "A and B", "A, B and 3 others". */
export function names(list: readonly string[], plural: (n: number, one: string) => string): string {
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, 2).join(", ")} and ${plural(list.length - 2, "other")}`;
}

import { Copy, File, History, Shield, type LucideIcon } from "lucide-react";

import { resourceId } from "@/lib/api/client";
import { fileExt } from "@/components/ui/FileIcon";
import { inferKind, LIFE_GROUPS, lifecycleKey, type LifecycleKey } from "@/modules/knowledge/model";

import type { Contribution, Item } from "./api";

/**
 * Manage → Documents view model (preview `features/curation.js` + `core/lifecycle.js`):
 * queue filters, flags, confidence badges, quick replies and lifecycle operations.
 */

export const DOCS_BASE = "/documents";
export const TABS = ["review", "all", "quality", "topics"] as const;
export type CurationTab = (typeof TABS)[number];

/* ═══════════════ Submissions (review queue) ═══════════════ */

export type FlagType = "duplicate" | "version" | "personal" | "format";

export const FLAG_META: Readonly<Record<FlagType, { icon: LucideIcon; tip: string; tone: "warning" | "accent" | "danger" | "default" }>> = {
  duplicate: { icon: Copy, tip: "Possible duplicate", tone: "warning" },
  version: { icon: History, tip: "New version", tone: "accent" },
  personal: { icon: Shield, tip: "May contain personal data", tone: "danger" },
  format: { icon: File, tip: "Can’t be searched", tone: "default" },
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

/** The last event (what the queue shows as "· 2 hours ago"). */
export function lastEvent(c: Contribution): { kind: string; at: string; message?: string; actor?: string } {
  const evs = (c.events ?? []).filter((e) => e.kind !== "ANALYZED");
  const e = evs.at(-1);
  return e ? { kind: e.kind ?? "", at: e.createTime ?? c.updateTime ?? "", message: e.message, actor: e.actor } : { kind: "SUBMITTED", at: c.createTime ?? "" };
}

/** The base a submission goes to: its target, else the assistant's suggestion. */
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
    "It doesn’t belong in this knowledge base.",
  ],
} as const;

/* ═══════════════ Documents (All documents) ═══════════════ */

/** Groups for the lifecycle filter. */
export const LIFE_FILTERS = LIFE_GROUPS.map(([key, label, keys]) => ({ key, label, keys }));
export const lifeGroupKeys = (group: string): readonly LifecycleKey[] => LIFE_GROUPS.find(([k]) => k === group)?.[2] ?? [];

/** A failed document whose file is locked (password-protected): it needs a new file, not a retry. */
export const isLocked = (item: Item | null | undefined) => /password/i.test(item?.document?.indexingError?.message ?? "");

/** One row of All documents: a document in a shared base, or a submission that isn't published. */
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
  /** Knowledge base name (full) and display name. */
  base: string;
  baseName: string;
  /** Member (submissions) or source (synced) the row came from. */
  contributor?: string;
  source?: string;
  kind: string;
  updated: string;
}

export function rowOf(item: Item | null, contribution: Contribution | null, baseNames: ReadonlyMap<string, string>): DocRow {
  const fileName = item?.document?.fileName || item?.displayName || "";
  const ext = fileExt({ name: fileName });
  const title = (item?.displayName || fileName || "Untitled document").replace(/\.[a-z0-9]{1,5}$/i, "");
  const open = contribution && contribution.state !== "APPROVED" && contribution.state !== "WITHDRAWN";
  const base = open ? targetOf(contribution) : item?.ancestors?.[0]?.name || item?.parentItem || "";
  const docType = item?.document?.documentType;
  return {
    id: resourceId(item?.name || contribution?.item || contribution?.name),
    item,
    contribution,
    lifecycle: open ? lifecycleKey({ contribution }) : lifecycleKey({ item }),
    title,
    fileName,
    ext,
    mime: item?.document?.mimeType ?? "",
    base,
    baseName: baseNames.get(base) || item?.ancestors?.[0]?.displayName || "",
    contributor: contribution?.contributor || (item?.document?.origin?.source ? undefined : item?.creator),
    source: item?.document?.origin?.source || contribution?.source || undefined,
    kind: docType && docType !== "markdown" ? docType : inferKind(title, ext),
    updated: (open ? contribution.updateTime : item?.updateTime) || item?.updateTime || "",
  };
}

/** Operations by lifecycle (preview `opsFor`): the main fix, secondary ones and the tail. */
export type DocOp = "review" | "publish" | "retry" | "replace" | "update" | "republish" | "unpublish" | "edit" | "move" | "open" | "download" | "archive";

export function opsFor(row: DocRow): { main: DocOp; more: DocOp[]; tail: DocOp[] } {
  const k = row.lifecycle;
  const live = ["published", "update", "stored", "queued", "failed", "publishing"].includes(k);
  const map: Partial<Record<LifecycleKey, DocOp>> = {
    analyzing: "review",
    review: "review",
    queued: "publish",
    failed: isLocked(row.item) ? "replace" : "retry",
    update: "update",
    unpublished: "republish",
  };
  const main = map[k] ?? "open";
  const published = row.item?.document?.publicationState === "PUBLISHED" && row.item?.state !== "DELETED" && !row.contribution?.state?.match(/ANALYZING|IN_REVIEW|CHANGES_REQUESTED|REJECTED/);
  const hasItem = !!row.item;
  const more = [
    main !== "open" && hasItem && "open",
    live && hasItem && "edit",
    live && hasItem && "move",
    published && live && "unpublish",
  ].filter(Boolean) as DocOp[];
  const tail = [hasItem && "download", hasItem && live && "archive"].filter(Boolean) as DocOp[];
  return { main: main === "open" && !hasItem ? "review" : main, more, tail };
}

/** Can this row be published by the bulk Publish action? */
export const canPublishRow = (r: DocRow) => ["unpublished", "queued", "update"].includes(r.lifecycle) || (r.lifecycle === "failed" && !isLocked(r.item));
export const canUnpublishRow = (r: DocRow) => !!r.item && r.item.document?.publicationState === "PUBLISHED" && ["published", "update", "stored", "queued", "failed", "publishing"].includes(r.lifecycle);

/** "A", "A and B", "A, B and 3 others". */
export function names(list: readonly string[], plural: (n: number, one: string) => string): string {
  return list.length <= 2 ? list.join(" and ") : `${list.slice(0, 2).join(", ")} and ${plural(list.length - 2, "other")}`;
}

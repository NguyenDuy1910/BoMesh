import type { Contribution, Item } from "./api";

/**
 * A document's two independent states (preview `core/lifecycle.js`, DOCUMENT_LIFECYCLE.md), as the backend keeps
 * them (`document.publicationState`, `document.indexingState`): publication (can readers see it?) and processing
 * (read, classified and indexed: can search and the assistant use it?). An open submission decides publication; a new
 * document's submission is processed before it's reviewed (the assistant classifies it for its reviewer), a new
 * version's once it's approved. Nothing is processed until someone asks; a run never publishes. Searchable = published
 * and processed.
 * Pure (no React, no icons) so the mapping is unit-tested. Labels and descriptions are the catalog's
 * (`m.state.publication[key]`, `m.state.processing[key]`); these tables keep only how a state looks.
 */

export type StateTone = "default" | "accent" | "success" | "warning" | "danger";
export interface StateMeta {
  tone: StateTone;
  live?: boolean;
}

/** Either side of a document: the item, and the latest contribution about it (open or decided). */
export interface DocStates {
  item?: Item | null;
  contribution?: Contribution | null;
}

/* ═══════════════ Publication ═══════════════ */

export type PublicationKey = "review" | "changes" | "published" | "unpublished" | "rejected";

export const PUBLICATION: Readonly<Record<PublicationKey, StateMeta>> = {
  review: { tone: "accent" },
  changes: { tone: "warning" },
  published: { tone: "success" },
  unpublished: { tone: "default" },
  rejected: { tone: "danger" },
};

/** Contribution states that decide publication (a submission, open or declined). */
const SUBMISSION: Readonly<Record<string, PublicationKey>> = { ANALYZING: "review", IN_REVIEW: "review", CHANGES_REQUESTED: "changes", REJECTED: "rejected" };

const isSubmission = (c: Contribution | null | undefined) => !!c?.state && c.state in SUBMISSION;

/** Whether people can read it: a submission's state, else the item's publication state. */
export function publicationOf({ item, contribution }: DocStates): PublicationKey {
  if (isSubmission(contribution)) return SUBMISSION[contribution!.state!]!;
  if (!item) return contribution?.state === "APPROVED" ? "published" : "review";
  return item.document?.publicationState === "UNPUBLISHED" ? "unpublished" : "published";
}

/* ═══════════════ Processing ═══════════════ */

export type ProcessingKey = "pending" | "processing" | "ready" | "failed" | "outdated" | "unsupported";
export type IndexingState = NonNullable<NonNullable<Item["document"]>["indexingState"]>;

export const PROCESSING_ORDER = ["pending", "processing", "ready", "failed", "outdated", "unsupported"] as const satisfies readonly ProcessingKey[];

export const PROCESSING: Readonly<Record<ProcessingKey, StateMeta>> = {
  pending: { tone: "default" },
  processing: { tone: "accent", live: true },
  ready: { tone: "success" },
  failed: { tone: "danger" },
  outdated: { tone: "warning" },
  unsupported: { tone: "default" },
};

/** The backend's `indexingState` per processing state (AIP-160 filters). */
export const PROCESSING_STATE: Readonly<Record<ProcessingKey, IndexingState>> = {
  pending: "PENDING",
  processing: "RUNNING",
  ready: "SUCCEEDED",
  failed: "FAILED",
  outdated: "OUTDATED",
  unsupported: "UNSUPPORTED",
};

const FROM_INDEXING = Object.fromEntries(Object.entries(PROCESSING_STATE).map(([k, v]) => [v, k])) as Readonly<Record<IndexingState, ProcessingKey>>;

/** Changed at its source since it was processed (the previous version still answers). */
export const changedAtSource = (item: Item | null | undefined) => (item?.document?.qualityIssues ?? []).some((i) => i.kind === "CHANGED_AT_SOURCE");

/** An open submission of a new document (in review, not a new version): its file is processed before a reviewer decides. */
export const isCandidate = (c: Contribution | null | undefined) => (c?.state === "ANALYZING" || c?.state === "IN_REVIEW") && c.kind !== "NEW_REVISION";

/** How far the item's content was processed (its `indexingState`); a file that didn't arrive failed. */
function indexingOf(item: Item | null | undefined): ProcessingKey {
  const doc = item?.document;
  if (!doc) return "pending";
  if (doc.contentState === "FAILED") return "failed";
  const k = FROM_INDEXING[doc.indexingState ?? "PENDING"] ?? "pending";
  return k === "ready" && changedAtSource(item) ? "outdated" : k;
}

/**
 * How far it was processed, whatever its publication. A new document's submission has its candidate's state (images
 * and archives are Not supported); a new version's, or one waiting on its contributor or declined, isn't processed.
 */
export function processingOf({ item, contribution }: DocStates): ProcessingKey {
  if (isCandidate(contribution)) {
    const k = indexingOf(item);
    return k === "pending" && isUnprocessable(item?.document?.fileName || item?.displayName, item?.document?.mimeType) ? "unsupported" : k;
  }
  if (isSubmission(contribution)) return "pending";
  return indexingOf(item);
}

/** Ready for a reviewer's decision: a new document once processed (or a format that can't be), or a new version. */
export function readyToReview(contribution: Contribution, item: Item | null | undefined): boolean {
  if (contribution.state !== "ANALYZING" && contribution.state !== "IN_REVIEW") return false;
  if (!isCandidate(contribution)) return true;
  const p = processingOf({ item, contribution });
  return p === "ready" || p === "outdated" || p === "unsupported";
}

/** In search and answers: published and processed. */
export const inSearch = (s: DocStates) => publicationOf(s) === "published" && processingOf(s) === "ready";

const IMAGE_EXT = /^(png|jpe?g|gif|webp|svg|heic|bmp|tiff?)$/;
const ARCHIVE_EXT = /^(zip|rar|7z|tar|gz|tgz)$/;
const ARCHIVE_MIME = /zip|x-7z|x-rar|x-tar|gzip/;

/** Images and archives can't be processed (preview `UNPROCESSABLE`). */
export function isUnprocessable(fileName: string | null | undefined, mime: string | null | undefined = ""): boolean {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(fileName ?? "")?.[1]?.toLowerCase() ?? "";
  const m = mime ?? "";
  return m.startsWith("image/") || ARCHIVE_MIME.test(m) || IMAGE_EXT.test(ext) || ARCHIVE_EXT.test(ext);
}

/** Can it be processed (again)? Published or unpublished, or a new document's submission; not while it runs, not an image or archive. */
export function canProcess(s: DocStates): boolean {
  const item = s.item;
  if (!item?.name || item.state === "DELETED") return false;
  const pub = publicationOf(s);
  if (pub !== "published" && pub !== "unpublished" && !isCandidate(s.contribution)) return false;
  const p = processingOf(s);
  return p !== "processing" && p !== "unsupported" && !isUnprocessable(item.document?.fileName || item.displayName, item.document?.mimeType);
}

/** Processing states Documents → Processing lists: what isn't processed yet. */
export const TO_PROCESS = ["pending", "processing", "failed", "outdated"] as const satisfies readonly ProcessingKey[];

/**
 * Documents → Processing: a new document's submission, or a published or unpublished document, that isn't processed
 * for its current revision. Never attachments, formats that can't be processed, new versions waiting for review or what's processed.
 */
export function toProcess(s: DocStates): boolean {
  if (!s.item?.name || s.item.state === "DELETED" || s.item.document?.purpose === "CONVERSATION_ATTACHMENT") return false;
  const pub = publicationOf(s);
  if (!isCandidate(s.contribution) && pub !== "published" && pub !== "unpublished") return false;
  return (TO_PROCESS as readonly ProcessingKey[]).includes(processingOf(s));
}

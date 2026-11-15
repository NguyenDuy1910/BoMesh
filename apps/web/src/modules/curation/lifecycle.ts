import type { Contribution, Item } from "./api";

/**
 * A document's two independent states (preview `core/lifecycle.js`, DOCUMENT_LIFECYCLE.md), as the backend keeps
 * them (`document.publicationState`, `document.indexingState`): publication (can readers see it?) and processing
 * (read, classified and indexed: can search and the assistant use it?). An open submission decides publication and
 * isn't processed. Nothing is processed until someone asks; a run never publishes. Searchable = published and processed.
 * Pure (no React, no icons) so the mapping is unit-tested.
 */

export type StateTone = "default" | "accent" | "success" | "warning" | "danger";
export interface StateMeta {
  label: string;
  tone: StateTone;
  desc: string;
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
  review: { label: "In review", tone: "accent", desc: "A reviewer will check it before it’s published." },
  changes: { label: "Changes requested", tone: "warning", desc: "A reviewer asked for changes before it can be published." },
  published: { label: "Published", tone: "success", desc: "People who can read its collection can open it." },
  unpublished: { label: "Unpublished", tone: "default", desc: "Hidden from readers, search and answers. Editors can publish it." },
  rejected: { label: "Declined", tone: "danger", desc: "A reviewer declined it. It won’t be published." },
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
  pending: { label: "Not processed", tone: "default", desc: "Not read, classified or indexed yet. Search and the assistant can’t use it." },
  processing: { label: "Processing", tone: "accent", live: true, desc: "Being read, classified against your topics and indexed." },
  ready: { label: "Processed", tone: "success", desc: "Read, classified and indexed: search and the assistant can use it once it’s published." },
  failed: { label: "Processing failed", tone: "danger", desc: "It couldn’t be read or indexed. Its fix is in Issues." },
  outdated: { label: "Outdated", tone: "warning", desc: "Changed since it was processed. Answers use the previous version until it’s processed again." },
  unsupported: { label: "Not supported", tone: "default", desc: "Images and archives can’t be processed. People can still download them." },
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

/** How far it was processed, whatever its publication. A submission isn't processed; a file that didn't arrive failed. */
export function processingOf({ item, contribution }: DocStates): ProcessingKey {
  if (isSubmission(contribution)) return "pending";
  const doc = item?.document;
  if (!doc) return "pending";
  if (doc.contentState === "FAILED") return "failed";
  const k = FROM_INDEXING[doc.indexingState ?? "PENDING"] ?? "pending";
  return k === "ready" && changedAtSource(item) ? "outdated" : k;
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

/** Can it be processed (again)? Published or unpublished, not while it runs, not an image or archive. */
export function canProcess(s: DocStates): boolean {
  const item = s.item;
  if (!item?.name || item.state === "DELETED") return false;
  const pub = publicationOf(s);
  if (pub !== "published" && pub !== "unpublished") return false;
  const p = processingOf(s);
  return p !== "processing" && p !== "unsupported" && !isUnprocessable(item.document?.fileName || item.displayName, item.document?.mimeType);
}

/** Documents → Issues: published or unpublished documents that couldn't be processed or changed since they were. */
export function isIssue(s: DocStates): boolean {
  if (!s.item?.name || s.item.state === "DELETED") return false;
  const pub = publicationOf(s);
  const p = processingOf(s);
  return (pub === "published" || pub === "unpublished") && (p === "failed" || p === "outdated");
}

/** Issues' filter: [processing state, label]. */
export const ISSUE_OPTS: readonly (readonly [ProcessingKey, string])[] = [
  ["failed", PROCESSING.failed.label],
  ["outdated", PROCESSING.outdated.label],
];

/**
 * What the Knowledge pages derive from API records, in one place: names a
 * person reads, filters, sorting, upload checks and the local overlays that
 * pending features add to real lists. Pure functions only, so they are tested
 * directly (`web/tests/knowledge-model.test.mts`).
 */

import type { FileTypeKind } from "@/modules/knowledge/components/FileTypeIcon";
import type { Collection, CollectionGrant, CollectionRole, ContractDocument } from "@/modules/knowledge/knowledge-api";

export const NAME_LIMIT = 60;
export const DESCRIPTION_LIMIT = 200;
export const REQUEST_REASON_MIN = 10;
/** The server's upload ceiling (`DEFAULT_MAX_UPLOAD_BYTES`). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Formats processing can read, and archives of them; images are not knowledge yet. */
export const UPLOAD_EXTENSIONS = [
  "csv", "docx", "htm", "html", "json", "jsonl", "log", "markdown", "md", "pdf", "pptx",
  "rst", "sql", "tsv", "txt", "xlsx", "xml", "yaml", "yml", "zip",
] as const;
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((extension) => `.${extension}`).join(",");

/** Case- and accent-insensitive text, so "tot nghiep" finds "tốt nghiệp". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
}

export function matchesSearch(query: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = fold(query.trim());
  return !needle || fields.some((field) => field && fold(field).includes(needle));
}

/** A knowledge base name problem, or `null`. Names are unique among the ones the caller can see. */
export function nameError(
  name: string,
  others: readonly Pick<Collection, "id" | "title">[],
  selfId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed.length > NAME_LIMIT) return `Use ${NAME_LIMIT} characters or fewer.`;
  const taken = others.find((other) => other.id !== selfId && fold(other.title.trim()) === fold(trimmed));
  return taken ? `“${taken.title}” already exists. Choose a different name.` : null;
}

export type AccessKey = "me" | "workspace" | "restricted";

export interface AccessSummary {
  key: AccessKey;
  /** Badge text: "Only you", "Everyone", "Restricted". */
  label: string;
  /** The same fact as a sentence, for tooltips and the details drawer. */
  long: string;
}

export function accessSummary(
  { personal, general }: { personal: boolean; general: "workspace" | "restricted" },
  workspaceName: string,
): AccessSummary {
  if (personal) return { key: "me", label: "Only you", long: "Only you can see this" };
  if (general === "workspace") {
    return { key: "workspace", label: "Everyone", long: `Everyone in ${workspaceName || "the workspace"} can view` };
  }
  return { key: "restricted", label: "Restricted", long: "Only people added can view" };
}

export const ACCESS_FILTERS = [
  { value: "workspace", label: "Everyone in workspace" },
  { value: "restricted", label: "Restricted" },
  { value: "me", label: "Only me" },
] as const;

export type CollectionSort = "updated" | "name" | "documents";

export const COLLECTION_SORTS: Record<CollectionSort, string> = {
  updated: "Recently updated",
  name: "Name",
  documents: "Most documents",
};

/** My files first, then by the chosen order. */
export function sortCollections<T extends Pick<Collection, "id" | "title" | "updated_at" | "document_count">>(
  collections: readonly T[],
  by: CollectionSort,
  personalId: string | null,
): T[] {
  return [...collections].sort((left, right) => {
    const pinned = Number(right.id === personalId) - Number(left.id === personalId);
    if (pinned) return pinned;
    if (by === "name") return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (by === "documents") return right.document_count - left.document_count || left.title.localeCompare(right.title);
    return right.updated_at.localeCompare(left.updated_at);
  });
}

export type DocumentTypeGroup = "pdf" | "word" | "excel" | "ppt" | "text";

export const TYPE_FILTERS: readonly { value: DocumentTypeGroup; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "word", label: "Word" },
  { value: "excel", label: "Excel" },
  { value: "ppt", label: "PowerPoint" },
  { value: "text", label: "Text" },
];

const GROUP_OF_KIND: Partial<Record<FileTypeKind, DocumentTypeGroup>> = {
  pdf: "pdf",
  document: "word",
  spreadsheet: "excel",
  slides: "ppt",
  text: "text",
  web: "text",
};

export function typeGroup(kind: FileTypeKind): DocumentTypeGroup | null {
  return GROUP_OF_KIND[kind] ?? null;
}

/** States a run would do something for; unsupported never changes, processing is under way. */
export function canReprocess(document: Pick<ContractDocument, "processing">): boolean {
  return document.processing.state !== "unsupported" && document.processing.state !== "processing";
}

/** Why a picked file cannot be uploaded here, or `null`. */
export function uploadProblem(file: { name: string; size: number }, { personal }: { personal: boolean }): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  if (!(UPLOAD_EXTENSIONS as readonly string[]).includes(extension)) return "This file type can’t be searched";
  if (extension === "zip" && personal) return "ZIP files can only be added to a shared knowledge base";
  if (file.size === 0) return "This file is empty";
  if (file.size > MAX_UPLOAD_BYTES) return "This file is larger than 100 MB";
  return null;
}

export interface MoveRecord {
  document: ContractDocument;
  to_collection_id: string;
}

export interface ListedDocument {
  document: ContractDocument;
  /** Shown here only because of a move kept in this browser (`document.move` pending). */
  movedHere: boolean;
}

/**
 * One collection's documents with this browser's pending moves applied:
 * documents moved away are dropped, documents moved here are added and
 * marked, and a document moved back reads as the real record it is.
 */
export function applyMoves(
  collectionId: string,
  documents: readonly ContractDocument[],
  moves: readonly MoveRecord[],
): ListedDocument[] {
  const latest = new Map<string, MoveRecord>();
  for (const move of moves) if (!latest.has(move.document.id)) latest.set(move.document.id, move);
  const listed: ListedDocument[] = documents
    .filter((document) => (latest.get(document.id)?.to_collection_id ?? collectionId) === collectionId)
    .map((document) => ({ document, movedHere: false }));
  const present = new Set(documents.map((document) => document.id));
  for (const move of latest.values()) {
    if (move.to_collection_id === collectionId && !present.has(move.document.id)) {
      listed.push({ document: move.document, movedHere: true });
    }
  }
  return listed;
}

/**
 * Every knowledge base keeps at least one owner: demoting or removing the
 * last one is refused here with the reason. `next` null means removal.
 */
export function lastOwnerProblem(grants: readonly CollectionGrant[], grant: CollectionGrant, next: CollectionRole | null): string | null {
  if (grant.role !== "owner" || next === "owner") return null;
  if (grants.filter((candidate) => candidate.role === "owner").length > 1) return null;
  return next === null
    ? "You can’t remove the last owner. Make someone else an owner first."
    : "Every knowledge base needs an owner. Make someone else an owner first.";
}

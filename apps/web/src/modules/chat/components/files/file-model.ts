/**
 * What the file panel knows about a produced file, independent of React:
 * its kind, its versions (real ones from the server, hand-made ones kept in
 * this browser while `artifact.manual_revision` is pending) and the formats
 * it can be downloaded as.
 */
import type { ArtifactExportFormat, ArtifactRevision, LocalArtifactRevision } from "../../api";

export type FileKind = "sheet" | "markdown" | "text" | "document" | "pdf" | "image" | "other";

const SHEET_TYPES: Record<string, true> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.ms-excel": true,
  "text/csv": true,
  "text/tab-separated-values": true,
};
const MARKDOWN_TYPES: Record<string, true> = { "text/markdown": true, "text/x-markdown": true };
const SHEET_EXTENSIONS: Record<string, true> = { csv: true, tsv: true, xlsx: true, xls: true };
const DOCUMENT_TYPES: Record<string, true> = {
  "application/msword": true,
  "application/vnd.ms-powerpoint": true,
  "application/rtf": true,
  "application/vnd.oasis.opendocument.text": true,
};
const DOCUMENT_EXTENSIONS: Record<string, true> = { docx: true, doc: true, pptx: true, ppt: true, odt: true, rtf: true };
const TEXT_APPLICATION_TYPES = /^application\/(json|xml|x-ndjson|yaml|x-yaml)$/;

function mediaType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(fileName: string): string {
  return fileName.trim().toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? "";
}

/** How the panel shows a file. The media type decides; the extension breaks ties. */
export function fileKindOf(mimeType: string, fileName = ""): FileKind {
  const type = mediaType(mimeType);
  const extension = extensionOf(fileName);
  if (SHEET_TYPES[type] || SHEET_EXTENSIONS[extension]) return "sheet";
  if (MARKDOWN_TYPES[type] || extension === "md" || extension === "markdown") return "markdown";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/") || TEXT_APPLICATION_TYPES.test(type)) return "text";
  if (type.startsWith("application/vnd.openxmlformats-officedocument.") || DOCUMENT_TYPES[type] || DOCUMENT_EXTENSIONS[extension]) {
    return "document";
  }
  return "other";
}

/** A sheet stored as delimited text rather than a workbook. */
export function isDelimitedText(mimeType: string, fileName = ""): boolean {
  const type = mediaType(mimeType);
  const extension = extensionOf(fileName);
  return type === "text/csv" || type === "text/tab-separated-values" || extension === "csv" || extension === "tsv";
}

export function delimiterOf(mimeType: string, fileName = ""): "," | "\t" {
  return mediaType(mimeType) === "text/tab-separated-values" || extensionOf(fileName) === "tsv" ? "\t" : ",";
}

/** Only text is written by hand; a workbook or a Word file is changed by asking the assistant. */
export function canEditByHand(kind: FileKind): boolean {
  return kind === "markdown" || kind === "text";
}

/** Whether two versions of this kind can be compared in the panel. */
export function canCompare(kind: FileKind): boolean {
  return kind !== "image" && kind !== "other";
}

export type RevisionAuthor = "assistant" | "you";

/** One version as the panel lists it. */
export interface FileRevision {
  revision: number;
  summary: string | null;
  sizeBytes: number;
  createdAt: string | null;
  downloadUrl: string | null;
  restoredFrom: number | null;
  author: RevisionAuthor;
  /** Kept in this browser only (`artifact.manual_revision` is pending). */
  local: boolean;
  /** The text of a version kept in this browser; null for server versions. */
  content: string | null;
  mimeType: string | null;
}

function authorOf(revision: ArtifactRevision): RevisionAuthor {
  if (revision.author === "user") return "you";
  if (revision.author === "assistant") return "assistant";
  // Before the server says who made a version, only a restore is known to be a person's.
  return revision.restored_from != null ? "you" : "assistant";
}

/**
 * Every version, oldest first: the server's versions, then the ones kept in
 * this browser.
 *
 * Normally `applyLocalArtifactChanges` has already moved local versions past
 * the server's newest one. If the assistant has since used a local number,
 * the local versions are still shown after the server's, renumbered the same
 * way, so no two versions share a number.
 */
export function mergeFileRevisions(
  real: readonly ArtifactRevision[],
  local: readonly LocalArtifactRevision[],
  current?: ArtifactRevision,
): FileRevision[] {
  const byNumber = new Map<number, ArtifactRevision>();
  for (const revision of real) {
    if (Number.isInteger(revision.revision) && revision.revision >= 1) byNumber.set(revision.revision, revision);
  }
  if (current && !byNumber.has(current.revision)) byNumber.set(current.revision, current);
  const server: FileRevision[] = [...byNumber.values()]
    .sort((left, right) => left.revision - right.revision)
    .map((revision) => ({
      revision: revision.revision,
      summary: revision.summary,
      sizeBytes: revision.size_bytes,
      createdAt: revision.created_at,
      downloadUrl: revision.download_url,
      restoredFrom: revision.restored_from ?? null,
      author: authorOf(revision),
      local: false,
      content: null,
      mimeType: null,
    }));

  const serverLatest = server.at(-1)?.revision ?? 0;
  const ordered = [...local].sort((left, right) => left.revision - right.revision);
  const collides = ordered.length > 0 && ordered[0]!.revision <= serverLatest;
  const renumbered = new Map(
    ordered.map((revision, index) => [revision.revision, collides ? serverLatest + index + 1 : revision.revision]),
  );
  const kept: FileRevision[] = ordered.map((revision) => ({
    revision: renumbered.get(revision.revision)!,
    summary: revision.summary,
    sizeBytes: revision.size_bytes,
    createdAt: revision.created_at,
    downloadUrl: null,
    restoredFrom: revision.restored_from === null ? null : renumbered.get(revision.restored_from) ?? revision.restored_from,
    author: "you",
    local: true,
    content: revision.content,
    mimeType: revision.mime_type,
  }));
  return [...server, ...kept];
}

/** The version before `revision` in the list, the one its changes are measured from. */
export function previousRevision(revisions: readonly FileRevision[], revision: number): FileRevision | undefined {
  const index = revisions.findIndex((candidate) => candidate.revision === revision);
  return index > 0 ? revisions[index - 1] : undefined;
}

/** What a version is called when it carries no summary of its own. */
export function revisionTitle(revision: FileRevision, first: boolean): string {
  if (revision.summary?.trim()) return revision.summary.trim();
  if (revision.restoredFrom !== null) return `Restored version ${revision.restoredFrom}`;
  return first ? "First version" : `Version ${revision.revision}`;
}

export const EXPORT_FORMATS: Record<ArtifactExportFormat, { label: string; extension: string }> = {
  csv: { label: "CSV", extension: "csv" },
  pdf: { label: "PDF", extension: "pdf" },
  md: { label: "Markdown", extension: "md" },
};

/**
 * The other formats a version can be downloaded as (`artifact.export_formats`),
 * never the format it already has.
 *
 * CSV needs tables, so only sheets offer it; Markdown needs structure, so a
 * plain text file does not; an image or an archive offers nothing.
 */
export function exportFormatsFor(mimeType: string, fileName = ""): ArtifactExportFormat[] {
  const kind = fileKindOf(mimeType, fileName);
  switch (kind) {
    case "sheet":
      return isDelimitedText(mimeType, fileName) ? ["pdf", "md"] : ["csv", "pdf", "md"];
    case "markdown":
      return ["pdf"];
    case "text":
      return mediaType(mimeType) === "text/plain" ? ["pdf"] : ["pdf", "md"];
    case "document":
      return ["pdf", "md"];
    case "pdf":
      return ["md"];
    default:
      return [];
  }
}

/** The file name without its extension, for naming a converted download. */
export function baseName(fileName: string): string {
  const trimmed = fileName.trim() || "file";
  return trimmed.replace(/\.[^./]+$/, "") || trimmed;
}

export function extensionLabel(fileName: string): string {
  const extension = extensionOf(fileName);
  return extension ? `.${extension}` : "";
}

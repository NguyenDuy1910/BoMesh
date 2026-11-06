/**
 * What the file panel knows about an artifact independent of React: how it is
 * shown (sheet, document, …), what it is called, its versions oldest first,
 * and the formats each version downloads as.
 */
import type { Artifact, ArtifactRevision } from "./api.ts";

/** Formats ExportArtifact renders (`mimeType`). */
export type ExportMimeType = "text/csv" | "application/pdf" | "text/markdown" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const MIME = {
  csv: "text/csv",
  pdf: "application/pdf",
  markdown: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const satisfies Record<string, ExportMimeType>;

/** Revision number from a revision name (`…/revisions/3` → 3); 0 when absent. */
export function revisionNumber(revision: string | undefined | null): number {
  const n = Number((revision ?? "").split("/").pop());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * How a version is shown and edited:
 * `markdown` rich page, edited in place · `text` plain page, edited as text ·
 * `csv` grid, edited by cell · `sheet` grid of a workbook's rendition (read only) ·
 * `document` page of a binary document's rendition (read only) · `image` · `other`.
 */
export type FileView = "markdown" | "text" | "csv" | "sheet" | "document" | "image" | "other";

const SHEET_MIMES: Readonly<Record<string, true>> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": true,
  "application/vnd.ms-excel": true,
  "application/vnd.oasis.opendocument.spreadsheet": true,
};

const MIME_EXT: Readonly<Record<string, string>> = {
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/html": "html",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/zip": "zip",
};

const mediaType = (mime: string | undefined | null) => (mime ?? "").split(";", 1)[0]!.trim().toLowerCase();

export function fileViewOf(mime: string | undefined | null): FileView {
  const type = mediaType(mime);
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/csv" || type === "text/tab-separated-values") return "csv";
  if (type.startsWith("text/")) return "text";
  if (SHEET_MIMES[type]) return "sheet";
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || type.startsWith("application/vnd.openxmlformats-officedocument.") || type === "application/msword" || type.startsWith("application/vnd.oasis.opendocument.")) {
    return "document";
  }
  return "other";
}

/** Grids (preview KIND "sheet"); everything else is a document page. */
export const isSheetView = (view: FileView) => view === "csv" || view === "sheet";

/** Hand edits are text revisions (CommitArtifact accepts text kinds only). */
export const isEditableView = (view: FileView) => view === "markdown" || view === "text" || view === "csv";

/** Lower-case extension for a MIME type ("" when unknown). */
export function extOf(mime: string | undefined | null): string {
  return MIME_EXT[mediaType(mime)] ?? "";
}

/** The file name a person recognizes: the title with its extension. */
export function fileNameOf(artifact: Pick<Artifact, "displayName" | "mimeType">): string {
  const title = artifact.displayName?.trim() || "Untitled file";
  const ext = extOf(artifact.mimeType);
  if (!ext || title.toLowerCase().endsWith(`.${ext}`)) return title;
  return `${title}.${ext}`;
}

/** Title without the extension. */
export function baseName(fileName: string): string {
  return fileName.replace(/\.[^./]+$/, "") || fileName;
}

const FORMAT_LABEL: Readonly<Record<string, string>> = {
  xlsx: "Excel spreadsheet",
  xls: "Excel spreadsheet",
  csv: "CSV",
  tsv: "TSV",
  docx: "Word document",
  doc: "Word document",
  md: "Markdown",
  pdf: "PDF",
  pptx: "PowerPoint",
  txt: "Text",
};

/** The format as the card names it ("Excel spreadsheet", "Markdown"). */
export function formatLabel(mime: string | undefined | null): string {
  const ext = extOf(mime);
  return FORMAT_LABEL[ext] ?? (ext ? ext.toUpperCase() : "File");
}

/* ═══════════════ Versions ═══════════════ */

export interface Version {
  n: number;
  /** Revision resource name. */
  name: string;
  summary: string;
  author: "you" | "assistant";
  createTime: string | undefined;
  sizeBytes: number;
  mimeType: string;
  /** Text revisions only. */
  text: string | undefined;
  revision: ArtifactRevision;
}

/** The title a version shows when it carries no summary. */
export function versionSummary(revision: ArtifactRevision, n: number): string {
  const summary = revision.changeSummary?.trim();
  if (summary) return summary;
  return n === 1 ? "First version" : revision.author === "USER" ? "Edited by you" : `Version ${n}`;
}

/** Every version, oldest first (the API lists newest first). */
export function versionsOf(revisions: readonly ArtifactRevision[]): Version[] {
  return revisions
    .map((revision) => {
      const n = revisionNumber(revision.name);
      return {
        n,
        name: revision.name ?? "",
        summary: versionSummary(revision, n),
        author: revision.author === "USER" ? ("you" as const) : ("assistant" as const),
        createTime: revision.createTime,
        sizeBytes: Number(revision.snapshot?.sizeBytes ?? 0) || 0,
        mimeType: revision.snapshot?.mimeType ?? "",
        text: revision.snapshot?.text,
        revision,
      };
    })
    .filter((version) => version.n > 0)
    .sort((a, b) => a.n - b.n);
}

/* ═══════════════ Downloads ═══════════════ */

export interface DownloadOption {
  id: string;
  label: string;
  /** ".csv" shown at the end of the menu row. */
  meta: string;
  icon: "table" | "file" | "file-text";
  /** Export format, or `original` for the stored bytes. */
  format: ExportMimeType | "original";
  ext: string;
}

/** The download menu of a version (preview `wk-dl`): converted formats for text, the original otherwise. */
export function downloadOptions(view: FileView, mime: string | undefined | null): DownloadOption[] {
  const ext = extOf(mime) || "bin";
  switch (view) {
    case "csv":
      return [
        { id: "csv", label: "Spreadsheet as CSV", meta: ".csv", icon: "table", format: MIME.csv, ext: "csv" },
        { id: "pdf", label: "PDF", meta: ".pdf", icon: "file", format: MIME.pdf, ext: "pdf" },
      ];
    case "markdown":
    case "text":
      return [
        { id: "docx", label: "Word document", meta: ".docx", icon: "file-text", format: MIME.docx, ext: "docx" },
        { id: "pdf", label: "PDF", meta: ".pdf", icon: "file", format: MIME.pdf, ext: "pdf" },
        { id: "md", label: "Markdown", meta: ".md", icon: "file", format: MIME.markdown, ext: "md" },
      ];
    case "sheet":
      return [{ id: "original", label: "Excel spreadsheet", meta: `.${ext}`, icon: "table", format: "original", ext }];
    default:
      return [{ id: "original", label: formatLabel(mime), meta: `.${ext}`, icon: view === "document" ? "file-text" : "file", format: "original", ext }];
  }
}

/* ═══════════════ Sheet edits ═══════════════ */

/** RFC 4180 field: quoted when it holds the delimiter, a quote or a line break. */
function csvField(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A sheet back to delimited text (what a cell edit commits). */
export function toDelimited(columns: readonly string[], rows: readonly (readonly string[])[], delimiter: "," | "\t" = ","): string {
  return [columns, ...rows].map((row) => row.map((value) => csvField(value, delimiter)).join(delimiter)).join("\n") + "\n";
}

/** Looks like a number to right-align it (`1,200`, `$4.50`, `-3`, `12%`). */
export function isNumeric(value: string): boolean {
  return /^\s*[-+]?[$€£]?\s?\d[\d,]*(\.\d+)?%?\s*$/.test(value);
}

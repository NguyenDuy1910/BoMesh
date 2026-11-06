import clsx from "clsx";

/** Visual file family; each has its own soft tone. */
export type FileKind = "pdf" | "doc" | "sheet" | "slide" | "text";

/** Extension → family (preview `FILE_KIND`); unknown extensions are `text`. */
export const FILE_KIND: Readonly<Record<string, FileKind>> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  odt: "doc",
  rtf: "doc",
  md: "text",
  txt: "text",
  html: "text",
  json: "text",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  ppt: "slide",
  pptx: "slide",
  odp: "slide",
  key: "slide",
};

const MIME_EXT: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/html": "html",
  "application/json": "json",
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/zip": "zip",
};

/** What identifies a file: an extension/type ("pdf"), a MIME type, or a file name. First match wins. */
export interface FileRef {
  type?: string | null;
  mime?: string | null;
  name?: string | null;
}

/** Lower-case extension for a file reference ("" when nothing identifies it). */
export function fileExt({ type, mime, name }: FileRef): string {
  if (type) return type.toLowerCase().replace(/^\./, "");
  if (mime) {
    const base = mime.toLowerCase().split(";")[0].trim();
    return MIME_EXT[base] ?? base.split("/").pop()?.split(/[.+-]/).pop() ?? "";
  }
  const match = name ? /\.([a-z0-9]+)$/i.exec(name) : null;
  return match ? match[1].toLowerCase() : "";
}

/** File family for a reference (drives the tile tone). */
export function fileKind(ref: FileRef): FileKind {
  return FILE_KIND[fileExt(ref)] ?? "text";
}

/** Short tile label: up to four upper-case extension letters ("PDF", "DOCX"); "FILE" when unknown. */
export function fileLabel(ref: FileRef): string {
  return (fileExt(ref) || "file").toUpperCase().slice(0, 4);
}

export interface FileIconProps extends FileRef {
  /** sm 24 · md 32 (default) · lg 40 px. */
  size?: "sm" | "md" | "lg";
  className?: string;
}

/** File type tile (preview `fileIcon(type, size)`): extension letters on the family's soft tone. */
export function FileIcon({ size = "md", className, ...ref }: FileIconProps) {
  return (
    <span className={clsx("file-icon", `file-icon--${fileKind(ref)}`, size !== "md" && `file-icon--${size}`, className)} aria-hidden>
      {fileLabel(ref)}
    </span>
  );
}

import { cn } from "@/lib/cn";

/** A file's format, as far as its mark is concerned. */
export type FileTypeKind =
  | "pdf"
  | "document"
  | "spreadsheet"
  | "slides"
  | "archive"
  | "image"
  | "web"
  | "text"
  | "unsupported";

/** Tile colour and the short mark shown when no extension is known. */
const PRESENTATION: Record<FileTypeKind, { tone: string; mark: string; label: string }> = {
  pdf: { tone: "bg-file-pdf", mark: "PDF", label: "PDF" },
  document: { tone: "bg-file-doc", mark: "DOC", label: "Document" },
  spreadsheet: { tone: "bg-file-sheet", mark: "XLS", label: "Spreadsheet" },
  slides: { tone: "bg-file-slides", mark: "PPT", label: "Presentation" },
  archive: { tone: "bg-file-archive", mark: "ZIP", label: "Archive" },
  image: { tone: "bg-file-image", mark: "IMG", label: "Image" },
  web: { tone: "bg-file-web", mark: "WEB", label: "Web page" },
  text: { tone: "bg-file-text", mark: "TXT", label: "Text" },
  unsupported: { tone: "bg-file-text", mark: "FILE", label: "File" },
};

const KIND_BY_EXTENSION: Record<string, FileTypeKind> = {
  pdf: "pdf",
  doc: "document",
  docx: "document",
  odt: "document",
  rtf: "document",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  "7z": "archive",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  html: "web",
  htm: "web",
  md: "text",
  markdown: "text",
  txt: "text",
  json: "text",
  xml: "text",
};

const KIND_BY_MIME: Record<string, FileTypeKind> = {
  "application/pdf": "pdf",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "text/csv": "spreadsheet",
  "text/tab-separated-values": "spreadsheet",
  "application/vnd.ms-powerpoint": "slides",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "slides",
  "application/zip": "archive",
  "application/x-zip-compressed": "archive",
  "text/html": "web",
  "text/markdown": "text",
  "text/plain": "text",
  "application/json": "text",
};

/**
 * A file's kind and its short label ("PDF", "DOCX") from its name and MIME
 * type. The extension wins, because it is what the person sees in the name.
 */
export function fileTypeOf(
  contentType?: string | null,
  name?: string | null,
): { kind: FileTypeKind; label: string } {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name ?? "")?.[1]?.toLowerCase();
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const kind = (extension && KIND_BY_EXTENSION[extension])
    || KIND_BY_MIME[mime]
    || (mime.startsWith("image/") ? "image" : mime.startsWith("text/") ? "text" : "unsupported");
  return { kind, label: extension && extension.length <= 4 ? extension.toUpperCase() : PRESENTATION[kind].mark };
}

const SIZES = {
  xs: "size-4 rounded-[3px] text-[7px]",
  sm: "size-[22px] rounded-[4px] text-[7.5px]",
  md: "size-8 rounded-[7px] text-[9.5px]",
  lg: "size-9 rounded-[8px] text-[10px]",
} as const;

/**
 * A document's format, as a coloured tile carrying its short type ("PDF",
 * "XLSX"). The colour is a format convention, never a status.
 */
export function FileTypeIcon({
  kind,
  /** The format in the reader's words — "PDF", "DOCX". Up to four characters show on the tile. */
  label,
  size = "md",
  decorative = false,
  className,
}: {
  kind: FileTypeKind;
  label?: string;
  size?: keyof typeof SIZES;
  /** Hidden from assistive tech when the file name beside it already says the type. */
  decorative?: boolean;
  className?: string;
}) {
  const presentation = PRESENTATION[kind];
  const text = label?.trim().toUpperCase();
  const mark = text && text.length <= 4 ? text : presentation.mark;
  return (
    <span
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label || presentation.label}
      className={cn(
        "inline-grid flex-none select-none place-items-center font-mono font-semibold leading-none tracking-[0.02em] text-file-label",
        presentation.tone,
        SIZES[size],
        className,
      )}
      role={decorative ? undefined : "img"}
    >
      {size === "xs" ? null : mark}
    </span>
  );
}

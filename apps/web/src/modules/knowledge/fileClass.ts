/**
 * A document's type is its file class (`Item.itemType` for documents): what the file is, derived by the server
 * from the validated MIME type and file name. Not a business category: nobody picks or edits it, and every
 * version of a document keeps the same class (preview `core/catalog.js` DOC_TYPES).
 *
 * Its own module so it stays free of `@/` imports and can be unit-tested directly.
 */

export type DocTypeId =
  | "pdf"
  | "word"
  | "presentation"
  | "spreadsheet"
  | "markdown"
  | "html"
  | "plain_text"
  | "data"
  | "image"
  | "audio"
  | "video"
  | "archive"
  | "other";

export const DOC_TYPE_LABELS: Readonly<Record<DocTypeId, string>> = {
  pdf: "PDF",
  word: "Word",
  presentation: "Bản trình chiếu",
  spreadsheet: "Bảng tính",
  markdown: "Markdown",
  html: "HTML",
  plain_text: "Văn bản thuần",
  data: "Dữ liệu",
  image: "Hình ảnh",
  audio: "Âm thanh",
  video: "Video",
  archive: "Tệp nén",
  other: "Khác",
};

const isDocType = (v: string): v is DocTypeId => Object.hasOwn(DOC_TYPE_LABELS, v);

/** A document's file class from its `itemType` (`PLAIN_TEXT` → `plain_text`); `other` when absent or unknown. */
export function docTypeOf(itemType: string | undefined): DocTypeId {
  const key = (itemType ?? "").toLowerCase();
  return isDocType(key) ? key : "other";
}

/** The file class as an `itemType` value (`plain_text` → `PLAIN_TEXT`), for AIP-160 filters. */
export const itemTypeOf = (type: DocTypeId) => type.toUpperCase();

/** File extension → file class (the server's table). */
const EXT_TYPES: Readonly<Record<string, DocTypeId>> = {
  pdf: "pdf",
  doc: "word",
  docx: "word",
  ppt: "presentation",
  pptx: "presentation",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  md: "markdown",
  markdown: "markdown",
  rst: "markdown",
  html: "html",
  htm: "html",
  txt: "plain_text",
  log: "plain_text",
  sql: "plain_text",
  json: "data",
  jsonl: "data",
  xml: "data",
  yaml: "data",
  yml: "data",
  zip: "archive",
};

/** File class of a local file not uploaded yet (Contribute's list): by extension, then MIME family. */
export function fileClassOf(fileName: string, mime?: string): DocTypeId {
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(fileName)?.[1] ?? "").toLowerCase();
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  const base = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (base === "application/pdf") return "pdf";
  for (const family of ["image", "audio", "video"] as const) if (base.startsWith(`${family}/`)) return family;
  return base.startsWith("text/") ? "plain_text" : "other";
}

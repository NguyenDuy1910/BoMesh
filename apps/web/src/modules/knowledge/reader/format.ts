/**
 * The file's native format (preview documents.js `X.docFormat`): a document opens the way its own app
 * shows it — PDF or Word pages, a slide deck, a spreadsheet, or one continuous Markdown / web / text /
 * email page. The format only decides the page chrome and the viewer around the pages.
 */
export type DocFormat = "pdf" | "docx" | "slide" | "sheet" | "markdown" | "web" | "text" | "email";

const BY_EXT: Readonly<Record<string, DocFormat>> = {
  pdf: "pdf",
  doc: "docx",
  docx: "docx",
  odt: "docx",
  rtf: "docx",
  ppt: "slide",
  pptx: "slide",
  odp: "slide",
  key: "slide",
  xls: "sheet",
  xlsx: "sheet",
  ods: "sheet",
  csv: "sheet",
  tsv: "sheet",
  md: "markdown",
  markdown: "markdown",
  html: "web",
  htm: "web",
  txt: "text",
  log: "text",
  json: "text",
  msg: "email",
  eml: "email",
};

const BY_MIME: ReadonlyArray<[RegExp, DocFormat]> = [
  [/pdf/, "pdf"],
  [/wordprocessingml|msword|opendocument\.text|rtf/, "docx"],
  [/presentationml|ms-powerpoint|opendocument\.presentation/, "slide"],
  [/spreadsheetml|ms-excel|opendocument\.spreadsheet|text\/csv|tab-separated/, "sheet"],
  [/markdown/, "markdown"],
  [/html/, "web"],
  [/rfc822|outlook/, "email"],
  [/^text\/|json/, "text"],
];

export function docFormat({ ext, mime }: { ext?: string; mime?: string }): DocFormat {
  const byExt = BY_EXT[(ext ?? "").toLowerCase()];
  if (byExt) return byExt;
  const type = (mime ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return BY_MIME.find(([re]) => re.test(type))?.[1] ?? "web";
}

/** Formats read page by page, with a viewer bar (page in view, zoom). */
export const PAGED_FORMATS: Readonly<Partial<Record<DocFormat, true>>> = { pdf: true, docx: true, slide: true };

/**
 * The page chrome a document is drawn in: PDF pages or a slide deck (paged, with a viewer bar), a
 * spreadsheet grid, or one continuous Markdown / text page. It follows the representation's kind
 * (`viewerFormat`) or, before the representation exists, the cover's (`coverFormat`); never the file name.
 */
export type DocFormat = "pdf" | "slide" | "sheet" | "markdown" | "text";

/** Formats read page by page, with a viewer bar (page in view, zoom). */
export const PAGED_FORMATS: Readonly<Partial<Record<DocFormat, true>>> = { pdf: true, slide: true };

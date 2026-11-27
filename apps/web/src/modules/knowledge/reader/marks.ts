/**
 * Search marks (preview reader.js `needles` + `markHits`): the words of `?q=` (or a citation quote as
 * one needle), as ranges on a text, on a table's cells or on a PDF page's text layer, numbered so the
 * reader can step through them ("2 of 5").
 */

export interface MarkRange {
  start: number;
  end: number;
  /** Position of this mark among all marks of the document, from 0. */
  hit: number;
}

/* ═══════════════ Folding (accent- and case-insensitive, length-preserving) ═══════════════ */

/** One character folded to one character ("Ệ" → "e", "đ" → "d"), so folded offsets are source offsets. */
function foldChar(c: string): string {
  if (c.charCodeAt(0) < 128) return c.toLowerCase();
  if (c === "đ" || c === "Đ") return "d";
  return c.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0) || c;
}

export function fold(text: string): string {
  let out = "";
  for (const c of text) out += c.length === 1 ? foldChar(c) : c;
  return out;
}

/* ═══════════════ What a search highlights ═══════════════ */

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i if in is it me my of on or our the their to was we what when where which who why will with you your about this that these those there any all after before".split(
    " ",
  ),
);

/**
 * Text to mark for `?q=` (preview `needles`): a citation quote (`cited`) or a phrase the
 * document contains is one needle; any other query marks its words of three or more letters.
 */
export function searchNeedles(q: string, documentText: string, cited: boolean): string[] {
  const query = q.trim();
  if (!query) return [];
  // Ignoring case, accents and spacing.
  const spaced = (text: string) => fold(text).replaceAll(/\s+/g, " ").trim();
  if (cited || spaced(documentText).includes(spaced(query))) return [query];
  return [
    ...new Set(
      fold(query)
        .replace(/[“”"]/g, " ")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ];
}

/** Every occurrence of the needles in `text` (folded), as [start, end). */
export function occurrences(text: string, needles: readonly string[]): [number, number][] {
  if (!needles.length || !text) return [];
  const folded = fold(text);
  if (folded.length !== text.length) return [];
  const out: [number, number][] = [];
  for (const needle of needles) {
    const n = fold(needle);
    if (!n) continue;
    for (let at = folded.indexOf(n); at >= 0; at = folded.indexOf(n, at + n.length)) out.push([at, at + n.length]);
  }
  return out;
}

/** Marks on a PDF's pages of text (`pageText`), keyed by page number. */
export interface PagedTextMarks {
  pages: Map<number, MarkRange[]>;
  total: number;
  /** The page each mark starts on. */
  hitPages: Map<number, number>;
}

/**
 * Marks for needles across pages of text, numbered in reading order (page, then position); a range
 * overlapping one already marked is dropped.
 */
export function pagedTextMarks(pageTexts: ReadonlyMap<number, string>, needles: readonly string[]): PagedTextMarks {
  const order = [...pageTexts.keys()].sort((a, b) => a - b);
  const groups: { page: number; start: number; ranges: [page: number, start: number, end: number][] }[] = [];
  for (const page of order) for (const [s, e] of occurrences(pageTexts.get(page)!, needles)) groups.push({ page, start: s, ranges: [[page, s, e]] });
  groups.sort((a, b) => a.page - b.page || a.start - b.start);
  const taken = new Map<number, [number, number][]>();
  const pages = new Map<number, MarkRange[]>();
  const hitPages = new Map<number, number>();
  let hit = 0;
  for (const group of groups) {
    const kept = group.ranges.filter(([page, start, end]) => end > start && !(taken.get(page) ?? []).some(([s, e]) => start < e && end > s));
    if (!kept.length) continue;
    for (const [page, start, end] of kept) {
      taken.set(page, [...(taken.get(page) ?? []), [start, end]]);
      pages.set(page, [...(pages.get(page) ?? []), { start, end, hit }]);
    }
    hitPages.set(hit, kept[0]![0]);
    hit++;
  }
  for (const list of pages.values()) list.sort((a, b) => a.start - b.start);
  return { pages, total: hit, hitPages };
}

/** Marks on one string (a text file as shown): sorted, non-overlapping ranges numbered from 0. */
export interface TextMarks {
  ranges: MarkRange[];
  total: number;
}

export const NO_TEXT_MARKS: TextMarks = { ranges: [], total: 0 };

/** Marks for the search needles of one text. */
export function textMarks(text: string, needles: readonly string[]): TextMarks {
  if (!needles.length) return NO_TEXT_MARKS;
  const { pages, total } = pagedTextMarks(new Map([[1, text]]), needles);
  return { ranges: pages.get(1) ?? [], total };
}

/** A pdf.js text item (`TextItem`): its string and whether a line ends after it. */
export interface PdfTextPiece {
  str?: string;
  hasEOL?: boolean;
}

/**
 * A page's text as the text layer shows it: each item's string, a line break after an item that ends
 * a line. The text layer's spans and `<br>`s read in the same order give the same string, so ranges
 * on this text are ranges on the layer.
 */
export function pageText(items: readonly PdfTextPiece[]): string {
  let out = "";
  for (const item of items) {
    out += item.str ?? "";
    if (item.hasEOL) out += "\n";
  }
  return out;
}

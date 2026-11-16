/**
 * Evidence marks (preview reader.js `needles` + `markHits`): cited passages (`ItemPassage.text` /
 * `boundingBoxes`) and search words, as ranges on a text, on a table's cells or on a PDF page (its
 * boxes, or its text layer), numbered so the reader can step through them ("2 of 5"). Nothing is
 * guessed: a passage that no longer resolves is counted, not placed.
 */

/** A box on a PDF page, normalized 0–1 with a top-left origin (`ItemPassageBoundingBox`). */
export interface PageBox {
  pageNumber?: number;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

/** A cited passage as the API returns it (`ItemPassage`). */
export interface CitedPassage {
  text?: string | null;
  boundingBoxes?: readonly PageBox[];
}

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

/** Folded text with runs of whitespace collapsed to one space, and each kept character's source index. */
function collapse(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (!space) {
        out += " ";
        at.push(i);
      }
      space = true;
    } else {
      out += foldChar(c);
      at.push(i);
      space = false;
    }
  }
  if (out.endsWith(" ")) {
    out = out.slice(0, -1);
    at.pop();
  }
  return { text: out, at };
}

/** Where `quote` sits in `text`, ignoring case, accents and spacing; the whole text when the text is part of the quote. */
export function locate(text: string, quote: string): { start: number; end: number } | null {
  const t = collapse(text);
  const q = collapse(quote).text;
  if (!q || !t.text) return null;
  const index = t.text.indexOf(q);
  if (index >= 0) return { start: t.at[index]!, end: t.at[index + q.length - 1]! + 1 };
  return q.includes(t.text) ? { start: 0, end: text.length } : null;
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
  if (cited || collapse(documentText).text.includes(collapse(query).text)) return [query];
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

/* ═══════════════ Passages → table rows ═══════════════ */

const MIN_CELL_LENGTH = 2;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const normalize = (text: string) => text.replaceAll(/\s+/g, " ").trim().toLowerCase();

/** Whether `value` occurs in `passage` not as part of a longer word or number ("53" is not quoted by "537"). */
function quotes(passage: string, value: string): boolean {
  for (let at = passage.indexOf(value); at >= 0; at = passage.indexOf(value, at + 1)) {
    const before = passage[at - 1];
    const after = passage[at + value.length];
    if ((!before || !WORD_CHARACTER.test(before) || !WORD_CHARACTER.test(value[0]!))
      && (!after || !WORD_CHARACTER.test(after) || !WORD_CHARACTER.test(value.at(-1)!))) return true;
  }
  return false;
}

/** Rows a passage quotes: its first cell and one other (or its only cell) appear in the passage as whole values. */
export function quotedRows(rows: readonly (readonly string[])[], passageText: string): number[] {
  const passage = normalize(passageText);
  const out: number[] = [];
  rows.forEach((row, index) => {
    const cells = row.map(normalize).filter((cell) => cell.length >= MIN_CELL_LENGTH);
    const [first, ...others] = cells;
    if (first !== undefined && quotes(passage, first) && (!others.length || others.some((cell) => quotes(passage, cell)))) out.push(index);
  });
  return out;
}

/* ═══════════════ Passages → text ═══════════════ */

/** Marks on one string (a text file as shown): sorted, non-overlapping ranges numbered from 0. */
export interface TextMarks {
  ranges: MarkRange[];
  total: number;
  /** Cited passages whose text isn't in this text. */
  unresolved: number;
}

export const NO_TEXT_MARKS: TextMarks = { ranges: [], total: 0, unresolved: 0 };

/** Pieces of a passage shorter than this are not looked for on their own (they would match anywhere). */
const MIN_PIECE = 16;

/**
 * Where a passage sits in a text: the whole quote when it is there as one run; else each of its
 * lines and sentences that is (a passage that spans a heading, a table or Markdown syntax the file
 * shows rendered). Empty when nothing of it is found.
 */
function locatePassage(text: string, quote: string): [number, number][] {
  const whole = locate(text, quote);
  if (whole) return [[whole.start, whole.end]];
  const out: [number, number][] = [];
  for (const piece of quote.split(/\n+|(?<=[.!?;:])\s+/)) {
    const words = piece.replace(/[#*_`>|]+/g, " ").trim();
    if (words.length < MIN_PIECE) continue;
    const found = locate(text, words);
    if (found && found.end - found.start < text.length) out.push([found.start, found.end]);
  }
  return out;
}

/**
 * Marks for the cited passages (their quoted text, found ignoring case, accents and spacing) and search
 * needles of one text. A passage found in pieces is one mark made of several ranges (one hit number).
 */
export function textMarks(text: string, { passages = [], needles = [] }: { passages?: readonly CitedPassage[]; needles?: readonly string[] }): TextMarks {
  if (!passages.length && !needles.length) return NO_TEXT_MARKS;
  const { pages, total, unresolved } = pagedTextMarks(new Map([[1, text]]), { passages, needles });
  return { ranges: pages.get(1) ?? [], total, unresolved };
}

/** Marks on a PDF's pages of text (`pageText`), keyed by page number. */
export interface PagedTextMarks {
  pages: Map<number, MarkRange[]>;
  total: number;
  /** Cited passages found on no page. */
  unresolved: number;
  /** The page each mark starts on. */
  hitPages: Map<number, number>;
}

/**
 * Marks for passages and needles across pages of text, numbered from `first` in reading order (page,
 * then position). A passage is one mark wherever its pieces land; a range overlapping one already
 * marked is dropped.
 */
export function pagedTextMarks(
  pageTexts: ReadonlyMap<number, string>,
  { passages = [], needles = [] }: { passages?: readonly CitedPassage[]; needles?: readonly string[] },
  first = 0,
): PagedTextMarks {
  const order = [...pageTexts.keys()].sort((a, b) => a - b);
  const groups: { page: number; start: number; ranges: [page: number, start: number, end: number][] }[] = [];
  let unresolved = 0;
  for (const passage of passages) {
    const ranges: [number, number, number][] = [];
    if (passage.text) for (const page of order) for (const [s, e] of locatePassage(pageTexts.get(page)!, passage.text)) ranges.push([page, s, e]);
    if (ranges.length) groups.push({ page: ranges[0]![0], start: Math.min(...ranges.filter((r) => r[0] === ranges[0]![0]).map((r) => r[1])), ranges });
    else unresolved++;
  }
  for (const page of order) for (const [s, e] of occurrences(pageTexts.get(page)!, needles)) groups.push({ page, start: s, ranges: [[page, s, e]] });
  groups.sort((a, b) => a.page - b.page || a.start - b.start);
  const taken = new Map<number, [number, number][]>();
  const pages = new Map<number, MarkRange[]>();
  const hitPages = new Map<number, number>();
  let hit = first;
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
  return { pages, total: hit - first, unresolved, hitPages };
}

/* ═══════════════ Passages → PDF pages ═══════════════ */

/** One cited passage on a PDF page: a normalized box and the mark it belongs to. */
export interface PageMark {
  left: number;
  top: number;
  width: number;
  height: number;
  hit: number;
}

export interface PdfMarks {
  /** Boxes per page number. */
  pages: Map<number, PageMark[]>;
  total: number;
  /** Cited passages without a box on a page: looked for in the pages' text instead. */
  textPassages: CitedPassage[];
}

export const NO_PDF_MARKS: PdfMarks = { pages: new Map(), total: 0, textPassages: [] };

const clamp01 = (value: number | undefined) => Math.min(1, Math.max(0, value ?? 0));

/**
 * Marks for cited passages on a PDF: each passage with `boundingBoxes` is one mark made of its boxes,
 * numbered in reading order (page, then top). Passages without boxes are returned to be found in the
 * text layer (`pagedTextMarks`, numbered after the boxes).
 */
export function pdfMarks(passages: readonly CitedPassage[]): PdfMarks {
  if (!passages.length) return NO_PDF_MARKS;
  const placed: { boxes: Required<PageBox>[] }[] = [];
  const textPassages: CitedPassage[] = [];
  for (const passage of passages) {
    const boxes = (passage.boundingBoxes ?? [])
      .filter((b) => (b.pageNumber ?? 0) > 0 && (b.width ?? 0) > 0 && (b.height ?? 0) > 0)
      .map((b) => ({ pageNumber: b.pageNumber!, left: clamp01(b.left), top: clamp01(b.top), width: clamp01(b.width), height: clamp01(b.height) }));
    if (boxes.length) placed.push({ boxes });
    else textPassages.push(passage);
  }
  const first = (p: (typeof placed)[number]) => p.boxes.reduce((a, b) => (b.pageNumber < a.pageNumber || (b.pageNumber === a.pageNumber && b.top < a.top) ? b : a));
  placed.sort((a, b) => first(a).pageNumber - first(b).pageNumber || first(a).top - first(b).top);
  const pages = new Map<number, PageMark[]>();
  placed.forEach(({ boxes }, hit) => {
    for (const { pageNumber, left, top, width, height } of boxes) {
      const list = pages.get(pageNumber) ?? [];
      list.push({ left, top, width: Math.min(width, 1 - left), height: Math.min(height, 1 - top), hit });
      pages.set(pageNumber, list);
    }
  });
  return { pages, total: placed.length, textPassages };
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

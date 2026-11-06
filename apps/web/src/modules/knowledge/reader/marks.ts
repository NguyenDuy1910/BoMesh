/**
 * Evidence marks on a rendition (preview reader.js `needles` + `markHits`):
 * cited passages (`ItemPassage.elementIds` + `text`) and search words, as
 * ranges on the blocks they land in, numbered in document order so the reader
 * can step through them ("2 of 5"). Nothing is guessed: a passage that no
 * longer resolves is counted, not placed.
 */
import { blockText, markableText, type DocumentRendition, type RenditionBlock, type TableBlock } from "./rendition.ts";

/** A cited passage as the API returns it (`ItemPassage`). */
export interface CitedPassage {
  elementIds?: readonly string[];
  text?: string | null;
}

export interface MarkRange {
  start: number;
  end: number;
  /** Position of this mark among all marks of the document, from 0. */
  hit: number;
}

export interface BlockMarks {
  /** Ranges on a text block's text, or on a table's caption. */
  text?: MarkRange[];
  /** Ranges per table cell, keyed `row:column` (row -1 is the header). */
  cells?: Map<string, MarkRange[]>;
  /** Cited table rows → hit. */
  rows?: Map<number, number>;
  /** A cited table whose rows can't be told apart → hit. */
  whole?: number;
}

export interface DocumentMarks {
  blocks: Map<string, BlockMarks>;
  /** Number of marks. */
  total: number;
  /** Cited passages that match nothing in this rendition (reprocessed since it was cited). */
  unresolved: number;
}

export const NO_MARKS: DocumentMarks = { blocks: new Map(), total: 0, unresolved: 0 };

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
function occurrences(text: string, needles: readonly string[]): [number, number][] {
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

/* ═══════════════ Passages → blocks ═══════════════ */

const FALLBACK_PREFIX = 60;
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

/** A row is quoted when its first cell and one other (or its only cell) appear in the passage as whole values. */
function rowInPassage(row: readonly string[], passage: string): boolean {
  const cells = row.map(normalize).filter((cell) => cell.length >= MIN_CELL_LENGTH);
  const [first, ...others] = cells;
  if (first === undefined || !quotes(passage, first)) return false;
  return !others.length || others.some((cell) => quotes(passage, cell));
}

/** The blocks a passage cites: the ones its element ids name, else the block holding its opening words. */
export function citedBlocks(rendition: DocumentRendition, passage: CitedPassage): RenditionBlock[] {
  const ids = new Set(passage.elementIds ?? []);
  const named = rendition.blocks.filter((block) => ids.has(block.id));
  if (named.length) return named;
  const opening = normalize(passage.text ?? "").slice(0, FALLBACK_PREFIX);
  if (!opening) return [];
  const match = rendition.blocks.find((block) => normalize(blockText(block)).includes(opening));
  return match ? [match] : [];
}

/** Cited rows of a table: those the passage quotes. */
export function citedRows(table: TableBlock, passageText: string): number[] {
  const passage = normalize(passageText);
  if (!passage) return [];
  const rows: number[] = [];
  table.rows.forEach((row, index) => {
    if (rowInPassage(row, passage)) rows.push(index);
  });
  return rows;
}

interface Pending {
  ranges: [number, number][];
  cells: Map<string, [number, number][]>;
  rows: Set<number>;
  whole: boolean;
}

/** Sorted, non-overlapping ranges, each numbered from `next`. */
function number(ranges: [number, number][], next: { hit: number }): MarkRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: MarkRange[] = [];
  for (const [start, end] of sorted) {
    if (end <= start) continue;
    const last = out.at(-1);
    if (last && start < last.end) continue;
    out.push({ start, end, hit: next.hit++ });
  }
  return out;
}

/**
 * Marks for the cited passages and search needles of one rendition. A passage quoted inside a
 * block marks those words; a block that is part of a longer passage is marked whole; a cited
 * table marks the rows the passage quotes (or the table, when no row is quoted).
 */
export function documentMarks(
  rendition: DocumentRendition,
  { passages = [], needles = [] }: { passages?: readonly CitedPassage[]; needles?: readonly string[] },
): DocumentMarks {
  if (!passages.length && !needles.length) return NO_MARKS;
  const pending = new Map<string, Pending>();
  const slot = (id: string) => {
    let p = pending.get(id);
    if (!p) pending.set(id, (p = { ranges: [], cells: new Map(), rows: new Set(), whole: false }));
    return p;
  };
  let unresolved = 0;

  for (const passage of passages) {
    const blocks = citedBlocks(rendition, passage);
    if (!blocks.length) {
      unresolved++;
      continue;
    }
    const text = passage.text ?? "";
    for (const block of blocks) {
      const p = slot(block.id);
      if (block.kind === "table") {
        const rows = citedRows(block, text);
        if (rows.length) rows.forEach((row) => p.rows.add(row));
        else p.whole = true;
      } else {
        const own = markableText(block);
        const range = text ? locate(own, text) : null;
        p.ranges.push(range ? [range.start, range.end] : [0, own.length]);
      }
    }
  }

  if (needles.length) {
    for (const block of rendition.blocks) {
      if (block.kind === "table") {
        const add = (key: string, value: string) => {
          const found = occurrences(value, needles);
          if (!found.length) return;
          const p = slot(block.id);
          p.cells.set(key, [...(p.cells.get(key) ?? []), ...found]);
        };
        block.columns.forEach((column, c) => add(`-1:${c}`, column));
        block.rows.forEach((row, r) => row.forEach((cell, c) => add(`${r}:${c}`, cell)));
        if (block.caption) {
          const found = occurrences(block.caption, needles);
          if (found.length) slot(block.id).ranges.push(...found);
        }
      } else {
        const found = occurrences(markableText(block), needles);
        if (found.length) slot(block.id).ranges.push(...found);
      }
    }
  }

  // Number the marks in reading order.
  const next = { hit: 0 };
  const out = new Map<string, BlockMarks>();
  for (const block of rendition.blocks) {
    const p = pending.get(block.id);
    if (!p) continue;
    const marks: BlockMarks = {};
    if (p.ranges.length) marks.text = number(p.ranges, next);
    if (block.kind === "table") {
      if (p.whole) marks.whole = next.hit++;
      if (p.rows.size || p.cells.size) {
        const rows = new Map<number, number>();
        const cells = new Map<string, MarkRange[]>();
        for (let c = 0; c < block.columns.length; c++) {
          const found = p.cells.get(`-1:${c}`);
          if (found) cells.set(`-1:${c}`, number(found, next));
        }
        block.rows.forEach((row, r) => {
          if (p.rows.has(r)) {
            rows.set(r, next.hit++);
            return;
          }
          row.forEach((_, c) => {
            const found = p.cells.get(`${r}:${c}`);
            if (found) cells.set(`${r}:${c}`, number(found, next));
          });
        });
        if (rows.size) marks.rows = rows;
        if (cells.size) marks.cells = cells;
      }
    }
    out.set(block.id, marks);
  }
  return { blocks: out, total: next.hit, unresolved };
}

/** The plain text of a whole rendition, for deciding how a search should match. */
export function renditionText(rendition: DocumentRendition): string {
  return rendition.blocks.map(blockText).join("\n");
}

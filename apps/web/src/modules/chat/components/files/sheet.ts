/**
 * A spreadsheet as the file panel shows it: named sheets of a header row and
 * value rows, read from a CSV revision's text or from the rendition the
 * server made of a workbook (one table per sheet, `page` = sheet number).
 */
import type { RenditionBlock } from "@/modules/knowledge/rendition";

export interface Sheet {
  name: string;
  columns: string[];
  rows: string[][];
  /** Rows in the source; more than `rows.length` when the preview was cut. */
  totalRows: number;
}

/** Spreadsheet column letters: A … Z, AA, AB … */
export function columnLetter(index: number): string {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/**
 * Parse delimited text (RFC 4180): quoted fields may hold the delimiter,
 * doubled quotes and line breaks; CRLF and LF both end a record.
 */
export function parseDelimited(text: string, delimiter: "," | "\t" = ","): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (quoted) {
      if (character !== '"') field += character;
      else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === '"' && field === "") quoted = true;
    else if (character === delimiter) {
      record.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += character;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  // A trailing blank line is not a row.
  while (records.length && records.at(-1)!.every((value) => value === "")) records.pop();
  return records;
}

export function sheetFromDelimited(text: string, name: string, delimiter: "," | "\t" = ","): Sheet {
  const [header = [], ...rows] = parseDelimited(text, delimiter);
  return { name, columns: header, rows, totalRows: rows.length };
}

/**
 * The sheets of a workbook rendition. A sheet is named by the heading that
 * opens its page, else the table caption, else its number; a page holding
 * several tables lists each as its own sheet.
 */
export function sheetsFromBlocks(blocks: readonly RenditionBlock[]): Sheet[] {
  const sheets: Sheet[] = [];
  const headings = new Map<number | null, string>();
  const tablesOnPage = new Map<number | null, number>();
  for (const block of blocks) {
    if (block.kind === "heading" && !headings.has(block.page) && block.text.trim()) {
      headings.set(block.page, block.text.trim());
      continue;
    }
    if (block.kind !== "table") continue;
    const count = (tablesOnPage.get(block.page) ?? 0) + 1;
    tablesOnPage.set(block.page, count);
    const base = headings.get(block.page) || block.caption?.trim() || `Sheet ${block.page ?? sheets.length + 1}`;
    sheets.push({
      name: count > 1 ? `${base} (${count})` : base,
      columns: block.columns,
      rows: block.rows,
      totalRows: Math.max(block.total_rows, block.rows.length),
    });
  }
  return sheets;
}

/** The widest row decides how many columns a sheet shows. */
export function sheetWidth(sheet: Sheet): number {
  let width = sheet.columns.length;
  for (const row of sheet.rows) width = Math.max(width, row.length);
  return width;
}

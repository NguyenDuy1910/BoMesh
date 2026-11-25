/**
 * The TABLE representation (`application/vnd.bomesh.table+json`, gzip-encoded; document_viewer.md
 * "Payloads"): every sheet's cells as strings, cut at the engine's bounds (50 sheets, 200 columns and
 * 10,000 rows per sheet, 1,000,000 cells), each sheet saying how large it really is.
 */
import { occurrences, type MarkRange } from "./marks.ts";

export interface TableSheet {
  name: string;
  rows: string[][];
  /** Rows and columns of the sheet in the file (at least what `rows` holds). */
  totalRows: number;
  totalColumns: number;
  /** The sheet holds less than the file's sheet. */
  truncated: boolean;
}

export interface TablePayload {
  sheets: TableSheet[];
}

/** The payload isn't a table this client reads (an unknown schema, or not a table at all). */
export class TablePayloadError extends Error {
  constructor(message = "Không đọc được bảng này.") {
    super(message);
    this.name = "TablePayloadError";
  }
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** A TABLE payload, checked and normalized: cells are strings, totals never below what is held, `truncated` set when they exceed it. */
export function parseTablePayload(json: unknown): TablePayload {
  const payload = json as { schema?: unknown; sheets?: unknown } | null;
  if (payload?.schema !== 1 || !Array.isArray(payload.sheets)) throw new TablePayloadError();
  const sheets = payload.sheets.map((raw: unknown, index): TableSheet => {
    const sheet = (raw ?? {}) as { name?: unknown; rows?: unknown; totalRows?: unknown; totalColumns?: unknown; truncated?: unknown };
    const rows = Array.isArray(sheet.rows) ? sheet.rows.map((row: unknown) => (Array.isArray(row) ? row.map((cell: unknown) => (cell == null ? "" : String(cell))) : [])) : [];
    const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
    const totalRows = Math.max(count(sheet.totalRows), rows.length);
    const totalColumns = Math.max(count(sheet.totalColumns), width);
    return {
      name: typeof sheet.name === "string" && sheet.name ? sheet.name : `Trang tính ${index + 1}`,
      rows,
      totalRows,
      totalColumns,
      truncated: sheet.truncated === true || totalRows > rows.length || totalColumns > width,
    };
  });
  return { sheets };
}

/** Columns a sheet shows: its widest row. */
export function sheetWidth(sheet: Pick<TableSheet, "rows">): number {
  return sheet.rows.reduce((w, row) => Math.max(w, row.length), 0);
}

/** What a cut sheet says: the rows it shows of how many, else the columns, else that part of it is shown. */
export type SheetNotice = { cut: "rows" | "columns"; shown: number; total: number } | { cut: "part" };

export function sheetNotice(sheet: TableSheet): SheetNotice | null {
  if (!sheet.truncated) return null;
  if (sheet.totalRows > sheet.rows.length) return { cut: "rows", shown: sheet.rows.length, total: sheet.totalRows };
  const width = sheetWidth(sheet);
  if (sheet.totalColumns > width) return { cut: "columns", shown: width, total: sheet.totalColumns };
  return { cut: "part" };
}

/** Rows are drawn in groups this size, each skipped by layout while off screen (`content-visibility: auto`). */
export const ROW_GROUP = 100;

/** [start, end) of each row group. */
export function rowGroups(rows: number, size = ROW_GROUP): [number, number][] {
  const out: [number, number][] = [];
  for (let start = 0; start < rows; start += size) out.push([start, Math.min(rows, start + size)]);
  return out;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Spreadsheet column name (0 → A, 26 → AA). */
export function columnLetter(index: number): string {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = LETTERS[(value - 1) % 26] + name;
  return name;
}

/** Every cell's text, for deciding how a search should match. */
export function tableText(payload: TablePayload): string {
  return payload.sheets.map((sheet) => sheet.rows.map((row) => row.join("\t")).join("\n")).join("\n");
}

/** Cell key in `TableMarks.cells`. */
export const cellKey = (sheet: number, row: number, column: number) => `${sheet}:${row}:${column}`;

export interface TableMarks {
  /** Ranges per cell (`cellKey`). */
  cells: Map<string, MarkRange[]>;
  total: number;
  /** The sheet each mark is on. */
  hitSheets: Map<number, number>;
}

export const NO_TABLE_MARKS: TableMarks = { cells: new Map(), total: 0, hitSheets: new Map() };

/**
 * Marks on a table: every occurrence of a needle in a cell, numbered in reading order (sheet, row,
 * column, position); an occurrence overlapping one already marked is dropped.
 */
export function tableMarks(payload: TablePayload, needles: readonly string[]): TableMarks {
  if (!needles.length) return NO_TABLE_MARKS;
  const cells = new Map<string, MarkRange[]>();
  const hitSheets = new Map<number, number>();
  let hit = 0;
  payload.sheets.forEach((sheet, s) =>
    sheet.rows.forEach((row, r) =>
      row.forEach((value, c) => {
        const ranges: MarkRange[] = [];
        for (const [start, end] of occurrences(value, needles).sort((a, b) => a[0] - b[0] || b[1] - a[1])) {
          if (ranges.some((m) => start < m.end && end > m.start)) continue;
          hitSheets.set(hit, s);
          ranges.push({ start, end, hit: hit++ });
        }
        if (ranges.length) cells.set(cellKey(s, r, c), ranges);
      }),
    ),
  );
  return { cells, total: hit, hitSheets };
}

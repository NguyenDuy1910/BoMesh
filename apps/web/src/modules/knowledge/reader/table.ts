/**
 * The TABLE representation (`application/vnd.bomesh.table+json` schema 2, gzip-encoded; document_viewer.md
 * "Representation payloads and bounds"): every sheet's cells as the sheet shows them, `rows[i][j]` being the
 * cell at row `i + 1`, column `j + 1` counted from A1 (leading blank rows and columns included), cut at the
 * engine's bounds (50 sheets, 200 columns and 10,000 rows per sheet, 1,000,000 cells), each sheet saying how
 * large it really is. A Highlight's `cellRange` indexes the rows directly (`cellRect`).
 */
import { occurrences, type MarkRange } from "./marks.ts";

export interface TableSheet {
  name: string;
  /** From cell A1: `rows[i][j]` is row `i + 1`, column `j` (`columnLetter`). */
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
  if (payload?.schema !== 2 || !Array.isArray(payload.sheets)) throw new TablePayloadError();
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

/** Column index of spreadsheet letters (A → 0, Z → 25, AA → 26, DH → 111). */
export function columnIndex(letters: string): number {
  let value = 0;
  for (const ch of letters) value = value * 26 + (ch.charCodeAt(0) - 64);
  return value - 1;
}

/** Cells of a sheet as row and column indices into `TableSheet.rows`, inclusive. */
export interface CellRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

const CELL = /^([A-Z]+)([1-9]\d*)$/;

/** An A1 range (`A24:DH26`, or one cell `B3`) as indices (`{ top: 23, left: 0, bottom: 25, right: 111 }`); `null` when it isn't one. */
export function cellRect(range: string): CellRect | null {
  const [from, to = from] = range.toUpperCase().split(":");
  const a = CELL.exec(from ?? "");
  const b = CELL.exec(to ?? "");
  if (!a || !b) return null;
  const [r1, c1, r2, c2] = [Number(a[2]) - 1, columnIndex(a[1]!), Number(b[2]) - 1, columnIndex(b[1]!)];
  return { top: Math.min(r1, r2), left: Math.min(c1, c2), bottom: Math.max(r1, r2), right: Math.max(c1, c2) };
}

/** The part of `rect` a sheet holds (its rows and its widest row), or `null` when the sheet holds none of it (cut away). */
export function heldRect(rect: CellRect, sheet: Pick<TableSheet, "rows">): CellRect | null {
  const bottom = Math.min(rect.bottom, sheet.rows.length - 1);
  const right = Math.min(rect.right, sheetWidth(sheet) - 1);
  return rect.top <= bottom && rect.left <= right ? { top: rect.top, left: rect.left, bottom, right } : null;
}

/** A Highlight's cells on a sheet of the payload. */
export interface SheetRect {
  /** Index into `TablePayload.sheets`. */
  sheet: number;
  rect: CellRect;
}

/** The part of each Highlight's range the payload holds, on the sheet it names; a Highlight on no sheet held, or on cells cut away, is left out. */
export function sheetRects(payload: TablePayload, highlights: readonly { sheet?: string; cellRange?: string }[]): SheetRect[] {
  const out: SheetRect[] = [];
  for (const h of highlights) {
    const sheet = h.sheet ? payload.sheets.findIndex((s) => s.name === h.sheet) : -1;
    const rect = sheet >= 0 && h.cellRange ? cellRect(h.cellRange) : null;
    const held = rect && heldRect(rect, payload.sheets[sheet]!);
    if (held) out.push({ sheet, rect: held });
  }
  return out;
}

/** Whether a cell lies in any of the rects. */
export const inRects = (rects: readonly CellRect[], row: number, column: number) => rects.some((r) => row >= r.top && row <= r.bottom && column >= r.left && column <= r.right);

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

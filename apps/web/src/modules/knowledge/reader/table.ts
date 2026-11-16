/**
 * The TABLE representation (`application/vnd.bomesh.table+json`, gzip-encoded; document_viewer.md
 * "Payloads"): every sheet's cells as strings, cut at the engine's bounds (50 sheets, 200 columns and
 * 10,000 rows per sheet, 1,000,000 cells), each sheet saying how large it really is.
 */
import { occurrences, quotedRows, type CitedPassage, type MarkRange } from "./marks.ts";

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
  constructor(message = "This table couldn’t be read.") {
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
      name: typeof sheet.name === "string" && sheet.name ? sheet.name : `Sheet ${index + 1}`,
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
  /** Ranges per cell (`cellKey`); a cited row's cells are marked whole. */
  cells: Map<string, MarkRange[]>;
  total: number;
  /** Cited passages that quote no row. */
  unresolved: number;
  /** The sheet each mark is on. */
  hitSheets: Map<number, number>;
}

export const NO_TABLE_MARKS: TableMarks = { cells: new Map(), total: 0, unresolved: 0, hitSheets: new Map() };

/**
 * Marks on a table: a cited passage marks the rows it quotes (one mark), a needle every cell holding it.
 * Numbered in reading order (sheet, row, column); a cell already marked whole isn't marked again.
 */
export function tableMarks(payload: TablePayload, { passages = [], needles = [] }: { passages?: readonly CitedPassage[]; needles?: readonly string[] }): TableMarks {
  if (!passages.length && !needles.length) return NO_TABLE_MARKS;
  type Group = { at: [number, number, number]; cells: { key: string; s: number; start: number; end: number }[] };
  const groups: Group[] = [];
  let unresolved = 0;
  for (const passage of passages) {
    const cells: Group["cells"] = [];
    let at: Group["at"] | undefined;
    payload.sheets.forEach((sheet, s) => {
      for (const r of passage.text ? quotedRows(sheet.rows, passage.text) : []) {
        at ??= [s, r, 0];
        sheet.rows[r]!.forEach((value, c) => {
          if (value) cells.push({ key: cellKey(s, r, c), s, start: 0, end: value.length });
        });
      }
    });
    if (at && cells.length) groups.push({ at, cells });
    else unresolved++;
  }
  if (needles.length) {
    payload.sheets.forEach((sheet, s) =>
      sheet.rows.forEach((row, r) =>
        row.forEach((value, c) => {
          for (const [start, end] of occurrences(value, needles)) groups.push({ at: [s, r, c], cells: [{ key: cellKey(s, r, c), s, start, end }] });
        }),
      ),
    );
  }
  groups.sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || a.at[2] - b.at[2]);
  const cells = new Map<string, MarkRange[]>();
  const hitSheets = new Map<number, number>();
  let hit = 0;
  for (const group of groups) {
    const kept = group.cells.filter(({ key, start, end }) => !(cells.get(key) ?? []).some((r) => start < r.end && end > r.start));
    if (!kept.length) continue;
    for (const { key, start, end } of kept) cells.set(key, [...(cells.get(key) ?? []), { start, end, hit }]);
    hitSheets.set(hit, kept[0]!.s);
    hit++;
  }
  for (const list of cells.values()) list.sort((a, b) => a.start - b.start);
  return { cells, total: hit, unresolved, hitSheets };
}

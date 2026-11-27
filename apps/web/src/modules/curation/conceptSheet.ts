import type { ConceptScheme } from "@/modules/knowledge/api";
import { conceptState, resourceKey, schemeByName, schemeOfConcept, type Taxonomy } from "@/modules/knowledge/taxonomy";

import { cleanLabel, newNotation, NOTATION_RE, schemeNotations } from "./governance";
import type { ConceptImportRow } from "./taxonomyApi";

/**
 * Concepts spreadsheet import (preview `features/masterdata.js` `parseCsv`, `planImport`, `csvRow`): the file's rows as
 * `:importConcepts` rows, one batch per scheme. The file names its columns in its first row, in any order:
 * scheme, notation, broader, pref_vi, pref_en, alt, hidden, definition, scope_note (the preview's), plus the API's own
 * related, alt_vi, alt_en, examples, color, icon, match_patterns, time_sensitive and mappings. A column the file doesn't
 * have leaves that field as it is; an empty cell clears it (a name is never cleared). Lists are separated by “;”, “|” or
 * line breaks; alternative and hidden labels may start with their language (“en:scholarship”).
 */

export const COLUMNS = ["scheme", "notation", "broader", "pref_vi", "pref_en", "alt", "hidden", "definition", "scope_note"] as const;
const EXTRA = ["related", "alt_vi", "alt_en", "examples", "color", "icon", "match_patterns", "time_sensitive", "mappings"] as const;
type Column = (typeof COLUMNS)[number] | (typeof EXTRA)[number];
/** Rows one file may hold. */
export const MAX_ROWS = 2000;

/** One file row, as written (cells cleaned), with its 1-based spreadsheet row number (header = 1). */
export interface SheetRow {
  line: number;
  cells: Partial<Record<Column, string>>;
}

export interface ConceptSheet {
  rows: SheetRow[];
  /** Columns the file has. */
  columns: ReadonlySet<Column>;
}

/** CSV or TSV text as rows of cells (quoted cells may hold separators, quotes and line breaks). `rows[i]` is spreadsheet row i + 1. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === "\t") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Long text keeps its line breaks (each line cleaned); every other cell is one line. */
const LONG: Partial<Record<Column, true>> = { definition: true, scope_note: true };
const cleanBlock = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(cleanLabel)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * Spreadsheet cells (`cells[i]` = row i + 1; CSV or a worksheet) as sheet rows. The first non-blank row names the
 * columns; it needs a notation or a name column. Blank rows are left out.
 */
export function readSheet(cells: readonly (readonly string[])[]): ConceptSheet | { error: string } {
  const lines = cells.flatMap((r, i) => (r.some((x) => cleanLabel(String(x ?? ""))) ? [{ r, line: i + 1 }] : []));
  if (!lines.length) return { error: "Tệp trống." };
  const head = lines[0].r.map((h) =>
    String(h ?? "")
      .replace(/^\ufeff/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]+/g, "_")
      .replace(/^_|_$/g, ""),
  );
  const known = [...COLUMNS, ...EXTRA] as readonly Column[];
  const at = new Map(known.map((k) => [k, head.indexOf(k)] as const).filter(([, i]) => i >= 0));
  if (!at.has("notation") && !at.has("pref_vi") && !at.has("pref_en")) return { error: `Dòng đầu tiên phải ghi tên các cột: ${COLUMNS.join(", ")}.` };
  const body = lines.slice(1);
  if (!body.length) return { error: "Tệp có tiêu đề nhưng không có hàng nào." };
  if (body.length > MAX_ROWS) return { error: `Tệp có hơn ${MAX_ROWS} hàng. Hãy chia thành các tệp nhỏ hơn.` };
  const rows = body.map(({ r, line }) => {
    const out: Partial<Record<Column, string>> = {};
    for (const [k, i] of at) out[k] = LONG[k] ? cleanBlock(String(r[i] ?? "")) : cleanLabel(String(r[i] ?? ""));
    return { line, cells: out };
  });
  return { rows, columns: new Set(at.keys()) };
}

/** Reads CSV or TSV text. */
export const parseSheet = (text: string) => readSheet(parseCsv(text));

/** A list cell's entries (“;”, “|” or line breaks). */
const listCell = (v: string | undefined) => [...new Set(String(v ?? "").split(/[;|\n]+/).map(cleanLabel).filter(Boolean))];

/** “vi:học bổng; en:scholarship; miễn học phí” → per language (no prefix: Vietnamese). */
function termsCell(v: string | undefined): { vi: string[]; en: string[] } {
  const out = { vi: [] as string[], en: [] as string[] };
  for (const t of listCell(v)) {
    const m = /^(vi|en):\s*(.+)$/i.exec(t);
    if (m) out[m[1].toLowerCase() as "vi" | "en"].push(cleanLabel(m[2]));
    else out.vi.push(t);
  }
  return out;
}

/** A row the server won't get, and why (shown as “Row n · label · why”). */
export interface SkippedRow {
  line: number;
  label: string;
  reason: string;
}

/** What to send: per scheme, its rows and their spreadsheet row numbers (by position). */
export interface ImportBatch {
  scheme: ConceptScheme;
  rows: ConceptImportRow[];
  lines: number[];
}

/**
 * The sheet as `:importConcepts` batches against the working copy (preview `planImport`): a row matches a concept by
 * scheme and notation; without a notation it adds one (made from its name). Rows without a `scheme` column go to
 * `current`. Rows that can't be sent are skipped with a reason; the server checks the rest (broader cycles, labels).
 */
export function planSheet(sheet: ConceptSheet, t: Taxonomy, current: ConceptScheme): { batches: ImportBatch[]; skipped: SkippedRow[] } {
  const has = (k: Column) => sheet.columns.has(k);
  const skipped: SkippedRow[] = [];
  const batches = new Map<string, ImportBatch>();
  const reserved = new Map<string, Set<string>>();
  const taken = (scheme: string) => reserved.get(scheme) ?? reserved.set(scheme, schemeNotations(t, scheme)).get(scheme)!;
  const added = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const planned: { scheme: ConceptScheme; row: ConceptImportRow; line: number; label: string; broader: string[] }[] = [];

  for (const { line, cells: c } of sheet.rows) {
    const label = c.notation || c.pref_vi || c.pref_en || "";
    const skip = (reason: string) => skipped.push({ line, label, reason });
    if (has("scheme") && !c.scheme) {
      skip("Thiếu trục phân loại.");
      continue;
    }
    const scheme = has("scheme") ? schemeByName(t, c.scheme) ?? t.schemes.find((s) => cleanLabel(s.displayName ?? "").toLowerCase() === c.scheme!.toLowerCase()) : current;
    if (!scheme?.name) {
      skip(`Không có trục phân loại nào tên “${c.scheme}”.`);
      continue;
    }
    let notation = (c.notation ?? "").toLowerCase();
    if (notation && !NOTATION_RE.test(notation)) {
      skip("Ký hiệu chỉ gồm chữ thường, chữ số và dấu gạch ngang, bắt đầu bằng một chữ cái.");
      continue;
    }
    const existing = notation ? t.byName.get(`${scheme.name}/concepts/${notation}`) : undefined;
    if (existing && conceptState(existing) === "DEPRECATED") {
      skip("Ký hiệu này thuộc một khái niệm đã ngừng dùng. Ký hiệu không bao giờ được dùng lại.");
      continue;
    }
    if (!existing && !c.pref_vi && !c.pref_en) {
      skip("Khái niệm mới cần tên ở pref_vi hoặc pref_en.");
      continue;
    }
    if (!notation) notation = newNotation(c.pref_vi || c.pref_en || "", taken(scheme.name));
    const key = `${scheme.name}\n${notation}`;
    if (seen.has(key)) {
      skip("Xuất hiện nhiều lần. Chỉ dòng đầu tiên được dùng.");
      continue;
    }
    seen.add(key);
    taken(scheme.name).add(notation);
    if (!existing) (added.get(scheme.name) ?? added.set(scheme.name, new Set()).get(scheme.name)!).add(notation);

    const alt = termsCell(c.alt);
    const hidden = termsCell(c.hidden);
    const list = (k: Column) => (has(k) ? listCell(c[k]).join("|") : undefined);
    const row: ConceptImportRow = { notation };
    const set = <K extends keyof ConceptImportRow>(k: K, v: ConceptImportRow[K] | undefined) => {
      if (v !== undefined) row[k] = v;
    };
    set("broader", has("broader") ? listCell(c.broader).map((x) => x.toLowerCase()).join("|") : undefined);
    set("related", list("related")?.toLowerCase());
    // A name is set when given, never cleared (a concept needs its Vietnamese name to publish).
    set("prefVi", c.pref_vi || undefined);
    set("prefEn", c.pref_en || undefined);
    set("altVi", has("alt_vi") ? list("alt_vi") : has("alt") ? alt.vi.join("|") : undefined);
    set("altEn", has("alt_en") ? list("alt_en") : has("alt") ? alt.en.join("|") : undefined);
    set("hidden", has("hidden") ? [...hidden.vi, ...hidden.en].join("|") : undefined);
    set("definition", has("definition") ? (c.definition ?? "") : undefined);
    set("scopeNote", has("scope_note") ? (c.scope_note ?? "") : undefined);
    set("examples", list("examples"));
    set("color", has("color") ? (c.color ?? "") : undefined);
    set("icon", has("icon") ? (c.icon ?? "") : undefined);
    set("matchPatterns", list("match_patterns"));
    set("timeSensitive", has("time_sensitive") ? (c.time_sensitive ?? "").toLowerCase() : undefined);
    set("mappings", list("mappings"));
    planned.push({ scheme, row, line, label: label || notation, broader: listCell(c.broader).map((x) => x.toLowerCase()) });
  }

  // `broader` names live concepts of the same scheme, or concepts this file adds.
  for (const p of planned) {
    const scheme = p.scheme.name ?? "";
    const live = (n: string) => {
      const c = t.byName.get(`${scheme}/concepts/${n}`);
      return (!!c && conceptState(c) !== "DEPRECATED") || !!added.get(scheme)?.has(n);
    };
    const missing = p.broader.filter((n) => n === p.row.notation || !live(n));
    if (missing.length) {
      skipped.push({ line: p.line, label: p.label, reason: `Không có khái niệm “${missing.join(", ")}” để nằm dưới trong ${p.scheme.displayName ?? resourceKey(scheme)}.` });
      continue;
    }
    const b = batches.get(scheme) ?? batches.set(scheme, { scheme: p.scheme, rows: [], lines: [] }).get(scheme)!;
    b.rows.push(p.row);
    b.lines.push(p.line);
  }
  return { batches: [...batches.values()], skipped: skipped.sort((a, b) => a.line - b.line) };
}

/** A concept as a file row in the preview's columns (the template's sample row). */
export function sheetRow(t: Taxonomy, name: string): string[] {
  const c = t.byName.get(name);
  const scheme = schemeOfConcept(name);
  const pref = (lang: string) => c?.prefLabels?.find((l) => l.languageCode === lang)?.text ?? "";
  const terms = (labels: readonly { languageCode: string; text: string }[] | undefined) => (labels ?? []).map((l) => `${l.languageCode}:${l.text}`).join("; ");
  return [
    resourceKey(scheme),
    resourceKey(name),
    (c?.broader ?? []).filter((b) => schemeOfConcept(b) === scheme).map(resourceKey).join("; "),
    pref("vi"),
    pref("en"),
    terms(c?.altLabels),
    terms(c?.hiddenLabels),
    c?.definition ?? "",
    c?.scopeNote ?? "",
  ];
}

/** A starting file: the columns, then the scheme's first concept as an example (when it has one). */
export const templateRows = (t: Taxonomy, first: string | undefined): string[][] => [[...COLUMNS], ...(first ? [sheetRow(t, first)] : [])];

/** CSV text (RFC 4180 quoting) with a BOM so spreadsheet apps read UTF-8. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `\ufeff${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

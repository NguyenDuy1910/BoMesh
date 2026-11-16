import { resourceId } from "@/lib/api/client";
import type { Topic } from "@/modules/knowledge/api";

import type { TopicImportRow } from "./api";

/**
 * Topics spreadsheet import · export (preview `features/masterdata.js` `parseCsv`, `exportCsv`, `templateCsv`):
 * pure functions. A row's code is its topic ID; the server compares the rows with the topics (`topics:import`),
 * so the client only reads the file into API rows and writes the topics back out.
 */

export const COLUMNS = ["code", "name", "parent_code", "description", "keywords", "synonyms", "guidance"] as const;
/** Columns a file may leave out: those stay as they are on the topics. */
export const OPTIONAL_COLUMNS = ["description", "keywords", "synonyms", "guidance"] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
/** `ImportTopicsRequest.rows` maxItems. */
export const MAX_ROWS = 2000;

export interface SheetImport {
  /** API rows: a field whose column the file doesn't have is left out (unchanged); an empty cell sends an empty value. */
  rows: TopicImportRow[];
  /** 1-based spreadsheet row (header = 1) of each API row, by position. */
  lines: number[];
  /** Optional columns the file doesn't have. */
  missing: OptionalColumn[];
}

const clean = (s: string | undefined) => String(s ?? "").trim().replace(/\s+/g, " ");
/** Multi-line text (guidance): each line cleaned, line breaks kept. */
const cleanBlock = (s: string | undefined) =>
  String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(clean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const splitList = (s: string | undefined) => [...new Set(String(s ?? "").split(/[,;|\n]+/).map(clean).filter(Boolean))];

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

const ALIAS: Readonly<Record<string, readonly string[]>> = { parent_code: ["parent", "domain", "domain_code"], synonyms: ["synonym"], guidance: ["guidance_for_the_assistant", "assistant_guidance"] };

/**
 * Spreadsheet cells (`cells[i]` = row i + 1; CSV or a worksheet) as import rows. The first non-blank row names the
 * columns in any order (only code and name are required); blank rows are left out.
 */
export function rowsToImport(cells: readonly (readonly string[])[]): SheetImport | { error: string } {
  const lines = cells.flatMap((r, i) => (r.some((x) => clean(x)) ? [{ r, line: i + 1 }] : []));
  if (!lines.length) return { error: "The file is empty." };
  const head = lines[0].r.map((h) =>
    String(h ?? "")
      .replace(/^\ufeff/, "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]+/g, "_")
      .replace(/^_|_$/g, ""),
  );
  const at = (k: string) => head.findIndex((h) => h === k || (ALIAS[k] ?? []).includes(h));
  const [iCode, iName, iParent, iDesc, iKw, iSyn, iGuide] = COLUMNS.map(at);
  if (iCode < 0 || iName < 0) return { error: "The first row must name the columns: code, name, parent_code, description, keywords, synonyms, guidance." };
  const body = lines.slice(1);
  if (!body.length) return { error: "The file has a header but no rows." };
  if (body.length > MAX_ROWS) return { error: `The file has more than ${MAX_ROWS} rows. Split it into smaller files.` };
  const rows = body.map(({ r }): TopicImportRow => ({
    code: clean(r[iCode]),
    name: clean(r[iName]),
    ...(iParent < 0 ? {} : { parentCode: clean(r[iParent]) }),
    ...(iDesc < 0 ? {} : { description: clean(r[iDesc]) }),
    ...(iKw < 0 ? {} : { keywords: splitList(r[iKw]) }),
    ...(iSyn < 0 ? {} : { synonyms: splitList(r[iSyn]) }),
    ...(iGuide < 0 ? {} : { guidance: cleanBlock(r[iGuide]) }),
  }));
  return { rows, lines: body.map((b) => b.line), missing: OPTIONAL_COLUMNS.filter((k) => at(k) < 0) };
}

/** Reads CSV or TSV text into import rows. */
export const parseSheet = (text: string) => rowsToImport(parseCsv(text));

/** The topics as spreadsheet rows: ACTIVE domains, each followed by its ACTIVE topics; code = topic ID. */
export function exportRows(topics: readonly Topic[]): string[][] {
  const rows: string[][] = [[...COLUMNS]];
  for (const d of topics.filter((t) => t.kind === "DOMAIN" && t.state === "ACTIVE")) {
    const domain = resourceId(d.name);
    rows.push([domain, d.displayName ?? "", "", d.description ?? "", "", "", ""]);
    for (const t of topics.filter((x) => x.kind === "TOPIC" && x.state === "ACTIVE" && x.parentTopic === d.name)) {
      rows.push([resourceId(t.name), t.displayName ?? "", domain, t.description ?? "", (t.keywords ?? []).join("; "), (t.synonyms ?? []).join("; "), t.guidance ?? ""]);
    }
  }
  return rows;
}

/** Codes are topic IDs (`^[a-z][a-z0-9-]{0,62}$`). */
export const TEMPLATE_ROWS: readonly (readonly string[])[] = [
  COLUMNS,
  ["ops", "Banking Operations", "", "Cut-off times, settlement and disputes.", "", "", ""],
  ["ops-cards", "Cards & disputes", "ops", "Chargebacks and cardholder disputes.", "chargeback; dispute; card scheme", "cardholder dispute; reason code", "Use for card disputes and chargebacks.\nNot for merchant fees."],
];

/** CSV text (RFC 4180 quoting) with a BOM so spreadsheet apps read UTF-8. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `\ufeff${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

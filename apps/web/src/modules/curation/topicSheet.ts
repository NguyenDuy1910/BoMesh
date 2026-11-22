import type { Topic } from "@/modules/knowledge/api";

import type { TopicImportRow } from "./api";

/**
 * Topics spreadsheet import · export (preview `features/masterdata.js` `parseCsv`, `exportCsv`, `templateCsv`):
 * pure functions. Rows name domains and topics the way people do — `domain`, `topic` — and the server matches them by
 * name (`topics:import`); IDs are never authored. Export adds the `name` column (the topic's resource name) last, so a
 * re-imported export can rename or move a topic.
 */

export const COLUMNS = ["domain", "topic", "description", "keywords", "synonyms", "guidance", "name"] as const;
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

const ALIAS: Readonly<Record<string, readonly string[]>> = {
  domain: ["domain_name"],
  topic: ["topic_name"],
  synonyms: ["synonym"],
  guidance: ["guidance_for_the_assistant", "assistant_guidance"],
};

/**
 * Spreadsheet cells (`cells[i]` = row i + 1; CSV or a worksheet) as import rows. The first non-blank row names the
 * columns in any order (only `domain` is required); blank rows are left out. A row without a topic describes its
 * domain.
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
  const [iDomain, iTopic, iDesc, iKw, iSyn, iGuide, iName] = COLUMNS.map(at);
  if (iDomain < 0) return { error: "The first row must name the columns: domain, topic, description, keywords, synonyms, guidance." };
  const body = lines.slice(1);
  if (!body.length) return { error: "The file has a header but no rows." };
  if (body.length > MAX_ROWS) return { error: `The file has more than ${MAX_ROWS} rows. Split it into smaller files.` };
  const rows = body.map(({ r }): TopicImportRow => {
    const topic = iTopic < 0 ? "" : clean(r[iTopic]);
    const name = iName < 0 ? "" : clean(r[iName]);
    return {
      domain: clean(r[iDomain]),
      ...(topic ? { topic } : {}),
      ...(name ? { name } : {}),
      ...(iDesc < 0 ? {} : { description: clean(r[iDesc]) }),
      ...(iKw < 0 ? {} : { keywords: splitList(r[iKw]) }),
      ...(iSyn < 0 ? {} : { synonyms: splitList(r[iSyn]) }),
      ...(iGuide < 0 ? {} : { guidance: cleanBlock(r[iGuide]) }),
    };
  });
  return { rows, lines: body.map((b) => b.line), missing: OPTIONAL_COLUMNS.filter((k) => at(k) < 0) };
}

/** Reads CSV or TSV text into import rows. */
export const parseSheet = (text: string) => rowsToImport(parseCsv(text));

/** The topics as spreadsheet rows: ACTIVE domains, each followed by its ACTIVE topics; `name` keeps their identity. */
export function exportRows(topics: readonly Topic[]): string[][] {
  const rows: string[][] = [[...COLUMNS]];
  for (const d of topics.filter((t) => t.kind === "DOMAIN" && t.state === "ACTIVE")) {
    const domain = d.displayName ?? "";
    rows.push([domain, "", d.description ?? "", "", "", "", d.name ?? ""]);
    for (const t of topics.filter((x) => x.kind === "TOPIC" && x.state === "ACTIVE" && x.parentTopic === d.name)) {
      rows.push([domain, t.displayName ?? "", t.description ?? "", (t.keywords ?? []).join("; "), (t.synonyms ?? []).join("; "), t.guidance ?? "", t.name ?? ""]);
    }
  }
  return rows;
}

/** A starting file: one domain row, then one topic row (no `name`: new rows are matched by name). */
export const TEMPLATE_ROWS: readonly (readonly string[])[] = [
  COLUMNS.slice(0, -1),
  ["Banking Operations", "", "Cut-off times, settlement and disputes.", "", "", ""],
  ["Banking Operations", "Cards & disputes", "Chargebacks and cardholder disputes.", "chargeback; dispute; card scheme", "cardholder dispute; reason code", "Use for card disputes and chargebacks.\nNot for merchant fees."],
];

/** CSV text (RFC 4180 quoting) with a BOM so spreadsheet apps read UTF-8. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `\ufeff${rows.map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

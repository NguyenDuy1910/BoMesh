/**
 * Minimal .xlsx reader: the first worksheet's cells as text, so spreadsheets import without a parser dependency.
 * An .xlsx file is a ZIP of XML parts; this reads the central directory, inflates the parts it needs with the
 * platform's `DecompressionStream("deflate-raw")`, and reads the XML with small regexes (no DOM, so it runs in
 * Node tests too). Shared strings, inline strings, numbers, booleans and formula results are read as text;
 * styles, dates and formulas themselves are not interpreted. ZIP64 and encrypted workbooks are not supported.
 */

/** The workbook can't be read as .xlsx (not a ZIP, missing parts, or an unsupported compression). */
export class XlsxError extends Error {}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

interface Entry {
  method: number;
  size: number;
  offset: number;
}

/** File name → where its data is, from the ZIP central directory. */
function entries(zip: Uint8Array): Map<string, Entry> {
  // End of central directory: 22 bytes plus a comment of up to 64 KiB, searched from the end.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (u32(zip, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxError("Not a ZIP file.");
  const count = u16(zip, eocd + 10);
  let at = u32(zip, eocd + 16);
  const names = new TextDecoder();
  const out = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || u32(zip, at) !== 0x02014b50) throw new XlsxError("Broken ZIP directory.");
    const nameLen = u16(zip, at + 28);
    const name = names.decode(zip.subarray(at + 46, at + 46 + nameLen));
    out.set(name, { method: u16(zip, at + 10), size: u32(zip, at + 20), offset: u32(zip, at + 42) });
    at += 46 + nameLen + u16(zip, at + 30) + u16(zip, at + 32);
  }
  return out;
}

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One part's text, or null when the workbook doesn't have it. */
async function part(zip: Uint8Array<ArrayBuffer>, dir: Map<string, Entry>, name: string): Promise<string | null> {
  const e = dir.get(name);
  if (!e) return null;
  if (u32(zip, e.offset) !== 0x04034b50) throw new XlsxError("Broken ZIP entry.");
  const start = e.offset + 30 + u16(zip, e.offset + 26) + u16(zip, e.offset + 28);
  const raw = zip.subarray(start, start + e.size);
  const bytes = e.method === 0 ? raw : e.method === 8 ? await inflate(raw) : null;
  if (!bytes) throw new XlsxError("Unsupported ZIP compression.");
  return new TextDecoder().decode(bytes);
}

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** XML text content: entities and Excel's `_xHHHH_` escapes decoded. */
const unescape = (s: string) =>
  s
    .replace(/&(?:#x([0-9a-f]+)|#(\d+)|(lt|gt|amp|quot|apos));/gi, (_, hex: string, dec: string, named: string) =>
      hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(Number(dec)) : ENTITIES[named.toLowerCase()],
    )
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** Text of every `<t>` in a fragment (rich-text runs joined; phonetic hints left out). */
const textOf = (xml: string) =>
  [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, "").matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)].map((m) => unescape(m[1] ?? "")).join("");

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** "AB" → 27 (0-based column index). */
const columnIndex = (letters: string) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

/** The first worksheet's path inside the ZIP (workbook order, through its relationships). */
async function firstSheet(zip: Uint8Array<ArrayBuffer>, dir: Map<string, Entry>): Promise<string> {
  const fallback = "xl/worksheets/sheet1.xml";
  const workbook = await part(zip, dir, "xl/workbook.xml");
  const rels = await part(zip, dir, "xl/_rels/workbook.xml.rels");
  const sheet = workbook && /<(?:\w+:)?sheet\b([^>]*)>/.exec(workbook)?.[1];
  const rid = sheet && /\b(?:\w+:)?id="([^"]*)"/.exec(sheet)?.[1];
  if (!rid || !rels) return fallback;
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)>/g)) {
    if (attr(m[1], "Id") !== rid) continue;
    const target = attr(m[1], "Target") ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    return dir.has(path) ? path : fallback;
  }
  return fallback;
}

/**
 * The first worksheet as rows of cell text: `rows[i]` is spreadsheet row i + 1 and `rows[i][j]` column j + 1
 * (rows and cells the sheet leaves out are empty). Throws `XlsxError` when the file isn't a readable workbook.
 */
export async function readXlsx(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string[][]> {
  const zip = data instanceof Uint8Array ? data : new Uint8Array(data);
  const dir = entries(zip);
  const sheetXml = await part(zip, dir, await firstSheet(zip, dir));
  if (sheetXml == null) throw new XlsxError("No worksheet.");
  const sharedXml = await part(zip, dir, "xl/sharedStrings.xml");
  const shared = sharedXml ? [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((m) => textOf(m[1] ?? "")) : [];

  const rows: string[][] = [];
  let nextRow = 0;
  for (const r of sheetXml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rowAt = Number(attr(r[1], "r")) - 1;
    const ri = Number.isInteger(rowAt) && rowAt >= 0 ? rowAt : nextRow;
    nextRow = ri + 1;
    const cells: string[] = [];
    let nextCol = 0;
    for (const c of (r[2] ?? "").matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ref = /^([A-Z]+)\d*$/i.exec(attr(c[1], "r") ?? "");
      const ci = ref ? columnIndex(ref[1]) : nextCol;
      nextCol = ci + 1;
      const body = c[2] ?? "";
      const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      const type = attr(c[1], "t");
      const text =
        type === "s" ? (shared[Number(v)] ?? "") : type === "inlineStr" ? textOf(body) : type === "b" ? (v === "1" ? "TRUE" : v == null ? "" : "FALSE") : v == null ? "" : unescape(v);
      while (cells.length < ci) cells.push("");
      cells[ci] = text;
    }
    while (rows.length < ri) rows.push([]);
    rows[ri] = cells;
  }
  return rows;
}

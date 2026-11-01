/**
 * Format conversion for `artifact.export_formats`, done in the browser while
 * `GET /artifacts/{artifact_id}/revisions/{revision}/export?format=` is
 * pending. Every output is a real file of the requested type:
 *
 * - `csv`: a CSV revision as is; otherwise the tables of the revision
 *   (Markdown tables, or the sheets of a spreadsheet's preview), one after
 *   another with a blank row between them.
 * - `md`: Markdown/plain text as is; CSV as a Markdown table; other text in a
 *   code fence; a binary file from its preview (headings, text, tables).
 * - `pdf`: a valid, text-only PDF (Helvetica, A4). The standard PDF fonts
 *   cover Latin-1 only, so letters outside it are written without their
 *   accents (e.g. Vietnamese "Hóa đơn" becomes "Hoa don"); layout, images and
 *   styling are not reproduced. The server endpoint will render the original.
 */
import { ApiError } from "@/lib/api/request";
import type { RenditionBlock } from "@/modules/knowledge/rendition";

export type ExportSource =
  | { kind: "text"; mime_type: string; text: string }
  | { kind: "blocks"; blocks: RenditionBlock[] };

type Table = { columns: string[]; rows: string[][] };

const baseMime = (mime: string) => mime.split(";", 1)[0]!.trim().toLowerCase();
const isCsv = (mime: string) => baseMime(mime) === "text/csv";
const isMarkdownOrPlain = (mime: string) => ["text/markdown", "text/x-markdown", "text/plain"].includes(baseMime(mime));

export function exportBlob(source: ExportSource, format: "csv" | "pdf" | "md", title: string): Blob {
  if (format === "csv") {
    if (source.kind === "text" && isCsv(source.mime_type)) return csvBlob(source.text);
    const tables = source.kind === "text" ? markdownTables(source.text) : blockTables(source.blocks);
    if (tables.length === 0) throw new ApiError("There's no table in this version to export as CSV.", 422);
    return csvBlob(tables.map(tableToCsv).join("\r\n\r\n"));
  }
  const markdown = toMarkdown(source);
  if (format === "md") return new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  return pdfBlob(title, markdownLines(markdown));
}

function toMarkdown(source: ExportSource): string {
  if (source.kind === "blocks") return source.blocks.map(blockMarkdown).filter(Boolean).join("\n\n") + "\n";
  if (isMarkdownOrPlain(source.mime_type)) return source.text;
  if (isCsv(source.mime_type)) {
    const [columns = [], ...rows] = parseCsv(source.text);
    return tableMarkdown({ columns, rows }) + "\n";
  }
  const language = baseMime(source.mime_type).split("/")[1]?.replace(/^x-/, "") ?? "";
  return `\`\`\`${language}\n${source.text}\n\`\`\`\n`;
}

function blockMarkdown(block: RenditionBlock): string {
  switch (block.kind) {
    case "heading":
      return `${"#".repeat(Math.min(Math.max(block.level, 1), 6))} ${block.text}`;
    case "paragraph":
    case "image":
      return block.text;
    case "code":
      return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
    case "link":
      return `[${block.text || block.url}](${block.url})`;
    case "table":
      return [block.caption ? `**${block.caption}**` : "", tableMarkdown(block)].filter(Boolean).join("\n\n");
  }
}

function tableMarkdown({ columns, rows }: Table): string {
  const width = Math.max(columns.length, ...rows.map((row) => row.length), 1);
  const cell = (value: string | undefined) => (value ?? "").replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
  const line = (values: string[]) => `| ${Array.from({ length: width }, (_, index) => cell(values[index])).join(" | ")} |`;
  return [line(columns), `|${" --- |".repeat(width)}`, ...rows.map(line)].join("\n");
}

function blockTables(blocks: RenditionBlock[]): Table[] {
  return blocks.flatMap((block) => {
    if (block.kind !== "table") return [];
    if (block.rows.length < block.total_rows) {
      throw new ApiError("This table is too large to export here. Download the original file instead.", 422);
    }
    return [{ columns: block.columns, rows: block.rows }];
  });
}

/** GitHub-style tables: a header row, a `---` separator row, then body rows. */
function markdownTables(text: string): Table[] {
  const tables: Table[] = [];
  const lines = text.split(/\r?\n/);
  const cells = (line: string) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((value) => value.trim().replaceAll("\\|", "|"));
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const separator = lines[index + 1]!.trim();
    if (!lines[index]!.includes("|") || !/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(separator)) continue;
    const table: Table = { columns: cells(lines[index]!), rows: [] };
    index += 2;
    while (index < lines.length && lines[index]!.includes("|") && lines[index]!.trim()) {
      table.rows.push(cells(lines[index]!));
      index += 1;
    }
    tables.push(table);
  }
  return tables;
}

function tableToCsv({ columns, rows }: Table): string {
  const cell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return [columns, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

/** A byte-order mark lets spreadsheet apps read UTF-8 (accented text) correctly. */
const csvBlob = (csv: string) => new Blob([`\uFEFF${csv.replace(/^\uFEFF/, "")}`], { type: "text/csv;charset=utf-8" });

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(value);
      value = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += character;
  }
  if (value || row.length) rows.push([...row, value]);
  return rows;
}

interface PdfLine {
  text: string;
  bold: boolean;
}

/** Markdown to printable lines: headings bold, table rows as `a | b`, fences dropped. */
function markdownLines(markdown: string): PdfLine[] {
  return markdown.replace(/^\uFEFF/, "").split(/\r?\n/).flatMap((line): PdfLine[] => {
    if (/^\s*```/.test(line) || /^\|?\s*:?-{3,}/.test(line.trim())) return [];
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) return [{ text: heading[1]!, bold: true }];
    const text = line.trim().startsWith("|")
      ? line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()).join("  |  ")
      : line.replaceAll(/\*\*(.+?)\*\*/g, "$1");
    return [{ text, bold: false }];
  });
}

const PAGE = { width: 595, height: 842, margin: 56, leading: 14, size: 10, columns: 95 } as const;

/** WinAnsi bytes for the Unicode punctuation the standard fonts do include. */
const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "™": 0x99,
};

function pdfString(text: string): string {
  let out = "";
  for (const character of text.replaceAll("\t", "    ")) {
    let code = character.codePointAt(0)!;
    if (WIN_ANSI[character]) code = WIN_ANSI[character];
    else if (!(code >= 32 && code <= 126) && !(code >= 160 && code <= 255)) {
      const base = character === "đ" ? "d" : character === "Đ" ? "D" : character.normalize("NFD").replace(/\p{M}/gu, "");
      const baseCode = base.length === 1 ? base.codePointAt(0)! : 63;
      code = (baseCode >= 32 && baseCode <= 126) || (baseCode >= 160 && baseCode <= 255) ? baseCode : 63;
    }
    if (code === 0x28 || code === 0x29 || code === 0x5c) out += `\\${String.fromCharCode(code)}`;
    else if (code >= 32 && code <= 126) out += String.fromCharCode(code);
    else out += `\\${code.toString(8).padStart(3, "0")}`;
  }
  return out;
}

function wrap(line: PdfLine): PdfLine[] {
  if (line.text.length <= PAGE.columns) return [line];
  const wrapped: PdfLine[] = [];
  let rest = line.text;
  while (rest.length > PAGE.columns) {
    const space = rest.lastIndexOf(" ", PAGE.columns);
    const cut = space > PAGE.columns / 2 ? space : PAGE.columns;
    wrapped.push({ text: rest.slice(0, cut), bold: line.bold });
    rest = rest.slice(cut).trimStart();
  }
  wrapped.push({ text: rest, bold: line.bold });
  return wrapped;
}

function pdfBlob(title: string, body: PdfLine[]): Blob {
  const lines = [{ text: title, bold: true }, { text: "", bold: false }, ...body].flatMap(wrap);
  const perPage = Math.floor((PAGE.height - 2 * PAGE.margin) / PAGE.leading);
  const pages: PdfLine[][] = [];
  for (let start = 0; start < lines.length; start += perPage) pages.push(lines.slice(start, start + perPage));
  if (pages.length === 0) pages.push([]);

  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((pageLines, index) => {
    const top = PAGE.height - PAGE.margin;
    const text = pageLines
      .map((line) => `/${line.bold ? "F2" : "F1"} ${PAGE.size} Tf (${pdfString(line.text)}) Tj T*`)
      .join("\n");
    const stream = `BT\n${PAGE.leading} TL\n${PAGE.margin} ${top} Td\n${text}\nET`;
    objects[pageIds[index]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.width} ${PAGE.height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`;
    objects[pageIds[index]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  // Every byte is ASCII (non-ASCII text is octal-escaped), so string length is byte length.
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Blob([pdf], { type: "application/pdf" });
}

/**
 * What `DocumentRenderer` decides before drawing a `ContentNode` — which links may be followed and how a table's
 * rows split into a header and a body — kept apart from React so it runs under `node --test`.
 */

/** Link schemes a document's runs may point to. Anything else (`javascript:`, `data:`, relative paths) is shown as text. */
const SAFE_SCHEMES: Readonly<Record<string, true>> = { "http:": true, "https:": true, "mailto:": true };

/** The URL to link a run to, or `undefined` when it must not be a link. */
export function safeHref(uri: string | undefined | null): string | undefined {
  const value = uri?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return SAFE_SCHEMES[url.protocol] ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export interface TableCell {
  readonly text: string;
  readonly rowSpan?: number;
  readonly colSpan?: number;
  readonly header?: boolean;
}

export interface TableRow {
  readonly cells?: readonly TableCell[];
}

/** One cell as drawn: its text, spans only when they merge cells, and whether it is a header cell. */
export interface LaidCell {
  text: string;
  rowSpan?: number;
  colSpan?: number;
  header: boolean;
}

export interface TableLayout {
  /** Leading rows whose cells are all header cells (`<thead>`). */
  head: LaidCell[][];
  body: LaidCell[][];
  /** Rows of the whole table not in this projection (shown only in the original); 0 when complete. */
  moreRows: number;
}

const span = (value: number | undefined) => (value && Number.isInteger(value) && value > 1 ? value : undefined);

function lay(cell: TableCell): LaidCell {
  const rowSpan = span(cell.rowSpan);
  const colSpan = span(cell.colSpan);
  return { text: cell.text ?? "", header: !!cell.header, ...(rowSpan ? { rowSpan } : {}), ...(colSpan ? { colSpan } : {}) };
}

/** A TABLE node's rows as a header and a body, with how many rows the projection left out. */
export function tableLayout({ rows = [], totalRows }: { rows?: readonly TableRow[]; totalRows?: number }): TableLayout {
  const laid = rows.map((row) => (row.cells ?? []).map(lay));
  let headRows = 0;
  while (headRows < laid.length - 1 && laid[headRows]!.length && laid[headRows]!.every((cell) => cell.header)) headRows++;
  return { head: laid.slice(0, headRows), body: laid.slice(headRows), moreRows: Math.max(0, (totalRows ?? 0) - rows.length) };
}

/** HEADING level → `h2`…`h6` (the page or dialog title is the `h1`). */
export function headingTag(level: number | undefined): "h2" | "h3" | "h4" | "h5" | "h6" {
  const n = Math.min(6, Math.max(2, (level ?? 1) + 1));
  return `h${n}` as "h2" | "h3" | "h4" | "h5" | "h6";
}

/** The part of a `ContentNode` its plain text is read from. */
export interface TextNode {
  readonly runs?: readonly { readonly text: string }[];
  readonly children?: readonly TextNode[];
  readonly rows?: readonly TableRow[];
  readonly caption?: string;
}

/** A block's plain text (runs, list items, table cells, caption), lines joined by "\n" — for comparing versions. */
export function nodeText(node: TextNode): string {
  const lines: string[] = [];
  const runs = (node.runs ?? []).map((run) => run.text).join("");
  if (runs) lines.push(runs);
  for (const row of node.rows ?? []) lines.push((row.cells ?? []).map((cell) => cell.text).join("\t"));
  for (const child of node.children ?? []) lines.push(nodeText(child));
  if (node.caption) lines.push(node.caption);
  return lines.join("\n");
}

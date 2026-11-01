/**
 * What changed between two versions of a file: added and removed blocks of
 * text, and added, changed, moved and removed cells of a sheet.
 */
import { sheetWidth, type Sheet } from "./sheet.ts";

export type BlockStatus = "same" | "added" | "removed";

export interface BlockChange {
  status: BlockStatus;
  text: string;
}

/** Beyond this many comparisons the middle of the file is shown as replaced. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Longest-common-subsequence alignment of two keyed sequences: each element
 * of `before` and `after` appears once, as kept, removed or added, in reading
 * order (removals before the additions that replace them).
 */
export function alignSequences<T>(before: readonly T[], after: readonly T[], key: (value: T) => string) {
  const out: { status: BlockStatus; value: T; beforeIndex: number; afterIndex: number }[] = [];
  let start = 0;
  while (start < before.length && start < after.length && key(before[start]!) === key(after[start]!)) {
    out.push({ status: "same", value: after[start]!, beforeIndex: start, afterIndex: start });
    start += 1;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  const tail: typeof out = [];
  while (endBefore > start && endAfter > start && key(before[endBefore - 1]!) === key(after[endAfter - 1]!)) {
    endBefore -= 1;
    endAfter -= 1;
    tail.unshift({ status: "same", value: after[endAfter]!, beforeIndex: endBefore, afterIndex: endAfter });
  }

  const rows = endBefore - start;
  const columns = endAfter - start;
  if (rows * columns > MAX_LCS_CELLS) {
    for (let index = start; index < endBefore; index += 1) out.push({ status: "removed", value: before[index]!, beforeIndex: index, afterIndex: -1 });
    for (let index = start; index < endAfter; index += 1) out.push({ status: "added", value: after[index]!, beforeIndex: -1, afterIndex: index });
    return [...out, ...tail];
  }

  const beforeKeys = before.slice(start, endBefore).map(key);
  const afterKeys = after.slice(start, endAfter).map(key);
  // lengths[i][j]: LCS of beforeKeys[i..] and afterKeys[j..].
  const lengths = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i]![j] = beforeKeys[i] === afterKeys[j]
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (beforeKeys[i] === afterKeys[j]) {
      out.push({ status: "same", value: after[start + j]!, beforeIndex: start + i, afterIndex: start + j });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      out.push({ status: "removed", value: before[start + i]!, beforeIndex: start + i, afterIndex: -1 });
      i += 1;
    } else {
      out.push({ status: "added", value: after[start + j]!, beforeIndex: -1, afterIndex: start + j });
      j += 1;
    }
  }
  for (; i < rows; i += 1) out.push({ status: "removed", value: before[start + i]!, beforeIndex: start + i, afterIndex: -1 });
  for (; j < columns; j += 1) out.push({ status: "added", value: after[start + j]!, beforeIndex: -1, afterIndex: start + j });
  return [...out, ...tail];
}

/**
 * Markdown split into the blocks a reader sees: paragraphs, headings, single
 * list items, and fenced code or tables kept whole.
 */
export function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence = false;
  const flush = () => {
    if (current.length) blocks.push(current.join("\n"));
    current = [];
  };
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence) flush();
      current.push(line);
      fence = !fence;
      if (!fence) flush();
      continue;
    }
    if (fence) {
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const table = /^\s*\|/.test(line);
    const previousTable = current.length > 0 && /^\s*\|/.test(current.at(-1)!);
    if (/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(line) || table !== previousTable) flush();
    current.push(line);
    // A heading never runs on into the paragraph under it.
    if (/^\s*#{1,6}\s/.test(line)) flush();
  }
  flush();
  return blocks;
}

/**
 * The same block written two ways compares equal: spacing, bullet markers
 * and emphasis markers are not changes a reader would notice.
 */
export function normalizeMarkdownBlock(block: string): string {
  return block
    .replace(/^(\s*)[*+](\s)/gm, "$1-$2")
    .replace(/^(\s*)\d+[.)](\s)/gm, "$11.$2")
    .replaceAll(/__(.+?)__/g, "**$1**")
    .replaceAll(/(^|[^\w*])_(\S.*?\S|\S)_(?!\w)/g, "$1*$2*")
    .replaceAll(/\s+/g, " ")
    .trim();
}

export function diffMarkdown(before: string, after: string): BlockChange[] {
  return alignSequences(markdownBlocks(before), markdownBlocks(after), normalizeMarkdownBlock)
    .map(({ status, value }) => ({ status, text: value }));
}

/** Plain text compared line by line; blank lines carry no change. */
export function diffLines(before: string, after: string): BlockChange[] {
  const lines = (text: string) => text.replaceAll("\r\n", "\n").split("\n").filter((line) => line.trim());
  return alignSequences(lines(before), lines(after), (line) => line.trim())
    .map(({ status, value }) => ({ status, text: value }));
}

/** Already-split text blocks (a rendition's paragraphs, headings and rows). */
export function diffBlocks(before: readonly string[], after: readonly string[]): BlockChange[] {
  return alignSequences(before, after, (block) => block.replaceAll(/\s+/g, " ").trim())
    .map(({ status, value }) => ({ status, text: value }));
}

export function blockChangeCounts(changes: readonly BlockChange[]) {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (change.status === "added") added += 1;
    else if (change.status === "removed") removed += 1;
  }
  return { added, removed };
}

export type CellStatus = "same" | "added" | "changed";

export interface SheetDiffRow {
  /** Spreadsheet row number in the newer version (the header is row 1). */
  number: number;
  status: "same" | "added" | "moved";
  cells: { value: string; status: CellStatus }[];
}

export interface SheetDiff {
  columns: { name: string; status: "same" | "added" }[];
  rows: SheetDiffRow[];
  /** Rows only the older version has, laid out under the newer columns. */
  removedRows: string[][];
  removedColumns: string[];
  counts: {
    addedRows: number;
    removedRows: number;
    movedRows: number;
    changedCells: number;
    addedColumns: number;
    removedColumns: number;
  };
}

/**
 * Compare two versions of one sheet.
 *
 * Columns are matched by header, rows by their first cell (the record's
 * name or id; repeats are told apart by occurrence). A matched row is
 * "moved" when it left the order the two versions share, so a re-sorted
 * sheet is not reported as unchanged.
 */
export function diffSheet(before: Sheet | undefined, after: Sheet): SheetDiff {
  const width = sheetWidth(after);
  const afterColumns = Array.from({ length: width }, (_, index) => after.columns[index] ?? "");
  if (!before) {
    return {
      columns: afterColumns.map((name) => ({ name, status: "added" })),
      rows: after.rows.map((row, index) => ({
        number: index + 2,
        status: "added",
        cells: afterColumns.map((_, column) => ({ value: row[column] ?? "", status: "added" })),
      })),
      removedRows: [],
      removedColumns: [],
      counts: { addedRows: after.rows.length, removedRows: 0, movedRows: 0, changedCells: 0, addedColumns: width, removedColumns: 0 },
    };
  }

  const beforeColumnIndex = new Map<string, number>();
  before.columns.forEach((name, index) => {
    if (!beforeColumnIndex.has(name)) beforeColumnIndex.set(name, index);
  });
  const columnSource = afterColumns.map((name) => beforeColumnIndex.get(name) ?? -1);
  const afterNames = new Set(afterColumns);
  const removedColumns = before.columns.filter((name) => !afterNames.has(name));

  const keyed = (rows: readonly string[][]) => {
    const seen = new Map<string, number>();
    return rows.map((row) => {
      const first = (row[0] ?? "").trim();
      const occurrence = (seen.get(first) ?? 0) + 1;
      seen.set(first, occurrence);
      return `${first}\u0000${occurrence}`;
    });
  };
  const beforeKeys = keyed(before.rows);
  const afterKeys = keyed(after.rows);
  const beforeByKey = new Map(beforeKeys.map((key, index) => [key, index]));
  const afterKeySet = new Set(afterKeys);
  // Rows both versions have, in the order they share; the others moved.
  const sharedBefore = beforeKeys.filter((key) => afterKeySet.has(key));
  const sharedAfter = afterKeys.filter((key) => beforeByKey.has(key));
  const inOrder = new Set(
    alignSequences(sharedBefore, sharedAfter, (key) => key)
      .filter((entry) => entry.status === "same")
      .map((entry) => entry.value),
  );

  let changedCells = 0;
  let addedRows = 0;
  let movedRows = 0;
  const rows: SheetDiffRow[] = after.rows.map((row, index) => {
    const key = afterKeys[index]!;
    const beforeIndex = beforeByKey.get(key);
    if (beforeIndex === undefined) {
      addedRows += 1;
      return {
        number: index + 2,
        status: "added",
        cells: afterColumns.map((_, column) => ({ value: row[column] ?? "", status: "added" })),
      };
    }
    const previous = before.rows[beforeIndex]!;
    const moved = !inOrder.has(key);
    if (moved) movedRows += 1;
    const cells = afterColumns.map((_, column) => {
      const value = row[column] ?? "";
      const source = columnSource[column]!;
      if (source < 0) return { value, status: "added" as const };
      const changed = (previous[source] ?? "") !== value;
      if (changed) changedCells += 1;
      return { value, status: changed ? ("changed" as const) : ("same" as const) };
    });
    return { number: index + 2, status: moved ? "moved" : "same", cells };
  });

  const removedRows = before.rows
    .filter((_, index) => !afterKeySet.has(beforeKeys[index]!))
    .map((row) => columnSource.map((source) => (source < 0 ? "" : row[source] ?? "")));

  const addedColumns = columnSource.filter((source) => source < 0).length;
  return {
    columns: afterColumns.map((name, index) => ({ name, status: columnSource[index]! < 0 ? "added" : "same" })),
    rows,
    removedRows,
    removedColumns,
    counts: {
      addedRows,
      removedRows: removedRows.length,
      movedRows,
      changedCells,
      addedColumns,
      removedColumns: removedColumns.length,
    },
  };
}

export function sheetHasChanges(diff: SheetDiff): boolean {
  return Object.values(diff.counts).some((count) => count > 0);
}

/**
 * Pure interaction rules shared by the UI primitives: menu keyboard
 * navigation, pager arithmetic, row selection, sort cycling and typed
 * confirmation. Kept free of React and the DOM so they can be unit-tested and
 * so every component applies the same rule.
 */

/* ── Menu navigation ─────────────────────────────────────────────── */

/**
 * The item a navigation key moves to, or `null` when the key is not a
 * navigation key. `current` is -1 when no item is focused yet. Arrow keys wrap.
 */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    default:
      return null;
  }
}

/**
 * Type-ahead: the first label after `current` (wrapping) that starts with
 * `query`, case-insensitively. Returns -1 when nothing matches.
 *
 * A repeated single character ("d", "d", "d") cycles through the items that
 * start with it, which is how native menus behave.
 */
export function typeaheadIndex(labels: readonly string[], query: string, current: number): number {
  const needle = query.toLocaleLowerCase();
  if (!needle || !labels.length) return -1;
  const repeated = needle.length > 1 && [...needle].every((char) => char === needle[0]);
  const search = repeated ? needle[0] : needle;
  // A fresh multi-character query may still match the current item; a single
  // character (or a repeat of one) always moves on.
  const from = search.length > 1 ? Math.max(current, 0) : current + 1;
  for (let step = 0; step < labels.length; step += 1) {
    const index = (from + step) % labels.length;
    if (labels[index].trim().toLocaleLowerCase().startsWith(search)) return index;
  }
  return -1;
}

/* ── Pager ───────────────────────────────────────────────────────── */

export interface PagerRange {
  /** At least 1, even for an empty list. */
  pageCount: number;
  /** The requested page clamped into `1…pageCount`. */
  page: number;
  /** Zero-based slice bounds for the current page: `rows.slice(start, end)`. */
  start: number;
  end: number;
  /** One-based, human-readable first and last row numbers ("21–40 of 112"). 0 when empty. */
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export function pagerRange(page: number, pageSize: number, total: number): PagerRange {
  const size = Math.max(1, Math.floor(pageSize));
  const count = Math.max(0, Math.floor(total));
  const pageCount = Math.max(1, Math.ceil(count / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  const end = Math.min(count, start + size);
  return {
    pageCount,
    page: current,
    start,
    end,
    from: count ? start + 1 : 0,
    to: end,
    hasPrevious: current > 1,
    hasNext: current < pageCount,
  };
}

/* ── Row selection ───────────────────────────────────────────────── */

export type SelectionState = "none" | "some" | "all";

/** What the header checkbox shows for the rows currently on screen. */
export function selectionState(
  visibleIds: readonly string[],
  selectedIds: readonly string[],
): SelectionState {
  if (!visibleIds.length) return "none";
  const selected = new Set(selectedIds);
  let count = 0;
  for (const id of visibleIds) if (selected.has(id)) count += 1;
  if (count === 0) return "none";
  return count === visibleIds.length ? "all" : "some";
}

/**
 * The header checkbox: when every visible row is selected it clears them,
 * otherwise it selects them all. Selections outside the visible rows (another
 * page) are kept.
 */
export function toggleAllSelection(
  visibleIds: readonly string[],
  selectedIds: readonly string[],
): string[] {
  if (selectionState(visibleIds, selectedIds) === "all") {
    const visible = new Set(visibleIds);
    return selectedIds.filter((id) => !visible.has(id));
  }
  const next = new Set(selectedIds);
  for (const id of visibleIds) next.add(id);
  return [...next];
}

export function toggleSelection(selectedIds: readonly string[], id: string): string[] {
  return selectedIds.includes(id)
    ? selectedIds.filter((value) => value !== id)
    : [...selectedIds, id];
}

/* ── Sorting ─────────────────────────────────────────────────────── */

export type SortDirection = "asc" | "desc";

export interface SortState {
  columnId: string;
  direction: SortDirection;
}

/** Clicking a header cycles ascending → descending → unsorted; a new column starts ascending. */
export function nextSort(current: SortState | null, columnId: string): SortState | null {
  if (!current || current.columnId !== columnId) return { columnId, direction: "asc" };
  return current.direction === "asc" ? { columnId, direction: "desc" } : null;
}

/** Compares two cell values for sorting: numbers and dates numerically, text naturally. */
export function compareSortValues(left: unknown, right: unknown): number {
  const missingLeft = left === null || left === undefined || left === "";
  const missingRight = right === null || right === undefined || right === "";
  if (missingLeft || missingRight) return missingLeft === missingRight ? 0 : missingLeft ? 1 : -1;
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
}

/* ── Typed confirmation ──────────────────────────────────────────── */

/** A confirmation that asks the user to type a word is satisfied only by that exact text. */
export function isConfirmationSatisfied(required: string | undefined, typed: string): boolean {
  return !required || typed === required;
}

/* ── Identity ────────────────────────────────────────────────────── */

/** Up to two initials: first and last word, ignoring an email domain. */
export function initialsOf(name: string): string {
  const parts = name
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** A stable palette slot for a name, so a person keeps one colour everywhere. */
export function paletteIndex(seed: string, size: number): number {
  let sum = 0;
  for (const char of seed) sum += char.codePointAt(0) ?? 0;
  return size > 0 ? sum % size : 0;
}

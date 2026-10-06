"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, SearchX, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import {
  compareSortValues,
  nextSort,
  pagerRange,
  selectionState,
  type SortState,
  toggleAllSelection,
  toggleSelection,
} from "@/components/ui/interaction";
import { SkeletonRows } from "@/components/ui/Skeleton";
import { cn } from "@/lib/cn";

export type { SortState } from "@/components/ui/interaction";

export interface DataTableColumn<T> {
  id: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  sortable?: boolean;
  /** Value for built-in sorting when `sort` is uncontrolled. Defaults to `row[id]`. */
  sortValue?: (row: T) => unknown;
  /** `right` for numbers (tabular figures). */
  align?: "left" | "right";
  width?: number | string;
  minWidth?: number | string;
  /** Hide the column when the viewport is at or below this width. Detail columns only — never name or status. */
  hideBelow?: 1080 | 900;
  className?: string;
}

export interface DataTablePagination {
  /** One-based. */
  page: number;
  pageSize: number;
  /** Rows across every page. When `data` holds more than one page, the table slices it itself. */
  total: number;
  onPageChange: (page: number) => void;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
}

interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  data: readonly T[];
  /** Accessible name of the table, e.g. "Workspace members". */
  ariaLabel: string;
  /** Defaults to `String(row.id)`. */
  getRowId?: (row: T) => string;

  /** Controlled sort. Omit both to let the table sort `data` itself with each column's `sortValue`. */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;

  /** Adds a checkbox column. Selection is controlled when `selectedIds` is passed. */
  selectable?: boolean;
  selectedIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;
  /** Names a row for its checkbox: "Select {name}". */
  rowLabel?: (row: T) => string;
  /** Actions for the floating bulk bar shown while rows are selected. Use `BulkActionButton`. */
  bulkActions?: (selectedIds: string[]) => React.ReactNode;

  /** Opens a row (Enter on the focused row too). Clicks on controls inside the row are ignored. */
  onRowClick?: (row: T) => void;
  /** Trailing actions, revealed on row hover or focus and always shown on touch screens. */
  rowActions?: (row: T) => React.ReactNode;
  /** The row an open drawer is describing. */
  activeRowId?: string | null;

  pagination?: DataTablePagination;

  /** First load: skeleton rows. A refetch with rows on screen only marks the table busy. */
  loading?: boolean;
  /** The list failed to load. A string is shown as the explanation. */
  error?: boolean | string | null;
  onRetry?: () => void;
  /** Shown when there are no rows and nothing is filtered. */
  emptyState?: React.ReactNode;
  /** A search or filter is narrowing the rows: an empty result is "no matches", not "empty". */
  filtered?: boolean;
  onClearFilters?: () => void;
  /** Replaces the default no-matches state. */
  noResultsState?: React.ReactNode;

  /** Shorter rows. Follows `data-density="compact"` regardless. */
  compact?: boolean;
  className?: string;
}

const hideClass = {
  1080: "max-[1080px]:hidden",
  900: "max-[900px]:hidden",
} as const;

const INTERACTIVE = "a,button,input,select,textarea,label,[role='menuitem'],[role='checkbox'],[role='switch']";

function defaultRowId(row: object) {
  return String((row as { id?: unknown }).id);
}

/**
 * The one table for lists of records: sortable headers, selection with a bulk
 * bar, a pager, hover-revealed row actions, and every list state — loading,
 * empty, no matches and failed. Detail columns drop out at 1080 px and 900 px.
 */
export function DataTable<T extends object>({
  columns,
  data,
  ariaLabel,
  getRowId = defaultRowId,
  sort: controlledSort,
  onSortChange,
  selectable = false,
  selectedIds: controlledSelected,
  onSelectionChange,
  rowLabel,
  bulkActions,
  onRowClick,
  rowActions,
  activeRowId,
  pagination,
  loading = false,
  error,
  onRetry,
  emptyState,
  filtered = false,
  onClearFilters,
  noResultsState,
  compact = false,
  className,
}: DataTableProps<T>) {
  const [internalSort, setInternalSort] = useState<SortState | null>(null);
  const [internalSelected, setInternalSelected] = useState<string[]>([]);
  const sortControlled = controlledSort !== undefined;
  const sort = sortControlled ? controlledSort : internalSort;
  const selected = controlledSelected ?? internalSelected;

  const setSort = (next: SortState | null) => {
    if (!sortControlled) setInternalSort(next);
    onSortChange?.(next);
  };
  const setSelected = (ids: string[]) => {
    if (controlledSelected === undefined) setInternalSelected(ids);
    onSelectionChange?.(ids);
  };

  const sorted = useMemo(() => {
    if (sortControlled || !sort) return data;
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    if (!column) return data;
    const value = column.sortValue ?? ((row: T) => (row as Record<string, unknown>)[column.id]);
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...data].sort((left, right) => direction * compareSortValues(value(left), value(right)));
  }, [columns, data, sort, sortControlled]);

  const range = pagination ? pagerRange(pagination.page, pagination.pageSize, pagination.total) : null;
  const rows = range && sorted.length > pagination!.pageSize ? sorted.slice(range.start, range.end) : sorted;
  const visibleIds = rows.map(getRowId);
  const headerSelection = selectionState(visibleIds, selected);

  if (error && !rows.length) {
    return (
      <ErrorState
        className={className}
        description={typeof error === "string" ? error : undefined}
        onAction={onRetry}
      />
    );
  }

  if (loading && !rows.length) {
    return <SkeletonRows className={className} columns={columns.length} label={`Loading ${ariaLabel.toLowerCase()}`} rows={pagination?.pageSize ? Math.min(pagination.pageSize, 8) : 6} />;
  }

  if (!rows.length) {
    if (filtered) {
      return (
        <div className={className}>
          {noResultsState ?? (
            <EmptyState
              action={
                onClearFilters && (
                  <Button onClick={onClearFilters} variant="secondary">
                    Clear filters
                  </Button>
                )
              }
              boxed
              description="Try a different search or fewer filters."
              icon={<SearchX />}
              size="md"
              title="No matches"
            />
          )}
        </div>
      );
    }
    return <div className={className}>{emptyState}</div>;
  }

  const cellPadding = compact ? "h-[46px] py-2" : "h-[var(--table-row-height)] py-[var(--table-cell-py)]";

  return (
    <div className={className}>
      <div
        aria-busy={loading || undefined}
        className="overflow-auto rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]"
      >
        <table aria-label={ariaLabel} className="w-full border-separate border-spacing-0 text-[length:var(--text-size-body)]">
          <thead>
            <tr>
              {selectable && (
                <th className={cn(headClass, "w-11 pr-0")} scope="col">
                  <Checkbox
                    className="align-middle"
                    aria-label="Select all rows on this page"
                    checked={headerSelection === "all"}
                    indeterminate={headerSelection === "some"}
                    onCheckedChange={() => setSelected(toggleAllSelection(visibleIds, selected))}
                  />
                </th>
              )}
              {columns.map((column) => {
                const direction = sort?.columnId === column.id ? sort.direction : null;
                return (
                  <th
                    aria-sort={direction ? (direction === "asc" ? "ascending" : "descending") : undefined}
                    className={cn(
                      headClass,
                      column.align === "right" && "text-right",
                      column.hideBelow && hideClass[column.hideBelow],
                      column.className,
                    )}
                    key={column.id}
                    scope="col"
                    style={{ width: column.width, minWidth: column.minWidth }}
                  >
                    {column.sortable ? (
                      <button
                        className={cn(
                          "inline-flex items-center gap-1 rounded-[var(--radius-xs)] font-[inherit] text-inherit transition-colors duration-[var(--duration-fast)]",
                          "hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
                          column.align === "right" && "flex-row-reverse",
                          direction && "text-[var(--text-primary)]",
                        )}
                        onClick={() => setSort(nextSort(sort, column.id))}
                        type="button"
                      >
                        {column.header}
                        {direction === "asc" ? (
                          <ArrowUp aria-hidden="true" className="h-[13px] w-[13px]" />
                        ) : direction === "desc" ? (
                          <ArrowDown aria-hidden="true" className="h-[13px] w-[13px]" />
                        ) : (
                          <ChevronsUpDown aria-hidden="true" className="h-[13px] w-[13px] opacity-50" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
              {rowActions && (
                <th className={cn(headClass, "w-14")} scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const id = getRowId(row);
              const isSelected = selected.includes(id);
              const isActive = id === activeRowId;
              return (
                <tr
                  aria-current={isActive ? "true" : undefined}
                  aria-selected={selectable ? isSelected : undefined}
                  className={cn(
                    "group/row [&:last-child>td]:border-b-0",
                    onRowClick && "cursor-pointer [&:hover>td]:bg-[var(--surface-subtle)] focus-visible:outline-none [&:focus-visible>td]:bg-[var(--surface-subtle)] focus-visible:shadow-[inset_0_0_0_2px_var(--focus-ring)]",
                    (isSelected || isActive) && "[&>td]:bg-[var(--surface-selected)] [&:hover>td]:bg-[var(--surface-selected)]",
                  )}
                  key={id}
                  onClick={
                    onRowClick
                      ? (event) => {
                          if ((event.target as HTMLElement).closest(INTERACTIVE)) return;
                          onRowClick(row);
                        }
                      : undefined
                  }
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.target !== event.currentTarget) return;
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          onRowClick(row);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {selectable && (
                    <td className={cn(bodyCellClass, cellPadding, "w-11 pr-0")}>
                      <Checkbox
                        className="align-middle"
                        aria-label={rowLabel ? `Select ${rowLabel(row)}` : "Select row"}
                        checked={isSelected}
                        onCheckedChange={() => setSelected(toggleSelection(selected, id))}
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      className={cn(
                        bodyCellClass,
                        cellPadding,
                        column.align === "right" && "text-right tabular-nums",
                        column.hideBelow && hideClass[column.hideBelow],
                        column.className,
                      )}
                      key={column.id}
                      style={{ width: column.width, minWidth: column.minWidth }}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                  {rowActions && (
                    <td className={cn(bodyCellClass, cellPadding, "w-14 text-right")}>
                      <div
                        className={cn(
                          "inline-flex items-center justify-end gap-1 opacity-0 transition-opacity duration-[var(--duration-fast)]",
                          "group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100",
                          isActive && "opacity-100",
                        )}
                      >
                        {rowActions(row)}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pagination && range && (pagination.total > pagination.pageSize || pagination.pageSizeOptions) && (
        <nav
          aria-label={`${ariaLabel} pages`}
          className="flex flex-wrap items-center justify-between gap-3 px-1 pt-2.5 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]"
        >
          <span className="tabular-nums">
            {range.from.toLocaleString()}–{range.to.toLocaleString()} of {pagination.total.toLocaleString()}
          </span>
          <div className="flex items-center gap-2">
            {pagination.pageSizeOptions && pagination.onPageSizeChange && (
              <label className="inline-flex items-center gap-2">
                Rows per page
                <select
                  className="h-[var(--control-sm)] rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--surface-base)] px-2 text-[length:var(--text-size-meta)] text-[var(--text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  onChange={(event) => pagination.onPageSizeChange?.(Number(event.target.value))}
                  value={pagination.pageSize}
                >
                  {pagination.pageSizeOptions.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button
              disabled={!range.hasPrevious}
              icon={<ChevronLeft aria-hidden="true" className="h-4 w-4" />}
              onClick={() => pagination.onPageChange(range.page - 1)}
              size="sm"
              variant="secondary"
            >
              Previous
            </Button>
            <Button
              disabled={!range.hasNext}
              iconAfter={<ChevronRight aria-hidden="true" className="h-4 w-4" />}
              onClick={() => pagination.onPageChange(range.page + 1)}
              size="sm"
              variant="secondary"
            >
              Next
            </Button>
          </div>
        </nav>
      )}
      {selectable && bulkActions && selected.length > 0 && (
        <div
          aria-label="Bulk actions"
          className={cn(
            "sticky bottom-4 z-[5] mx-auto mt-3 flex w-max max-w-full items-center gap-1.5 rounded-[var(--radius-lg)] py-1.5 pl-3.5 pr-1.5",
            "bg-[var(--surface-inverse)] text-[length:var(--text-size-body)] text-[var(--text-inverse)] shadow-[var(--shadow-pop)] motion-safe:animate-ui-pop",
          )}
          role="toolbar"
        >
          <span aria-live="polite" className="mr-1.5 whitespace-nowrap font-semibold tabular-nums">
            {selected.length.toLocaleString()} selected
          </span>
          {bulkActions([...selected])}
          <BulkActionButton aria-label="Clear selection" icon={<X />} onClick={() => setSelected([])} />
        </div>
      )}
    </div>
  );
}

const headClass = cn(
  "sticky top-0 z-[1] h-[var(--table-head-height)] whitespace-nowrap border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] px-3 text-left",
  "text-[length:var(--text-size-meta)] font-medium text-[var(--text-tertiary)]",
);

const bodyCellClass = "border-b border-[var(--border-subtle)] px-3 align-middle";

/** A quiet button for the bulk bar, readable on its inverse background. Icon-only needs `aria-label`. */
export function BulkActionButton({
  icon,
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) {
  return (
    <button
      className={cn(
        "inline-flex h-[var(--control-sm)] items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 font-medium text-inherit opacity-85",
        "transition-[background-color,opacity] duration-[var(--duration-fast)] hover:bg-[var(--surface-inverse-hover)] hover:opacity-100",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-45",
        "[&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0",
        !children && "w-[var(--control-sm)] justify-center px-0",
        className,
      )}
      type="button"
      {...props}
    >
      {icon && <span aria-hidden="true" className="inline-flex">{icon}</span>}
      {children}
    </button>
  );
}

/** Primary cell content: a name with one line of supporting detail. */
export function CellTitle({
  title,
  subtitle,
  icon,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {icon}
      <span className="min-w-0">
        <span className="block max-w-[420px] truncate font-medium text-[var(--text-primary)]">{title}</span>
        {subtitle && (
          <span className="mt-px block truncate text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
            {subtitle}
          </span>
        )}
      </span>
    </div>
  );
}

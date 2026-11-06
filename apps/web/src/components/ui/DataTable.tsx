"use client";

import { Checkbox, Dropdown, Label, Table } from "@heroui/react";
import type { Selection, SortDescriptor } from "@heroui/react";
import { ArrowUp, ChevronsUpDown, MoreHorizontal, X, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import { useMemo, useState, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export interface DataTableColumn<T> {
  /** Stable column id (also the sort key). */
  id: string;
  /** Header label (a node for visually hidden headers, e.g. `<span className="sr-only">Actions</span>`). */
  header: ReactNode;
  /** Cell content for a row. */
  cell: (row: T) => ReactNode;
  /**
   * Makes the column sortable. With client-side sorting (no `onSortChange`) the rows are
   * ordered by this value; with server-side sorting any function enables the header.
   */
  sortValue?: (row: T) => string | number | boolean | null | undefined;
  /** Right-align (numbers). */
  align?: "start" | "end";
  /** The row's main cell: row header, and the title of the card row below 760 px. Defaults to the first column. */
  primary?: boolean;
  /** Hide in the card-row layout (< 760 px). */
  hideOnMobile?: boolean;
  /** Prefix shown before the value in the card-row layout ("Updated"). */
  mobileLabel?: string;
  /** Column width: px, percentage or fraction (`120`, `"30%"`, `"2fr"`). */
  width?: number | `${number}%` | `${number}fr`;
  className?: string;
}

/** One entry of a row's ⋯ menu. */
export interface RowAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Destructive entry (red); confirm it in `onAction`. */
  danger?: boolean;
  isDisabled?: boolean;
  onAction: () => void;
}

export interface DataTableSort {
  column: string;
  direction: "ascending" | "descending";
}

export interface DataTableProps<T> {
  /** Accessible name of the table. */
  label: string;
  rows: readonly T[];
  columns: readonly DataTableColumn<T>[];
  getRowId: (row: T) => string;
  /** Controlled sort. Omit with `onSortChange` to sort client-side (initially by `defaultSort`). */
  sort?: DataTableSort | null;
  /** Server-side sorting: receive header clicks; `rows` must arrive sorted. */
  onSortChange?: (sort: DataTableSort) => void;
  defaultSort?: DataTableSort;
  /** Enables row checkboxes; controlled selection. */
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  /**
   * Human name of a row for its checkbox ("Select <name>"). Defaults to the primary column's `sortValue`
   * when that is a string, else "row <n>".
   */
  rowLabel?: (row: T) => string;
  /** Floating bulk bar content while rows are selected (buttons acting on `ids`). */
  bulkActions?: (ids: string[], clear: () => void) => ReactNode;
  /** Row ⋯ menu entries (hide what the caller can't do: return only allowed actions). */
  rowActions?: (row: T) => readonly RowAction[];
  /** Inline action before the ⋯ menu (preview "Sync now" / "Reconnect" beside the menu). */
  rowActionLead?: (row: T) => ReactNode;
  /** Extra class on the actions cells (page CSS such as `src-actions`). */
  actionsClassName?: string;
  /** Whole-row activation (open a drawer). */
  onRowAction?: (row: T) => void;
  /** Whole-row link (navigates on activation). */
  rowHref?: (row: T) => string;
  /** Rendered in the body when `rows` is empty. */
  emptyContent?: ReactNode;
  /** Card rows below 760 px (default true). */
  stack?: boolean;
  /** Footer under the table surface, usually `<Pager/>`. */
  footer?: ReactNode;
  className?: string;
  /** Extra class per row (e.g. `table__row--new` to flash freshly added rows). */
  rowClassName?: (row: T) => string | undefined;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return Number(a) - Number(b);
}

function SelectionCheckbox({ label }: { label: string }) {
  return (
    <Checkbox aria-label={label} slot="selection">
      <Checkbox.Content>
        <Checkbox.Control>
          <Checkbox.Indicator />
        </Checkbox.Control>
      </Checkbox.Content>
    </Checkbox>
  );
}

/**
 * Data table (preview `table()` + `sortHead`/`selCheck`/`bulkBar`/`pager`, HeroUI Table primary variant):
 * sortable headers, row selection with a floating bulk bar, row ⋯ actions, whole-row activation,
 * and card rows below 760 px (primary cell · actions, other cells wrap underneath as metadata).
 */
export function DataTable<T>({
  label,
  rows,
  columns,
  getRowId,
  sort,
  onSortChange,
  defaultSort,
  selectedIds,
  onSelectionChange,
  rowLabel,
  bulkActions,
  rowActions,
  rowActionLead,
  actionsClassName,
  onRowAction,
  rowHref,
  emptyContent,
  stack = true,
  footer,
  className,
  rowClassName,
}: DataTableProps<T>) {
  const [localSort, setLocalSort] = useState<DataTableSort | null>(defaultSort ?? null);
  const activeSort = sort !== undefined ? sort : localSort;
  const primaryId = (columns.find((c) => c.primary) ?? columns[0])?.id;
  const selectable = Boolean(onSelectionChange);

  const ordered = useMemo(() => {
    if (onSortChange || !activeSort) return rows;
    const column = columns.find((c) => c.id === activeSort.column);
    if (!column?.sortValue) return rows;
    const value = column.sortValue;
    const sign = activeSort.direction === "ascending" ? 1 : -1;
    return [...rows].sort((a, b) => sign * compare(value(a), value(b)));
  }, [rows, columns, activeSort, onSortChange]);

  const byId = useMemo(() => new Map(ordered.map((row) => [getRowId(row), row])), [ordered, getRowId]);
  const primarySort = columns.find((c) => c.id === primaryId)?.sortValue;
  const nameOf = (row: T, index: number): string => {
    const name = rowLabel?.(row) ?? primarySort?.(row);
    return typeof name === "string" && name.trim() ? name.trim() : `row ${index + 1}`;
  };
  const selected = selectedIds ?? new Set<string>();
  const clear = () => onSelectionChange?.(new Set());

  const handleSort = (descriptor: SortDescriptor) => {
    const next: DataTableSort = { column: String(descriptor.column), direction: descriptor.direction };
    if (onSortChange) onSortChange(next);
    else setLocalSort(next);
  };
  const handleSelection = (keys: Selection) => {
    onSelectionChange?.(keys === "all" ? new Set(byId.keys()) : new Set([...keys].map(String)));
  };
  const handleRowAction = onRowAction
    ? (key: string | number) => {
        const row = byId.get(String(key));
        if (row) onRowAction(row);
      }
    : undefined;

  return (
    <div className={clsx("data-table", className)}>
      <Table className={clsx(stack && "table--stack")}>
        <Table.ScrollContainer>
          <Table.Content
            aria-label={label}
            sortDescriptor={activeSort ?? undefined}
            onSortChange={handleSort}
            selectionMode={selectable ? "multiple" : "none"}
            selectionBehavior="toggle"
            selectedKeys={selectable ? selected : undefined}
            onSelectionChange={selectable ? handleSelection : undefined}
            onRowAction={handleRowAction}
          >
            <Table.Header>
              {selectable ? (
                <Table.Column className="table__column--check">
                  <SelectionCheckbox label="Select all" />
                </Table.Column>
              ) : null}
              {columns.map((column) => (
                <Table.Column
                  key={column.id}
                  id={column.id}
                  isRowHeader={column.id === primaryId}
                  allowsSorting={Boolean(column.sortValue)}
                  width={column.width}
                  className={clsx(column.align === "end" && "table__column--num", column.className)}
                >
                  {({ sortDirection }) =>
                    column.sortValue ? (
                      <Table.SortableColumnHeader className="table__sort" sortDirection={sortDirection} indicator={<ArrowUp className="i" aria-hidden />}>
                        {column.header}
                        {sortDirection ? null : <ChevronsUpDown className="i table__sort-idle" aria-hidden />}
                      </Table.SortableColumnHeader>
                    ) : (
                      column.header
                    )
                  }
                </Table.Column>
              ))}
              {rowActions || rowActionLead ? (
                <Table.Column className="table__column--actions">
                  <span className="sr-only">Actions</span>
                </Table.Column>
              ) : null}
            </Table.Header>
            <Table.Body renderEmptyState={emptyContent ? () => emptyContent : undefined}>
              {ordered.map((row, index) => {
                const id = getRowId(row);
                const actions = rowActions?.(row) ?? [];
                const lead = rowActionLead?.(row);
                return (
                  <Table.Row key={id} id={id} href={rowHref?.(row)} className={clsx((onRowAction || rowHref) && "table__row--action", rowClassName?.(row))}>
                    {selectable ? (
                      <Table.Cell className="table__cell--check">
                        <SelectionCheckbox label={`Select ${nameOf(row, index)}`} />
                      </Table.Cell>
                    ) : null}
                    {columns.map((column) => (
                      <Table.Cell
                        key={column.id}
                        data-label={column.mobileLabel}
                        className={clsx(
                          column.id === primaryId && "table__cell--primary",
                          column.align === "end" && "table__cell--num",
                          column.hideOnMobile && "table__cell--hide-sm",
                          column.className,
                        )}
                      >
                        {column.cell(row)}
                      </Table.Cell>
                    ))}
                    {rowActions || rowActionLead ? (
                      <Table.Cell className={clsx("table__cell--actions", actionsClassName)}>
                        {lead ? (
                          <div className="row gap-4">
                            {lead}
                            {actions.length ? <RowMenu actions={actions} /> : null}
                          </div>
                        ) : actions.length ? (
                          <RowMenu actions={actions} />
                        ) : null}
                      </Table.Cell>
                    ) : null}
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {footer}
      {selectable && bulkActions && selected.size > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="bulk-bar__count">{selected.size} selected</span>
          {bulkActions([...selected], clear)}
          <IconButton icon={X} tip="Clear selection" size="sm" onPress={clear} />
        </div>
      ) : null}
    </div>
  );
}

function RowMenu({ actions }: { actions: readonly RowAction[] }) {
  return (
    <Dropdown>
      <IconButton icon={MoreHorizontal} tip="More actions" size="sm" showTip={false} />
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label="Row actions" onAction={(key) => actions.find((a) => a.id === key)?.onAction()} disabledKeys={actions.filter((a) => a.isDisabled).map((a) => a.id)}>
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <Dropdown.Item key={action.id} id={action.id} textValue={action.label} variant={action.danger ? "danger" : "default"}>
                {Icon ? <Icon className="i" aria-hidden /> : null}
                <Label>{action.label}</Label>
              </Dropdown.Item>
            );
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

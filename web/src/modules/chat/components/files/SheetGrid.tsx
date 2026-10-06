"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Callout } from "@/components/ui/Callout";
import { cn } from "@/lib/cn";

import { diffSheet, type SheetDiff } from "./diff";
import { columnLetter, sheetWidth, type Sheet } from "./sheet";

/** Rows laid out at once; a longer sheet says how many more there are. */
const MAX_ROWS = 500;
const NUMERIC = /^-?[$€£¥]?\s?\d[\d,.]*\s?%?$/;

const cellBase = "h-7 whitespace-nowrap border-b border-r border-border-subtle px-[9px] py-[5px] text-left";
const headBase = "bg-surface-subtle font-mono text-[length:var(--text-size-caption)] font-medium text-text-tertiary";
const changeTone = {
  added: "bg-status-success-bg",
  changed: "bg-status-info-bg",
  removed: "bg-status-danger-bg text-status-danger-text line-through",
} as const;

function SheetTabs({ sheets, active, onChange }: { sheets: readonly Sheet[]; active: number; onChange: (index: number) => void }) {
  if (sheets.length < 2) return null;
  return (
    <div
      aria-label="Sheets"
      className="sticky top-0 z-[3] flex gap-0.5 overflow-x-auto border-b border-border-subtle bg-surface-base px-3 pt-2"
      role="tablist"
    >
      {sheets.map((sheet, index) => (
        <button
          aria-selected={index === active}
          className={cn(
            "-mb-px h-[30px] shrink-0 rounded-t-[7px] border border-transparent px-3 text-[12.5px] font-medium text-text-secondary",
            "hover:text-text-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)",
            index === active && "border-border-subtle border-b-surface-subtle bg-surface-subtle text-text-primary",
          )}
          key={`${sheet.name}-${index}`}
          onClick={() => onChange(index)}
          role="tab"
          type="button"
        >
          {sheet.name}
        </button>
      ))}
    </div>
  );
}

function plural(count: number, noun: string) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * A spreadsheet version: sheet tabs, a value bar showing the selected cell's
 * address and full value, and the grid with spreadsheet column letters and
 * row numbers. Arrow keys move the selection.
 */
export function SheetGrid({ sheets, truncated, title }: { sheets: readonly Sheet[]; truncated: boolean; title: string }) {
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  const idBase = useId();
  const index = Math.min(active, sheets.length - 1);
  const sheet = sheets[index];
  if (!sheet) return <EmptySheet />;

  const width = sheetWidth(sheet);
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const valueOf = (row: number, column: number) => (row === 0 ? sheet.columns[column] : sheet.rows[row - 1]?.[column]) ?? "";
  const cellId = (row: number, column: number) => `${idBase}-${row}-${column}`;

  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    const current = selected ?? { row: 0, column: 0 };
    const next = {
      row: Math.min(Math.max(current.row + (selected ? step[0] : 0), 0), rows.length),
      column: Math.min(Math.max(current.column + (selected ? step[1] : 0), 0), width - 1),
    };
    setSelected(next);
    document.getElementById(cellId(next.row, next.column))?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  return (
    <div>
      <SheetTabs
        active={index}
        onChange={(next) => {
          setActive(next);
          setSelected(null);
        }}
        sheets={sheets}
      />
      <div
        className={cn(
          "sticky z-[3] flex items-center gap-2.5 border-b border-border-subtle bg-surface-base px-3 py-1.5 text-[12.5px]",
          sheets.length > 1 ? "top-[39px]" : "top-0",
        )}
      >
        <span className="min-w-9 font-mono text-[12px] font-semibold text-text-tertiary">
          {selected ? `${columnLetter(selected.column)}${selected.row + 1}` : ""}
        </span>
        <span aria-live="polite" className="min-w-0 truncate text-text-primary">
          {selected ? valueOf(selected.row, selected.column) || <span className="text-text-tertiary">Empty cell</span> : (
            <span className="text-text-tertiary">Select a cell to see its value</span>
          )}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-text-tertiary">
          {plural(sheet.totalRows, "row")} · {plural(width, "column")}
        </span>
      </div>
      <SheetNotes shown={rows.length} sheet={sheet} truncated={truncated} />
      <div
        aria-activedescendant={selected ? cellId(selected.row, selected.column) : undefined}
        aria-label={`${title}, ${sheet.name}`}
        className="overflow-auto p-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
        onKeyDown={move}
        role="grid"
        tabIndex={0}
      >
        <table className="border-separate border-spacing-0 overflow-hidden rounded-[6px] bg-surface-base text-[12.5px] shadow-[0_0_0_1px_var(--border-subtle)]">
          <thead>
            <tr>
              <th aria-hidden="true" className={cn(cellBase, headBase)} />
              {Array.from({ length: width }, (_, column) => (
                <th className={cn(cellBase, headBase, "text-center")} key={column} scope="col">
                  {columnLetter(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[sheet.columns, ...rows].map((values, row) => (
              <tr key={row}>
                <th className={cn(cellBase, headBase, "w-[34px] text-right")} scope="row">{row + 1}</th>
                {Array.from({ length: width }, (_, column) => {
                  const value = values[column] ?? "";
                  const isSelected = selected?.row === row && selected.column === column;
                  return (
                    <td
                      aria-selected={isSelected}
                      className={cn(
                        cellBase,
                        "cursor-cell",
                        row === 0 && "font-semibold",
                        row > 0 && NUMERIC.test(value.trim()) && "text-right tabular-nums",
                        isSelected && "shadow-[inset_0_0_0_2px_var(--accent-primary)]",
                      )}
                      id={cellId(row, column)}
                      key={column}
                      onClick={() => setSelected({ row, column })}
                      role="gridcell"
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SheetNotes({ sheet, shown, truncated }: { sheet: Sheet; shown: number; truncated: boolean }) {
  if (shown >= sheet.totalRows && !truncated) return null;
  return (
    <div className="px-3 pt-3">
      <Callout tone="neutral">
        {shown < sheet.totalRows
          ? `Showing the first ${shown.toLocaleString()} of ${sheet.totalRows.toLocaleString()} rows. Download the file to see the rest.`
          : "Only the first part of this file can be shown here. Download it to see the rest."}
      </Callout>
    </div>
  );
}

function EmptySheet() {
  return <p className="p-6 text-center text-[13px] text-text-tertiary">This spreadsheet has no tables to show.</p>;
}

/** Changes between two versions of a spreadsheet, sheet by sheet. */
export function SheetChanges({ before, after }: { before: readonly Sheet[]; after: readonly Sheet[] }) {
  const [active, setActive] = useState(0);
  const index = Math.min(active, after.length - 1);
  const sheet = after[index];
  const diff = useMemo<SheetDiff | null>(() => {
    if (!sheet) return null;
    const previous = before.find((candidate) => candidate.name === sheet.name) ?? before[index];
    return diffSheet(previous, sheet);
  }, [before, index, sheet]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // A change past the right edge is what the person came for: bring the first one into view.
  useEffect(() => {
    const box = scrollRef.current;
    const first = box?.querySelector<HTMLElement>("[data-change]");
    if (!box || !first) return;
    const right = first.offsetLeft + first.offsetWidth + 24;
    if (right > box.clientWidth) box.scrollLeft = right - box.clientWidth;
  }, [diff]);
  if (!sheet || !diff) return <EmptySheet />;

  const rows = diff.rows.slice(0, MAX_ROWS);
  return (
    <div>
      <SheetTabs active={index} onChange={setActive} sheets={after} />
      {diff.removedColumns.length > 0 && (
        <p className="px-4 pt-3 text-[12.5px] text-status-danger-text">
          {diff.removedColumns.length === 1 ? "Removed column" : "Removed columns"}: {diff.removedColumns.join(", ")}
        </p>
      )}
      <div className="overflow-auto p-3" ref={scrollRef}>
        <table className="border-separate border-spacing-0 overflow-hidden rounded-[6px] bg-surface-base text-[12.5px] shadow-[0_0_0_1px_var(--border-subtle)]">
          <thead>
            <tr>
              <th aria-hidden="true" className={cn(cellBase, headBase)} />
              {diff.columns.map((column, position) => (
                <th
                  className={cn(cellBase, headBase, "text-center", column.status === "added" && "bg-status-success-bg text-status-success-text")}
                  data-change={column.status === "added" ? "added" : undefined}
                  key={position}
                  scope="col"
                >
                  {columnLetter(position)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th className={cn(cellBase, headBase, "w-[34px] text-right")} scope="row">1</th>
              {diff.columns.map((column, position) => (
                <td
                  className={cn(cellBase, "font-semibold", column.status === "added" && "bg-status-success-bg text-status-success-text")}
                  key={position}
                >
                  {column.name}
                </td>
              ))}
            </tr>
            {rows.map((row) => (
              <tr key={row.number}>
                <th className={cn(cellBase, headBase, "w-[34px] text-right")} scope="row">{row.number}</th>
                {row.cells.map((cell, position) => {
                  const status = row.status === "moved" && position === 0 ? "changed" : cell.status;
                  return (
                    <td
                      className={cn(
                        cellBase,
                        NUMERIC.test(cell.value.trim()) && "text-right tabular-nums",
                        status !== "same" && changeTone[status],
                      )}
                      data-change={status === "changed" ? status : undefined}
                      key={position}
                      title={row.status === "moved" && position === 0 ? "Moved" : undefined}
                    >
                      {cell.value}
                    </td>
                  );
                })}
              </tr>
            ))}
            {diff.removedRows.map((values, position) => (
              <tr aria-label="Removed row" key={`removed-${position}`}>
                <th className={cn(cellBase, headBase, "w-[34px] text-right")} scope="row">–</th>
                {values.map((value, column) => (
                  <td className={cn(cellBase, changeTone.removed)} key={column}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** "2 rows added · 1 column added", for the legend line. */
export function sheetChangeSummary(diffs: readonly SheetDiff[]): string {
  const total = { addedRows: 0, removedRows: 0, movedRows: 0, changedCells: 0, addedColumns: 0, removedColumns: 0 };
  for (const diff of diffs) for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += diff.counts[key];
  return [
    total.addedColumns && `${plural(total.addedColumns, "column")} added`,
    total.removedColumns && `${plural(total.removedColumns, "column")} removed`,
    total.addedRows && `${plural(total.addedRows, "row")} added`,
    total.removedRows && `${plural(total.removedRows, "row")} removed`,
    total.movedRows && `${plural(total.movedRows, "row")} moved`,
    total.changedCells && `${plural(total.changedCells, "cell")} changed`,
  ].filter(Boolean).join(" · ");
}

"use client";

import { Button, Input } from "@heroui/react";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";

import { plural } from "@/lib/format";

import { diffSheet } from "../diff";
import { isNumeric } from "../model";
import { columnLetter, sheetWidth, type Sheet } from "../sheet";

export interface CellRef {
  /** 0 = header row (row 1); value rows start at 1. */
  r: number;
  c: number;
}

export interface SheetViewProps {
  sheets: readonly Sheet[];
  sheetIndex: number;
  onSheetChange: (index: number) => void;
  /** Compare against this version's sheets (Changes tab). */
  previous?: readonly Sheet[];
  selected?: CellRef | null;
  onSelect?: (cell: CellRef | null) => void;
  /** The latest CSV version, not while the assistant writes: the selected cell can be edited. */
  editable?: boolean;
  /** Save a cell's new value (a new version). */
  onSaveCell?: (cell: CellRef, value: string) => void;
  isSaving?: boolean;
}

/** A sheet as a grid (preview `sheetHtml`): sheet tabs, formula bar, letters, row numbers, change marks. */
export function SheetView({ sheets, sheetIndex, onSheetChange, previous, selected, onSelect, editable, onSaveCell, isSaving }: SheetViewProps) {
  const si = Math.min(sheetIndex, sheets.length - 1);
  const sheet = sheets[si]!;
  const diffMode = !!previous;
  const before = previous?.find((s) => s.name === sheet.name) ?? (previous && previous.length === 1 && sheets.length === 1 ? previous[0] : undefined);
  const diff = useMemo(() => (diffMode ? diffSheet(before, sheet) : null), [before, diffMode, sheet]);
  const width = sheetWidth(sheet);
  const columns = Array.from({ length: width }, (_, i) => sheet.columns[i] ?? "");
  const gridRef = useRef<HTMLDivElement>(null);

  // Bring the first added/changed column into view once per comparison (preview `after`).
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !diff) return;
    const cell = grid.querySelector<HTMLElement>("thead th.is-add, td.is-chg");
    if (cell) grid.scrollLeft = Math.max(0, cell.offsetLeft - grid.clientWidth + cell.offsetWidth + 24);
  }, [diff]);

  const sel = !diffMode && selected ? selected : null;
  const value = sel ? (sel.r === 0 ? columns[sel.c] : sheet.rows[sel.r - 1]?.[sel.c]) ?? "" : "";

  return (
    <>
      {sheets.length > 1 ? (
        <div className="wk-sheet-tabs" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button key={`${s.name}-${i}`} type="button" role="tab" aria-selected={i === si} onClick={() => onSheetChange(i)}>
              {s.name}
            </button>
          ))}
        </div>
      ) : null}
      {diffMode ? null : (
        <FormulaBar
          key={sel ? `${si}:${sel.r}:${sel.c}` : "none"}
          refLabel={sel ? `${columnLetter(sel.c)}${sel.r + 1}` : ""}
          value={value}
          hasSelection={!!sel}
          editable={!!editable}
          isSaving={isSaving}
          counts={`${plural(sheet.rows.length, "row")} · ${plural(width, "column")}`}
          onSave={(next) => sel && onSaveCell?.(sel, next)}
        />
      )}
      <div className="wk-grid" ref={gridRef}>
        <table>
          <thead>
            <tr>
              <th className="wk-grid__corner" />
              {columns.map((_, i) => (
                <th key={i} className={clsx(diff?.columns[i]?.status === "added" && "is-add")}>
                  {columnLetter(i)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody translate="no">
            <tr className="wk-grid__hdr">
              <th>1</th>
              {columns.map((name, i) => (
                <td
                  key={i}
                  className={clsx(diff?.columns[i]?.status === "added" && "is-add", sel?.r === 0 && sel.c === i && "is-sel")}
                  data-act={diffMode ? undefined : "cell"}
                  onClick={diffMode ? undefined : () => onSelect?.({ r: 0, c: i })}
                >
                  {name}
                </td>
              ))}
            </tr>
            {diff
              ? diff.rows.map((row, ri) => (
                  <tr key={ri}>
                    <th>{row.number}</th>
                    {row.cells.map((cell, ci) => (
                      <td
                        key={ci}
                        className={clsx(
                          isNumeric(cell.value) && "num",
                          (row.status === "added" || cell.status === "added") && "is-add",
                          (cell.status === "changed" || (ci === 0 && row.status === "moved")) && "is-chg",
                        )}
                      >
                        {cell.value}
                      </td>
                    ))}
                  </tr>
                ))
              : sheet.rows.map((row, ri) => (
                  <tr key={ri}>
                    <th>{ri + 2}</th>
                    {columns.map((_, ci) => {
                      const v = row[ci] ?? "";
                      return (
                        <td
                          key={ci}
                          className={clsx(isNumeric(v) && "num", sel?.r === ri + 1 && sel.c === ci && "is-sel")}
                          data-act="cell"
                          onClick={() => onSelect?.({ r: ri + 1, c: ci })}
                        >
                          {v}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            {diff?.removedRows.map((row, ri) => (
              <tr key={`del-${ri}`}>
                <th>–</th>
                {columns.map((_, ci) => (
                  <td key={ci} className="is-del">
                    {row[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FormulaBar({
  refLabel,
  value,
  hasSelection,
  editable,
  isSaving,
  counts,
  onSave,
}: {
  refLabel: string;
  value: string;
  hasSelection: boolean;
  editable: boolean;
  isSaving?: boolean;
  counts: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (hasSelection && editable) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editable, hasSelection]);

  return (
    <div className="wk-fbar">
      <span className="wk-fbar__ref mono">{refLabel}</span>
      <span className="wk-fbar__val">
        {!hasSelection ? (
          <span className="muted">Select a cell to see or edit its value</span>
        ) : editable ? (
          <Input
            ref={inputRef}
            className="wk-fbar__input"
            fullWidth
            aria-label={`Value of ${refLabel}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSave(draft);
            }}
            translate="no"
          />
        ) : (
          <span className="truncate" translate="no">
            {value}
          </span>
        )}
      </span>
      {hasSelection && editable ? (
        <Button size="sm" variant="tertiary" isPending={isSaving} onPress={() => onSave(draft)}>
          Save
        </Button>
      ) : (
        <span className="t-xs muted num none">{counts}</span>
      )}
    </div>
  );
}

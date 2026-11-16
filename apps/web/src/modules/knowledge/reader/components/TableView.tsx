"use client";

import clsx from "clsx";
import { memo, useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { fmtNum } from "@/lib/format";

import { searchNeedles, type MarkRange } from "../marks";
import { cellKey, columnLetter, NO_TABLE_MARKS, parseTablePayload, rowGroups, sheetNotice, sheetWidth, tableMarks, tableText, type TableSheet } from "../table";
import { Marked } from "./Marked";
import { CutNotice, SkeletonPage } from "./ReaderParts";
import { useRepresentationBody, type ViewerProps } from "./viewer";

const NUMERIC = /^-?[\d.,\s]+%?$/;

const readTable = async (response: Response) => parseTablePayload(await response.json());

/**
 * The TABLE representation (gzip JSON the browser decompresses): one sheet at a time as a CSS grid with
 * sticky column letters and row numbers, its rows in groups of 100 that layout skips while off screen,
 * sheet tabs, a formula bar for the selected cell, and the cells holding a cited row or a search word
 * marked. A sheet cut at the engine's bounds says so and offers the original.
 */
export function TableView({ fileKey, representation, refresh, highlight, focusHit, onMarks, onDownload }: ViewerProps) {
  const body = useRepresentationBody({ fileKey, representation, refresh }, readTable);
  const payload = body.data;
  const passages = highlight?.passages;
  const needles = useMemo(() => (payload && highlight?.q ? searchNeedles(highlight.q, tableText(payload), highlight.cited) : []), [payload, highlight?.q, highlight?.cited]);
  const marks = useMemo(() => (payload && (passages?.length || needles.length) ? tableMarks(payload, { passages, needles }) : NO_TABLE_MARKS), [payload, passages, needles]);
  const [active, setActive] = useState(0);
  const [cell, setCell] = useState<{ ref: string; value: string }>();

  const { total, unresolved } = marks;
  const ready = !!payload || body.isError;
  useEffect(() => onMarks({ total, unresolved, ready }), [total, unresolved, ready, onMarks]);

  // The focused mark's sheet is the one shown.
  const focusSheet = marks.hitSheets.get(focusHit);
  useEffect(() => {
    if (focusSheet !== undefined) setActive(focusSheet);
  }, [focusSheet]);

  if (body.isPending) return <SkeletonPage />;
  if (body.isError) return <ErrorState title="This file didn’t load" error={body.error} onRetry={() => void body.refetch()} />;
  const sheets = payload!.sheets;
  const index = Math.min(active, sheets.length - 1);
  const sheet = sheets[index];
  if (!sheet || (!sheet.rows.length && sheets.length === 1)) {
    return (
      <div className="doc-state">
        <EmptyState title="This sheet is empty" />
      </div>
    );
  }
  const notice = sheetNotice(sheet);

  const select = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as Element).closest<HTMLElement>(".doc-grid__cell[data-c]");
    if (!el) return;
    const r = Number(el.dataset.r);
    const c = Number(el.dataset.c);
    setCell({ ref: `${columnLetter(c)}${r + 1}`, value: sheet.rows[r]?.[c] ?? "" });
  };

  return (
    <div className="doc-viewer doc-viewer--sheet">
      <div className="doc-fx" role="group" aria-label="Formula bar">
        <span className="doc-fx__ref">{cell?.ref ?? "A1"}</span>
        <span className="doc-fx__fn" aria-hidden>
          fx
        </span>
        <span className="doc-fx__val" translate="no">
          {cell ? cell.value : (sheet.rows[0]?.[0] ?? "")}
        </span>
      </div>
      <div className="doc-page doc-page--sheet" data-page={1} translate="no">
        <SheetGrid key={`${fileKey}:${index}`} sheet={sheet} sheetIndex={index} cells={marks.cells} focusHit={focusHit} onSelect={select} />
        {sheets.length > 1 ? (
          <div className="doc-sheet__tabs" role="tablist" aria-label="Sheets">
            {sheets.map((s, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === index}
                className={clsx(i === index && "is-on")}
                onClick={() => {
                  setActive(i);
                  setCell(undefined);
                }}
              >
                {s.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {notice?.cut === "rows" ? (
        <CutNotice onDownload={onDownload}>{`Showing the first ${fmtNum(notice.shown)} of ${fmtNum(notice.total)} rows — download for the rest.`}</CutNotice>
      ) : notice?.cut === "columns" ? (
        <CutNotice onDownload={onDownload}>{`Showing the first ${fmtNum(notice.shown)} of ${fmtNum(notice.total)} columns — download for the rest.`}</CutNotice>
      ) : notice || representation.truncated ? (
        <CutNotice onDownload={onDownload}>Showing part of this file — download for the rest.</CutNotice>
      ) : null}
    </div>
  );
}

/** One sheet's grid. Row groups holding the focused mark are always laid out, so it can be scrolled to. */
function SheetGrid({
  sheet,
  sheetIndex,
  cells,
  focusHit,
  onSelect,
}: {
  sheet: TableSheet;
  sheetIndex: number;
  cells: ReadonlyMap<string, MarkRange[]>;
  focusHit: number;
  onSelect: (e: MouseEvent<HTMLDivElement>) => void;
}) {
  const width = Math.max(1, sheetWidth(sheet));
  const focusRow = useMemo(() => {
    if (focusHit < 0) return -1;
    for (const [key, ranges] of cells) {
      const [s, r] = key.split(":").map(Number);
      if (s === sheetIndex && ranges.some((m) => m.hit === focusHit)) return r!;
    }
    return -1;
  }, [cells, sheetIndex, focusHit]);
  const letters = Array.from({ length: width }, (_, c) => columnLetter(c));
  return (
    <div className="doc-grid-wrap">
      <div className="doc-grid" role="table" style={{ "--cols": width } as CSSProperties} onClick={onSelect}>
        <div className="doc-grid__head" role="row">
          <span className="doc-grid__corner" role="columnheader" />
          {letters.map((l) => (
            <span key={l} className="doc-grid__letter" role="columnheader">
              {l}
            </span>
          ))}
        </div>
        {rowGroups(sheet.rows.length).map(([start, end]) => (
          <RowGroup
            key={start}
            sheet={sheet}
            sheetIndex={sheetIndex}
            start={start}
            end={end}
            width={width}
            cells={cells}
            focusHit={focusRow >= start && focusRow < end ? focusHit : -1}
          />
        ))}
      </div>
    </div>
  );
}

const RowGroup = memo(function RowGroup({
  sheet,
  sheetIndex,
  start,
  end,
  width,
  cells,
  focusHit,
}: {
  sheet: TableSheet;
  sheetIndex: number;
  start: number;
  end: number;
  width: number;
  cells: ReadonlyMap<string, MarkRange[]>;
  /** The focused mark when it is in this group, else -1. */
  focusHit: number;
}) {
  return (
    <div className={clsx("doc-grid__group", focusHit >= 0 && "is-focus")} role="rowgroup" style={{ "--rows": end - start } as CSSProperties}>
      {sheet.rows.slice(start, end).map((row, i) => {
        const r = start + i;
        return (
          <div key={r} className={clsx("doc-grid__row", r === 0 && "doc-grid__row--first")} role="row">
            <span className="doc-grid__rn" role="rowheader">
              {r + 1}
            </span>
            {Array.from({ length: width }, (_, c) => {
              const value = row[c] ?? "";
              return (
                <span key={c} className={clsx("doc-grid__cell", NUMERIC.test(value) && "num")} role="cell" data-r={r} data-c={c}>
                  <Marked text={value} ranges={cells.get(cellKey(sheetIndex, r, c))} focusHit={focusHit} />
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
});

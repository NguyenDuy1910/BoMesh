"use client";

import clsx from "clsx";
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { fmtNum } from "@/lib/format";

import { searchNeedles, type MarkRange } from "../marks";
import { cellKey, columnLetter, inRects, NO_TABLE_MARKS, parseTablePayload, rowGroups, sheetNotice, sheetRects, sheetWidth, tableMarks, tableText, type CellRect, type SheetRect, type TableSheet } from "../table";
import { Marked } from "./Marked";
import { CutNotice, SkeletonPage } from "./ReaderParts";
import { useRepresentationBody, type ViewerProps } from "./viewer";

const NUMERIC = /^-?[\d.,\s]+%?$/;

const readTable = async (response: Response) => parseTablePayload(await response.json());

/**
 * The TABLE representation (gzip JSON the browser decompresses): one sheet at a time as a CSS grid with
 * sticky column letters and row numbers (the sheet's own: rows start at A1), its rows in groups of 100 that
 * layout skips while off screen, sheet tabs, a formula bar for the selected cell, and the cells holding a
 * search word marked. A citation's cell ranges are tinted (the focused one stronger) and the first is
 * brought into view on its sheet. A sheet cut at the engine's bounds says so and offers the original.
 */
export function TableView({ fileKey, representation, refresh, highlight, regions, focusHit, onMarks, onDownload }: ViewerProps) {
  const body = useRepresentationBody({ fileKey, representation, refresh }, readTable);
  const payload = body.data;
  const needles = useMemo(() => (payload && highlight?.q ? searchNeedles(highlight.q, tableText(payload), highlight.cited) : []), [payload, highlight?.q, highlight?.cited]);
  const marks = useMemo(() => (payload && needles.length ? tableMarks(payload, needles) : NO_TABLE_MARKS), [payload, needles]);
  const focusRects = useMemo(() => (payload && regions ? sheetRects(payload, regions.focus) : []), [payload, regions]);
  const otherRects = useMemo(() => (payload && regions ? sheetRects(payload, regions.others) : []), [payload, regions]);
  const [active, setActive] = useState(0);
  const [cell, setCell] = useState<{ ref: string; value: string }>();

  const { total } = marks;
  const ready = !!payload || body.isError;
  const cited = focusRects.length > 0;
  useEffect(() => onMarks({ total, ready, cited }), [total, ready, cited, onMarks]);

  // The focused mark's sheet is the one shown; else the sheet of the citation's first range.
  const focusSheet = marks.hitSheets.get(focusHit) ?? focusRects[0]?.sheet;
  useEffect(() => {
    if (focusSheet !== undefined) setActive(focusSheet);
  }, [focusSheet, focusRects]);

  if (body.isPending) return <SkeletonPage />;
  if (body.isError) return <ErrorState title="Không tải được tệp này" error={body.error} onRetry={() => void body.refetch()} />;
  const sheets = payload!.sheets;
  const index = Math.min(active, sheets.length - 1);
  const sheet = sheets[index];
  if (!sheet || (!sheet.rows.length && sheets.length === 1)) {
    return (
      <div className="doc-state">
        <EmptyState title="Trang tính này trống" />
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
      <div className="doc-fx" role="group" aria-label="Thanh công thức">
        <span className="doc-fx__ref">{cell?.ref ?? "A1"}</span>
        <span className="doc-fx__fn" aria-hidden>
          fx
        </span>
        <span className="doc-fx__val" translate="no">
          {cell ? cell.value : (sheet.rows[0]?.[0] ?? "")}
        </span>
      </div>
      <div className="doc-page doc-page--sheet" data-page={1} translate="no">
        <SheetGrid
          key={`${fileKey}:${index}`}
          sheet={sheet}
          sheetIndex={index}
          cells={marks.cells}
          focusHit={focusHit}
          focusRects={focusRects}
          otherRects={otherRects}
          onSelect={select}
        />
        {sheets.length > 1 ? (
          <div className="doc-sheet__tabs" role="tablist" aria-label="Trang tính">
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
        <CutNotice onDownload={onDownload}>{`Đang hiển thị ${fmtNum(notice.shown)} hàng đầu tiên trong số ${fmtNum(notice.total)} — tải xuống để xem phần còn lại.`}</CutNotice>
      ) : notice?.cut === "columns" ? (
        <CutNotice onDownload={onDownload}>{`Đang hiển thị ${fmtNum(notice.shown)} cột đầu tiên trong số ${fmtNum(notice.total)} — tải xuống để xem phần còn lại.`}</CutNotice>
      ) : notice || representation.truncated ? (
        <CutNotice onDownload={onDownload}>Đang hiển thị một phần của tệp — tải xuống để xem phần còn lại.</CutNotice>
      ) : null}
    </div>
  );
}

/** One sheet's grid. Row groups holding the focused mark or range are always laid out, so they can be scrolled to. */
function SheetGrid({
  sheet,
  sheetIndex,
  cells,
  focusHit,
  focusRects: allFocus,
  otherRects: allOthers,
  onSelect,
}: {
  sheet: TableSheet;
  sheetIndex: number;
  cells: ReadonlyMap<string, MarkRange[]>;
  focusHit: number;
  focusRects: readonly SheetRect[];
  otherRects: readonly SheetRect[];
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
  const focusRects = useMemo(() => allFocus.filter((x) => x.sheet === sheetIndex).map((x) => x.rect), [allFocus, sheetIndex]);
  const otherRects = useMemo(() => allOthers.filter((x) => x.sheet === sheetIndex).map((x) => x.rect), [allOthers, sheetIndex]);

  // The citation's first range in view: the grid scrolls inside its own box, under the sticky letters and row numbers.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !focusRects.length) return;
    const frame = requestAnimationFrame(() => {
      const target = wrap.querySelector<HTMLElement>(".doc-grid__cell--focus");
      if (!target) return;
      const box = wrap.getBoundingClientRect();
      const at = target.getBoundingClientRect();
      wrap.scrollTop = Math.max(0, wrap.scrollTop + at.top - box.top - wrap.clientHeight / 3);
      if (at.left < box.left + 48 || at.right > box.right) wrap.scrollLeft = Math.max(0, wrap.scrollLeft + at.left - box.left - 64);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRects]);

  const letters = Array.from({ length: width }, (_, c) => columnLetter(c));
  return (
    <div className="doc-grid-wrap" ref={wrapRef}>
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
            focusRects={focusRects}
            otherRects={otherRects}
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
  focusRects,
  otherRects,
}: {
  sheet: TableSheet;
  sheetIndex: number;
  start: number;
  end: number;
  width: number;
  cells: ReadonlyMap<string, MarkRange[]>;
  /** The focused mark when it is in this group, else -1. */
  focusHit: number;
  /** The focused citation's cells on this sheet, and the other citations'. */
  focusRects: readonly CellRect[];
  otherRects: readonly CellRect[];
}) {
  const holdsFocus = focusHit >= 0 || focusRects.some((r) => r.top < end && r.bottom >= start);
  return (
    <div className={clsx("doc-grid__group", holdsFocus && "is-focus")} role="rowgroup" style={{ "--rows": end - start } as CSSProperties}>
      {sheet.rows.slice(start, end).map((row, i) => {
        const r = start + i;
        return (
          <div key={r} className={clsx("doc-grid__row", r === 0 && "doc-grid__row--first")} role="row">
            <span className="doc-grid__rn" role="rowheader">
              {r + 1}
            </span>
            {Array.from({ length: width }, (_, c) => {
              const value = row[c] ?? "";
              const focus = inRects(focusRects, r, c);
              return (
                <span
                  key={c}
                  className={clsx("doc-grid__cell", NUMERIC.test(value) && "num", focus ? "doc-grid__cell--focus" : inRects(otherRects, r, c) && "doc-grid__cell--cited")}
                  role="cell"
                  data-r={r}
                  data-c={c}
                >
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

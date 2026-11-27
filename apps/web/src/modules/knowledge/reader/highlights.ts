/**
 * A citation's Highlights on the Original (document_viewer.md "Citations open in the Original"): boxes drawn over
 * PDF pages, as fractions of the page so they hold at any zoom and exist before the page is drawn. The focused
 * citation's regions are drawn stronger than the other citations of the same document and revision.
 *
 * Pure and dependency-free so it runs under `node --test`.
 */
import type { Highlight, HighlightBox } from "../content/reference.ts";

/** The regions to mark: the focused citation's, and the lighter ones of the document's other citations. */
export interface CitedRegions {
  focus: readonly Highlight[];
  others: readonly Highlight[];
}

/** One box to draw on a page. */
export interface PageBox {
  box: HighlightBox;
  focus: boolean;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** A box's place on its page box as percentages (`left`/`top`/`width`/`height`), clamped to the page. */
export function boxStyle(box: HighlightBox): { left: string; top: string; width: string; height: string } {
  const left = clamp(Math.min(box.left, box.right));
  const top = clamp(Math.min(box.top, box.bottom));
  const right = clamp(Math.max(box.left, box.right));
  const bottom = clamp(Math.max(box.top, box.bottom));
  const pct = (value: number) => `${Math.round(value * 1_000_000) / 10_000}%`;
  return { left: pct(left), top: pct(top), width: pct(right - left), height: pct(bottom - top) };
}

/** Boxes per page number, the other citations' first so the focused ones paint over them. */
export function pageBoxes({ focus, others }: CitedRegions): ReadonlyMap<number, readonly PageBox[]> {
  const pages = new Map<number, PageBox[]>();
  const add = (highlights: readonly Highlight[], isFocus: boolean) => {
    for (const h of highlights) {
      if (!h.pageNumber || !h.boxes?.length) continue;
      const list = pages.get(h.pageNumber) ?? [];
      for (const box of h.boxes) list.push({ box, focus: isFocus });
      pages.set(h.pageNumber, list);
    }
  };
  add(others, false);
  add(focus, true);
  return pages;
}

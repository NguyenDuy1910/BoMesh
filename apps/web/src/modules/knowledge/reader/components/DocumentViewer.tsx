"use client";

import { Button, Tooltip } from "@heroui/react";
import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type RefObject } from "react";

import { IconButton } from "@/components/ui/IconButton";

import { PAGED_FORMATS, type DocFormat } from "../format";
import { columnLetter } from "./RenditionView";

const ZOOMS = [0.75, 0.9, 1, 1.15, 1.3, 1.5];

export interface DocumentViewerProps {
  format: DocFormat;
  /** Pages (slides for a deck) of the document, for "Page n of N". */
  count: number;
  /** The slim viewer bar (Reader); the quick preview has none. */
  bar?: boolean;
  /** The element that scrolls the pages, to follow the page in view. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** The pages (`RenditionView` or `PageImageView`). */
  children: ReactNode;
}

/**
 * The native viewer around the document's pages (preview reader.js `viewerHtml`): paged files
 * (PDF, Word, slides) get a slim viewer bar with the page in view and zoom; spreadsheets get a
 * formula bar (select a cell to see its reference and value); web-like files read as one
 * continuous page.
 */
export function DocumentViewer({ format, count, bar = true, scrollRef, children }: DocumentViewerProps) {
  if (format === "sheet") return <SheetViewer>{children}</SheetViewer>;
  if (!PAGED_FORMATS[format]) {
    return (
      <article className={`doc-viewer doc-viewer--flow doc-viewer--${format}`} translate="no">
        {children}
      </article>
    );
  }
  return (
    <PagedViewer format={format} count={count} bar={bar} scrollRef={scrollRef}>
      {children}
    </PagedViewer>
  );
}

function PagedViewer({ format, count, bar, scrollRef, children }: Required<Pick<DocumentViewerProps, "format" | "count" | "bar">> & Pick<DocumentViewerProps, "scrollRef" | "children">) {
  const [zoom, setZoom] = useState(1);
  const [where, setWhere] = useState(1);
  const pagesRef = useRef<HTMLDivElement>(null);
  const label = format === "slide" ? "Slide" : "Page";

  // The page (or slide) in view, like the file's own app: the last one whose top passed a third of the view.
  useEffect(() => {
    const sc = scrollRef?.current;
    const root = pagesRef.current;
    if (!bar || !sc || !root) return;
    const track = () => {
      const line = sc.getBoundingClientRect().top + sc.clientHeight / 3;
      let n = 1;
      for (const page of root.querySelectorAll<HTMLElement>(".doc-page[data-n]")) {
        if (page.getBoundingClientRect().top > line) break;
        n = Number(page.dataset.n) || n;
      }
      setWhere(n);
    };
    track();
    sc.addEventListener("scroll", track, { passive: true });
    return () => sc.removeEventListener("scroll", track);
  }, [bar, scrollRef, zoom]);

  const zi = ZOOMS.indexOf(zoom);
  return (
    <div className={`doc-viewer doc-viewer--${format}`}>
      {bar ? (
        <div className="doc-viewer__bar">
          <span className="doc-viewer__where num" aria-live="polite">{`${label} ${Math.min(where, count)} of ${count}`}</span>
          <div className="doc-viewer__zoom" role="group" aria-label="Zoom">
            <IconButton icon={Minus} tip="Zoom out" size="sm" isDisabled={zi <= 0} onPress={() => setZoom(ZOOMS[Math.max(0, zi - 1)]!)} />
            <Tooltip>
              <Button variant="ghost" size="sm" className="doc-viewer__pct num" onPress={() => setZoom(1)}>
                {`${Math.round(zoom * 100)}%`}
              </Button>
              <Tooltip.Content>Reset zoom</Tooltip.Content>
            </Tooltip>
            <IconButton icon={Plus} tip="Zoom in" size="sm" isDisabled={zi >= ZOOMS.length - 1} onPress={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, zi + 1)]!)} />
          </div>
        </div>
      ) : null}
      <div className="doc-viewer__pages" ref={pagesRef} style={{ "--doc-zoom": zoom } as CSSProperties} translate="no">
        {children}
      </div>
    </div>
  );
}

/** Spreadsheets: selecting a cell shows its reference and value in the formula bar, as in the file's own app. */
function SheetViewer({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [cell, setCell] = useState<{ ref: string; value: string; el?: HTMLElement }>({ ref: "A1", value: "" });

  // Before a selection the formula bar shows A1 (the header row's first cell).
  useEffect(() => {
    const first = root.current?.querySelector<HTMLElement>(".doc-sheet__hdr td:not(.doc-sheet__rn)");
    if (first) setCell((c) => (c.el || c.value === first.textContent ? c : { ref: "A1", value: first.textContent ?? "" }));
  }, [children]);

  const select = (e: MouseEvent<HTMLDivElement>) => {
    const td = (e.target as Element).closest<HTMLElement>(".doc-sheet td");
    if (!td || td.classList.contains("doc-sheet__rn")) return;
    const tr = td.parentElement;
    if (!tr) return;
    const col = Array.prototype.indexOf.call(tr.children, td) - 1;
    const row = tr.querySelector(".doc-sheet__rn")?.textContent ?? "";
    cell.el?.classList.remove("is-sel");
    td.classList.add("is-sel");
    setCell({ ref: `${columnLetter(col)}${row}`, value: td.textContent ?? "", el: td });
  };

  return (
    <div className="doc-viewer doc-viewer--sheet" ref={root} onClick={select}>
      <div className="doc-fx" role="group" aria-label="Formula bar">
        <span className="doc-fx__ref">{cell.ref}</span>
        <span className="doc-fx__fn" aria-hidden>
          fx
        </span>
        <span className="doc-fx__val" translate="no">
          {cell.value}
        </span>
      </div>
      {children}
    </div>
  );
}

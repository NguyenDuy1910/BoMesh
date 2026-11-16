"use client";

import { Button, Tooltip } from "@heroui/react";
import { Minus, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import { IconButton } from "@/components/ui/IconButton";

import { PAGED_FORMATS, type DocFormat } from "../format";

const ZOOMS = [0.75, 0.9, 1, 1.15, 1.3, 1.5];

const ViewerZoom = createContext(1);

/** The viewer bar's zoom (CSS `zoom` on the pages): a PDF draws its canvases at this scale to stay sharp. */
export function useViewerZoom(): number {
  return useContext(ViewerZoom);
}

export interface DocumentViewerProps {
  format: DocFormat;
  /** Pages (slides for a deck) of the document, for "Page n of N". */
  count: number;
  /** The slim viewer bar (Reader); the quick preview has none. */
  bar?: boolean;
  /** The element that scrolls the pages, to follow the page in view. */
  scrollRef?: RefObject<HTMLElement | null>;
  /** The pages (`PdfView`) or the text (`TextView`). */
  children: ReactNode;
}

/**
 * The native viewer around the document's pages (preview reader.js `viewerHtml`): paged files (PDF)
 * get a slim viewer bar with the page in view and zoom; text reads as one continuous page.
 */
export function DocumentViewer({ format, count, bar = true, scrollRef, children }: DocumentViewerProps) {
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
        <ViewerZoom.Provider value={zoom}>{children}</ViewerZoom.Provider>
      </div>
    </div>
  );
}

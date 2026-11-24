"use client";

import { Button } from "@heroui/react";
import clsx from "clsx";
import { Download, RotateCcw } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";

import type { DocumentCover } from "../../api";
import { NO_PDF_MARKS, pagedTextMarks, pageText, pdfMarks, searchNeedles, type MarkRange, type PageMark } from "../marks";
import { drawPixelRatio, isCancelled, loadPdfJs, pdfSource, scheduleDraw, storageStatus, type PdfDocument, type PdfLoadingTask, type PdfPage } from "../pdf";
import { DocumentViewer, useViewerZoom } from "./DocumentViewer";
import { NothingToShow } from "./ReaderParts";
import type { ViewerProps } from "./viewer";

/** Letter paper (points) until the file says otherwise. */
const LETTER: Size = [612, 792];
/** A 403 this soon after a fresh URL is a real refusal, not an expired signature. */
const FRESH_URL_MS = 10_000;

type Size = readonly [width: number, height: number];

export interface PdfViewerProps extends ViewerProps {
  /** The item's cover (current revision only): page 1 until page 1 is drawn. */
  cover?: DocumentCover;
  /** `?page=`: a page to keep drawn whatever is in view. */
  page?: number;
  /** The slim viewer bar (page in view, zoom). */
  bar: boolean;
  scrollRef?: RefObject<HTMLElement | null>;
  /** The element that scrolls the pages: what "near the view" is measured against. */
  scroller: HTMLElement | null;
  /** Pages in the file, once it is open. */
  onPages: (count: number) => void;
}

/** The PDF representation in the paged viewer; a file that can't be opened offers a retry and the download. */
export function PdfViewer({ bar, scrollRef, onDownload, onPages, ...props }: PdfViewerProps) {
  const [pages, setPages] = useState(0);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const onOpened = useCallback(
    (n: number) => {
      setPages(n);
      onPages(n);
    },
    [onPages],
  );
  const onFailed = useCallback(() => setFailed(true), []);
  if (failed) {
    return (
      <NothingToShow
        title="Không mở được tệp PDF này"
        description="Tệp có thể bị hỏng hoặc được bảo vệ. Hãy tải xuống để mở bằng ứng dụng của tệp."
        actions={
          <>
            <Button
              variant="secondary"
              onPress={() => {
                setFailed(false);
                setAttempt((n) => n + 1);
                void props.refresh();
              }}
            >
              <RotateCcw className="i" aria-hidden />
              Thử lại
            </Button>
            <Button variant="tertiary" onPress={onDownload}>
              <Download className="i" aria-hidden />
              Tải xuống
            </Button>
          </>
        }
      />
    );
  }
  return (
    <DocumentViewer format="pdf" count={Math.max(1, pages)} bar={bar} scrollRef={scrollRef}>
      <PdfView key={attempt} {...props} onPages={onOpened} onFailed={onFailed} />
    </DocumentViewer>
  );
}

type PdfViewProps = Omit<PdfViewerProps, "bar" | "scrollRef" | "onDownload"> & {
  /** The file can't be opened or drawn (after one retry with a fresh URL when storage refused). */
  onFailed: (error: unknown) => void;
};

/**
 * A PDF drawn with pdf.js (document_viewer.md "Reading (web)"): read with 1 MiB `Range` requests (no
 * streaming, no prefetch; a file under 4 MiB in one read), so only the pages shown are fetched. Every
 * page is a box of its exact size from the start (page 1's size until a page says otherwise), fitted to
 * the width; only pages within one screen of the view hold a canvas — drawn one page at a time
 * (`scheduleDraw`) at the device pixel ratio (at most 2) and the viewer's zoom — and a text layer, and scrolling away releases them, so memory stays flat on
 * long documents. Cited passages with boxes are evidence boxes on their pages; passages without boxes
 * and `?q=` are found in the pages' text and marked in the text layer. Opening is cover-first: the
 * item's cover is page 1 until page 1 is drawn.
 */
function PdfView({ representation, refresh, cover, highlight, focusHit, page = 0, scroller, onMarks, onPages, onFailed }: PdfViewProps) {
  const [src, setSrc] = useState(() => ({ uri: representation.uri, expires: Date.parse(representation.expireTime ?? ""), at: Date.now() }));
  const [doc, setDoc] = useState<PdfDocument>();
  const [count, setCount] = useState(0);
  const [sizes, setSizes] = useState<ReadonlyMap<number, Size>>(new Map());
  const [near, setNear] = useState<ReadonlySet<number>>(new Set());
  const [width, setWidth] = useState(0);
  const zoom = useViewerZoom();
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useRef<{ doc?: PdfDocument; refreshing: boolean }>({ refreshing: false });

  const fail = useCallback(
    (error: unknown, from: PdfDocument | undefined) => {
      if (from !== live.current.doc || live.current.refreshing) return;
      const status = storageStatus(error);
      const expired = Number.isFinite(src.expires) && Date.now() >= src.expires;
      if (expired || (status === 403 && Date.now() - src.at > FRESH_URL_MS)) {
        // The signed URL expired: read the preview again and reopen the file with the fresh one.
        live.current = { refreshing: true };
        setDoc(undefined);
        void refresh().then((preview) => {
          const uri = preview?.representation?.uri;
          if (!uri || uri === src.uri) return onFailed(error);
          setSrc({ uri, expires: Date.parse(preview.representation?.expireTime ?? ""), at: Date.now() });
        });
        return;
      }
      onFailed(error);
    },
    [src, refresh, onFailed],
  );

  // Open the file: page 1's size for every page until each is read.
  useEffect(() => {
    let cancelled = false;
    let task: PdfLoadingTask | undefined;
    void (async () => {
      const pdfjs = await loadPdfJs();
      if (cancelled) return;
      task = pdfjs.getDocument(pdfSource(src.uri, representation.sizeBytes));
      const opened = await task.promise;
      const firstPage = await opened.getPage(1);
      if (cancelled) return;
      const { width: w, height: h } = firstPage.getViewport({ scale: 1 });
      live.current = { doc: opened, refreshing: false };
      setSizes((s) => (s.has(1) ? s : new Map(s).set(1, [w, h])));
      setCount(opened.numPages);
      setDoc(opened);
      onPages(opened.numPages);
    })().catch((error: unknown) => {
      if (cancelled) return;
      live.current = { doc: undefined, refreshing: false };
      fail(error, undefined);
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
    // Re-signed URLs of the same file don't reopen it; only a refresh after a failure does (`src`).
  }, [src.uri]);

  /* ── Marks: boxes of cited passages, then what the pages' text holds ── */
  const passages = highlight?.passages;
  const boxes = useMemo(() => (passages?.length ? pdfMarks(passages) : NO_PDF_MARKS), [passages]);
  const q = highlight?.q ?? "";
  const scan = !!(q || boxes.textPassages.length);
  const [pageTexts, setPageTexts] = useState<ReadonlyMap<number, string>>();
  useEffect(() => {
    if (!doc || !scan || !count) return;
    let cancelled = false;
    void (async () => {
      const texts = new Map<number, string>();
      for (let n = 1; n <= count && !cancelled; n++) {
        const content = await (await doc.getPage(n)).getTextContent({ disableNormalization: true });
        texts.set(n, pageText(content.items as { str?: string; hasEOL?: boolean }[]));
      }
      if (!cancelled) setPageTexts(texts);
    })().catch((error: unknown) => {
      if (!cancelled && !isCancelled(error)) fail(error, doc);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, scan, count, fail]);
  const text = useMemo(() => {
    if (!scan || !pageTexts) return undefined;
    const needles = q ? searchNeedles(q, [...pageTexts.values()].join("\n"), !!highlight?.cited) : [];
    return pagedTextMarks(pageTexts, { passages: boxes.textPassages, needles }, boxes.total);
  }, [scan, pageTexts, q, highlight?.cited, boxes]);

  const boxPage = focusHit >= 0 ? [...boxes.pages].find(([, list]) => list.some((m) => m.hit === focusHit))?.[0] : undefined;
  const focusPage = boxPage ?? text?.hitPages.get(focusHit);
  const total = boxes.total + (text?.total ?? 0);
  const unresolved = text ? text.unresolved : boxes.textPassages.length;
  const ready = !!doc && (!scan || !!text);
  useEffect(() => onMarks({ total, unresolved, ready, focusPage }), [total, unresolved, ready, focusPage, onMarks]);

  // Fit to width: pages are redrawn when the column changes size.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Pages within one screen of the view are drawn; the others are released.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !count) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setNear((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const n = Number((entry.target as HTMLElement).dataset.n);
            if (entry.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        }),
      { root: scroller, rootMargin: "100% 0px" },
    );
    for (const el of root.querySelectorAll<HTMLElement>(".doc-pdf__page[data-n]")) observer.observe(el);
    return () => observer.disconnect();
  }, [count, scroller]);

  const onSize = useCallback((n: number, size: Size) => {
    setSizes((s) => {
      const had = s.get(n);
      return had && Math.abs(had[0] - size[0]) < 0.5 && Math.abs(had[1] - size[1]) < 0.5 ? s : new Map(s).set(n, size);
    });
  }, []);

  const base = sizes.get(1) ?? (cover?.widthPixels && cover.heightPixels ? ([cover.widthPixels, cover.heightPixels] as const) : LETTER);
  const shown = count || 1;
  return (
    <div ref={rootRef} className="doc-pdf" aria-busy={!doc || undefined}>
      {Array.from({ length: shown }, (_, i) => {
        const n = i + 1;
        const ranges = text?.pages.get(n);
        const marked = boxes.pages.has(n) || !!ranges;
        return (
          <PdfPageBox
            key={n}
            doc={doc}
            n={n}
            size={sizes.get(n) ?? base}
            draw={!!doc && width > 0 && (near.has(n) || n === page || n === focusPage)}
            layout={`${width}:${zoom}`}
            cover={n === 1 ? cover?.imageUri : undefined}
            marks={boxes.pages.get(n)}
            textMarks={ranges}
            focusHit={marked ? focusHit : -1}
            onSize={onSize}
            onFail={fail}
          />
        );
      })}
      {!count && doc === undefined ? <div className="doc-page doc-pdf__page doc-page--blank" style={{ aspectRatio: `${base[0]} / ${base[1]}` }} /> : null}
    </div>
  );
}

/**
 * Marks `ranges` of the page's text (`pageText`) in its text layer: the layer's spans and line breaks
 * read in order give that text, so each span a range covers has its covered part wrapped in
 * `mark.evidence[data-hit]`. Marks from a previous call are removed first.
 */
function markTextLayer(layer: HTMLElement, ranges: readonly MarkRange[], focusHit: number) {
  for (const old of layer.querySelectorAll("mark.evidence")) old.replaceWith(...old.childNodes);
  layer.normalize();
  if (!ranges.length) return;
  let at = 0;
  for (const el of layer.querySelectorAll<HTMLElement>("span:not(.markedContent), br")) {
    if (el.tagName === "BR") {
      at += 1;
      continue;
    }
    const value = el.textContent ?? "";
    const start = at;
    at += value.length;
    const hits = ranges.filter((r) => r.start < at && r.end > start);
    if (!hits.length) continue;
    const parts = document.createDocumentFragment();
    let pos = 0;
    for (const r of hits) {
      const from = Math.max(0, r.start - start);
      const to = Math.min(value.length, r.end - start);
      if (from > pos) parts.append(value.slice(pos, from));
      const mark = document.createElement("mark");
      mark.className = clsx("evidence doc-pdf__hit", r.hit === focusHit && "is-focus");
      mark.dataset.hit = String(r.hit);
      mark.textContent = value.slice(from, to);
      parts.append(mark);
      pos = to;
    }
    if (pos < value.length) parts.append(value.slice(pos));
    el.replaceChildren(parts);
  }
}

const PdfPageBox = memo(function PdfPageBox({
  doc,
  n,
  size,
  draw,
  layout,
  cover,
  marks,
  textMarks,
  focusHit,
  onSize,
  onFail,
}: {
  doc: PdfDocument | undefined;
  n: number;
  size: Size;
  draw: boolean;
  /** Changes when the page must be drawn again (width, zoom). */
  layout: string;
  cover?: string;
  marks?: readonly PageMark[];
  /** Ranges of this page's text to mark in its text layer. */
  textMarks?: readonly MarkRange[];
  focusHit: number;
  onSize: (n: number, size: Size) => void;
  onFail: (error: unknown, doc: PdfDocument | undefined) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<PdfPage>(undefined);
  const [drawn, setDrawn] = useState(false);
  const [layer, setLayer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    const canvasHolder = canvasRef.current;
    const textHolder = textRef.current;
    if (!doc || !draw || !box || !canvasHolder || !textHolder) return;
    let cancelled = false;
    let canvas: HTMLCanvasElement | undefined;
    let render: { cancel: () => void } | undefined;
    let text: { cancel: () => void } | undefined;
    // Drawn one page at a time (`scheduleDraw`): images and glyphs paint on the main thread.
    scheduleDraw(async () => {
      if (cancelled) return;
      const [pdfjs, page] = await Promise.all([loadPdfJs(), doc.getPage(n)]);
      if (cancelled) return;
      pageRef.current = page;
      const unit = page.getViewport({ scale: 1 });
      onSize(n, [unit.width, unit.height]);
      const cssWidth = box.clientWidth;
      if (!cssWidth) return;
      // Layout pixels for the text layer; device pixels (zoom included) for the canvas.
      const scale = cssWidth / unit.width;
      const pixels = ((box.getBoundingClientRect().width || cssWidth) / unit.width) * drawPixelRatio();
      const viewport = page.getViewport({ scale: pixels });
      canvas = document.createElement("canvas");
      canvas.className = "doc-pdf__canvas";
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const task = page.render({ canvas, viewport });
      render = task;
      await task.promise;
      if (cancelled) return;
      // Swap in the new drawing only once it is complete, so a redraw (zoom, resize) never flashes.
      const old = canvasHolder.firstElementChild;
      canvasHolder.replaceChildren(canvas);
      if (old instanceof HTMLCanvasElement) old.width = old.height = 0;
      setDrawn(true);
      const next = document.createElement("div");
      next.className = "textLayer";
      next.style.setProperty("--total-scale-factor", String(scale));
      const textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: next,
        viewport: page.getViewport({ scale }),
      });
      text = textLayer;
      await textLayer.render();
      if (cancelled) return;
      const end = document.createElement("div");
      end.className = "endOfContent";
      next.append(end);
      textHolder.replaceChildren(next);
      setLayer(next);
    }).catch((error: unknown) => {
      if (!cancelled && !isCancelled(error)) onFail(error, doc);
    });
    return () => {
      cancelled = true;
      render?.cancel();
      text?.cancel();
      if (canvas && canvas.parentElement !== canvasHolder) canvas.width = canvas.height = 0;
    };
  }, [doc, n, draw, layout, onSize, onFail]);

  // Far from the view: release the drawing, the text and the page's parsed resources.
  useEffect(() => {
    if (draw) return;
    const old = canvasRef.current?.firstElementChild;
    if (old instanceof HTMLCanvasElement) old.width = old.height = 0;
    canvasRef.current?.replaceChildren();
    textRef.current?.replaceChildren();
    pageRef.current?.cleanup();
    pageRef.current = undefined;
    setDrawn(false);
    setLayer(null);
  }, [draw]);

  // Text marks live in the text layer's markup: placed (again) whenever the layer or the marks change.
  useEffect(() => {
    if (layer && (textMarks?.length || layer.querySelector("mark.evidence"))) markTextLayer(layer, textMarks ?? [], focusHit);
  }, [layer, textMarks, focusHit]);

  const style: CSSProperties = { aspectRatio: `${size[0]} / ${size[1]}` };
  if (cover && !drawn) style.backgroundImage = `url("${cover}")`;
  return (
    <div ref={boxRef} className="doc-page doc-pdf__page" data-page={n} data-n={n} style={style}>
      <div ref={canvasRef} className="doc-pdf__layer" />
      {marks?.map((m, i) => (
        <mark
          key={i}
          className={clsx("evidence doc-pdf__mark", m.hit === focusHit && "is-focus")}
          data-hit={m.hit}
          style={{ left: `${m.left * 100}%`, top: `${m.top * 100}%`, width: `${m.width * 100}%`, height: `${m.height * 100}%` }}
        />
      ))}
      <div ref={textRef} className="doc-pdf__layer doc-pdf__text" />
    </div>
  );
});

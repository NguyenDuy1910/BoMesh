"use client";

import { Button, buttonVariants } from "@heroui/react";
import { Download } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { ErrorState } from "@/components/ui/ErrorState";
import { ApiError } from "@/lib/api/client";

import type { DocumentCover } from "../../api";
import { highlightPage, locationLabel, type Highlight, type Reference } from "../../content/reference";
import { scrollParent } from "../../content/scroll";
import type { CitedRegions } from "../highlights";
import { coverFormat, surfaceView, UNAVAILABLE_COPY, type Viewer } from "../preview";
import { useItemPreview } from "../queries";
import { coverPages } from "./CoverPages";
import { NothingToShow, QuoteCard, SkeletonPage } from "./ReaderParts";
import type { ViewerMarks, ViewerProps } from "./viewer";

/* One lazy chunk per viewer: a document loads only the viewer of its representation (pdf.js only with the PDF one). */
const PdfViewer = lazy(() => import("./PdfView").then((m) => ({ default: m.PdfViewer })));
const ImageView = lazy(() => import("./ImageView").then((m) => ({ default: m.ImageView })));
const TableView = lazy(() => import("./TableView").then((m) => ({ default: m.TableView })));
const TextView = lazy(() => import("./TextView").then((m) => ({ default: m.TextView })));
const MediaView = lazy(() => import("./MediaView").then((m) => ({ default: m.MediaView })));
const ArchiveView = lazy(() => import("./ArchiveView").then((m) => ({ default: m.ArchiveView })));

/** What the surface needs to know about the document before its preview is read. */
export interface SurfaceDocument {
  /** Bare item ID. */
  id: string;
  /** The current revision's cover: page 1 while the preview opens or is prepared. */
  cover?: DocumentCover;
}

/** The reader's `?q=` to mark. */
export interface SurfaceHighlight {
  q: string;
  /** `q` is a citation quote, matched as one phrase. */
  cited: boolean;
}

/**
 * A citation to mark on the Original: its Highlights (PDF boxes, table cell ranges) or, on a text
 * representation, its quote. Callers keep its identity while it is the same citation (a new one scrolls to it).
 */
export interface SurfaceCitation extends Pick<Reference, "quote" | "location" | "highlights"> {
  /** Highlights of the document's other citations in the same revision, drawn lighter. */
  others: readonly Highlight[];
}

export interface SurfaceMarks {
  /** Marks drawn. */
  total: number;
  /** The view is drawn, so the counts are final. */
  ready: boolean;
  /** `?q=` is marked in this view (the PDF, table and text viewers mark it). */
  searchable: boolean;
}

export type SurfaceVariant = "reader" | "preview" | "pane";

export interface DocumentSurfaceProps {
  document: SurfaceDocument;
  /** Revision number to show; the current revision when empty. */
  revision?: string;
  /** `reader`: the viewer bar (page, zoom); `preview`: the quick preview; `pane`: the review pane (no bar, the pane says the pages). */
  variant?: SurfaceVariant;
  /** The element that scrolls the document (default: the nearest scrolling ancestor). */
  scrollRef?: RefObject<HTMLElement | null>;
  /** The `?q=` search to mark. */
  highlight?: SurfaceHighlight;
  /** The citation in focus; when it can't be marked (no Highlight, a range cut away, a quote not found) its quote shows above the file. */
  citation?: SurfaceCitation;
  /** The mark to bring into view and emphasize. */
  focusHit?: number;
  /** `?page=`: the page to open on (default: the citation's first page). */
  page?: number;
  onMarks?: (marks: SurfaceMarks) => void;
  /** Pages in the document, once known (the review pane's "Page 1 of N"). */
  onPages?: (count: number) => void;
  onDownload: () => void;
}

const NO_SURFACE_MARKS: SurfaceMarks = { total: 0, ready: false, searchable: false };
const SEARCHABLE: Readonly<Partial<Record<Viewer, true>>> = { pdf: true, table: true, text: true };

/**
 * The one document surface (document_viewer.md "Reading (web)"): reads `GetItemPreview` and branches
 * only on its `state` and the representation's `kind` — READY draws one of six viewers (PDF, image,
 * table, text, media, archive) given the representation's URL; PREPARING shows the cover as page 1 and
 * polls; UNAVAILABLE says why and offers the original. Used by the Reader, the quick preview, the
 * submission view and the review pane. Nothing here depends on processing: `?q=` is marked when the
 * caller passes it; a citation's Highlights are drawn over the PDF pages or the grid, its quote marked in text.
 */
export function DocumentSurface({ document: d, revision, variant = "reader", scrollRef, highlight, citation, focusHit = -1, page, onMarks, onPages, onDownload }: DocumentSurfaceProps) {
  const preview = useItemPreview(d.id, revision);
  const p = preview.data;
  const view = p ? surfaceView(p) : undefined;
  // The cover shows the current revision's first page; an older revision has none.
  const cover = revision ? undefined : d.cover;
  const fileKey = `${d.id}:${p?.revision ?? revision ?? ""}`;
  const format = coverFormat(cover);

  const rootRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  useEffect(() => setScroller(scrollRef?.current ?? scrollParent(rootRef.current)), [scrollRef]);
  // Callers pass `onMarks`/`onPages` inline: the latest is kept in a ref, so a new function identity never re-runs an
  // effect (a caller that sets state in the callback would otherwise re-render, pass a new function and loop).
  const callbacks = useRef({ onMarks, onPages });
  useLayoutEffect(() => {
    callbacks.current = { onMarks, onPages };
  });

  /* ── Marks, as the viewer of this file reports them ── */
  const [reported, setReported] = useState<ViewerMarks & { key: string }>();
  const onViewerMarks = useCallback(
    (m: ViewerMarks) =>
      setReported((r) =>
        r && r.key === fileKey && r.total === m.total && r.ready === m.ready && r.focusPage === m.focusPage && r.cited === m.cited ? r : { ...m, key: fileKey },
      ),
    [fileKey],
  );
  const onViewerPages = useCallback((n: number) => callbacks.current.onPages?.(n), []);
  const viewerMarks = reported?.key === fileKey ? reported : undefined;
  const surfaceMarks: SurfaceMarks =
    view?.state === "READY" && viewerMarks
      ? { total: viewerMarks.total, ready: viewerMarks.ready, searchable: !!SEARCHABLE[view.viewer] }
      : NO_SURFACE_MARKS;
  const { total, ready: drawn, searchable } = surfaceMarks;
  useEffect(() => callbacks.current.onMarks?.({ total, ready: drawn, searchable }), [total, drawn, searchable]);

  /* ── The citation: Highlights for the PDF and the grid, the quote for text ── */
  const regions = useMemo<CitedRegions | undefined>(() => (citation ? { focus: citation.highlights, others: citation.others } : undefined), [citation]);
  const citationPage = highlightPage(citation?.highlights);
  const opensAt = page ?? citationPage;
  const quoteHighlight = useMemo<SurfaceHighlight | undefined>(() => (citation?.quote ? { q: citation.quote, cited: true } : undefined), [citation?.quote]);
  // Whether the citation is marked in the file: `undefined` until that is known.
  let marked: boolean | undefined;
  if (!citation) marked = true;
  else if (preview.isPending) marked = undefined;
  else if (view?.state !== "READY") marked = false;
  else if (view.viewer === "pdf") marked = citationPage !== undefined;
  else if (view.viewer === "table") marked = viewerMarks?.ready ? !!viewerMarks.cited : undefined;
  else if (view.viewer === "text") marked = highlight ? false : viewerMarks?.ready ? viewerMarks.total > 0 : undefined;
  else marked = false;

  /* ── Bring the focused mark, the citation's first box (or its page, `?page=`) into view: on open and on every step, not on re-renders ── */
  const first = useRef(true);
  const focusPage = viewerMarks?.focusPage;
  useEffect(() => {
    const sc = scroller;
    const root = rootRef.current;
    if (!sc || !root || !drawn) return;
    const mark = (focusHit >= 0 ? root.querySelector<HTMLElement>(`mark.evidence[data-hit="${focusHit}"]`) : null) ?? (citation ? root.querySelector<HTMLElement>(".doc-pdf__hl.is-focus") : null);
    const where = mark ? undefined : focusHit >= 0 && focusPage ? focusPage : opensAt;
    const target = mark ?? (where ? root.querySelector<HTMLElement>(`[data-page="${where}"]`) : null);
    if (!target) {
      if (first.current && variant !== "reader") sc.scrollTop = 0;
      return;
    }
    const top = sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - (mark ? sc.clientHeight / 3 : 24);
    sc.scrollTo({ top: Math.max(0, top), behavior: first.current ? "auto" : "smooth" });
    first.current = false;
  }, [scroller, drawn, focusHit, focusPage, opensAt, total, variant, citation]);

  /* ── What to draw ── */
  const loading = coverPages(cover, format) ?? <SkeletonPage />;
  const unavailable = (title: string, description: string, download: ReactNode) => (
    <>
      <NothingToShow title={title} description={description} actions={download} />
      {variant === "pane" ? null : coverPages(cover, format, { loading: false })}
    </>
  );
  const downloadButton = (
    <Button variant="tertiary" onPress={onDownload}>
      <Download className="i" aria-hidden />
      Tải xuống
    </Button>
  );

  let body: ReactNode;
  if (preview.isPending) body = loading;
  else if (preview.isError) {
    const e = preview.error;
    if (e instanceof ApiError && e.code === "FAILED_PRECONDITION") body = unavailable("Tệp chưa được tải lên xong", "Quá trình tải lên chưa hoàn tất. Hãy thử lại sau giây lát.", downloadButton);
    else if (e instanceof ApiError && e.status === 404 && revision) body = unavailable("Phiên bản này không khả dụng", "Có thể phiên bản này đã bị gỡ.", downloadButton);
    else body = <ErrorState title="Không tải được tài liệu này" error={e} onRetry={() => preview.refetch()} />;
  } else if (!view || view.state === "PREPARING") {
    body = (
      <>
        <p className="doc-gap doc-preparing" role="status">
          Đang chuẩn bị bản xem trước…
        </p>
        {loading}
      </>
    );
  } else if (view.state === "UNAVAILABLE") {
    const copy = UNAVAILABLE_COPY[view.reason];
    // The revision's own original (an older revision's too), straight from storage.
    const original = p?.original?.uri;
    body = unavailable(
      copy.title,
      copy.description,
      original ? (
        <a className={buttonVariants({ variant: "tertiary" })} href={original} download rel="noopener noreferrer">
          <Download className="i" aria-hidden />
          Tải xuống
        </a>
      ) : (
        downloadButton
      ),
    );
  } else {
    const props: ViewerProps = {
      fileKey,
      representation: view.representation,
      refresh: preview.refresh,
      highlight: view.viewer === "text" ? (highlight ?? quoteHighlight) : highlight,
      regions,
      focusHit,
      onMarks: onViewerMarks,
      onDownload,
    };
    const viewer =
      view.viewer === "pdf" ? (
        <PdfViewer
          {...props}
          cover={cover?.imageUri ? cover : undefined}
          page={opensAt}
          bar={variant === "reader"}
          scrollRef={scrollRef}
          scroller={scroller}
          onPages={onViewerPages}
        />
      ) : view.viewer === "image" ? (
        <ImageView {...props} />
      ) : view.viewer === "table" ? (
        <TableView {...props} />
      ) : view.viewer === "text" ? (
        <TextView {...props} />
      ) : view.viewer === "media" ? (
        <MediaView {...props} />
      ) : (
        <ArchiveView {...props} />
      );
    body = (
      <Suspense key={fileKey} fallback={view.viewer === "pdf" ? loading : <SkeletonPage />}>
        {viewer}
      </Suspense>
    );
  }
  const quote = citation?.quote && marked === false ? <QuoteCard quote={citation.quote} where={locationLabel(citation)} /> : null;

  if (variant === "preview") {
    return (
      <div ref={rootRef} className={`pv-doc pv-doc--${view?.state === "READY" ? view.viewer : "pdf"}`}>
        {quote}
        {body}
      </div>
    );
  }
  return (
    <div ref={rootRef} className="doc-surface">
      {quote}
      {body}
    </div>
  );
}

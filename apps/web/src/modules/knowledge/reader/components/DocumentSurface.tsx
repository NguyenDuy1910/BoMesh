"use client";

import { Button, buttonVariants } from "@heroui/react";
import { Download } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { ErrorState } from "@/components/ui/ErrorState";
import { ApiError } from "@/lib/api/client";

import type { DocumentCover } from "../../api";
import type { CitedPassage } from "../marks";
import { coverFormat, surfaceView, UNAVAILABLE_COPY, type Viewer } from "../preview";
import { useItemPreview } from "../queries";
import { coverPages } from "./CoverPages";
import { NothingToShow, SkeletonPage } from "./ReaderParts";
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

/** Cited passages (`GetPassage`) and the reader's `?q=` to mark. Only processed documents have passages. */
export interface SurfaceHighlight {
  passages: readonly CitedPassage[];
  q: string;
  /** `q` is a quote (a citation's excerpt), matched as one phrase. */
  cited: boolean;
}

export interface SurfaceMarks {
  /** Marks drawn. */
  total: number;
  /** Cited passages this view could not place. */
  unresolved: number;
  /** The view is drawn, so the counts are final. */
  ready: boolean;
  /** `?q=` is marked in this view (the PDF, table and text viewers mark it). */
  searchable: boolean;
}

export type SurfaceVariant = "reader" | "preview" | "first";

export interface DocumentSurfaceProps {
  document: SurfaceDocument;
  /** Revision number to show; the current revision when empty. */
  revision?: string;
  /** `reader`: the viewer bar (page, zoom); `preview`: the quick preview; `first`: the first page only (review). */
  variant?: SurfaceVariant;
  /** The element that scrolls the document (default: the nearest scrolling ancestor). */
  scrollRef?: RefObject<HTMLElement | null>;
  highlight?: SurfaceHighlight;
  /** The mark to bring into view and emphasize. */
  focusHit?: number;
  /** `?page=`: the page to open on. */
  page?: number;
  onMarks?: (marks: SurfaceMarks) => void;
  /** Pages in the document, once known (the review pane's "Page 1 of N"). */
  onPages?: (count: number) => void;
  onDownload: () => void;
}

const NO_SURFACE_MARKS: SurfaceMarks = { total: 0, unresolved: 0, ready: false, searchable: false };
const SEARCHABLE: Readonly<Partial<Record<Viewer, true>>> = { pdf: true, table: true, text: true };

/**
 * The one document surface (document_viewer.md "Reading (web)"): reads `GetItemPreview` and branches
 * only on its `state` and the representation's `kind` — READY draws one of six viewers (PDF, image,
 * table, text, media, archive) given the representation's URL; PREPARING shows the cover as page 1 and
 * polls; UNAVAILABLE says why and offers the original. Used by the Reader, the quick preview, the
 * submission view and the review's first page. Nothing here depends on processing: cited passages and
 * `?q=` are marked when the caller passes them (processed documents only).
 */
export function DocumentSurface({ document: d, revision, variant = "reader", scrollRef, highlight, focusHit = -1, page, onMarks, onPages, onDownload }: DocumentSurfaceProps) {
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
        r && r.key === fileKey && r.total === m.total && r.unresolved === m.unresolved && r.ready === m.ready && r.focusPage === m.focusPage ? r : { ...m, key: fileKey },
      ),
    [fileKey],
  );
  const onViewerPages = useCallback((n: number) => callbacks.current.onPages?.(n), []);
  const viewerMarks = reported?.key === fileKey ? reported : undefined;
  const surfaceMarks: SurfaceMarks =
    view?.state === "READY" && viewerMarks
      ? { total: viewerMarks.total, unresolved: viewerMarks.unresolved, ready: viewerMarks.ready, searchable: !!SEARCHABLE[view.viewer] }
      : NO_SURFACE_MARKS;
  const { total, unresolved, ready: drawn, searchable } = surfaceMarks;
  useEffect(() => callbacks.current.onMarks?.({ total, unresolved, ready: drawn, searchable }), [total, unresolved, drawn, searchable]);

  /* ── Bring the focused mark (or `?page=`) into view: on open and on every step, not on re-renders ── */
  const first = useRef(true);
  const focusPage = viewerMarks?.focusPage;
  useEffect(() => {
    const sc = scroller;
    const root = rootRef.current;
    if (!sc || !root || !drawn) return;
    const mark = focusHit >= 0 ? root.querySelector<HTMLElement>(`mark.evidence[data-hit="${focusHit}"]`) : null;
    const where = mark ? undefined : focusHit >= 0 && focusPage ? focusPage : page;
    const target = mark ?? (where ? root.querySelector<HTMLElement>(`[data-page="${where}"]`) : null);
    if (!target) {
      if (first.current && variant === "preview") sc.scrollTop = 0;
      return;
    }
    const top = sc.scrollTop + target.getBoundingClientRect().top - sc.getBoundingClientRect().top - (mark ? sc.clientHeight / 3 : 24);
    sc.scrollTo({ top: Math.max(0, top), behavior: first.current ? "auto" : "smooth" });
    first.current = false;
  }, [scroller, drawn, focusHit, focusPage, page, total, variant]);

  /* ── What to draw ── */
  const loading = coverPages(cover, format) ?? <SkeletonPage />;
  const unavailable = (title: string, description: string, download: ReactNode) => (
    <>
      <NothingToShow title={title} description={description} actions={download} />
      {variant === "first" ? null : coverPages(cover, format, { loading: false })}
    </>
  );
  const downloadButton = (
    <Button variant="tertiary" onPress={onDownload}>
      <Download className="i" aria-hidden />
      Download
    </Button>
  );

  let body: ReactNode;
  if (preview.isPending) body = loading;
  else if (preview.isError) {
    const e = preview.error;
    if (e instanceof ApiError && e.code === "FAILED_PRECONDITION") body = unavailable("The file hasn’t arrived yet", "Its upload didn’t finish. Try again in a moment.", downloadButton);
    else if (e instanceof ApiError && e.status === 404 && revision) body = unavailable("This version isn’t available", "It may have been removed.", downloadButton);
    else body = <ErrorState title="This document didn’t load" error={e} onRetry={() => preview.refetch()} />;
  } else if (!view || view.state === "PREPARING") {
    body = (
      <>
        <p className="doc-gap doc-preparing" role="status">
          Preparing the preview…
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
          Download
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
      first: variant === "first",
      highlight,
      focusHit,
      onMarks: onViewerMarks,
      onDownload,
    };
    const viewer =
      view.viewer === "pdf" ? (
        <PdfViewer
          {...props}
          cover={cover?.imageUri ? cover : undefined}
          page={page}
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

  if (variant === "preview") {
    return (
      <div ref={rootRef} className={`pv-doc pv-doc--${view?.state === "READY" ? view.viewer : "pdf"}`}>
        {body}
      </div>
    );
  }
  return (
    <div ref={rootRef} className="doc-surface">
      {body}
    </div>
  );
}

/** The nearest ancestor that scrolls vertically (the reader canvas, the preview body, the review pane). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

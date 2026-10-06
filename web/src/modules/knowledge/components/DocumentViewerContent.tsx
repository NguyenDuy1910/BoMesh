"use client";

import { Copy, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  elementsRendition,
  isSpreadsheetType,
  loadRendition,
  renditionOutline,
  type DocumentRendition,
} from "../rendition";
import { citationPages, citationRegions, previewPages } from "../preview";
import type { KnowledgeItemViewer, ViewerCitation } from "../types";
import { DocumentRenditionView, RenditionDocument } from "./DocumentRenditionView";
import { SourcePageImage } from "./SourcePageImage";

/** One cited passage of this document, resolved: its citation, and for the passage the viewer was opened at, its text. */
export interface ViewedPassage {
  chunkId: string;
  citation: ViewerCitation | null;
  chunkText?: string | null;
}

/** How a readable document is drawn: its text (rendition) or its page images. */
export type DocumentView = "text" | "pages";

export interface OutlineItem {
  /** A `data-block-id` or `data-page` inside the canvas. */
  target: { blockId: string } | { page: number };
  title: string;
  level: 1 | 2;
}

/** Whether the person (or their BoMesh setting) asked for less motion. */
export function prefersReducedMotion(): boolean {
  return document.documentElement.dataset.reducedMotion === "true"
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function targetSelector(target: OutlineItem["target"]): string {
  return "blockId" in target ? `[data-block-id="${CSS.escape(target.blockId)}"]` : `[data-page="${target.page}"]`;
}

/**
 * The views this document offers, in order of preference. Text comes first
 * when there is a rendition: it can be searched, selected, quoted and marked
 * by element. Page images are offered beside it for a paged source.
 */
export function documentViews(viewer: KnowledgeItemViewer | undefined): DocumentView[] {
  const views: DocumentView[] = [];
  if (viewer?.preview?.rendition || viewer?.elements.length) views.push("text");
  if (previewPages(viewer?.preview).length) views.push("pages");
  return views;
}

/**
 * "On this page": the document's headings in text view, its pages in page
 * view. The rendition is read through the shared cache, so this never
 * downloads it a second time.
 */
export function useDocumentOutline(viewer: KnowledgeItemViewer | undefined, view: DocumentView | undefined): OutlineItem[] | null {
  const [document, setDocument] = useState<{ key: string; value: DocumentRendition }>();
  const rendition = viewer?.preview?.rendition;
  const key = viewer && rendition ? `${viewer.document_id}:${rendition.version}` : undefined;

  useEffect(() => {
    if (!viewer || !rendition || !key || view !== "text") return;
    const controller = new AbortController();
    void loadRendition(viewer.document_id, rendition, controller.signal)
      .then((value) => setDocument({ key, value }))
      .catch(() => undefined);
    return () => controller.abort();
  }, [key, rendition, view, viewer]);

  return useMemo(() => {
    if (!viewer || !view) return null;
    if (isSpreadsheetType(viewer.content_type)) return null;
    if (view === "pages") {
      return previewPages(viewer.preview).map((page) => ({ target: { page }, title: `Page ${page}`, level: 1 as const }));
    }
    const source = rendition ? (document && document.key === key ? document.value : undefined) : elementsRendition(viewer.elements);
    if (!source) return [];
    return renditionOutline(source).map((entry) => ({ target: { blockId: entry.id }, title: entry.title, level: entry.level }));
  }, [document, key, rendition, view, viewer]);
}

export function DocumentOutline({
  items,
  scrollRef,
  className,
}: {
  items: OutlineItem[];
  scrollRef: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const [active, setActive] = useState(0);

  // The heading a third of the way down the canvas is the one being read.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !items.length) return;
    let frame = 0;
    const track = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
        let on = 0;
        items.forEach((item, index) => {
          const element = scroller.querySelector(targetSelector(item.target));
          if (element && element.getBoundingClientRect().top <= line) on = index;
        });
        setActive(on);
      });
    };
    track();
    scroller.addEventListener("scroll", track, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", track);
    };
  }, [items, scrollRef]);

  const jump = (item: OutlineItem, index: number) => {
    const element = scrollRef.current?.querySelector(targetSelector(item.target));
    if (!element) return;
    setActive(index);
    element.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  return (
    <nav aria-label="Outline" className={className}>
      <p className="px-2.5 pb-1.5 text-caption font-medium text-text-tertiary">On this page</p>
      {items.length ? (
        <ul className="grid gap-px">
          {items.map((item, index) => (
            <li key={`${index}:${item.title}`}>
              <button
                aria-current={index === active ? "location" : undefined}
                className={cn(
                  "block w-full rounded-sm px-2.5 py-[5px] text-left text-[13px] leading-snug text-text-secondary",
                  "hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:shadow-(--shadow-focus)",
                  item.level === 2 && "pl-5",
                  index === active && "bg-surface-hover font-medium text-text-primary",
                )}
                onClick={() => jump(item, index)}
                type="button"
              >
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-2.5 text-[13px] text-text-tertiary">No headings</p>
      )}
    </nav>
  );
}

/**
 * The readable document: its rendition as pages (or the indexed passages of a
 * document from before renditions), or its page images with the cited
 * regions drawn on them.
 */
export function DocumentCanvas({
  viewer,
  view,
  passages,
  focusIndex,
  onRetry,
}: {
  viewer: KnowledgeItemViewer;
  view: DocumentView;
  passages: readonly ViewedPassage[];
  focusIndex: number;
  /** Re-read the viewer, which re-signs every URL. */
  onRetry: () => void;
}) {
  const preview = viewer.preview;
  const originalUrl = viewer.external_url || viewer.document_url || preview?.original.url;
  const pageCount = isSpreadsheetType(viewer.content_type) ? undefined : preview?.page_count;

  if (view === "pages" && preview) {
    return <PageImages focusIndex={focusIndex} onRetry={onRetry} passages={passages} viewer={viewer} />;
  }
  if (preview?.rendition) {
    return (
      <DocumentRenditionView
        contentType={viewer.content_type}
        focusIndex={focusIndex}
        itemId={viewer.document_id}
        layout="pages"
        onRetry={onRetry}
        originalUrl={originalUrl}
        pageCount={pageCount}
        passages={passages}
        rendition={preview.rendition}
      />
    );
  }
  return (
    <RenditionDocument
      contentType={viewer.content_type}
      document={elementsRendition(viewer.elements)}
      focusIndex={focusIndex}
      layout="pages"
      originalUrl={originalUrl}
      pageCount={pageCount}
      passages={passages}
    />
  );
}

function PageImages({
  viewer,
  passages,
  focusIndex,
  onRetry,
}: {
  viewer: KnowledgeItemViewer;
  passages: readonly ViewedPassage[];
  focusIndex: number;
  onRetry: () => void;
}) {
  const preview = viewer.preview!;
  const pages = previewPages(preview);
  const total = Math.max(preview.page_count ?? 0, pages.at(-1) ?? 0);
  const focusPage = citationPages(passages[focusIndex]?.citation ?? undefined)[0];
  const [failedPages, setFailedPages] = useState<ReadonlySet<number>>(new Set());
  // Signed URLs are short-lived: the first failure re-signs them once.
  const resigned = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onLoadFailed = useCallback((page: number) => {
    if (!resigned.current) {
      resigned.current = true;
      onRetry();
      return;
    }
    setFailedPages((current) => new Set(current).add(page));
  }, [onRetry]);

  useEffect(() => {
    if (focusPage === undefined) return;
    containerRef.current?.querySelector(`[data-page="${focusPage}"]`)?.scrollIntoView({ block: "start" });
  }, [focusPage]);

  return (
    <div ref={containerRef}>
      {pages.map((page) => {
        const regions = passages.flatMap((passage) =>
          citationRegions(passage.citation ?? undefined, page, preview));
        return (
          <div className="mx-auto mb-5 max-w-[820px] scroll-mt-6" key={page}>
            <SourcePageImage
              className="shadow-(--shadow-2)"
              failed={failedPages.has(page)}
              lazy={page !== focusPage}
              onLoadFailed={onLoadFailed}
              page={page}
              prefetch={false}
              preview={preview}
              regions={regions}
              title={viewer.title}
            />
            <p className="mt-2.5 text-center font-mono text-caption font-medium text-text-tertiary">
              Page {page}{total > 1 ? ` of ${total}` : ""}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Shortest and longest selection worth asking about (prototype). */
const SELECTION_MIN = 12;
const SELECTION_MAX = 800;

/**
 * Select any passage of the document to ask about it or copy it: a small
 * toolbar floats above the selection. It follows the selection, so it hides
 * when the selection collapses, on scroll and on Escape.
 */
export function SelectionAsk({
  containerRef,
  scrollRef,
  onAsk,
  onCopy,
}: {
  /** The positioned element the toolbar is placed in. */
  containerRef: RefObject<HTMLElement | null>;
  /** Where selections count, and whose scrolling hides the toolbar. */
  scrollRef: RefObject<HTMLElement | null>;
  onAsk: (text: string) => void;
  onCopy: (text: string) => void;
}) {
  const [selection, setSelection] = useState<{ text: string; left: number; top: number }>();
  const toolbarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    if (!scroller || !container) return;
    let timer = 0;
    const read = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = window.getSelection();
        const text = current?.toString().trim() ?? "";
        const range = current && current.rangeCount ? current.getRangeAt(0) : undefined;
        if (!range || text.length < SELECTION_MIN || text.length > SELECTION_MAX || !scroller.contains(range.commonAncestorContainer)) {
          setSelection(undefined);
          return;
        }
        const box = range.getBoundingClientRect();
        const frame = container.getBoundingClientRect();
        const width = toolbarRef.current?.offsetWidth ?? 220;
        setSelection({
          text,
          left: Math.max(8, Math.min(frame.width - width - 8, box.left - frame.left + box.width / 2 - width / 2)),
          top: Math.max(8, box.top - frame.top - 46),
        });
      }, 0);
    };
    const hide = () => setSelection(undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
      else if (event.shiftKey || event.key === "Shift") read();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) hide();
    };
    scroller.addEventListener("mouseup", read);
    scroller.addEventListener("keyup", onKey);
    scroller.addEventListener("scroll", hide, { passive: true });
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.clearTimeout(timer);
      scroller.removeEventListener("mouseup", read);
      scroller.removeEventListener("keyup", onKey);
      scroller.removeEventListener("scroll", hide);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [containerRef, scrollRef]);

  if (!selection) return null;
  return (
    <div
      aria-label="Selection actions"
      className="absolute z-40 flex animate-ui-pop gap-1 rounded-[10px] bg-surface-inverse p-1 shadow-(--shadow-pop) motion-reduce:animate-none"
      onKeyDown={(event) => {
        if (event.key === "Escape") setSelection(undefined);
      }}
      ref={toolbarRef}
      role="toolbar"
      style={{ left: selection.left, top: selection.top }}
    >
      <Button
        className="text-text-inverse hover:bg-surface-inverse-hover hover:text-text-inverse"
        icon={<Sparkles aria-hidden="true" size={15} />}
        onClick={() => onAsk(selection.text)}
        size="sm"
        variant="ghost"
      >
        Ask about this
      </Button>
      <Button
        className="text-text-inverse hover:bg-surface-inverse-hover hover:text-text-inverse"
        icon={<Copy aria-hidden="true" size={15} />}
        onClick={() => {
          onCopy(selection.text);
          setSelection(undefined);
        }}
        size="sm"
        variant="ghost"
      >
        Copy
      </Button>
    </div>
  );
}

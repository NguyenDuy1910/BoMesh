"use client";

import { memo, useEffect, useRef, useState, type ReactNode } from "react";

import type { Schema } from "@/lib/api/client";

import type { DocumentCover } from "../../api";
import { PAGED_FORMATS, type DocFormat } from "../format";

type ItemPageAsset = Schema<"ItemPageAsset">;

/** Pages mounted either side of the pages in view; the others are blanks of their exact size. */
const WINDOW = 2;

export interface PageImageViewProps {
  /** Page images of the current revision, in page order. */
  pages: readonly ItemPageAsset[];
  /** The page the reader is on (`?page=`, or a citation's page): always mounted, so it can be scrolled to. */
  focusPage?: number;
  /** The item's cover image (current revision only): drawn under page 1 until the page image paints over it. */
  coverUri?: string;
}

/**
 * The document exactly as it is (document_viewer.md "Reading (web)": *in the file's
 * native format … PDFs keep page images*). Ingestion renders one WebP per source page
 * beside the JSON rendition; this draws those pages, so a PDF keeps its own typography,
 * figures, formulas and layout instead of being reflowed into extracted text. The page
 * number is on the page itself; `data-n` feeds the viewer bar.
 *
 * Memory stays bounded however long the document: every page is a box of its exact size
 * (so the scrollbar, "Page n of N" and jumps to a page are right), but only the pages two
 * either side of those in view hold an image; scrolling away unmounts it.
 *
 * The rendition is still what the assistant cites and what search matches — it is the
 * *indexed* view of the same document, a separate concern from reading it.
 */
export function PageImageView({ pages, focusPage = 0, coverUri }: PageImageViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const focusIndex = Math.max(0, pages.findIndex((p, i) => (p.pageNumber ?? i + 1) === focusPage));
  // Indexes of the first and last page in view (viewport-clipped, so it works inside any scroller).
  const [inView, setInView] = useState<readonly [number, number]>([focusIndex, focusIndex]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.i);
        if (entry.isIntersecting) visible.add(index);
        else visible.delete(index);
      }
      if (!visible.size) return;
      let lo = Infinity;
      let hi = -1;
      for (const i of visible) {
        lo = Math.min(lo, i);
        hi = Math.max(hi, i);
      }
      setInView((cur) => (cur[0] === lo && cur[1] === hi ? cur : [lo, hi]));
    });
    for (const el of root.querySelectorAll<HTMLElement>(".doc-page[data-i]")) observer.observe(el);
    return () => observer.disconnect();
  }, [pages]);

  return (
    <div ref={rootRef} style={{ display: "contents" }}>
      {pages.map((page, index) => {
        const no = page.pageNumber ?? index + 1;
        return (
          <PageImage
            key={`${no}:${index}`}
            index={index}
            uri={page.imageUri!}
            no={no}
            width={page.widthPixels ?? undefined}
            height={page.heightPixels ?? undefined}
            mounted={(index >= inView[0] - WINDOW && index <= inView[1] + WINDOW) || (focusPage > 0 && index === focusIndex)}
            placeholder={index === 0 ? coverUri : undefined}
          />
        );
      })}
    </div>
  );
}

const PageImage = memo(function PageImage({
  index,
  uri,
  no,
  width,
  height,
  mounted,
  placeholder,
}: {
  index: number;
  uri: string;
  no: number;
  width?: number;
  height?: number;
  mounted: boolean;
  placeholder?: string;
}) {
  // A known size keeps the box exact whether or not the image is mounted; without one, a letter page stands in until it is.
  const aspectRatio = width && height ? `${width} / ${height}` : mounted ? undefined : "8.5 / 11";
  return (
    <div
      className="doc-page doc-page--image"
      data-page={no}
      data-n={no}
      data-i={index}
      style={{ aspectRatio, backgroundImage: placeholder ? `url("${placeholder}")` : undefined }}
    >
      {mounted ? (
        <>
          {/* Not next/image: these are signed URLs on the storage host, which the optimizer cannot cache. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="doc-page__img" src={uri} alt={`Page ${no}`} width={width} height={height} decoding="async" draggable={false} />
        </>
      ) : null}
    </div>
  );
});

/**
 * The cover the list already had (no extra request; its image is in the browser cache from the card),
 * drawn as the document's first page at reading size: its image, else its text in the format's shape —
 * a page with the title and first lines, a slide with its title and bullets, the first sheet's top-left
 * cells (preview reader.js `coverPages`). While the content and pages or rendition load (`loading`), a
 * paged document gets a sized blank after it, so nothing moves when they arrive; without a rendition
 * (`loading: false`) it stays under the not-ready message. `null` without a cover to draw.
 */
export function coverPages(cover: DocumentCover | undefined, format: DocFormat, { loading = true }: { loading?: boolean } = {}): ReactNode {
  if (!cover || cover.kind === "IMAGE") return null;
  const busy = loading ? ({ "aria-busy": true, "aria-label": "Loading" } as const) : {};
  if (cover.imageUri) {
    const aspectRatio = cover.widthPixels && cover.heightPixels ? `${cover.widthPixels} / ${cover.heightPixels}` : cover.kind === "SLIDE" ? "16 / 9" : "8.5 / 11";
    return (
      <div className={`doc-viewer doc-viewer--${PAGED_FORMATS[format] ? format : "pdf"}`} {...busy}>
        <div className="doc-viewer__pages" translate="no">
          <div className="doc-page doc-page--image doc-page--cover" style={{ aspectRatio }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the card's cover, already cached */}
            <img className="doc-page__img" src={cover.imageUri} alt="" width={cover.widthPixels} height={cover.heightPixels} decoding="async" draggable={false} />
          </div>
          {loading ? <div className="doc-page doc-page--image doc-page--blank" style={{ aspectRatio }} /> : null}
        </div>
      </div>
    );
  }
  const lines = cover.lines ?? [];
  const cells = cover.cells ?? [];
  const title = cover.title ? <h2>{cover.title}</h2> : null;
  if (cover.kind === "SHEET" && cells.length) {
    const cols = Math.max(...cells.map((row) => row.length));
    return (
      <div className="doc-viewer doc-viewer--sheet" translate="no" {...busy}>
        <div className="doc-page doc-page--sheet doc-page--cover">
          <div className="doc-sheet">
            <table>
              <thead>
                <tr>
                  <th className="doc-sheet__rn" />
                  {Array.from({ length: cols }, (_, j) => (
                    <th key={j}>{String.fromCharCode(65 + j)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cells.map((row, i) => (
                  <tr key={i} className={i ? undefined : "doc-sheet__hdr"}>
                    <td className="doc-sheet__rn">{i + 1}</td>
                    {Array.from({ length: cols }, (_, j) => (
                      <td key={j}>{row[j] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }
  if (!title && !lines.length) return null;
  const slide = cover.kind === "SLIDE";
  const pageClass = slide ? "doc-page--slide" : `doc-page--${format}`;
  const first = (
    <div className={`doc-page ${pageClass} doc-page--cover`}>
      {title}
      {slide ? (
        lines.length ? (
          <ul>
            {lines.slice(0, 5).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null
      ) : (
        lines.map((l, i) => <p key={i}>{l}</p>)
      )}
    </div>
  );
  if (!PAGED_FORMATS[format] && !slide) {
    return (
      <article className={`doc-viewer doc-viewer--flow doc-viewer--${format}`} translate="no" {...busy}>
        {first}
      </article>
    );
  }
  return (
    <div className={`doc-viewer doc-viewer--${slide ? "slide" : format}`} {...busy}>
      <div className="doc-viewer__pages" translate="no">
        {first}
        {loading ? <div className={`doc-page ${pageClass} doc-page--blank`} /> : null}
      </div>
    </div>
  );
}

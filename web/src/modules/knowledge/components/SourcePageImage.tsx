"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { pagesToPrefetch, previewPage, regionStyle } from "../preview";
import type { KnowledgePreview, ViewerBoundingBox } from "../types";

/**
 * One rendered page of a source, with the cited regions drawn over it.
 *
 * Shared by the chat source panel (one page at a time, neighbours kept warm in
 * the browser cache so paging feels immediate) and the document viewer (every
 * page stacked, each loaded as it nears the screen).
 */
export function SourcePageImage({
  className,
  failed,
  lazy = false,
  onLoadFailed,
  page,
  prefetch = true,
  preview,
  regions = [],
  title,
  zoom,
}: {
  preview: KnowledgePreview;
  page: number;
  title: string;
  /** Citation regions on this page, as page fractions. */
  regions?: ViewerBoundingBox[];
  /** Percent of the reading width; omitted to fill the container. */
  zoom?: number;
  /** This page could not be loaded even with fresh URLs. */
  failed: boolean;
  onLoadFailed: (page: number) => void;
  /** Load the image only as it nears the screen (a stack of pages). */
  lazy?: boolean;
  /** Warm the neighbouring pages (one page shown at a time). */
  prefetch?: boolean;
  className?: string;
}) {
  // A page that has not painted yet must not carry a highlight over blank space.
  const [renderedPage, setRenderedPage] = useState<number>();
  const asset = previewPage(preview, page);
  if (!asset) return null;

  return (
    <>
      <div
        className={cn("source-preview__page", className)}
        data-page={page}
        style={{
          aspectRatio: `${asset.width} / ${asset.height}`,
          ...(zoom === undefined ? {} : { width: `calc(min(100%, 52rem) * ${zoom / 100})`, marginInline: "auto" }),
        }}
      >
        <img
          alt={`${title}, page ${page}`}
          className="source-preview__image"
          // Keyed by page, not by URL: moving to another page remounts so a
          // slow image cannot paint over a newer one, while a refreshed URL
          // for the page on screen swaps in without blanking it.
          key={page}
          loading={lazy ? "lazy" : undefined}
          onError={() => onLoadFailed(page)}
          onLoad={() => setRenderedPage(page)}
          src={asset.url}
        />
        {renderedPage !== page && !failed && (
          <span className="source-preview__page-loading" role="status">
            <LoaderCircle aria-hidden="true" className="source-preview__spinner" size={16} />
            <span className="sr-only">Loading page {page}</span>
          </span>
        )}
        {failed && (
          <span className="source-preview__page-loading" role="alert">
            This page didn’t load.
          </span>
        )}
        {renderedPage === page
          && regions.map((region) => (
            <span
              aria-hidden="true"
              className="source-preview__highlight"
              data-cited-region
              key={`${region.x}:${region.y}:${region.width}:${region.height}`}
              style={regionStyle(region)}
            />
          ))}
      </div>
      {prefetch && pagesToPrefetch(preview, page).map((target) => {
        const upcoming = previewPage(preview, target);
        return upcoming ? (
          <img alt="" aria-hidden="true" className="source-preview__prefetch" key={upcoming.url} src={upcoming.url} />
        ) : null;
      })}
    </>
  );
}

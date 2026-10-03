"use client";

import { ChevronLeft, ChevronRight, Minus, Plus, Search, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";

const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;

/**
 * Page, zoom and find, floating over the stage.
 *
 * It sits above the document rather than in a bar below it so the reader's
 * eye stays on the page, and it collapses into the find field when searching
 * — one floating object, never two.
 */
export function DocumentPager({
  page = 1,
  pageCount = 1,
  zoom,
  search = "",
  onPageChange,
  onZoomChange,
  onSearchChange,
}: {
  /** Paging shows only with more than one page and a handler. */
  page?: number;
  pageCount?: number;
  onPageChange?: (page: number) => void;
  /** Zoom shows only for a view that can be zoomed. */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** Find shows only for a view that can be searched. */
  search?: string;
  onSearchChange?: (value: string) => void;
}) {
  const [finding, setFinding] = useState(false);

  if (onSearchChange && (finding || search)) {
    return (
      <div className="knowledge-pager knowledge-pager--finding" role="search">
        <Search aria-hidden="true" size={16} />
        <input
          aria-label="Find in document"
          autoFocus
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onSearchChange("");
            setFinding(false);
          }}
          placeholder="Find in document…"
          type="search"
          value={search}
        />
        <Button
          aria-label="Close find"
          icon={<X size={16} />}
          iconOnly
          onClick={() => {
            onSearchChange("");
            setFinding(false);
          }}
          size="sm"
          variant="ghost"
        />
      </div>
    );
  }

  return (
    <div className="knowledge-pager">
      {onPageChange && pageCount > 1 && (
        <div className="knowledge-pager__group">
          <Button
            aria-label="Previous page"
            disabled={page <= 1}
            icon={<ChevronLeft size={16} />}
            iconOnly
            onClick={() => onPageChange(page - 1)}
            size="sm"
            variant="ghost"
          />
          <span aria-live="polite">{page} / {pageCount}</span>
          <Button
            aria-label="Next page"
            disabled={page >= pageCount}
            icon={<ChevronRight size={16} />}
            iconOnly
            onClick={() => onPageChange(page + 1)}
            size="sm"
            variant="ghost"
          />
        </div>
      )}
      {onZoomChange && zoom !== undefined && (
        <div className="knowledge-pager__group">
          <Button
            aria-label="Zoom out"
            disabled={zoom <= ZOOM_MIN}
            icon={<Minus size={16} />}
            iconOnly
            onClick={() => onZoomChange(zoom - ZOOM_STEP)}
            size="sm"
            variant="ghost"
          />
          <span>{zoom}%</span>
          <Button
            aria-label="Zoom in"
            disabled={zoom >= ZOOM_MAX}
            icon={<Plus size={16} />}
            iconOnly
            onClick={() => onZoomChange(zoom + ZOOM_STEP)}
            size="sm"
            variant="ghost"
          />
        </div>
      )}
      {onSearchChange && (
        <Tooltip label="Find in document" side="top">
          <Button
            aria-label="Find in document"
            icon={<Search size={16} />}
            iconOnly
            onClick={() => setFinding(true)}
            size="sm"
            variant="ghost"
          />
        </Tooltip>
      )}
    </div>
  );
}

"use client";

import { X } from "lucide-react";

import { Button } from "@/components/ui/Button";

/**
 * What a selection can have done to it.
 *
 * The bar replaces nothing and pushes nothing around: it takes the strip above
 * the rows only while a selection exists. Remove is separated from the
 * reversible action and confirmed elsewhere, so the destructive one is never
 * the neighbour of the routine one. Retrying only ever touches the failed
 * documents in a selection, so it says how many that is.
 */
export function DocumentBulkBar({
  count,
  retryableCount,
  onRetryIndexing,
  onRemove,
  onClear,
}: {
  count: number;
  retryableCount: number;
  onRetryIndexing: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  return (
    <div className="knowledge-bulk-bar" role="status">
      <span>{count} {count === 1 ? "document" : "documents"} selected</span>
      <Button
        disabled={!retryableCount}
        onClick={onRetryIndexing}
        size="sm"
        title={retryableCount ? undefined : "Only documents that failed to index can be retried"}
        variant="ghost"
      >
        {retryableCount && retryableCount < count
          ? `Retry indexing (${retryableCount})`
          : "Retry indexing"}
      </Button>
      <Button className="text-[var(--status-danger-text)] hover:bg-[var(--status-danger-bg)]" onClick={onRemove} size="sm" variant="ghost">
        Remove
      </Button>
      <Button
        aria-label="Clear selection"
        icon={<X size={16} />}
        iconOnly
        onClick={onClear}
        size="sm"
        variant="ghost"
      />
    </div>
  );
}

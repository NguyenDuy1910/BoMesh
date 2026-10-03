"use client";

import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/Button";

/**
 * What a selection can have done to it.
 *
 * The bar replaces nothing and pushes nothing around: it takes the strip above
 * the rows only while a selection exists. Remove is separated from the
 * reversible action and confirmed elsewhere, so the destructive one is never
 * the neighbour of the routine one. Re-index sends the whole selection; the
 * backend refuses what it cannot re-index and says why.
 */
export function DocumentBulkBar({
  count,
  onReindex,
  onRemove,
  onClear,
}: {
  count: number;
  onReindex: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  return (
    <div className="knowledge-bulk-bar" role="status">
      <span>{count.toLocaleString()} {count === 1 ? "document" : "documents"} selected</span>
      <Button
        icon={<RefreshCw size={14} />}
        onClick={onReindex}
        size="sm"
        title="Index again from the stored file, with the current models"
        variant="ghost"
      >
        Re-index
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

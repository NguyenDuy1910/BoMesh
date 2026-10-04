"use client";

import { Play, X } from "lucide-react";

import { Button } from "@/components/ui/Button";

/**
 * What a selection can have done to it.
 *
 * The bar takes the strip above the rows only while a selection exists. Run
 * processing is its one primary action; Delete is set apart and confirmed
 * elsewhere, so the destructive action is never the neighbour of the routine
 * one. The backend leaves out what is already being processed and says so.
 */
export function DocumentBulkBar({
  count,
  processing,
  onProcess,
  onRemove,
  onClear,
}: {
  count: number;
  /** A run is being created for this selection. */
  processing: boolean;
  /** Omitted when the caller may not start a run. */
  onProcess?: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  return (
    <div className="knowledge-bulk-bar" role="status">
      <span>{count.toLocaleString()} {count === 1 ? "item" : "items"} selected</span>
      {onProcess && (
        <Button icon={<Play size={14} />} loading={processing} onClick={onProcess} size="sm">
          Make searchable
        </Button>
      )}
      <Button className="text-[var(--status-danger-text)] hover:bg-[var(--status-danger-bg)]" onClick={onRemove} size="sm" variant="ghost">
        Delete
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

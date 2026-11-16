"use client";

import { X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "./IconButton";

export interface BulkBarProps {
  /** Selected rows; nothing renders at 0. */
  count: number;
  onClear: () => void;
  /** Replaces "N selected" (preview `bulkBar(…, label)`, e.g. "All matching selected"). */
  label?: string;
  /** The batch actions (buttons). */
  children: ReactNode;
}

/** Floating bulk-action bar (preview `bulkBar()`): "N selected", the actions, and Clear selection. */
export function BulkBar({ count, onClear, label, children }: BulkBarProps) {
  if (!count) return null;
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-bar__count">{label || `${count} selected`}</span>
      {children}
      <IconButton icon={X} tip="Clear selection" size="sm" onPress={onClear} />
    </div>
  );
}

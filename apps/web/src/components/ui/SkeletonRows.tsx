import { Skeleton } from "@heroui/react";

import { useMessages } from "@/lib/i18n";

export interface SkeletonRowsProps {
  /** Number of placeholder rows (default 6). */
  rows?: number;
  /** Rows only, without the table surface: for lists already inside a box (a dialog's list field). */
  unboxed?: boolean;
}

/**
 * Structure-preserving loading for tables and lists (preview `skelRows()`):
 * icon tile, two text lines and a trailing meta per row, inside the table surface.
 */
export function SkeletonRows({ rows = 6, unboxed = false }: SkeletonRowsProps) {
  const m = useMessages();
  return (
    <div className={unboxed ? "skeleton-rows skeleton-rows--unboxed" : "table-root table-root--primary skeleton-rows"} aria-busy="true" aria-label={m.common.loading}>
      <div className="skeleton-rows__body">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton-rows__row">
            <Skeleton className="skeleton-rows__lead" />
            <div className="grow stack gap-6">
              <Skeleton className="skeleton--line" style={{ width: `${30 + ((i * 17) % 35)}%` }} />
              <Skeleton className="skeleton--line" style={{ width: `${18 + ((i * 11) % 20)}%`, height: 10 }} />
            </div>
            <Skeleton className="skeleton--line hide-sm" style={{ width: 72 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

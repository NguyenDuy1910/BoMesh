import { Skeleton } from "@heroui/react";

export interface SkeletonRowsProps {
  /** Number of placeholder rows (default 6). */
  rows?: number;
}

/**
 * Structure-preserving loading for tables and lists (preview `skelRows()`):
 * icon tile, two text lines and a trailing meta per row, inside the table surface.
 */
export function SkeletonRows({ rows = 6 }: SkeletonRowsProps) {
  return (
    <div className="table-root table-root--primary skeleton-rows" aria-busy="true" aria-label="Loading">
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

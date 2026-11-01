import { cn } from "@/lib/cn";

/** A single neutral placeholder block that shimmers (static under reduced motion). */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block rounded-[var(--radius-sm)] bg-[var(--surface-inset)]",
        "motion-safe:animate-ui-shimmer motion-safe:bg-[linear-gradient(90deg,var(--surface-inset)_0%,var(--surface-hover)_40%,var(--surface-inset)_80%)] motion-safe:bg-[length:200%_100%]",
        className,
      )}
      style={style}
    />
  );
}

/**
 * Loading rows for a table or list whose rows are not known yet. Extra
 * columns hide at narrow widths like the DataTable columns they stand in for.
 */
export function SkeletonRows({
  rows = 6,
  columns = 4,
  label = "Loading",
  className,
}: {
  rows?: number;
  /** Including the leading icon+title cell. */
  columns?: number;
  /** Announced to assistive technology, e.g. "Loading members". */
  label?: string;
  className?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={cn(
        "@container overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)]",
        className,
      )}
      role="status"
    >
      {Array.from({ length: rows }, (_, row) => (
        <div
          className="flex items-center gap-4 border-b border-[var(--border-subtle)] p-4 last:border-b-0"
          key={row}
        >
          <Skeleton className="h-8 w-8 shrink-0 rounded-[var(--radius-md)]" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3" style={{ width: `${30 + ((row * 17) % 35)}%` }} />
            <Skeleton className="h-2.5" style={{ width: `${18 + ((row * 11) % 20)}%` }} />
          </div>
          {Array.from({ length: Math.max(0, columns - 2) }, (_, column) => (
            <Skeleton
              className="hidden h-3 shrink-0 @[640px]:block"
              key={column}
              style={{ width: 60 + ((column * 23 + row * 7) % 50) }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Loading cards for a grid (knowledge bases, connectors). */
export function SkeletonCards({
  count = 6,
  label = "Loading",
  className,
}: {
  count?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3", className)}
      role="status"
    >
      {Array.from({ length: count }, (_, card) => (
        <div
          className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-[var(--border-subtle)] bg-[var(--surface-base)] px-[18px] py-4"
          key={card}
        >
          <Skeleton className="h-9 w-9 rounded-[var(--radius-md)]" />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-2.5 w-[85%]" />
          <Skeleton className="h-2.5 w-2/5" />
        </div>
      ))}
    </div>
  );
}

/**
 * The loading treatment for page content whose shape is not known yet.
 *
 * It shows page rhythm, not a replica of the data: a few neutral blocks, and
 * — only when the real ones are not already on screen — a heading and a
 * control row. Pages that know they are loading a list use `SkeletonRows` or
 * `SkeletonCards` instead.
 */
export function PageLoadingSkeleton({
  label = "Loading",
  heading = false,
  controls = false,
  className,
}: {
  /** Announced to assistive technology, e.g. "Loading members". */
  label?: string;
  /** The page header is not rendered yet (route-level and session loading). */
  heading?: boolean;
  /** The page's toolbar is not rendered yet. */
  controls?: boolean;
  className?: string;
}) {
  return (
    <section aria-busy="true" aria-label={label} className={cn("flex w-full flex-col gap-5", className)} role="status">
      <span className="sr-only">{label}</span>
      {heading && (
        <div aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
      )}
      {controls && <Skeleton className="h-[var(--control-md)] w-full max-w-md rounded-[var(--radius-md)]" />}
      <div aria-hidden="true" className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full rounded-[var(--radius-lg)]" />
        <Skeleton className="h-16 w-full rounded-[var(--radius-lg)]" />
        <Skeleton className="h-16 w-full rounded-[var(--radius-lg)]" />
        <Skeleton className="h-16 w-2/3 rounded-[var(--radius-lg)]" />
      </div>
    </section>
  );
}

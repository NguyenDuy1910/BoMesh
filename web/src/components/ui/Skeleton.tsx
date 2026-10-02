import { cn } from "@/lib/cn";

/** A single neutral placeholder block, for a small inline load inside a component. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("ctl-skeleton", className)} />;
}

/**
 * The one loading treatment for page content whose shape is not known yet.
 *
 * It shows page rhythm, not a replica of the data: a few neutral blocks, and
 * — only when the real ones are not already on screen — a heading and a
 * control row. Pages keep their real header, tabs and toolbar visible and
 * pass neither flag, so only the unknown content is a placeholder. There is
 * deliberately no row count or column layout to tune: a skeleton that mirrors
 * a list goes stale the moment the list changes.
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
    <section aria-busy="true" aria-label={label} className={cn("page-skeleton", className)} role="status">
      <span className="sr-only">{label}</span>
      {heading && (
        <div aria-hidden="true" className="page-skeleton__heading">
          <Skeleton className="h-6 w-44" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
      )}
      {controls && <Skeleton className="page-skeleton__controls" />}
      <div aria-hidden="true" className="page-skeleton__blocks">
        <Skeleton className="page-skeleton__block" />
        <Skeleton className="page-skeleton__block" />
        <Skeleton className="page-skeleton__block" />
        <Skeleton className="page-skeleton__block page-skeleton__block--short" />
      </div>
    </section>
  );
}

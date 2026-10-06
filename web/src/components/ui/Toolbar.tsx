import { cn } from "@/lib/cn";

export interface ToolbarProps {
  /** Usually a `SearchInput`; 280px wide, full width on narrow screens. */
  search?: React.ReactNode;
  /** `FilterChip`s, a sort control, then `ClearFilters`. */
  filters?: React.ReactNode;
  /** Pushed to the right edge: a view switch, a live count, the primary action. */
  end?: React.ReactNode;
  className?: string;
}

/** The row above a list: search left, filters next to it, everything else right. */
export function Toolbar({ search, filters, end, className }: ToolbarProps) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center gap-2", className)}>
      {search && <div className="w-full max-w-full min-[861px]:w-[280px]">{search}</div>}
      {filters}
      {end && (
        <>
          <span aria-hidden="true" className="flex-1" />
          <div className="flex flex-wrap items-center gap-2">{end}</div>
        </>
      )}
    </div>
  );
}

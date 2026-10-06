import { Inbox } from "lucide-react";

import { cn } from "@/lib/cn";

interface EmptyStateProps {
  /** A lucide icon; defaults to an inbox. */
  icon?: React.ReactNode;
  /** `err` and `ok` tint the icon tile; ErrorState uses `err`. */
  tone?: "neutral" | "err" | "ok";
  title: string;
  /** Say what this surface will hold and what to do next — never "No data". */
  description?: React.ReactNode;
  /** The action that resolves the emptiness, plus at most one alternative. */
  action?: React.ReactNode;
  /** `sm` sits inside a section or table, `md` inside a card, `lg` (default) stands in for a page. */
  size?: "sm" | "md" | "lg";
  /** A dashed outline, for an empty region that is still a drop or fill target. */
  boxed?: boolean;
  className?: string;
}

const sizeClass = {
  sm: "px-4 py-8",
  md: "px-6 py-10",
  lg: "px-6 py-14",
} as const;

const toneClass = {
  neutral: "bg-[var(--surface-inset)] text-[var(--text-secondary)]",
  err: "bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]",
  ok: "bg-[var(--status-success-bg)] text-[var(--status-success-text)]",
} as const;

/** The one empty (and, through ErrorState, failed) state for lists, panels and pages. */
export function EmptyState({
  icon,
  tone = "neutral",
  title,
  description,
  action,
  size = "lg",
  boxed = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        boxed && "rounded-[var(--radius-lg)] border border-dashed border-[var(--border-default)]",
        className,
      )}
    >
      <div
        className={cn("mx-auto flex max-w-[440px] flex-col items-center text-center", sizeClass[size])}
        role={tone === "err" ? "alert" : "status"}
      >
        <span
          aria-hidden="true"
          className={cn(
            "mb-4 grid place-items-center rounded-[var(--radius-sheet)] [&_svg]:h-5 [&_svg]:w-5",
            size === "sm" ? "h-10 w-10" : "h-12 w-12",
            toneClass[tone],
          )}
        >
          {icon ?? <Inbox />}
        </span>
        <h3 className="text-balance text-base font-semibold text-[var(--text-primary)]">{title}</h3>
        {description && (
          <div className="mt-1.5 text-pretty text-[length:var(--text-size-body)] text-[var(--text-secondary)]">
            {description}
          </div>
        )}
        {action && <div className="mt-[18px] flex flex-wrap justify-center gap-2">{action}</div>}
      </div>
    </div>
  );
}

import { cn } from "@/lib/cn";

const fillClass = {
  accent: "bg-[var(--accent-primary)]",
  ok: "bg-[var(--status-success-text)]",
  err: "bg-[var(--status-danger-text)]",
} as const;

interface ProgressProps {
  /** 0–100. Omit for indeterminate progress (work started, size unknown). */
  value?: number;
  /** Accessible name; also shown above the bar with `showLabel`. */
  label: string;
  /** Shown at the right of the label row; defaults to the rounded percentage. */
  valueText?: string;
  showLabel?: boolean;
  /** Defaults to `accent`; `ok` for finished, `err` for stopped with failures. */
  tone?: keyof typeof fillClass;
  className?: string;
}

/** A thin progress bar for syncs, uploads and processing. */
export function Progress({ value, label, valueText, showLabel = false, tone = "accent", className }: ProgressProps) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  const percent = determinate ? Math.min(100, Math.max(0, value)) : 0;
  const text = valueText ?? (determinate ? `${Math.round(percent)}%` : undefined);

  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)}>
      {showLabel && (
        <div className="flex items-baseline justify-between gap-3 text-[length:var(--text-size-meta)]">
          <span className="truncate text-[var(--text-secondary)]">{label}</span>
          {text && <span className="shrink-0 tabular-nums text-[var(--text-tertiary)]">{text}</span>}
        </div>
      )}
      <div
        aria-label={label}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuemin={determinate ? 0 : undefined}
        aria-valuenow={determinate ? Math.round(percent) : undefined}
        aria-valuetext={determinate ? text : "In progress"}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-inset)]"
        role="progressbar"
      >
        {determinate ? (
          <span
            className={cn(
              "block h-full rounded-full transition-[width] duration-[var(--duration-slow)] ease-[var(--ease-standard)]",
              fillClass[tone],
            )}
            // A sliver stays visible at 0 so the bar reads as started, not broken.
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        ) : (
          <span
            className={cn(
              "block h-full w-full rounded-full bg-[var(--accent-soft-hover)]",
              "motion-safe:animate-ui-shimmer motion-safe:bg-[linear-gradient(90deg,transparent_0%,var(--accent-primary)_50%,transparent_100%)] motion-safe:bg-[length:200%_100%]",
            )}
          />
        )}
      </div>
    </div>
  );
}

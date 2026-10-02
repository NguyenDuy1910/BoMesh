import { cn } from "@/lib/cn";

export type StatusTone = "neutral" | "success" | "info" | "warning" | "danger" | "accent";

const TONE: Record<StatusTone, { shell: string; dot: string }> = {
  neutral: {
    shell: "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-text)] ring-[var(--status-neutral-border)]",
    dot: "bg-[var(--status-neutral-solid)]",
  },
  success: {
    shell: "bg-[var(--status-success-bg)] text-[var(--status-success-text)] ring-[var(--status-success-border)]",
    dot: "bg-[var(--status-success-solid)]",
  },
  info: {
    shell: "bg-[var(--status-info-bg)] text-[var(--status-info-text)] ring-[var(--status-info-border)]",
    dot: "bg-[var(--status-info-solid)]",
  },
  warning: {
    shell: "bg-[var(--status-warning-bg)] text-[var(--status-warning-text)] ring-[var(--status-warning-border)]",
    dot: "bg-[var(--status-warning-solid)]",
  },
  danger: {
    shell: "bg-[var(--status-danger-bg)] text-[var(--status-danger-text)] ring-[var(--status-danger-border)]",
    dot: "bg-[var(--status-danger-solid)]",
  },
  accent: {
    shell: "bg-[var(--accent-soft)] text-[var(--text-accent)] ring-[var(--status-neutral-border)]",
    dot: "bg-[var(--accent-primary)]",
  },
};

/**
 * The one visual for state — a row's lifecycle, a run's outcome, an account's
 * health. Every page renders state through this, so "Failed" in Knowledge and
 * "Failed" in Activity are the same object. At most one per row; counts and
 * metadata use `Badge` instead.
 *
 * `pulse` marks work still in progress (syncing, indexing). The label says
 * so too, so the motion is never the only signal.
 */
export function StatusPill({
  tone = "neutral",
  pulse = false,
  children,
  className,
}: {
  tone?: StatusTone;
  pulse?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const { shell, dot } = TONE[tone];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-full)] py-0.5 pl-2 pr-2.5",
        "text-[length:var(--text-size-meta)] font-medium leading-[var(--text-lh-meta)] ring-1 ring-inset",
        shell,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dot, pulse && "motion-safe:animate-pulse")} />
      {children}
    </span>
  );
}

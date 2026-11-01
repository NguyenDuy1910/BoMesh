import { cn } from "@/lib/cn";

export type BadgeTone = "ok" | "warn" | "err" | "info" | "neutral" | "accent" | "outline";

const TONE: Record<BadgeTone, { pill: string; text: string }> = {
  ok: {
    pill: "bg-[var(--status-success-bg)] text-[var(--status-success-text)]",
    text: "text-[var(--status-success-text)]",
  },
  warn: {
    pill: "bg-[var(--status-warning-bg)] text-[var(--status-warning-text)]",
    text: "text-[var(--status-warning-text)]",
  },
  err: {
    pill: "bg-[var(--status-danger-bg)] text-[var(--status-danger-text)]",
    text: "text-[var(--status-danger-text)]",
  },
  info: {
    pill: "bg-[var(--status-info-bg)] text-[var(--status-info-text)]",
    text: "text-[var(--status-info-text)]",
  },
  neutral: {
    pill: "bg-[var(--status-neutral-bg)] text-[var(--status-neutral-text)]",
    text: "text-[var(--status-neutral-text)]",
  },
  accent: {
    pill: "bg-[var(--accent-soft)] text-[var(--text-accent)]",
    text: "text-[var(--text-accent)]",
  },
  outline: {
    pill: "bg-transparent text-[var(--text-secondary)] shadow-[inset_0_0_0_1px_var(--border-default)]",
    text: "text-[var(--text-tertiary)]",
  },
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** Leading dot in the tone's colour. On by default; an `icon` replaces it. */
  dot?: boolean;
  /** Work still moving: the dot pulses (never the only signal — say it in the label). */
  live?: boolean;
  /** Healthy steady state: a quiet dot and text, no pill background. */
  plain?: boolean;
  /** Dense lists: only the dot shows; the label stays for screen readers. */
  dotOnly?: boolean;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * Status only — at most one per row. Metadata (types, counts, capabilities)
 * uses `Tag`. Most callers want `StatusBadge`, which picks tone and wording
 * from the shared vocabulary.
 */
export function Badge({
  tone = "neutral",
  dot = true,
  live = false,
  plain = false,
  dotOnly = false,
  icon,
  title,
  className,
  children,
}: BadgeProps) {
  const colours = TONE[tone];
  const marker = icon ? (
    <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-[13px]">{icon}</span>
  ) : dot ? (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        (plain || dotOnly) && colours.text,
        live && "motion-safe:animate-pulse",
      )}
    />
  ) : null;

  if (dotOnly) {
    return (
      <span className={cn("inline-flex shrink-0 items-center", className)} title={title ?? (typeof children === "string" ? children : undefined)}>
        {marker}
        <span className="sr-only">{children}</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap",
        plain
          ? "text-[13.5px] font-normal leading-5 text-[var(--text-secondary)]"
          : cn(
              "h-[22px] rounded-[var(--radius-full)] px-2 text-[length:var(--text-size-caption)] font-medium leading-4",
              colours.pill,
            ),
        className,
      )}
      title={title}
    >
      {marker}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

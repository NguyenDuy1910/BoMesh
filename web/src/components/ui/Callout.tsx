import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/lib/cn";

export type CalloutTone = "info" | "ok" | "warn" | "err" | "neutral";

interface CalloutProps {
  /** Defaults to `info`. Status tones only — evidence amber is reserved for citations. */
  tone?: CalloutTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** Buttons at the right; at most one should be primary on the page. */
  actions?: React.ReactNode;
  /** Replaces the tone's icon. */
  icon?: React.ReactNode;
  className?: string;
}

const toneClass: Record<CalloutTone, { box: string; icon: string }> = {
  info: {
    box: "border-[var(--status-info-border)] bg-[var(--status-info-bg)]",
    icon: "text-[var(--status-info-text)]",
  },
  ok: {
    box: "border-[var(--status-success-border)] bg-[var(--status-success-bg)]",
    icon: "text-[var(--status-success-text)]",
  },
  warn: {
    box: "border-[var(--status-warning-border)] bg-[var(--status-warning-bg)]",
    icon: "text-[var(--status-warning-text)]",
  },
  err: {
    box: "border-[var(--status-danger-border)] bg-[var(--status-danger-bg)]",
    icon: "text-[var(--status-danger-text)]",
  },
  neutral: {
    box: "border-[var(--border-subtle)] bg-[var(--surface-subtle)]",
    icon: "text-[var(--text-tertiary)]",
  },
};

const toneIcon: Record<CalloutTone, React.ReactNode> = {
  info: <Info />,
  ok: <CheckCircle2 />,
  warn: <AlertTriangle />,
  err: <AlertCircle />,
  neutral: <Info />,
};

/** A message about the region it sits in: attention, outcome or context. */
export function Callout({ tone = "info", title, children, actions, icon, className }: CalloutProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius-lg)] border px-3.5 py-3 text-[var(--text-primary)]",
        toneClass[tone].box,
        className,
      )}
      role={tone === "err" ? "alert" : "status"}
    >
      <span aria-hidden="true" className={cn("mt-px inline-flex shrink-0 [&_svg]:h-4 [&_svg]:w-4", toneClass[tone].icon)}>
        {icon ?? toneIcon[tone]}
      </span>
      <div className="min-w-0 flex-1 text-[length:var(--text-size-body)]">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && "mt-0.5 text-[var(--text-secondary)]")}>{children}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">{actions}</div>}
    </div>
  );
}

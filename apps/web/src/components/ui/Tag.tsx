import { X } from "lucide-react";

import { cn } from "@/lib/cn";

export interface TagProps {
  icon?: React.ReactNode;
  /** Shows a remove button; `removeLabel` names it for screen readers. */
  onRemove?: () => void;
  removeLabel?: string;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

/** Metadata — a type, a capability, a selected value. Never a status (use `Badge`). */
export function Tag({ icon, onRemove, removeLabel, title, className, children }: TagProps) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] px-2",
        "bg-[var(--surface-inset)] text-[length:var(--text-size-meta)] text-[var(--text-secondary)]",
        className,
      )}
      title={title}
    >
      {icon && <span aria-hidden="true" className="inline-flex shrink-0 [&>svg]:size-[13px]">{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {onRemove && (
        <button
          aria-label={removeLabel ?? `Remove ${typeof children === "string" ? children : "tag"}`}
          className={cn(
            "-mr-0.5 grid size-4 shrink-0 place-items-center rounded-[var(--radius-xs)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
            "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
          )}
          onClick={onRemove}
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </button>
      )}
    </span>
  );
}

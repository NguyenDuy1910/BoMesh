"use client";

import { cn } from "@/lib/cn";

/**
 * The inline evidence numeral after a claim. Opens the cited passage; `active`
 * marks the source currently shown in the sources panel.
 */
export function CitationChip({
  n,
  title,
  active = false,
  onClick,
  className,
}: {
  n: number;
  /** The source's title, for the accessible name "Source 2: Travel policy.pdf". */
  title: string;
  active?: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  return (
    <button
      aria-current={active || undefined}
      aria-label={`Source ${n}: ${title}`}
      className={cn(
        "mx-px inline-flex h-[18px] min-w-[19px] cursor-pointer items-center justify-center rounded-[5px] px-[5px] align-[2px]",
        "font-[family-name:var(--font-mono)] text-[11px] font-semibold leading-none text-[var(--evidence-text)]",
        "transition-colors duration-[var(--duration-fast)] hover:bg-[var(--evidence-strong)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        active
          ? "bg-[var(--evidence-strong)] shadow-[inset_0_0_0_1.5px_var(--evidence-line)]"
          : "bg-[var(--evidence-bg)] shadow-[inset_0_0_0_1px_var(--evidence-border)]",
        className,
      )}
      data-active={active || undefined}
      onClick={onClick}
      title={title}
      type="button"
    >
      {n}
    </button>
  );
}

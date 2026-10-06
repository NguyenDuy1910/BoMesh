"use client";

import type { ReactNode } from "react";

import { ui } from "@/components/ui/design-system";
import { cn } from "@/lib/cn";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Required when `label` is not text (icon-only segments). */
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentOption<T>[];
  /** Names the group, e.g. "Density". */
  ariaLabel: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * A few mutually exclusive views or modes, shown side by side on a sunken
 * track. Each segment is a toggle button (`aria-pressed`), so Tab reaches
 * every option and the current one is announced as pressed.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "md",
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      aria-label={ariaLabel}
      className={cn("inline-flex max-w-full gap-0.5 rounded-md bg-surface-inset p-0.75", className)}
      role="group"
    >
      {options.map((option) => (
        <button
          aria-label={option.ariaLabel}
          aria-pressed={option.value === value}
          className={cn(
            "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-sm font-medium text-text-secondary [&_svg]:size-4 [&_svg]:shrink-0",
            ui.motion,
            ui.focus,
            size === "sm" ? "h-6 px-2.5 text-meta" : "h-7 px-3 text-[0.8125rem]",
            "enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45",
            "aria-pressed:bg-surface-base aria-pressed:text-text-primary aria-pressed:shadow-(--shadow-2)",
          )}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

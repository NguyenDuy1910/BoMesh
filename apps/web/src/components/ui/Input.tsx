"use client";

import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { type ControlSize, ui } from "@/components/ui/design-system";
import { cn } from "@/lib/cn";

export interface InputProps extends Omit<ComponentProps<"input">, "ref" | "size" | "prefix"> {
  size?: ControlSize;
  /** Marks the value invalid (red edge, `aria-invalid`). Show the message with FormField. */
  error?: boolean;
  /** Attached addon before the value, e.g. `bomesh.app/`. */
  prefix?: ReactNode;
  /** Muted text or an icon after the value, inside the field, e.g. a unit. */
  suffix?: ReactNode;
}

const groupPadding: Record<ControlSize, string> = {
  sm: "px-2.5",
  md: "px-3",
  lg: "px-3.5",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, error, prefix, suffix, size = "md", "aria-invalid": ariaInvalid, ...props },
  ref,
) {
  const invalid = error || ariaInvalid || undefined;
  if (prefix === undefined && suffix === undefined) {
    return (
      <input
        aria-invalid={invalid}
        className={cn(ui.control, ui.controlSize[size], "read-only:bg-surface-subtle", className)}
        ref={ref}
        {...props}
      />
    );
  }
  // The border, radius and focus halo move to the wrapper so the addons sit
  // inside one edge; the input itself is bare.
  return (
    <div className={cn(ui.controlGroup, ui.controlSize[size], "px-0", className)}>
      {prefix !== undefined && (
        <span className="flex shrink-0 items-center whitespace-nowrap border-r border-border-subtle bg-surface-subtle px-2.5 text-text-tertiary">
          {prefix}
        </span>
      )}
      <input
        aria-invalid={invalid}
        className={cn(
          "h-full min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-text-tertiary disabled:cursor-not-allowed",
          groupPadding[size],
          suffix !== undefined && "pr-1.5",
        )}
        ref={ref}
        {...props}
      />
      {suffix !== undefined && (
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap pr-2.5 text-[0.8125rem] text-text-tertiary [&_svg]:size-4">
          {suffix}
        </span>
      )}
    </div>
  );
});

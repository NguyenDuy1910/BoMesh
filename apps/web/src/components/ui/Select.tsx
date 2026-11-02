"use client";

import { ChevronDown } from "lucide-react";
import { forwardRef, type ComponentProps } from "react";

import { type ControlSize, ui } from "@/components/ui/design-system";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<ComponentProps<"select">, "ref" | "size"> {
  size?: ControlSize;
  /** Marks the value invalid (red edge, `aria-invalid`). Show the message with FormField. */
  error?: boolean;
  /** Rendered as `<option>`s. Pass `children` instead for `<optgroup>`s. */
  options?: readonly SelectOption[];
  /** A disabled first option shown while the value is empty. */
  placeholder?: string;
}

/**
 * A native select, so keyboard, mobile pickers and form submission behave as
 * the platform does. Wrapped only to carry the same chevron and states as the
 * other controls.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, error, options, placeholder, size = "md", children, "aria-invalid": ariaInvalid, ...props },
  ref,
) {
  return (
    <div className={cn("relative inline-flex w-full", className)}>
      <select
        aria-invalid={error || ariaInvalid || undefined}
        className={cn(ui.control, ui.controlSize[size], "cursor-pointer appearance-none pr-8.5")}
        ref={ref}
        {...props}
      >
        {placeholder !== undefined && (
          <option disabled value="">
            {placeholder}
          </option>
        )}
        {options?.map((option) => (
          <option disabled={option.disabled} key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-text-tertiary"
      />
    </div>
  );
});

"use client";

import { Check, Minus } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/cn";

export interface CheckboxProps extends Omit<ComponentProps<"input">, "ref" | "type" | "size"> {
  /** Mixed state, e.g. a header box when some rows are selected. Reads as "mixed". */
  indeterminate?: boolean;
  /** Called with the new checked state. The native `onChange` also works. */
  onCheckedChange?: (checked: boolean) => void;
  /** Visible label. Without it, pass `aria-label`. */
  label?: ReactNode;
  /** A second line under the label. */
  description?: ReactNode;
}

/** The box itself. `peer` drives the glyphs drawn on top of it. */
const box = [
  "peer size-4 shrink-0 cursor-pointer appearance-none rounded-xs border-[1.5px] border-border-strong bg-surface-base",
  "transition-[background-color,border-color,box-shadow] duration-(--duration-fast) ease-(--ease-standard)",
  "not-checked:not-indeterminate:hover:border-text-tertiary",
  "checked:border-accent-primary checked:bg-accent-primary indeterminate:border-accent-primary indeterminate:bg-accent-primary",
  "outline-none focus-visible:shadow-(--shadow-focus)",
  "aria-[invalid=true]:border-status-danger",
  "disabled:cursor-not-allowed disabled:opacity-45",
].join(" ");

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { indeterminate = false, onCheckedChange, onChange, label, description, className, disabled, ...props },
  forwardedRef,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

  // `indeterminate` exists only as a DOM property, never as an attribute.
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const control = (
    <span className={cn("relative inline-grid size-4 shrink-0 place-items-center", label === undefined && className)}>
      <input
        className={box}
        disabled={disabled}
        onChange={(event) => {
          onChange?.(event);
          onCheckedChange?.(event.target.checked);
        }}
        ref={inputRef}
        type="checkbox"
        {...props}
      />
      <Check
        aria-hidden="true"
        className="pointer-events-none absolute hidden size-3 text-text-on-accent peer-checked:block peer-indeterminate:hidden"
        strokeWidth={3}
      />
      <Minus
        aria-hidden="true"
        className="pointer-events-none absolute hidden size-3 text-text-on-accent peer-indeterminate:block"
        strokeWidth={3}
      />
    </span>
  );

  if (label === undefined) return control;
  return (
    <label
      className={cn(
        "inline-flex items-start gap-2.5 text-body text-text-primary",
        // The box fades itself (disabled:opacity-45); fading the label too would hide it.
        disabled ? "cursor-not-allowed text-text-tertiary" : "cursor-pointer",
        className,
      )}
    >
      <span className="mt-0.5 inline-flex">{control}</span>
      <span className="grid gap-0.5">
        <span>{label}</span>
        {description !== undefined && <span className="text-meta text-text-secondary">{description}</span>}
      </span>
    </label>
  );
});

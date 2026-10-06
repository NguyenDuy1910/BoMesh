"use client";

import { forwardRef, useId, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/** The dot: a ring that thickens to 5px in the accent when selected. */
const dot = [
  "size-4 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-border-strong bg-surface-base",
  "transition-[border-color,border-width,box-shadow] duration-(--duration-fast) ease-(--ease-standard)",
  "not-checked:hover:border-text-tertiary",
  "checked:border-[5px] checked:border-accent-primary",
  "outline-none focus-visible:shadow-(--shadow-focus)",
  "disabled:cursor-not-allowed disabled:opacity-45",
].join(" ");

export type RadioProps = Omit<ComponentProps<"input">, "ref" | "type" | "size">;

/** A bare radio. Prefer RadioGroup or ChoiceCard, which carry the label. */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio({ className, ...props }, ref) {
  return <input className={cn(dot, className)} ref={ref} type="radio" {...props} />;
});

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<T extends string> {
  /** Shared `name`; generated when omitted. */
  name?: string;
  value: T | undefined;
  onChange: (value: T) => void;
  options: readonly RadioOption<T>[];
  /** Visible group label, rendered as the fieldset legend. */
  label?: ReactNode;
  /** Used when there is no visible `label`. */
  "aria-label"?: string;
  orientation?: "vertical" | "horizontal";
  disabled?: boolean;
  className?: string;
}

/**
 * Native radios in a fieldset: arrow keys move the selection, Tab enters and
 * leaves the group as one stop.
 */
export function RadioGroup<T extends string>({
  name,
  value,
  onChange,
  options,
  label,
  "aria-label": ariaLabel,
  orientation = "vertical",
  disabled = false,
  className,
}: RadioGroupProps<T>) {
  const generatedName = useId();
  const groupName = name ?? generatedName;
  return (
    <fieldset aria-label={label === undefined ? ariaLabel : undefined} className={cn("m-0 min-w-0 border-0 p-0", className)} disabled={disabled}>
      {label !== undefined && (
        <legend className="mb-2 text-[0.84375rem] font-medium text-text-primary">{label}</legend>
      )}
      <div className={cn("flex", orientation === "vertical" ? "flex-col gap-2.5" : "flex-wrap gap-x-5 gap-y-2")}>
        {options.map((option) => (
          <label
            className={cn(
              "inline-flex items-start gap-2.5 text-body text-text-primary",
              // The dot fades itself (disabled:opacity-45); fading the label too would hide it.
              disabled || option.disabled ? "cursor-not-allowed text-text-tertiary" : "cursor-pointer",
            )}
            key={option.value}
          >
            <Radio
              checked={value === option.value}
              className="mt-0.5"
              disabled={option.disabled}
              name={groupName}
              onChange={() => onChange(option.value)}
              value={option.value}
            />
            <span className="grid gap-0.5">
              <span>{option.label}</span>
              {option.description !== undefined && (
                <span className="text-meta text-text-secondary">{option.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

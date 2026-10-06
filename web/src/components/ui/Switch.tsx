"use client";

import { forwardRef, type ComponentProps } from "react";

import { cn } from "@/lib/cn";

export interface SwitchProps
  extends Omit<ComponentProps<"button">, "ref" | "onChange" | "role" | "aria-checked" | "type"> {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  /**
   * Accessible name. A switch usually sits beside its visible title (e.g. in
   * a SettingRow); pass that title here, or `aria-labelledby` instead.
   */
  label?: string;
  /** Id of the description the switch should be read with. */
  describedBy?: string;
}

/**
 * A binary setting that applies immediately. For a choice whose two states
 * need names (e.g. who can see something) use ChoiceCard or RadioGroup.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, describedBy, className, disabled, onClick, ...props },
  ref,
) {
  return (
    <button
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-label={label}
      className={cn(
        "relative inline-flex h-5 w-8.5 shrink-0 items-center rounded-full outline-none",
        "transition-[background-color,box-shadow] duration-(--duration-base) ease-(--ease-standard)",
        "focus-visible:shadow-(--shadow-focus)",
        "disabled:cursor-not-allowed disabled:opacity-45",
        checked ? "bg-accent-primary enabled:hover:bg-accent-hover" : "bg-border-strong enabled:hover:bg-text-disabled",
        className,
      )}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange?.(!checked);
      }}
      ref={ref}
      role="switch"
      type="button"
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0.5 size-4 rounded-full shadow-(--shadow-knob)",
          "transition-transform duration-(--duration-base) ease-(--ease-standard) motion-reduce:transition-none",
          checked ? "translate-x-3.5 bg-text-on-accent" : "translate-x-0 bg-control-knob",
        )}
      />
    </button>
  );
});

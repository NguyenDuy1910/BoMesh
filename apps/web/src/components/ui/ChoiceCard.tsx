"use client";

import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { Checkbox } from "@/components/ui/Checkbox";
import { Radio } from "@/components/ui/Radio";
import { cn } from "@/lib/cn";

export interface ChoiceCardProps extends Omit<ComponentProps<"input">, "ref" | "type" | "size" | "title"> {
  /** `radio` for one-of-many (share a `name`), `checkbox` for any-of-many. */
  type?: "radio" | "checkbox";
  title: ReactNode;
  description?: ReactNode;
  /** Optional leading visual, e.g. an icon tile. */
  icon?: ReactNode;
}

/**
 * A large, labelled option: the whole card is the hit target and the native
 * radio or checkbox inside carries the state, so keyboard and form behaviour
 * are the platform's. The selected card takes the accent edge and soft fill.
 */
export const ChoiceCard = forwardRef<HTMLInputElement, ChoiceCardProps>(function ChoiceCard(
  { type = "radio", title, description, icon, className, disabled, ...props },
  ref,
) {
  const Control = type === "radio" ? Radio : Checkbox;
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border-default bg-surface-base px-3.5 py-3 text-left",
        "transition-[background-color,border-color,box-shadow] duration-(--duration-fast) ease-(--ease-standard)",
        // The control fades itself when disabled; the card only quiets its text
        // so the two opacities never multiply into an invisible control.
        disabled
          ? "cursor-not-allowed bg-surface-subtle"
          : "cursor-pointer hover:border-border-strong",
        "has-checked:border-accent-primary has-checked:bg-accent-soft has-checked:shadow-[0_0_0_1px_var(--accent-primary)]",
        "has-focus-visible:shadow-(--shadow-focus) has-checked:has-focus-visible:shadow-(--shadow-focus)",
        className,
      )}
    >
      <Control className="mt-0.5" disabled={disabled} ref={ref} {...props} />
      {icon}
      <span className="grid min-w-0 gap-0.5">
        <span className={cn("font-medium", disabled ? "text-text-disabled" : "text-text-primary")}>{title}</span>
        {description !== undefined && <span className={cn("text-[0.8125rem]", disabled ? "text-text-disabled" : "text-text-secondary")}>{description}</span>}
      </span>
    </label>
  );
});

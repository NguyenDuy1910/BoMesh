"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { forwardRef, type ComponentProps, type ReactNode } from "react";

import { ui } from "@/components/ui/design-system";
import { cn } from "@/lib/cn";

/**
 * One action hierarchy for the whole product.
 *
 * primary       exactly one per view — the action the page exists for
 * secondary     outlined; alternatives of equal weight to each other
 * ghost         chromeless; toolbar, row and icon actions, dismissals
 * danger        solid red; the confirming action inside a destructive flow
 * danger-ghost  red text; the row- or menu-level entry into a destructive flow
 * link          inline text action in the accent colour
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-ghost" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-accent-primary text-text-on-accent shadow-(--shadow-button-primary) hover:bg-accent-hover active:bg-accent-pressed",
  secondary:
    "border-border-default bg-surface-base text-text-primary shadow-(--shadow-1) hover:border-border-strong hover:bg-surface-hover active:bg-surface-pressed",
  ghost:
    "text-text-secondary hover:bg-surface-hover hover:text-text-primary active:bg-surface-pressed aria-expanded:bg-surface-pressed aria-expanded:text-text-primary aria-pressed:bg-surface-pressed aria-pressed:text-text-primary",
  danger: "bg-danger-solid text-text-on-danger hover:bg-danger-solid-hover active:bg-danger-solid-hover",
  "danger-ghost": "text-status-danger hover:bg-status-danger-bg active:bg-status-danger-bg",
  link: "h-auto! rounded-xs px-0! text-text-accent hover:underline",
};

/** Pressed/selected look for toggle-like buttons (`selected`), per variant. */
const selectedClasses: Partial<Record<ButtonVariant, string>> = {
  secondary: "border-border-strong bg-surface-pressed",
  ghost: "bg-surface-pressed text-text-primary",
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-(--control-sm) gap-1.5 rounded-sm px-2.5 text-[0.8125rem] [&_svg]:size-[15px]",
  md: "h-(--control-md) gap-2 rounded-md px-3.5 text-body [&_svg]:size-4",
  lg: "h-(--control-lg) gap-2 rounded-md px-4.5 text-[0.9375rem] [&_svg]:size-4",
};

const iconOnlySizeClasses: Record<ButtonSize, string> = {
  sm: "w-(--control-sm) px-0",
  md: "w-(--control-md) px-0",
  lg: "w-(--control-lg) px-0",
};

interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  selected?: boolean;
  block?: boolean;
  className?: string;
}

/** The class list of a button, for elements that must look like one. */
export function buttonClasses({
  variant = "primary",
  size = "md",
  iconOnly = false,
  selected = false,
  block = false,
  className,
}: ButtonStyleOptions = {}) {
  return cn(
    "relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap border border-transparent font-medium leading-none no-underline",
    "[&_svg]:shrink-0",
    ui.motion,
    ui.focus,
    "disabled:pointer-events-none disabled:opacity-45 disabled:shadow-none aria-disabled:pointer-events-none aria-disabled:opacity-45 aria-disabled:shadow-none",
    sizeClasses[size],
    iconOnly && iconOnlySizeClasses[size],
    variantClasses[variant],
    selected && selectedClasses[variant],
    block && "w-full",
    className,
  );
}

interface ButtonOwnProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Keeps the width, swaps the content for a spinner, and blocks clicks. */
  loading?: boolean;
  icon?: ReactNode;
  iconAfter?: ReactNode;
  /** Pressed look for a toggle-like button; pair with `aria-pressed` when it toggles. */
  selected?: boolean;
  /** Full width. */
  block?: boolean;
}

/** An icon-only button has no visible text, so it must be named. */
type IconOnly =
  | { iconOnly: true; "aria-label": string; "aria-labelledby"?: string }
  | { iconOnly: true; "aria-label"?: string; "aria-labelledby": string };

export type ButtonProps = Omit<ComponentProps<"button">, "ref"> &
  ButtonOwnProps &
  (IconOnly | { iconOnly?: false });

function ButtonContent({
  children,
  icon,
  iconAfter,
  iconOnly,
  loading,
}: Pick<ButtonProps, "children" | "icon" | "iconAfter" | "iconOnly" | "loading">) {
  return (
    <>
      <span className={cn("contents", loading && "invisible")}>
        {icon}
        {!iconOnly && children}
        {!iconOnly && iconAfter}
      </span>
      {loading && (
        <Loader2 aria-hidden="true" className="absolute inset-0 m-auto animate-spin motion-reduce:animate-none" />
      )}
    </>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    icon,
    iconAfter,
    iconOnly = false,
    selected = false,
    block = false,
    children,
    className,
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-busy={loading || undefined}
      // A loading button is busy, not unavailable: it keeps its full colour.
      className={buttonClasses({ variant, size, iconOnly, selected, block, className: cn(loading && "disabled:opacity-100", className) })}
      disabled={disabled || loading}
      type={type}
      {...props}
    >
      <ButtonContent icon={icon} iconAfter={iconAfter} iconOnly={iconOnly} loading={loading}>
        {children}
      </ButtonContent>
    </button>
  );
});

export type ButtonLinkProps = Omit<ComponentProps<typeof Link>, "ref"> &
  Omit<ButtonOwnProps, "loading"> &
  (IconOnly | { iconOnly?: false });

/** A Next.js link that looks like a button. Navigation, not an action. */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  {
    variant = "secondary",
    size = "md",
    icon,
    iconAfter,
    iconOnly = false,
    selected = false,
    block = false,
    children,
    className,
    ...props
  },
  ref,
) {
  return (
    <Link
      ref={ref}
      className={buttonClasses({ variant, size, iconOnly, selected, block, className })}
      {...props}
    >
      <ButtonContent icon={icon} iconAfter={iconAfter} iconOnly={iconOnly}>
        {children}
      </ButtonContent>
    </Link>
  );
});

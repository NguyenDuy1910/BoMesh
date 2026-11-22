"use client";

import { Button, buttonVariants, Focusable, Tooltip } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import NextLink from "next/link";

export interface IconButtonProps {
  icon: LucideIcon;
  /** Tooltip and accessible name ("Close", "More actions"). */
  tip: string;
  onPress?: () => void;
  /** Navigates instead (a real link, styled as the button). */
  href?: string;
  /** `ghost` (default, muted icon), `tertiary`, `outline`, `danger-soft`… any HeroUI Button variant. */
  variant?: "ghost" | "tertiary" | "secondary" | "outline" | "danger-soft" | "primary";
  size?: "sm" | "md" | "lg";
  isDisabled?: boolean;
  isPending?: boolean;
  /** Show the tooltip (default true). Turn off when the label is visible nearby. */
  showTip?: boolean;
  className?: string;
  id?: string;
  /** Disclosure state for a toggle (e.g. the sidebar toggle). */
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaKeyShortcuts?: string;
}

/**
 * Icon-only button with tooltip (preview `iconBtn(icon, tip)`, HeroUI Button `isIconOnly` + Tooltip).
 * Ghost icon buttons use the muted foreground like the preview.
 */
export function IconButton({
  icon: Icon,
  tip,
  onPress,
  href,
  variant = "ghost",
  size,
  isDisabled,
  isPending,
  showTip = true,
  className,
  id,
  ariaExpanded,
  ariaControls,
  ariaKeyShortcuts,
}: IconButtonProps) {
  const cls = clsx(variant === "ghost" && "button--muted", className);
  const button = href ? (
    <NextLink href={href} aria-label={tip} id={id} className={clsx(buttonVariants({ variant, size, isIconOnly: true }), cls)}>
      <Icon aria-hidden />
    </NextLink>
  ) : (
    <Button
      isIconOnly
      aria-label={tip}
      id={id}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-keyshortcuts={ariaKeyShortcuts}
      variant={variant}
      size={size}
      isDisabled={isDisabled}
      isPending={isPending}
      onPress={onPress}
      className={cls}
    >
      <Icon aria-hidden />
    </Button>
  );
  if (!showTip) return button;
  return (
    <Tooltip>
      {href ? <Focusable>{button}</Focusable> : button}
      <Tooltip.Content>{tip}</Tooltip.Content>
    </Tooltip>
  );
}

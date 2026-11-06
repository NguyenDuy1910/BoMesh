"use client";

import { Button, Tooltip } from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

export interface IconButtonProps {
  icon: LucideIcon;
  /** Tooltip and accessible name ("Close", "More actions"). */
  tip: string;
  onPress?: () => void;
  /** `ghost` (default, muted icon), `tertiary`, `outline`, `danger-soft`… any HeroUI Button variant. */
  variant?: "ghost" | "tertiary" | "secondary" | "outline" | "danger-soft" | "primary";
  size?: "sm" | "md" | "lg";
  isDisabled?: boolean;
  isPending?: boolean;
  /** Show the tooltip (default true). Turn off when the label is visible nearby. */
  showTip?: boolean;
  className?: string;
}

/**
 * Icon-only button with tooltip (preview `iconBtn(icon, tip)`, HeroUI Button `isIconOnly` + Tooltip).
 * Ghost icon buttons use the muted foreground like the preview.
 */
export function IconButton({ icon: Icon, tip, onPress, variant = "ghost", size, isDisabled, isPending, showTip = true, className }: IconButtonProps) {
  const button = (
    <Button
      isIconOnly
      aria-label={tip}
      variant={variant}
      size={size}
      isDisabled={isDisabled}
      isPending={isPending}
      onPress={onPress}
      className={clsx(variant === "ghost" && "button--muted", className)}
    >
      <Icon aria-hidden />
    </Button>
  );
  if (!showTip) return button;
  return (
    <Tooltip>
      {button}
      <Tooltip.Content>{tip}</Tooltip.Content>
    </Tooltip>
  );
}

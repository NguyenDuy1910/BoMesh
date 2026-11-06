"use client";

import { Tooltip } from "@heroui/react";
import type { ReactNode } from "react";

export interface TipProps {
  /** Tooltip text. When empty the children render without a tooltip. */
  content: ReactNode;
  placement?: "top" | "bottom" | "left" | "right";
  /** Non-interactive content (chip, icon, text). For buttons use `IconButton tip` or HeroUI `Tooltip` directly. */
  children: ReactNode;
}

/**
 * Tooltip on non-interactive content (preview `data-tip` on chips and marks).
 * The trigger is made keyboard-focusable so the tip is reachable without a pointer.
 */
export function Tip({ content, placement = "top", children }: TipProps) {
  if (!content) return <>{children}</>;
  return (
    <Tooltip>
      <Tooltip.Trigger className="tip-trigger">{children}</Tooltip.Trigger>
      <Tooltip.Content placement={placement}>{content}</Tooltip.Content>
    </Tooltip>
  );
}

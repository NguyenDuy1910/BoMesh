import type { LucideIcon } from "lucide-react";
import clsx from "clsx";
import type { Tone } from "./StatusChip";

export interface ItemIconProps {
  icon: LucideIcon;
  tone?: Tone;
  /** `sm` = 28 px tile, `md` = 36 px (default). */
  size?: "sm" | "md";
  className?: string;
}

/** Icon tile used as a list-row lead (preview `itemIcon(icon, tone, size)`). */
export function ItemIcon({ icon: Icon, tone, size = "md", className }: ItemIconProps) {
  return (
    <span className={clsx("item-icon", tone && tone !== "default" && `item-icon--${tone}`, size === "sm" && "item-icon--sm", className)} aria-hidden>
      <Icon className="i" />
    </span>
  );
}

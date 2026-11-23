import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

import { CATEGORY_TONES, type CategoryTone } from "@/lib/tones";

import type { Tone } from "./StatusChip";

export interface ItemIconProps {
  icon: LucideIcon;
  /** A status tone, or a category tone (`blue`, `violet`, …) for kinds such as roles and permission groups. */
  tone?: Tone | CategoryTone;
  /** `sm` = 28 px tile, `md` = 36 px (default). */
  size?: "sm" | "md";
  className?: string;
}

const isCategoryTone = (tone: string): tone is CategoryTone => (CATEGORY_TONES as readonly string[]).includes(tone);

/** Icon tile used as a list-row lead (preview `itemIcon(icon, tone, size)`). */
export function ItemIcon({ icon: Icon, tone, size = "md", className }: ItemIconProps) {
  const toneClass = !tone || tone === "default" ? null : isCategoryTone(tone) ? `item-icon--tone tone-${tone}` : `item-icon--${tone}`;
  return (
    <span className={clsx("item-icon", toneClass, size === "sm" && "item-icon--sm", className)} aria-hidden>
      <Icon className="i" />
    </span>
  );
}

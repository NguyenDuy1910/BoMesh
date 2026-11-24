/**
 * Category colors: identity colors for kinds, never for status. Preview: `CATEGORY_TONES`, `categoryTone()`,
 * `categoryColor()`, `DOMAIN_COLORS` and `freeDomainColor()` in `core/ui.js`.
 */
import { hashOf } from "./format";

export const CATEGORY_TONES = ["blue", "violet", "teal", "amber", "pink", "green"] as const;

export type CategoryTone = (typeof CATEGORY_TONES)[number];

/** One of the six category tones (tokens.css `--tone-*`, class `tone-*`), for small sets such as roles or avatars. */
export const categoryTone = (key: string): CategoryTone => CATEGORY_TONES[hashOf(key) % CATEGORY_TONES.length];

/**
 * A stable color for one of many kinds (topic domains): a hue hashed from `key`, skipping the red band status
 * owns, at the lightness and chroma of the category tones. Six tones are too few for dozens of domains.
 */
export const categoryColor = (key: string): string => `oklch(63% 0.15 ${45 + (hashOf(key) % 300)})`;

/**
 * The colors people give topic domains (`Topic.color`, lowercase `#rrggbb`): twelve hues apart, mid-tone so their soft
 * tiles and tags read in light and dark, no status red. The label is the swatch's accessible name.
 */
export const DOMAIN_COLORS: readonly { hex: string; label: string }[] = [
  { hex: "#2f6fb5", label: "Xanh dương" },
  { hex: "#0e7c66", label: "Ngọc lục bảo" },
  { hex: "#c2620f", label: "Cam" },
  { hex: "#6b4fbf", label: "Tím violet" },
  { hex: "#b4467a", label: "Hồng" },
  { hex: "#1f7a8c", label: "Xanh lơ" },
  { hex: "#4e6b2e", label: "Ô liu" },
  { hex: "#a8790e", label: "Hổ phách" },
  { hex: "#4c51bf", label: "Chàm" },
  { hex: "#9c3fa8", label: "Mận" },
  { hex: "#8a5a3c", label: "Nâu" },
  { hex: "#4f5865", label: "Xám đá" },
];

/** A new domain's color: the first palette color no domain uses (`used`: their colors); the palette repeats once all are taken. */
export function freeDomainColor(used: readonly (string | undefined)[]): string {
  const taken = new Set(used.flatMap((c) => (c ? [c.toLowerCase()] : [])));
  return (DOMAIN_COLORS.find((c) => !taken.has(c.hex)) ?? DOMAIN_COLORS[used.length % DOMAIN_COLORS.length]).hex;
}

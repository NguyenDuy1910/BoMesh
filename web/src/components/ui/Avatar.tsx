import { initialsOf, paletteIndex } from "@/components/ui/interaction";
import { cn } from "@/lib/cn";

const sizeClass = {
  xs: "h-5 w-5 text-[9px]",
  sm: "h-6 w-6 text-[10px]",
  rail: "h-[26px] w-[26px] text-[10px]",
  md: "h-7 w-7 text-[11px]",
  lg: "h-9 w-9 text-[length:var(--text-size-meta)]",
  xl: "h-12 w-12 text-lg",
} as const;

/* Written out in full so Tailwind generates every palette class. */
const PALETTE = [
  "bg-avatar-1",
  "bg-avatar-2",
  "bg-avatar-3",
  "bg-avatar-4",
  "bg-avatar-5",
  "bg-avatar-6",
  "bg-avatar-7",
  "bg-avatar-8",
  "bg-avatar-9",
  "bg-avatar-10",
] as const;

/**
 * A person's initials on a colour derived from their name, so the same person
 * keeps the same colour on every screen. Decorative: the name is always
 * written next to it.
 */
export function Avatar({
  name,
  size = "md",
  className,
}: {
  name: string;
  size?: keyof typeof sizeClass;
  className?: string;
}) {
  const seed = name || "?";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-full font-semibold leading-none tracking-[-0.01em] text-[var(--text-on-accent)]",
        PALETTE[paletteIndex(seed, PALETTE.length)],
        sizeClass[size],
        className,
      )}
    >
      {initialsOf(seed)}
    </span>
  );
}

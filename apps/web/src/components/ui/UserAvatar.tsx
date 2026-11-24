"use client";

import { Avatar } from "@heroui/react";
import clsx from "clsx";
import { initials } from "@/lib/format";
import { categoryTone } from "@/lib/tones";

export interface UserAvatarProps {
  /** Display name; drives initials and the stable tone. */
  name: string;
  /** Photo URL; initials show while it loads or when it fails. */
  src?: string | null;
  /** xs 20 · sm 24 · md 32 (default) · lg 40 · xl 56 px. */
  size?: "xs" | "sm" | "md" | "lg" | "xl";
  /** Accessible name; omit when the name is printed next to the avatar (decorative). */
  label?: string;
  className?: string;
}

/** Person avatar (preview `avatar(name, size)`, HeroUI Avatar) with a name-stable category tone: soft tile + ink. */
export function UserAvatar({ name, src, size = "md", label, className }: UserAvatarProps) {
  return (
    <Avatar
      variant="soft"
      className={clsx("user-avatar", `user-avatar--${size}`, "user-avatar--tone", `tone-${categoryTone(name)}`, className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      translate="no"
    >
      {src ? <Avatar.Image src={src} alt="" /> : null}
      <Avatar.Fallback>{initials(name)}</Avatar.Fallback>
    </Avatar>
  );
}

"use client";

import { Avatar } from "@heroui/react";
import clsx from "clsx";
import { hashOf, initials } from "@/lib/format";
import type { Tone } from "./StatusChip";

const AVATAR_TONES: readonly Tone[] = ["accent", "success", "warning", "danger", "default"];

/** Soft tone that stays the same for a given name (preview `avatar()` hashing). */
export function avatarTone(name: string): Tone {
  return AVATAR_TONES[hashOf(name) % AVATAR_TONES.length];
}

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

/** Person avatar (preview `avatar(name, size)`, HeroUI Avatar soft fallback) with a name-stable tone. */
export function UserAvatar({ name, src, size = "md", label, className }: UserAvatarProps) {
  const tone = avatarTone(name);
  return (
    <Avatar
      variant="soft"
      color={tone}
      className={clsx("user-avatar", `user-avatar--${size}`, className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      translate="no"
    >
      {src ? <Avatar.Image src={src} alt="" /> : null}
      <Avatar.Fallback color={tone}>{initials(name)}</Avatar.Fallback>
    </Avatar>
  );
}

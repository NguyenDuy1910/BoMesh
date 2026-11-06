"use client";

import clsx from "clsx";

import { hashOf } from "@/lib/format";
import { useOptionalWorkspace } from "@/lib/workspace";

import { spaceType, type Space } from "../types";

/** Space colours are data, like knowledge base marks (preview `COLORS`); the API has no colour, so one is picked from the space ID. */
const COLORS = ["#2F6FB5", "#0E7C66", "#4E6B2E", "#B4467A", "#6B4FBF", "#C2620F", "#1F7A8C", "#A23B3B"];

/** A space's colour (SpaceMark tile, sidebar and work-tag dots). */
export function spaceColor(space: Pick<Space, "name" | "displayName"> | null | undefined): string {
  return space ? COLORS[hashOf(space.name ?? space.displayName ?? "") % COLORS.length] : "var(--accent)";
}

export interface SpaceMarkProps {
  space: Pick<Space, "name" | "displayName" | "spaceType"> | null | undefined;
  /** Tile size in px (default 36). */
  size?: number;
  className?: string;
}

/** Coloured tile with the space type's icon (preview `X.spaceMark(sp, size)`). */
export function SpaceMark({ space, size = 36, className }: SpaceMarkProps) {
  const settings = useOptionalWorkspace()?.settings;
  const Icon = spaceType(space?.spaceType, settings).icon;
  const icon = size < 28 ? "i-xs" : size < 34 ? "i-sm" : size < 40 ? "" : size < 46 ? "i-lg" : "i-xl";
  const color = spaceColor(space);
  return (
    <span className={clsx("sp-mark", className)} style={{ ["--sp-mark" as string]: `${size}px`, background: color }} aria-hidden>
      <Icon className={clsx("i", icon)} />
    </span>
  );
}

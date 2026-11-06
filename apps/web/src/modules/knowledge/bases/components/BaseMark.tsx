"use client";

import { Lock, User } from "lucide-react";
import type { CSSProperties } from "react";

import { baseColor, isLocked, isPersonal, type Item } from "../model";

export interface BaseMarkProps {
  base: Pick<Item, "name" | "displayName" | "access" | "collection">;
  /** Pixel size (preview 24–40). */
  size?: number;
  /** Lock glyph instead of the initial; defaults to `access === "LOCKED"`. */
  locked?: boolean;
}

/** Knowledge base mark (preview `X.kbMark`): coloured initial; lock when locked; person glyph for My files. */
export function BaseMark({ base, size = 36, locked = isLocked(base as Item) }: BaseMarkProps) {
  const personal = isPersonal(base as Item);
  const iconClass = size < 28 ? "i i-xs" : size < 36 ? "i i-sm" : "i";
  const style = { "--kb-mark": `${size}px`, ...(!locked && !personal ? { background: baseColor(base.name ?? "") } : {}) } as CSSProperties;
  if (locked || personal) {
    const Icon = locked ? Lock : User;
    return (
      <span className="kb-mark kb-mark--muted" style={style} aria-hidden>
        <Icon className={iconClass} />
      </span>
    );
  }
  return (
    <span className="kb-mark" style={style} aria-hidden>
      {((base.displayName ?? "").trim()[0] || "K").toUpperCase()}
    </span>
  );
}

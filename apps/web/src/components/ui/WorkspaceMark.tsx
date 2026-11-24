"use client";

import clsx from "clsx";
import { useState } from "react";

export interface WorkspaceMarkProps {
  /** Workspace display name; its first letter is the mark without a logo. */
  name: string;
  /** The workspace's logo URL (`Workspace.logoUri` / `WorkspaceSettings.branding.logo.uri`). */
  logo?: string | null;
  /** The workspace's own mark color (any CSS color); defaults to the accent. */
  color?: string | null;
  /** Square size in px (default 28). */
  size?: number;
  className?: string;
}

/**
 * Workspace mark (preview `wsMark(ws, size)`): the logo cropped to the rounded square, else the first letter on the
 * workspace color. A logo that fails to load falls back to the letter. Decorative: the name is always next to it.
 */
export function WorkspaceMark({ name, logo, color, size = 28, className }: WorkspaceMarkProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const image = logo && failed !== logo ? logo : null;
  return (
    <span
      className={clsx("ws-mark", image && "ws-mark--logo", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), background: image ? undefined : color || undefined }}
      aria-hidden
      translate="no"
    >
      {(name.trim() || "?")[0].toUpperCase()}
      {/* eslint-disable-next-line @next/next/no-img-element -- a signed storage URL, not a static asset */}
      {image && <img className="ws-mark__img" src={image} alt="" onError={() => setFailed(image)} />}
    </span>
  );
}

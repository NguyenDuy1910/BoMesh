import clsx from "clsx";

export interface WorkspaceMarkProps {
  /** Workspace display name; its first letter is the mark. */
  name: string;
  /** The workspace's own logo color (any CSS color); defaults to the accent. */
  color?: string | null;
  /** Square size in px (default 28). */
  size?: number;
  className?: string;
}

/** Workspace logo tile (preview `wsMark(ws, size)`): first letter on the workspace color. */
export function WorkspaceMark({ name, color, size = 28, className }: WorkspaceMarkProps) {
  return (
    <span
      className={clsx("ws-mark", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46), background: color || undefined }}
      aria-hidden
      translate="no"
    >
      {(name.trim() || "?")[0].toUpperCase()}
    </span>
  );
}

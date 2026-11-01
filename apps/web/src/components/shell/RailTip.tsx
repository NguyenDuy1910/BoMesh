"use client";

import { Tooltip } from "@/components/ui/Tooltip";

/**
 * Names a sidebar control in the 68px icon rail, where its text is hidden.
 * Expanded, the visible label already names it, so the tooltip is disabled —
 * but the wrapper stays, so toggling the rail never remounts the control
 * (focus can return to it). The child's `aria-label` must equal `label` so
 * the name is not read twice.
 */
export function RailTip({
  enabled,
  label,
  className,
  children,
}: {
  enabled: boolean;
  label: string;
  /** Visibility classes (e.g. `only-collapsed`) that must apply to the wrapper, not just the control. */
  className?: string;
  children: React.ReactElement;
}) {
  return (
    <Tooltip className={`flex w-full justify-center${className ? ` ${className}` : ""}`} disabled={!enabled} label={label} side="right">
      {children}
    </Tooltip>
  );
}

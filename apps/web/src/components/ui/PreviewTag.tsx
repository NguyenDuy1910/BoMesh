import { Tooltip } from "@/components/ui/Tooltip";
import { isPendingMarkerEnabled } from "@/lib/config/pending";
import { cn } from "@/lib/cn";

const EXPLANATION = "Not connected to the server yet. Changes are kept in this browser.";

/**
 * Marks a surface whose API is still pending (UI built, data kept locally).
 * Neutral on purpose — it is a fact about the build, not a warning. Renders
 * nothing when the marker is switched off (`NEXT_PUBLIC_BOMESH_PENDING_MARKER=off`).
 */
export function PreviewTag({ className }: { className?: string }) {
  if (!isPendingMarkerEnabled()) return null;
  return (
    <Tooltip label={EXPLANATION}>
      <span
        className={cn(
          "inline-flex h-5 shrink-0 items-center rounded-[var(--radius-xs)] px-1.5",
          "bg-[var(--status-neutral-bg)] text-[length:var(--text-size-caption)] font-medium text-[var(--status-neutral-text)]",
          "shadow-[inset_0_0_0_1px_var(--status-neutral-border)]",
          "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
          className,
        )}
        role="note"
        tabIndex={0}
      >
        Preview
      </span>
    </Tooltip>
  );
}

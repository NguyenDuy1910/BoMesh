"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

interface SaveBarProps {
  /** Shown after "Unsaved changes", e.g. a link to the tab with problems. */
  message?: ReactNode;
  onDiscard: () => void;
  onSave: () => void;
  saving?: boolean;
  /** Blocks Save while the form cannot be saved as it stands. */
  disabled?: boolean;
  saveLabel?: string;
  discardLabel?: string;
  className?: string;
}

/**
 * The sticky "Unsaved changes · Discard · Save" bar (prototype `.adm-savebar`)
 * for long forms whose edits are saved together. Render it only while the
 * form is dirty; it sticks to the bottom of the scrolling sheet and holds the
 * page's one primary button.
 */
export function SaveBar({
  message,
  onDiscard,
  onSave,
  saving = false,
  disabled = false,
  saveLabel = "Save changes",
  discardLabel = "Discard",
  className,
}: SaveBarProps) {
  return (
    <div
      aria-label="Unsaved changes"
      className={cn(
        "sticky bottom-3 z-10 mt-5 flex items-center gap-2 rounded-lg border border-border-default bg-surface-raised py-2.5 pr-2.5 pl-4",
        "shadow-(--shadow-pop) animate-ui-pop motion-reduce:animate-none",
        className,
      )}
      role="region"
    >
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent-primary" />
      <span className="min-w-0 flex-1 text-body font-medium text-text-primary">
        Unsaved changes
        {message && <span className="font-normal text-text-secondary"> · {message}</span>}
      </span>
      <Button disabled={saving} onClick={onDiscard} variant="secondary">
        {discardLabel}
      </Button>
      <Button disabled={disabled} loading={saving} onClick={onSave} variant="primary">
        {saveLabel}
      </Button>
    </div>
  );
}

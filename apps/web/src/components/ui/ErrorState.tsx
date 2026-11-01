"use client";

import { AlertCircle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";

interface ErrorStateProps {
  /** Defaults to "This didn’t load". */
  title?: string;
  /** What went wrong and what to do. Defaults to the reassuring generic line. */
  description?: string;
  /** The recovery action; usually a refetch. Without it no button is shown. */
  onAction?: () => void;
  /** Defaults to "Try again". */
  actionLabel?: string;
  /** `block` replaces a list or page region; `inline` sits inside a form, dialog or card. */
  layout?: "block" | "inline";
  /** Block layout only: the dashed outline. Defaults to `true`. */
  boxed?: boolean;
  className?: string;
}

/**
 * A region that failed to load or an action that failed, with one way to
 * recover. Never shows a raw error code on its own.
 */
export function ErrorState({
  title,
  description,
  onAction,
  actionLabel = "Try again",
  layout = "block",
  boxed = true,
  className,
}: ErrorStateProps) {
  if (layout === "inline") {
    return (
      <Callout
        actions={
          onAction && (
            <Button onClick={onAction} size="sm" variant="secondary">
              {actionLabel}
            </Button>
          )
        }
        className={className}
        title={title}
        tone="err"
      >
        {description ?? "Something went wrong. Try again."}
      </Callout>
    );
  }

  return (
    <EmptyState
      action={
        onAction && (
          <Button icon={<RotateCw aria-hidden="true" className="h-4 w-4" />} onClick={onAction} variant="secondary">
            {actionLabel}
          </Button>
        )
      }
      boxed={boxed}
      className={className}
      description={description ?? "Check your connection and try again. Nothing was lost."}
      icon={<AlertCircle />}
      title={title ?? "This didn’t load"}
      tone="err"
    />
  );
}

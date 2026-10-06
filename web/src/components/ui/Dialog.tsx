"use client";

import { X } from "lucide-react";
import { type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";
import { useModalLayer } from "@/lib/hooks/useModalLayer";

export type DialogSize = "sm" | "md" | "lg" | "xl";

/* Max widths, not widths: a caller's `max-w-*` replaces the size through
   `cn`'s merge, and the panel still shrinks to the viewport. */
const sizeClass: Record<DialogSize, string> = {
  sm: "max-w-[420px]",
  md: "max-w-[520px]",
  lg: "max-w-[720px]",
  xl: "max-w-[960px] h-[min(720px,calc(100dvh-48px))]",
};

interface DialogProps {
  open: boolean;
  /** Escape, the scrim and the close button all call this — never while `busy`. */
  onClose: () => void;
  title: React.ReactNode;
  /** One line under the title. */
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Buttons, right-aligned. Put the primary action last. */
  footer?: React.ReactNode;
  /** Quiet text at the left of the footer, e.g. "Changes save for everyone". */
  footerStart?: React.ReactNode;
  /** sm 420 · md 520 (default) · lg 720 · xl 960 with a fixed height. */
  size?: DialogSize;
  /** A submission is in flight: the dialog cannot be dismissed until it settles. */
  busy?: boolean;
  /** Where focus lands. Defaults to `[data-autofocus]`, then the first field, then the first action. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Omit the header close button (the footer must offer a way out). */
  hideClose?: boolean;
  /** `alertdialog` for confirmations that interrupt. */
  role?: "dialog" | "alertdialog";
  className?: string;
  bodyClassName?: string;
}

/**
 * A modal dialog: scrim, centred panel, header with title and close, a
 * scrolling body and an optional footer. Focus, Escape, scroll lock and the
 * inert page come from `useModalLayer`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  footerStart,
  size = "md",
  busy = false,
  initialFocusRef,
  hideClose = false,
  role = "dialog",
  className,
  bodyClassName,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const pressStartedOnScrim = useRef(false);

  useModalLayer({ open, onClose, panelRef, initialFocusRef, dismissible: !busy });

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] grid place-items-center overflow-y-auto bg-[var(--scrim)] p-6 motion-safe:animate-ui-fade max-sm:p-3"
      // Close only when the press both starts and ends on the scrim, so a text
      // selection dragged out of the panel does not dismiss the dialog.
      onClick={(event) => {
        if (event.target === event.currentTarget && pressStartedOnScrim.current && !busy) onClose();
      }}
      onPointerDown={(event) => {
        pressStartedOnScrim.current = event.target === event.currentTarget;
      }}
    >
      <div
        aria-busy={busy || undefined}
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          "relative flex max-h-[calc(100dvh-48px)] min-h-0 w-full flex-col rounded-[var(--radius-2xl)]",
          "bg-[var(--surface-raised)] text-[length:var(--text-size-body)] text-[var(--text-primary)] shadow-[var(--shadow-modal)]",
          "focus:outline-none motion-safe:animate-ui-pop",
          sizeClass[size],
          className,
        )}
        ref={panelRef}
        role={role}
        tabIndex={-1}
      >
        <div className="flex shrink-0 items-start gap-3 px-[22px] pb-1 pt-5">
          <div className="min-w-0 flex-1">
            <h2
              className="text-[1.0625rem] font-semibold leading-6 tracking-[-0.01em] text-[var(--text-primary)]"
              id={titleId}
            >
              {title}
            </h2>
            {description && (
              <div className="mt-1 text-[length:var(--text-size-body)] text-[var(--text-secondary)]" id={descriptionId}>
                {description}
              </div>
            )}
          </div>
          {!hideClose && <LayerCloseButton disabled={busy} label="Close dialog" onClick={onClose} />}
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto px-[22px] pb-5 pt-4", bodyClassName)}>{children}</div>
        {(footer || footerStart) && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-[22px] py-3.5">
            {footerStart && (
              <div className="mr-auto min-w-0 text-[length:var(--text-size-meta)] text-[var(--text-tertiary)]">
                {footerStart}
              </div>
            )}
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The header close button shared by dialogs and drawers. Never the initial focus target. */
export function LayerCloseButton({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "-mr-1.5 -mt-0.5 inline-flex h-[var(--control-sm)] w-[var(--control-sm)] shrink-0 items-center justify-center rounded-[var(--radius-md)]",
        "text-[var(--text-tertiary)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] disabled:pointer-events-none disabled:opacity-45",
      )}
      data-layer-close=""
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <X aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}

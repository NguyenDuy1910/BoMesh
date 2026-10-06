"use client";

import { type RefObject, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { LayerCloseButton } from "@/components/ui/Dialog";
import { cn } from "@/lib/cn";
import { useModalLayer } from "@/lib/hooks/useModalLayer";

const sizeClass = {
  md: "w-[min(520px,calc(100vw-16px))]",
  lg: "w-[min(680px,calc(100vw-16px))]",
} as const;

interface DrawerProps {
  open: boolean;
  /** Escape, the scrim and the close button all call this — never while `busy`. */
  onClose: () => void;
  title: React.ReactNode;
  /** One line under the title. */
  description?: React.ReactNode;
  /** Leading mark in the header: an avatar, app tile or file icon. */
  icon?: React.ReactNode;
  /** Extra controls under the title (status, tabs). */
  header?: React.ReactNode;
  /** Icon buttons or a menu next to the close button. */
  headerActions?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** md 520 (default) · lg 680. */
  size?: keyof typeof sizeClass;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  bodyClassName?: string;
}

/**
 * A side panel for reading or editing one record without leaving the list.
 * It floats over the page from the right edge at every width (at tablet width
 * it covers most of the content), with the same layer behaviour as `Dialog`.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  icon,
  header,
  headerActions,
  children,
  footer,
  size = "md",
  busy = false,
  initialFocusRef,
  className,
  bodyClassName,
}: DrawerProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement | null>(null);

  useModalLayer({ open, onClose, panelRef, initialFocusRef, dismissible: !busy });

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[55]">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[var(--scrim-soft)] motion-safe:animate-ui-fade"
        onClick={() => {
          if (!busy) onClose();
        }}
      />
      <aside
        aria-busy={busy || undefined}
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={cn(
          "absolute bottom-2 right-2 top-2 flex min-h-0 flex-col rounded-[var(--radius-xl)]",
          "bg-[var(--surface-raised)] text-[length:var(--text-size-body)] text-[var(--text-primary)] shadow-[var(--shadow-modal)]",
          "focus:outline-none motion-safe:animate-ui-slide-in",
          sizeClass[size],
          className,
        )}
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-[var(--border-subtle)] px-5 pb-3.5 pt-[18px]">
          {icon && <span className="shrink-0">{icon}</span>}
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
            {header}
          </div>
          {headerActions && <div className="flex shrink-0 items-center gap-1">{headerActions}</div>}
          <LayerCloseButton disabled={busy} label="Close panel" onClick={onClose} />
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto p-5", bodyClassName)}>{children}</div>
        {footer && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3">
            {footer}
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}

/** A titled group inside a drawer body. */
export function DrawerSection({
  title,
  actions,
  children,
  className,
}: {
  title: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-6 last:mb-0", className)}>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="text-[length:var(--text-size-meta)] font-semibold text-[var(--text-primary)]">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

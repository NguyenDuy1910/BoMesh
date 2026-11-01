"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/cn";

type Side = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  label: string;
  /** One element, usually a button. It must carry its own accessible name. */
  children: React.ReactNode;
  /** Preferred side; flips when there is no room. Defaults to `top`. */
  side?: Side;
  /** Hover delay in milliseconds. Keyboard focus shows it at once. Defaults to 350. */
  delay?: number;
  disabled?: boolean;
  className?: string;
}

const GAP = 6;
const MARGIN = 8;
const OPPOSITE: Record<Side, Side> = { top: "bottom", bottom: "top", left: "right", right: "left" };

/**
 * Names or briefly explains a control on hover and keyboard focus.
 *
 * Touch users never see it, so it never carries the only label or the only
 * copy of an instruction: the control keeps its own `aria-label`, and the text
 * is also linked as the control's description for screen readers (skipped
 * when it would only repeat the accessible name). The bubble is portalled so
 * a scrolling rail or table cannot clip it; Escape dismisses it.
 */
export function Tooltip({ label, children, side = "top", delay = 350, disabled, className }: TooltipProps) {
  const descriptionId = useId();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const timer = useRef(0);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen(false);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.getBoundingClientRect();
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const { offsetWidth: width, offsetHeight: height } = bubble;
    const fits: Record<Side, boolean> = {
      top: anchor.top - GAP - height >= MARGIN,
      bottom: anchor.bottom + GAP + height <= window.innerHeight - MARGIN,
      left: anchor.left - GAP - width >= MARGIN,
      right: anchor.right + GAP + width <= window.innerWidth - MARGIN,
    };
    const placed = fits[side] || !fits[OPPOSITE[side]] ? side : OPPOSITE[side];
    const clampX = (x: number) => Math.min(Math.max(MARGIN, x), window.innerWidth - width - MARGIN);
    const clampY = (y: number) => Math.min(Math.max(MARGIN, y), window.innerHeight - height - MARGIN);
    const centreX = anchor.left + anchor.width / 2 - width / 2;
    const centreY = anchor.top + anchor.height / 2 - height / 2;
    const position = {
      top: { left: clampX(centreX), top: anchor.top - GAP - height },
      bottom: { left: clampX(centreX), top: anchor.bottom + GAP },
      left: { left: anchor.left - GAP - width, top: clampY(centreY) },
      right: { left: anchor.right + GAP, top: clampY(centreY) },
    }[placed];
    setStyle(position);
  }, [open, side, label]);

  const show = (immediately: boolean) => {
    if (disabled) return;
    window.clearTimeout(timer.current);
    if (immediately) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), delay);
  };

  const child = isValidElement<{ "aria-label"?: string; "aria-describedby"?: string }>(children)
    ? children
    : null;
  const describes = child !== null && child.props["aria-label"] !== label;
  const content =
    child && describes
      ? cloneElement(child, {
          "aria-describedby": [child.props["aria-describedby"], descriptionId].filter(Boolean).join(" "),
        })
      : children;

  return (
    <span
      className={cn("relative inline-flex", className)}
      onBlur={hide}
      onFocus={(event) => show(event.target.matches(":focus-visible"))}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        // Dismiss the tooltip before anything else reacts to Escape.
        event.preventDefault();
        hide();
      }}
      onPointerDown={hide}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") show(false);
      }}
      onPointerLeave={hide}
      ref={anchorRef}
    >
      {content}
      {describes && (
        <span className="sr-only" id={descriptionId}>
          {label}
        </span>
      )}
      {open &&
        createPortal(
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none fixed z-[95] w-max max-w-[280px] rounded-[var(--radius-sm)] px-2 py-1",
              "bg-[var(--surface-inverse)] text-[length:var(--text-size-caption)] font-medium leading-4 text-[var(--text-inverse)]",
              "motion-safe:animate-ui-fade",
            )}
            data-layer-persistent=""
            ref={bubbleRef}
            style={style}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}

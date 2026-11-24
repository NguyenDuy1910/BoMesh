"use client";

import { Button, Drawer, Popover } from "@heroui/react";
import clsx from "clsx";
import { X } from "lucide-react";
import { useState, type ReactNode } from "react";

/** Below this app width a popover opens as a bottom sheet (preview `isPhone()`, `#frame` < 680 px). */
const SHEET = 680;

export interface PopoverSheetProps {
  /** The trigger: a `<Pressable>`-wrapped `<button>` or a HeroUI `<Button>`, as for a HeroUI Popover. */
  trigger: ReactNode;
  title: string;
  /** Body: the controls that stay open while you work in them. */
  children: ReactNode;
  /** Footer actions (Reset, Clear…); on phones the sheet's Done follows them. */
  footer?: ReactNode;
  placement?: "bottom start" | "bottom end";
  /** On the body, in both forms. */
  bodyClassName?: string;
  /** On the anchored popover only (e.g. its width). */
  className?: string;
  /** Called when it opens or closes, in either form. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * A titled popover for inline filters and small pickers (preview `PO[name]` + `popoverHtml()`): header with its ×, a
 * scrolling body and an optional footer, anchored under its trigger. On phones it opens as a bottom sheet instead, over a
 * dimmed backdrop, without the × and with a primary Done after the footer actions.
 */
export function PopoverSheet({ trigger, title, children, footer, placement = "bottom start", bodyClassName, className, onOpenChange: notify }: PopoverSheetProps) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const onOpenChange = (next: boolean) => {
    if (next) setSheet(document.body.clientWidth < SHEET);
    setOpen(next);
    notify?.(next);
  };
  return (
    <>
      <Popover isOpen={open && !sheet} onOpenChange={onOpenChange}>
        {trigger}
        <Popover.Content placement={placement} className={className}>
          <Popover.Dialog>
            <div className="popover__header">
              <Popover.Heading className="popover__title">{title}</Popover.Heading>
              <Button slot="close" isIconOnly size="sm" variant="ghost" aria-label="Đóng" className="popover__close">
                <X aria-hidden />
              </Button>
            </div>
            <div className={clsx("popover__body", bodyClassName)}>{children}</div>
            {footer ? <div className="popover__footer">{footer}</div> : null}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <Drawer.Backdrop isOpen={open && sheet} onOpenChange={onOpenChange}>
        <Drawer.Content placement="bottom" className="popover-sheet">
          <Drawer.Dialog aria-label={title}>
            <Drawer.Header>
              <Drawer.Heading>{title}</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body className={bodyClassName}>{children}</Drawer.Body>
            <Drawer.Footer>
              {footer}
              <Button slot="close" variant="primary" className="popover__done">
                Xong
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </>
  );
}

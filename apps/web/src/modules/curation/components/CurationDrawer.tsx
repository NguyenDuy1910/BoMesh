"use client";

import { Drawer } from "@heroui/react";
import clsx from "clsx";
import type { ReactNode } from "react";

export interface CurationDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Leading tile next to the title (file icon, item icon). */
  lead?: ReactNode;
  /** Icon buttons beside the close button (Open, Download). */
  headActions?: ReactNode;
  /** md 480 · lg 720 · xl 960 px. */
  size?: "md" | "lg" | "xl";
  children: ReactNode;
  footer?: ReactNode;
  footerStart?: ReactNode;
}

/** The preview's drawer anatomy (`openDrawer`: lead, title, description, head actions, body, footer with a start slot) on HeroUI Drawer. */
export function CurationDrawer({ isOpen, onClose, title, description, lead, headActions, size = "md", children, footer, footerStart }: CurationDrawerProps) {
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className={clsx(size !== "md" && `drawer__dialog--${size}`)}>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <div className="row gap-12">
              {lead}
              <div className="grow min-w-0">
                <Drawer.Heading className="truncate">{title}</Drawer.Heading>
                {description ? <p className="drawer__description">{description}</p> : null}
              </div>
              {headActions ? <div className="row gap-4 none">{headActions}</div> : null}
            </div>
          </Drawer.Header>
          <Drawer.Body>{children}</Drawer.Body>
          {footer || footerStart ? (
            <Drawer.Footer>
              {footerStart ? <div className="drawer__footer-start row gap-8">{footerStart}</div> : null}
              {footer}
            </Drawer.Footer>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

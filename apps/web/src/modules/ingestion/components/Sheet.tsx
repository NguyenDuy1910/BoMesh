"use client";

import { Drawer } from "@heroui/react";
import type { ReactNode } from "react";

export interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** Leading tile next to the title (app icon). */
  lead?: ReactNode;
  /** Icon buttons beside the close button (⋯ menu). */
  headActions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

/** The preview's drawer anatomy (lead, title, description, head actions, body, footer) on HeroUI Drawer. */
export function Sheet({ isOpen, onClose, title, description, lead, headActions, children, footer }: SheetProps) {
  return (
    <Drawer.Backdrop isOpen={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <div className="row gap-12">
              {lead}
              <div className="grow src-min">
                <Drawer.Heading className="truncate" translate="no">
                  {title}
                </Drawer.Heading>
                {description ? <p className="drawer__description">{description}</p> : null}
              </div>
              {headActions ? <div className="row gap-4 none">{headActions}</div> : null}
            </div>
          </Drawer.Header>
          <Drawer.Body>{children}</Drawer.Body>
          {footer ? <Drawer.Footer>{footer}</Drawer.Footer> : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

/** A drawer section with its heading row and optional trailing action. */
export function SheetSection({ title, actions, id, children }: { title: string; actions?: ReactNode; id?: string; children: ReactNode }) {
  return (
    <section className="drawer__section" id={id}>
      <div className="src-sec__head">
        <h3 className="drawer__section-title">{title}</h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

"use client";

import { Drawer } from "@heroui/react";
import type { ReactNode } from "react";

export interface SideDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Leading avatar / icon tile beside the title. */
  lead?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Footer start (secondary / destructive actions). */
  footStart?: ReactNode;
  /** Footer end (the primary action). */
  foot?: ReactNode;
  /** Title is workspace content (a person's or group's name). */
  contentTitle?: boolean;
  children: ReactNode;
}

/** Right-side detail drawer (preview `DR[...]`: lead, title, description, body, footer start/end). */
export function SideDrawer({ isOpen, onClose, lead, title, description, footStart, foot, contentTitle, children }: SideDrawerProps) {
  return (
    <Drawer.Backdrop variant="transparent" isOpen={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Drawer.Content placement="right">
        <Drawer.Dialog>
          <Drawer.CloseTrigger aria-label="Close" />
          <Drawer.Header>
            <div className="row gap-12" style={{ alignItems: "flex-start" }}>
              {lead}
              <div className="grow" style={{ minWidth: 0 }}>
                <Drawer.Heading translate={contentTitle ? "no" : undefined}>{title}</Drawer.Heading>
                {description ? <p className="drawer__description">{description}</p> : null}
              </div>
            </div>
          </Drawer.Header>
          <Drawer.Body>{children}</Drawer.Body>
          {foot || footStart ? (
            <Drawer.Footer>
              {footStart ? <div className="drawer__footer-start row gap-8">{footStart}</div> : null}
              {foot}
            </Drawer.Footer>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}

/** A titled drawer section (preview `drawer__section`). */
export function DrawerSection({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="drawer__section">
      <div className="row between gap-8">
        <h3 className="drawer__section-title">{title}</h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

"use client";

import { Modal } from "@heroui/react";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  /** One sentence under the title (preview modal `desc`). */
  description?: ReactNode;
  /** Icon tile left of the title (preview modal `icon`): names the action at a glance. */
  icon?: LucideIcon;
  /** Icon tile tone (preview modal `tone`); accent by default. */
  tone?: "success" | "warning" | "danger" | "default";
  size?: "sm" | "md" | "lg";
  /** While saving: no dismiss by Escape, backdrop or close button. */
  guard?: boolean;
  /** Muted note at the footer's start (preview `footStart`). */
  footerStart?: ReactNode;
  footer: ReactNode;
  children?: ReactNode;
}

/** The preview's modal anatomy on HeroUI Modal: icon tile, heading and description, body, footer with an optional start note. */
export function Dialog({ isOpen, onClose, title, description, icon: Icon, tone, size = "sm", guard, footerStart, footer, children }: DialogProps) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open || guard ? undefined : onClose())} isDismissable={!guard} isKeyboardDismissDisabled={guard}>
      <Modal.Container size={size} placement="auto" scroll="inside">
        <Modal.Dialog>
          {guard ? null : <Modal.CloseTrigger aria-label="Close" />}
          <Modal.Header>
            {Icon ? (
              <span className={clsx("modal__icon", tone && `modal__icon--${tone}`)} aria-hidden>
                <Icon />
              </span>
            ) : null}
            <div className="grow" style={{ minWidth: 0 }}>
              <Modal.Heading>{title}</Modal.Heading>
              {description ? <p className="modal__description">{description}</p> : null}
            </div>
          </Modal.Header>
          {children ? <Modal.Body className="stack gap-16">{children}</Modal.Body> : null}
          <Modal.Footer>
            {footerStart ? <div className="grow row t-sm muted">{footerStart}</div> : null}
            {footer}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

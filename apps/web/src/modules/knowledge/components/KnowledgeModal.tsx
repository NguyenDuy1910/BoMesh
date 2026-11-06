"use client";

import { Modal } from "@heroui/react";
import type { ReactNode } from "react";

export interface KnowledgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Muted line under the title (preview modal `desc`). */
  description?: ReactNode;
  /** sm 380 · md 440 · lg 600 px (preview modal sizes). */
  size?: "sm" | "md" | "lg";
  /** Prevents closing (e.g. while uploading; preview `guard`). */
  guard?: boolean;
  children: ReactNode;
  /** Footer buttons, right-aligned. */
  footer?: ReactNode;
  /** Left side of the footer (preview `footStart`). */
  footerStart?: ReactNode;
}

/** The preview's modal anatomy on HeroUI Modal: heading + description, body, footer with an optional start slot. */
export function KnowledgeModal({ isOpen, onClose, title, description, size = "md", guard, children, footer, footerStart }: KnowledgeModalProps) {
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open || guard ? undefined : onClose())} isDismissable={!guard} isKeyboardDismissDisabled={guard}>
      <Modal.Container placement="auto" scroll="inside">
        <Modal.Dialog className={`modal__dialog--${size}`}>
          {guard ? null : <Modal.CloseTrigger aria-label="Close" />}
          <Modal.Header>
            <Modal.Heading>{title}</Modal.Heading>
            {description ? <p className="modal__description">{description}</p> : null}
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
          {footer || footerStart ? (
            <Modal.Footer>
              {footerStart ? <div className="grow row">{footerStart}</div> : null}
              {footer}
            </Modal.Footer>
          ) : null}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

"use client";

import { Modal } from "@heroui/react";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface KnowledgeModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Muted line under the title (preview modal `desc`). */
  description?: ReactNode;
  /** Icon tile that names the action at a glance (preview modal `icon`). */
  icon?: LucideIcon;
  /** Icon tile tone (preview modal `tone`, default accent). */
  tone?: "accent" | "success" | "warning" | "danger" | "default";
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

/** The preview's modal anatomy on HeroUI Modal: icon tile, heading + description, body, footer with an optional start slot. */
export function KnowledgeModal({ isOpen, onClose, title, description, icon: Icon, tone = "accent", size = "md", guard, children, footer, footerStart }: KnowledgeModalProps) {
  const heading = (
    <>
      <Modal.Heading>{title}</Modal.Heading>
      {description ? <p className="modal__description">{description}</p> : null}
    </>
  );
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => (open || guard ? undefined : onClose())} isDismissable={!guard} isKeyboardDismissDisabled={guard}>
      <Modal.Container placement="auto" scroll="inside">
        <Modal.Dialog className={`modal__dialog--${size}`}>
          {guard ? null : <Modal.CloseTrigger aria-label="Close" />}
          <Modal.Header>
            {Icon ? (
              <>
                <Modal.Icon className={clsx(tone !== "accent" && `modal__icon--${tone}`)} aria-hidden>
                  <Icon className="i" />
                </Modal.Icon>
                <div className="grow min-w-0">{heading}</div>
              </>
            ) : (
              heading
            )}
          </Modal.Header>
          <Modal.Body>{children}</Modal.Body>
          {footer || footerStart ? (
            <Modal.Footer>
              {footerStart ? <div className="modal__footer-start row gap-8">{footerStart}</div> : null}
              {footer}
            </Modal.Footer>
          ) : null}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

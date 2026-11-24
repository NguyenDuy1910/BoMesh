"use client";

import { Button, FieldError, Input, Label, Modal, TextField } from "@heroui/react";
import clsx from "clsx";
import { CircleHelp, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import type { PendingConfirm } from "./Confirm";

/**
 * The confirmation dialog rendered by `<ConfirmHost/>` (preview `M.confirm`); loaded on the first `confirm()`. A small alert
 * dialog with the modal anatomy: an icon tile (alert for destructive actions, help otherwise), the consequence, and a footer
 * band with a quiet Cancel and the named action.
 */
export function ConfirmDialog({ pending, onSettle }: { pending: PendingConfirm | null; onSettle: (ok: boolean) => void }) {
  return (
    <Modal.Backdrop isOpen={pending !== null} onOpenChange={(open) => (open ? undefined : onSettle(false))}>
      <Modal.Container placement="auto" scroll="inside">
        <Modal.Dialog className="modal__dialog--sm" role="alertdialog">
          {pending ? <ConfirmBody key={pending.id} pending={pending} onSettle={onSettle} /> : null}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function ConfirmBody({ pending, onSettle }: { pending: PendingConfirm; onSettle: (ok: boolean) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const danger = (pending.tone ?? "danger") === "danger";
  const Icon = danger ? TriangleAlert : CircleHelp;
  // Typed confirmation validates on submit and clears as soon as the text matches (preview `confirm-typed`).
  const ok = () => {
    if (pending.typed !== undefined && text !== pending.typed) {
      setError(`Nhập chính xác ${pending.typed} để xác nhận.`);
      input.current?.focus();
      return;
    }
    onSettle(true);
  };
  return (
    <>
      <Modal.CloseTrigger aria-label="Đóng" />
      <Modal.Header>
        <Modal.Icon className={clsx(danger && "modal__icon--danger")} aria-hidden>
          <Icon className="i" />
        </Modal.Icon>
        <div className="grow min-w-0">
          <Modal.Heading>{pending.title}</Modal.Heading>
        </div>
      </Modal.Header>
      {pending.description || pending.typed ? (
        <Modal.Body>
          {pending.description ? <p className="muted">{pending.description}</p> : null}
          {pending.typed ? (
            <TextField
              className={clsx(pending.description && "mt-16")}
              value={text}
              onChange={(next) => {
                setText(next);
                if (error && next === pending.typed) setError("");
              }}
              isInvalid={Boolean(error)}
              autoFocus
            >
              <Label>{`Nhập ${pending.typed} để xác nhận`}</Label>
              <Input ref={input} className="mono" autoComplete="off" spellCheck={false} onKeyDown={(e) => e.key === "Enter" && ok()} />
              <FieldError>{error}</FieldError>
            </TextField>
          ) : null}
        </Modal.Body>
      ) : null}
      <Modal.Footer>
        <Button variant="ghost" onPress={() => onSettle(false)}>
          {pending.cancelLabel ?? "Hủy"}
        </Button>
        <Button variant={danger ? "danger" : "primary"} onPress={ok} autoFocus={!pending.typed}>
          {pending.confirmLabel ?? "Xác nhận"}
        </Button>
      </Modal.Footer>
    </>
  );
}

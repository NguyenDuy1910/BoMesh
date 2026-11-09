"use client";

import { AlertDialog, Button, Input, Label, TextField } from "@heroui/react";
import { useState } from "react";

import type { PendingConfirm } from "./Confirm";

/** The confirmation dialog (HeroUI AlertDialog) rendered by `<ConfirmHost/>`; loaded on the first `confirm()`. */
export function ConfirmDialog({ pending, onSettle }: { pending: PendingConfirm | null; onSettle: (ok: boolean) => void }) {
  return (
    <AlertDialog.Backdrop isOpen={pending !== null} onOpenChange={(open) => (open ? undefined : onSettle(false))} isKeyboardDismissDisabled={false}>
      <AlertDialog.Container size="sm" placement="auto">
        <AlertDialog.Dialog className="confirm-dialog">{pending ? <ConfirmBody key={pending.id} pending={pending} onSettle={onSettle} /> : null}</AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function ConfirmBody({ pending, onSettle }: { pending: PendingConfirm; onSettle: (ok: boolean) => void }) {
  const [text, setText] = useState("");
  const blocked = pending.typed !== undefined && text !== pending.typed;
  const danger = (pending.tone ?? "danger") === "danger";
  return (
    <>
      <AlertDialog.CloseTrigger aria-label="Close" />
      <AlertDialog.Header>
        <AlertDialog.Heading>{pending.title}</AlertDialog.Heading>
      </AlertDialog.Header>
      {pending.description || pending.typed ? (
        <AlertDialog.Body>
          {pending.description ? <p className="muted">{pending.description}</p> : null}
          {pending.typed ? (
            <TextField className="mt-16" value={text} onChange={setText} autoFocus>
              <Label>{`Type ${pending.typed} to confirm`}</Label>
              <Input className="mono" autoComplete="off" spellCheck={false} />
            </TextField>
          ) : null}
        </AlertDialog.Body>
      ) : null}
      <AlertDialog.Footer>
        <Button variant="tertiary" onPress={() => onSettle(false)}>
          {pending.cancelLabel ?? "Cancel"}
        </Button>
        <Button variant={danger ? "danger" : "primary"} isDisabled={blocked} onPress={() => onSettle(true)} autoFocus={!pending.typed}>
          {pending.confirmLabel ?? "Confirm"}
        </Button>
      </AlertDialog.Footer>
    </>
  );
}

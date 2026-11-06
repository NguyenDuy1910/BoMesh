"use client";

import { AlertDialog, Button, Input, Label, TextField } from "@heroui/react";
import { useState, useSyncExternalStore, type ReactNode } from "react";

export interface ConfirmOptions {
  title: string;
  /** Consequence in plain language (what happens, whether it can be undone). */
  description?: ReactNode;
  /** Confirm button label (default "Confirm"); name the action ("Remove member"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for destructive actions (red button, alert dialog), `accent` for consequential ones. Default `danger`. */
  tone?: "danger" | "accent";
  /** Typed confirmation: the confirm button stays disabled until this exact text is typed. */
  typed?: string;
}

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function setCurrent(next: Pending | null) {
  current = next;
  for (const listener of listeners) listener();
}

/**
 * Asks for confirmation before an irreversible action (preview `confirmAction()`).
 * Resolves `true` on confirm, `false` on cancel/close. Rendered by `<ConfirmHost/>`.
 *
 * ```ts
 * if (await confirm({ title: "Remove Linh?", description: "They lose access now.", confirmLabel: "Remove" })) remove();
 * ```
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  current?.resolve(false);
  return new Promise<boolean>((resolve) => setCurrent({ ...options, id: ++seq, resolve }));
}

function settle(ok: boolean) {
  const pending = current;
  if (!pending) return;
  setCurrent(null);
  pending.resolve(ok);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Confirmation dialog host (HeroUI AlertDialog); mount once in the root providers. */
export function ConfirmHost() {
  const pending = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return (
    <AlertDialog.Backdrop isOpen={pending !== null} onOpenChange={(open) => (open ? undefined : settle(false))} isKeyboardDismissDisabled={false}>
      <AlertDialog.Container size="sm" placement="auto">
        <AlertDialog.Dialog className="confirm-dialog">{pending ? <ConfirmBody key={pending.id} pending={pending} /> : null}</AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function ConfirmBody({ pending }: { pending: Pending }) {
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
        <Button variant="tertiary" onPress={() => settle(false)}>
          {pending.cancelLabel ?? "Cancel"}
        </Button>
        <Button variant={danger ? "danger" : "primary"} isDisabled={blocked} onPress={() => settle(true)} autoFocus={!pending.typed}>
          {pending.confirmLabel ?? "Confirm"}
        </Button>
      </AlertDialog.Footer>
    </>
  );
}

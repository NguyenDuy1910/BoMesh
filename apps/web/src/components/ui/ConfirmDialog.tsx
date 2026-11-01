"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { isConfirmationSatisfied } from "@/components/ui/interaction";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Runs the action. While its promise is pending the dialog is busy and
   * cannot be dismissed; when it resolves the dialog closes, when it throws
   * the error message is shown and the dialog stays open for a retry.
   */
  onConfirm: () => Promise<void> | void;
  title: string;
  /** What will happen, in one or two sentences the user can act on. */
  description: React.ReactNode;
  /** The verb on the button, e.g. "Archive workspace". A follow-up toast repeats it. */
  confirmLabel: string;
  cancelLabel?: string;
  /** Danger tone: a red confirm button and Cancel as the initial focus. Defaults to `true`. */
  destructive?: boolean;
  /**
   * Typed confirmation for irreversible, wide-reaching actions: the confirm
   * button stays disabled until exactly this text is typed.
   */
  confirmText?: string;
}

/**
 * Every irreversible action goes through this, so the wording, the button
 * order and the error handling are the same wherever it is used.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  confirmText,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const fieldId = useId();

  // Each opening starts clean.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setTyped("");
  }, [open]);

  const satisfied = isConfirmationSatisfied(confirmText, typed);

  async function confirm() {
    if (!satisfied || pending) return;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      busy={pending}
      footer={
        <>
          <Button data-autofocus={destructive && !confirmText ? "" : undefined} disabled={pending} onClick={onClose} variant="secondary">
            {cancelLabel}
          </Button>
          <Button
            data-autofocus={!destructive && !confirmText ? "" : undefined}
            disabled={!satisfied}
            loading={pending}
            onClick={() => void confirm()}
            variant={destructive ? "danger" : "primary"}
          >
            {confirmLabel}
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      role="alertdialog"
      size="sm"
      title={title}
    >
      <div className="space-y-4">
        <div className="text-[length:var(--text-size-body)] text-[var(--text-secondary)]">{description}</div>
        {confirmText && (
          <form
            className="grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <label className="text-[length:var(--text-size-body)] font-medium text-[var(--text-primary)]" htmlFor={fieldId}>
              Type “{confirmText}” to confirm
            </label>
            <Input
              autoCapitalize="off"
              autoComplete="off"
              disabled={pending}
              id={fieldId}
              onChange={(event) => setTyped(event.target.value)}
              spellCheck={false}
              value={typed}
            />
          </form>
        )}
        {error && <Callout tone="err">{error}</Callout>}
      </div>
    </Dialog>
  );
}

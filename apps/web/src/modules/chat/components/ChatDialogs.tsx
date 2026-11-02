"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { FormField } from "@/components/ui/FormField";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/Toast";
import { deleteConversation, renameConversation } from "../chat-runtime";

const TITLE_MAX = 80;

function titleError(value: string): string | null {
  if (!value.trim()) return "Enter a name for this chat.";
  if (value.trim().length > TITLE_MAX) return `Use ${TITLE_MAX} characters or fewer.`;
  return null;
}

/** Rename a chat. The list keeps its place; only new messages move a chat up. */
export function RenameChatDialog({
  conversationId,
  title,
  open,
  onClose,
}: {
  conversationId: string;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(title);
    setError(null);
  }, [open, title]);

  const save = async () => {
    const problem = titleError(value);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      await renameConversation(conversationId, value);
      toast.show({ message: "Chat renamed" });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The chat couldn’t be renamed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      busy={busy}
      footer={(
        <>
          <Button disabled={busy} onClick={onClose} variant="secondary">Cancel</Button>
          <Button loading={busy} onClick={() => void save()} variant="primary">Save</Button>
        </>
      )}
      onClose={onClose}
      open={open}
      size="sm"
      title="Rename chat"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FormField error={error ?? undefined} htmlFor="chat-rename" label="Name" required>
          <Input
            data-autofocus
            maxLength={TITLE_MAX + 20}
            onBlur={() => {
              if (error) setError(titleError(value));
            }}
            onChange={(event) => setValue(event.target.value)}
            onFocus={(event) => event.target.select()}
            value={value}
          />
        </FormField>
      </form>
    </Dialog>
  );
}

/** Delete a chat from this device, with the files uploaded into it. */
export function DeleteChatDialog({
  conversationId,
  title,
  open,
  onClose,
  onDeleted,
}: {
  conversationId: string;
  title: string;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const toast = useToast();
  return (
    <ConfirmDialog
      confirmLabel="Delete chat"
      description={`“${title}” will be removed from your chats on this device, with the files you uploaded into it. Documents added from knowledge stay where they are. This can’t be undone.`}
      onClose={onClose}
      onConfirm={async () => {
        await deleteConversation(conversationId);
        toast.show({ message: "Chat deleted" });
        onDeleted?.();
      }}
      open={open}
      title="Delete this chat?"
    />
  );
}

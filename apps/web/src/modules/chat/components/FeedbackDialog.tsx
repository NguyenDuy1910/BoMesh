"use client";

import { Button, FieldError, Label, Modal, TextArea, TextField } from "@heroui/react";
import { useEffect, useState } from "react";

/** "Something else…" under Bad answer (preview `M['chat-feedback']`). */
export function FeedbackDialog({ isOpen, onClose, onSubmit }: { isOpen: boolean; onClose: () => void; onSubmit: (comment: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setText("");
    setError("");
  }, [isOpen]);

  const send = async () => {
    if (!text.trim()) {
      setError("Add a short comment.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(text.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => !open && !busy && onClose()}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="Close" />
          <Modal.Header>
            <Modal.Heading>What was wrong with this answer?</Modal.Heading>
            <p className="modal__description">Your feedback goes to the workspace admins.</p>
          </Modal.Header>
          <Modal.Body>
            <TextField
              fullWidth
              value={text}
              onChange={(v) => {
                setText(v);
                setError("");
              }}
              isInvalid={!!error}
              autoFocus
            >
              <Label>Tell us more</Label>
              <TextArea id="chat-fb-text" rows={3} placeholder="What should the answer have said?" />
              <FieldError>{error}</FieldError>
            </TextField>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={onClose} isDisabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" isPending={busy} onPress={() => void send()}>
              Send feedback
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

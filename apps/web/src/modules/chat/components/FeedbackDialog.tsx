"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { MessageSquare, Send, ThumbsDown } from "lucide-react";
import { useEffect, useState } from "react";

import { ItemIcon } from "@/components/ui/ItemIcon";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

/** Longest feedback note (preview `FB_MAX`). */
export const FEEDBACK_MAX = 140;

/** "Something else…" under Bad answer (preview `M['chat-feedback']`): a short note the workspace admins see with the answer. */
export function FeedbackDialog({ isOpen, question, onClose, onSubmit }: { isOpen: boolean; question?: string; onClose: () => void; onSubmit: (comment: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setText("");
    setTouched(false);
  }, [isOpen]);
  const error = touched && !text.trim() ? "Thêm một ghi chú ngắn để quản trị viên biết cần sửa gì." : "";

  const send = async () => {
    setTouched(true);
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSubmit(text.trim().slice(0, FEEDBACK_MAX));
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <KnowledgeModal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      icon={ThumbsDown}
      title="Gửi phản hồi"
      description="Quản trị viên không gian làm việc sẽ xem phản hồi cùng câu trả lời này và dùng nó để sửa tài liệu."
      guard={busy}
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={busy}>
            Hủy
          </Button>
          <Button variant="primary" isPending={busy} onPress={() => void send()}>
            <Send className="i" aria-hidden />
            Gửi phản hồi
          </Button>
        </>
      }
    >
      {question ? (
        <div className="chat-ctx">
          <ItemIcon icon={MessageSquare} size="sm" />
          <div className="grow">
            <div className="chat-ctx__title truncate" translate="no">{`“${question}”`}</div>
            <div className="t-xs muted truncate">Câu hỏi bạn đã hỏi</div>
          </div>
        </div>
      ) : null}
      <TextField fullWidth value={text} onChange={setText} isInvalid={!!error} maxLength={FEEDBACK_MAX} isDisabled={busy} autoFocus>
        <Label>Có vấn đề gì?</Label>
        <TextArea
          id="chat-fb-text"
          rows={3}
          placeholder="VD: Câu trả lời trích dẫn phiên bản chính sách của năm ngoái"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error ? (
          <FieldError>{error}</FieldError>
        ) : (
          <div className="row between gap-12">
            <span />
            <Description className="counter num">{`${text.length}/${FEEDBACK_MAX}`}</Description>
          </div>
        )}
      </TextField>
    </KnowledgeModal>
  );
}

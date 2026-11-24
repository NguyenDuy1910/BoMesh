"use client";

import { Button, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { Check, CircleX, Pencil, Quote, Send } from "lucide-react";
import { useRef, useState } from "react";

import { FileIcon } from "@/components/ui";
import { plural } from "@/lib/format";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";

import { QUICK_REPLIES } from "../model";

export interface DecideRequest {
  mode: "changes" | "decline";
  /** Submissions the decision covers. */
  titles: string[];
  /** The one document's file (shown above the message). */
  fileName?: string;
  mime?: string;
  /** Contributor name (one member submission). */
  contributor?: string;
}

/**
 * Request changes / Decline (preview `M['cur-decide']`): the document, a required message the contributor sees,
 * then common replies as quiet rows. The decision has Undo right after.
 */
export function DecideDialog({ request, onClose, onSubmit }: { request: DecideRequest | null; onClose: () => void; onSubmit: (message: string) => void }) {
  return request ? <DecideForm key={`${request.mode}:${request.titles.join("|")}`} request={request} onClose={onClose} onSubmit={onSubmit} /> : null;
}

function DecideForm({ request, onClose, onSubmit }: { request: DecideRequest; onClose: () => void; onSubmit: (message: string) => void }) {
  const [text, setText] = useState("");
  const [tried, setTried] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const changes = request.mode === "changes";
  const n = request.titles.length;
  const person = n === 1 ? request.contributor : "";
  const error = tried && !text.trim() ? (changes ? "Cho người gửi biết cần sửa gì." : "Nêu lý do. Người gửi sẽ thấy.") : "";
  const desc = changes
    ? n > 1
      ? "Mỗi người gửi sẽ nhận được lời nhắn của bạn và có thể gửi lại."
      : person
        ? `${person} sẽ nhận được lời nhắn của bạn và có thể gửi lại.`
        : "Lời nhắn của bạn được lưu trong lịch sử của tài liệu."
    : n > 1
      ? "Các tài liệu này sẽ không được công bố. Mỗi người gửi sẽ thấy lý do của bạn."
      : person
        ? `Tài liệu sẽ không được công bố. ${person} sẽ thấy lý do của bạn.`
        : "Tài liệu sẽ không được công bố. Lý do của bạn được lưu trong lịch sử tài liệu.";

  const submit = () => {
    setTried(true);
    if (!text.trim()) {
      ref.current?.focus();
      return;
    }
    onSubmit(text.trim());
  };
  const quick = (q: string) => {
    setText(q);
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(q.length, q.length);
    });
  };

  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      size="md"
      icon={changes ? Pencil : CircleX}
      tone={changes ? "warning" : "danger"}
      title={changes ? "Yêu cầu chỉnh sửa" : n > 1 ? `Từ chối ${plural(n, "submission")}` : "Từ chối tài liệu chờ duyệt"}
      description={desc}
      footerStart={<span className="t-xs muted">Bạn có thể hoàn tác ngay sau đó.</span>}
      footer={
        <>
          <Button variant="ghost" onPress={onClose}>
            Hủy
          </Button>
          <Button variant={changes ? "primary" : "danger"} onPress={submit}>
            {changes ? <Send className="i" aria-hidden /> : <CircleX className="i" aria-hidden />}
            {changes ? "Gửi yêu cầu" : n > 1 ? `Từ chối ${n}` : "Từ chối"}
          </Button>
        </>
      }
    >
      {n === 1 ? (
        <div className="cur-dec-doc">
          <FileIcon name={request.fileName} mime={request.mime} size="sm" />
          <span className="truncate" title={request.titles[0]} translate="no">
            {request.titles[0]}
          </span>
        </div>
      ) : null}
      <TextField className="field" value={text} onChange={setText} isRequired isInvalid={!!error} maxLength={600}>
        <Label>{changes ? "Cần thay đổi gì?" : "Lý do"}</Label>
        <TextArea ref={ref} rows={4} autoFocus placeholder={changes ? "Hãy nói cụ thể để họ có thể sửa một lần là xong." : "Hãy nêu lý do để họ biết nên làm gì thay thế."} />
        <FieldError>{error}</FieldError>
      </TextField>
      <div className="cur-quick" role="group" aria-labelledby="cur-quick-label">
        <div className="t-label" id="cur-quick-label">
          Hoặc bắt đầu từ một câu trả lời thường dùng
        </div>
        {QUICK_REPLIES[request.mode].map((q) => {
          const on = text.trim() === q;
          const Icon = on ? Check : Quote;
          return (
            <button key={q} type="button" className="cur-quick__opt" aria-pressed={on} onClick={() => quick(q)}>
              <Icon className="i i-sm" aria-hidden />
              <span>{q}</span>
            </button>
          );
        })}
      </div>
    </KnowledgeModal>
  );
}

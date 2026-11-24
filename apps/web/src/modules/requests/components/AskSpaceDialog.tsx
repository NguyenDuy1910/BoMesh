"use client";

import { Button, Description, FieldError, Label, TextArea, TextField } from "@heroui/react";
import { MessageSquare, Send, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { toast, UserAvatar } from "@/components/ui";
import { errorMessage, resourceId } from "@/lib/api/client";
import { KnowledgeModal } from "@/modules/knowledge/components/KnowledgeModal";
import { useSpaceStaff } from "@/modules/spaces/queries";

import { clip, teamWord, type Space } from "../model";
import { useCreateRequest } from "../queries";

export interface AskSpaceDialogProps {
  space: Space;
  isOpen: boolean;
  onClose: () => void;
  /** Prefilled question (e.g. "Ask the office instead" from a failed rule check). */
  initialQuestion?: string;
  /** Muted line after the space name ("About Annual leave"). */
  about?: string;
  /** Conversation message (`…/conversations/{c}/messages/{m}`) the caller owns; the server attaches its answer and citations. */
  sourceMessage?: string;
  /** What the assistant answered, shown as "Sent along" (display only). */
  assistantAnswer?: string;
}

/**
 * Ask a space's staff a question (preview `M['rq-ask']`): files a QUESTION request.
 * Used by "Ask the office instead" on /requests/new, the space header and chat escalation.
 */
export function AskSpaceDialog(props: AskSpaceDialogProps) {
  return props.isOpen ? <AskSpaceForm {...props} /> : null;
}

function AskSpaceForm({ space, onClose, initialQuestion, about, sourceMessage, assistantAnswer }: AskSpaceDialogProps) {
  const router = useRouter();
  const [text, setText] = useState(initialQuestion ?? "");
  const [error, setError] = useState("");
  const create = useCreateRequest();
  const staff = useSpaceStaff(resourceId(space.name));
  const team = staff.data?.members ?? [];
  const course = space.spaceType === "course";
  const note = course ? "Nhóm giảng dạy trả lời tại đây; bạn sẽ nhận câu trả lời trong Hộp thư." : `${space.displayName} trả lời tại đây; bạn sẽ nhận câu trả lời trong Hộp thư.`;

  const send = () => {
    const question = text.trim();
    if (!question) {
      setError("Nhập câu hỏi của bạn.");
      return;
    }
    setError("");
    create.mutate(
      { kind: "QUESTION", space: space.name, question, title: clip(question, 120), sourceMessage },
      {
        onSuccess: (r) => {
          onClose();
          toast(`Đã gửi câu hỏi đến ${teamWord(space)}`, { action: { label: "Mở", onPress: () => router.push(`/requests/${resourceId(r.name)}`) } });
        },
        onError: (e) => toast(errorMessage(e), { tone: "danger" }),
      },
    );
  };

  const names = team.map((m) => m.displayName ?? "");
  return (
    <KnowledgeModal
      isOpen
      onClose={onClose}
      guard={create.isPending}
      size="md"
      icon={MessageSquare}
      title={course ? `Hỏi nhóm giảng dạy ${space.displayName}` : `Hỏi ${space.displayName}`}
      description={note}
      footerStart={
        team.length ? (
          <span className="row gap-8" style={{ minWidth: 0 }}>
            <span className="rq-avatars">
              {team.slice(0, 3).map((m) => (
                <UserAvatar key={m.name} name={m.displayName ?? ""} size="xs" />
              ))}
            </span>
            <span className="truncate" translate="no">
              {names.length > 2 ? `${names.slice(0, 2).join(", ")} +${names.length - 2}` : names.join(" và ")}
            </span>
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button variant="ghost" onPress={onClose} isDisabled={create.isPending}>
            Hủy
          </Button>
          <Button variant="primary" onPress={send} isPending={create.isPending}>
            <Send className="i" aria-hidden />
            Gửi câu hỏi
          </Button>
        </>
      }
    >
      <TextField className="field" value={text} onChange={(v) => (setText(v), error && setError(""))} isRequired isInvalid={!!error}>
        <Label>Câu hỏi của bạn</Label>
        <TextArea rows={5} placeholder="Bạn muốn biết điều gì?" autoFocus translate="no" />
        {error ? <FieldError>{error}</FieldError> : <Description>{about ?? "Hãy nêu những gì bạn đã thử để họ trả lời một lần là đủ."}</Description>}
      </TextField>
      {assistantAnswer ? (
        <div className="rq-ai mt-16">
          <Sparkles className="i i-sm" aria-hidden />
          <div className="grow">
            <div className="rq-ai__label">Gửi kèm: thông tin trợ lý tìm được</div>
            <p translate="no">{clip(assistantAnswer, 280)}</p>
          </div>
        </div>
      ) : null}
    </KnowledgeModal>
  );
}

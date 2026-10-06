"use client";

import { Copy, Pencil } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { CHAT_LIMITS } from "../attachments";
import { getMessageText } from "../conversations";
import type { DocumentAccess } from "../hooks/useDocumentAccess";
import type { ChatMessage } from "../types";
import { AttachmentChip } from "./AttachmentChip";

/**
 * A question in the thread: its files, its text, and Copy / Edit. Editing
 * happens in place; sending the edit replaces the answer below (the caller
 * confirms first when later messages would be dropped).
 */
export const UserMessage = memo(function UserMessage({
  message,
  access,
  canEdit,
  onEdit,
}: {
  message: ChatMessage;
  access: ReadonlyMap<string, DocumentAccess>;
  /** False while an answer streams in this chat. */
  canEdit: boolean;
  onEdit: (messageId: string, text: string) => void;
}) {
  const toast = useToast();
  const text = getMessageText(message);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const documents = message.parts.flatMap((part) => part.type === "data-document" ? [part.data] : []);

  useEffect(() => {
    if (!editing) return;
    const textarea = editor.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  useEffect(() => {
    const textarea = editor.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 320)}px`;
  }, [draft, editing]);

  const cancel = () => {
    setEditing(false);
    setDraft(text);
    window.requestAnimationFrame(() => editButton.current?.focus());
  };
  const submit = () => {
    const next = draft.trim();
    if (!next || next.length > CHAT_LIMITS.messageCharacters) return;
    setEditing(false);
    onEdit(message.id, next);
  };

  return (
    <div className="group flex flex-col items-end gap-1" data-chat-role="user" id={`message-${message.id}`}>
      {documents.length > 0 && (
        <ul aria-label="Files on this message" className="flex flex-wrap justify-end gap-1.5">
          {documents.map((document) => (
            <li key={document.id}>
              <AttachmentChip
                attachment={{
                  name: document.fileName,
                  kind: document.origin === "reference" ? "reference" : "upload",
                  stage: "ready",
                  documentId: document.id,
                  locked: access.get(document.id) === "unreadable",
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <div className="flex w-[min(620px,100%)] flex-col gap-2">
          <textarea
            aria-label="Edit your message"
            className="min-h-20 w-full resize-none rounded-[14px] border border-border-default bg-surface-base px-4 py-2.5 text-[0.9375rem] leading-[1.55] text-text-primary outline-none focus:border-accent-primary focus:shadow-(--shadow-focus)"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            ref={editor}
            value={draft}
          />
          <div className="flex items-center justify-end gap-2">
            <span className="flex-1 text-meta text-text-tertiary">The answer below will be replaced.</span>
            <Button onClick={cancel} size="sm" variant="secondary">Cancel</Button>
            <Button disabled={!draft.trim() || draft.trim().length > CHAT_LIMITS.messageCharacters} onClick={submit} size="sm" variant="primary">
              Send
            </Button>
          </div>
        </div>
      ) : (
        <div className="max-w-[min(85%,620px)] whitespace-pre-wrap break-words rounded-[18px_18px_6px_18px] bg-surface-inset px-4 py-2.5 text-[0.9375rem] leading-[1.55] text-text-primary">
          {text}
        </div>
      )}
      {!editing && (
        <div className={cn(
          "flex gap-0.5 opacity-0 transition-opacity duration-(--duration-fast) focus-within:opacity-100 group-hover:opacity-100",
          "[@media(hover:none)]:opacity-100",
        )}>
          <Tooltip label="Copy">
            <Button
              aria-label="Copy"
              icon={<Copy aria-hidden="true" />}
              iconOnly
              onClick={() => {
                void navigator.clipboard.writeText(text).then(
                  () => toast.show({ message: "Copied" }),
                  () => toast.show({ tone: "err", message: "Copying isn’t allowed in this browser." }),
                );
              }}
              size="sm"
              variant="ghost"
            />
          </Tooltip>
          <Tooltip label="Edit">
            <Button
              aria-label="Edit"
              disabled={!canEdit}
              icon={<Pencil aria-hidden="true" />}
              iconOnly
              onClick={() => {
                setDraft(text);
                setEditing(true);
              }}
              ref={editButton}
              size="sm"
              variant="ghost"
            />
          </Tooltip>
        </div>
      )}
    </div>
  );
});

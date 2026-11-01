"use client";

import { ArrowUp, BookOpen, Plus, Square, Upload } from "lucide-react";
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from "react";

import { ICON_MENU_TRIGGER } from "./icon-menu-trigger";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import type { Collection } from "../api";
import { ATTACHMENT_ACCEPT, CHAT_LIMITS } from "../attachments";
import type { ComposerAttachment, ReferencedDocument } from "../hooks/useComposerAttachments";
import type { ConversationCollection } from "../types";
import { plural } from "../work";
import { AttachmentChip } from "./AttachmentChip";
import { KnowledgePicker } from "./KnowledgePicker";
import { ScopeChip } from "./ScopeChip";

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  placeholder: string;
  /** A turn is streaming in this chat: the send button becomes Stop. */
  streaming: boolean;
  /** No caller identity: nothing can be sent. */
  unavailable?: boolean;
  enterToSend: boolean;
  attachments: ComposerAttachment[];
  attachmentsBusy: boolean;
  onAddFiles: (files: File[]) => number;
  onAddReferences: (documents: ReferencedDocument[]) => number;
  onRemoveAttachment: (key: string) => void;
  scope: ConversationCollection[];
  onScopeChange: (scope: ConversationCollection[]) => void;
  collections: Collection[];
  collectionsLoading: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Product-tour anchors on the home composer. */
  tourAnchors?: boolean;
}

const MAX_TEXTAREA_HEIGHT = 200;

/**
 * The one composer for the chat home and threads: text, files (upload or
 * from knowledge), the knowledge scope and send/stop.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder,
  streaming,
  unavailable,
  enterToSend,
  attachments,
  attachmentsBusy,
  onAddFiles,
  onAddReferences,
  onRemoveAttachment,
  scope,
  onScopeChange,
  collections,
  collectionsLoading,
  textareaRef,
  tourAnchors,
}: ComposerProps) {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const length = value.trim().length;
  const overLimit = value.length > CHAT_LIMITS.messageCharacters;
  const canSend = length > 0 && !overLimit && !attachmentsBusy && !streaming && !unavailable;
  const room = CHAT_LIMITS.attachments - attachments.length;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [textareaRef, value]);

  const addFiles = (files: File[]) => {
    if (!files.length) return;
    const left = onAddFiles(files);
    if (left > 0) toast.show({ tone: "info", message: `You can add up to ${CHAT_LIMITS.attachments} files to one message` });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const send = enterToSend ? !event.shiftKey : event.metaKey || event.ctrlKey;
    if (!send) return;
    event.preventDefault();
    if (canSend) onSubmit();
  };

  return (
    <div>
      <div
        className={cn(
          "mx-auto max-w-(--chat-max) rounded-[18px] border border-border-default bg-surface-base pb-2.5 pl-4 pr-3 pt-3",
          "shadow-(--shadow-composer) transition-[border-color,box-shadow] duration-(--duration-fast)",
          "focus-within:border-border-strong focus-within:shadow-(--shadow-composer-focus)",
        )}
        data-tour={tourAnchors ? "composer" : undefined}
      >
        {attachments.length > 0 && (
          <ul aria-label="Files on this message" className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <li key={attachment.key}>
                <AttachmentChip
                  attachment={{ ...attachment, documentId: attachment.document?.id }}
                  onRemove={() => onRemoveAttachment(attachment.key)}
                />
              </li>
            ))}
          </ul>
        )}
        <textarea
          aria-label="Message"
          className="block max-h-[200px] min-h-6 w-full resize-none border-0 bg-transparent py-0.5 text-[0.9375rem] leading-normal text-text-primary outline-none placeholder:text-text-tertiary"
          data-autofocus
          disabled={unavailable}
          id="chat-input"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={unavailable ? "Sign in to ask a question" : placeholder}
          ref={textareaRef}
          rows={1}
          value={value}
        />
        <div className="mt-2 flex items-center gap-1.5">
          <Menu
            ariaLabel="Add files"
            disabled={unavailable}
            label={<Plus aria-hidden="true" />}
            showChevron={false}
            tooltip="Add files"
            triggerClassName={ICON_MENU_TRIGGER}
          >
            <MenuLabel>Add to this message</MenuLabel>
            <MenuItem icon={<Upload />} onSelect={() => fileInput.current?.click()} shortcut="Private to you">
              Upload from computer…
            </MenuItem>
            <MenuItem icon={<BookOpen />} onSelect={() => setPickerOpen(true)} shortcut="Not copied">
              Add from knowledge…
            </MenuItem>
          </Menu>
          <ScopeChip collections={collections} loading={collectionsLoading} onChange={onScopeChange} scope={scope} />
          <span className="flex-1" />
          {overLimit ? (
            <span className="mr-1.5 font-mono text-caption text-status-danger" role="alert">
              {value.length.toLocaleString()} / {CHAT_LIMITS.messageCharacters.toLocaleString()}
            </span>
          ) : value.length > CHAT_LIMITS.messageCharacters * 0.9 ? (
            <span className="mr-1.5 font-mono text-caption text-text-tertiary">
              {value.length.toLocaleString()} / {CHAT_LIMITS.messageCharacters.toLocaleString()}
            </span>
          ) : attachments.length > 0 ? (
            <span className="mr-1.5 text-caption text-text-tertiary">
              {attachments.length}/{CHAT_LIMITS.attachments} files
            </span>
          ) : null}
          {streaming ? (
            <Tooltip label="Stop answering">
              <button
                aria-label="Stop answering"
                className="grid size-[34px] place-items-center rounded-[10px] bg-surface-inverse text-text-inverse transition-colors hover:bg-surface-inverse-hover focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
                onClick={onStop}
                type="button"
              >
                <Square aria-hidden="true" className="fill-current" size={14} />
              </button>
            </Tooltip>
          ) : (
            <button
              aria-label="Send"
              className="grid size-[34px] place-items-center rounded-[10px] bg-accent-primary text-text-on-accent transition-[background-color,opacity] hover:bg-accent-hover focus-visible:shadow-(--shadow-focus) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-35"
              disabled={!canSend}
              onClick={onSubmit}
              title={attachmentsBusy ? "Wait for the files to finish uploading" : undefined}
              type="button"
            >
              <ArrowUp aria-hidden="true" size={17} />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-caption text-text-tertiary">
        Answers cite your company knowledge. Check important details.
      </p>
      <input
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
        ref={fileInput}
        tabIndex={-1}
        type="file"
      />
      <KnowledgePicker
        collections={collections}
        onAdd={(documents) => {
          const left = onAddReferences(documents);
          if (left > 0) toast.show({ tone: "info", message: `Added ${plural(documents.length - left, "document")}. One message holds up to ${CHAT_LIMITS.attachments} files.` });
          window.requestAnimationFrame(() => textareaRef.current?.focus());
        }}
        onClose={() => setPickerOpen(false)}
        open={pickerOpen}
        room={room}
      />
    </div>
  );
}

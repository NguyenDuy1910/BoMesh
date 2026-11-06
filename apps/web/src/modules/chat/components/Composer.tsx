"use client";

import { Button, TextArea, Tooltip } from "@heroui/react";
import clsx from "clsx";
import { ArrowUp, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";

import { AttachMenu, AttachmentChip, type ComposerAttachments } from "@/modules/artifacts";

import type { ConversationScope } from "../api";
import { ScopePicker } from "./ScopePicker";

/** Drafts per place ("home", "proj:<id>", a conversation id): they never leak between threads and survive navigation. */
const drafts = new Map<string, string>();

export function useDraft(key: string): [string, (value: string) => void] {
  const [draft, setDraftState] = useState(() => drafts.get(key) ?? "");
  useEffect(() => setDraftState(drafts.get(key) ?? ""), [key]);
  const setDraft = useCallback(
    (value: string) => {
      drafts.set(key, value);
      setDraftState(value);
    },
    [key],
  );
  return [draft, setDraft];
}

export interface ComposerProps {
  draft: string;
  onDraftChange: (value: string) => void;
  attachments: ComposerAttachments;
  scope: ConversationScope;
  onScopeChange: (scope: ConversationScope) => void;
  placeholder: string;
  onSend: () => void;
  /** An answer is streaming in this place: the send button becomes Stop. */
  streaming?: boolean;
  onStop?: () => void;
  /** The home composer (bigger). */
  lg?: boolean;
  autoFocus?: boolean;
}

/**
 * The message composer (preview `composerHtml`): attachments row, the
 * question, then Attach · Search in · count · Send/Stop. Enter sends,
 * Shift+Enter breaks the line; it grows up to 220 px.
 */
export function Composer({ draft, onDraftChange, attachments, scope, onScopeChange, placeholder, onSend, streaming, onStop, lg, autoFocus = true }: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const canSend = !!draft.trim() && attachments.ready;

  const grow = () => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };
  useEffect(grow, [draft]);
  useEffect(() => {
    if (!autoFocus) return;
    const el = input.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSend && !streaming) onSend();
  };

  return (
    <div className={clsx("chat-composer", lg && "chat-composer--lg")} id="chat-composer">
      <div className="chat-composer__files" id="chat-files" hidden={!attachments.files.length}>
        {attachments.files.map((file, i) => (
          <AttachmentChip key={`${file.name}-${i}`} file={file} onRemove={() => attachments.remove(i)} />
        ))}
      </div>
      <TextArea
        ref={input}
        className="chat-composer__input"
        id="chat-input"
        rows={lg ? 2 : 1}
        placeholder={placeholder}
        aria-label="Message"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="chat-composer__bar">
        <AttachMenu composer={attachments} />
        <ScopePicker scope={scope} onChange={onScopeChange} />
        <span className="grow" />
        {attachments.files.length ? <span className="t-xs muted num chat-composer__count">{attachments.files.length}/5</span> : null}
        {streaming ? (
          <Tooltip>
            <Button isIconOnly variant="tertiary" aria-label="Stop answering" className="chat-composer__send" onPress={onStop}>
              <Square className="i" aria-hidden />
            </Button>
            <Tooltip.Content>Stop answering</Tooltip.Content>
          </Tooltip>
        ) : (
          <Tooltip>
            <Button isIconOnly variant="primary" aria-label="Send" id="chat-send" className="chat-composer__send" isDisabled={!canSend} onPress={onSend}>
              <ArrowUp className="i" aria-hidden />
            </Button>
            <Tooltip.Content>Send</Tooltip.Content>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

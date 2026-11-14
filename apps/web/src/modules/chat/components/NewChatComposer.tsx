"use client";

import { useState } from "react";

import { useWorkspace } from "@/lib/workspace";
import { AttachmentChip, chipFileFromItem, useComposerFiles } from "@/modules/artifacts";
import { useProjectReferences } from "@/modules/projects";

import type { ConversationScope } from "../api";
import { sentFiles } from "../runtime";
import { useStartConversation } from "../useStartConversation";
import { Composer, useDraft } from "./Composer";

/** Project documents taken off the next chat, per project (preview composer `off`); cleared once it is sent. */
const removed = new Map<string, readonly string[]>();

export interface NewChatComposerProps {
  placeholder?: string;
  /** Project id: the new chat is filed there and its documents are attached. */
  project?: string;
  lg?: boolean;
}

/**
 * A composer that starts a new conversation on send (the project page's "New chat in …"). The project's documents the
 * caller can open show as chips, removable for this chat only (preview `composerFiles` with `X.projects.refs`).
 */
export function NewChatComposer({ placeholder, project, lg }: NewChatComposerProps) {
  const { member } = useWorkspace();
  const key = project ? `proj:${project}` : "home";
  const files = useComposerFiles(key);
  const [draft, setDraft] = useDraft(key);
  const [scope, setScope] = useState<ConversationScope>({});
  const [off, setOffState] = useState<readonly string[]>(() => removed.get(key) ?? []);
  const setOff = (next: readonly string[]) => {
    removed.set(key, next);
    setOffState(next);
  };
  const refs = useProjectReferences(project);
  const own = new Set(files.attachments);
  const attached = refs.items.filter((i) => i.name && !own.has(i.name) && !off.includes(i.name));
  const { start, pending } = useStartConversation();

  const send = async () => {
    const question = draft.trim();
    if (!question || !files.ready || pending) return;
    const ok = await start({
      question,
      scope,
      attachments: [...attached.map((i) => i.name!), ...files.attachments],
      files: [...attached.map((i) => chipFileFromItem(i, member.personalCollection)), ...sentFiles(files.files)],
      project,
    });
    if (!ok) return;
    setDraft("");
    setOff([]);
    files.clear();
  };

  const chips = attached.length
    ? attached.map((item) => <AttachmentChip key={item.name} file={chipFileFromItem(item, member.personalCollection)} onRemove={() => setOff([...off, item.name!])} />)
    : null;

  return (
    <Composer
      lg={lg}
      draft={draft}
      onDraftChange={setDraft}
      attachments={files}
      scope={scope}
      onScopeChange={setScope}
      placeholder={placeholder}
      onSend={() => void send()}
      autoFocus={false}
      chips={chips}
    />
  );
}

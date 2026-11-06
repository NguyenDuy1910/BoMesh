"use client";

import { useState } from "react";

import { useWorkspace } from "@/lib/workspace";
import { chipFileFromItem, useComposerFiles } from "@/modules/artifacts";
import { useProjectReferences } from "@/modules/projects";

import type { ConversationScope } from "../api";
import { sentFiles } from "../runtime";
import { useStartConversation } from "../useStartConversation";
import { Composer, useDraft } from "./Composer";

export interface NewChatComposerProps {
  placeholder?: string;
  /** Project id: the new chat is filed there and its knowledge references are attached. */
  project?: string;
  lg?: boolean;
}

/**
 * A composer that starts a new conversation on send (the project page's
 * "New chat in …"). Project references the caller can open are attached to
 * the first question, never shown in the composer (preview `X.projects.refs`).
 */
export function NewChatComposer({ placeholder = "Ask anything", project, lg }: NewChatComposerProps) {
  const { member } = useWorkspace();
  const key = project ? `proj:${project}` : "home";
  const files = useComposerFiles(key);
  const [draft, setDraft] = useDraft(key);
  const [scope, setScope] = useState<ConversationScope>({});
  const refs = useProjectReferences(project);
  const { start, pending } = useStartConversation();

  const send = async () => {
    const question = draft.trim();
    if (!question || !files.ready || pending) return;
    const own = new Set(files.attachments);
    const extra = refs.items.filter((i) => i.name && !own.has(i.name));
    const ok = await start({
      question,
      scope,
      attachments: [...extra.map((i) => i.name!), ...files.attachments],
      files: [...extra.map((i) => chipFileFromItem(i, member.personalCollection)), ...sentFiles(files.files)],
      project,
    });
    if (!ok) return;
    setDraft("");
    files.clear();
  };

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
    />
  );
}

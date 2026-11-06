"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { errorMessage, resourceId } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";
import { toast } from "@/components/ui/Toast";
import { attachConversationToProject } from "@/modules/projects";

import { chatKeys, createConversation, type ConversationScope } from "./api";
import { makeTitle } from "./citations";
import { sendTurn, stopTurn, streamingConversation, type SentFile } from "./runtime";

export interface StartConversation {
  question: string;
  scope?: ConversationScope;
  /** DOCUMENT item names attached to the first question. */
  attachments?: string[];
  files?: SentFile[];
  /** Project id the new conversation is filed in. */
  project?: string | null;
  /** Stop an answer still streaming elsewhere instead of refusing (URL entry, preview `chat-ask`). */
  replaceRunning?: boolean;
}

/**
 * Start a conversation (preview `start()`): CreateConversation with the scope and
 * a title from the question, file it in a project, open the thread and stream
 * the first answer. Resolves false when nothing was started.
 */
export function useStartConversation() {
  const { id: workspace } = useWorkspace();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const start = useCallback(
    async ({ question, scope = {}, attachments = [], files = [], project, replaceRunning }: StartConversation): Promise<boolean> => {
      const running = streamingConversation();
      if (running) {
        if (!replaceRunning) {
          toast("Another answer is still being written. Wait for it or stop it.", { tone: "accent" });
          return false;
        }
        stopTurn(running);
      }
      setPending(true);
      try {
        const clean: ConversationScope = {
          ...(scope.collections?.length ? { collections: scope.collections } : {}),
          ...(scope.spaces?.length ? { spaces: scope.spaces } : {}),
        };
        const conversation = await createConversation(workspace, { displayName: makeTitle(question), scope: clean });
        const id = resourceId(conversation.name);
        queryClient.setQueryData(chatKeys.conversation(workspace, id), conversation);
        queryClient.setQueryData(chatKeys.messages(workspace, id), []);
        if (project) await attachConversationToProject(workspace, conversation.name ?? id, project).catch(() => undefined);
        void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(workspace) });
        sendTurn(queryClient, { workspace, conversation: id, message: question, attachments, files });
        router.push(`/chat/${id}`);
        return true;
      } catch (error) {
        toast(errorMessage(error), { tone: "danger" });
        return false;
      } finally {
        setPending(false);
      }
    },
    [workspace, queryClient, router],
  );

  return { start, pending };
}

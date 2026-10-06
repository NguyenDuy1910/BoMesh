"use client";

import { useCallback, useEffect, useState } from "react";

import { subscribeApiData } from "@/lib/api/revision";
import { bindConversationUser, deleteConversation, renameConversation } from "../chat-runtime";
import { conversationAdapter, subscribeToConversations } from "../conversations";
import type { ConversationCollection } from "../types";

/** One chat as lists show it. `updated_at` is epoch milliseconds. */
export interface ConversationListItem {
  id: string;
  title: string;
  updated_at: number;
  preview: string;
  scope: ConversationCollection[];
}

interface ConversationListState {
  conversations: ConversationListItem[];
  loading: boolean;
  error: string | null;
}

/**
 * The signed-in account's chats in the active workspace, newest first. Chats
 * are kept on this device; the list follows writes from any surface or tab
 * and re-reads when the session or workspace changes.
 */
export function useConversationList() {
  const [state, setState] = useState<ConversationListState>({
    conversations: [],
    loading: true,
    error: null,
  });

  const reload = useCallback(async () => {
    try {
      bindConversationUser();
      const list = await conversationAdapter.listConversations();
      setState({
        conversations: list.map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          updated_at: conversation.updatedAt,
          preview: conversation.preview ?? "",
          scope: conversation.scope ?? [],
        })),
        loading: false,
        error: null,
      });
    } catch {
      setState((current) => ({ ...current, loading: false, error: "Your chats couldn’t be read from this browser." }));
    }
  }, []);

  useEffect(() => {
    void reload();
    const stopStore = subscribeToConversations(() => void reload());
    const stopSession = subscribeApiData(() => void reload());
    return () => {
      stopStore();
      stopSession();
    };
  }, [reload]);

  return {
    ...state,
    reload,
    rename: renameConversation,
    remove: deleteConversation,
  };
}

"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";

import { chatKeys, getAssistant, getConversation, getShare, listMessages, listShares } from "./api";

/** The published assistant: welcome message and starters (readable by every member). */
export function useAssistant() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: chatKeys.assistant(id), queryFn: () => getAssistant(id), staleTime: 5 * 60_000 });
}

export function useConversation(conversation: string | undefined) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: chatKeys.conversation(id, conversation ?? ""),
    queryFn: () => getConversation(id, conversation!),
    enabled: !!conversation,
    retry: false,
  });
}

export function useMessages(conversation: string | undefined) {
  const { id } = useWorkspace();
  return useQuery({
    queryKey: chatKeys.messages(id, conversation ?? ""),
    queryFn: () => listMessages(id, conversation!),
    enabled: !!conversation,
    retry: false,
    // Refetched only when a turn settles: a refetch mid-stream would show the stored question twice.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useShares(conversation: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: chatKeys.shares(id, conversation), queryFn: () => listShares(id, conversation), enabled });
}

export function useShare(conversation: string, share: string) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: chatKeys.share(id, conversation, share), queryFn: () => getShare(id, conversation, share), retry: false });
}

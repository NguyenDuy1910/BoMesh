"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";
import { listMembers } from "@/modules/search/api";

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

/** Everyone in the workspace (share people picker, "Shared with …"). */
export function useMembers({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "members", "all"], queryFn: () => listMembers(id), enabled, staleTime: 60_000 });
}

/** "Shared with Lan and Minh" / "Anyone in {workspace} can open it" (preview `shareSummary`); empty when not shared. */
export function useShareSummary(conversation: string, { enabled = true }: { enabled?: boolean } = {}): string {
  const { workspace } = useWorkspace();
  const shares = useShares(conversation, { enabled });
  const share = shares.data?.[0];
  const members = useMembers({ enabled: share?.audience === "PEOPLE" });
  if (!share) return "";
  if (share.audience !== "PEOPLE") return `Anyone in ${workspace.displayName ?? "the workspace"} can open it`;
  const names = (share.recipients ?? []).map((r) => members.data?.find((m) => m.name === r)?.displayName || "Someone");
  return `Shared with ${names.length <= 2 ? names.join(" and ") : `${names[0]}, ${names[1]} and ${names.length - 2} more`}`;
}

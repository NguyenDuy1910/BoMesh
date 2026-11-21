"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";
import { listMembers } from "@/modules/search/api";

import { memberName } from "@/modules/shares/api";
import { useLiveShares } from "@/modules/shares/queries";

import { chatKeys, getAssistant, getConversation, listMessages } from "./api";

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

/** Everyone in the workspace (share people picker, "Shared with …"). */
export function useMembers({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "members", "all"], queryFn: () => listMembers(id), enabled, staleTime: 60_000 });
}

/** Your live share of a conversation (one at most; Share / Update sharing replaces it). */
export function useMyConversationShare(conversation: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id, memberId } = useWorkspace();
  const shares = useLiveShares(`workspaces/${id}/conversations/${conversation}`, "SHARE", { enabled });
  const me = memberName(id, memberId);
  return { share: shares.data?.find((s) => s.creator === me) ?? null, isPending: enabled && shares.isPending };
}

/** "Shared with Lan and Minh" / "Anyone in {workspace} can open it" (preview `shareSummary`); empty when not shared. */
export function useShareSummary(conversation: string, { enabled = true }: { enabled?: boolean } = {}): string {
  const share = useMyConversationShare(conversation, { enabled }).share;
  const members = useMembers({ enabled: share?.audience === "PEOPLE" });
  const { workspace } = useWorkspace();
  if (!share) return "";
  if (share.audience !== "PEOPLE") return `Anyone in ${workspace.displayName ?? "the workspace"} can open it`;
  const names = (share.recipients ?? []).map((r) => members.data?.find((m) => m.name === r)?.displayName || "Someone");
  return `Shared with ${names.length <= 2 ? names.join(" and ") : `${names[0]}, ${names[1]} and ${names.length - 2} more`}`;
}

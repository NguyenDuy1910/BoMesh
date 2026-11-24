"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";
import { useMemberNames } from "@/modules/knowledge/queries";

import { memberName } from "@/modules/shares/api";
import { useLiveShares } from "@/modules/shares/queries";

import { chatKeys, getAssistant, getConversation, listMemberCandidates, listMessages } from "./api";

/** The published assistant: welcome message and starters (readable by every member). Publishing writes it into the cache. */
export function useAssistant() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: chatKeys.assistant(id), queryFn: () => getAssistant(id), staleTime: 10 * 60_000 });
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

/** Active members matching the share people picker's search (one small ListMembers page; none until something is typed). */
export function useMemberCandidates(q: string, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "members", "shareCandidates", q], queryFn: () => listMemberCandidates(id, q), enabled: enabled && !!q, staleTime: 60_000 });
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
  const names = useMemberNames(share?.audience === "PEOPLE" ? (share.recipients ?? []) : []);
  const { workspace } = useWorkspace();
  if (!share) return "";
  if (share.audience !== "PEOPLE") return `Mọi thành viên trong ${workspace.displayName ?? "không gian làm việc"} đều mở được`;
  const shown = (share.recipients ?? []).map((r) => names.get(r) || "Ai đó");
  return `Đã chia sẻ với ${shown.length <= 2 ? shown.join(" và ") : `${shown[0]}, ${shown[1]} và ${shown.length - 2} người khác`}`;
}

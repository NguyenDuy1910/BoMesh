"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";

import { listMembers, listRecentConversationPage, listRoles, SEARCHED_CONVERSATIONS } from "./api";

/**
 * The caller's most recent conversations Search matches against: one read per workspace, not per query, so every search
 * (and any other consumer of this key) reuses it. Under `[ws, "conversations"]`, so creating or changing one refreshes it.
 */
export function useSearchedConversations() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "conversations", "searched", SEARCHED_CONVERSATIONS], queryFn: () => listRecentConversationPage(id), staleTime: 30_000 });
}

/** Members and role names, for people managers only. */
export function usePeople({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const members = useQuery({ queryKey: [id, "members", "all"], queryFn: () => listMembers(id), enabled, staleTime: 60_000 });
  const roles = useQuery({ queryKey: [id, "roles", "all"], queryFn: () => listRoles(id), enabled, staleTime: 5 * 60_000 });
  return { members, roles };
}

"use client";

import { useQuery } from "@tanstack/react-query";

import { useTokenPages } from "@/lib/paging";
import { useWorkspace } from "@/lib/workspace";
import { listMemberPage } from "@/modules/people/api";
import { memberSearch } from "@/modules/people/model";

import { listRecentConversationPage, listRoles, SEARCHED_CONVERSATIONS } from "./api";

/**
 * The caller's most recent conversations Search matches against: one read per workspace, not per query, so every search
 * (and any other consumer of this key) reuses it. Under `[ws, "conversations"]`, so creating or changing one refreshes it.
 */
export function useSearchedConversations() {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "conversations", "searched", SEARCHED_CONVERSATIONS], queryFn: () => listRecentConversationPage(id), staleTime: 30_000 });
}

/** Members whose name or email contains `q` (one server page of `pageSize`) and role names, for people managers only. */
export function usePeople(q: string, pageSize: number, { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const filter = memberSearch(q);
  const members = useTokenPages([id, "members", "search", filter, pageSize], (pageToken) => listMemberPage(id, { filter, orderBy: "displayName", pageSize, pageToken }), { enabled });
  const roles = useQuery({ queryKey: [id, "roles", "all"], queryFn: () => listRoles(id), enabled, staleTime: 5 * 60_000 });
  return { members, roles };
}

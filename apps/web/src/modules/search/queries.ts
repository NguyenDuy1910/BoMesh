"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";

import { listMembers, listMyConversations, listRoles } from "./api";

/** The caller's conversations (Search results, Home's "You asked" / "Continue a conversation"). */
export function useMyConversations({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: [id, "conversations", "mine", "all"], queryFn: () => listMyConversations(id), enabled, staleTime: 30_000 });
}

/** Members and role names, for people managers only. */
export function usePeople({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const members = useQuery({ queryKey: [id, "members", "all"], queryFn: () => listMembers(id), enabled, staleTime: 60_000 });
  const roles = useQuery({ queryKey: [id, "roles", "all"], queryFn: () => listRoles(id), enabled, staleTime: 5 * 60_000 });
  return { members, roles };
}

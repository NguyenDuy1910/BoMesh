"use client";

import { useQuery } from "@tanstack/react-query";

import { useWorkspace } from "@/lib/workspace";

import { getMemberHome, homeKeys } from "./api";

/** The member's Home read model; shared by Home, New chat (starters) and popularity ranks. */
export function useMemberHome({ enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  return useQuery({ queryKey: homeKeys.home(id), queryFn: () => getMemberHome(id), enabled, staleTime: 60_000 });
}

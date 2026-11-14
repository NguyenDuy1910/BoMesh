"use client";

import { Globe, Lock, Users, type LucideIcon } from "lucide-react";

import { useWorkspace } from "@/lib/workspace";
import { useSpaces } from "@/modules/spaces/queries";

import type { ReadingList } from "../api";

/** Who a reading list is shared with (preview `shareLabel`). */
export function useShareLabel() {
  const { workspace } = useWorkspace();
  const spaces = useSpaces();
  return (list: Pick<ReadingList, "audience" | "space">): { icon: LucideIcon; label: string } => {
    if (list.audience === "WORKSPACE") return { icon: Globe, label: `Everyone in ${workspace.displayName}` };
    if (list.audience === "SPACE") return { icon: Users, label: spaces.data?.find((s) => s.name === list.space)?.displayName ?? "A space" };
    return { icon: Lock, label: "Only you" };
  };
}

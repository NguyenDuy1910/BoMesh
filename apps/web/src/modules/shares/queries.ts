"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { listShares, memberName, shareFilter, shareKeys, workspaceShareOf, type Share } from "./api";
import { shareUrl } from "./model";

/** Live shares of one target, of one kind (the invite links dialog, a conversation's Share dialog). */
export function useLiveShares(target: string, kind: Share["kind"], { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const filter = shareFilter({ target, kind, state: "ACTIVE" });
  return useQuery({ queryKey: shareKeys.list(id, filter), queryFn: () => listShares(id, filter), enabled });
}

/**
 * Copy link on a document, collection or space (preview `X.shares.copyShare`): a share of the target to the workspace,
 * made once and copied again after (`origin + uri`, never the API name). It grants nothing.
 */
export function useCopyShareLink() {
  const { id, memberId } = useWorkspace();
  return useCallback(
    async (target: string) => {
      try {
        const share = await workspaceShareOf(id, target, memberName(id, memberId));
        const url = shareUrl(window.location.origin, share.uri);
        if (!url) throw new Error("The share has no link.");
        await navigator.clipboard.writeText(url);
        toast("Link copied. Only people who can already open it will see it.");
      } catch (error) {
        toast(error instanceof DOMException ? "Couldn’t copy the link" : errorMessage(error), { tone: "danger" });
      }
    },
    [id, memberId],
  );
}

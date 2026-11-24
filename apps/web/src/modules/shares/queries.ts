"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { listSharePage, memberName, shareFilter, shareKeys, workspaceShareOf, type Share } from "./api";
import { shareUrl } from "./model";

/** How many live shares of one target a dialog lists (invite links an admin made; a conversation's share). */
const LIVE_SHARES = 50;

/** Live shares of one target, of one kind (the invite links dialog, a conversation's Share dialog): one page, newest first. */
export function useLiveShares(target: string, kind: Share["kind"], { enabled = true }: { enabled?: boolean } = {}) {
  const { id } = useWorkspace();
  const filter = shareFilter({ target, kind, state: "ACTIVE" });
  return useQuery({ queryKey: shareKeys.list(id, filter), queryFn: () => listSharePage(id, filter, LIVE_SHARES), enabled });
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
        if (!url) throw new Error("Liên kết chia sẻ không có địa chỉ.");
        await navigator.clipboard.writeText(url);
        toast("Đã sao chép liên kết. Chỉ người đã có quyền mới mở được.");
      } catch (error) {
        toast(error instanceof DOMException ? "Không sao chép được liên kết" : errorMessage(error), { tone: "danger" });
      }
    },
    [id, memberId],
  );
}

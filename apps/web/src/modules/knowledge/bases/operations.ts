"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { confirm } from "@/components/ui/Confirm";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { deleteItem, undeleteItem } from "../api";
import { invalidateKnowledge } from "../queries";
import type { Item } from "./model";

/** Base-level operations (preview `A['kb-archive']`). */
export function useBaseOperations() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();

  return useMemo(() => {
    const refresh = () => invalidateKnowledge(qc, ws);
    const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

    async function restore(base: Item) {
      try {
        await undeleteItem(ws, base.name ?? "");
        refresh();
        toast(`Restored “${base.displayName ?? ""}”`);
      } catch (error) {
        fail(error);
      }
    }

    return {
      /** Typed confirmation, soft delete with its documents (30-day restore), back to the list, Undo. */
      async archive(base: Item): Promise<boolean> {
        const n = base.collection?.documentCount ?? 0;
        const name = base.displayName ?? "";
        const ok = await confirm({
          title: `Archive ${name}?`,
          description: n ? `Its ${plural(n, "document")} will stop appearing in answers for everyone.` : "It will disappear for everyone.",
          confirmLabel: "Archive",
          tone: "danger",
          typed: name,
        });
        if (!ok) return false;
        try {
          await deleteItem(ws, base.name ?? "", { force: true });
          refresh();
          router.push("/knowledge/bases");
          toast(`Archived “${name}”`, { undo: () => void restore(base) });
          return true;
        } catch (error) {
          fail(error);
          return false;
        }
      },
    };
  }, [qc, ws, router]);
}

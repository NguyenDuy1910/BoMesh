"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { deleteItem, undeleteItem } from "../api";
import { invalidateKnowledge } from "../queries";
import { collectionHref, COLLECTIONS_HREF, type Item } from "./model";

/** Collection-level operations (preview `A['kb-archive']`). */
export function useCollectionOperations() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();
  const router = useRouter();

  return useMemo(() => {
    const refresh = () => invalidateKnowledge(qc, ws);
    const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

    return {
      /** Archiving is reversible: it happens at once (soft delete with its documents), back to Collections, with Undo. */
      async archive(collection: Item): Promise<void> {
        const name = collection.displayName ?? "";
        try {
          await deleteItem(ws, collection.name ?? "", { force: true });
          refresh();
          router.push(COLLECTIONS_HREF);
          toast(`Archived “${name}”`, {
            undo: () => {
              undeleteItem(ws, collection.name ?? "").then(() => {
                refresh();
                router.push(collectionHref(collection.name, "settings"));
              }, fail);
            },
          });
        } catch (error) {
          fail(error);
        }
      },
    };
  }, [qc, ws, router]);
}

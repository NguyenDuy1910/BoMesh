"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";

import { confirm } from "@/components/ui/Confirm";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { useWorkspace } from "@/lib/workspace";

import { createContribution, deleteContribution, resubmitContribution, uploadDocument, withdrawContribution } from "../api";
import { invalidateKnowledge, knowledgeKeys } from "../queries";
import { UNDO_WINDOW_MS } from "./components/parts";
import type { ContributionView } from "./useContributionViews";

/* Removing a declined contribution is permanent in the API, so it is hidden first and deleted once the Undo window closes. */
let removing: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const setRemoving = (next: ReadonlySet<string>) => {
  removing = next;
  listeners.forEach((l) => l());
};

/** Contribution names being removed (hidden until the delete runs or is undone). */
export function useRemovingContributions(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => removing,
    () => removing,
  );
}

/** Withdraw (confirm, Undo re-submits), remove (Undo), resubmit (optional new file) — preview `ctb-withdraw` / `ctb-resubmit`. */
export function useContributionActions() {
  const { id: ws, member } = useWorkspace();
  const qc = useQueryClient();

  return useMemo(() => {
    const refresh = () => {
      invalidateKnowledge(qc, ws);
      void qc.invalidateQueries({ queryKey: knowledgeKeys.contributions(ws) });
    };
    const fail = (e: unknown) => toast(errorMessage(e), { tone: "danger" });

    /** Puts a withdrawn contribution back up for review (same document, same base and note), then drops the withdrawn record. */
    async function submitAgain(v: ContributionView) {
      const c = v.contribution;
      try {
        await createContribution(ws, {
          kind: c.kind,
          item: c.item,
          targetCollection: c.kind === "NEW_REVISION" ? undefined : c.targetCollection || undefined,
          replacesItem: c.replacesItem,
          note: c.note,
          changeSummary: c.changeSummary,
        });
        await deleteContribution(ws, c.name ?? "").catch(() => undefined);
        refresh();
      } catch (e) {
        fail(e);
      }
    }

    return {
      /** Confirm, withdraw; Undo submits it again. Resolves true when withdrawn. */
      async withdraw(v: ContributionView): Promise<boolean> {
        const ok = await confirm({
          title: "Withdraw this submission?",
          description: `Reviewers won’t see “${v.title}” anymore. You can contribute it again later.`,
          confirmLabel: "Withdraw",
          tone: "danger",
        });
        if (!ok) return false;
        try {
          await withdrawContribution(ws, v.contribution.name ?? "", v.contribution.etag);
          refresh();
          toast(`Withdrew “${v.title}”`, { undo: () => void submitAgain(v) });
          return true;
        } catch (e) {
          refresh();
          fail(e);
          return false;
        }
      },

      /** Removes a declined (or withdrawn) contribution after the Undo window. */
      remove(v: ContributionView) {
        const name = v.contribution.name ?? "";
        setRemoving(new Set(removing).add(name));
        const timer = setTimeout(() => {
          void deleteContribution(ws, name)
            .then(refresh, fail)
            .finally(() => {
              const next = new Set(removing);
              next.delete(name);
              setRemoving(next);
            });
        }, UNDO_WINDOW_MS);
        toast(`Removed “${v.title}”`, {
          undo: () => {
            clearTimeout(timer);
            const next = new Set(removing);
            next.delete(name);
            setRemoving(next);
          },
        });
      },

      /** Resubmits with what changed and an optional replacement file (uploaded to My files first). */
      async resubmit(v: ContributionView, { changeSummary, file }: { changeSummary: string; file?: File | null }): Promise<boolean> {
        try {
          let item: string | undefined;
          if (file) {
            if (!member.personalCollection) throw new Error("You don’t have a My files folder to upload the new file to.");
            item = (await uploadDocument(ws, { parentItem: member.personalCollection, file })).name;
          }
          await resubmitContribution(ws, v.contribution.name ?? "", { item, changeSummary, etag: v.contribution.etag });
          refresh();
          toast("Resubmitted for review");
          return true;
        } catch (e) {
          refresh();
          fail(e);
          return false;
        }
      },
    };
  }, [qc, ws, member.personalCollection]);
}

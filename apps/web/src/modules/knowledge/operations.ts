"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { confirm } from "@/components/ui/Confirm";
import { toast } from "@/components/ui/Toast";
import { errorMessage } from "@/lib/api/client";
import { fmtDate, plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import {
  createSavedItem,
  deleteItem,
  deleteReadingListEntry,
  deleteSavedItem,
  downloadItem,
  featureItem,
  FEATURED_LIST,
  moveItem,
  publishItem,
  undeleteItem,
  unpublishItem,
  verifyItem,
} from "./api";
import { invalidateKnowledge, knowledgeKeys } from "./queries";

/** What an operation needs to know about a document. `Resource` satisfies it. */
export interface DocRef {
  /** Full item name. */
  name: string;
  /** Title shown in toasts. */
  title: string;
  fileName?: string;
  /** Concurrency token (optional). */
  etag?: string;
}

const refOf = (r: DocRef | { name: string; title: string; fileName?: string; item?: { etag?: string } }): DocRef => ({
  name: r.name,
  title: r.title,
  fileName: r.fileName,
  etag: "item" in r ? r.item?.etag : "etag" in r ? r.etag : undefined,
});

/**
 * Shared document operations (preview `features/documents.js` + resource actions):
 * every one updates data, refreshes the knowledge caches, then toasts (Undo where
 * the API can reverse it). Callers decide visibility with item permissions.
 */
export function useDocumentOperations() {
  const { id: ws } = useWorkspace();
  const qc = useQueryClient();

  return useMemo(() => {
    const refresh = () => invalidateKnowledge(qc, ws);
    const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

    async function setSaved(doc: DocRef, saved: boolean, { quiet = false } = {}) {
      try {
        if (saved) await createSavedItem(ws, doc.name);
        else await deleteSavedItem(ws, doc.name);
        void qc.invalidateQueries({ queryKey: knowledgeKeys.saved(ws) });
        if (!quiet) {
          toast(saved ? `Saved “${doc.title}”` : `Removed “${doc.title}” from saved`, { undo: () => void setSaved(doc, !saved, { quiet: true }) });
        }
      } catch (error) {
        fail(error);
      }
    }

    async function setFeatured(doc: DocRef, featured: boolean, { quiet = false } = {}) {
      try {
        if (featured) await featureItem(ws, doc.name);
        else await deleteReadingListEntry(ws, FEATURED_LIST, doc.name);
        void qc.invalidateQueries({ queryKey: knowledgeKeys.readingLists(ws) });
        if (!quiet) {
          toast(featured ? "Featured on Home for everyone who can read it" : "Removed from Home", { undo: () => void setFeatured(doc, !featured, { quiet: true }) });
        }
      } catch (error) {
        fail(error);
      }
    }

    async function restore(docs: DocRef[]) {
      try {
        await Promise.all(docs.map((d) => undeleteItem(ws, d.name)));
        refresh();
        toast(docs.length === 1 ? `Restored “${docs[0].title}”` : `Restored ${plural(docs.length, "document")}`);
      } catch (error) {
        fail(error);
      }
    }

    return {
      setSaved,
      setFeatured,
      restore,

      /** Confirm, soft-delete (30-day restore), toast with Undo. Resolves true when archived. */
      async archive(input: DocRef[] | DocRef): Promise<boolean> {
        const docs = (Array.isArray(input) ? input : [input]).map(refOf);
        if (!docs.length) return false;
        const one = docs.length === 1;
        const ok = await confirm({
          title: one ? `Archive “${docs[0].title}”?` : `Archive ${plural(docs.length, "document")}?`,
          description: `${one ? "It" : "They"} will stop appearing in answers and search. You can undo this.`,
          confirmLabel: "Archive",
          tone: "danger",
        });
        if (!ok) return false;
        try {
          await Promise.all(docs.map((d) => deleteItem(ws, d.name)));
          refresh();
          toast(one ? `Archived “${docs[0].title}”` : `Archived ${plural(docs.length, "document")}`, { undo: () => void restore(docs) });
          return true;
        } catch (error) {
          refresh();
          fail(error);
          return false;
        }
      },

      async publish(doc: DocRef) {
        try {
          await publishItem(ws, doc.name);
          refresh();
          toast(`Published “${doc.title}”`, { undo: () => void unpublishItem(ws, doc.name).then(refresh, fail) });
        } catch (error) {
          fail(error);
        }
      },

      async unpublish(doc: DocRef) {
        try {
          await unpublishItem(ws, doc.name);
          refresh();
          toast(`Unpublished “${doc.title}”`, { undo: () => void publishItem(ws, doc.name).then(refresh, fail) });
        } catch (error) {
          fail(error);
        }
      },

      /** Mark as verified / renew verification (no API to revert, so no Undo). */
      async verify(doc: DocRef) {
        try {
          const item = await verifyItem(ws, doc.name);
          refresh();
          const due = item.document?.verification?.nextReviewTime;
          toast(due ? `Verified “${doc.title}” until ${fmtDate(due)}` : `Verified “${doc.title}”`);
        } catch (error) {
          fail(error);
        }
      },

      /** Move documents into another collection; Undo moves them back. */
      async move(docs: DocRef[], destination: { name: string; displayName: string }, from?: string) {
        try {
          await Promise.all(docs.map((d) => moveItem(ws, d.name, destination.name)));
          refresh();
          toast(`Moved ${plural(docs.length, "document")} to ${destination.displayName}`, {
            undo: from
              ? () =>
                  void Promise.all(docs.map((d) => moveItem(ws, d.name, from))).then(() => {
                    refresh();
                    toast(`Moved ${plural(docs.length, "document")} back`);
                  }, fail)
              : undefined,
          });
          return true;
        } catch (error) {
          refresh();
          fail(error);
          return false;
        }
      },

      async download(doc: DocRef) {
        try {
          await downloadItem(ws, doc.name, doc.fileName || doc.title);
          toast(`Downloaded ${doc.fileName || doc.title}`);
        } catch (error) {
          fail(error);
        }
      },

      async copyLink(doc: DocRef) {
        const id = doc.name.slice(doc.name.lastIndexOf("/") + 1);
        try {
          await navigator.clipboard.writeText(`${window.location.origin}/doc/${id}`);
          toast("Link copied");
        } catch {
          toast("Couldn’t copy the link", { tone: "danger" });
        }
      },
    };
  }, [qc, ws]);
}

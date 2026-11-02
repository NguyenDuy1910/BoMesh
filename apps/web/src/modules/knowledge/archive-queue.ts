"use client";

import { useSyncExternalStore } from "react";

import { invalidateApiData } from "@/lib/api/revision";
import { restoreDocument } from "@/modules/knowledge/api";
import { knowledgeApi } from "@/modules/knowledge/knowledge-api";

/**
 * Archiving documents with an Undo window.
 *
 * `DELETE /documents/{id}` is real; bringing a deleted document back is not
 * (`document.restore` is pending and cannot reverse a delete the server has
 * applied). So an archive hides the rows at once and holds the real DELETE
 * until the Undo window closes; Undo inside the window asks `restoreDocument`
 * (which confirms the document is still live) and shows the rows again. When
 * the restore endpoint ships, the hold can stay: it only delays the delete.
 */

interface Held {
  ids: string[];
  timer: number | undefined;
  sent: boolean;
  commit: () => Promise<void>;
}

/** Archived in this tab: held, being deleted, or deleted (a refetch no longer lists those anyway). */
const hidden = new Set<string>();
let snapshot: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const held = new Set<Held>();

function publish() {
  snapshot = new Set(hidden);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Document ids archived in this tab, whose rows stay hidden. */
export function useArchivedDocuments(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

// Leaving the page sends every held delete, so an archive is never lost by navigating away.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const entry of held) void entry.commit();
  });
}

export interface ArchiveHandle {
  /** Brings the rows back. Rejects when the delete was already sent. */
  undo: () => Promise<void>;
}

/**
 * Hide `ids` now and delete them after `holdMs` (0 = at once). `onFailed`
 * receives the ids the server refused to delete; their rows come back.
 */
export function archiveDocuments(
  ids: readonly string[],
  { holdMs, onFailed }: { holdMs: number; onFailed: (failedIds: string[]) => void },
): ArchiveHandle {
  for (const id of ids) hidden.add(id);
  publish();

  const entry: Held = {
    ids: [...ids],
    timer: undefined,
    sent: false,
    async commit() {
      if (entry.sent) return;
      entry.sent = true;
      window.clearTimeout(entry.timer);
      held.delete(entry);
      const results = await Promise.allSettled(entry.ids.map((id) => knowledgeApi.deleteDocument(id)));
      const failed = entry.ids.filter((_, index) => results[index].status === "rejected");
      for (const id of failed) hidden.delete(id);
      publish();
      invalidateApiData();
      if (failed.length) onFailed(failed);
    },
  };
  held.add(entry);
  entry.timer = window.setTimeout(() => void entry.commit(), Math.max(0, holdMs));

  return {
    async undo() {
      if (entry.sent) throw new Error("These documents were already archived.");
      entry.sent = true;
      window.clearTimeout(entry.timer);
      held.delete(entry);
      try {
        await Promise.all(entry.ids.map((id) => restoreDocument(id)));
      } finally {
        for (const id of entry.ids) hidden.delete(id);
        publish();
      }
    },
  };
}

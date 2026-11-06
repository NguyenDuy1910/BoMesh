"use client";

import { confirm, toast } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { plural } from "@/lib/format";
import { useWorkspace } from "@/lib/workspace";

import { createSync, deleteSource, pauseSource, publishWaiting, resumeSource, updateSource, type Connection, type PublishingPolicy, type Source, type Sync } from "./api";
import { appName, sourceName, sourceStatus } from "./model";
import { openReconnect } from "./overlays";
import { useInvalidateIngestion } from "./queries";
import { draftText, scheduleFor, type ScheduleDraft } from "./schedule";

/**
 * Source actions shared by the table rows, the alerts and the drawers: each
 * calls the API, refreshes ingestion data, then toasts (Undo where the API can
 * reverse it).
 */
export interface SourceActions {
  syncNow: (source: Source) => Promise<Sync | null>;
  togglePause: (source: Source) => Promise<void>;
  disconnect: (source: Source, kbName: string | undefined) => Promise<boolean>;
  publish: (sources: readonly Source[]) => Promise<void>;
  setPolicy: (source: Source, policy: PublishingPolicy) => Promise<void>;
  saveSchedule: (source: Source, draft: ScheduleDraft) => Promise<boolean>;
}

export function useSourceActions(connections: ReadonlyMap<string, Connection>): SourceActions {
  const { id } = useWorkspace();
  const refresh = useInvalidateIngestion();

  const fail = (error: unknown) => toast(errorMessage(error), { tone: "danger" });

  /** Starts a MANUAL sync; an expired account opens Reconnect instead. Returns the new sync. */
  async function syncNow(source: Source): Promise<Sync | null> {
    const connection = connections.get(source.connection);
    if (connection && connection.state !== "ACTIVE") {
      openReconnect(source.connection);
      return null;
    }
    if (sourceStatus(source) === "syncing") {
      toast(`${sourceName(source)} is already syncing`, { tone: "accent" });
      return null;
    }
    try {
      const sync = await createSync(id, source.name ?? "");
      toast(`Syncing ${sourceName(source)}…`, { tone: "accent" });
      return sync;
    } catch (error) {
      fail(error);
      return null;
    } finally {
      refresh();
    }
  }

  async function pause(source: Source) {
    try {
      await pauseSource(id, source.name ?? "");
      toast(`Paused ${sourceName(source)}`, {
        undo: () => {
          resumeSource(id, source.name ?? "").then(refresh, fail);
        },
      });
    } catch (error) {
      fail(error);
    } finally {
      refresh();
    }
  }

  async function resume(source: Source) {
    try {
      const resumed = await resumeSource(id, source.name ?? "");
      if (resumed.state === "REAUTHORIZATION_REQUIRED") {
        toast(`Resumed ${sourceName(source)}. Reconnect ${appName(connections.get(source.connection)?.connector)} to sync again.`, { tone: "accent" });
      } else toast(`Resumed ${sourceName(source)}`);
    } catch (error) {
      fail(error);
    } finally {
      refresh();
    }
  }

  const togglePause = (source: Source) => (source.state === "PAUSED" ? resume(source) : pause(source));

  async function disconnect(source: Source, kbName: string | undefined): Promise<boolean> {
    const ok = await confirm({
      title: `Disconnect ${sourceName(source)}?`,
      description: `Documents already in ${kbName || "the knowledge base"} stay. New changes stop syncing.`,
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return false;
    try {
      await deleteSource(id, source.name ?? "");
      toast(`Disconnected ${sourceName(source)}`);
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      refresh();
    }
  }

  /** Publishes what the sources left waiting (one processing run per source). */
  async function publish(sources: readonly Source[]) {
    const waiting = sources.filter((s) => (s.pendingDocumentCount ?? 0) > 0);
    const count = waiting.reduce((n, s) => n + (s.pendingDocumentCount ?? 0), 0);
    if (!count) {
      toast("Nothing waiting to publish", { tone: "accent" });
      return;
    }
    try {
      await Promise.all(waiting.map((s) => publishWaiting(id, s.name ?? "")));
      toast(waiting.length === 1 ? `Publishing ${plural(count, "document")} from ${sourceName(waiting[0]!)}` : `Publishing ${plural(count, "document")}`);
    } catch (error) {
      fail(error);
    } finally {
      refresh();
    }
  }

  async function setPolicy(source: Source, policy: PublishingPolicy) {
    const before = source.publishingPolicy ?? "REVIEW_FIRST";
    if (before === policy) return;
    try {
      const updated = await updateSource(id, source, { publishingPolicy: policy }, ["publishingPolicy"]);
      toast(policy === "REVIEW_FIRST" ? `${sourceName(source)}: new and changed files go to review first` : `${sourceName(source)}: new and changed files publish automatically`, {
        undo: () => {
          updateSource(id, updated, { publishingPolicy: before }, ["publishingPolicy"]).then(refresh, fail);
        },
      });
    } catch (error) {
      fail(error);
    } finally {
      refresh();
    }
  }

  async function saveSchedule(source: Source, draft: ScheduleDraft): Promise<boolean> {
    try {
      await updateSource(id, source, { schedule: scheduleFor(draft) }, ["schedule"]);
      toast(`Schedule saved · ${draftText(draft)}`);
      return true;
    } catch (error) {
      fail(error);
      return false;
    } finally {
      refresh();
    }
  }

  return { syncNow, togglePause, disconnect, publish, setPolicy, saveSchedule };
}

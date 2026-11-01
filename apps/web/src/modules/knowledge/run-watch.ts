"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

import { afterVisibleDelay } from "@/lib/hooks/usePolling";
import { ingestionRunsApi, isRunActive, type IngestionRun } from "@/modules/ingestion/runs-api";

/**
 * Runs this tab started from a knowledge base (an upload, a reprocess, a
 * retry), followed until they finish. The contract has no push channel:
 * clients poll run detail about every 2 s while it runs.
 */
export interface WatchedRun {
  runId: string;
  collectionId: string;
  kind: "upload" | "reprocess" | "retry";
  /** The one document's name when the run covers a single document. */
  singleName: string | null;
}

const POLL_MS = 2000;
const watched = new Map<string, WatchedRun>();
let snapshot: readonly WatchedRun[] = [];
const listeners = new Set<() => void>();

function publish() {
  snapshot = [...watched.values()];
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function watchRun(run: WatchedRun): void {
  watched.set(run.runId, run);
  publish();
}

/**
 * Poll this collection's watched runs. `onProgress` fires when a run's counts
 * move (re-read the documents); `onFinished` once per run that stops.
 */
export function useWatchedRuns(
  collectionId: string,
  handlers: { onProgress: () => void; onFinished: (watch: WatchedRun, run: IngestionRun) => void },
): readonly WatchedRun[] {
  const all = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  const mine = all.filter((run) => run.collectionId === collectionId);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const key = mine.map((run) => run.runId).join(",");

  useEffect(() => {
    if (!key) return;
    const runIds = key.split(",");
    const seen = new Map<string, string>();
    let stopped = false;
    let cancel = () => {};
    const tick = async () => {
      let moved = false;
      for (const runId of runIds) {
        const watch = watched.get(runId);
        if (!watch) continue;
        try {
          const run = await ingestionRunsApi.get(runId);
          const signature = `${run.status}:${JSON.stringify(run.counts)}`;
          if (seen.get(runId) !== signature) {
            seen.set(runId, signature);
            moved = true;
          }
          if (!isRunActive(run)) {
            watched.delete(runId);
            handlersRef.current.onFinished(watch, run);
          }
        } catch {
          // A run the caller can no longer read just stops being followed.
          watched.delete(runId);
        }
      }
      if (stopped) return;
      if (moved) handlersRef.current.onProgress();
      if (runIds.some((runId) => watched.has(runId))) cancel = afterVisibleDelay(POLL_MS, () => void tick());
      else publish();
    };
    cancel = afterVisibleDelay(POLL_MS, () => void tick());
    return () => {
      stopped = true;
      cancel();
    };
  }, [key]);

  return mine;
}

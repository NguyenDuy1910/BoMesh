import type { IngestionRun, IngestionRunScope, RunSelectableState } from "./runs-api.ts";

/**
 * How a run is said out loud.
 *
 * The API speaks in run and item statuses; a person reads what was processed,
 * how far it got and whether anything needs them. Every screen that shows a
 * run takes its words from here (its status from `lib/status.ts`), so the
 * list, the detail and a toast cannot describe the same run differently.
 */

/** Progress is what has reached an outcome: processed or failed, of the total. */
export function runProgress(run: Pick<IngestionRun, "counts">) {
  const { total, succeeded, failed } = run.counts;
  const done = succeeded + failed;
  return {
    done,
    total,
    /** 0–100, for a bar. */
    percent: total ? Math.min(100, Math.round((done / total) * 100)) : 0,
  };
}

const STATE_WORDS: Record<RunSelectableState, string> = {
  pending: "pending",
  outdated: "outdated",
  failed: "failed",
  ready: "ready",
};

function joinWords(words: readonly string[]): string {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Pending and outdated documents", or just "Documents" when no state narrows it. */
export function describeStates(states: readonly RunSelectableState[]): string {
  const phrase = joinWords(states.map((state) => STATE_WORDS[state] ?? state));
  return phrase ? `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} documents` : "Documents";
}

export interface ScopeNames {
  collection: (id: string) => string | undefined;
  source: (id: string) => string | undefined;
}

/**
 * What a run processed, as a sentence: "Pending and outdated documents in
 * Finance", "12 selected documents", "Failed documents from a previous run".
 */
export function describeScope(scope: IngestionRunScope, names: ScopeNames): string {
  if (scope.retry_of_run_id) return "Retry of documents that did not finish";
  if (scope.selected_documents !== null) {
    const count = scope.selected_documents;
    return `${count.toLocaleString()} selected ${count === 1 ? "document" : "documents"}`;
  }
  const what = describeStates(scope.states);
  if (scope.collection_id) {
    return `${what} in ${names.collection(scope.collection_id) ?? "a knowledge base"}`;
  }
  if (scope.source_id) {
    return `${what} from ${names.source(scope.source_id) ?? "a source"}`;
  }
  return `${what} in the workspace`;
}

/** Who started it, in a word: their name, or the schedule that did. */
export function runActor(run: Pick<IngestionRun, "created_by" | "trigger">): string {
  const person = run.created_by?.display_name || run.created_by?.email;
  if (person) return person;
  return run.trigger === "scheduled" ? "Schedule" : run.trigger === "api" ? "API" : "Unknown";
}

/** A span as the history table reads it: "4s", "6m 19s", "1h 2m". */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Time between two instants, or until `now` while it is still open. */
export function elapsed(
  startedAt: string | null,
  finishedAt: string | null,
  now = Date.now(),
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : now;
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** Documents a retry would take again: failed, skipped and cancelled. */
export function retryableCount(run: Pick<IngestionRun, "counts">): number {
  const { failed, skipped, cancelled } = run.counts;
  return failed + skipped + cancelled;
}

export type RunStepState = "done" | "active" | "pending" | "failed" | "stopped";

export interface RunStep {
  label: string;
  state: RunStepState;
  note: string;
}

const documents = (count: number) => `${count.toLocaleString()} ${count === 1 ? "document" : "documents"}`;

/**
 * The three steps a person recognises in a sync — collect what changed, read
 * it, make it searchable — derived from the run's counts. No step carries a
 * duration: the API times documents, not steps, and a split would be invented.
 */
export function runSteps(run: Pick<IngestionRun, "status" | "counts" | "error">): RunStep[] {
  const { total, succeeded, failed } = run.counts;
  const reached = succeeded + failed;
  const found = `Found ${documents(total)} to process`;
  const ready = `${succeeded.toLocaleString()} ready for questions`;
  const collect = (state: RunStepState, note = found): RunStep => ({ label: "Collect documents", state, note });
  const read = (state: RunStepState, note: string): RunStep => ({ label: "Read documents", state, note });
  const searchable = (state: RunStepState, note: string): RunStep => ({ label: "Make searchable", state, note });

  switch (run.status) {
    case "queued":
      return [collect("active", "Waiting to start"), read("pending", "Not started"), searchable("pending", "Not started")];
    case "running":
      return [
        collect("done"),
        read("active", `${reached.toLocaleString()} of ${total.toLocaleString()} read`),
        succeeded ? searchable("active", ready) : searchable("pending", "Waiting"),
      ];
    case "completed":
      return [
        collect("done"),
        read("done", `${succeeded.toLocaleString()} read${failed ? ` · ${failed.toLocaleString()} couldn’t be read` : ""}`),
        searchable("done", ready),
      ];
    case "cancelled":
      return [
        collect("done"),
        read("stopped", `Stopped after ${reached.toLocaleString()} of ${total.toLocaleString()}`),
        searchable("stopped", ready),
      ];
    default:
      if (!total) {
        return [
          collect("failed", run.error || "Couldn’t start"),
          read("pending", "Not started"),
          searchable("pending", "Not started"),
        ];
      }
      return [
        collect("done"),
        read("failed", `Stopped after ${reached.toLocaleString()} of ${total.toLocaleString()}`),
        searchable(succeeded ? "stopped" : "pending", succeeded ? ready : "Not started"),
      ];
  }
}

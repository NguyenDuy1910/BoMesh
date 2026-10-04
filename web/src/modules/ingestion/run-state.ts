import type { StatusVocabulary } from "@/components/ui/StatusBadge";
import type {
  IngestionRun,
  IngestionRunPhase,
  IngestionRunScope,
  IngestionRunTrigger,
  RunSelectableState,
} from "./runs-api.ts";

/**
 * How a run is said out loud.
 *
 * The API speaks in run and item statuses; a person reads what was processed,
 * how far it got and whether anything needs them. Every screen that shows a
 * run takes its words from here, so the list, the detail and a toast cannot
 * describe the same run differently.
 */

/** Run statuses, in end-user words. */
export const RUN_STATUS: StatusVocabulary = {
  queued: { label: "Queued", tone: "info", moving: true },
  running: { label: "Processing", tone: "info", moving: true },
  completed: { label: "Completed", tone: "success" },
  completed_with_errors: { label: "Completed with errors", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** A run item is a Document, so it reads in the Document's own states. */
export const RUN_ITEM_STATUS: StatusVocabulary = {
  queued: { label: "Waiting", tone: "neutral" },
  running: { label: "Processing", tone: "info", moving: true },
  succeeded: { label: "Ready", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Skipped", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/**
 * The `RUN_STATUS` entry a run is shown with. A run that completed with some
 * Documents failed is normal, not a failure of the run, but it still needs
 * someone, so it reads differently from a clean one.
 */
export function runStatus(run: Pick<IngestionRun, "status" | "counts">): string {
  return run.status === "completed" && run.counts.failed > 0 ? "completed_with_errors" : run.status;
}

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
    return `${what} in ${names.collection(scope.collection_id) ?? "a collection"}`;
  }
  if (scope.source_id) {
    return `${what} from ${names.source(scope.source_id) ?? "a source"}`;
  }
  return `${what} in the workspace`;
}

export const TRIGGER_LABEL: Record<IngestionRunTrigger, string> = {
  manual: "Started by a person",
  scheduled: "Started by a schedule",
  api: "Started through the API",
};

/** Who started it, in a word: their name, or the schedule that did. */
export function runActor(run: Pick<IngestionRun, "created_by" | "trigger">): string {
  const person = run.created_by?.display_name || run.created_by?.email;
  if (person) return person;
  return run.trigger === "scheduled" ? "Schedule" : run.trigger === "api" ? "API" : "Unknown";
}

/** A short span: "850 ms", "12.4 s", "3 min 5 s", "1 h 2 min". */
export function formatDuration(milliseconds: number): string {
  const ms = Math.max(0, Math.round(milliseconds));
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
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

const PHASE_LABEL: Record<IngestionRunPhase["phase"], string> = {
  downloading: "Downloading",
  expanding: "Expanding archive",
  parsing: "Parsing",
  contextualizing: "Contextualizing",
  embedding: "Embedding",
  storing: "Storing",
};

/** One line per document: "Parsing 1.2 s · Embedding 3.4 s · Storing 220 ms". */
export function describePhases(phases: readonly IngestionRunPhase[], now = Date.now()): string {
  return phases
    .map((phase) => {
      const label = PHASE_LABEL[phase.phase] ?? phase.phase;
      const span = elapsed(phase.started_at, phase.finished_at, now);
      return span === null ? label : `${label} ${formatDuration(span)}`;
    })
    .join(" · ");
}

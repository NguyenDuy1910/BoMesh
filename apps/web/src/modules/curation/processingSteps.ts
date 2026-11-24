import type { IngestionRun, IngestionTask } from "./api";
import type { ProcessingKey } from "./lifecycle";

/**
 * A document's processing steps (preview `PROC_STEPS` / `procSteps` in core/lifecycle.js): an ingestion run task's
 * `phases` (document_contract.md "Processing") grouped into the five steps people read. A step the task went past
 * without entering (no topics to choose among, contextual retrieval off) was skipped.
 */

type Phase = NonNullable<IngestionTask["phase"]>;

export interface ProcStep {
  id: "read" | "classify" | "context" | "embed" | "index";
  label: string;
  phases: readonly Phase[];
  /** What the step does. */
  desc: string;
  /** What it does when the file needed text recognition (OCR). */
  ocrDesc?: string;
  /** Why it was skipped. */
  skipped?: string;
}

export const PROC_STEPS: readonly ProcStep[] = [
  {
    id: "read",
    label: "Read the file",
    phases: ["FETCHING", "PARSING", "OCR"],
    desc: "Opens the file and splits it into passages",
    ocrDesc: "Opens the file, recognizes its text and splits it into passages",
  },
  { id: "classify", label: "Classify", phases: ["CLASSIFYING"], desc: "Picks its topics among the candidates", skipped: "Skipped: no topics to choose among" },
  { id: "context", label: "Add context", phases: ["CHUNKING"], desc: "Situates each passage in the document", skipped: "Skipped: contextual retrieval is off" },
  { id: "embed", label: "Embed", phases: ["EMBEDDING"], desc: "Turns passages into vectors for search" },
  { id: "index", label: "Index", phases: ["INDEXING"], desc: "Stores them so search and the assistant find them" },
];

export type StepState = "todo" | "running" | "done" | "failed" | "skipped";

export interface StepStatus extends ProcStep {
  state: StepState;
  /** Time spent: so far while running, in total once done. */
  ms: number;
  /** The read step recognized the file's text. */
  ocr: boolean;
}

const ENDED: Partial<Record<NonNullable<IngestionTask["state"]>, true>> = { SUCCEEDED: true, FAILED: true, CANCELLED: true };
const time = (t: string | undefined) => (t ? Date.parse(t) : NaN);

/** The task's five steps, in order. */
export function procSteps(task: IngestionTask, now = Date.now()): StepStatus[] {
  const phases = task.phases ?? [];
  const stepOf = (p: Phase | undefined) => PROC_STEPS.findIndex((s) => !!p && s.phases.includes(p));
  const lastSeen = Math.max(-1, ...phases.map((p) => stepOf(p.phase)));
  const ended = !!task.state && !!ENDED[task.state];
  return PROC_STEPS.map((s, i) => {
    const mine = phases.filter((p) => !!p.phase && s.phases.includes(p.phase));
    const ms = mine.reduce((sum, p) => {
      const start = time(p.startTime);
      const end = Number.isFinite(time(p.endTime)) ? time(p.endTime) : now;
      return Number.isFinite(start) ? sum + Math.max(0, end - start) : sum;
    }, 0);
    let state: StepState;
    if (mine.some((p) => p.state === "FAILED")) state = "failed";
    else if (mine.some((p) => p.state === "RUNNING")) state = ended ? "todo" : "running";
    else if (mine.some((p) => p.state === "SUCCEEDED")) state = "done";
    else if (i < lastSeen || task.state === "SUCCEEDED") state = "skipped";
    else state = "todo";
    return { ...s, state, ms, ocr: s.id === "read" && phases.some((p) => p.phase === "OCR") };
  });
}

/** The step it's at (running) or stopped at (failed), with its 1-based position. */
export function procStepAt(steps: readonly StepStatus[]): (StepStatus & { n: number }) | null {
  const i = steps.findIndex((s) => s.state === "running" || s.state === "failed");
  return i < 0 ? null : { ...steps[i], n: i + 1 };
}

/** Time from start (or creation) to end, or to now while it runs; null when unknown. */
export function taskElapsed(task: IngestionTask, now = Date.now()): number | null {
  const start = time(task.startTime ?? task.createTime);
  const end = Number.isFinite(time(task.endTime)) ? time(task.endTime) : now;
  return Number.isFinite(start) ? Math.max(0, end - start) : null;
}

/* ═══════════════ Documents → Processing: the state a row shows ═══════════════ */

/** What a Processing row reads (and its state pills filter on): Waiting is a queued run task, the rest are processing states. */
export type ShownProcessing = ProcessingKey | "waiting";

const TASK_SHOWN: Partial<Record<NonNullable<IngestionTask["state"]>, ShownProcessing>> = { QUEUED: "waiting", RUNNING: "processing", FAILED: "failed", SUCCEEDED: "ready" };

/**
 * The state a Processing row shows (preview `procShown`): its task in the runs in flight — Waiting, Processing, Failed,
 * or Processed until the run ends — else its processing state (`ProcessingState` renders the same choice).
 */
export const shownProcessing = (processing: ProcessingKey, live: IngestionTask | undefined): ShownProcessing => (live?.state && TASK_SHOWN[live.state]) || processing;

/* ═══════════════ A run's tasks between polls ═══════════════ */

/** A run's tasks by item ID. */
export type RunTasks = Readonly<Record<string, IngestionTask>>;

/** What one poll reads: the running tasks, or the latest finished ones (newest first, at most `limit`). */
export type TaskRead = { kind: "running" } | { kind: "finished"; limit: number };

/** A run's known tasks, and what the last poll read (`null`: the first read, of every task, or nothing). */
export interface RunSync {
  tasks: RunTasks;
  last: TaskRead["kind"] | null;
}

export const RUNNING_TASKS = "state = RUNNING";
export const FINISHED_TASKS = "state = SUCCEEDED OR state = FAILED OR state = CANCELLED";
/** Room for tasks that finish between the run's counts and the read. */
const FINISHED_SLACK = 20;

/** Task ID = item ID. */
export const taskKey = (t: IngestionTask) => (t.item ?? t.name ?? "").split("/").pop() ?? "";

/**
 * What a poll reads once the run's tasks are known — at most one request: the latest finished tasks when the run's
 * counts say more finished than are known, the running ones while the run has some (their steps move); when both
 * changed they take turns, so neither waits more than one poll. A waiting task only starts (it's then running) or
 * ends (it's then counted finished), so waiting tasks are never read again; with nothing running or newly finished
 * there's no read at all.
 */
export function nextTaskRead(sync: RunSync, counts: IngestionRun["counts"]): TaskRead | null {
  const c = counts ?? {};
  const done = (c.succeededCount ?? 0) + (c.failedCount ?? 0) + (c.cancelledCount ?? 0);
  const seen = Object.values(sync.tasks).filter((t) => !!t.state && !!ENDED[t.state]).length;
  const running = (c.runningCount ?? 0) > 0;
  if (done > seen && (!running || sync.last !== "finished")) return { kind: "finished", limit: Math.min(1000, done - seen + FINISHED_SLACK) };
  return running ? { kind: "running" } : null;
}

/** The known tasks with what a poll read; a finished task never goes back to running. */
export function mergeTasks(known: RunTasks, read: readonly IngestionTask[]): RunTasks {
  let next: Record<string, IngestionTask> | null = null;
  for (const t of read) {
    const was = (next ?? known)[taskKey(t)]?.state;
    if (was && ENDED[was] && !(t.state && ENDED[t.state])) continue;
    next ??= { ...known };
    next[taskKey(t)] = t;
  }
  return next ?? known;
}

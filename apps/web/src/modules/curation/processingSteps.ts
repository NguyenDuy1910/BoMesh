import type { IngestionTask } from "./api";

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

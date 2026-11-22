"use client";

import { Pressable } from "@heroui/react";
import clsx from "clsx";
import { AlertCircle, Check, CircleDashed, LoaderCircle, Minus, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PopoverSheet, StatusChip } from "@/components/ui";
import { fmtDuration, rel } from "@/lib/format";
import { ProcessingChip } from "@/modules/knowledge/components/LifecycleChip";

import type { IngestionTask } from "../api";
import { processingLine, type DocRow } from "../model";
import { PROC_STEPS, procStepAt, procSteps, taskElapsed, type StepState, type StepStatus } from "../processingSteps";
import { useRunTask } from "../queries";

/** The task's error, user-safe (`IngestionTask.error.message`). */
const errorOf = (task: IngestionTask) => (task.error as { message?: string } | undefined)?.message || "";
/** "under a second" rather than "0s": a file that can't be read fails at once. */
const took = (ms: number) => (ms < 1000 ? "under a second" : fmtDuration(ms));

/** current = the step in flight (spinning); issue = where it stopped (preview `TASK_STEP`). */
const STEP_LOOK: Readonly<Record<StepState, [cls: string, icon: LucideIcon, tone: string, sr: string]>> = {
  done: ["done", Check, "success", "Done"],
  running: ["current", LoaderCircle, "accent", "In progress"],
  failed: ["issue", AlertCircle, "danger", "Failed"],
  skipped: ["skipped", Minus, "", "Skipped"],
  todo: ["todo", CircleDashed, "", "Not yet"],
};

/** A task's five steps (preview `taskSteps`): what each does, its time, and the error where it stopped. */
export function TaskSteps({ task }: { task: IngestionTask }) {
  const error = errorOf(task);
  const text = (s: StepStatus) => (s.state === "skipped" ? s.skipped || "Skipped" : s.state === "failed" ? error || "It stopped here" : s.ocr ? (s.ocrDesc ?? s.desc) : s.desc);
  return (
    <ol className="flow-steps flow-steps--compact">
      {procSteps(task).map((s) => {
        const [cls, Icon, tone, sr] = STEP_LOOK[s.state];
        return (
          <li key={s.id} className={clsx("flow-steps__item", `is-${cls}`, s.state === "running" && "is-busy")}>
            <span className={clsx("flow-steps__dot", tone && `flow-steps__dot--${tone}`)} aria-hidden="true">
              <Icon className="i i-xs" />
            </span>
            <div className="grow">
              <div className="row gap-8 t-sm">
                <span className="medium grow">{s.label}</span>
                <span className="sr-only">{sr}</span>
                {s.ms >= 500 && s.state !== "todo" ? <span className="flow-steps__time num">{fmtDuration(s.ms)}</span> : null}
              </div>
              <div className={clsx("flow-steps__text", s.state === "failed" && "cur-ix--bad")}>{text(s)}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** When it started or how long it took, in one line above the steps (preview `taskWhen`). */
function taskWhen(task: IngestionTask): string {
  const ms = taskElapsed(task) ?? 0;
  if (task.state === "QUEUED") return "Waiting for a free slot";
  if (task.state === "RUNNING") return `Started ${rel(task.startTime ?? task.createTime ?? "")} · ${fmtDuration(ms)} so far`;
  if (task.state === "SUCCEEDED") return `Processed ${rel(task.endTime ?? "")} in ${took(ms)}`;
  if (task.state === "FAILED") return `Stopped ${rel(task.endTime ?? "")} after ${took(ms)}`;
  return `Stopped ${rel(task.endTime ?? "")}`;
}

/**
 * Five segments (one per step) and where it is — each part its own text, so each translates — as a button that opens
 * *Processing steps* (preview `stepTrack` + `PO['proc-steps']`); a failure's fix sits in the popover's footer.
 */
function StepTrack({ task, parts, bad = false, fix }: { task: IngestionTask; parts: readonly string[]; bad?: boolean; fix?: ReactNode }) {
  const steps = procSteps(task);
  return (
    <PopoverSheet
      title="Processing steps"
      className="proc-pop"
      footer={fix}
      trigger={
        <Pressable>
          <button type="button" className={clsx("proc-track", bad && "is-bad")} title="See each step">
            <span className="proc-track__bar" aria-hidden="true">
              {steps.map((s) => (
                <span key={s.id} className={`proc-track__seg is-${s.state}`} />
              ))}
            </span>
            <span className="proc-track__label truncate">
              {parts.filter(Boolean).map((p, i) => (
                <span key={i}>
                  {i ? <span aria-hidden="true"> · </span> : null}
                  <span>{p}</span>
                </span>
              ))}
            </span>
          </button>
        </Pressable>
      }
    >
      <p className="proc-pop__when">{taskWhen(task)}</p>
      <TaskSteps task={task} />
    </PopoverSheet>
  );
}

/** The step it's at ("Classify · step 2 of 5") or where it failed. */
function failedAt(task: IngestionTask): string {
  const at = procStepAt(procSteps(task));
  const error = errorOf(task);
  return at ? `Failed at ${at.label}: ${error || "stopped partway"}` : error || "Stopped partway";
}

/**
 * Documents → Processing's State cell (preview `procCell` / `taskCell`). While the document's run task is in flight
 * (`live`, from the runs in flight) it reads Waiting, Processing with its step track, Processing failed at a step, or
 * Processed until the run ends. A failure from an earlier run shows the steps of its last task. Otherwise: the
 * processing chip and its line.
 */
export function ProcessingState({ row, live, fix }: { row: DocRow; live?: IngestionTask; fix?: ReactNode }) {
  const failed = row.processing === "failed" && !live;
  const last = useRunTask(row.item?.document?.lastIngestionRun, row.id, { enabled: failed });
  const task = live ?? (failed ? last.data : undefined);
  const cell = (head: ReactNode, body: ReactNode) => (
    <div className="stack gap-2 proc-cell">
      {head}
      {body}
    </div>
  );

  if (task?.state === "QUEUED") {
    return cell(<StatusChip label="Waiting" dot size="sm" tooltip="In line: it starts as soon as the worker has a free slot" />, <span className="cell-sub truncate">In line to be processed</span>);
  }
  if (task?.state === "RUNNING") {
    const at = procStepAt(procSteps(task));
    return cell(<StatusChip label="Processing" tone="accent" dot live size="sm" />, <StepTrack task={task} parts={at ? [at.label, `step ${at.n} of ${PROC_STEPS.length}`] : ["Starting…"]} />);
  }
  if (task?.state === "FAILED") {
    return cell(<ProcessingChip state="failed" size="sm" />, <StepTrack task={task} parts={[failedAt(task)]} bad fix={fix} />);
  }
  if (task?.state === "SUCCEEDED" && live) {
    return cell(
      <StatusChip label="Processed" tone="success" variant="tertiary" dot size="sm" />,
      <StepTrack task={task} parts={[processingLine({ ...row, processing: "ready" }), fmtDuration(taskElapsed(task) ?? 0)]} />,
    );
  }
  const line = processingLine(row);
  return cell(
    <ProcessingChip state={row.processing} size="sm" />,
    <span className={clsx("cell-sub truncate", (row.processing === "failed" || row.processing === "outdated") && "cur-ix--bad")} title={line}>
      {line}
    </span>,
  );
}

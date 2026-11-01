"use client";

import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  LoaderCircle,
  MessageSquareText,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SquarePen,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/cn";
import type { TurnWork, WorkRun, WorkStep, WorkStepKind } from "../work";

const STEP_ICONS: Record<WorkStepKind, LucideIcon> = {
  search: Search,
  read: FileText,
  prepare: Server,
  code: Terminal,
  export: File,
  edit: SquarePen,
  note: MessageSquareText,
  other: Settings2,
};

/** Lines of command output shown before the reader asks for the rest. */
const OUTPUT_PREVIEW_LINES = 40;

/**
 * How the answer was found: one quiet line ("Worked for 26s · Searched …")
 * that opens into a timeline of searches, reads and shell runs. While the
 * answer is being worked on the timeline is open and the line says what runs
 * now. With "Show how answers were found" off, only the live line remains.
 */
export function WorkLine({
  work,
  live,
  showSteps,
  liveFallback,
}: {
  work: TurnWork;
  live: boolean;
  showSteps: boolean;
  /** The live line before any step has started. */
  liveFallback: string;
}) {
  const [open, setOpen] = useState(false);
  const expanded = showSteps && (live || open);
  if (!live && (!showSteps || !work.steps.length)) return null;

  return (
    <div className="mb-3.5 text-[0.84375rem]">
      {live ? (
        <span aria-live="polite" className="inline-flex max-w-full items-center gap-2 text-text-tertiary" role="status">
          <LoaderCircle aria-hidden="true" className="shrink-0 animate-spin motion-reduce:animate-none" size={15} />
          <span className="truncate">{work.liveLabel ?? liveFallback}</span>
        </span>
      ) : (
        <button
          aria-expanded={open}
          className="-ml-1.5 inline-flex max-w-full items-center gap-2 rounded-sm px-1.5 py-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {open ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
          <span className="max-w-[640px] truncate">{work.summary ?? "How this answer was found"}</span>
        </button>
      )}
      {expanded && work.steps.length > 0 && (
        <div className="ml-[7px] mt-2 border-l-[1.5px] border-border-default py-0.5 pl-4">
          <ol aria-label="Steps" className="flex flex-col gap-2.5">
            {work.steps.map((step) => <Step key={step.id} step={step} />)}
          </ol>
          {work.usesShell && (
            <p className="mt-2.5 inline-flex items-center gap-1.5 text-caption text-text-tertiary">
              <ShieldCheck aria-hidden="true" size={13} />
              Ran in a private workspace for this chat · no internet · only the files you shared
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Step({ step }: { step: WorkStep }) {
  const Icon = STEP_ICONS[step.kind];
  return (
    <li className="relative flex items-start gap-2.5 text-text-secondary">
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-[21.5px] top-[7px] size-2 rounded-full",
          step.state === "ok" && "bg-status-success-text",
          step.state === "bad" && "bg-status-danger-text",
          step.state === "live" && "bg-accent-primary shadow-[0_0_0_3px_var(--accent-soft)]",
        )}
      />
      <Icon aria-hidden="true" className="mt-0.5 shrink-0 text-text-tertiary" size={15} />
      <div className="min-w-0 flex-1">
        <div className={cn(step.kind === "note" && "italic", step.state === "bad" && "text-status-danger")}>
          <span className="sr-only">{step.state === "bad" ? "Failed: " : step.state === "live" ? "In progress: " : ""}</span>
          {step.label}
          {step.detail && <span className="text-text-tertiary"> · {step.detail}</span>}
        </div>
        {step.queries && (
          <p className="mt-0.5 truncate text-caption text-text-tertiary">
            {step.queries.map((query) => `“${query}”`).join(", ")}
          </p>
        )}
        {step.runs?.map((run, index) => <Run index={index} key={`${index}:${run.command}`} run={run} />)}
        {step.files && step.files.length > 0 && (
          <p className="mt-1 text-caption text-text-tertiary">Changed {step.files.join(", ")}</p>
        )}
      </div>
    </li>
  );
}

/** One shell command: the code on request, what it printed, how it ended. */
function Run({ run, index }: { run: WorkRun; index: number }) {
  const [showCode, setShowCode] = useState(false);
  const output = run.output;
  const stdout = output?.stdout.replace(/\s+$/, "") ?? "";
  const stderr = output?.stderr.replace(/\s+$/, "") ?? "";
  const lastErrorLine = (stderr || stdout).split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  const status = !output ? "running" : run.failed ? (output.timed_out ? "took too long" : `failed · exit ${output.exit_code ?? "?"}`) : "ok";

  return (
    <div className="mt-2 overflow-hidden rounded-[10px] bg-(--code-surface) font-mono text-[0.78125rem] leading-[1.55] text-(--code-text) shadow-[inset_0_0_0_1px_var(--code-border)]">
      <div className="flex items-center gap-2 border-b border-(--code-border) px-3 py-1.5 text-(--code-muted)">
        <Terminal aria-hidden="true" size={13} />
        <span>Command {index + 1}</span>
        <button
          aria-expanded={showCode}
          className="rounded-xs px-1.5 py-0.5 text-(--code-text) hover:bg-(--code-control-hover) focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
          onClick={() => setShowCode((value) => !value)}
          type="button"
        >
          {showCode ? "Hide code" : "Show code"}
        </button>
        <span className="flex-1" />
        <span className={cn(run.failed ? "font-semibold text-(--code-danger)" : "text-(--code-muted)")}>{status}</span>
      </div>
      {showCode && <pre className="m-0 whitespace-pre-wrap break-words px-3 py-2.5">{run.command}</pre>}
      {showCode ? (
        <>
          <Output text={stdout} />
          <Output danger text={stderr} />
        </>
      ) : run.failed && lastErrorLine ? (
        <pre className="m-0 whitespace-pre-wrap break-words border-t border-(--code-border) px-3 py-2 text-(--code-danger)">{lastErrorLine}</pre>
      ) : null}
    </div>
  );
}

function Output({ text, danger }: { text: string; danger?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const lines = text.split("\n");
  const hidden = expanded ? 0 : Math.max(0, lines.length - OUTPUT_PREVIEW_LINES);
  return (
    <div className="border-t border-(--code-border) px-3 py-2">
      {hidden > 0 && (
        <button
          className="mb-1 rounded-xs px-1 text-(--code-muted) underline hover:text-(--code-text) focus-visible:shadow-(--shadow-focus) focus-visible:outline-none"
          onClick={() => setExpanded(true)}
          type="button"
        >
          Show {hidden} earlier line{hidden === 1 ? "" : "s"}
        </button>
      )}
      <pre className={cn("m-0 whitespace-pre-wrap break-words", danger ? "text-(--code-danger)" : "text-(--code-muted)")}>
        {hidden ? lines.slice(hidden).join("\n") : text}
      </pre>
    </div>
  );
}

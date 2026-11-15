"use client";

import clsx from "clsx";
import { Check, ChevronDown, ChevronRight, File, FileText, Search, Server, Terminal, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { StatusChip } from "@/components/ui/StatusChip";

import type { FoundSource, StepKind, WorkStep } from "../turn";

const STEP_ICON: Record<StepKind, LucideIcon> = { search: Search, read: FileText, prepare: Server, code: Terminal, export: File, tool: Check };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Searched your knowledge · Read 2 documents · Ran 3 commands, 1 failed · Created 1 file · 12s" (preview `stepsSummary`). */
function summary(steps: readonly WorkStep[], files: number, seconds?: number): string {
  const parts: string[] = [];
  const search = steps.find((s) => s.kind === "search");
  if (search) parts.push(search.label);
  const reads = steps.filter((s) => s.kind === "read").length;
  if (reads) parts.push(`Read ${plural(reads, "document")}`);
  const runs = steps.flatMap((s) => s.runs ?? []);
  if (runs.length) {
    const bad = runs.filter((r) => r.exit !== 0).length;
    parts.push(runs.length === 1 && !bad ? "Ran code" : `Ran ${plural(runs.length, "command")}${bad ? `, ${bad} failed` : ""}`);
  }
  if (files) parts.push(`Created ${plural(files, "file")}`);
  if (!parts.length && steps[0]) parts.push(steps[0].label);
  if (seconds) parts.push(`${seconds}s`);
  return parts.join(" · ");
}

/** Two orbiting dots: the assistant is working (no spinner). */
function Thinking() {
  return (
    <span className="chat-think" aria-hidden>
      <i />
      <i />
    </span>
  );
}

/** What a step found, as quiet document chips that open the preview at the found passage (preview `foundHtml`). */
function Found({ sources, onOpen }: { sources: readonly FoundSource[]; onOpen?: (source: FoundSource) => void }) {
  return (
    <div className="chat-found" role="list" aria-label="Found">
      {sources.map((s) => (
        <button key={s.item} type="button" role="listitem" className="chat-found__doc" translate="no" onClick={() => onOpen?.(s)}>
          <FileText className="i i-xs" aria-hidden />
          <span className="truncate">{s.title || "Untitled document"}</span>
        </button>
      ))}
    </div>
  );
}

/** Finished steps, each with what it found, and while working the live row last (preview `stepsList`). */
function StepList({ steps, live, onOpenSource }: { steps: readonly WorkStep[]; live: string | null; onOpenSource?: (source: FoundSource) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ol className="chat-steps__list" aria-label="Steps">
      {steps.map((s) => {
        const Icon = STEP_ICON[s.kind];
        return (
          <li key={s.id} className={clsx("chat-step", s.bad && "is-bad")}>
            <Icon className="i i-sm" aria-hidden />
            <div className="grow">
              <span>{s.label}</span>
              {s.detail ? <span className="muted"> · {s.detail}</span> : null}
              {s.sources?.length ? <Found sources={s.sources} onOpen={onOpenSource} /> : null}
              {(s.runs ?? []).map((r, ri) => {
                const key = `${s.id}:${ri}`;
                const show = !!open[key];
                const lastError = r.exit ? r.out.trim().split("\n").filter(Boolean).at(-1) ?? "" : "";
                return (
                  <div key={key} className="chat-run">
                    <div className="chat-run__head">
                      <Terminal className="i i-xs" aria-hidden />
                      <span>Command {ri + 1}</span>
                      <button type="button" className="link-button" onClick={() => setOpen((o) => ({ ...o, [key]: !show }))}>
                        {show ? "Hide code" : "Show code"}
                      </button>
                      <span className="grow" />
                      <StatusChip size="sm" label={r.exit ? `Failed · exit ${r.exit}` : "OK"} tone={r.exit ? "danger" : "success"} variant={r.exit ? "soft" : "tertiary"} dot={false} />
                    </div>
                    {show ? (
                      <>
                        <pre className="chat-run__code">{r.cmd}</pre>
                        {r.out ? <pre className={clsx("chat-run__out", r.exit !== 0 && "is-err")}>{r.out}</pre> : null}
                      </>
                    ) : lastError ? (
                      <pre className="chat-run__out is-err">{lastError}</pre>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </li>
        );
      })}
      {live ? (
        <li className="chat-step is-live" role="status" aria-live="polite">
          <Thinking />
          <span className="chat-steps__label truncate">{live}</span>
        </li>
      ) : null}
    </ol>
  );
}

export interface WorkStepsProps {
  steps: readonly WorkStep[];
  /** The answer is being written. */
  streaming: boolean;
  /** Nothing of the answer is on screen yet: the live row shows. */
  working: boolean;
  /** "Show how answers were found". */
  show: boolean;
  files?: number;
  seconds?: number;
  onOpenSource?: (source: FoundSource) => void;
}

/**
 * How the answer is being found, as it happens (preview `stepsHtml`): each
 * finished step shows what it found (a search lists its documents at once),
 * the live row last names the tool that runs right now or says "Thinking"
 * (it never claims a search that isn't happening), and the answer streams
 * below. An answer written in front of the reader keeps its timeline open
 * (nothing folds or jumps when it finishes); stored answers show one summary
 * line that opens it. With "Show how answers were found" off, only the live
 * line shows.
 */
export function WorkSteps({ steps, streaming, working, show, files = 0, seconds, onOpenSource }: WorkStepsProps) {
  const [open, setOpen] = useState(streaming);
  const live = working ? ([...steps].reverse().find((s) => s.live)?.label ?? "Thinking") : null;
  const done = steps.filter((s) => !s.live);
  if (!show || (streaming && !done.length)) {
    return live ? (
      <div className="chat-steps">
        <span className="chat-steps__live" role="status" aria-live="polite">
          <Thinking />
          <span className="chat-steps__label truncate">{live}</span>
        </span>
      </div>
    ) : null;
  }
  if (streaming) {
    return (
      <div className="chat-steps">
        <StepList steps={done} live={live} onOpenSource={onOpenSource} />
      </div>
    );
  }
  if (!steps.length) return null;
  return (
    <div className="chat-steps">
      <button type="button" className="chat-steps__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="i i-sm" aria-hidden /> : <ChevronRight className="i i-sm" aria-hidden />}
        <span className="truncate">{summary(steps, files, seconds) || "How this answer was found"}</span>
      </button>
      {open ? <StepList steps={done} live={null} onOpenSource={onOpenSource} /> : null}
    </div>
  );
}

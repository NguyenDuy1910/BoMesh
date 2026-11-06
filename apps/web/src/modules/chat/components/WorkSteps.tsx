"use client";

import { Spinner } from "@heroui/react";
import clsx from "clsx";
import { Check, ChevronDown, ChevronRight, File, FileText, Search, Server, Terminal, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { StatusChip } from "@/components/ui/StatusChip";

import type { StepKind, WorkStep } from "../turn";

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

function StepList({ steps }: { steps: readonly WorkStep[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <ol className="chat-steps__list" aria-label="Steps">
      {steps.map((s) => {
        const Icon = STEP_ICON[s.kind];
        return (
          <li key={s.id} className={clsx("chat-step", s.live && "is-live", s.bad && "is-bad")}>
            {s.live ? <Spinner size="sm" /> : <Icon className="i i-sm" aria-hidden />}
            <div className="grow">
              <span>{s.label}</span>
              {s.detail ? <span className="muted"> · {s.detail}</span> : null}
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
    </ol>
  );
}

/**
 * How the answer was found (preview `stepsHtml`). While working: a live line
 * with the current step; once written: a collapsed summary that opens into the
 * timeline. Hidden entirely when "Show how answers were found" is off, except
 * the live line, which is the only sign the assistant is working.
 */
export function WorkSteps({ steps, working, show, files = 0, seconds }: { steps: readonly WorkStep[]; working: boolean; show: boolean; files?: number; seconds?: number }) {
  const [open, setOpen] = useState(false);
  if (working) {
    const current = [...steps].reverse().find((s) => s.live);
    return (
      <div className="chat-steps">
        <span className="chat-steps__live" role="status" aria-live="polite">
          <Spinner size="sm" />
          <span className="truncate">{current?.label ?? "Searching your knowledge"}…</span>
        </span>
        {show && steps.length ? <StepList steps={steps} /> : null}
      </div>
    );
  }
  if (!show || !steps.length) return null;
  return (
    <div className="chat-steps">
      <button type="button" className="chat-steps__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="i i-sm" aria-hidden /> : <ChevronRight className="i i-sm" aria-hidden />}
        <span className="truncate">{summary(steps, files, seconds) || "How this answer was found"}</span>
      </button>
      {open ? <StepList steps={steps} /> : null}
    </div>
  );
}

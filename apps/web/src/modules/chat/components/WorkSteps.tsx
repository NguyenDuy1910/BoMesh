"use client";

import clsx from "clsx";
import { Check, ChevronDown, ChevronRight, File, FileText, Search, Server, Terminal, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { StatusChip } from "@/components/ui/StatusChip";
import { rel } from "@/lib/format";

import type { FoundSource, StepKind, WorkStep } from "../turn";

const STEP_ICON: Record<StepKind, LucideIcon> = { note: Check, search: Search, read: FileText, prepare: Server, code: Terminal, export: File, tool: Check };

/** Documents a search shows before "Show more". */
const FOUND_SHOWN = 3;

/** The folded flow in one line (preview `stepsSummary`): what was done, never how many or how long. */
function summary(steps: readonly WorkStep[], files: boolean): string {
  const parts: string[] = [];
  for (const s of steps) if (s.kind !== "note" && !parts.includes(s.label)) parts.push(s.label);
  if (files) parts.push("Created a file");
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

/** One found document (preview `docCard`): what it is, where it lives, how fresh, the passage that matched, and its
 *  source numbers once the answer cites it. Opens the preview at that passage. */
function DocCard({ source, index, cited, onOpen }: { source: FoundSource; index: number; cited?: readonly number[]; onOpen?: (source: FoundSource) => void }) {
  const meta = [source.collection, source.update_time ? rel(source.update_time) : null].filter(Boolean).join(" · ");
  return (
    <button type="button" role="listitem" className="chat-doc is-fresh" style={{ animationDelay: `${index * 70}ms` }} onClick={() => onOpen?.(source)}>
      <FileIcon size="sm" mime={source.mime_type} name={source.file_name ?? source.title} />
      <span className="chat-doc__head">
        <span className="chat-doc__title truncate" translate="no">
          {source.title || "Untitled document"}
        </span>
        {meta ? <span className="chat-doc__meta truncate">{meta}</span> : null}
        {cited?.length ? (
          <span className="chat-doc__ns" aria-label={`${cited.length > 1 ? "Sources" : "Source"} ${cited.join(", ")}`}>
            {cited.map((n) => (
              <span key={n} className="chat-doc__n">
                {n}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {source.excerpt ? (
        <span className="chat-doc__quote" translate="no">
          {source.page ? <b>p. {source.page} · </b> : null}
          {source.excerpt}
        </span>
      ) : null}
    </button>
  );
}

function Found({ sources, cited, onOpen }: { sources: readonly FoundSource[]; cited: ReadonlyMap<string, number[]>; onOpen?: (source: FoundSource) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, FOUND_SHOWN);
  return (
    <>
      <div className="chat-docs" role="list" aria-label="Found documents">
        {shown.map((s, i) => (
          <DocCard key={s.item} source={s} index={i} cited={cited.get(s.item)} onOpen={onOpen} />
        ))}
      </div>
      {sources.length > FOUND_SHOWN ? (
        <div className="chat-docs__more">
          <button type="button" className="link-button" onClick={() => setAll(!all)}>
            {all ? "Show less" : "Show more"}
          </button>
        </div>
      ) : null}
    </>
  );
}

function ActionRow({ step: s, cited, onOpenSource }: { step: WorkStep; cited: ReadonlyMap<string, number[]>; onOpenSource?: (source: FoundSource) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const Icon = STEP_ICON[s.kind];
  const detail = s.query ? `“${s.query}”` : s.detail;
  return (
    <li className={clsx("chat-step", s.bad && "is-bad")}>
      <Icon className="i i-sm" aria-hidden />
      <div className="grow">
        <span>{s.label}</span>
        {detail ? (
          <span className="muted" translate={s.query ? "no" : undefined}>
            {" "}
            · {detail}
          </span>
        ) : null}
        {s.sources?.length ? <Found sources={s.sources} cited={cited} onOpen={onOpenSource} /> : null}
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
}

interface Live {
  label: string;
  query?: string;
}

/** The flow in order (preview `stepsList`): notes, finished actions with what they found, and the live row last. */
function Flow({ steps, live, cited, onOpenSource }: { steps: readonly WorkStep[]; live: Live | null; cited: ReadonlyMap<string, number[]>; onOpenSource?: (source: FoundSource) => void }) {
  return (
    <ol className="chat-steps__list" aria-label="How the answer is being found">
      {steps.map((s) =>
        s.kind === "note" ? (
          <li key={s.id} className="chat-step chat-step--note is-fresh">
            <p translate="no">
              {s.text}
              {s.live ? <span className="chat-caret" aria-hidden /> : null}
            </p>
          </li>
        ) : s.live ? null : (
          <ActionRow key={s.id} step={s} cited={cited} onOpenSource={onOpenSource} />
        ),
      )}
      {live ? (
        <li className="chat-step is-live" role="status" aria-live="polite">
          <Thinking />
          <span className="chat-steps__label truncate">{live.label}</span>
          {live.query ? (
            <span className="chat-steps__q truncate" translate="no">
              “{live.query}”
            </span>
          ) : null}
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
  /** The turn saved a file. */
  files?: boolean;
  /** Source numbers of each cited document, by item name. */
  cited: ReadonlyMap<string, number[]>;
  onOpenSource?: (source: FoundSource) => void;
}

/**
 * How the answer is found, as one flow above it (preview `stepsHtml`): the
 * assistant says what it will do (a note), does it (a search shows the
 * documents it found as cards), says what it found and what comes next, then
 * answers. The live row last names the action that runs right now or says
 * "Thinking" (never a search that isn't happening); a note being written
 * needs none. An answer written in front of the reader keeps its flow open
 * (nothing folds or jumps when it finishes); stored answers show one summary
 * line that opens it. With "Show how answers were found" off, only the live
 * line shows. No counts or timings anywhere.
 */
export function WorkSteps({ steps, streaming, working, show, files = false, cited, onOpenSource }: WorkStepsProps) {
  const [open, setOpen] = useState(streaming);
  const current = [...steps].reverse().find((s) => s.live);
  const live: Live | null = working && current?.kind !== "note" ? (current ? { label: current.label, query: current.query } : { label: "Thinking" }) : null;
  const visible = steps.some((s) => s.kind === "note" || !s.live);
  if (!show || (streaming && !visible)) {
    return live ? (
      <div className="chat-steps">
        <span className="chat-steps__live" role="status" aria-live="polite">
          <Thinking />
          <span className="chat-steps__label truncate">{live.label}</span>
        </span>
      </div>
    ) : null;
  }
  if (streaming) {
    return (
      <div className="chat-steps">
        <Flow steps={steps} live={live} cited={cited} onOpenSource={onOpenSource} />
      </div>
    );
  }
  if (!steps.length) return null;
  return (
    <div className="chat-steps">
      <button type="button" className="chat-steps__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="i i-sm" aria-hidden /> : <ChevronRight className="i i-sm" aria-hidden />}
        <span className="truncate">{summary(steps, files) || "How this answer was found"}</span>
      </button>
      {open ? <Flow steps={steps} live={null} cited={cited} onOpenSource={onOpenSource} /> : null}
    </div>
  );
}

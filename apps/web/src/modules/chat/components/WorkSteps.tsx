"use client";

import clsx from "clsx";
import { Check, ChevronDown, ChevronRight, File, FileText, Search, Server, Terminal, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { FileIcon } from "@/components/ui/FileIcon";
import { StatusChip } from "@/components/ui/StatusChip";
import { rel } from "@/lib/format";
import { locationLabel } from "@/modules/knowledge/content/reference";

import type { FoundSource, StepKind, WorkStep } from "../turn";

const STEP_ICON: Record<StepKind, LucideIcon> = { note: Check, search: Search, read: FileText, prepare: Server, code: Terminal, export: File, tool: Check };

/** Documents a search shows before "Show more" while the answer is still being found. */
const FOUND_SHOWN = 3;

/** The folded flow in one line (preview `stepsSummary`): what was done, never how many or how long. */
function summary(steps: readonly WorkStep[], files: boolean): string {
  const parts: string[] = [];
  for (const s of steps) if (s.kind !== "note" && !parts.includes(s.label)) parts.push(s.label);
  if (files) parts.push("Đã tạo tệp");
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

/** One found document (preview `docCard`): what it is, where it lives, how fresh, its best match (where, then the
 *  quote), and its source numbers once the answer cites it. Opens the preview at that match. */
function DocCard({ source, index, cited, onOpen }: { source: FoundSource; index: number; cited?: readonly number[]; onOpen?: (source: FoundSource) => void }) {
  const meta = [source.collection, source.update_time ? rel(source.update_time) : null].filter(Boolean).join(" · ");
  const where = locationLabel(source);
  return (
    <button type="button" role="listitem" className="chat-doc is-fresh" style={{ animationDelay: `${index * 70}ms` }} onClick={() => onOpen?.(source)}>
      <FileIcon size="sm" mime={source.mime_type} name={source.file_name ?? source.title} />
      <span className="chat-doc__head">
        <span className="chat-doc__title truncate" translate="no">
          {source.title || "Tài liệu chưa đặt tên"}
        </span>
        {meta ? <span className="chat-doc__meta truncate">{meta}</span> : null}
        {cited?.length ? (
          <span className="chat-doc__ns" aria-label={`Nguồn ${cited.join(", ")}`}>
            {cited.map((n) => (
              <span key={n} className="chat-doc__n">
                {n}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {source.quote ? (
        <span className="chat-doc__quote" translate="no">
          {where ? <b>{where} · </b> : null}
          {source.quote}
        </span>
      ) : null}
    </button>
  );
}

/** What a search found (preview `foundHtml`). While the answer is found, or when it stopped short: every document,
 *  three then "Show more". Once it is written: only the documents it cites; the others it found but did not use stay
 *  one quiet link away, since a near match is not a source. */
function Found({ sources, cited, answered, onOpen }: { sources: readonly FoundSource[]; cited: ReadonlyMap<string, number[]>; answered: boolean; onOpen?: (source: FoundSource) => void }) {
  const [all, setAll] = useState(false);
  const cards = (list: readonly FoundSource[]) =>
    list.length ? (
      <div className="chat-docs" role="list" aria-label="Tài liệu tìm thấy">
        {list.map((s, i) => (
          <DocCard key={s.item} source={s} index={i} cited={cited.get(s.item)} onOpen={onOpen} />
        ))}
      </div>
    ) : null;
  const toggle = (label: string) => (
    <div className="chat-docs__more">
      <button type="button" className="link-button" onClick={() => setAll(!all)}>
        {label}
      </button>
    </div>
  );
  if (!answered) {
    return (
      <>
        {cards(all ? sources : sources.slice(0, FOUND_SHOWN))}
        {sources.length > FOUND_SHOWN ? toggle(all ? "Thu gọn" : "Xem thêm") : null}
      </>
    );
  }
  const used = sources.filter((s) => cited.has(s.item));
  const unused = sources.filter((s) => !cited.has(s.item));
  if (!unused.length) return cards(used);
  const label = used.length ? (all ? "Ẩn các tài liệu khác" : "Xem các tài liệu khác đã tìm thấy") : all ? "Ẩn tài liệu đã tìm thấy" : "Xem tài liệu đã tìm thấy";
  return (
    <>
      {cards(all ? [...used, ...unused] : used)}
      {toggle(label)}
    </>
  );
}

function ActionRow({ step: s, cited, answered, onOpenSource }: { step: WorkStep; cited: ReadonlyMap<string, number[]>; answered: boolean; onOpenSource?: (source: FoundSource) => void }) {
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
        {s.sources?.length ? <Found sources={s.sources} cited={cited} answered={answered} onOpen={onOpenSource} /> : null}
        {(s.runs ?? []).map((r, ri) => {
          const key = `${s.id}:${ri}`;
          const show = !!open[key];
          const lastError = r.exit ? r.out.trim().split("\n").filter(Boolean).at(-1) ?? "" : "";
          return (
            <div key={key} className="chat-run">
              <div className="chat-run__head">
                <Terminal className="i i-xs" aria-hidden />
                <span>{`Lệnh ${ri + 1}`}</span>
                <button type="button" className="link-button" onClick={() => setOpen((o) => ({ ...o, [key]: !show }))}>
                  {show ? "Ẩn mã" : "Hiện mã"}
                </button>
                <span className="grow" />
                <StatusChip size="sm" label={r.exit ? `Lỗi · mã thoát ${r.exit}` : "OK"} tone={r.exit ? "danger" : "success"} variant={r.exit ? "soft" : "tertiary"} dot={false} />
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
function Flow({ steps, live, cited, answered, onOpenSource }: { steps: readonly WorkStep[]; live: Live | null; cited: ReadonlyMap<string, number[]>; answered: boolean; onOpenSource?: (source: FoundSource) => void }) {
  return (
    <ol className="chat-steps__list" aria-label="Cách câu trả lời đang được tìm">
      {steps.map((s) =>
        s.kind === "note" ? (
          <li key={s.id} className="chat-step chat-step--note is-fresh">
            <p translate="no">
              {s.text}
              {s.live ? <span className="chat-caret" aria-hidden /> : null}
            </p>
          </li>
        ) : s.live ? null : (
          <ActionRow key={s.id} step={s} cited={cited} answered={answered} onOpenSource={onOpenSource} />
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
  /** Nothing of the answer is on screen yet: the flow shows open, the live row last. */
  working: boolean;
  /** The answer was written to the end (COMPLETED): a search lists only what it cites. */
  answered: boolean;
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
 * needs none. The flow folds into one summary line as the answer starts to
 * appear, so the answer takes its place before anyone reads it (nothing jumps
 * when it finishes); the line opens it again, and a search then lists only the
 * documents the answer cites. An answer that stops short (stopped, failed)
 * opens its flow again: what was found is all there is. With "Show how
 * answers were found" off, only the live line shows. No counts or timings.
 */
export function WorkSteps({ steps, streaming, working, answered, show, files = false, cited, onOpenSource }: WorkStepsProps) {
  const [open, setOpen] = useState(false);
  const [wasStreaming, setWasStreaming] = useState(streaming);
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    // A new answer starts folded; one that stops short opens. One that finishes leaves the reader's choice alone.
    if (streaming) setOpen(false);
    else if (!answered) setOpen(true);
  }
  const current = [...steps].reverse().find((s) => s.live);
  const live: Live | null = working && current?.kind !== "note" ? (current ? { label: current.label, query: current.query } : { label: "Đang suy nghĩ" }) : null;
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
  if (streaming && working) {
    return (
      <div className="chat-steps">
        <Flow steps={steps} live={live} cited={cited} answered={false} onOpenSource={onOpenSource} />
      </div>
    );
  }
  if (!steps.length) return null;
  return (
    <div className="chat-steps">
      <button type="button" className="chat-steps__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="i i-sm" aria-hidden /> : <ChevronRight className="i i-sm" aria-hidden />}
        <span className="truncate">{summary(steps, files) || "Cách tìm ra câu trả lời này"}</span>
      </button>
      {open ? <Flow steps={steps} live={null} cited={cited} answered={answered} onOpenSource={onOpenSource} /> : null}
    </div>
  );
}

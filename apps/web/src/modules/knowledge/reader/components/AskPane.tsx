"use client";

import { Button } from "@heroui/react";
import { ArrowRight, MessageSquare, RotateCcw, Sparkles } from "lucide-react";

import { Callout } from "@/components/ui/Callout";
import { resourceId } from "@/lib/api/client";
import type { AnswerSource, Turn } from "@/modules/chat/turn";
import { AnswerMarkdown } from "@/modules/chat/components/AnswerMarkdown";

import { clip } from "../../model";

/** Suggested questions per resource type (preview `PROMPTS`). */
const GUIDE = ["What are the key steps?", "What are the deadlines?", "Summarize this"];
const PAPER = ["What’s the method and main result?", "What are the limitations?", "Summarize this"];
const PROCEDURE = ["What do I need to do?", "What are the deadlines?", "Summarize this"];
const LECTURE = ["Explain the key idea simply", "Give me 3 practice questions", "Summarize this"];
const PROMPTS: Readonly<Record<string, readonly string[]>> = {
  policy: ["What are the deadlines?", "Who does this apply to?", "What do I need to do?", "Summarize this"],
  procedure: PROCEDURE,
  form: ["What do I need to do?", "Summarize this"],
  calendar: ["What are the key dates?", "Summarize this"],
  announcement: ["What do I need to do?", "What are the deadlines?", "Summarize this"],
  guide: GUIDE,
  lecture: LECTURE,
  syllabus: ["How is the course assessed?", "What are the learning outcomes?", "Summarize this"],
  lab: ["What do I need to prepare?", "What are the safety rules?", "Summarize this"],
  paper: PAPER,
  dataset: ["What’s in the dataset?", "How can I use it?", "Summarize this"],
  handbook: GUIDE,
  thesis: PAPER,
  report: PAPER,
  protocol: PROCEDURE,
  exam: LECTURE,
  assignment: PROCEDURE,
};
const DEFAULT_PROMPTS = ["Summarize this", "What do I need to do?"];

/** One question and its streamed answer. `turn` is absent until the reply starts. */
export interface AskTurn {
  id: number;
  q: string;
  turn?: Turn;
  /** The request was refused before streaming (e.g. the assistant is unreachable). */
  error?: string;
}

export interface AskPaneProps {
  kind: string;
  itemName: string;
  thread: readonly AskTurn[];
  onAsk: (q: string) => void;
  onRetry: (turn: AskTurn) => void;
  /** A cited passage of this document: highlight it. */
  onShowPassages: (passages: string[]) => void;
  /** A citation of another document: open it. */
  onOpenSource: (source: AnswerSource) => void;
  onContinue: () => void;
  onClear: () => void;
}

const pending = (t: AskTurn) => !t.error && (!t.turn || t.turn.status === "streaming");

/** Ask tab (preview `askPane`): suggested questions, then the in-place thread answered from this document. */
export function AskPane({ kind, itemName, thread, onAsk, onRetry, onShowPassages, onOpenSource, onContinue, onClear }: AskPaneProps) {
  if (!thread.length) {
    return (
      <div className="rdr-ask-empty">
        <div className="rdr-ask-empty__title">
          <Sparkles className="i i-sm" aria-hidden />
          Ask about this document
        </div>
        <div className="rdr-prompts">
          {(PROMPTS[kind] ?? DEFAULT_PROMPTS).map((p) => (
            <button key={p} type="button" className="rdr-prompt" onClick={() => onAsk(p)}>
              <span>{p}</span>
              <ArrowRight className="i i-xs" aria-hidden />
            </button>
          ))}
        </div>
      </div>
    );
  }
  const done = !thread.some(pending);
  return (
    <div className="rdr-thread" aria-live="polite">
      {thread.map((t) => (
        <div key={t.id} className="rdr-turn">
          <div className="rdr-q" translate="no">
            {t.q}
          </div>
          <Answer t={t} itemName={itemName} onRetry={onRetry} onShowPassages={onShowPassages} onOpenSource={onOpenSource} />
        </div>
      ))}
      {done ? (
        <div className="rdr-ask-foot">
          <Button size="sm" variant="secondary" onPress={onContinue}>
            <MessageSquare className="i" aria-hidden />
            Continue in chat
          </Button>
          <Button size="sm" variant="ghost" onPress={onClear}>
            Clear
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Answer({ t, itemName, onRetry, onShowPassages, onOpenSource }: { t: AskTurn } & Pick<AskPaneProps, "itemName" | "onRetry" | "onShowPassages" | "onOpenSource">) {
  const turn = t.turn;
  const failed = t.error !== undefined || turn?.status === "failed" || turn?.status === "interrupted";
  if (!turn?.text && !failed) {
    return (
      <div className="rdr-typing" role="status">
        <span className="rdr-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        Reading the document…
      </div>
    );
  }
  const own = (turn?.sources ?? []).filter((s) => s.available && resourceId(s.item) === resourceId(itemName));
  const cite = (n: number) => {
    const source = turn?.sources.find((s) => s.n === n || s.aliases?.includes(n));
    if (!source?.available) return;
    if (resourceId(source.item) === resourceId(itemName)) onShowPassages(source.passages.map((p) => p.passage));
    else onOpenSource(source);
  };
  return (
    <div className="rdr-a">
      {turn?.text ? <AnswerMarkdown text={turn.text} sources={turn.sources} streaming={turn.status === "streaming"} onCite={cite} className="chat-answer rdr-a__lead" /> : null}
      {turn?.status === "completed" && own.length ? (
        <div className="rdr-quotes">
          {own.flatMap((s) =>
            s.passages.map((p) => (
              <button key={p.passage} type="button" className="rdr-quote" onClick={() => onShowPassages([p.passage])}>
                <span className="rdr-quote__n">{s.n}</span>
                <span className="rdr-quote__body">
                  {p.excerpt ? (
                    <span className="rdr-quote__text" translate="no">
                      “{clip(p.excerpt, 280)}”
                    </span>
                  ) : null}
                  <span className="rdr-quote__meta">{p.page ? `Page ${p.page}` : "Show passage"}</span>
                </span>
              </button>
            )),
          )}
        </div>
      ) : null}
      {failed ? (
        <Callout
          tone="danger"
          title="The answer stopped before it finished"
          description={t.error || turn?.error || "Retry to get the full answer."}
          actions={
            <Button size="sm" variant="secondary" onPress={() => onRetry(t)}>
              <RotateCcw className="i" aria-hidden />
              Retry
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

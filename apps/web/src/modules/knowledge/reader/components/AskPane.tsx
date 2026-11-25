"use client";

import { Button } from "@heroui/react";
import { ArrowRight, MessageSquare, RotateCcw } from "lucide-react";
import dynamic from "next/dynamic";

import { Callout } from "@/components/ui/Callout";
import { resourceId } from "@/lib/api/client";
import type { AnswerSource, Turn } from "@/modules/chat/turn";

import { locationLabel, type Reference } from "../../content/reference";
import { clip } from "../../model";

/** The markdown + math stack loads with the first answer, not with the reader. */
const AnswerMarkdown = dynamic(() => import("@/modules/chat/components/AnswerMarkdown").then((m) => m.AnswerMarkdown), { ssr: false });

/** Suggested questions (a document type is its file class, which says nothing about what to ask). */
const PROMPTS = ["Tóm tắt nội dung này", "Tôi cần làm gì?"];

/** One question and its streamed answer. `turn` is absent until the reply starts. */
export interface AskTurn {
  id: number;
  q: string;
  turn?: Turn;
  /** The request was refused before streaming (e.g. the assistant is unreachable). */
  error?: string;
}

export interface AskPaneProps {
  itemName: string;
  thread: readonly AskTurn[];
  onAsk: (q: string) => void;
  onRetry: (turn: AskTurn) => void;
  /** A cited reference of this document: highlight its blocks. */
  onShowReference: (reference: Reference) => void;
  /** A citation of another document: open it. */
  onOpenSource: (source: AnswerSource) => void;
  onContinue: () => void;
  onClear: () => void;
}

const pending = (t: AskTurn) => !t.error && (!t.turn || t.turn.status === "streaming");

/** Ask tab (preview `askPane`): suggested questions, then the in-place thread answered from this document. */
export function AskPane({ itemName, thread, onAsk, onRetry, onShowReference, onOpenSource, onContinue, onClear }: AskPaneProps) {
  if (!thread.length) {
    return (
      <div className="rdr-ask-empty">
        <div className="rdr-ask-empty__title">Thử hỏi</div>
        <div className="rdr-prompts">
          {PROMPTS.map((p) => (
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
          <Answer t={t} itemName={itemName} onRetry={onRetry} onShowReference={onShowReference} onOpenSource={onOpenSource} />
        </div>
      ))}
      {done ? (
        <div className="rdr-ask-foot">
          <Button size="sm" variant="tertiary" onPress={onContinue}>
            <MessageSquare className="i" aria-hidden />
            Tiếp tục trò chuyện
          </Button>
          <Button size="sm" variant="ghost" onPress={onClear}>
            Xóa
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Answer({ t, itemName, onRetry, onShowReference, onOpenSource }: { t: AskTurn } & Pick<AskPaneProps, "itemName" | "onRetry" | "onShowReference" | "onOpenSource">) {
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
        Đang đọc tài liệu…
      </div>
    );
  }
  const own = (turn?.sources ?? []).filter((s) => s.available && resourceId(s.item) === resourceId(itemName));
  const cite = (n: number) => {
    const source = turn?.sources.find((s) => s.n === n || s.aliases?.includes(n));
    if (!source?.available) return;
    const reference = source.references[0];
    if (resourceId(source.item) === resourceId(itemName) && reference) onShowReference(reference);
    else onOpenSource(source);
  };
  return (
    <div className="rdr-a">
      {turn?.text ? <AnswerMarkdown text={turn.text} sources={turn.sources} streaming={turn.status === "streaming"} onCite={cite} className="chat-answer rdr-a__lead" /> : null}
      {turn?.status === "completed" && own.length ? (
        <div className="rdr-quotes">
          {own.flatMap((s) =>
            s.references.map((reference) => (
              <button key={`${reference.structureVersion}:${reference.refs.join(",")}`} type="button" className="rdr-quote" onClick={() => onShowReference(reference)}>
                <span className="rdr-quote__n">{s.n}</span>
                <span className="rdr-quote__body">
                  {reference.quote ? (
                    <span className="rdr-quote__text" translate="no">
                      “{clip(reference.quote, 280)}”
                    </span>
                  ) : null}
                  <span className="rdr-quote__meta">{locationLabel(reference) || "Xem đoạn trích"}</span>
                </span>
              </button>
            )),
          )}
        </div>
      ) : null}
      {failed ? (
        <Callout
          tone="danger"
          title="Câu trả lời đã dừng trước khi hoàn tất"
          description={t.error || turn?.error || "Hãy thử lại để nhận câu trả lời đầy đủ."}
          actions={
            <Button size="sm" variant="tertiary" onPress={() => onRetry(t)}>
              <RotateCcw className="i" aria-hidden />
              Thử lại
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

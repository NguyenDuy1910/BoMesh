/**
 * The thread as rows: stored messages (ListMessages, active turns only) with
 * the live turn laid over them. A live retry/edit hides the question it
 * replaces and everything after it until the server's copy arrives.
 */

import type { Message } from "./api";
import { sourcesFromCitations } from "./citations";
import { attemptsBefore, filesOfAnswer, workOfAnswer, type AnswerAttempt, type LiveTurn, type SentFile } from "./runtime";
import type { AnswerSource, WorkStep } from "./turn";

export type AnswerState = "streaming" | "COMPLETED" | "INTERRUPTED" | "FAILED";

export interface AnswerView {
  /** Row key / DOM id suffix: the message ID, or `live`. */
  key: string;
  /** Assistant message name, once known. */
  message?: string;
  /** The question's message name (for retry), when stored. */
  question?: string;
  questionText: string;
  text: string;
  sources: AnswerSource[];
  artifacts: string[];
  steps: WorkStep[];
  state: AnswerState;
  error?: string;
  /** The request was refused before a turn was stored. */
  refused?: boolean;
  rating?: "HELPFUL" | "UNHELPFUL";
  reason?: string;
  startedAt?: number;
  finishedAt?: number;
  /** Earlier attempts (variants), oldest first. */
  earlier: AnswerAttempt[];
  /** Files attached to the question, when known. */
  files: SentFile[];
}

export type ThreadRow =
  | { kind: "user"; key: string; message?: string; text: string; files: SentFile[] }
  | { kind: "answer"; answer: AnswerView }
  /** A stored question with no answer (stopped before the reply began, or the tab closed). */
  | { kind: "unanswered"; key: string; question: string; text: string };

const idOf = (name?: string) => name?.slice(name.lastIndexOf("/") + 1) ?? "";

/** What Retry → More detail / Shorter adds to the question it resends (preview `m.mod`). */
export const RETRY_MODIFIER = { detail: "\n\nMore detail, please.", shorter: "\n\nShorter, please." } as const;

/** The question as the person asked it: retry modifiers are neither shown nor stacked. */
export function questionOf(text: string): string {
  let out = text;
  for (;;) {
    const suffix = Object.values(RETRY_MODIFIER).find((s) => out.endsWith(s));
    if (!suffix) return out;
    out = out.slice(0, -suffix.length);
  }
}

export function storedAnswer(m: Message, question: Message | undefined): AnswerView {
  const text = m.text ?? "";
  const work = workOfAnswer(m.name);
  return {
    key: idOf(m.name),
    message: m.name,
    question: question?.name,
    questionText: questionOf(question?.text ?? ""),
    text,
    sources: sourcesFromCitations(text, m.citations ?? []),
    artifacts: m.artifacts ?? [],
    steps: work?.steps ?? [],
    state: m.state ?? "COMPLETED",
    rating: m.feedback?.rating,
    reason: m.feedback?.reason || m.feedback?.comment,
    startedAt: work?.startedAt,
    finishedAt: work?.finishedAt,
    earlier: attemptsBefore(m.name),
    files: filesOfAnswer(m.name),
  };
}

export function liveAnswer(live: LiveTurn, question: Message | undefined): AnswerView {
  const t = live.turn;
  return {
    key: "live",
    message: t.message,
    question: question?.name,
    questionText: questionOf(live.question),
    text: t.text,
    sources: t.sources,
    artifacts: t.artifacts,
    steps: t.steps,
    state: t.status === "streaming" ? "streaming" : t.status === "completed" ? "COMPLETED" : t.status === "interrupted" ? "INTERRUPTED" : "FAILED",
    error: t.error,
    refused: live.refused,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    earlier: live.earlier,
    files: live.files,
  };
}

export function buildThread(messages: readonly Message[], live: LiveTurn | undefined): ThreadRow[] {
  let stored = [...messages];
  if (live?.replaceFrom) {
    const cut = stored.findIndex((m) => m.name === live.replaceFrom);
    if (cut >= 0) stored = stored.slice(0, cut);
  } else if (live) {
    // The server stores the turn as it starts; a refetch mid-stream must not show it twice.
    if (live.turn.message && stored.at(-1)?.name === live.turn.message) stored = stored.slice(0, -1);
    const last = stored.at(-1);
    if (last?.role === "USER" && (last.text ?? "") === live.question) stored = stored.slice(0, -1);
  }
  const rows: ThreadRow[] = [];
  stored.forEach((m, i) => {
    if (m.role === "USER") {
      const next = stored[i + 1];
      const answered = next?.role === "ASSISTANT";
      rows.push({ kind: "user", key: idOf(m.name), message: m.name, text: questionOf(m.text ?? ""), files: answered ? filesOfAnswer(next!.name) : [] });
      if (!answered && !(live && i === stored.length - 1)) rows.push({ kind: "unanswered", key: `${idOf(m.name)}-open`, question: m.name ?? "", text: m.text ?? "" });
    } else {
      const prev = stored[i - 1];
      rows.push({ kind: "answer", answer: storedAnswer(m, prev?.role === "USER" ? prev : undefined) });
    }
  });
  if (live) {
    rows.push({ kind: "user", key: "live-q", message: live.replaceFrom, text: questionOf(live.question), files: live.files });
    rows.push({ kind: "answer", answer: liveAnswer(live, live.replaceFrom ? messages.find((m) => m.name === live.replaceFrom) : undefined) });
  }
  return rows;
}

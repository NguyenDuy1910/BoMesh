"use client";

/**
 * The chat runtime: live answers outlive the page that started them
 * (conversation_loop.md "An answer keeps streaming across pages"). One answer
 * streams at a time, workspace-wide, like the preview. When it settles the
 * conversation's messages are refetched and the live copy is released, so
 * the thread then shows the server's stored turn.
 *
 * Retry keeps earlier attempts as variants (‹ 1/2 ›) in this session: the
 * server supersedes them, so only the client remembers them.
 */

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { errorMessage } from "@/lib/api/client";
import type { ComposerFile } from "@/modules/artifacts";

import { chatKeys, converse, type ConverseRequest, type Message } from "./api";
import { emptyTurn, endTurn, type AnswerSource, type Turn, type WorkStep } from "./turn.ts";

/** What a composer attached, for the optimistic question bubble (a ChatFiles `ChipFile`). */
export interface SentFile {
  name: string;
  /** Item name, when the file is a knowledge document. */
  item?: string;
  mime?: string;
  kind?: "upload" | "ref";
}

/** The composer's settled files as sent chips (failed uploads are not sent). */
export function sentFiles(files: readonly ComposerFile[]): SentFile[] {
  return files.filter((f) => f.ready && f.item).map(({ name, item, mime, kind }) => ({ name, item, mime, kind }));
}

export interface LiveTurn {
  workspace: string;
  conversation: string;
  question: string;
  files: SentFile[];
  /** The user message this turn supersedes (retry / edit); it and later messages are hidden while live. */
  replaceFrom?: string;
  /** Earlier attempts of the answer being retried. */
  earlier: AnswerAttempt[];
  turn: Turn;
  /** The request was refused before any turn was stored: the live copy stays to show the error. */
  refused?: boolean;
}

/** One attempt at an answer, kept for the variant pager. */
export interface AnswerAttempt {
  message?: string;
  text: string;
  sources: AnswerSource[];
  artifacts: string[];
  state: "COMPLETED" | "INTERRUPTED" | "FAILED";
  rating?: "HELPFUL" | "UNHELPFUL";
}

const live = new Map<string, LiveTurn>();
const controllers = new Map<string, AbortController>();
/** Earlier attempts by the name of the answer that replaced them. */
const variants = new Map<string, AnswerAttempt[]>();
const listeners = new Set<() => void>();
let version = 0;
let frame: number | null = null;

function emit() {
  version += 1;
  for (const l of listeners) l();
}

/** Coalesce stream updates to one render per frame. */
function emitSoon() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    emit();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function useLiveTurn(conversation: string | undefined): LiveTurn | undefined {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return conversation ? live.get(conversation) : undefined;
}

/** The conversation whose answer is streaming right now, if any. */
export function useStreamingConversation(): string | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return streamingConversation();
}

export function streamingConversation(): string | null {
  for (const [id, entry] of live) if (entry.turn.status === "streaming") return id;
  return null;
}

export function attemptsBefore(answer: string | undefined): AnswerAttempt[] {
  return (answer && variants.get(answer)) || [];
}

/**
 * What was attached to the question an answer replies to, by answer name.
 * `Message` carries no attachments, so this is known only for turns sent in
 * this session (retry re-sends them).
 */
const answerFiles = new Map<string, SentFile[]>();

export function filesOfAnswer(answer: string | undefined): SentFile[] {
  return (answer && answerFiles.get(answer)) || [];
}

/** How an answer was found (`Message` carries no steps either): known for turns streamed in this session. */
export interface AnswerWork {
  steps: WorkStep[];
  startedAt: number;
  finishedAt?: number;
}
const answerWork = new Map<string, AnswerWork>();

export function workOfAnswer(answer: string | undefined): AnswerWork | undefined {
  return answer ? answerWork.get(answer) : undefined;
}

export interface SendTurn extends ConverseRequest {
  workspace: string;
  conversation: string;
  files?: SentFile[];
  /** Attempts to keep as variants of the answer this turn replaces. */
  earlier?: AnswerAttempt[];
}

/**
 * Stream one turn. Returns false (and sends nothing) while another answer is
 * still being written.
 */
export function sendTurn(queryClient: QueryClient, input: SendTurn): boolean {
  if (streamingConversation()) return false;
  const { workspace, conversation, files = [], earlier = [], ...request } = input;
  const controller = new AbortController();
  controllers.set(conversation, controller);
  const entry: LiveTurn = { workspace, conversation, question: request.message, files, replaceFrom: request.replaceFromMessage, earlier, turn: emptyTurn() };
  const lastBefore = queryClient.getQueryData<Message[]>(chatKeys.messages(workspace, conversation))?.at(-1)?.name;
  live.set(conversation, entry);
  emit();

  const update = (turn: Turn) => {
    if (live.get(conversation) !== entry) return;
    // After Stop, late frames must not reopen the turn.
    if (entry.turn.status !== "streaming" && turn.status === "streaming") return;
    entry.turn = entry.turn.status === "interrupted" && turn.status !== "completed" ? { ...turn, status: "interrupted", error: undefined } : turn;
    emitSoon();
  };

  void converse(workspace, conversation, request, { signal: controller.signal, onTurn: update })
    .then(async (turn) => {
      update(turn);
      if (turn.message && earlier.length) variants.set(turn.message, earlier);
      if (turn.message && files.length) answerFiles.set(turn.message, files);
      if (turn.message && turn.steps.length) answerWork.set(turn.message, { steps: turn.steps, startedAt: turn.startedAt, finishedAt: turn.finishedAt });
      // The turn is stored (whatever its state): show the server's copy.
      await queryClient.invalidateQueries({ queryKey: chatKeys.messages(workspace, conversation) });
      void queryClient.invalidateQueries({ queryKey: chatKeys.conversations(workspace), refetchType: "active" });
      if (live.get(conversation) === entry) live.delete(conversation);
    })
    .catch(async (error: unknown) => {
      if (controller.signal.aborted) {
        // Stopped before the reply began: whatever the server stored is the truth. It may store
        // the turn a moment after the abort, so the stopped question stays until it shows up.
        for (const delay of [0, 1500, 3000]) {
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          await queryClient.invalidateQueries({ queryKey: chatKeys.messages(workspace, conversation) });
          const last = queryClient.getQueryData<Message[]>(chatKeys.messages(workspace, conversation))?.at(-1);
          if (last?.role === "ASSISTANT" && last.name !== lastBefore) break;
        }
        if (live.get(conversation) === entry) live.delete(conversation);
        return;
      }
      // Refused before streaming: nothing was stored; keep the question with the error.
      entry.refused = true;
      entry.turn = endTurn(entry.turn, "failed", errorMessage(error));
    })
    .finally(() => {
      if (controllers.get(conversation) === controller) controllers.delete(conversation);
      emit();
    });
  return true;
}

/** Stop the streaming answer; the server keeps it as INTERRUPTED. Settles at once, so another turn may start. */
export function stopTurn(conversation: string) {
  const entry = live.get(conversation);
  if (entry) entry.turn = endTurn(entry.turn, "interrupted");
  controllers.get(conversation)?.abort();
  emit();
}

/** Drop a refused turn's leftover (after Retry or when a new question replaces it). */
export function dismissTurn(conversation: string) {
  const entry = live.get(conversation);
  if (entry && entry.turn.status !== "streaming") {
    live.delete(conversation);
    emit();
  }
}

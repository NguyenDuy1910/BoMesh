/**
 * Assistant API (`openapi.yaml` tag Assistant, conversation_loop.md):
 * conversations, messages, feedback, the workspace assistant settings
 * and the `:converse` SSE stream. Path params are bare IDs; bodies carry full
 * resource names.
 */

import { api, call, rawFetch, requestId, type Schema } from "@/lib/api/client";

import { SseDecoder, parseFrame, type SseFrame } from "./sse.ts";
import { StreamEventDeduplicator } from "./stream-deduplicator.ts";
import { emptyTurn, endTurn, isTerminalEvent, reduceTurn, type StreamEvent, type Turn } from "./turn.ts";

export type Conversation = Schema<"Conversation">;
export type Message = Schema<"Message">;
export type Assistant = Schema<"WorkspaceAssistant">;
export type ConversationScope = Schema<"ConversationScope">;
export type FeedbackRating = Schema<"SubmitMessageFeedbackRequest">["rating"];

/** Query keys; every key starts with the workspace ID (Projects' sidebar shares the `conversations` prefix). */
export const chatKeys = {
  conversations: (ws: string) => [ws, "conversations"] as const,
  conversation: (ws: string, id: string) => [ws, "conversations", "one", id] as const,
  messages: (ws: string, id: string) => [ws, "conversations", "messages", id] as const,
  assistant: (ws: string) => [ws, "assistant"] as const,
};

export function getAssistant(workspace: string): Promise<Assistant> {
  return call(api.GET("/api/v1/workspaces/{workspace}/assistant", { params: { path: { workspace } } }));
}

/** Matches the share picker reads: it shows five, after leaving out you and the people already added. */
const MEMBER_CANDIDATES = 10;

/** Active members whose name or email contains `q` (ListMembers, case-insensitive), by name. */
export async function listMemberCandidates(workspace: string, q: string): Promise<Schema<"Member">[]> {
  const term = JSON.stringify(`*${q}*`);
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/members", {
      params: { path: { workspace }, query: { filter: `state = ACTIVE AND (displayName = ${term} OR email = ${term})`, orderBy: "displayName", pageSize: MEMBER_CANDIDATES } },
    }),
  );
  return page.members ?? [];
}

/* ═══════════════ Conversations ═══════════════ */

export function createConversation(workspace: string, body: { displayName?: string; scope?: ConversationScope }): Promise<Conversation> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conversations", {
      params: { path: { workspace }, query: { requestId: requestId() } },
      body,
    }),
  );
}

export function getConversation(workspace: string, conversation: string): Promise<Conversation> {
  return call(api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}", { params: { path: { workspace, conversation } } }));
}

export function updateConversation(workspace: string, conversation: string, patch: Conversation, updateMask: readonly string[]): Promise<Conversation> {
  return call(
    api.PATCH("/api/v1/workspaces/{workspace}/conversations/{conversation}", {
      params: { path: { workspace, conversation }, query: { updateMask: updateMask.join(",") } },
      body: patch,
    }),
  );
}

export function deleteConversation(workspace: string, conversation: string): Promise<Conversation> {
  return call(api.DELETE("/api/v1/workspaces/{workspace}/conversations/{conversation}", { params: { path: { workspace, conversation } } }));
}

export function undeleteConversation(workspace: string, conversation: string): Promise<Conversation> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conversations/{conversation}:undelete", {
      params: { path: { workspace, conversation } },
      body: {},
    }),
  );
}

/* ═══════════════ Messages ═══════════════ */

/** How many messages a thread shows: the newest page (100 turns); the thread has no control to load older ones. */
const THREAD_MESSAGES = 200;

/** The conversation's newest {@link THREAD_MESSAGES} messages (one ListMessages page), in conversation order. */
export async function listMessages(workspace: string, conversation: string): Promise<Message[]> {
  const page = await call(
    api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}/messages", {
      params: { path: { workspace, conversation }, query: { pageSize: THREAD_MESSAGES, orderBy: "createTime desc" } },
    }),
  );
  return (page.messages ?? []).reverse();
}

export function submitFeedback(
  workspace: string,
  conversation: string,
  message: string,
  body: { rating: FeedbackRating; reason?: string; comment?: string },
): Promise<Message> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conversations/{conversation}/messages/{message}:submitFeedback", {
      params: { path: { workspace, conversation, message } },
      body,
    }),
  );
}

/* ═══════════════ Converse (SSE) ═══════════════ */

export interface ConverseRequest {
  message: string;
  /** DOCUMENT item names. */
  attachments?: string[];
  /** A user message name: it and every later message are superseded by this turn. */
  replaceFromMessage?: string;
}

export interface ConverseOptions {
  signal?: AbortSignal;
  /** The folded turn after every event. */
  onTurn?: (turn: Turn) => void;
}

/**
 * Send one turn and stream the reply. Resolves with the settled turn: aborting
 * (Stop) resolves it `interrupted` — the server stores the partial answer as
 * INTERRUPTED. Throws `ApiError` when the request is refused before streaming.
 */
export async function converse(workspace: string, conversation: string, request: ConverseRequest, options: ConverseOptions = {}): Promise<Turn> {
  const { signal, onTurn } = options;
  const response = await rawFetch(`/api/v1/workspaces/${workspace}/conversations/${conversation}:converse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(request),
    signal,
  });
  let turn = emptyTurn();
  onTurn?.(turn);
  if (!response.body) return endTurn(turn, "failed", "Câu trả lời đã dừng trước khi hoàn tất.");

  const reader = response.body.getReader();
  const decoder = new SseDecoder();
  const dedup = new StreamEventDeduplicator();
  const apply = (frames: SseFrame[]) => {
    for (const frame of frames) {
      const event = parseFrame<StreamEvent & { sequence_number?: number }>(frame);
      if (!event || !dedup.shouldAccept(event)) continue;
      turn = reduceTurn(turn, event);
      if (isTerminalEvent(event)) break;
    }
    onTurn?.(turn);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        apply(decoder.end());
        break;
      }
      apply(decoder.push(value));
      if (turn.status !== "streaming") {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    turn = signal?.aborted
      ? endTurn(turn, "interrupted")
      : endTurn(turn, "failed", error instanceof Error && error.message ? error.message : "Kết nối bị đóng trước khi câu trả lời hoàn tất.");
    onTurn?.(turn);
    return turn;
  }
  if (turn.status === "streaming") {
    turn = endTurn(turn, signal?.aborted ? "interrupted" : "failed", signal?.aborted ? undefined : "Kết nối bị đóng trước khi câu trả lời hoàn tất.");
    onTurn?.(turn);
  }
  return turn;
}

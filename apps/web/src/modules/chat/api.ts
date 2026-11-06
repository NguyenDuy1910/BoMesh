/**
 * Assistant API (`openapi.yaml` tag Assistant, conversation_loop.md):
 * conversations, messages, feedback, shares, the workspace assistant settings
 * and the `:converse` SSE stream. Path params are bare IDs; bodies carry full
 * resource names.
 */

import { api, call, listAll, rawFetch, requestId, type Schema } from "@/lib/api/client";

import { SseDecoder, parseFrame, type SseFrame } from "./sse.ts";
import { StreamEventDeduplicator } from "./stream-deduplicator.ts";
import { emptyTurn, endTurn, isTerminalEvent, reduceTurn, type StreamEvent, type Turn } from "./turn.ts";

export type Conversation = Schema<"Conversation">;
export type Message = Schema<"Message">;
export type Share = Schema<"Share">;
export type Assistant = Schema<"WorkspaceAssistant">;
export type ConversationScope = Schema<"ConversationScope">;
export type FeedbackRating = Schema<"SubmitMessageFeedbackRequest">["rating"];

/** Query keys; every key starts with the workspace ID (Projects' sidebar shares the `conversations` prefix). */
export const chatKeys = {
  conversations: (ws: string) => [ws, "conversations"] as const,
  conversation: (ws: string, id: string) => [ws, "conversations", "one", id] as const,
  messages: (ws: string, id: string) => [ws, "conversations", "messages", id] as const,
  shares: (ws: string, id: string) => [ws, "conversations", "shares", id] as const,
  share: (ws: string, id: string, share: string) => [ws, "conversations", "shares", id, share] as const,
  assistant: (ws: string) => [ws, "assistant"] as const,
};

export function getAssistant(workspace: string): Promise<Assistant> {
  return call(api.GET("/api/v1/workspaces/{workspace}/assistant", { params: { path: { workspace } } }));
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

export function listMessages(workspace: string, conversation: string): Promise<Message[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}/messages", {
          params: { path: { workspace, conversation }, query: { pageSize: 200, pageToken } },
        }),
      ),
    (page) => page.messages,
  );
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

/* ═══════════════ Shares ═══════════════ */

export function listShares(workspace: string, conversation: string): Promise<Share[]> {
  return listAll(
    (pageToken) =>
      call(
        api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}/shares", {
          params: { path: { workspace, conversation }, query: { pageToken } },
        }),
      ),
    (page) => page.shares,
  );
}

/** One live share per conversation: creating revokes the previous one. */
export function createShare(workspace: string, conversation: string, body: { audience: Share["audience"]; recipients?: string[] }): Promise<Share> {
  return call(
    api.POST("/api/v1/workspaces/{workspace}/conversations/{conversation}/shares", {
      params: { path: { workspace, conversation }, query: { requestId: requestId() } },
      body,
    }),
  );
}

/** GetShare: the snapshot as the caller may read it (withheld turns and citations are `available: false`). */
export function getShare(workspace: string, conversation: string, share: string): Promise<Share> {
  return call(api.GET("/api/v1/workspaces/{workspace}/conversations/{conversation}/shares/{share}", { params: { path: { workspace, conversation, share } } }));
}

/** The web address of a share (`/chat/<c>/shares/<s>`), from its resource name. */
export function shareHref(share: Pick<Share, "name">): string {
  const [, , , conversation, , id] = (share.name ?? "").split("/");
  return `/chat/${conversation}/shares/${id}`;
}

export async function deleteShare(workspace: string, conversation: string, share: string): Promise<void> {
  await call(api.DELETE("/api/v1/workspaces/{workspace}/conversations/{conversation}/shares/{share}", { params: { path: { workspace, conversation, share } } }));
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
  if (!response.body) return endTurn(turn, "failed", "The answer stopped before it finished.");

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
      : endTurn(turn, "failed", error instanceof Error && error.message ? error.message : "The connection closed before the answer finished.");
    onTurn?.(turn);
    return turn;
  }
  if (turn.status === "streaming") {
    turn = endTurn(turn, signal?.aborted ? "interrupted" : "failed", signal?.aborted ? undefined : "The connection closed before the answer finished.");
    onTurn?.(turn);
  }
  return turn;
}

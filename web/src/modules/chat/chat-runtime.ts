"use client";

import { getApiConfiguration } from "@/lib/api/config";
import { releaseConversationDocument, streamAgentResponse, type SharedConversation } from "./api";
import { CHAT_LIMITS } from "./attachments";
import {
  editTruncation,
  historyFromMessages,
  regenerationContext,
  retryRequest,
  type RetryMode,
} from "./conversation-history";
import {
  cachedToUIMessage,
  conversationAdapter,
  conversationPreview,
  getMessageText,
  setConversationUser,
  subscribeToConversations,
  titleFromMessage,
  uiToCachedMessage,
} from "./conversations";
import { applyResponseStreamEvent, emptyTurnState, failTurn } from "./message-stream";
import { DOCUMENT_CITATION_TYPE } from "./types";
import type {
  AnswerFeedback,
  ChatConversation,
  ChatMessage,
  ChatMessagePart,
  ConversationCollection,
  ConversationDocument,
  TurnState,
} from "./types";
import { beginAttempt, selectVariant, settleAttempt } from "./variants";

/**
 * The client chat runtime: every open thread's messages and its one live
 * answer, kept outside React so an answer keeps streaming while the reader
 * moves between pages, and so the home page can start a chat that the thread
 * page then shows. Threads persist to the device-local conversation store.
 */

export type ThreadStatus = "loading" | "ready" | "missing" | "error";

export interface ThreadSnapshot {
  conversationId: string;
  status: ThreadStatus;
  conversation: ChatConversation | null;
  messages: ChatMessage[];
  /** The assistant message streaming now, if any. */
  streamingId: string | null;
}

export const STOPPED_MESSAGE = "Response stopped.";
const INTERRUPTED_MESSAGE = "The answer was interrupted before it finished.";

const threads = new Map<string, ThreadSnapshot>();
const loadingSnapshots = new Map<string, ThreadSnapshot>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let namespace: string | null = null;
let storeSubscription: (() => void) | null = null;

function notify() {
  for (const listener of listeners) listener();
}

/**
 * Point the local store at the signed-in account and active workspace. A
 * different account or workspace drops every thread held in memory, so one
 * workspace's chats never show in another. Returns whether a caller exists.
 */
export function bindConversationUser(): boolean {
  const configuration = getApiConfiguration();
  setConversationUser(configuration?.userId, configuration?.tenantId);
  const next = `${configuration?.userId ?? ""}:${configuration?.tenantId ?? ""}`.toLowerCase();
  if (namespace !== null && namespace !== next) {
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    threads.clear();
    loadingSnapshots.clear();
    notify();
  }
  namespace = next;
  return Boolean(configuration);
}

export function subscribeThreads(listener: () => void): () => void {
  listeners.add(listener);
  storeSubscription ??= subscribeToConversations(() => void refreshConversationMeta());
  return () => {
    listeners.delete(listener);
  };
}

export function getThreadSnapshot(conversationId: string): ThreadSnapshot {
  const thread = threads.get(conversationId);
  if (thread) return thread;
  let loading = loadingSnapshots.get(conversationId);
  if (!loading) {
    loading = { conversationId, status: "loading", conversation: null, messages: [], streamingId: null };
    loadingSnapshots.set(conversationId, loading);
  }
  return loading;
}

function setThread(conversationId: string, next: ThreadSnapshot) {
  threads.set(conversationId, next);
  notify();
}

function updateThread(conversationId: string, update: (thread: ThreadSnapshot) => ThreadSnapshot) {
  const thread = threads.get(conversationId);
  if (!thread) return;
  setThread(conversationId, update(thread));
}

function updateMessage(conversationId: string, messageId: string, update: (message: ChatMessage) => ChatMessage) {
  updateThread(conversationId, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) => message.id === messageId ? update(message) : message),
  }));
}

/** Read a saved chat into memory. A thread already in memory is kept as is. */
export async function loadThread(conversationId: string, options: { force?: boolean } = {}): Promise<void> {
  bindConversationUser();
  const held = threads.get(conversationId);
  if (held && held.status === "ready" && !options.force) return;
  if (controllers.has(conversationId)) return;
  try {
    const conversation = await conversationAdapter.getConversation(conversationId);
    if (!conversation) {
      setThread(conversationId, { conversationId, status: "missing", conversation: null, messages: [], streamingId: null });
      return;
    }
    const stored = await conversationAdapter.getConversationMessages(conversationId);
    // A turn saved while it was still streaming did not finish: the page was
    // closed or reloaded. It reads as interrupted, never as still running.
    const messages = stored.map(cachedToUIMessage).map((message) => (
      message.turn?.status === "streaming"
        ? { ...message, turn: failTurn(message.turn, INTERRUPTED_MESSAGE) }
        : message
    ));
    setThread(conversationId, { conversationId, status: "ready", conversation, messages, streamingId: null });
  } catch {
    setThread(conversationId, { conversationId, status: "error", conversation: null, messages: [], streamingId: null });
  }
}

/** Renames and scope changes made elsewhere show in an open thread. */
async function refreshConversationMeta() {
  for (const [conversationId, thread] of threads) {
    if (thread.status !== "ready") continue;
    const conversation = await conversationAdapter.getConversation(conversationId);
    if (!conversation) {
      if (!controllers.has(conversationId)) {
        setThread(conversationId, { ...thread, status: "missing", conversation: null, messages: [] });
      }
      continue;
    }
    const current = thread.conversation;
    if (
      current?.title !== conversation.title
      || JSON.stringify(current?.scope ?? []) !== JSON.stringify(conversation.scope ?? [])
    ) {
      setThread(conversationId, { ...threads.get(conversationId)!, conversation });
    }
  }
}

/**
 * Save the thread. `touch` moves the chat to the top of the list; reading
 * actions (feedback, switching answer variants) leave it where it is.
 */
async function persistThread(conversationId: string, touch: boolean): Promise<void> {
  const thread = threads.get(conversationId);
  if (!thread || thread.status !== "ready") return;
  const firstUser = thread.messages.find((message) => message.role === "user");
  if (!firstUser) return;
  let conversation = await conversationAdapter.getConversation(conversationId);
  if (!conversation) {
    conversation = await conversationAdapter.createConversation(titleFromMessage(getMessageText(firstUser)), conversationId);
  }
  await conversationAdapter.saveConversationMessages(conversationId, thread.messages.map(uiToCachedMessage));
  const updated = await conversationAdapter.updateConversation(conversationId, {
    preview: conversationPreview(thread.messages),
    ...(conversation.titleSource === "custom" ? {} : { title: titleFromMessage(getMessageText(firstUser)) }),
    ...(touch ? {} : { updatedAt: conversation.updatedAt }),
  });
  if (updated && threads.get(conversationId)) {
    updateThread(conversationId, (current) => ({ ...current, conversation: updated }));
  }
}

function newId(prefix: string) {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function userMessage(text: string, documents: ConversationDocument[], collections: ConversationCollection[]): ChatMessage {
  return {
    id: newId("user"),
    role: "user",
    parts: [
      { type: "text", text, state: "done" },
      ...documents.map((document): ChatMessagePart => ({ type: "data-document", id: document.id, data: document })),
      ...collections.map((collection): ChatMessagePart => ({ type: "data-collection", id: collection.id, data: collection })),
    ],
  };
}

function freshTurn(id: string): TurnState {
  return { ...emptyTurnState(id), startedAt: Date.now() };
}

function readableError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : "";
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
  } catch {
    // Not a JSON body; the message is already prose.
  }
  return raw || "The answer couldn’t be completed.";
}

/** Run one answer request into `assistantId`, which must already be in the thread. */
async function runAnswer(
  conversationId: string,
  assistantId: string,
  request: {
    text: string;
    history: ChatMessage[];
    documents: ConversationDocument[];
    collections: ConversationCollection[];
  },
): Promise<void> {
  const controller = new AbortController();
  controllers.get(conversationId)?.abort();
  controllers.set(conversationId, controller);
  updateThread(conversationId, (thread) => ({ ...thread, streamingId: assistantId }));
  void persistThread(conversationId, true);

  try {
    await streamAgentResponse(request.text, {
      conversationId,
      history: historyFromMessages(request.history),
      attachmentIds: request.documents.map((document) => document.id),
      collectionItemIds: request.collections.map((collection) => collection.id),
      signal: controller.signal,
      onEvent: (event) => {
        if (controller.signal.aborted) return;
        updateThread(conversationId, (thread) => ({
          ...thread,
          messages: applyResponseStreamEvent(thread.messages, assistantId, event),
        }));
      },
    });
  } catch (cause) {
    if (!controller.signal.aborted) {
      updateMessage(conversationId, assistantId, (message) => ({
        ...message,
        turn: failTurn(message.turn ?? freshTurn(message.id), readableError(cause)),
      }));
    }
  } finally {
    if (controllers.get(conversationId) === controller) controllers.delete(conversationId);
    if (threads.get(conversationId)) {
      updateMessage(conversationId, assistantId, (message) => {
        const turn = message.turn ?? freshTurn(message.id);
        const settled = turn.status === "streaming" ? failTurn(turn, INTERRUPTED_MESSAGE) : turn;
        return settleAttempt({ ...message, turn: { ...settled, finishedAt: Date.now() } });
      });
      updateThread(conversationId, (thread) => ({
        ...thread,
        streamingId: thread.streamingId === assistantId ? null : thread.streamingId,
      }));
      void persistThread(conversationId, true);
    }
  }
}

export function isConversationStreaming(conversationId: string): boolean {
  return controllers.has(conversationId);
}

/**
 * Start a new chat from the home page: the chat is saved with its first
 * question at once (so it shows in recents) and the answer starts streaming.
 * Returns the new chat's id for navigation.
 */
export async function startConversation(input: {
  text: string;
  documents: ConversationDocument[];
  scope: ConversationCollection[];
}): Promise<string> {
  bindConversationUser();
  const conversationId = newId("conversation");
  const created = await conversationAdapter.createConversation(titleFromMessage(input.text), conversationId);
  const conversation = input.scope.length
    ? await conversationAdapter.updateConversation(conversationId, { scope: input.scope }) ?? created
    : created;
  setThread(conversationId, { conversationId, status: "ready", conversation, messages: [], streamingId: null });
  sendQuestion(conversationId, { text: input.text, documents: input.documents, collections: input.scope });
  return conversationId;
}

/** Ask a new question in an existing thread. */
export function sendQuestion(
  conversationId: string,
  input: { text: string; documents: ConversationDocument[]; collections: ConversationCollection[] },
): void {
  const thread = threads.get(conversationId);
  if (!thread || thread.status !== "ready" || controllers.has(conversationId)) return;
  const text = input.text.slice(0, CHAT_LIMITS.messageCharacters);
  const history = thread.messages;
  const assistantId = newId("assistant");
  setThread(conversationId, {
    ...thread,
    messages: [
      ...history,
      userMessage(text, input.documents, input.collections),
      { id: assistantId, role: "assistant", parts: [], turn: freshTurn(assistantId) },
    ],
  });
  void runAnswer(conversationId, assistantId, { text, history, documents: input.documents, collections: input.collections });
}

/**
 * Retry one answer. The earlier attempt stays as a variant; "Search all
 * knowledge" also clears the chat's knowledge-base scope.
 */
export function retryAnswer(conversationId: string, assistantId: string, mode: RetryMode): void {
  const thread = threads.get(conversationId);
  if (!thread || controllers.has(conversationId)) return;
  const request = retryRequest(thread.messages, assistantId, mode, CHAT_LIMITS.messageCharacters);
  const target = thread.messages.find((message) => message.id === assistantId);
  if (!request || !target) return;
  if (mode === "all_knowledge") void setConversationScope(conversationId, []);
  updateMessage(conversationId, assistantId, (message) => beginAttempt(message, freshTurn(message.id)));
  void runAnswer(conversationId, assistantId, {
    text: request.requestText,
    history: request.historyMessages,
    documents: request.documents,
    collections: request.collections,
  });
}

/** Answer a question that has none — the page closed before the request started. */
export function answerQuestion(conversationId: string, userMessageId: string): void {
  const thread = threads.get(conversationId);
  if (!thread || controllers.has(conversationId)) return;
  const index = thread.messages.findIndex((message) => message.id === userMessageId);
  const context = regenerationContext(thread.messages.slice(0, index + 1));
  if (index < 0 || !context) return;
  const assistantId = newId("assistant");
  setThread(conversationId, {
    ...thread,
    messages: [
      ...thread.messages.slice(0, index + 1),
      { id: assistantId, role: "assistant", parts: [], turn: freshTurn(assistantId) },
      ...thread.messages.slice(index + 1),
    ],
  });
  void runAnswer(conversationId, assistantId, {
    text: context.userText,
    history: context.historyMessages,
    documents: context.documents,
    collections: context.collections,
  });
}

/**
 * Edit a question and ask it again. Its answer and every later message are
 * replaced; the caller confirms first when later messages exist.
 */
export function editQuestion(conversationId: string, userMessageId: string, text: string): void {
  const thread = threads.get(conversationId);
  const trimmed = text.trim().slice(0, CHAT_LIMITS.messageCharacters);
  if (!thread || !trimmed || controllers.has(conversationId)) return;
  const truncation = editTruncation(thread.messages, userMessageId);
  if (!truncation) return;
  const documents = truncation.user.parts.flatMap((part) => part.type === "data-document" ? [part.data] : []);
  const collections = truncation.user.parts.flatMap((part) => part.type === "data-collection" ? [part.data] : []);
  const edited: ChatMessage = {
    ...truncation.user,
    parts: [
      { type: "text", text: trimmed, state: "done" },
      ...truncation.user.parts.filter((part) => part.type !== "text"),
    ],
  };
  const assistantId = newId("assistant");
  setThread(conversationId, {
    ...thread,
    messages: [
      ...truncation.kept,
      edited,
      { id: assistantId, role: "assistant", parts: [], turn: freshTurn(assistantId) },
    ],
  });
  void runAnswer(conversationId, assistantId, { text: trimmed, history: truncation.kept, documents, collections });
}

/** Stop the live answer; what arrived so far stays, marked as stopped. */
export function stopAnswer(conversationId: string): void {
  const controller = controllers.get(conversationId);
  const streamingId = threads.get(conversationId)?.streamingId;
  if (!controller) return;
  controller.abort();
  if (streamingId) {
    updateMessage(conversationId, streamingId, (message) => ({
      ...message,
      turn: failTurn(message.turn ?? freshTurn(message.id), STOPPED_MESSAGE),
    }));
  }
}

export function selectAnswerVariant(conversationId: string, assistantId: string, index: number): void {
  if (controllers.has(conversationId)) return;
  updateMessage(conversationId, assistantId, (message) => selectVariant(message, index));
  void persistThread(conversationId, false);
}

export function setAnswerFeedback(conversationId: string, assistantId: string, feedback: AnswerFeedback | undefined): void {
  updateMessage(conversationId, assistantId, (message) => ({ ...message, feedback }));
  void persistThread(conversationId, false);
}

/** A rename keeps the chat's place in the list; only new messages move it. */
export async function renameConversation(conversationId: string, title: string): Promise<void> {
  bindConversationUser();
  const existing = await conversationAdapter.getConversation(conversationId);
  if (!existing) throw new Error("This chat isn’t available.");
  const updated = await conversationAdapter.updateConversation(conversationId, {
    title: title.trim(),
    titleSource: "custom",
    updatedAt: existing.updatedAt,
  });
  if (updated) updateThread(conversationId, (thread) => ({ ...thread, conversation: updated }));
}

/** The knowledge bases a chat searches; keeps the chat's place in the list. */
export async function setConversationScope(conversationId: string, scope: ConversationCollection[]): Promise<void> {
  bindConversationUser();
  const existing = await conversationAdapter.getConversation(conversationId);
  if (!existing) return;
  const updated = await conversationAdapter.updateConversation(conversationId, { scope, updatedAt: existing.updatedAt });
  if (updated) updateThread(conversationId, (thread) => ({ ...thread, conversation: updated }));
}

/**
 * Delete a chat and the files uploaded into it. A document referenced from
 * knowledge belongs to its knowledge base and is never deleted with a chat.
 * A live answer in that chat is stopped first.
 */
export async function deleteConversation(conversationId: string): Promise<void> {
  bindConversationUser();
  controllers.get(conversationId)?.abort();
  controllers.delete(conversationId);
  const stored = await conversationAdapter.getConversationMessages(conversationId);
  const uploads = new Set(stored.flatMap((message) => message.parts.flatMap((part) => (
    part.type === "data-document" && part.data.origin !== "reference" ? [part.data.id] : []
  ))));
  await Promise.allSettled([...uploads].map((documentId) => releaseConversationDocument(documentId)));
  await conversationAdapter.deleteConversation(conversationId);
  setThread(conversationId, { conversationId, status: "missing", conversation: null, messages: [], streamingId: null });
}

/**
 * "Continue in a new chat" from a shared chat: its messages become a chat of
 * the reader's own, with citations only to documents they can open; markers
 * for the rest are removed. Returns the new chat's id.
 */
export async function importSharedConversation(shared: SharedConversation): Promise<string> {
  bindConversationUser();
  const conversationId = newId("conversation");
  const messages: ChatMessage[] = shared.messages.map((message) => {
    if (message.role === "user") {
      return { id: newId("user"), role: "user", parts: [{ type: "text", text: message.content, state: "done" }] };
    }
    const hidden = new Set(message.sources.filter((source) => !source.available).map((source) => source.number));
    const text = message.content.replace(/\s?\[(\d{1,3})\]/g, (marker, number: string) => hidden.has(Number(number)) ? "" : marker);
    const id = newId("assistant");
    return {
      id,
      role: "assistant",
      parts: [],
      turn: {
        id,
        status: "completed",
        responseOrder: ["shared"],
        responses: {
          shared: {
            id: "shared",
            status: "completed",
            itemOrder: ["answer"],
            items: {
              answer: {
                type: "message",
                id: "answer",
                role: "assistant",
                status: "completed",
                phase: "final_answer",
                content: [{
                  type: "output_text",
                  text,
                  annotations: message.sources.flatMap((source) => source.available
                    ? [{ type: DOCUMENT_CITATION_TYPE, citation: { number: source.number, item_id: source.document_id, chunk_id: source.chunk_id, title: source.title } }]
                    : []),
                }],
              },
            },
          },
        },
      },
    };
  });
  await conversationAdapter.createConversation(titleFromMessage(shared.title), conversationId);
  await conversationAdapter.saveConversationMessages(conversationId, messages.map(uiToCachedMessage));
  await conversationAdapter.updateConversation(conversationId, { preview: conversationPreview(messages) });
  threads.delete(conversationId);
  return conversationId;
}

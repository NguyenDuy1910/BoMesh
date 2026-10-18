import type {
  ChatMessage,
  ChatMessagePart,
  ConversationCollection,
  ConversationDocument,
} from "./types";
import { getMessageText } from "./conversations.ts";

export function conversationMessageText(message: ChatMessage) {
  return getMessageText(message).trim();
}

/**
 * The server's zero-based turn index of the user message at `userIndex`: the
 * number of user messages before it. Sent as `replace_from_turn` when a
 * request replaces that question (retry, edit, or answering it now).
 */
export function userTurnIndex(messages: ChatMessage[], userIndex: number): number {
  return messages.slice(0, userIndex).filter((message) => message.role === "user").length;
}

export function regenerationContext(
  messages: ChatMessage[],
  targetId?: string,
): {
  userText: string;
  replaceFromTurn: number;
  displayMessages: ChatMessage[];
  documents: ConversationDocument[];
  collections: ConversationCollection[];
} | null {
  const targetIndex = targetId
    ? messages.findIndex((message) => message.id === targetId)
    : messages.length;
  const user = messages
    .slice(0, targetIndex < 0 ? messages.length : targetIndex)
    .reverse()
    .find((message) => message.role === "user");
  if (!user) return null;
  const userIndex = messages.indexOf(user);
  const userText = conversationMessageText(user);
  if (!userText) return null;
  return {
    userText,
    replaceFromTurn: userTurnIndex(messages, userIndex),
    displayMessages: messages.slice(0, userIndex + 1),
    documents: user.parts
      .filter((part): part is Extract<ChatMessagePart, { type: "data-document" }> => (
        part.type === "data-document"
      ))
      .map((part) => part.data),
    collections: user.parts
      .filter((part): part is Extract<ChatMessagePart, { type: "data-collection" }> => (
        part.type === "data-collection"
      ))
      .map((part) => part.data),
  };
}

/**
 * Retry modes on an answer. A retry is a new request: the same question with
 * an instruction appended, or with the knowledge scope cleared.
 */
export type RetryMode = "again" | "detail" | "shorter" | "all_knowledge";

const RETRY_INSTRUCTIONS: Record<RetryMode, string | null> = {
  again: null,
  detail: "Answer again in more detail, with the specifics the sources support.",
  shorter: "Answer again more briefly: only the key points.",
  all_knowledge: null,
};

/** The text sent for a retry; the visible question stays as the person wrote it. */
export function retryMessageText(userText: string, mode: RetryMode, maxCharacters: number): string {
  const instruction = RETRY_INSTRUCTIONS[mode];
  if (!instruction) return userText.slice(0, maxCharacters);
  const suffix = `\n\n${instruction}`;
  return `${userText.slice(0, Math.max(0, maxCharacters - suffix.length))}${suffix}`;
}

/**
 * What a retry of one answer sends. The question and its files
 * are the ones that produced the answer; "Search all knowledge" sends no
 * knowledge-base scope.
 */
export function retryRequest(
  messages: ChatMessage[],
  assistantId: string,
  mode: RetryMode,
  maxCharacters: number,
): {
  userText: string;
  requestText: string;
  replaceFromTurn: number;
  documents: ConversationDocument[];
  collections: ConversationCollection[];
} | null {
  const context = regenerationContext(messages, assistantId);
  if (!context) return null;
  return {
    userText: context.userText,
    requestText: retryMessageText(context.userText, mode, maxCharacters),
    replaceFromTurn: context.replaceFromTurn,
    documents: context.documents,
    collections: mode === "all_knowledge" ? [] : context.collections,
  };
}

/**
 * Editing a question replaces its answer and drops everything after it.
 * `dropped` counts the later messages beyond that answer — the ones the
 * person is asked to confirm losing.
 */
export function editTruncation(
  messages: ChatMessage[],
  userMessageId: string,
): { kept: ChatMessage[]; user: ChatMessage; dropped: number; replaceFromTurn: number } | null {
  const index = messages.findIndex((message) => message.id === userMessageId && message.role === "user");
  if (index < 0) return null;
  const answerFollows = messages[index + 1]?.role === "assistant";
  return {
    kept: messages.slice(0, index),
    user: messages[index]!,
    replaceFromTurn: userTurnIndex(messages, index),
    dropped: Math.max(0, messages.length - index - 1 - (answerFollows ? 1 : 0)),
  };
}

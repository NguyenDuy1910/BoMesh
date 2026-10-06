import type {
  AgentHistoryMessage,
  ChatMessage,
  ChatMessagePart,
  ConversationCollection,
  ConversationDocument,
} from "./types";
import { getMessageText } from "./conversations.ts";

export const MAX_HISTORY_MESSAGES = 24;
export const MAX_HISTORY_CHARACTERS = 24_000;
export const MAX_HISTORY_MESSAGE_CHARACTERS = 8_000;
const CLIP_MARKER = "\n…\n";

export function conversationMessageText(message: ChatMessage) {
  return getMessageText(message).trim();
}

export function historyFromMessages(messages: ChatMessage[]): AgentHistoryMessage[] {
  let remainingCharacters = MAX_HISTORY_CHARACTERS;
  const selected: AgentHistoryMessage[] = [];

  for (const message of [...messages].reverse()) {
    const content = clipHistoryMessage(conversationMessageText(message));
    if (!content) continue;
    if (selected.length === MAX_HISTORY_MESSAGES || content.length > remainingCharacters) {
      break;
    }
    selected.push({ role: message.role, content });
    remainingCharacters -= content.length;
  }

  selected.reverse();
  // Never send an assistant answer after dropping the user request that
  // introduced it at a history budget boundary.
  while (selected[0]?.role === "assistant") selected.shift();
  return selected;
}

function clipHistoryMessage(content: string) {
  if (content.length <= MAX_HISTORY_MESSAGE_CHARACTERS) return content;
  const available = MAX_HISTORY_MESSAGE_CHARACTERS - CLIP_MARKER.length;
  const leadingCharacters = Math.ceil(available * 0.6);
  const trailingCharacters = available - leadingCharacters;
  return `${content.slice(0, leadingCharacters)}${CLIP_MARKER}${content.slice(-trailingCharacters)}`;
}

export function regenerationContext(
  messages: ChatMessage[],
  targetId?: string,
): {
  userText: string;
  historyMessages: ChatMessage[];
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
    historyMessages: messages.slice(0, userIndex),
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
 * What a retry of one answer sends. The question, its files and its history
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
  historyMessages: ChatMessage[];
  documents: ConversationDocument[];
  collections: ConversationCollection[];
} | null {
  const context = regenerationContext(messages, assistantId);
  if (!context) return null;
  return {
    userText: context.userText,
    requestText: retryMessageText(context.userText, mode, maxCharacters),
    historyMessages: context.historyMessages,
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
): { kept: ChatMessage[]; user: ChatMessage; dropped: number } | null {
  const index = messages.findIndex((message) => message.id === userMessageId && message.role === "user");
  if (index < 0) return null;
  const answerFollows = messages[index + 1]?.role === "assistant";
  return {
    kept: messages.slice(0, index),
    user: messages[index]!,
    dropped: Math.max(0, messages.length - index - 1 - (answerFollows ? 1 : 0)),
  };
}

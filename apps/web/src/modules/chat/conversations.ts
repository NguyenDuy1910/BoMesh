"use client";

import type {
  AnswerVariant,
  CachedChatMessage,
  ChatConversation,
  ChatMessage,
  ChatMessagePart,
  TurnState,
  WorkLogEntry,
} from "./types";
import { finalTurnText } from "./message-stream.ts";

/**
 * The device-local conversation store (conversation_loop.md: conversations are
 * not synchronized across devices). Storage is isolated by account and
 * workspace; every write announces itself so lists in other surfaces and other
 * tabs stay current.
 */
const CONVERSATIONS_KEY_BASE = "bomesh-conversations";
const MESSAGE_PREFIX_BASE = "bomesh-messages:";
const ANONYMOUS_USER_NAMESPACE = "anonymous";
const DEFAULT_CONVERSATION_TITLE = "New chat";
const MAX_STORED_MESSAGES = 100;
const PREVIEW_CHARACTERS = 160;

/** Fired on `window` after any conversation or message write in this tab. */
export const CONVERSATIONS_CHANGED_EVENT = "bomesh:conversations-changed";

let memoryConversations: ChatConversation[] = [];
const memoryMessages = new Map<string, CachedChatMessage[]>();
let activeUserNamespace = ANONYMOUS_USER_NAMESPACE;

function normalizeUserNamespace(identity: string | null | undefined) {
  const value = String(identity ?? "").trim().toLowerCase();
  return value || ANONYMOUS_USER_NAMESPACE;
}

/** Keep browser-local chats isolated by both signed-in user and active workspace. */
export function setConversationUser(
  identity: string | null | undefined,
  tenantId?: string | null,
) {
  const user = normalizeUserNamespace(identity);
  const tenant = normalizeUserNamespace(tenantId);
  const next = `${user}:${tenant}`;
  if (next === activeUserNamespace) return;
  activeUserNamespace = next;
  memoryConversations = [];
  memoryMessages.clear();
}

function conversationsKey() {
  return `${CONVERSATIONS_KEY_BASE}:${activeUserNamespace}`;
}

function messageKey(sessionId: string) {
  return `${MESSAGE_PREFIX_BASE}${activeUserNamespace}:${sessionId}`;
}

/**
 * Call `listener` after any write to the store, in this tab or another one.
 * Returns the unsubscribe function.
 */
export function subscribeToConversations(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }
  const onStorage = (event: StorageEvent) => {
    if (!event.key || event.key.startsWith(CONVERSATIONS_KEY_BASE) || event.key.startsWith(MESSAGE_PREFIX_BASE)) {
      listener();
    }
  };
  window.addEventListener(CONVERSATIONS_CHANGED_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

function announceChange() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
}

export interface ConversationAdapter {
  createConversation(
    title?: string,
    id?: string,
    sessionId?: string,
  ): Promise<ChatConversation>;
  listConversations(): Promise<ChatConversation[]>;
  getConversation(id: string): Promise<ChatConversation | null>;
  getConversationMessages(id: string): Promise<CachedChatMessage[]>;
  saveConversationMessages(id: string, messages: CachedChatMessage[]): Promise<void>;
  updateConversation(
    id: string,
    patch: Partial<
      Pick<ChatConversation, "title" | "titleSource" | "updatedAt" | "scope" | "preview">
    >
  ): Promise<ChatConversation | null>;
  deleteConversation(id: string): Promise<void>;
}

function readConversations(): ChatConversation[] {
  try {
    const raw = window.localStorage.getItem(conversationsKey());
    return normalizeConversations(
      raw ? (JSON.parse(raw) as ChatConversation[]) : memoryConversations
    );
  } catch {
    return normalizeConversations(memoryConversations);
  }
}

function writeConversations(conversations: ChatConversation[]) {
  memoryConversations = conversations;
  try {
    window.localStorage.setItem(conversationsKey(), JSON.stringify(conversations));
  } catch {
    // Keep local-only conversations usable when browser storage is unavailable.
  }
  announceChange();
}

function readStoredMessages(id: string): CachedChatMessage[] {
  const sessionId = resolveSessionId(id);
  try {
    const raw = window.localStorage.getItem(messageKey(sessionId));
    return raw
      ? normalizeCachedMessages(JSON.parse(raw) as CachedChatMessage[])
      : normalizeCachedMessages(memoryMessages.get(sessionId) ?? []);
  } catch {
    return normalizeCachedMessages(memoryMessages.get(sessionId) ?? []);
  }
}

function createLocalId(prefix: string) {
  const randomUUID = globalThis.crypto?.randomUUID?.();
  if (randomUUID) return randomUUID;

  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function normalizeConversations(conversations: ChatConversation[]) {
  return conversations.map((conversation) => ({
    ...conversation,
    sessionId: conversation.sessionId || conversation.id,
  }));
}

function resolveSessionId(id: string) {
  return (
    readConversations().find(
      (conversation) => conversation.id === id || conversation.sessionId === id
    )?.sessionId ?? id
  );
}

function normalizeCachedMessage(message: CachedChatMessage): CachedChatMessage {
  return {
    ...message,
    parts: message.parts.flatMap((part) => {
      const normalized = normalizeStoredPart(part);
      return normalized ? [normalized] : [];
    }),
  };
}

function normalizeStoredPart(part: ChatMessagePart): ChatMessagePart | undefined {
  if (part.type === "text" && part.state === "streaming") {
    return { ...part, state: "done" };
  }
  return part.type === "text" || part.type === "data-document" || part.type === "data-collection"
    ? part
    : undefined;
}

function normalizeCachedMessages(messages: CachedChatMessage[]) {
  return messages.map(normalizeCachedMessage);
}

export function getMessageText(message: ChatMessage): string {
  if (message.role === "assistant") {
    const semanticText = finalTurnText(message.turn);
    if (semanticText) return semanticText;
  }
  return message.parts
    .filter((part): part is Extract<ChatMessagePart, { type: "text" }> => (
      part.type === "text"
    ))
    .map((part) => part.text)
    .join("");
}

/** A chat's first title: the opening question, cut at a word near 60 characters. */
export function titleFromMessage(message: string) {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (!cleaned) return DEFAULT_CONVERSATION_TITLE;
  if (cleaned.length <= 60) return cleaned;
  const cut = cleaned.slice(0, 57);
  const atWord = cut.replace(/\s+\S*$/, "");
  return `${atWord.length > 30 ? atWord : cut}…`;
}

/**
 * The line the chat list shows under a title: the first non-empty line of the
 * newest answer, without Markdown emphasis, citation markers or table rows.
 */
export function conversationPreview(messages: readonly ChatMessage[]): string {
  const answer = [...messages].reverse().find((message) => message.role === "assistant");
  if (!answer) return "";
  const text = getMessageText(answer)
    .replace(/\*\*|__|\*|`/g, "")
    .replace(/\s?\[\d{1,3}\]/g, "")
    .replace(/^\s*\|.*$/gm, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "");
  const line = text.split("\n").map((value) => value.trim()).find(Boolean) ?? "";
  const clean = line.replace(/:\s*$/, "");
  return clean.length > PREVIEW_CHARACTERS ? `${clean.slice(0, PREVIEW_CHARACTERS - 1)}…` : clean;
}

export function cachedToUIMessage(message: CachedChatMessage): ChatMessage {
  // An assistant reply's content lives entirely in ``turn`` — its own ``parts``
  // is always empty (see useBomeshChat.ts). Gating this branch on parts alone
  // dropped ``turn`` for every restored assistant message and rendered it as an
  // empty bubble, since the answer renderer reads only ``turn``.
  if (message.parts.length || message.turn) {
    return {
      id: message.id,
      role: message.role,
      parts: message.parts.flatMap((part) => {
        const normalized = normalizeStoredPart(part);
        return normalized ? [normalized] : [];
      }),
      turn: message.turn,
      ...(message.variants?.length ? { variants: message.variants } : {}),
      ...(typeof message.variantIndex === "number" ? { variantIndex: message.variantIndex } : {}),
      ...(message.feedback ? { feedback: message.feedback } : {}),
    };
  }

  return {
    id: message.id,
    role: message.role,
    parts: [{ type: "text", text: message.content, state: "done" }],
  };
}

export function uiToCachedMessage(message: ChatMessage): CachedChatMessage {
  const turn = message.turn && storedTurn(message.turn);
  const variants = message.variants?.map((variant): AnswerVariant => ({
    ...variant,
    turn: storedTurn(variant.turn),
  }));
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: getMessageText(message),
    parts: message.parts.flatMap((part) => {
      const normalized = normalizeStoredPart(part);
      return normalized ? [normalized] : [];
    }),
    turn,
    ...(variants?.length ? { variants } : {}),
    ...(typeof message.variantIndex === "number" ? { variantIndex: message.variantIndex } : {}),
    ...(message.feedback ? { feedback: message.feedback } : {}),
    createdAt: Date.now(),
  };
}

/**
 * A turn as it is saved: live-only state is dropped, and the runtime facts of
 * its tool calls are settled into `workLog` so a restored answer can still
 * say what ran. A call still marked active when the turn ended did not finish.
 */
function storedTurn(turn: TurnState): TurnState {
  const { modelPending: _modelPending, runtimeActivities, ...stored } = turn;
  if (!runtimeActivities?.length) return stored;
  const workLog: WorkLogEntry[] = runtimeActivities.map((activity) => ({
    callId: activity.callId,
    toolName: activity.toolName,
    state: activity.state === "active" ? (turn.status === "completed" ? "completed" : "failed") : activity.state,
    ...(typeof activity.resultCount === "number" ? { resultCount: activity.resultCount } : {}),
  }));
  return { ...stored, workLog };
}

export const conversationAdapter: ConversationAdapter = {
  async createConversation(
    title = DEFAULT_CONVERSATION_TITLE,
    id = createLocalId("conversation"),
    sessionId = id,
  ) {
    const existing = readConversations().find((conversation) => conversation.id === id);
    if (existing && existing.deletedAt === undefined) return existing;

    const now = Date.now();
    if (existing) {
      const restored: ChatConversation = {
        ...existing,
        title,
        sessionId,
        updatedAt: now,
        deletedAt: undefined,
      };
      writeConversations(
        readConversations().map((conversation) => (
          conversation.id === id ? restored : conversation
        )),
      );
      return restored;
    }
    const conversation: ChatConversation = {
      id,
      sessionId,
      title,
      titleSource: "generated",
      createdAt: now,
      updatedAt: now,
    };
    // Persist alongside existing conversations — creating a new chat must never
    // remove or overwrite a previous one. Empty drafts are not persisted until
    // the first message is sent, so there is nothing to prune here.
    writeConversations([conversation, ...readConversations()]);
    return conversation;
  },

  async listConversations() {
    return readConversations()
      .filter((conversation) => conversation.deletedAt === undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async getConversation(id) {
    return readConversations().find((conversation) => (
      conversation.id === id && conversation.deletedAt === undefined
    )) ?? null;
  },

  async getConversationMessages(id) {
    return readStoredMessages(id);
  },

  async saveConversationMessages(id, messages) {
    const nextMessages = normalizeCachedMessages(messages).slice(-MAX_STORED_MESSAGES);
    const sessionId = resolveSessionId(id);
    memoryMessages.set(sessionId, nextMessages);
    try {
      window.localStorage.setItem(
        messageKey(sessionId),
        JSON.stringify(nextMessages)
      );
    } catch {
      // Keep the in-memory fallback alive for restricted browser contexts.
    }
    announceChange();
  },

  async updateConversation(id, patch) {
    let updated: ChatConversation | null = null;
    const next = readConversations().map((conversation) => {
      if (conversation.id !== id || conversation.deletedAt !== undefined) {
        return conversation;
      }
      updated = {
        ...conversation,
        ...patch,
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      return updated;
    });
    writeConversations(next);
    return updated;
  },

  async deleteConversation(id) {
    const deletedAt = Date.now();
    writeConversations(readConversations().map((conversation) => (
      conversation.id === id || conversation.sessionId === id
        ? { ...conversation, deletedAt }
        : conversation
    )));
  },
};

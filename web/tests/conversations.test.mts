import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationAdapter,
  conversationPreview,
  setConversationUser,
  uiToCachedMessage,
} from "../src/modules/chat/conversations.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("conversation adapter persists custom rename metadata and confirmed deletion", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: new MemoryStorage() },
  });
  setConversationUser("sidebar-actions-test");

  await conversationAdapter.createConversation("Generated title", "chat-1", "session-1");
  const renamed = await conversationAdapter.updateConversation("chat-1", {
    title: "Quarterly planning",
    titleSource: "custom",
  });

  assert.equal(renamed?.title, "Quarterly planning");
  assert.equal(renamed?.titleSource, "custom");
  assert.equal((await conversationAdapter.listConversations()).length, 1);
  await conversationAdapter.saveConversationMessages("chat-1", [
    {
      id: "message-1",
      role: "user",
      content: "Retain this message",
      parts: [{ type: "text", text: "Retain this message", state: "done" }],
      createdAt: Date.now(),
    },
  ]);

  await conversationAdapter.deleteConversation("chat-1");
  assert.deepEqual(await conversationAdapter.listConversations(), []);
  assert.equal(
    (await conversationAdapter.getConversationMessages("chat-1"))[0]?.content,
    "Retain this message",
  );
});

test("does not persist pending or runtime activity as conversation history", () => {
  const cached = uiToCachedMessage({
    id: "assistant-1",
    role: "assistant",
    parts: [],
    turn: {
      id: "assistant-1",
      status: "streaming",
      responses: {},
      responseOrder: [],
      modelPending: true,
      runtimeActivities: [{
        callId: "call-1",
        toolName: "knowledge_search",
        state: "active",
        startedAt: Date.now(),
      }],
    },
  });

  assert.equal(cached.turn?.modelPending, undefined);
  assert.equal(cached.turn?.runtimeActivities, undefined);
});

test("retains collection context on a persisted user turn", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: new MemoryStorage() },
  });
  setConversationUser("collection-context-test");

  await conversationAdapter.createConversation("Policy question", "chat-collections");
  await conversationAdapter.saveConversationMessages("chat-collections", [{
    id: "message-collection",
    role: "user",
    content: "What changed in the policy?",
    parts: [
      { type: "text", text: "What changed in the policy?", state: "done" },
      {
        type: "data-collection",
        id: "collection-policy",
        data: { id: "collection-policy", title: "Policy workspace" },
      },
    ],
    createdAt: Date.now(),
  }]);

  const restored = await conversationAdapter.getConversationMessages("chat-collections");
  assert.equal(restored[0]?.parts[1]?.type, "data-collection");
});

test("conversations are kept per workspace", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: new MemoryStorage() },
  });
  setConversationUser("chat-restore-test", "workspace-a");
  await conversationAdapter.createConversation("Workspace A chat", "conversation-1");

  setConversationUser("chat-restore-test", "workspace-b");
  assert.deepEqual(await conversationAdapter.listConversations(), []);
  assert.equal(await conversationAdapter.getConversation("conversation-1"), null);

  setConversationUser("chat-restore-test", "workspace-a");
  assert.deepEqual((await conversationAdapter.listConversations()).map(({ id }) => id), ["conversation-1"]);
});

test("a saved turn keeps what ran, settled, but never live-only state", () => {
  const cached = uiToCachedMessage({
    id: "assistant-2",
    role: "assistant",
    parts: [],
    turn: {
      id: "assistant-2",
      status: "failed",
      responses: {},
      responseOrder: [],
      runtimeActivities: [
        { callId: "call-1", toolName: "knowledge_search", state: "completed", startedAt: 1, resultCount: 4 },
        { callId: "call-2", toolName: "export_sandbox_file", state: "active", startedAt: 2 },
      ],
    },
  });

  assert.deepEqual(cached.turn?.workLog, [
    { callId: "call-1", toolName: "knowledge_search", state: "completed", resultCount: 4 },
    { callId: "call-2", toolName: "export_sandbox_file", state: "failed" },
  ]);
});

test("the chat list preview is the answer's first line without Markdown or citation markers", () => {
  const answer = {
    id: "a-1",
    role: "assistant" as const,
    parts: [{ type: "text" as const, text: "## Per diem\n**USD 75** a day [1]:\n| a | b |", state: "done" as const }],
  };
  assert.equal(conversationPreview([answer]), "Per diem");
  assert.equal(conversationPreview([{ ...answer, parts: [{ type: "text", text: "- **USD 75** a day [1]:", state: "done" }] }]), "USD 75 a day");
});

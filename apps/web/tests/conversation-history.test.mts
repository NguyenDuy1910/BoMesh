import assert from "node:assert/strict";
import test from "node:test";

import {
  editTruncation,
  regenerationContext,
  retryRequest,
} from "../src/modules/chat/conversation-history.ts";
import type { ChatMessage, TurnState } from "../src/modules/chat/types.ts";
import { beginAttempt, selectVariant, settleAttempt, variantPosition } from "../src/modules/chat/variants.ts";

function message(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text, state: "done" }],
  };
}

test("regeneration replaces the question's turn, counted among user messages", () => {
  const messages = [
    message("user-1", "user", "Tell me about product Easy"),
    message("assistant-1", "assistant", "Easy is an internal loan product."),
    message("user-2", "user", "What are its fees?"),
    message("assistant-2", "assistant", "Old answer"),
  ];

  const context = regenerationContext(messages, "assistant-2");

  assert.equal(context?.userText, "What are its fees?");
  assert.equal(context?.replaceFromTurn, 1);
  assert.equal(regenerationContext(messages, "assistant-1")?.replaceFromTurn, 0);
  assert.deepEqual(context?.displayMessages, messages.slice(0, 3));
});

test("a retry resends the question with its instruction and keeps the scope unless told to search everything", () => {
  const scoped: ChatMessage = {
    id: "user-1",
    role: "user",
    parts: [
      { type: "text", text: "What is the per diem?", state: "done" },
      { type: "data-collection", id: "c-hr", data: { id: "c-hr", title: "HR Policies" } },
    ],
  };
  const messages = [scoped, message("assistant-1", "assistant", "USD 75.")];

  const again = retryRequest(messages, "assistant-1", "again", 4_000);
  assert.equal(again?.requestText, "What is the per diem?");
  assert.deepEqual(again?.collections, [{ id: "c-hr", title: "HR Policies" }]);
  assert.equal(again?.replaceFromTurn, 0);

  const shorter = retryRequest(messages, "assistant-1", "shorter", 4_000);
  assert.match(shorter?.requestText ?? "", /^What is the per diem\?\n\n.*briefly/);
  // The visible question stays as the person wrote it.
  assert.equal(shorter?.userText, "What is the per diem?");

  assert.deepEqual(retryRequest(messages, "assistant-1", "all_knowledge", 4_000)?.collections, []);
  // The instruction never pushes a request past the message limit.
  const long = retryRequest([message("user-2", "user", "x".repeat(4_000)), message("a-2", "assistant", "ok")], "a-2", "detail", 4_000);
  assert.equal(long?.requestText.length, 4_000);
});

test("retrying the second answer replaces the second user turn", () => {
  const messages = [
    message("user-1", "user", "First?"),
    message("assistant-1", "assistant", "One."),
    message("user-2", "user", "Second?"),
    message("assistant-2", "assistant", "Two."),
  ];
  assert.equal(retryRequest(messages, "assistant-2", "all_knowledge", 4_000)?.replaceFromTurn, 1);
  assert.equal(retryRequest(messages, "assistant-1", "again", 4_000)?.replaceFromTurn, 0);
});

test("editing a question replaces its answer and counts only the later messages it drops", () => {
  const messages = [
    message("user-1", "user", "First?"),
    message("assistant-1", "assistant", "One."),
    message("user-2", "user", "Second?"),
    message("assistant-2", "assistant", "Two."),
  ];

  assert.deepEqual(editTruncation(messages, "user-2"), { kept: messages.slice(0, 2), user: messages[2], dropped: 0, replaceFromTurn: 1 });
  assert.equal(editTruncation(messages, "user-1")?.dropped, 2);
  assert.equal(editTruncation(messages, "user-1")?.replaceFromTurn, 0);
  // A question with no answer yet drops nothing but what follows it.
  assert.equal(editTruncation(messages.slice(0, 3), "user-2")?.dropped, 0);
  assert.equal(editTruncation(messages, "assistant-1"), null);
});

function turn(id: string): TurnState {
  return { id, status: "completed", responses: {}, responseOrder: [] };
}

test("retrying keeps every earlier answer reachable through the pager, with its own feedback", () => {
  let answer: ChatMessage = { id: "a-1", role: "assistant", parts: [], turn: turn("first"), feedback: "down" };
  assert.equal(variantPosition(answer), null);

  answer = beginAttempt(answer, turn("second"));
  // While the retry streams there is no pager yet.
  assert.equal(variantPosition(answer), null);
  assert.equal(answer.feedback, undefined);
  answer = settleAttempt(answer);
  assert.deepEqual(variantPosition(answer), { index: 1, count: 2 });
  assert.equal(answer.turn?.id, "second");

  answer = { ...answer, feedback: "up" };
  answer = selectVariant(answer, 0);
  assert.equal(answer.turn?.id, "first");
  assert.equal(answer.feedback, "down");
  answer = selectVariant(answer, 5);
  assert.equal(answer.turn?.id, "second");
  assert.equal(answer.feedback, "up");

  answer = settleAttempt(beginAttempt(answer, turn("third")));
  assert.deepEqual(answer.variants?.map((variant) => variant.turn.id), ["first", "second", "third"]);
  assert.deepEqual(variantPosition(answer), { index: 2, count: 3 });
});

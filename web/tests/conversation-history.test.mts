import assert from "node:assert/strict";
import test from "node:test";

import {
  editTruncation,
  historyFromMessages,
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

test("history keeps the final response from a semantic multi-response Turn", () => {
  const messages: ChatMessage[] = [
    message("old-user", "user", "O".repeat(20_000)),
    message("old-assistant", "assistant", "A".repeat(5_000)),
    message("recent-user", "user", "What are the loan fees?"),
    {
      id: "recent-assistant",
      role: "assistant",
      parts: [],
      turn: {
        id: "turn-1",
        status: "completed",
        responseOrder: ["response-1", "response-2"],
        responses: {
          "response-1": {
            id: "response-1", status: "completed", itemOrder: ["tool-1"],
            items: {
              "tool-1": {
                type: "function_call", id: "tool-1", call_id: "call-1", name: "knowledge_search",
                arguments: "{}", status: "completed",
              },
            },
          },
          "response-2": {
            id: "response-2", status: "completed", itemOrder: ["message-1"],
            items: {
              "message-1": {
                type: "message", id: "message-1", role: "assistant", status: "completed",
                content: [{ type: "output_text", text: "The documented fee is 1%.", annotations: [] }],
              },
            },
          },
        },
      },
    },
  ];

  const history = historyFromMessages(messages);

  assert.deepEqual(history.slice(-2), [
    { role: "user", content: "What are the loan fees?" },
    { role: "assistant", content: "The documented fee is 1%." },
  ]);
  assert.equal(history[0]?.role, "user");
});

test("regeneration excludes the replaced answer and current request from history", () => {
  const messages = [
    message("user-1", "user", "Tell me about product Easy"),
    message("assistant-1", "assistant", "Easy is an internal loan product."),
    message("user-2", "user", "What are its fees?"),
    message("assistant-2", "assistant", "Old answer"),
  ];

  const context = regenerationContext(messages, "assistant-2");

  assert.equal(context?.userText, "What are its fees?");
  assert.deepEqual(context?.historyMessages, messages.slice(0, 2));
  assert.deepEqual(context?.displayMessages, messages.slice(0, 3));
});

test("oversized messages preserve both the subject and the latest details", () => {
  const longAnswer = `Subject: Easy loan\n${"A".repeat(9_000)}\nFinal fee: 1%`;

  const history = historyFromMessages([
    message("user", "user", "Tell me about Easy loan"),
    message("assistant", "assistant", longAnswer),
  ]);

  assert.equal(history[1]?.content.length, 8_000);
  assert.match(history[1]?.content ?? "", /^Subject: Easy loan/);
  assert.match(history[1]?.content ?? "", /Final fee: 1%$/);
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
  assert.deepEqual(again?.historyMessages, []);

  const shorter = retryRequest(messages, "assistant-1", "shorter", 4_000);
  assert.match(shorter?.requestText ?? "", /^What is the per diem\?\n\n.*briefly/);
  // The visible question stays as the person wrote it.
  assert.equal(shorter?.userText, "What is the per diem?");

  assert.deepEqual(retryRequest(messages, "assistant-1", "all_knowledge", 4_000)?.collections, []);
  // The instruction never pushes a request past the message limit.
  const long = retryRequest([message("user-2", "user", "x".repeat(4_000)), message("a-2", "assistant", "ok")], "a-2", "detail", 4_000);
  assert.equal(long?.requestText.length, 4_000);
});

test("editing a question replaces its answer and counts only the later messages it drops", () => {
  const messages = [
    message("user-1", "user", "First?"),
    message("assistant-1", "assistant", "One."),
    message("user-2", "user", "Second?"),
    message("assistant-2", "assistant", "Two."),
  ];

  assert.deepEqual(editTruncation(messages, "user-2"), { kept: messages.slice(0, 2), user: messages[2], dropped: 0 });
  assert.equal(editTruncation(messages, "user-1")?.dropped, 2);
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

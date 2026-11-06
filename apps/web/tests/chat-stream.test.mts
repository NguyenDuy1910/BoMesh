import assert from "node:assert/strict";
import test from "node:test";

import { parseFrame, SseDecoder } from "../src/modules/chat/sse.ts";
import { emptyTurn, endTurn, reduceTurn, shellRuns, type StreamEvent, type Turn } from "../src/modules/chat/turn.ts";

// --- SSE framing ----------------------------------------------------------

test("frames split across chunks, lines and CRLF come out whole", () => {
  const decoder = new SseDecoder();
  const out = [
    ...decoder.push("event: response.output_text.delta\r\nda"),
    ...decoder.push('ta: {"delta":"Hel'),
    ...decoder.push('lo"}\r'),
    ...decoder.push("\n\r\n: keep-alive\n\nevent: response.completed\ndata: {}\n\n"),
  ];
  assert.deepEqual(out, [
    { event: "response.output_text.delta", data: '{"delta":"Hello"}' },
    { event: "response.completed", data: "{}" },
  ]);
});

test("a multi-byte character split between reads is decoded once", () => {
  const decoder = new SseDecoder();
  const bytes = new TextEncoder().encode('data: {"delta":"Tết"}\n\n');
  const cut = bytes.indexOf(0xe1) + 1; // inside "ế"
  const out = [...decoder.push(bytes.slice(0, cut)), ...decoder.push(bytes.slice(cut))];
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!.data).delta, "Tết");
});

test("multiline data joins with newlines and the last frame flushes at end", () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push("data: a\ndata: b"), []);
  assert.deepEqual(decoder.end(), [{ event: "message", data: "a\nb" }]);
});

test("the event name fills a payload without a type; bad JSON is skipped", () => {
  assert.deepEqual(parseFrame({ event: "tool_started", data: '{"call_id":"c1"}' }), { call_id: "c1", type: "tool_started" });
  assert.equal(parseFrame({ event: "x", data: "{nope" }), null);
});

// --- turn folding ---------------------------------------------------------

const msg = "workspaces/w1/conversations/c1/messages/m2";
const cite = (number: number, item: string, passage: string, start: number) => ({
  type: "bomesh:document_citation",
  start_index: start,
  end_index: start + 3,
  citation: { number, item: `workspaces/w1/items/${item}`, passage: `workspaces/w1/items/${item}/passages/${passage}`, title: `${item}.pdf`, excerpt: "quote", page_start: 2 },
});

function run(events: StreamEvent[], start: Turn = emptyTurn(0)): Turn {
  return events.reduce((turn, event) => reduceTurn(turn, event, 1000), start);
}

test("created names the assistant message; deltas build the answer", () => {
  const turn = run([
    { type: "response.created", response: { id: "r", status: "in_progress", metadata: { message: msg } } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Leave is " },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "20 weeks" },
  ]);
  assert.equal(turn.message, msg);
  assert.equal(turn.text, "Leave is 20 weeks");
  assert.equal(turn.status, "streaming");
});

test("text written before a tool call is not the answer; steps follow the tools", () => {
  const turn = run([
    { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Let me search." }] } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "c1", name: "knowledge_search", arguments: "" } },
    { type: "tool_started", call_id: "c1", tool_name: "knowledge_search" },
  ]);
  assert.equal(turn.text, "");
  assert.deepEqual(turn.steps.map((s) => [s.kind, s.label, s.live]), [["search", "Searching your knowledge", true]]);

  const done = run([
    { type: "tool_completed", call_id: "c1", tool_name: "knowledge_search", status: "completed", result_count: 7, duration_ms: 900 },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call_output", call_id: "c1", output: "…" } },
    { type: "response.output_text.delta", output_index: 3, content_index: 0, delta: "Answer" },
  ], turn);
  assert.equal(done.text, "Answer");
  assert.deepEqual(done.steps.map((s) => [s.label, s.detail, s.live]), [["Searched your knowledge", "7 relevant passages", false]]);
});

test("citation annotations group passages under one number per document", () => {
  const turn = run([
    { type: "response.created", response: { metadata: { message: msg } } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "A [1]" },
    { type: "response.output_text.annotation.added", output_index: 0, content_index: 0, annotation_index: 0, annotation: cite(1, "doc-a", "p1", 2) },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: " B [2]" },
    { type: "response.output_text.annotation.added", output_index: 0, content_index: 0, annotation_index: 1, annotation: cite(2, "doc-b", "p7", 8) },
    { type: "response.output_text.annotation.added", output_index: 0, content_index: 0, annotation_index: 2, annotation: cite(1, "doc-a", "p3", 2) },
  ]);
  assert.deepEqual(turn.sources.map((s) => [s.n, s.item, s.passages.map((p) => p.passage.split("/").pop())]), [
    [1, "workspaces/w1/items/doc-a", ["p1", "p3"]],
    [2, "workspaces/w1/items/doc-b", ["p7"]],
  ]);
  // The same annotation arriving again (item done) is not counted twice.
  const again = run([{ type: "response.output_text.annotation.added", output_index: 0, content_index: 0, annotation_index: 0, annotation: cite(1, "doc-a", "p1", 2) }], turn);
  assert.equal(again.sources[0]!.passages.length, 2);
});

test("artifact annotations and progress become artifact names once each", () => {
  const turn = run([
    { type: "response.created", response: { metadata: { message: msg } } },
    { type: "tool_progress", call_id: "c9", tool_name: "export_sandbox_file", data: { artifact: { id: "a1" } } },
    { type: "response.content_part.done", output_index: 4, content_index: 0, part: { type: "output_text", text: "Made it.", annotations: [{ type: "bomesh:artifact", artifact: { id: "a1" } }] } },
  ]);
  assert.deepEqual(turn.artifacts, ["workspaces/w1/artifacts/a1"]);
});

test("terminal events settle the turn", () => {
  const ok = run([{ type: "response.completed", response: {} }]);
  assert.equal(ok.status, "completed");
  assert.equal(ok.finishedAt, 1000);

  const failed = run([{ type: "response.failed", response: { error: { code: "MODEL_STREAM_ERROR", message: "x" } }, error: { code: 14, message: "The model is unavailable.", details: [{ reason: "MODEL_STREAM_ERROR" }] } }]);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "The model is unavailable.");
  assert.equal(failed.reason, "MODEL_STREAM_ERROR");

  assert.equal(run([{ type: "response.incomplete", response: {} }]).status, "interrupted");
});

test("stopping a live turn marks it interrupted and settles live steps", () => {
  const live = run([{ type: "tool_started", call_id: "c1", tool_name: "knowledge_search" }]);
  const stopped = endTurn(live, "interrupted", undefined, 5);
  assert.equal(stopped.status, "interrupted");
  assert.equal(stopped.steps[0]!.live, false);
  // A settled turn is never reopened.
  assert.equal(endTurn(stopped, "failed"), stopped);
});

test("shell runs pair commands with results; non-JSON output is one failed run", () => {
  assert.deepEqual(
    shellRuns('{"commands":["ls","python a.py"]}', JSON.stringify({ results: [{ exit_code: 0, stdout: "a.py" }, { exit_code: 1, stderr: "Traceback" }] })),
    [{ cmd: "ls", out: "a.py", exit: 0 }, { cmd: "python a.py", out: "Traceback", exit: 1 }],
  );
  assert.deepEqual(shellRuns('{"commands":["ls"]}', "sandbox unavailable"), [{ cmd: "ls", out: "sandbox unavailable", exit: 1 }]);
});

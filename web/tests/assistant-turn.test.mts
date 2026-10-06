import assert from "node:assert/strict";
import test from "node:test";

import { assistantTurnItems, executionSummary } from "../src/modules/chat/assistant-turn.ts";
import { turnWork } from "../src/modules/chat/work.ts";
import type { TurnState } from "../src/modules/chat/types.ts";

test("renders message items directly from semantic item state", () => {
  const items = assistantTurnItems(turnWithFinalMessage());

  assert.deepEqual(items, [{
    kind: "message",
    id: "message-1",
    phase: "final_answer",
    text: "The answer.",
    state: "done",
  }]);
});

test("does not present a model function call as runtime activity", () => {
  const turn: TurnState = {
    id: "turn-1",
    status: "streaming",
    responseOrder: ["response-1", "response-2"],
    responses: {
      "response-1": {
        id: "response-1", status: "completed", itemOrder: ["message-1", "tool-1"],
        items: {
          "message-1": {
            type: "message", id: "message-1", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "I’ll check the policy.", annotations: [] }],
          },
          "tool-1": {
            type: "function_call", id: "tool-1", call_id: "call-1", name: "knowledge_search",
            arguments: "{}", status: "completed",
          },
        },
      },
      "response-2": {
        id: "response-2", status: "in_progress", itemOrder: ["message-2"],
        items: {
          "message-2": {
            type: "message", id: "message-2", role: "assistant", status: "in_progress",
            content: [{ type: "output_text", text: "Grounded answer.", annotations: [] }],
          },
        },
      },
    },
  };

  assert.deepEqual(
    assistantTurnItems(turn).map((item) => [item.kind, item.kind === "tool" ? item.state : item.id]),
    [["message", "message-1"], ["message", "message-2"]],
  );
});

test("presents a verified runtime activity at its function-call position", () => {
  const turn: TurnState = {
    id: "turn-1",
    status: "streaming",
    responseOrder: ["response-1"],
    runtimeActivities: [{
      callId: "call-1", toolName: "sql_query", state: "active", startedAt: 1,
    }],
    responses: {
      "response-1": {
        id: "response-1", status: "completed", itemOrder: ["tool-1"],
        items: {
          "tool-1": {
            type: "function_call", id: "tool-1", call_id: "call-1", name: "sql_query",
            arguments: "{}", status: "completed",
          },
        },
      },
    },
  };

  assert.deepEqual(assistantTurnItems(turn), [{
    kind: "activity", id: "call-1",
    activity: { callId: "call-1", toolName: "sql_query", state: "active", startedAt: 1 },
  }]);
});

test("presents hosted shell execution with its command and captured output", () => {
  const turn: TurnState = {
    id: "turn-1",
    status: "streaming",
    responseOrder: ["response-1"],
    responses: {
      "response-1": {
        id: "response-1", status: "in_progress", itemOrder: ["run-1", "run-2"],
        items: {
          "run-1": {
            type: "hosted_execution_result", id: "run-1", call_id: "shell-1",
            status: "completed", commands: ["printf verified"],
            output: [{ stdout: "verified", stderr: "", exit_code: 0, timed_out: false }],
            workspace_files: ["analysis.csv"],
          },
          "run-2": { type: "hosted_execution_call", id: "run-2", call_id: "shell-2", status: "in_progress", commands: ["date"] },
        },
      },
    },
  };

  assert.deepEqual(assistantTurnItems(turn), [
    {
      kind: "execution", id: "run-1", callId: "shell-1", state: "completed",
      commands: ["printf verified"],
      output: [{ stdout: "verified", stderr: "", exit_code: 0, timed_out: false }],
      files: ["analysis.csv"],
    },
    {
      kind: "execution", id: "run-2", callId: "shell-2", state: "running",
      commands: ["date"], output: [], files: [],
    },
  ]);
});

test("does not render provider reasoning as user-facing commentary", () => {
  const turn = turnWithFinalMessage();
  turn.responses["response-1"]!.itemOrder.unshift("reasoning-1");
  turn.responses["response-1"]!.items["reasoning-1"] = {
    type: "reasoning", id: "reasoning-1", status: "completed",
    summary: [{ type: "summary_text", text: "I should verify the policy source." }],
  };

  assert.deepEqual(assistantTurnItems(turn), [{
    kind: "message",
    id: "message-1",
    phase: "final_answer",
    text: "The answer.",
    state: "done",
  }]);
});

function turnWithFinalMessage(): TurnState {
  return {
    id: "turn-1",
    status: "completed",
    responseOrder: ["response-1"],
    responses: {
      "response-1": {
        id: "response-1", status: "completed", itemOrder: ["message-1"],
        items: {
          "message-1": {
            type: "message", id: "message-1", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "The answer.", annotations: [] }],
          },
        },
      },
    },
  };
}

test("a shell run with a failing command names that command's own error", () => {
  const summary = executionSummary({
    kind: "execution",
    id: "run-1",
    callId: "shell-1",
    state: "failed",
    commands: ["ls ~", "python -c 'print(1)'"],
    output: [
      // A warning on a successful command is not the cause.
      { stdout: "data.xlsx\n", stderr: "warning: locale not set\n", exit_code: 0, timed_out: false },
      { stdout: "", stderr: "Traceback (most recent call last):\n  File x\nbash: python: command not found\n", exit_code: 127, timed_out: false },
    ],
    files: [],
  });

  assert.deepEqual(summary, { label: "Ran 2 commands, 1 failed", detail: "bash: python: command not found" });
});

/** A finished turn that searched, then ran three commands of which one failed. */
function fileWorkTurn(status: TurnState["status"] = "completed"): TurnState {
  return {
    id: "turn-work",
    status,
    startedAt: 1_000,
    finishedAt: 27_000,
    responseOrder: ["response-1", "response-2"],
    workLog: [{ callId: "search-1", toolName: "knowledge_search", state: "completed", resultCount: 7 }],
    responses: {
      "response-1": {
        id: "response-1", status: "completed", itemOrder: ["call-1"],
        items: {
          "call-1": {
            type: "function_call", id: "call-1", call_id: "search-1", name: "knowledge_search",
            arguments: JSON.stringify({ queries: ["vendor renewals"] }), status: "completed",
          },
        },
      },
      "response-2": {
        id: "response-2", status: "completed", itemOrder: ["run-1"],
        items: {
          "run-1": {
            type: "hosted_execution_result", id: "run-1", call_id: "shell-1", status: "completed",
            commands: ["ls ~", "python3 totals.py", "cat out.csv"],
            output: [
              { stdout: "vendors.csv\n", stderr: "", exit_code: 0, timed_out: false },
              { stdout: "", stderr: "Traceback (most recent call last):\nKeyError: 'Amount'\n", exit_code: 1, timed_out: false },
              { stdout: "vendor,total\n", stderr: "", exit_code: 0, timed_out: false },
            ],
          },
        },
      },
    },
  };
}

test("the work line names the search, the failed command and how long it took", () => {
  const work = turnWork(fileWorkTurn(), { scopeTitles: ["HR Policies"] });

  assert.equal(work.summary, "Worked for 26s · Searched HR Policies · Ran 3 commands, 1 failed");
  assert.deepEqual(work.steps.map((step) => [step.kind, step.state]), [["search", "ok"], ["code", "bad"]]);
  assert.equal(work.steps[0]?.detail, "7 relevant passages");
  assert.deepEqual(work.steps[0]?.queries, ["vendor renewals"]);
  assert.equal(work.steps[1]?.detail, "KeyError: 'Amount'");
  assert.deepEqual(work.steps[1]?.runs?.map((run) => run.failed), [false, true, false]);
  assert.equal(work.usesShell, true);
  assert.equal(work.fileWorkFailed, false);
});

test("file work that failed and saved nothing is the 'Nothing was saved' state", () => {
  const work = turnWork(fileWorkTurn("failed"));

  assert.equal(work.fileWorkFailed, true);
  assert.equal(work.summary, "Worked for 26s · Searched your knowledge · Ran 3 commands, 1 failed");
});

test("while streaming, a model call is not a step until the runtime starts it", () => {
  const turn: TurnState = { ...fileWorkTurn("streaming"), workLog: undefined, finishedAt: undefined, runtimeActivities: [] };
  turn.responses["response-2"] = { id: "response-2", status: "in_progress", itemOrder: [], items: {} };

  assert.deepEqual(turnWork(turn).steps, []);
  turn.runtimeActivities = [{ callId: "search-1", toolName: "knowledge_search", state: "active", startedAt: 0 }];
  const live = turnWork(turn, { scopeTitles: ["Finance", "Legal", "HR", "Sales"] });
  assert.equal(live.liveLabel, "Searching Finance, Legal and 2 more…");
});

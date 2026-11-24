import assert from "node:assert/strict";
import test from "node:test";

import type { IngestionTask } from "../src/modules/curation/api.ts";
import { FINISHED_TASKS, mergeTasks, nextTaskRead, shownProcessing, taskKey } from "../src/modules/curation/processingSteps.ts";

type State = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
const task = (id: string, state: State, phases: IngestionTask["phases"] = []): IngestionTask => ({ name: `workspaces/w/ingestionRuns/r/tasks/${id}`, item: `workspaces/w/items/${id}`, state, phases });
const byItem = (...tasks: IngestionTask[]) => Object.fromEntries(tasks.map((t) => [taskKey(t), t]));

test("a Processing row shows its run task's state while it has one, else its processing state", () => {
  assert.equal(shownProcessing("pending", task("a", "QUEUED")), "waiting");
  assert.equal(shownProcessing("pending", task("a", "RUNNING")), "processing");
  assert.equal(shownProcessing("pending", task("a", "FAILED")), "failed");
  assert.equal(shownProcessing("pending", task("a", "SUCCEEDED")), "ready");
  // Stopped: back to what the document is.
  assert.equal(shownProcessing("pending", task("a", "CANCELLED")), "pending");
  assert.equal(shownProcessing("outdated", undefined), "outdated");
  assert.equal(shownProcessing("failed", undefined), "failed");
});

test("a poll reads at most one thing: finished tasks when more finished, else the running ones, else nothing", () => {
  const tasks = byItem(task("a", "SUCCEEDED"), task("b", "RUNNING"), task("c", "QUEUED"), task("d", "QUEUED"));
  // Steps move while something runs.
  assert.deepEqual(nextTaskRead({ tasks, last: null }, { totalCount: 4, succeededCount: 1, runningCount: 1, queuedCount: 2 }), { kind: "running" });
  // Every task waits for a slot and nothing new finished: no read at all.
  assert.equal(nextTaskRead({ tasks: byItem(task("c", "QUEUED")), last: null }, { totalCount: 1, queuedCount: 1 }), null);
  // Two more finished (one failed, one cancelled): the latest ones, with room for what finishes meanwhile.
  const counts = { totalCount: 4, succeededCount: 1, failedCount: 1, cancelledCount: 1, runningCount: 1 };
  const read = nextTaskRead({ tasks, last: null }, counts);
  assert.equal(read?.kind, "finished");
  assert.ok(read?.kind === "finished" && read.limit >= 2 && read.limit <= 1000);
  // Both changed: they take turns, so the running steps never wait more than one poll.
  assert.deepEqual(nextTaskRead({ tasks, last: "finished" }, counts), { kind: "running" });
  assert.equal(nextTaskRead({ tasks, last: "running" }, counts)?.kind, "finished");
  // Nothing running any more: the finished read every poll until they're all known.
  assert.equal(nextTaskRead({ tasks, last: "finished" }, { ...counts, runningCount: 0 })?.kind, "finished");
  assert.match(FINISHED_TASKS, /SUCCEEDED/);
});

test("merging a poll keeps unchanged tasks and never moves a finished task back", () => {
  const a = task("a", "SUCCEEDED");
  const known = byItem(a, task("b", "RUNNING"), task("c", "QUEUED"));
  // A poll that read nothing (or only what's settled) keeps the very same object (no re-render).
  assert.equal(mergeTasks(known, []), known);
  assert.equal(mergeTasks(known, [task("a", "RUNNING")]), known);
  const b2 = task("b", "RUNNING", [{ phase: "CLASSIFYING", state: "RUNNING" }]);
  const c2 = task("c", "RUNNING");
  const next = mergeTasks(known, [b2, c2, task("a", "RUNNING")]);
  assert.equal(next.a, a);
  assert.equal(next.b, b2);
  assert.equal(next.c, c2);
  const done = mergeTasks(next, [task("b", "SUCCEEDED"), task("d", "FAILED")]);
  assert.equal(done.b?.state, "SUCCEEDED");
  assert.equal(done.d?.state, "FAILED");
});

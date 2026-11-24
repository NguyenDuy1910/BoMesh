import assert from "node:assert/strict";
import test from "node:test";

import type { IngestionTask } from "../src/modules/curation/api.ts";
import { FIRST_RUN_PAGE, nextRunTaskCursor, shownProcessing, taskKey } from "../src/modules/curation/processingSteps.ts";

type State = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
const task = (id: string, state: State, phases: IngestionTask["phases"] = []): IngestionTask => ({ name: `workspaces/w/ingestionRuns/r/tasks/${id}`, item: `workspaces/w/items/${id}`, state, phases });

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

test("a task's key is its item ID (task ID = item ID), from the item or else the task name", () => {
  assert.equal(taskKey(task("a", "QUEUED")), "a");
  assert.equal(taskKey({ name: "workspaces/w/ingestionRuns/r/tasks/b" }), "b");
  assert.equal(taskKey({}), "");
});

test("the run pills page through each run in flight, then the next run, then stop", () => {
  // The run has more pages: its next page.
  assert.deepEqual(nextRunTaskCursor(FIRST_RUN_PAGE, "t1", 2), { run: 0, token: "t1" });
  // The run's last page with another run in flight: that run's first page.
  assert.deepEqual(nextRunTaskCursor({ run: 0, token: "t1" }, undefined, 2), { run: 1, token: "" });
  assert.deepEqual(nextRunTaskCursor({ run: 0, token: "" }, "", 2), { run: 1, token: "" });
  // The last run's last page: no next page.
  assert.equal(nextRunTaskCursor({ run: 1, token: "t9" }, undefined, 2), null);
  assert.equal(nextRunTaskCursor(FIRST_RUN_PAGE, undefined, 1), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeScope,
  formatDuration,
  retryableCount,
  runProgress,
  runSteps,
  type ScopeNames,
} from "../src/modules/ingestion/run-state.ts";
import type { IngestionRunCounts, IngestionRunScope } from "../src/modules/ingestion/runs-api.ts";

const names: ScopeNames = {
  collection: (id) => ({ c1: "Finance" })[id],
  source: (id) => ({ s1: "Engineering space" })[id],
};

function scope(overrides: Partial<IngestionRunScope> = {}): IngestionRunScope {
  return {
    selected_documents: null,
    collection_id: null,
    source_id: null,
    states: ["pending", "outdated"],
    retry_of_run_id: null,
    ...overrides,
  };
}

function counts(overrides: Partial<IngestionRunCounts> = {}): IngestionRunCounts {
  return { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0, ...overrides };
}

test("a run says what it processed and where, by name", () => {
  assert.equal(describeScope(scope(), names), "Pending and outdated documents in the workspace");
  assert.equal(describeScope(scope({ collection_id: "c1" }), names), "Pending and outdated documents in Finance");
  assert.equal(describeScope(scope({ source_id: "s1", states: ["failed"] }), names), "Failed documents from Engineering space");
  assert.equal(
    describeScope(scope({ states: ["pending", "outdated", "failed"] }), names),
    "Pending, outdated and failed documents in the workspace",
  );
});

test("an explicit selection and a retry outrank the selectors they carry", () => {
  assert.equal(describeScope(scope({ selected_documents: 1, collection_id: "c1" }), names), "1 selected document");
  assert.equal(describeScope(scope({ selected_documents: 12 }), names), "12 selected documents");
  assert.equal(
    describeScope(scope({ retry_of_run_id: "r0", selected_documents: 3 }), names),
    "Retry of documents that did not finish",
  );
});

test("a collection or source no longer listed is still described", () => {
  assert.equal(describeScope(scope({ collection_id: "gone" }), names), "Pending and outdated documents in a knowledge base");
  assert.equal(describeScope(scope({ source_id: "gone" }), names), "Pending and outdated documents from a source");
});

test("progress counts every document that reached an outcome, failed included", () => {
  assert.deepEqual(
    runProgress({ counts: counts({ total: 200, succeeded: 170, failed: 12, running: 8, queued: 10 }) }),
    { done: 182, total: 200, percent: 91 },
  );
  // Skipped and cancelled documents did not reach an outcome.
  assert.deepEqual(runProgress({ counts: counts({ total: 4, succeeded: 1, skipped: 2, cancelled: 1 }) }).done, 1);
  assert.deepEqual(runProgress({ counts: counts() }), { done: 0, total: 0, percent: 0 });
});

test("a sync's steps follow its counts, and a stopped sync says where it stopped", () => {
  const states = (status: "queued" | "running" | "completed" | "failed" | "cancelled", c = counts(), error: string | null = null) =>
    runSteps({ status, counts: c, error }).map((step) => `${step.state}: ${step.note}`);

  assert.deepEqual(states("running", counts({ total: 28, succeeded: 18, failed: 2 })), [
    "done: Found 28 documents to process",
    "active: 20 of 28 read",
    "active: 18 ready for questions",
  ]);
  assert.deepEqual(states("completed", counts({ total: 10, succeeded: 8, failed: 2 })), [
    "done: Found 10 documents to process",
    "done: 8 read · 2 couldn’t be read",
    "done: 8 ready for questions",
  ]);
  assert.deepEqual(states("cancelled", counts({ total: 24, succeeded: 6, cancelled: 18 }))[1], "stopped: Stopped after 6 of 24");
  // A run that never got going blames the first step, with the reason it was given.
  assert.deepEqual(states("failed", counts(), "The model provider refused the key."), [
    "failed: The model provider refused the key.",
    "pending: Not started",
    "pending: Not started",
  ]);
});

test("a retry takes failed, skipped and cancelled documents, never processed ones", () => {
  assert.equal(retryableCount({ counts: counts({ total: 30, succeeded: 20, failed: 4, skipped: 1, cancelled: 5 }) }), 10);
  assert.equal(retryableCount({ counts: counts({ total: 3, succeeded: 3 }) }), 0);
});

test("durations read the way the history table shows them", () => {
  assert.equal(formatDuration(4_200), "4s");
  assert.equal(formatDuration(379_000), "6m 19s");
  assert.equal(formatDuration(3_725_000), "1h 2m");
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  describeScope,
  runProgress,
  runStatus,
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
  assert.equal(describeScope(scope({ collection_id: "gone" }), names), "Pending and outdated documents in a collection");
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

test("a completed run with failed documents reads differently from a clean one", () => {
  assert.equal(runStatus({ status: "completed", counts: counts({ total: 3, succeeded: 3 }) }), "completed");
  assert.equal(
    runStatus({ status: "completed", counts: counts({ total: 3, succeeded: 2, failed: 1 }) }),
    "completed_with_errors",
  );
  // A run that stopped is a failure of the run, whatever its items did.
  assert.equal(runStatus({ status: "failed", counts: counts({ total: 3, failed: 1, skipped: 2 }) }), "failed");
});

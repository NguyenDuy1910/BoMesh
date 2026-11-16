import assert from "node:assert/strict";
import test from "node:test";

import { canProcess, inSearch, isIssue, isUnprocessable, PROCESSING_ORDER, PROCESSING_STATE, processingOf, publicationOf } from "../src/modules/curation/lifecycle.ts";

type Doc = {
  publicationState?: "PUBLISHED" | "UNPUBLISHED";
  indexingState?: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "OUTDATED" | "UNSUPPORTED";
  contentState?: "PENDING" | "AVAILABLE" | "FAILED";
  fileName?: string;
  mimeType?: string;
  qualityIssues?: { kind: "CHANGED_AT_SOURCE" | "REVIEW_DUE" }[];
};

const item = (document: Doc, extra: { state?: "ACTIVE" | "DELETED" } = {}) =>
  ({ name: "workspaces/w/items/d1", state: "ACTIVE", ...extra, document: { fileName: "Policy.pdf", mimeType: "application/pdf", contentState: "AVAILABLE", ...document } }) as never;
const contribution = (state: string) => ({ name: "workspaces/w/contributions/c1", state }) as never;

test("publication: an open or declined submission decides, else the item's publicationState", () => {
  assert.equal(publicationOf({ contribution: contribution("ANALYZING") }), "review");
  assert.equal(publicationOf({ item: item({ publicationState: "UNPUBLISHED" }), contribution: contribution("IN_REVIEW") }), "review");
  assert.equal(publicationOf({ contribution: contribution("CHANGES_REQUESTED") }), "changes");
  assert.equal(publicationOf({ contribution: contribution("REJECTED") }), "rejected");
  assert.equal(publicationOf({ item: item({ publicationState: "PUBLISHED" }), contribution: contribution("APPROVED") }), "published");
  assert.equal(publicationOf({ item: item({ publicationState: "UNPUBLISHED" }) }), "unpublished");
  assert.equal(publicationOf({ item: item({ publicationState: "PUBLISHED" }) }), "published");
});

test("processing follows indexingState, independent of publication", () => {
  const cases = [
    ["PENDING", "pending"],
    ["RUNNING", "processing"],
    ["SUCCEEDED", "ready"],
    ["FAILED", "failed"],
    ["OUTDATED", "outdated"],
    ["UNSUPPORTED", "unsupported"],
  ] as const;
  for (const [indexingState, key] of cases) {
    for (const publicationState of ["PUBLISHED", "UNPUBLISHED"] as const) {
      assert.equal(processingOf({ item: item({ indexingState, publicationState }) }), key, `${indexingState}/${publicationState}`);
    }
    assert.equal(PROCESSING_STATE[key], indexingState);
  }
  assert.deepEqual([...PROCESSING_ORDER], ["pending", "processing", "ready", "failed", "outdated", "unsupported"]);
});

test("processing: submissions aren't processed, missing state is Not processed, failed content fails, changed at source is outdated", () => {
  assert.equal(processingOf({ item: item({ indexingState: "SUCCEEDED" }), contribution: contribution("IN_REVIEW") }), "pending");
  assert.equal(processingOf({ item: item({}) }), "pending");
  assert.equal(processingOf({}), "pending");
  assert.equal(processingOf({ item: item({ contentState: "FAILED", indexingState: "PENDING" }) }), "failed");
  assert.equal(processingOf({ item: item({ indexingState: "SUCCEEDED", qualityIssues: [{ kind: "CHANGED_AT_SOURCE" }] }) }), "outdated");
  assert.equal(processingOf({ item: item({ indexingState: "SUCCEEDED", qualityIssues: [{ kind: "REVIEW_DUE" }] }) }), "ready");
});

test("searchable needs published and processed", () => {
  assert.equal(inSearch({ item: item({ publicationState: "PUBLISHED", indexingState: "SUCCEEDED" }) }), true);
  assert.equal(inSearch({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING" }) }), false);
  assert.equal(inSearch({ item: item({ publicationState: "UNPUBLISHED", indexingState: "SUCCEEDED" }) }), false);
  assert.equal(inSearch({ item: item({ publicationState: "PUBLISHED", indexingState: "SUCCEEDED" }), contribution: contribution("IN_REVIEW") }), false);
});

test("canProcess: published or unpublished, not running, not unsupported, not an image or archive, not a submission", () => {
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING" }) }), true);
  assert.equal(canProcess({ item: item({ publicationState: "UNPUBLISHED", indexingState: "FAILED" }) }), true);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "SUCCEEDED" }) }), true);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "RUNNING" }) }), false);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "UNSUPPORTED" }) }), false);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING", fileName: "scan.png", mimeType: "image/png" }) }), false);
  assert.equal(canProcess({ item: item({ publicationState: "UNPUBLISHED", indexingState: "PENDING" }), contribution: contribution("IN_REVIEW") }), false);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING" }, { state: "DELETED" }) }), false);
});

test("images and archives can't be processed", () => {
  assert.equal(isUnprocessable("photo.JPG"), true);
  assert.equal(isUnprocessable("bundle.zip"), true);
  assert.equal(isUnprocessable("x", "application/x-7z-compressed"), true);
  assert.equal(isUnprocessable("x", "image/webp"), true);
  assert.equal(isUnprocessable("Policy.pdf", "application/pdf"), false);
  assert.equal(isUnprocessable("notes.md", "text/markdown"), false);
});

test("Issues: failed or outdated, published or unpublished; never submissions or Not processed", () => {
  assert.equal(isIssue({ item: item({ publicationState: "PUBLISHED", indexingState: "FAILED" }) }), true);
  assert.equal(isIssue({ item: item({ publicationState: "UNPUBLISHED", indexingState: "OUTDATED" }) }), true);
  assert.equal(isIssue({ item: item({ publicationState: "PUBLISHED", indexingState: "SUCCEEDED", qualityIssues: [{ kind: "CHANGED_AT_SOURCE" }] }) }), true);
  assert.equal(isIssue({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING" }) }), false);
  assert.equal(isIssue({ item: item({ publicationState: "UNPUBLISHED", indexingState: "FAILED" }), contribution: contribution("CHANGES_REQUESTED") }), false);
});

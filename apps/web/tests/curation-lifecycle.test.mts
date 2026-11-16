import assert from "node:assert/strict";
import test from "node:test";

import { canProcess, inSearch, isUnprocessable, PROCESSING_ORDER, PROCESSING_STATE, processingOf, publicationOf, readyToReview, toProcess } from "../src/modules/curation/lifecycle.ts";

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
const contribution = (state: string, kind = "NEW_DOCUMENT") => ({ name: "workspaces/w/contributions/c1", state, kind }) as never;

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

test("processing: a new document's submission has its candidate's state; a new version's or a decided one isn't processed", () => {
  assert.equal(processingOf({ item: item({ indexingState: "SUCCEEDED" }), contribution: contribution("IN_REVIEW") }), "ready");
  assert.equal(processingOf({ item: item({ indexingState: "PENDING", fileName: "scan.png", mimeType: "image/png" }), contribution: contribution("IN_REVIEW") }), "unsupported");
  assert.equal(processingOf({ item: item({ indexingState: "SUCCEEDED" }), contribution: contribution("IN_REVIEW", "NEW_REVISION") }), "pending");
  assert.equal(processingOf({ item: item({ indexingState: "SUCCEEDED" }), contribution: contribution("CHANGES_REQUESTED") }), "pending");
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

test("canProcess: published, unpublished or a new document's submission; not running, unsupported, an image or archive", () => {
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING" }) }), true);
  assert.equal(canProcess({ item: item({ publicationState: "UNPUBLISHED", indexingState: "FAILED" }) }), true);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "SUCCEEDED" }) }), true);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "RUNNING" }) }), false);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "UNSUPPORTED" }) }), false);
  assert.equal(canProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING", fileName: "scan.png", mimeType: "image/png" }) }), false);
  assert.equal(canProcess({ item: item({ publicationState: "UNPUBLISHED", indexingState: "PENDING" }), contribution: contribution("IN_REVIEW") }), true);
  assert.equal(canProcess({ item: item({ publicationState: "UNPUBLISHED", indexingState: "PENDING" }), contribution: contribution("IN_REVIEW", "NEW_REVISION") }), false);
  assert.equal(canProcess({ item: item({ publicationState: "UNPUBLISHED", indexingState: "PENDING" }), contribution: contribution("CHANGES_REQUESTED") }), false);
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

test("Review: a new document once processed (or one that can't be), every new version; never a decided submission", () => {
  assert.equal(readyToReview(contribution("IN_REVIEW"), item({ indexingState: "PENDING" })), false);
  assert.equal(readyToReview(contribution("IN_REVIEW"), item({ indexingState: "RUNNING" })), false);
  assert.equal(readyToReview(contribution("IN_REVIEW"), item({ indexingState: "FAILED" })), false);
  assert.equal(readyToReview(contribution("IN_REVIEW"), item({ indexingState: "SUCCEEDED" })), true);
  assert.equal(readyToReview(contribution("IN_REVIEW"), item({ indexingState: "UNSUPPORTED" })), true);
  assert.equal(readyToReview(contribution("IN_REVIEW", "NEW_REVISION"), item({ indexingState: "PENDING" })), true);
  assert.equal(readyToReview(contribution("CHANGES_REQUESTED"), item({ indexingState: "SUCCEEDED" })), false);
});

test("Processing: what isn't processed for its current revision, submissions of new documents included", () => {
  assert.equal(toProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "PENDING" }) }), true);
  assert.equal(toProcess({ item: item({ publicationState: "UNPUBLISHED", indexingState: "FAILED" }) }), true);
  assert.equal(toProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "SUCCEEDED", qualityIssues: [{ kind: "CHANGED_AT_SOURCE" }] }) }), true);
  assert.equal(toProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "SUCCEEDED" }) }), false);
  assert.equal(toProcess({ item: item({ publicationState: "PUBLISHED", indexingState: "UNSUPPORTED" }) }), false);
  assert.equal(toProcess({ item: item({ indexingState: "PENDING" }), contribution: contribution("IN_REVIEW") }), true);
  assert.equal(toProcess({ item: item({ indexingState: "SUCCEEDED" }), contribution: contribution("IN_REVIEW") }), false);
  assert.equal(toProcess({ item: item({ indexingState: "PENDING" }), contribution: contribution("IN_REVIEW", "NEW_REVISION") }), false);
});

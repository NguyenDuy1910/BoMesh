import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { REVIEW_READY, SUBMISSIONS_TO_PROCESS, processingDocuments, processingSubmissions, reviewFilter } = await import("../src/modules/curation/docFilter.ts");
const { FIRST_PAGE, walkPage } = await import("../src/modules/curation/processingSteps.ts");

const WS = "w1";
const DOCS = 'itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND ancestors:"workspaces/w1/items/a"';
const TO_PROCESS = "(document.indexingState = PENDING OR document.indexingState = RUNNING OR document.indexingState = FAILED OR document.indexingState = OUTDATED)";

test("review: ready to decide, then the queue filter, the target collection and the name search", () => {
  assert.equal(reviewFilter({ queue: "all", collection: "", q: "" }, WS), REVIEW_READY);
  assert.equal(reviewFilter({ queue: "version", collection: "kb2", q: " thông tư* " }, WS), `${REVIEW_READY} AND kind = NEW_REVISION AND targetCollection = "workspaces/w1/items/kb2" AND itemDisplayName = "*thông tư*"`);
  assert.equal(reviewFilter({ queue: "sync", collection: "workspaces/w1/items/f9", q: "" }, WS), `${REVIEW_READY} AND origin = SOURCE AND targetCollection = "workspaces/w1/items/f9"`);
  assert.equal(
    reviewFilter({ queue: "flagged", collection: "", q: "" }, WS),
    `${REVIEW_READY} AND (flags:DUPLICATE OR flags:NEW_REVISION OR flags:PERSONAL_DATA OR flags:UNSEARCHABLE_FORMAT OR kind = NEW_REVISION)`,
  );
});

test("processing: submissions and documents per pill, collection and search", () => {
  const none = { state: "", kb: "", q: "" } as const;
  assert.equal(processingSubmissions(none, WS), SUBMISSIONS_TO_PROCESS);
  assert.equal(processingDocuments(["workspaces/w1/items/a"], none, WS), `${DOCS} AND ${TO_PROCESS}`);
  assert.equal(processingSubmissions({ state: "failed", kb: "kb2", q: "x" }, WS), `${SUBMISSIONS_TO_PROCESS} AND itemIndexingState = FAILED AND targetCollection = "workspaces/w1/items/kb2" AND itemDisplayName = "*x*"`);
  assert.equal(
    processingDocuments(["workspaces/w1/items/a", "workspaces/w1/items/b"], { state: "processing", kb: "kb2", q: "x" }, WS),
    'itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND ancestors:"workspaces/w1/items/kb2" AND (document.indexingState = RUNNING) AND displayName = "*x*"',
  );
  // A submission is never changed at its source; without a collection there are no documents.
  assert.equal(processingSubmissions({ state: "outdated", kb: "", q: "" }, WS), null);
  assert.equal(processingDocuments([], none, WS), null);
});

/** A list of `n` rows read with offset page tokens, recording each read. */
function list(prefix: string, n: number, reads: string[]) {
  return async (token: string, size: number) => {
    reads.push(`${prefix}@${token || 0}+${size}`);
    const from = Number(token || 0);
    const rows = Array.from({ length: Math.max(0, Math.min(size, n - from)) }, (_, i) => `${prefix}${from + i}`);
    return { rows, next: from + size < n ? String(from + size) : "" };
  };
}

test("a Processing page walks the submissions, fills the page that ends them with documents, then pages the documents", async () => {
  const reads: string[] = [];
  const read = { submissions: list("s", 7, reads), documents: list("d", 12, reads) };
  const p1 = await walkPage(FIRST_PAGE, 5, read);
  assert.deepEqual([p1.submissions, p1.documents, p1.next], [["s0", "s1", "s2", "s3", "s4"], [], { list: "submissions", token: "5" }]);
  const p2 = await walkPage(p1.next!, 5, read);
  assert.deepEqual([p2.submissions, p2.documents, p2.next], [["s5", "s6"], ["d0", "d1", "d2"], { list: "documents", token: "3" }]);
  const p3 = await walkPage(p2.next!, 5, read);
  assert.deepEqual([p3.submissions, p3.documents, p3.next], [[], ["d3", "d4", "d5", "d6", "d7"], { list: "documents", token: "8" }]);
  const p4 = await walkPage(p3.next!, 5, read);
  assert.deepEqual([p4.documents, p4.next], [["d8", "d9", "d10", "d11"], null]);
  assert.deepEqual(reads, ["s@0+5", "s@5+5", "d@0+3", "d@3+5", "d@8+5"]);
});

test("a page walk without one of the lists, or ending the submissions exactly", async () => {
  const reads: string[] = [];
  const docsOnly = await walkPage(FIRST_PAGE, 5, { submissions: null, documents: list("d", 2, reads) });
  assert.deepEqual([docsOnly.documents, docsOnly.next], [["d0", "d1"], null]);
  const subsOnly = await walkPage(FIRST_PAGE, 5, { submissions: list("s", 3, reads), documents: null });
  assert.deepEqual([subsOnly.submissions, subsOnly.next], [["s0", "s1", "s2"], null]);
  const exact = await walkPage(FIRST_PAGE, 5, { submissions: list("s", 5, reads), documents: list("d", 2, reads) });
  assert.deepEqual([exact.submissions.length, exact.documents, exact.next], [5, [], { list: "documents", token: "" }]);
});

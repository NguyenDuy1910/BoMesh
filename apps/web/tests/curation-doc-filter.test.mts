import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { aipString, docQueryOf, documentFilter, listFilter } = await import("../src/modules/curation/docFilter.ts");

const WS = "w1";
const query = (qs: string) => {
  const p = new URLSearchParams(qs);
  return docQueryOf((k) => p.get(k));
};
const filter = (qs: string, scope: string[] = ["workspaces/w1/items/kb1"]) => documentFilter(query(qs), { workspace: WS, scope });

test("no filters: the collections the caller looks after", () => {
  assert.equal(filter(""), 'ancestors:"workspaces/w1/items/kb1"');
  assert.equal(filter("", ["workspaces/w1/items/a", "workspaces/w1/items/b"]), '(ancestors:"workspaces/w1/items/a" OR ancestors:"workspaces/w1/items/b")');
  assert.equal(filter("", []), "");
});

test("processing-state pills map to document.indexingState", () => {
  const states = { pending: "PENDING", processing: "RUNNING", ready: "SUCCEEDED", failed: "FAILED", outdated: "OUTDATED", unsupported: "UNSUPPORTED" };
  for (const [pill, state] of Object.entries(states)) {
    assert.equal(filter(`processing=${pill}`), `ancestors:"workspaces/w1/items/kb1" AND document.indexingState = ${state}`, pill);
  }
  assert.equal(filter("processing=bogus"), 'ancestors:"workspaces/w1/items/kb1"');
});

test("facets: the Collection replaces the scope; bare IDs become resource names", () => {
  assert.equal(
    filter("kb=kb2&pub=unpublished&type=spreadsheet&topic=t9&src=s1&processing=pending"),
    [
      'ancestors:"workspaces/w1/items/kb2"',
      "document.indexingState = PENDING",
      "document.publicationState = UNPUBLISHED",
      'document.origin.source = "workspaces/w1/sources/s1"',
      "itemType = SPREADSHEET",
      'document.topics:"workspaces/w1/topics/t9"',
    ].join(" AND "),
  );
  assert.equal(filter("kb=workspaces/w1/items/kb3"), 'ancestors:"workspaces/w1/items/kb3"');
  assert.equal(filter("pub=published"), 'ancestors:"workspaces/w1/items/kb1" AND document.publicationState = PUBLISHED');
  assert.equal(filter("pub=review"), 'ancestors:"workspaces/w1/items/kb1"');
});

test("uploads and contributions have no source", () => {
  assert.equal(filter("src=upload"), 'ancestors:"workspaces/w1/items/kb1" AND document.origin.source = null');
  assert.equal(filter("src=contrib"), 'ancestors:"workspaces/w1/items/kb1" AND document.origin.source = null');
});

test("search is a wildcard on the name, quoted and escaped", () => {
  assert.equal(filter("q=  2015  "), 'ancestors:"workspaces/w1/items/kb1" AND displayName = "*2015*"');
  assert.equal(filter(`q=${encodeURIComponent('say "hi" \\ *now*')}`), 'ancestors:"workspaces/w1/items/kb1" AND displayName = "*say \\"hi\\" \\\\ now*"');
  assert.equal(aipString('a"b\\c'), '"a\\"b\\\\c"');
});

test("the list adds knowledge documents to the document filter", () => {
  assert.equal(listFilter(filter("processing=failed")), 'itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND ancestors:"workspaces/w1/items/kb1" AND document.indexingState = FAILED');
  assert.equal(listFilter(""), "itemKind = DOCUMENT AND document.purpose = KNOWLEDGE");
});

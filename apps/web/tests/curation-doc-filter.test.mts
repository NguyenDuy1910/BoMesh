import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { aipString, conceptGap, conceptOfParam, conceptParam, contributionsOf, curatedFilter, detailsFilter, docQueryOf, documentFilter, documentsToProcess, listFilter, nameSearch, reverifyFilter } = await import(
  "../src/modules/curation/docFilter.ts"
);

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
    filter("kb=kb2&pub=unpublished&type=spreadsheet&concept=domain/it&src=s1&processing=pending"),
    [
      'ancestors:"workspaces/w1/items/kb2"',
      "document.indexingState = PENDING",
      "document.publicationState = UNPUBLISHED",
      'document.origin.source = "workspaces/w1/sources/s1"',
      "itemType = SPREADSHEET",
      'document.concepts:"workspaces/w1/conceptSchemes/domain/concepts/it"',
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

test("queue filters keep the scope as one OR group and AND their clauses", () => {
  const scope = ["workspaces/w1/items/a", "workspaces/w1/items/b"];
  assert.equal(
    documentsToProcess(scope, ["FAILED", "OUTDATED"]),
    'itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND (ancestors:"workspaces/w1/items/a" OR ancestors:"workspaces/w1/items/b") AND (document.indexingState = FAILED OR document.indexingState = OUTDATED)',
  );
  assert.equal(curatedFilter(["workspaces/w1/items/a"], "", "x = 1"), 'itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND ancestors:"workspaces/w1/items/a" AND x = 1');
});

test("a page's contributions are read by candidate name, quoted", () => {
  assert.equal(contributionsOf(["workspaces/w1/items/a", 'b"c']), 'item = "workspaces/w1/items/a" OR item = "b\\"c"');
  assert.equal(contributionsOf([]), "");
});

const DOCS_A = 'itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND ancestors:"workspaces/w1/items/a"';

test("quality lists: every reason or gap, or one of them", () => {
  const scope = ["workspaces/w1/items/a"];
  const due = `${DOCS_A} AND document.publicationState = PUBLISHED AND document.indexingState != OUTDATED AND`;
  assert.equal(reverifyFilter(scope), `${due} (document.verification.state = REVIEW_DUE OR (document.verification.state = UNVERIFIED AND document.indexingState = SUCCEEDED))`);
  assert.equal(reverifyFilter(scope, "expired"), `${due} document.verification.state = REVIEW_DUE`);
  assert.equal(reverifyFilter(scope, "never"), `${due} (document.verification.state = UNVERIFIED AND document.indexingState = SUCCEEDED)`);
  const published = `${DOCS_A} AND document.publicationState = PUBLISHED AND`;
  assert.equal(detailsFilter(scope), `${published} (NOT document.concepts:* OR NOT document.owner:* OR NOT document.summary:*)`);
  assert.equal(detailsFilter(scope, "summary"), `${published} NOT document.summary:*`);
  assert.equal(detailsFilter(scope, "concept"), `${published} NOT document.concepts:*`);
});

test("missing a classification: nothing accepted, or nothing in a scheme that requires a label", () => {
  const s = "workspaces/w1/conceptSchemes";
  assert.equal(conceptGap(), "NOT document.concepts:*");
  assert.equal(
    conceptGap([`${s}/type`, `${s}/audience`]),
    `(NOT document.concepts:* OR NOT document.concepts:"${s}/type" OR NOT document.concepts:"${s}/audience")`,
  );
  const published = `${DOCS_A} AND document.publicationState = PUBLISHED AND`;
  assert.equal(
    detailsFilter(["workspaces/w1/items/a"], undefined, [`${s}/type`]),
    `${published} ((NOT document.concepts:* OR NOT document.concepts:"${s}/type") OR NOT document.owner:* OR NOT document.summary:*)`,
  );
});

test("a concept in the address: {scheme}/{concept} ↔ its full name", () => {
  assert.equal(conceptOfParam(WS, "domain/it"), "workspaces/w1/conceptSchemes/domain/concepts/it");
  assert.equal(conceptOfParam(WS, "workspaces/w1/conceptSchemes/domain/concepts/it"), "workspaces/w1/conceptSchemes/domain/concepts/it");
  assert.equal(conceptParam("workspaces/w1/conceptSchemes/domain/concepts/it"), "domain/it");
  assert.equal(filter("concept=workspaces/w1/conceptSchemes/domain/concepts/ai"), 'ancestors:"workspaces/w1/items/kb1" AND document.concepts:"workspaces/w1/conceptSchemes/domain/concepts/ai"');
});

test("name search drops typed wildcards; blank searches nothing", () => {
  assert.equal(nameSearch("  thông tư* "), 'displayName = "*thông tư*"');
  assert.equal(nameSearch("  "), "");
  assert.equal(nameSearch("*"), "");
});

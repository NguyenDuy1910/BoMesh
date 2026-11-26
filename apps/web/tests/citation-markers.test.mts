import assert from "node:assert/strict";
import test from "node:test";

import {
  CITATION_ELEMENT,
  CITATION_NUMBER_PROPERTY,
  rehypeCitationMarkers,
  splitCitationMarkers,
} from "../src/modules/chat/citation-markers.ts";
import { answerFreshness, markerNumbers, plainAnswer, sourceLookup, sourcesFromCitations, type StoredCitation } from "../src/modules/chat/citations.ts";

function text(value: string) {
  return { type: "text", value };
}

function element(tagName: string, children: unknown[]) {
  return { type: "element", tagName, properties: {}, children };
}

// --- marker splitting -----------------------------------------------------

test("a claim keeps its citation where the model placed it", () => {
  assert.deepEqual(
    splitCitationMarkers("You must create one VPC endpoint for each name. [1] Next."),
    [
      { type: "text", value: "You must create one VPC endpoint for each name. " },
      { type: "citation", number: 1, value: "[1]" },
      { type: "text", value: " Next." },
    ],
  );
});

test("one claim can carry several citations", () => {
  assert.deepEqual(
    splitCitationMarkers("Both apply. [1][2]").filter((s) => s.type === "citation"),
    [
      { type: "citation", number: 1, value: "[1]" },
      { type: "citation", number: 2, value: "[2]" },
    ],
  );
});

test("a repeated citation is split at every occurrence", () => {
  const numbers = splitCitationMarkers("First. [1] Second. [1]")
    .filter((segment) => segment.type === "citation")
    .map((segment) => (segment.type === "citation" ? segment.number : 0));

  assert.deepEqual(numbers, [1, 1]);
});

test("text without a marker is returned unchanged as one run", () => {
  assert.deepEqual(splitCitationMarkers("A plain answer."), [
    { type: "text", value: "A plain answer." },
  ]);
  // An array index is not a citation marker shape.
  assert.deepEqual(splitCitationMarkers("items[i]"), [{ type: "text", value: "items[i]" }]);
});

// --- rehype placement -----------------------------------------------------

test("markers become citation elements inside the block that holds them", () => {
  const tree = element("root", [
    element("p", [text("A claim. [1] More.")]),
  ]);

  rehypeCitationMarkers()(tree as never);

  const paragraph = (tree.children[0] as ReturnType<typeof element>);
  assert.equal(paragraph.children.length, 3);
  const chip = paragraph.children[1] as {
    tagName: string;
    properties: Record<string, string>;
    children: Array<{ value: string }>;
  };
  assert.equal(chip.tagName, CITATION_ELEMENT);
  assert.equal(chip.properties[CITATION_NUMBER_PROPERTY], "1");
  // The literal text is retained so an unresolved number can fall back to it.
  assert.equal(chip.children[0].value, "[1]");
});

test("code and links keep their literal brackets", () => {
  const tree = element("root", [
    element("pre", [element("code", [text("array[1]")])]),
    element("a", [text("see [1]")]),
  ]);

  rehypeCitationMarkers()(tree as never);

  const code = (tree.children[0] as ReturnType<typeof element>)
    .children[0] as ReturnType<typeof element>;
  assert.equal(code.children.length, 1);
  assert.equal((code.children[0] as { value: string }).value, "array[1]");
  const link = tree.children[1] as ReturnType<typeof element>;
  assert.equal(link.children.length, 1);
});

test("nested inline formatting still gets its chip", () => {
  const tree = element("root", [
    element("p", [element("strong", [text("Bold claim. [2]")])]),
  ]);

  rehypeCitationMarkers()(tree as never);

  const strong = (tree.children[0] as ReturnType<typeof element>)
    .children[0] as ReturnType<typeof element>;
  assert.equal(strong.children.length, 2);
  assert.equal((strong.children[1] as { tagName: string }).tagName, CITATION_ELEMENT);
});

// --- resolution of stored answers -------------------------------------------

const ws = "workspaces/w/items";
const cited = (doc: string, ref: string, extra: Partial<StoredCitation> = {}): StoredCitation => ({
  available: true,
  item: `${ws}/${doc}`,
  revision: `${ws}/${doc}/revisions/1`,
  structureVersion: "0123456789abcdef",
  refs: [ref],
  quote: `quote ${ref}`,
  location: "",
  ...extra,
});

test("references of one document share its number, in first-use order", () => {
  const sources = sourcesFromCitations("Leave is 20 weeks [1]. Tell People Ops [2]. Paid in full [1].", [
    cited("a", "texts/1", { displayName: "Parental leave.pdf", location: "2. Eligibility", highlights: [{ pageNumber: 2, boxes: [] }] }),
    cited("b", "texts/9", { displayName: "Handbook.pdf", highlights: [{ pageNumber: 18, boxes: [] }] }),
    cited("a", "tables/0", { displayName: "Parental leave.pdf", highlights: [{ sheet: "Leave", cellRange: "A2:C4" }] }),
  ]);
  assert.deepEqual(
    sources.map((s) => [s.n, s.title, s.references.map((r) => [r.refs.join(), r.location, r.highlights])]),
    [
      [1, "Parental leave.pdf", [["texts/1", "2. Eligibility", [{ pageNumber: 2, boxes: [] }]], ["tables/0", "", [{ sheet: "Leave", cellRange: "A2:C4" }]]]],
      [2, "Handbook.pdf", [["texts/9", "", [{ pageNumber: 18, boxes: [] }]]]],
    ],
  );
  assert.equal(sources[0]!.references[0]!.revision, `${ws}/a/revisions/1`);
  assert.equal(sources[0]!.aliases, undefined);
});

test("an answer saved with one number per citation resolves every old number", () => {
  const sources = sourcesFromCitations("A [1]. B [2]. C [3].", [cited("a", "texts/1"), cited("a", "texts/2"), cited("b", "texts/3")]);
  const lookup = sourceLookup(sources);
  assert.equal(lookup.get(1)?.item, `${ws}/a`);
  assert.equal(lookup.get(2)?.item, `${ws}/a`);
  assert.equal(lookup.get(3)?.item, `${ws}/b`);
  assert.deepEqual(sources.map((s) => [s.n, s.aliases]), [[1, [2]], [3, undefined]]);
});

test("a citation the reader can no longer open keeps its number without a document", () => {
  const sources = sourcesFromCitations("Open [1]. Closed [2].", [cited("a", "texts/1"), { available: false }]);
  assert.deepEqual(sources.map((s) => [s.n, s.available, s.item, s.references.length]), [[1, true, `${ws}/a`, 1], [2, false, "", 0]]);
});

test("a document's repeated reference is kept once; one without blocks keeps the document but no reference", () => {
  const sources = sourcesFromCitations("A [1]", [cited("a", "texts/1"), cited("a", "texts/1"), cited("a", "texts/2", { refs: [] })]);
  assert.deepEqual(sources.map((s) => [s.n, s.references.map((r) => r.refs.join())]), [[1, ["texts/1"]]]);
});

test("marker numbers come out once each, in reading order", () => {
  assert.deepEqual(markerNumbers("x [2] y [1] z [2] `[9]`"), [2, 1, 9]);
});

test("plain copy drops markers, emphasis, links and table rows", () => {
  assert.equal(plainAnswer("**Bold** claim [1] and [a link](/doc/1).\n\n| a | b |\n|---|---|"), "Bold claim and a link.");
});

// --- living answers -------------------------------------------------------

test("only a readable outdated source of the latest attempt asks for an update", () => {
  const stale = sourcesFromCitations("A [1] B [2]", [
    { item: "workspaces/w/items/a", displayName: "A", available: true, outdated: true, updateTime: "2026-11-20T00:00:00Z" },
    { available: false, outdated: true },
  ]);
  assert.deepEqual(stale.map((s) => !!s.outdated), [true, false]);
  const fresh = sourcesFromCitations("A [1]", [{ item: "workspaces/w/items/a", displayName: "A", available: true }]);
  const attempts = [
    { sources: stale, state: "COMPLETED" },
    { sources: fresh, state: "COMPLETED" },
  ];
  assert.equal(answerFreshness(attempts, 0)?.kind, "earlier");
  assert.equal(answerFreshness(attempts, 1)?.kind, "updated");
  assert.equal(answerFreshness([attempts[0]!], 0)?.kind, "outdated");
  assert.equal(answerFreshness([{ sources: stale, state: "streaming" }], 0), null);
});

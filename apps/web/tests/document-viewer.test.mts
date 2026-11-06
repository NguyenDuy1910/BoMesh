import assert from "node:assert/strict";
import test from "node:test";

import { explainPassagePrompt, parseReaderQuery, readerHref, revisionNumber } from "../src/modules/knowledge/reader/links.ts";

function query(href: string): URLSearchParams {
  return new URL(href, "http://bomesh.test").searchParams;
}

test("the reader address carries every cited passage, in citation order", () => {
  assert.equal(readerHref({ item: "workspaces/w/items/doc 1" }), "/doc/doc%201");
  const href = readerHref({ item: "doc1", passages: ["workspaces/w/items/doc1/passages/c2", "", "c1"], from: "workspaces/w/conversations/k9", q: "  leave  " });
  assert.ok(href.startsWith("/doc/doc1?"));
  const params = query(href);
  assert.deepEqual(params.getAll("passage"), ["c2", "c1"]);
  assert.equal(params.get("from"), "k9");
  assert.equal(params.get("q"), "leave");
});

test("deep-link parameters parse back, ignoring junk", () => {
  const parsed = parseReaderQuery(query("/doc/x?q=%20leave%20&page=3&passage=a&passage=b&passage=a&from=k&v=0"));
  assert.deepEqual(parsed, { q: "leave", page: 3, passages: ["a", "b"], from: "k", v: undefined });
  assert.equal(parseReaderQuery(query("/doc/x?page=two&v=2")).v, 2);
  assert.equal(parseReaderQuery(query("/doc/x?page=two")).page, undefined);
});

test("revision numbers come from revision names", () => {
  assert.equal(revisionNumber("workspaces/w/items/d/revisions/3"), 3);
  assert.equal(revisionNumber(""), undefined);
});

test("asking about a selection quotes it, collapsed and cut to a readable length", () => {
  assert.equal(explainPassagePrompt("  Contractors   follow\nthe terms. "), "Explain this passage: “Contractors follow the terms.”");
  const long = explainPassagePrompt("word ".repeat(100));
  const quote = long.split("“")[1]!.split("”")[0]!;
  assert.ok(quote.endsWith("…"));
  assert.ok(quote.length <= 241);
});

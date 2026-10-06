import assert from "node:assert/strict";
import test from "node:test";

import { askAboutDocumentHref, askAboutPassageHref, documentHref } from "../src/modules/knowledge/preview.ts";

const target = { documentId: "doc 1", name: "Employee Handbook.pdf", collectionId: "kb-hr" };

function query(href: string): URLSearchParams {
  return new URL(href, "http://bomesh.test").searchParams;
}

test("the viewer address carries every cited chunk, in citation order", () => {
  assert.equal(documentHref("doc 1"), "/documents/doc%201");
  const href = documentHref("doc 1", ["c2", "", "c1"]);
  assert.ok(href.startsWith("/documents/doc%201?"));
  assert.deepEqual(query(href).getAll("chunk"), ["c2", "c1"]);
});

test("asking about a document starts a draft scoped to its knowledge base, with it attached", () => {
  const params = query(askAboutDocumentHref(target));
  assert.equal(params.get("q"), "About “Employee Handbook.pdf”: ");
  assert.equal(params.get("scope"), "kb-hr");
  assert.equal(params.get("doc"), "doc 1");
});

test("asking about a selection quotes it, collapsed and cut to a readable length", () => {
  const short = query(askAboutPassageHref(target, "  Contractors   follow\nthe terms. "));
  assert.equal(short.get("q"), "About this passage from “Employee Handbook.pdf”:\n“Contractors follow the terms.”\n\n");
  assert.equal(short.get("scope"), "kb-hr");

  const long = query(askAboutPassageHref(target, "word ".repeat(100))).get("q") ?? "";
  const quote = long.split("“")[2]!.split("”")[0]!;
  assert.ok(quote.endsWith("…"));
  assert.ok(quote.length <= 241);
});

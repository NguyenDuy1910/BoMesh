import assert from "node:assert/strict";
import test from "node:test";

import { DOC_TYPE_LABELS, docTypeOf, fileClassOf, itemTypeOf } from "../src/modules/knowledge/fileClass.ts";

test("a document's type is its itemType, read as a file class", () => {
  assert.equal(docTypeOf("PDF"), "pdf");
  assert.equal(docTypeOf("PLAIN_TEXT"), "plain_text");
  assert.equal(DOC_TYPE_LABELS[docTypeOf("PRESENTATION")], "Bản trình chiếu");
});

test("collection classes and missing types fall back to Other", () => {
  assert.equal(docTypeOf("STANDARD"), "other");
  assert.equal(docTypeOf(undefined), "other");
  assert.equal(docTypeOf(""), "other");
});

test("filters write the class back as an itemType", () => {
  assert.equal(itemTypeOf("plain_text"), "PLAIN_TEXT");
  assert.equal(itemTypeOf(docTypeOf("SPREADSHEET")), "SPREADSHEET");
});

test("a local file's class follows the server's table: extension, then MIME family", () => {
  assert.equal(fileClassOf("Syllabus.pdf"), "pdf");
  assert.equal(fileClassOf("deck.PPTX"), "presentation");
  assert.equal(fileClassOf("data.tsv"), "spreadsheet");
  assert.equal(fileClassOf("notes.rst"), "markdown");
  assert.equal(fileClassOf("events.jsonl"), "data");
  assert.equal(fileClassOf("query.sql"), "plain_text");
  assert.equal(fileClassOf("photo", "image/png"), "image");
  assert.equal(fileClassOf("readme", "text/x-c"), "plain_text");
  assert.equal(fileClassOf("blob.bin", "application/octet-stream"), "other");
});

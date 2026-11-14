import assert from "node:assert/strict";
import test from "node:test";

import { pickTypeLabel } from "../src/modules/knowledge/title.ts";

/** A `.pptx`: format says "Slides", nothing in the title names a purpose. */
const slides = { kindLabel: "Plain text", formatLabel: "Slides", kindIsSpecific: false };
/** A PDF whose title reads "Course syllabus 2026": inferKind found a real kind. */
const syllabus = { kindLabel: "Syllabus", formatLabel: "PDF", kindIsSpecific: true };

test("a format-derived documentType shows the format, not 'Plain text'", () => {
  // The backend maps every unrecognised MIME type to `plain_text`
  // (item_store.document_type_for_content_type), so a .pptx/.xlsx/.docx all arrive as plain_text.
  assert.equal(pickTypeLabel("plain_text", slides), "Slides");
  assert.equal(pickTypeLabel("plain_text", { kindLabel: "Plain text", formatLabel: "Spreadsheet", kindIsSpecific: false }), "Spreadsheet");
  assert.equal(pickTypeLabel("plain_text", { kindLabel: "Plain text", formatLabel: "Word", kindIsSpecific: false }), "Word");
});

test("the other format-shaped types keep naming their format", () => {
  for (const t of ["pdf", "markdown", "image", "audio", "video", "archive"]) {
    assert.equal(pickTypeLabel(t, { kindLabel: "Whatever", formatLabel: "PDF", kindIsSpecific: false }), "PDF", t);
  }
});

test("a purpose someone set wins over the format", () => {
  // A real resource kind: what the document is *for* is more useful than what it is.
  assert.equal(pickTypeLabel("policy", { kindLabel: "Policy", formatLabel: "PDF", kindIsSpecific: true }), "Policy");
  assert.equal(pickTypeLabel("lecture", { kindLabel: "Lecture slides", formatLabel: "Slides", kindIsSpecific: true }), "Lecture slides");
  // web_page describes where it came from, not merely its bytes, so it is not a format type.
  assert.equal(pickTypeLabel("web_page", { kindLabel: "Web page", formatLabel: "Text", kindIsSpecific: false }), "Web page");
});

test("a title that names a purpose beats the bare format", () => {
  assert.equal(pickTypeLabel("plain_text", syllabus), "Syllabus");
  // Nothing recognisable in the title: the format beats inferKind's "Reference" catch-all.
  assert.equal(pickTypeLabel("plain_text", { kindLabel: "Reference", formatLabel: "PDF", kindIsSpecific: false }), "PDF");
});

test("no documentType at all still falls back to the format", () => {
  assert.equal(pickTypeLabel(undefined, slides), "Slides");
  assert.equal(pickTypeLabel("", slides), "Slides");
});

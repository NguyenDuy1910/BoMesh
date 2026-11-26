import assert from "node:assert/strict";
import test from "node:test";

import { headingTag, nodeText, safeHref, tableLayout } from "../src/modules/knowledge/content/blocks.ts";
import { locationLabel, referenceOf, referenceOfWire } from "../src/modules/knowledge/content/reference.ts";

/* ═══════════════ DocumentRenderer: links ═══════════════ */

test("only http, https and mailto runs become links", () => {
  assert.equal(safeHref("https://example.test/a?b=1"), "https://example.test/a?b=1");
  assert.equal(safeHref("http://example.test"), "http://example.test/");
  assert.equal(safeHref("mailto:hr@example.test"), "mailto:hr@example.test");
  for (const unsafe of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "file:///etc/passwd", "/relative/path", "#top", "", undefined, null]) {
    assert.equal(safeHref(unsafe), undefined, String(unsafe));
  }
});

/* ═══════════════ DocumentRenderer: tables ═══════════════ */

test("a table keeps its merged cells' spans and splits its leading header rows from the body", () => {
  const layout = tableLayout({
    rows: [
      { cells: [{ text: "Khoản", header: true, rowSpan: 2 }, { text: "Mức", header: true, colSpan: 2 }] },
      { cells: [{ text: "2024", header: true }, { text: "2025", header: true }] },
      { cells: [{ text: "Công tác phí", rowSpan: 1, colSpan: 1 }, { text: "200" }, { text: "250" }] },
    ],
    totalRows: 3,
  });
  assert.deepEqual(layout.head, [
    [{ text: "Khoản", header: true, rowSpan: 2 }, { text: "Mức", header: true, colSpan: 2 }],
    [{ text: "2024", header: true }, { text: "2025", header: true }],
  ]);
  // Spans of 1 are the default: not written out.
  assert.deepEqual(layout.body, [[{ text: "Công tác phí", header: false }, { text: "200", header: false }, { text: "250", header: false }]]);
  assert.equal(layout.moreRows, 0);
});

test("a table cut by the projection says how many rows stay in the original", () => {
  const rows = [{ cells: [{ text: "a" }] }, { cells: [{ text: "b" }] }];
  assert.equal(tableLayout({ rows, totalRows: 1250 }).moreRows, 1248);
  assert.equal(tableLayout({ rows }).moreRows, 0);
});

test("a table of only header cells keeps its last row as the body, and a row header stays in the body", () => {
  const layout = tableLayout({ rows: [{ cells: [{ text: "A", header: true }] }, { cells: [{ text: "B", header: true }, { text: "1" }] }] });
  assert.equal(layout.head.length, 1);
  assert.deepEqual(layout.body, [[{ text: "B", header: true }, { text: "1", header: false }]]);
});

test("heading levels map below the page title", () => {
  assert.equal(headingTag(1), "h2");
  assert.equal(headingTag(3), "h4");
  assert.equal(headingTag(9), "h6");
  assert.equal(headingTag(undefined), "h2");
});

test("a block's plain text reads runs, list items, cells and caption", () => {
  const text = nodeText({
    runs: [{ text: "Bảng " }, { text: "phí" }],
    rows: [{ cells: [{ text: "a" }, { text: "b" }] }],
    children: [{ runs: [{ text: "mục 1" }] }],
    caption: "Nguồn: HR",
  });
  assert.equal(text, "Bảng phí\na\tb\nmục 1\nNguồn: HR");
});

/* ═══════════════ References ═══════════════ */

test("an API citation becomes a reference only when it can be opened", () => {
  const highlights = [{ pageNumber: 4, boxes: [{ left: 0.1, top: 0.2, right: 0.8, bottom: 0.25 }] }, { sheet: "Phí 2025", cellRange: "A24:DH26" }];
  const full = { item: "workspaces/w/items/d", revision: "workspaces/w/items/d/revisions/2", structureVersion: "0123456789abcdef", refs: ["texts/1"], quote: "q", location: "Mục 3", highlights };
  assert.deepEqual(referenceOf(full), full);
  assert.equal(referenceOf({ ...full, refs: [] }), null);
  assert.equal(referenceOf({ ...full, structureVersion: undefined }), null);
  assert.equal(referenceOf({ ...full, revision: undefined }), null);
  assert.equal(referenceOf({ available: false } as never), null);
  assert.deepEqual(referenceOf({ ...full, quote: undefined, location: undefined, highlights: undefined }), { ...full, quote: "", location: "", highlights: [] });
  // A Highlight in neither form (no page from 1, no sheet with a range) is dropped.
  assert.deepEqual(referenceOf({ ...full, highlights: [{ pageNumber: 0 }, { sheet: "A" }, { cellRange: "A1" }, highlights[0]!] })!.highlights, [highlights[0]]);
});

test("a stream citation maps its snake_case fields and keeps its highlights", () => {
  const highlights = [{ pageNumber: 2, boxes: [] }];
  const wire = { item: "workspaces/w/items/d", revision: "workspaces/w/items/d/revisions/2", structure_version: "0123456789abcdef", refs: ["texts/1"], quote: "q", location: "", highlights };
  assert.deepEqual(referenceOfWire(wire)?.highlights, highlights);
  assert.equal(referenceOfWire(wire)?.structureVersion, "0123456789abcdef");
  assert.deepEqual(referenceOfWire({ ...wire, highlights: null })?.highlights, []);
});

test("the location label joins the document's location and the first highlighted page", () => {
  assert.equal(locationLabel({ location: "13. Ngày phê duyệt", highlights: [{ pageNumber: 4, boxes: [] }, { pageNumber: 5, boxes: [] }] }), "13. Ngày phê duyệt · trang 4");
  assert.equal(locationLabel({ location: "", highlights: [{ pageNumber: 4 }] }), "trang 4");
  assert.equal(locationLabel({ location: "Phí 2025 · bảng 1", highlights: [{ sheet: "Phí 2025", cellRange: "A1:C9" }] }), "Phí 2025 · bảng 1");
  assert.equal(locationLabel({ location: "Mục 2" }), "Mục 2");
  assert.equal(locationLabel(null), "");
});

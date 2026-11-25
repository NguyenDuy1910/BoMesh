import assert from "node:assert/strict";
import test from "node:test";

import { headingTag, nodeText, safeHref, tableLayout } from "../src/modules/knowledge/content/blocks.ts";
import { citedBlocks } from "../src/modules/knowledge/content/highlight.ts";
import { locationLabel, referenceOf } from "../src/modules/knowledge/content/reference.ts";

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

/* ═══════════════ ContentView: what a reference highlights ═══════════════ */

const nodes = [
  { ref: "texts/1" },
  { ref: "groups/2", children: [{ ref: "texts/3" }, { ref: "texts/4", children: [{ ref: "groups/5", children: [{ ref: "texts/6" }] }] }] },
  { ref: "tables/0" },
];

test("cited blocks are marked by ref, list items included, and the first in reading order is the focus", () => {
  const cited = citedBlocks(nodes, ["tables/0", "texts/6", "texts/3"]);
  assert.deepEqual([...cited.marked].sort(), ["tables/0", "texts/3", "texts/6"]);
  assert.equal(cited.first, "texts/3");
});

test("a cited list marks the list itself, not each item", () => {
  const cited = citedBlocks(nodes, ["groups/2"]);
  assert.deepEqual([...cited.marked], ["groups/2"]);
  assert.equal(cited.first, "groups/2");
});

test("refs outside the window mark nothing", () => {
  const cited = citedBlocks(nodes, ["texts/99"]);
  assert.equal(cited.marked.size, 0);
  assert.equal(cited.first, "");
  assert.equal(citedBlocks([], ["texts/1"]).first, "");
  assert.equal(citedBlocks(nodes, []).marked.size, 0);
});

/* ═══════════════ References ═══════════════ */

test("an API citation becomes a reference only when it can be opened", () => {
  const full = { item: "workspaces/w/items/d", revision: "workspaces/w/items/d/revisions/2", structureVersion: "0123456789abcdef", refs: ["texts/1"], quote: "q", location: "Mục 3", pageNumber: 4 };
  assert.deepEqual(referenceOf(full), full);
  assert.equal(referenceOf({ ...full, refs: [] }), null);
  assert.equal(referenceOf({ ...full, structureVersion: undefined }), null);
  assert.equal(referenceOf({ ...full, revision: undefined }), null);
  assert.equal(referenceOf({ available: false } as never), null);
  const { pageNumber: _page, ...unpaged } = full;
  assert.deepEqual(referenceOf({ ...full, quote: undefined, location: undefined, pageNumber: undefined }), { ...unpaged, quote: "", location: "" });
});

test("the location label joins the document's location and the page", () => {
  assert.equal(locationLabel({ location: "13. Ngày phê duyệt", pageNumber: 4 }), "13. Ngày phê duyệt · trang 4");
  assert.equal(locationLabel({ location: "", pageNumber: 4 }), "trang 4");
  assert.equal(locationLabel({ location: "Phí 2025 · bảng 1" }), "Phí 2025 · bảng 1");
  assert.equal(locationLabel(null), "");
});

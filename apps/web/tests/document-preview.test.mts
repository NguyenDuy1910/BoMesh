import assert from "node:assert/strict";
import test from "node:test";

import { archiveRows, parseArchivePayload } from "../src/modules/knowledge/reader/archive.ts";
import { locate, pagedTextMarks, pageText, pdfMarks, quotedRows, searchNeedles, textMarks } from "../src/modules/knowledge/reader/marks.ts";
import { coverFormat, surfaceView, UNAVAILABLE_COPY, viewerFormat } from "../src/modules/knowledge/reader/preview.ts";
import { cellKey, columnLetter, parseTablePayload, rowGroups, sheetNotice, tableMarks, TablePayloadError } from "../src/modules/knowledge/reader/table.ts";

const representation = (kind: string, extra: Record<string, unknown> = {}) => ({ kind, uri: `https://storage.test/${kind}`, mimeType: "x/y", sizeBytes: "10", ...extra });

/* ═══════════════ state + kind → viewer ═══════════════ */

test("a READY preview is drawn by the viewer of its representation's kind, and nothing else", () => {
  const kinds = { PDF: "pdf", IMAGE: "image", TABLE: "table", TEXT: "text", MEDIA: "media", ARCHIVE: "archive" } as const;
  for (const [kind, viewer] of Object.entries(kinds)) {
    const view = surfaceView({ state: "READY", representation: representation(kind) as never, original: { uri: "https://storage.test/original" } });
    assert.equal(view.state, "READY");
    assert.equal(view.state === "READY" && view.viewer, viewer);
    assert.equal(view.state === "READY" && view.representation.uri, `https://storage.test/${kind}`);
  }
});

test("PREPARING polls; UNAVAILABLE says why; a READY preview without a usable representation can't be shown", () => {
  assert.deepEqual(surfaceView({ state: "PREPARING" }), { state: "PREPARING" });
  for (const reason of ["FORMAT_NOT_SUPPORTED", "TOO_LARGE", "CONVERSION_FAILED"] as const) {
    assert.deepEqual(surfaceView({ state: "UNAVAILABLE", unavailableReason: reason }), { state: "UNAVAILABLE", reason });
    assert.ok(UNAVAILABLE_COPY[reason].title);
  }
  assert.deepEqual(surfaceView({ state: "READY" }), { state: "UNAVAILABLE", reason: "FORMAT_NOT_SUPPORTED" });
  assert.deepEqual(surfaceView({ state: "READY", representation: representation("HOLOGRAM") as never }), { state: "UNAVAILABLE", reason: "FORMAT_NOT_SUPPORTED" });
  assert.deepEqual(surfaceView({ state: "READY", representation: { kind: "PDF" } }), { state: "UNAVAILABLE", reason: "FORMAT_NOT_SUPPORTED" });
});

test("the page chrome follows the representation, or the cover before it exists", () => {
  assert.equal(viewerFormat("pdf", {}), "pdf");
  assert.equal(viewerFormat("table", {}), "sheet");
  assert.equal(viewerFormat("text", { textFormat: "MARKDOWN" }), "markdown");
  assert.equal(viewerFormat("text", { textFormat: "PLAIN" }), "text");
  assert.equal(coverFormat({ kind: "SLIDE" }), "slide");
  assert.equal(coverFormat({ kind: "SHEET" }), "sheet");
  assert.equal(coverFormat({ kind: "PAGE" }), "pdf");
  assert.equal(coverFormat(undefined), "pdf");
});

/* ═══════════════ Needles and marks ═══════════════ */

test("locate ignores case, accents and spacing", () => {
  assert.deepEqual(locate("Travel  MUST be booked", "must be"), { start: 8, end: 15 });
  assert.equal(locate("Travel", "Meals"), null);
});

test("a search is one phrase when the document holds it, else its meaningful words", () => {
  assert.deepEqual(searchNeedles("phep nam", "Nghỉ phép năm: 12 ngày.", false), ["phep nam"]);
  assert.deepEqual(searchNeedles("How are meals reimbursed?", "Meals are reimbursed up to the limit.", false), ["meals", "reimbursed"]);
  // A citation quote is one needle, whatever it contains.
  assert.deepEqual(searchNeedles("Meals are paid", "", true), ["Meals are paid"]);
});

test("a text marks cited passages and search words in reading order", () => {
  const text = "Meals are reimbursed.\nTravel   must be booked early. Meals again.";
  const marks = textMarks(text, { passages: [{ text: "travel must be booked" }, { text: "not in this file" }], needles: ["meals"] });
  assert.equal(marks.total, 3);
  assert.equal(marks.unresolved, 1);
  assert.deepEqual(
    marks.ranges.map((r) => [text.slice(r.start, r.end), r.hit]),
    [
      ["Meals", 0],
      ["Travel   must be booked", 1],
      ["Meals", 2],
    ],
  );
  assert.equal(textMarks(text, {}).total, 0);
});

test("a passage split by a heading or Markdown syntax is marked piece by piece, as one mark", () => {
  const text = "Expense policy\nMeals are reimbursed up to the daily limit.\nTravel\nTravel must be booked through the agency.";
  const marks = textMarks(text, { passages: [{ text: "Meals are **reimbursed** up to the daily limit.\n## Travel\nTravel must be booked through the agency." }] });
  assert.equal(marks.total, 1);
  assert.deepEqual(
    marks.ranges.map((r) => [text.slice(r.start, r.end), r.hit]),
    [
      ["Meals are reimbursed up to the daily limit.", 0],
      ["Travel must be booked through the agency.", 0],
    ],
  );
});

test("a PDF marks passages with boxes as boxes and leaves the others to its text", () => {
  const marks = pdfMarks([
    { boundingBoxes: [{ pageNumber: 3, left: 0.1, top: 0.5, width: 0.5, height: 0.1 }] },
    {
      boundingBoxes: [
        { pageNumber: 1, left: 0.1, top: 0.9, width: 0.8, height: 0.2 },
        { pageNumber: 2, left: 0.1, top: 0.05, width: 0.8, height: 0.1 },
      ],
    },
    { text: "no boxes", boundingBoxes: [] },
    { text: "no page", boundingBoxes: [{ pageNumber: 0, left: 0, top: 0, width: 1, height: 1 }] },
  ]);
  assert.equal(marks.total, 2);
  assert.deepEqual(marks.textPassages.map((p) => p.text), ["no boxes", "no page"]);
  // The passage starting on page 1 comes first; a box running off the page is clipped to it.
  assert.deepEqual(marks.pages.get(1), [{ left: 0.1, top: 0.9, width: 0.8, height: 0.09999999999999998, hit: 0 }]);
  assert.equal(marks.pages.get(2)?.[0]?.hit, 0);
  assert.equal(marks.pages.get(3)?.[0]?.hit, 1);
  assert.equal(pdfMarks([]).total, 0);
});

test("a PDF page's text reads as its text layer does, and marks are numbered after the boxes across pages", () => {
  const page1 = pageText([{ str: "Meals are", hasEOL: true }, { str: "reimbursed." }, { str: "", hasEOL: true }, { str: "Policy" }]);
  assert.equal(page1, "Meals are\nreimbursed.\nPolicy");
  const pages = new Map([
    [2, "Travel must be booked early. Meals again."],
    [1, page1],
  ]);
  const marks = pagedTextMarks(pages, { passages: [{ text: "travel must be booked" }, { text: "nowhere" }], needles: ["meals"] }, 2);
  assert.equal(marks.total, 3);
  assert.equal(marks.unresolved, 1);
  assert.deepEqual(marks.pages.get(1), [{ start: 0, end: 5, hit: 2 }]);
  assert.deepEqual(marks.pages.get(2), [
    { start: 0, end: 21, hit: 3 },
    { start: 29, end: 34, hit: 4 },
  ]);
  assert.equal(marks.hitPages.get(3), 2);
});

/* ═══════════════ TABLE payload ═══════════════ */

test("a table payload is normalized and its cut sheets say how", () => {
  const payload = parseTablePayload({
    schema: 1,
    sheets: [
      { name: "Costs", rows: [["Name", "Amount"], ["Alice", 300], ["Bob", null]], totalRows: 12000, totalColumns: 2, truncated: true },
      { name: "", rows: [["a", "b", "c"]], totalRows: 1, totalColumns: 250 },
      { name: "Cells", rows: [["x"]], totalRows: 1, totalColumns: 1, truncated: true },
      { name: "Whole", rows: [["x"]], totalRows: 1, totalColumns: 1, truncated: false },
    ],
  });
  const [costs, wide, cells, whole] = payload.sheets;
  assert.deepEqual(costs!.rows, [["Name", "Amount"], ["Alice", "300"], ["Bob", ""]]);
  assert.deepEqual(sheetNotice(costs!), { cut: "rows", shown: 3, total: 12000 });
  // A sheet whose totals exceed what it holds is cut even when the flag is missing.
  assert.equal(wide!.name, "Trang tính 2");
  assert.equal(wide!.truncated, true);
  assert.deepEqual(sheetNotice(wide!), { cut: "columns", shown: 3, total: 250 });
  // Cut by the cell bound only: no count to give.
  assert.deepEqual(sheetNotice(cells!), { cut: "part" });
  assert.equal(sheetNotice(whole!), null);
  assert.throws(() => parseTablePayload({ schema: 2, sheets: [] }), TablePayloadError);
  assert.throws(() => parseTablePayload(null), TablePayloadError);
});

test("rows are drawn in groups of 100; columns are lettered like a spreadsheet", () => {
  assert.deepEqual(rowGroups(250), [
    [0, 100],
    [100, 200],
    [200, 250],
  ]);
  assert.deepEqual(rowGroups(0), []);
  assert.deepEqual([0, 25, 26, 51, 701, 702].map(columnLetter), ["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
});

test("a cited passage marks the rows it quotes; a needle every cell holding it, in reading order", () => {
  // Alice: name and amount quoted. Carol: only her name, so not cited. "Ali"/"30" sit inside longer values.
  const rows = [["Name", "Amount"], ["Alice", "300"], ["Carol", "450"], ["Ali", "30"]];
  assert.deepEqual(quotedRows(rows, "Alice was paid 300. Carol was paid 999."), [1]);
  const payload = parseTablePayload({ schema: 1, sheets: [{ name: "A", rows }, { name: "B", rows: [["alice again"]] }] });
  const marks = tableMarks(payload, { passages: [{ text: "Alice 300" }, { text: "Nobody here" }], needles: ["ali"] });
  assert.equal(marks.unresolved, 1);
  // Row 1 is one mark (the passage); "Ali" in row 3 and sheet B are marks of their own.
  assert.deepEqual(marks.cells.get(cellKey(0, 1, 0)), [{ start: 0, end: 5, hit: 0 }]);
  assert.deepEqual(marks.cells.get(cellKey(0, 1, 1)), [{ start: 0, end: 3, hit: 0 }]);
  assert.deepEqual(marks.cells.get(cellKey(0, 3, 0)), [{ start: 0, end: 3, hit: 1 }]);
  assert.deepEqual(marks.cells.get(cellKey(1, 0, 0)), [{ start: 0, end: 3, hit: 2 }]);
  assert.equal(marks.total, 3);
  assert.equal(marks.hitSheets.get(2), 1);
});

/* ═══════════════ ARCHIVE payload ═══════════════ */

test("an archive listing is a tree: folders first, folder sizes summed, missing folders added", () => {
  const payload = parseArchivePayload({
    schema: 1,
    entries: [
      { path: "b.txt", sizeBytes: 5, directory: false },
      { path: "docs/", sizeBytes: 0, directory: true },
      { path: "docs/a.md", sizeBytes: 10, directory: false },
      { path: "src/lib/x.ts", sizeBytes: 7, directory: false },
    ],
    totalEntries: 20,
    truncated: false,
  });
  assert.equal(payload.truncated, true);
  assert.equal(payload.totalEntries, 20);
  assert.deepEqual(
    archiveRows(payload.entries).map((r) => [r.path, r.depth, r.directory, r.sizeBytes]),
    [
      ["docs", 0, true, 10],
      ["docs/a.md", 1, false, 10],
      ["src", 0, true, 7],
      ["src/lib", 1, true, 7],
      ["src/lib/x.ts", 2, false, 7],
      ["b.txt", 0, false, 5],
    ],
  );
  assert.throws(() => parseArchivePayload({ schema: 9, entries: [] }));
});

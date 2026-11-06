import assert from "node:assert/strict";
import test from "node:test";

import { diffLines, diffMarkdown, diffSheet, sheetHasChanges } from "../src/modules/artifacts/diff.ts";
import { htmlToMarkdown, type MarkdownSourceNode } from "../src/modules/artifacts/html-markdown.ts";
import {
  downloadOptions,
  fileNameOf,
  fileViewOf,
  formatLabel,
  revisionNumber,
  toDelimited,
  versionsOf,
} from "../src/modules/artifacts/model.ts";
import { columnLetter, parseDelimited, sheetFromDelimited, sheetsFromBlocks, type Sheet } from "../src/modules/artifacts/sheet.ts";

test("Markdown changes are compared block by block, ignoring how a bullet is written", () => {
  const changes = diffMarkdown(
    "# Plan\n\nIntro text.\n\n- one\n- two\n",
    "# Plan\n\nIntro text, revised.\n\n* one\n- two\n- three\n",
  );

  assert.deepEqual(changes.map((change) => [change.status, change.text]), [
    ["same", "# Plan"],
    ["removed", "Intro text."],
    ["added", "Intro text, revised."],
    ["same", "* one"],
    ["same", "- two"],
    ["added", "- three"],
  ]);
  assert.ok(diffMarkdown("A **bold** word\n", "A __bold__ word\n").every((change) => change.status === "same"));
});

test("plain text changes are compared line by line", () => {
  assert.deepEqual(diffLines("alpha\nbeta\n\ngamma", "alpha\ngamma\ndelta").map((change) => [change.status, change.text]), [
    ["same", "alpha"],
    ["removed", "beta"],
    ["same", "gamma"],
    ["added", "delta"],
  ]);
});

const vendorsV1: Sheet = {
  name: "Vendors",
  columns: ["Vendor", "Spend"],
  rows: [["Acme", "10"], ["Bolt", "20"], ["Core", "30"]],
  totalRows: 3,
};

test("sheet changes mark added columns and rows, changed and moved cells, and removed rows", () => {
  const diff = diffSheet(vendorsV1, {
    name: "Vendors",
    columns: ["Vendor", "Spend", "Approver"],
    rows: [["Core", "30", "CFO"], ["Acme", "15", "VP"], ["Dyna", "5", "Owner"]],
    totalRows: 3,
  });

  assert.deepEqual(diff.columns, [
    { name: "Vendor", status: "same" },
    { name: "Spend", status: "same" },
    { name: "Approver", status: "added" },
  ]);
  assert.deepEqual(diff.rows.map((row) => [row.number, row.status, row.cells.map((cell) => cell.status)]), [
    [2, "same", ["same", "same", "added"]],
    [3, "moved", ["same", "changed", "added"]],
    [4, "added", ["added", "added", "added"]],
  ]);
  assert.deepEqual(diff.removedRows, [["Bolt", "20", ""]]);
  assert.deepEqual(diff.counts, { addedRows: 1, removedRows: 1, movedRows: 1, changedCells: 1, addedColumns: 1, removedColumns: 0 });
});

test("a re-sorted sheet has changes; an identical one has none", () => {
  const sorted = { ...vendorsV1, rows: [...vendorsV1.rows].reverse() };
  assert.equal(sheetHasChanges(diffSheet(vendorsV1, sorted)), true);
  assert.equal(sheetHasChanges(diffSheet(vendorsV1, structuredClone(vendorsV1))), false);
  assert.deepEqual(diffSheet(vendorsV1, { ...vendorsV1, columns: ["Vendor"], rows: vendorsV1.rows.map((row) => [row[0]!]) }).removedColumns, ["Spend"]);
});

test("rows repeating a first cell are matched by occurrence", () => {
  const before: Sheet = { name: "S", columns: ["Team", "Cost"], rows: [["Ops", "1"], ["Ops", "2"]], totalRows: 2 };
  const diff = diffSheet(before, { ...before, rows: [["Ops", "1"], ["Ops", "3"]] });
  assert.deepEqual(diff.rows.map((row) => row.cells[1]?.status), ["same", "changed"]);
});

test("delimited text keeps quoted delimiters, quotes and line breaks", () => {
  assert.deepEqual(parseDelimited('\uFEFFName,Note\r\n"Acme, Inc.","said ""hi""\nthen left"\r\nBolt,\n\n'), [
    ["Name", "Note"],
    ["Acme, Inc.", 'said "hi"\nthen left'],
    ["Bolt", ""],
  ]);
  assert.deepEqual([columnLetter(0), columnLetter(25), columnLetter(26), columnLetter(701)], ["A", "Z", "AA", "ZZ"]);
});

test("a cell edit round-trips through CSV", () => {
  const sheet = sheetFromDelimited('Vendor,Note\nAcme,"a, b"\nBolt,"say ""hi"""\n', "Sheet1");
  const rows = sheet.rows.map((row) => [...row]);
  rows[1]![1] = "line\nbreak";
  const text = toDelimited(sheet.columns, rows);
  assert.equal(text, 'Vendor,Note\nAcme,"a, b"\nBolt,"line\nbreak"\n');
  assert.deepEqual(parseDelimited(text), [["Vendor", "Note"], ["Acme", "a, b"], ["Bolt", "line\nbreak"]]);
});

test("a workbook rendition becomes named sheets", () => {
  const sheets = sheetsFromBlocks([
    { id: "h1", kind: "heading", level: 1, text: "Needs review", page: 1 },
    { id: "t1", kind: "table", caption: null, columns: ["Vendor"], rows: [["Acme"]], total_rows: 40, page: 1 },
    { id: "t2", kind: "table", caption: "Totals", columns: ["Sum"], rows: [["9"]], total_rows: 1, page: 2 },
    { id: "t3", kind: "table", caption: null, columns: ["X"], rows: [], total_rows: 0, page: 3 },
  ]);
  assert.deepEqual(sheets.map((sheet) => [sheet.name, sheet.totalRows]), [["Needs review", 40], ["Totals", 1], ["Sheet 3", 0]]);
});

function element(nodeName: string, childNodes: MarkdownSourceNode[] = [], attributes: Record<string, string> = {}): MarkdownSourceNode {
  return {
    nodeType: 1,
    nodeName,
    childNodes,
    get textContent() {
      return childNodes.map((child) => child.textContent).join("");
    },
    getAttribute: (name) => attributes[name] ?? null,
  };
}
const text = (value: string): MarkdownSourceNode => ({ nodeType: 3, nodeName: "#text", textContent: value, childNodes: [] });

test("an edited document is saved back as Markdown", () => {
  const markdown = htmlToMarkdown(element("DIV", [
    element("H2", [text("Vendor review")]),
    element("P", [text("Eleven need "), element("STRONG", [text("attention ")]), text("now, "), element("EM", [text("before")]), text(" renewal.")]),
    element("UL", [element("LI", [text("CloudHost")]), element("LI", [text("Payroll "), element("UL", [element("LI", [text("HR")])])])]),
    element("OL", [element("LI", [text("Ask")]), element("LI", [text("Sign")])]),
    element("DIV", [element("BUTTON", [text("Copy")]), element("PRE", [element("CODE", [text("select 1;\n")], { class: "language-sql" })])]),
    element("TABLE", [element("TBODY", [element("TR", [element("TH", [text("Vendor")]), element("TH", [text("Ends")])]), element("TR", [element("TD", [text("Mail|Wave")]), element("TD", [text("Oct 15")])])])]),
    text("A typed line with a * star"),
  ]));

  assert.equal(markdown, [
    "## Vendor review",
    "Eleven need **attention** now, *before* renewal.",
    "- CloudHost\n- Payroll\n  - HR",
    "1. Ask\n2. Sign",
    "```sql\nselect 1;\n```",
    "| Vendor | Ends |\n| --- | --- |\n| Mail\\|Wave | Oct 15 |",
    "A typed line with a \\* star",
  ].join("\n\n") + "\n");
});

test("the panel's shifted headings are saved at their file level", () => {
  const root = element("DIV", [element("H2", [text("Title")]), element("H3", [text("Section")]), element("H6", [text("Deep")])]);
  assert.equal(htmlToMarkdown(root, { headingOffset: 1 }), "# Title\n\n## Section\n\n##### Deep\n");
});

test("versions read oldest first with authors and default summaries", () => {
  const versions = versionsOf([
    { name: "workspaces/w/artifacts/a/revisions/3", author: "USER", changeSummary: "Edited B4", snapshot: { mimeType: "text/csv", sizeBytes: "120", text: "x" } },
    { name: "workspaces/w/artifacts/a/revisions/1", author: "ASSISTANT", snapshot: { mimeType: "text/csv", sizeBytes: "100" } },
    { name: "workspaces/w/artifacts/a/revisions/2", author: "USER", snapshot: { mimeType: "text/csv" } },
  ]);
  assert.deepEqual(versions.map((v) => [v.n, v.author, v.summary, v.sizeBytes]), [
    [1, "assistant", "First version", 100],
    [2, "you", "Edited by you", 0],
    [3, "you", "Edited B4", 120],
  ]);
  assert.equal(revisionNumber("workspaces/w/artifacts/a/revisions/12"), 12);
  assert.equal(revisionNumber(undefined), 0);
});

test("files are shown, named and downloaded by type", () => {
  assert.equal(fileViewOf("text/markdown"), "markdown");
  assert.equal(fileViewOf("text/csv; charset=utf-8"), "csv");
  assert.equal(fileViewOf("application/json"), "other");
  assert.equal(fileViewOf("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "sheet");
  assert.equal(fileViewOf("application/pdf"), "document");
  assert.equal(fileNameOf({ displayName: "Claims over $500", mimeType: "text/csv" }), "Claims over $500.csv");
  assert.equal(fileNameOf({ displayName: "memo.md", mimeType: "text/markdown" }), "memo.md");
  assert.equal(formatLabel("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "Word document");
  assert.deepEqual(downloadOptions("csv", "text/csv").map((o) => o.id), ["csv", "pdf"]);
  assert.deepEqual(downloadOptions("markdown", "text/markdown").map((o) => o.id), ["docx", "pdf", "md"]);
  assert.deepEqual(downloadOptions("sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").map((o) => [o.format, o.ext]), [["original", "xlsx"]]);
});

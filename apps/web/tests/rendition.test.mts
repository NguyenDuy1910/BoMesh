import assert from "node:assert/strict";
import test from "node:test";

import { citedBlocks, citedRows, documentMarks, locate, renditionText, searchNeedles } from "../src/modules/knowledge/reader/marks.ts";
import { elementsRendition, loadRendition, renditionOutline, renditionPages } from "../src/modules/knowledge/reader/rendition.ts";
import type { DocumentRendition, TableBlock } from "../src/modules/knowledge/reader/rendition.ts";

const rendition: DocumentRendition = {
  schema: 1,
  truncated: false,
  blocks: [
    { id: "doc_heading_001", kind: "heading", level: 1, text: "Expense policy", page: 1 },
    { id: "p001_para_002", kind: "paragraph", text: "Meals are reimbursed up to the daily limit.", page: 1 },
    {
      id: "p002_para_003",
      kind: "paragraph",
      text: "Travel must be booked through the approved agency at least fourteen days before departure, unless the trip is urgent.",
      page: 2,
    },
    {
      id: "p003_table_001",
      kind: "table",
      caption: null,
      columns: ["#", "Name", "Amount", "Region"],
      rows: [
        ["1", "Alice", "300", "North"],
        ["2", "Bob", "200", "South"],
        ["3", "Carol", "450", "East"],
        ["4", "Dave", "", ""],
        // "Ali" and "30" are inside "Alice" and "300", not quoted themselves.
        ["5", "Ali", "30", ""],
      ],
      total_rows: 5,
      page: 3,
    },
  ],
};

test("a passage marks the blocks its element ids name", () => {
  assert.deepEqual(citedBlocks(rendition, { elementIds: ["p001_para_002", "missing"], text: "Meals" }).map((b) => b.id), ["p001_para_002"]);
});

test("a cited table marks the rows whose cells the passage quotes", () => {
  const table = rendition.blocks[3] as TableBlock;
  // Alice: name and amount quoted. Carol: only her name, so not cited. Dave: his only cell.
  // Row numbers are shorter than two characters and never count; "Ali"/"30" sit inside longer values.
  assert.deepEqual(citedRows(table, "1, Name = Alice. 1, Amount = 300. 3, Name = Carol. 3, Amount = 999. 4, Name = Dave."), [0, 3]);
});

test("a passage without element ids falls back to the block that contains its opening", () => {
  const passage = "Travel must be   booked through the approved\nagency at least fourteen days before departure";
  assert.deepEqual(citedBlocks(rendition, { text: passage }).map((b) => b.id), ["p002_para_003"]);
});

test("a passage found nowhere is counted as unresolved, not placed", () => {
  const marks = documentMarks(rendition, { passages: [{ text: "A sentence that is not in this document at all." }] });
  assert.equal(marks.total, 0);
  assert.equal(marks.unresolved, 1);
});

test("a passage quoted inside a block marks those words; a longer one marks the whole block", () => {
  const marks = documentMarks(rendition, {
    passages: [
      { elementIds: ["p002_para_003"], text: "the approved agency" },
      { elementIds: ["p001_para_002"], text: "Meals are reimbursed up to the daily limit. And more text that continues on the next block." },
    ],
  });
  assert.deepEqual(marks.blocks.get("p002_para_003")?.text, [{ start: 30, end: 49, hit: 1 }]);
  // Numbered in reading order, not citation order.
  assert.deepEqual(marks.blocks.get("p001_para_002")?.text, [{ start: 0, end: 43, hit: 0 }]);
  assert.equal(marks.total, 2);
});

test("cited table rows are marks of their own; an unquoted table is marked whole", () => {
  const rows = documentMarks(rendition, { passages: [{ elementIds: ["p003_table_001"], text: "2, Name = Bob. 2, Amount = 200." }] });
  assert.deepEqual([...(rows.blocks.get("p003_table_001")?.rows ?? [])], [[1, 0]]);
  const whole = documentMarks(rendition, { passages: [{ elementIds: ["p003_table_001"], text: "Totals by region" }] });
  assert.equal(whole.blocks.get("p003_table_001")?.whole, 0);
});

test("a search marks every occurrence, ignoring case and accents, in document order", () => {
  const doc: DocumentRendition = {
    schema: 1,
    truncated: false,
    blocks: [
      { id: "a", kind: "paragraph", text: "Nghỉ phép năm: 12 ngày.", page: 1 },
      { id: "b", kind: "paragraph", text: "Phép năm không dùng hết sẽ hết hạn.", page: 2 },
    ],
  };
  const needles = searchNeedles("phep nam", renditionText(doc), false);
  assert.deepEqual(needles, ["phep nam"]);
  const marks = documentMarks(doc, { needles });
  assert.deepEqual(marks.blocks.get("a")?.text, [{ start: 5, end: 13, hit: 0 }]);
  assert.deepEqual(marks.blocks.get("b")?.text, [{ start: 0, end: 8, hit: 1 }]);
});

test("a query the document doesn't contain as a phrase marks its meaningful words", () => {
  assert.deepEqual(searchNeedles("How are meals reimbursed?", renditionText(rendition), false), ["meals", "reimbursed"]);
  // A citation quote is one needle, whatever it contains.
  assert.deepEqual(searchNeedles("Meals are paid", "", true), ["Meals are paid"]);
});

test("locate ignores case, accents and spacing", () => {
  assert.deepEqual(locate("Travel  MUST be booked", "must be"), { start: 8, end: 15 });
  assert.equal(locate("Travel", "Meals"), null);
});

test("the outline keeps the top two heading levels present", () => {
  const outline = renditionOutline({
    schema: 1,
    truncated: false,
    blocks: [
      { id: "h1", kind: "heading", level: 2, text: "Leave", page: 1 },
      { id: "h2", kind: "heading", level: 3, text: "Annual   leave", page: 1 },
      { id: "h3", kind: "heading", level: 4, text: "Carry-over", page: 2 },
      { id: "h4", kind: "heading", level: 3, text: " ", page: 2 },
    ],
  });

  assert.deepEqual(outline, [
    { id: "h1", title: "Leave", level: 1 },
    { id: "h2", title: "Annual leave", level: 2 },
  ]);
});

test("blocks are grouped by page; unnumbered blocks stay with their neighbours", () => {
  const pages = renditionPages({
    schema: 1,
    truncated: false,
    blocks: [
      { id: "a", kind: "heading", level: 1, text: "Title", page: null },
      { id: "b", kind: "paragraph", text: "One", page: 1 },
      { id: "c", kind: "paragraph", text: "Note", page: null },
      { id: "d", kind: "paragraph", text: "Three", page: 3 },
    ],
  });

  assert.deepEqual(pages.map((page) => [page.page, page.blocks.map((block) => block.id)]), [[1, ["a", "b", "c"]], [3, ["d"]]]);
  assert.deepEqual(renditionPages({ schema: 1, truncated: false, blocks: [{ id: "x", kind: "paragraph", text: "x", page: null }] })
    .map((page) => page.page), [null]);
});

test("a revision without a rendition reads from its reader elements", () => {
  const document = elementsRendition([
    { elementId: "e1", kind: "HEADING", level: 2, text: "Leave", pageNumber: 1 },
    { elementId: "e2", kind: "PARAGRAPH", text: "Ten days a year.", pageNumber: 1 },
    { elementId: "e3", kind: "CODE", text: "x = 1", pageNumber: 2 },
    { elementId: "e4", kind: "PARAGRAPH", text: "  ", pageNumber: 2 },
    { kind: "LIST", text: "Unused days expire." },
  ]);

  assert.deepEqual(document.blocks.map((block) => [block.id, block.kind, block.page]), [
    ["e1", "heading", 1],
    ["e2", "paragraph", 1],
    ["e3", "code", 2],
    ["element-4", "paragraph", null],
  ]);
  // Element ids stay block ids, so passages mark the indexed text too.
  assert.equal(documentMarks(document, { passages: [{ elementIds: ["e2"], text: "Ten days" }] }).blocks.get("e2")?.text?.[0]?.end, 8);
});

test("concurrent reads of one document version share one download", async (context) => {
  const calls = stubFetch(context, () => json(rendition));

  const [first, second] = await Promise.all([
    loadRendition("item-shared", { uri: "https://storage.test/a", version: "v1" }),
    loadRendition("item-shared", { uri: "https://storage.test/b", version: "v1" }),
  ]);
  const later = await loadRendition("item-shared", { uri: "https://storage.test/c", version: "v1" });

  assert.equal(calls.length, 1);
  assert.equal(first, second);
  assert.equal(later, first);
  assert.equal(first.blocks.length, 4);
});

test("a failed download is retried by the next read", async (context) => {
  let fail = true;
  const calls = stubFetch(context, () => (fail ? new Response("expired", { status: 403 }) : json(rendition)));
  const ref = { uri: "https://storage.test/expired", version: "v1" };

  await assert.rejects(loadRendition("item-retry", ref));
  fail = false;
  const loaded = await loadRendition("item-retry", { ...ref, uri: "https://storage.test/fresh" });

  assert.equal(calls.length, 2);
  assert.equal(calls[1], "https://storage.test/fresh");
  assert.equal(loaded.blocks[0]?.id, "doc_heading_001");
});

test("an unknown rendition schema is refused and not cached", async (context) => {
  const calls = stubFetch(context, () => json({ ...rendition, schema: 2 }));
  const ref = { uri: "https://storage.test/next", version: "v9" };

  await assert.rejects(loadRendition("item-schema", ref));
  await assert.rejects(loadRendition("item-schema", ref));
  assert.equal(calls.length, 2);
});

test("one reader giving up does not cancel the download for another", async (context) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const calls = stubFetch(context, async () => {
    await gate;
    return json(rendition);
  });
  const ref = { uri: "https://storage.test/slow", version: "v1" };
  const controller = new AbortController();

  const abandoned = loadRendition("item-abort", ref, controller.signal);
  const kept = loadRendition("item-abort", ref);
  controller.abort();
  release();

  await assert.rejects(abandoned, { name: "AbortError" });
  assert.equal((await kept).blocks.length, 4);
  assert.equal(calls.length, 1);
});

function stubFetch(
  context: { after: (fn: () => void) => void },
  respond: () => Response | Promise<Response>,
): string[] {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return await respond();
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

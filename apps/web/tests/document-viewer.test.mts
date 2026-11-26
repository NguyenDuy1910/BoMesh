import assert from "node:assert/strict";
import test from "node:test";

import { citationParams, explainPassagePrompt, highlightParam, originParam, parseHighlightParam, parseOrigin, parseReaderQuery, readerHref, revisionNumber } from "../src/modules/knowledge/reader/links.ts";

function query(href: string): URLSearchParams {
  return new URL(href, "http://bomesh.test").searchParams;
}

test("the reader address carries a citation's revision, structure version, blocks, quote, location and highlights, in order", () => {
  assert.equal(readerHref({ item: "workspaces/w/items/doc 1" }), "/doc/doc%201");
  const highlights = [
    { pageNumber: 3, boxes: [{ left: 0.1, top: 0.123456, right: 0.9, bottom: 0.2 }] },
    { pageNumber: 4, boxes: [] },
    { sheet: "Phí 2025!", cellRange: "A24:DH26" },
  ];
  const reference = { revision: "workspaces/w/items/doc1/revisions/4", structureVersion: "0123456789abcdef", refs: ["texts/31", "tables/0"], quote: "Nghỉ 20 ngày", location: "Mục 3", highlights };
  const href = readerHref({ item: "doc1", reference, from: "workspaces/w/conversations/k9", q: "  leave  " });
  assert.ok(href.startsWith("/doc/doc1?"));
  const params = query(href);
  assert.equal(params.get("rev"), "4");
  assert.equal(params.get("ver"), "0123456789abcdef");
  assert.deepEqual(params.getAll("ref"), ["texts/31", "tables/0"]);
  assert.deepEqual(params.getAll("hl"), ["3:0.1,0.1235,0.9,0.2", "4", "Phí 2025!!A24:DH26"]);
  assert.equal(params.get("from"), "k9");
  assert.equal(params.get("q"), "leave");
  assert.deepEqual(parseReaderQuery(params).target, {
    revision: 4,
    structureVersion: "0123456789abcdef",
    refs: ["texts/31", "tables/0"],
    quote: "Nghỉ 20 ngày",
    location: "Mục 3",
    highlights: [{ pageNumber: 3, boxes: [{ left: 0.1, top: 0.1235, right: 0.9, bottom: 0.2 }] }, { pageNumber: 4, boxes: [] }, { sheet: "Phí 2025!", cellRange: "A24:DH26" }],
  });
});

test("a reference without a revision number names no blocks", () => {
  const reference = { revision: "", structureVersion: "0123456789abcdef", refs: ["texts/1"], quote: "q", location: "", highlights: [{ pageNumber: 1, boxes: [] }] };
  assert.equal(readerHref({ item: "d", reference }), "/doc/d");
  assert.deepEqual(citationParams(reference), { rev: "", ver: "", ref: [], quote: "", loc: "", hl: [] });
});

test("an hl= value is a page with its boxes or a sheet range; anything else is dropped", () => {
  assert.equal(highlightParam({ pageNumber: 2 }), "2");
  assert.deepEqual(parseHighlightParam("2"), { pageNumber: 2, boxes: [] });
  assert.deepEqual(parseHighlightParam("Sheet1!B3"), { sheet: "Sheet1", cellRange: "B3" });
  for (const junk of ["0", "two", "2:0.1,0.2,0.3", "2:0.1,0.2,0.3,1.5", "!A1", "Sheet1!", "Sheet1!a1", "Sheet1!A0"]) assert.equal(parseHighlightParam(junk), null, junk);
  const parsed = parseReaderQuery(query("/doc/x?rev=2&ver=0123456789abcdef&ref=texts/1&hl=junk&hl=5"));
  assert.deepEqual(parsed.target?.highlights, [{ pageNumber: 5, boxes: [] }]);
  assert.equal(parsed.target?.quote, "");
});

test("deep-link parameters parse back, ignoring junk", () => {
  const parsed = parseReaderQuery(query("/doc/x?q=%20leave%20&page=3&rev=2&ver=0123456789abcdef&ref=texts/1&ref=texts/2&ref=texts/1&loc=M%E1%BB%A5c%201&from=k&v=0"));
  assert.deepEqual(parsed, {
    q: "leave",
    page: 3,
    target: { revision: 2, structureVersion: "0123456789abcdef", refs: ["texts/1", "texts/2"], quote: "", location: "Mục 1", highlights: [] },
    from: "k",
    v: undefined,
    ask: false,
  });
  assert.equal(parseReaderQuery(query("/doc/x?ask=1")).ask, true);
  assert.equal(parseReaderQuery(query("/doc/x?page=two&v=2")).v, 2);
  assert.equal(parseReaderQuery(query("/doc/x?page=two")).page, undefined);
  // A partial or malformed reference is no target: the reader opens the document without a highlight.
  assert.equal(parseReaderQuery(query("/doc/x?rev=2&ref=texts/1")).target, null);
  assert.equal(parseReaderQuery(query("/doc/x?rev=2&ver=XYZ&ref=texts/1")).target, null);
  assert.equal(parseReaderQuery(query("/doc/x?rev=2&ver=0123456789abcdef")).target, null);
});

test("revision numbers come from revision names", () => {
  assert.equal(revisionNumber("workspaces/w/items/d/revisions/3"), 3);
  assert.equal(revisionNumber(""), undefined);
});

test("asking about a selection quotes it, collapsed and cut to a readable length", () => {
  assert.equal(explainPassagePrompt("  Contractors   follow\nthe terms. "), "Giải thích đoạn trích này: “Contractors follow the terms.”");
  const long = explainPassagePrompt("word ".repeat(100));
  const quote = long.split("“")[1]!.split("”")[0]!;
  assert.ok(quote.endsWith("…"));
  assert.ok(quote.length <= 241);
});

test("the reader's origin round-trips through from=", () => {
  assert.deepEqual(parseOrigin("k9"), { kind: "conversation", id: "k9" });
  assert.deepEqual(parseOrigin("home"), { kind: "home" });
  assert.deepEqual(parseOrigin(originParam({ kind: "space", id: "workspaces/w/spaces/s1" })), { kind: "space", id: "s1" });
  assert.deepEqual(parseOrigin(originParam({ kind: "library", tab: "saved" })), { kind: "library", tab: "saved" });
  assert.equal(parseOrigin(""), null);
  assert.equal(new URL(readerHref({ item: "d", from: "space:s1", ask: true }), "http://x").search, "?from=space%3As1&ask=1");
});

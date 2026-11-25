import assert from "node:assert/strict";
import test from "node:test";

import { explainPassagePrompt, originParam, parseOrigin, parseReaderQuery, readerHref, revisionNumber } from "../src/modules/knowledge/reader/links.ts";

function query(href: string): URLSearchParams {
  return new URL(href, "http://bomesh.test").searchParams;
}

test("the reader address carries a citation's revision, structure version and every cited block, in order", () => {
  assert.equal(readerHref({ item: "workspaces/w/items/doc 1" }), "/doc/doc%201");
  const reference = { revision: "workspaces/w/items/doc1/revisions/4", structureVersion: "0123456789abcdef", refs: ["texts/31", "tables/0"] };
  const href = readerHref({ item: "doc1", reference, from: "workspaces/w/conversations/k9", q: "  leave  ", view: "original" });
  assert.ok(href.startsWith("/doc/doc1?"));
  const params = query(href);
  assert.equal(params.get("rev"), "4");
  assert.equal(params.get("ver"), "0123456789abcdef");
  assert.deepEqual(params.getAll("ref"), ["texts/31", "tables/0"]);
  assert.equal(params.get("from"), "k9");
  assert.equal(params.get("q"), "leave");
  assert.equal(params.get("view"), "original");
  assert.deepEqual(parseReaderQuery(params).target, { revision: 4, structureVersion: "0123456789abcdef", refs: ["texts/31", "tables/0"] });
});

test("a reference without a revision number names no blocks", () => {
  const href = readerHref({ item: "d", reference: { revision: "", structureVersion: "0123456789abcdef", refs: ["texts/1"] } });
  assert.equal(href, "/doc/d");
});

test("deep-link parameters parse back, ignoring junk", () => {
  const parsed = parseReaderQuery(query("/doc/x?q=%20leave%20&page=3&rev=2&ver=0123456789abcdef&ref=texts/1&ref=texts/2&ref=texts/1&from=k&v=0&view=both"));
  assert.deepEqual(parsed, {
    q: "leave",
    page: 3,
    target: { revision: 2, structureVersion: "0123456789abcdef", refs: ["texts/1", "texts/2"] },
    from: "k",
    v: undefined,
    ask: false,
    view: null,
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

import assert from "node:assert/strict";
import test from "node:test";

import { noteLines } from "../src/modules/curation/noteLinks.ts";

test("an import's 'Label: URL' lines become labelled sources named by their decoded file", () => {
  const lines = noteLines(
    "Nguồn: https://fcft.hcmute.edu.vn/Resources/Docs/%C4%90%C3%A1p%20%C3%A1n%20(2016).docx\nTrang liên kết: https://fcft.hcmute.edu.vn/?ArticleId=28e8",
  );
  assert.equal(lines.length, 2);
  const [src, page] = lines;
  assert.ok("label" in src && "label" in page);
  assert.equal(src.label, "Nguồn");
  assert.equal(src.link.host, "fcft.hcmute.edu.vn");
  assert.equal(src.link.tail, "Đáp án (2016).docx");
  assert.equal(page.label, "Trang liên kết");
  assert.equal(page.link.tail, "");
  assert.equal(page.link.full, "https://fcft.hcmute.edu.vn/?ArticleId=28e8");
});

test("addresses inside a sentence become links without the sentence's punctuation; brackets they open stay", () => {
  const [line] = noteLines("Xem https://www.example.edu/a/b. Và (https://example.edu/x_(y)) nữa");
  assert.ok("segments" in line);
  const links = line.segments.flatMap((s) => ("link" in s ? [s.link] : []));
  assert.deepEqual(
    links.map((l) => [l.host, l.href]),
    [
      ["example.edu", "https://www.example.edu/a/b"],
      ["example.edu", "https://example.edu/x_(y)"],
    ],
  );
  assert.equal(line.segments.map((s) => ("text" in s ? s.text : "[link]")).join(""), "Xem [link]. Và ([link]) nữa");
});

test("plain text, other schemes and malformed escapes stay readable text", () => {
  assert.deepEqual(noteLines("Em gửi bản đã ký.\n\njavascript:alert(1)"), [{ segments: [{ text: "Em gửi bản đã ký." }] }, { segments: [{ text: "javascript:alert(1)" }] }]);
  const [line] = noteLines("Nguồn: https://example.edu/bad%E0%A4.pdf");
  assert.ok("label" in line);
  assert.equal(line.link.tail, "bad%E0%A4.pdf");
});

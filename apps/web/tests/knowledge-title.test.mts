import assert from "node:assert/strict";
import test from "node:test";

import { readableTitle } from "../src/modules/knowledge/title.ts";

test("readableTitle unslugs machine-made names", () => {
  // A crawler slug with a content hash welded on: the hash is noise to a reader.
  assert.equal(readableTitle("bai-giang-nguyen-ly-may-d0579879b5b8ce4"), "Bai giang nguyen ly may");
  assert.equal(
    readableTitle("tai-lieu-doi-moi-co-che-quan-ly-va-su-dung-von-su-nghiep-d0a8b3fc226bc64"),
    "Tai lieu doi moi co che quan ly va su dung von su nghiep",
  );
  // No hash, still a slug.
  assert.equal(readableTitle("bai-giang-tin-hoc-dai-cuong"), "Bai giang tin hoc dai cuong");
  // Underscores are separators too.
  assert.equal(readableTitle("my_quarterly_notes_draft"), "My quarterly notes draft");
});

test("readableTitle leaves names a person wrote alone", () => {
  // Any whitespace means someone typed it: punctuation, case and spacing are theirs.
  assert.equal(readableTitle("Q3 Revenue Report"), "Q3 Revenue Report");
  assert.equal(readableTitle("Bài giảng Nguyên lý máy"), "Bài giảng Nguyên lý máy");
  assert.equal(readableTitle("Notes - meeting 2024-05-01"), "Notes - meeting 2024-05-01");
  // No separators at all.
  assert.equal(readableTitle("README"), "README");
  // Too few parts to be a slug: a deliberate short identifier.
  assert.equal(readableTitle("v1-final"), "v1-final");
});

test("readableTitle keeps a hash that is the whole name", () => {
  // Nothing readable to recover; mangling it would only lose information.
  assert.equal(readableTitle("d0579879b5b8ce4"), "d0579879b5b8ce4");
});

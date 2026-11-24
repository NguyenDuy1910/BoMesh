import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { parseFolderTree, templateJson, MAX_ROWS } = await import("../src/modules/knowledge/bases/folderTree.ts");

test("parseFolderTree flattens {folders} depth-first: parents first, trimmed names, descriptions only when set", () => {
  const tree = parseFolderTree(
    "\ufeff" +
      JSON.stringify({
        folders: [
          { name: " Khoa CNTT ", description: " Faculty ", folders: [{ name: "Bài giảng & slide", extra: 1 }, { name: "Đề thi", folders: [{ name: "2026" }] }] },
          { name: "Biểu mẫu", description: "" },
        ],
      }),
  );
  assert.deepEqual(tree, {
    rows: [
      { path: ["Khoa CNTT"], description: "Faculty" },
      { path: ["Khoa CNTT", "Bài giảng & slide"] },
      { path: ["Khoa CNTT", "Đề thi"] },
      { path: ["Khoa CNTT", "Đề thi", "2026"] },
      { path: ["Biểu mẫu"] },
    ],
  });
});

test("parseFolderTree takes a bare array and keeps names the server judges (empty, long, deep) as rows", () => {
  const tree = parseFolderTree(JSON.stringify([{ name: "   " }, { name: "x".repeat(600) }]));
  assert.ok("rows" in tree);
  assert.deepEqual(
    tree.rows.map((r) => r.path[0]!.length),
    [0, 600],
  );
});

test("parseFolderTree names the JSON path of the first node without a text name", () => {
  assert.deepEqual(parseFolderTree(JSON.stringify({ folders: [{ name: "A", folders: [{ name: "B" }, { title: "C" }] }, { name: 3 }] })), {
    error: "Thư mục tại $.folders[0].folders[1] không có tên.",
  });
  assert.deepEqual(parseFolderTree(JSON.stringify([{ name: 3 }])), { error: "Thư mục tại $[0] không có tên." });
  assert.deepEqual(parseFolderTree(JSON.stringify([null])), { error: "Thư mục tại $[0] không có tên." });
  assert.deepEqual(parseFolderTree(JSON.stringify([{ name: "A", folders: {} }])), { error: "Mục “folders” tại $[0] không phải danh sách." });
  assert.deepEqual(parseFolderTree(JSON.stringify([{ name: "A", description: 1 }])), { error: "Mô tả tại $[0] không phải văn bản." });
});

test("parseFolderTree rejects invalid JSON, other shapes, empty files and more than 1000 folders", () => {
  assert.deepEqual(parseFolderTree("{"), { error: "Tệp không phải JSON hợp lệ." });
  assert.deepEqual(parseFolderTree('{"items": []}'), { error: "Tệp phải là một danh sách thư mục, hoặc một đối tượng có danh sách “folders”." });
  assert.deepEqual(parseFolderTree("[]"), { error: "Tệp không có thư mục nào." });
  assert.ok("error" in parseFolderTree(JSON.stringify(Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ name: `F${i}` })))));
  assert.ok("rows" in parseFolderTree(JSON.stringify(Array.from({ length: MAX_ROWS }, (_, i) => ({ name: `F${i}` })))));
});

test("the template parses into rows", () => {
  const tree = parseFolderTree(templateJson());
  assert.ok("rows" in tree && tree.rows.length === 4);
});

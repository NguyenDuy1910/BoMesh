import assert from "node:assert/strict";
import test from "node:test";

import { expandPicked, zipMembers, type Picked } from "../src/modules/knowledge/upload-sources.ts";

/** A minimal ZIP writer (CRC left 0: the reader doesn't check it). `deflate` members use deflate-raw. */
async function makeZip(members: { path: string; body: string; deflate?: boolean; utf8Flag?: boolean }[]): Promise<Blob> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const m of members) {
    const name = enc.encode(m.path);
    const raw = enc.encode(m.body);
    const data = m.deflate ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()) : raw;
    const flags = m.utf8Flag === false ? 0 : 0x800;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, m.deflate ? 8 : 0, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, name.length, true);
    locals.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(8, flags, true);
    cen.setUint16(10, m.deflate ? 8 : 0, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, raw.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const dirSize = central.reduce((n, part) => n + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, members.length, true);
  eocd.setUint16(10, members.length, true);
  eocd.setUint32(12, dirSize, true);
  eocd.setUint32(16, offset, true);
  return new Blob([...locals, ...central, new Uint8Array(eocd.buffer)]);
}

const accepts = ({ name, size }: { name: string; size: number }) => size > 0 && /\.(pdf|md|docx)$/i.test(name);

test("a ZIP adds its documents, flat, each with where it came from; stored and deflated members read back", async () => {
  const zip = await makeZip([
    { path: "Hồ sơ/", body: "" },
    { path: "Hồ sơ/Quy chế.pdf", body: "%PDF-1.4 quy che" },
    { path: "Hồ sơ/Học vụ/Hướng dẫn.md", body: "# Hướng dẫn\n".repeat(50), deflate: true },
  ]);
  const { added, leftOut, unreadable } = await expandPicked([{ file: new File([zip], "hoso.zip"), path: "" }], accepts);
  assert.deepEqual(unreadable, []);
  assert.deepEqual(leftOut, []);
  assert.deepEqual(
    added.map((a) => [a.file.name, a.where]),
    [
      ["Quy chế.pdf", "hoso.zip/Hồ sơ"],
      ["Hướng dẫn.md", "hoso.zip/Hồ sơ/Học vụ"],
    ],
  );
  assert.equal(await added[1].file.text(), "# Hướng dẫn\n".repeat(50));
});

test("system files are dropped silently; other types, nested ZIPs and escaping paths are counted per source", async () => {
  const zip = await makeZip([
    { path: "__MACOSX/._a.pdf", body: "x" },
    { path: "docs/.DS_Store", body: "x" },
    { path: "docs/a.pdf", body: "%PDF" },
    { path: "docs/photo.png", body: "png" },
    { path: "docs/inner.zip", body: "zip" },
    { path: "../evil.pdf", body: "%PDF" },
  ]);
  const { added, leftOut } = await expandPicked([{ file: new File([zip], "pack.zip"), path: "" }], accepts);
  assert.deepEqual(added.map((a) => a.file.name), ["a.pdf"]);
  // The climbing path is not a member at all; the image and the nested ZIP are left out.
  assert.deepEqual(leftOut, [{ source: "pack.zip", count: 2 }]);
});

test("folder files keep their folder, count what can't be sent under the top folder, and loose files pass through", async () => {
  const picked: Picked[] = [
    { file: new File(["%PDF"], "a.pdf"), path: "Thesis/Ch 1/a.pdf" },
    { file: new File(["x"], "b.png"), path: "Thesis/b.png" },
    { file: new File(["x"], ".hidden.md"), path: "Thesis/.hidden.md" },
    { file: new File(["anything"], "loose.png"), path: "" },
  ];
  const { added, leftOut } = await expandPicked(picked, accepts);
  assert.deepEqual(
    added.map((a) => [a.file.name, a.where]),
    [
      ["a.pdf", "Thesis/Ch 1"],
      ["loose.png", ""],
    ],
  );
  assert.deepEqual(leftOut, [{ source: "Thesis", count: 1 }]);
});

test("a ZIP inside a picked folder opens too; a file that isn't a ZIP is reported unreadable", async () => {
  const inner = await makeZip([{ path: "form.docx", body: "docx" }]);
  const picked: Picked[] = [
    { file: new File([inner], "forms.zip"), path: "Unit/forms.zip" },
    { file: new File(["not a zip"], "broken.zip"), path: "" },
  ];
  const { added, unreadable } = await expandPicked(picked, accepts);
  assert.deepEqual(added.map((a) => [a.file.name, a.where]), [["form.docx", "Unit/forms.zip"]]);
  assert.deepEqual(unreadable.map((f) => f.name), ["broken.zip"]);
});

test("names without the UTF-8 flag still decode as UTF-8 when they are", async () => {
  const zip = await makeZip([{ path: "Đơn xin.pdf", body: "%PDF", utf8Flag: false }]);
  assert.deepEqual((await zipMembers(zip)).map((m) => m.path), ["Đơn xin.pdf"]);
});

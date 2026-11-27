import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { parseSheet, planSheet, readSheet, sheetRow, templateRows, toCsv, COLUMNS, MAX_ROWS } = await import("../src/modules/curation/conceptSheet.ts");
const { readXlsx, XlsxError } = await import("../src/lib/xlsx.ts");
const { buildTaxonomy } = await import("../src/modules/knowledge/taxonomy.ts");

const W = "workspaces/w/conceptSchemes";
const domain = { name: `${W}/domain`, displayName: "Lĩnh vực", purpose: "CLASSIFICATION", position: 1 } as const;
const audience = { name: `${W}/audience`, displayName: "Đối tượng", purpose: "CLASSIFICATION", position: 2 } as const;
const t = buildTaxonomy(
  [domain, audience],
  [
    { name: `${W}/domain/concepts/it`, prefLabels: [{ languageCode: "vi", text: "Công nghệ thông tin" }, { languageCode: "en", text: "IT" }], altLabels: [{ languageCode: "en", text: "Computing" }], definition: "Máy tính.", state: "PUBLISHED" },
    { name: `${W}/domain/concepts/ai`, prefLabels: [{ languageCode: "vi", text: "Trí tuệ nhân tạo" }], broader: [`${W}/domain/concepts/it`], state: "PUBLISHED" },
    { name: `${W}/domain/concepts/old`, prefLabels: [{ languageCode: "vi", text: "Cũ" }], state: "DEPRECATED" },
    { name: `${W}/audience/concepts/student`, prefLabels: [{ languageCode: "vi", text: "Sinh viên" }], state: "PUBLISHED" },
  ],
);

type Sheet = Exclude<ReturnType<typeof parseSheet>, { error: string }>;
function sheet(text: string): Sheet {
  const s = parseSheet(text);
  assert.ok(!("error" in s), "parses");
  return s as Sheet;
}

test("parseSheet reads quoted CSV and TSV; headers in any order and case; cells cleaned, long text keeps its lines", () => {
  const s = sheet('\ufeffNotation,Pref VI,Definition\nit,"Công nghệ,  thông tin","Dòng 1.\r\n\r\n\r\nDòng  2."\n');
  assert.deepEqual(s.rows, [{ line: 2, cells: { notation: "it", pref_vi: "Công nghệ, thông tin", definition: "Dòng 1.\n\nDòng 2." } }]);
  assert.deepEqual([...s.columns].sort(), ["definition", "notation", "pref_vi"]);
  assert.equal(sheet("scheme\tnotation\tpref_en\ndomain\tai\tAI\n").rows[0].cells.pref_en, "AI");
});

test("rows keep their spreadsheet row numbers past blank rows and multi-line cells", () => {
  const s = sheet('\n notation , pref_vi \n\na,A\n"b",",\n"\n,\nc,C\n');
  assert.deepEqual(
    s.rows.map((r) => r.line),
    [4, 5, 7],
  );
});

test("empty, header-only, name-less and oversized files are errors", () => {
  assert.deepEqual(parseSheet(""), { error: "Tệp trống." });
  assert.deepEqual(parseSheet("notation,pref_vi\n,\n"), { error: "Tệp có tiêu đề nhưng không có hàng nào." });
  assert.ok("error" in parseSheet("scheme,definition\ndomain,x\n"));
  const big = ["notation,pref_vi", ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `c${i},C${i}`)].join("\n");
  assert.ok("error" in parseSheet(big));
});

test("planSheet: rows match by scheme and notation; absent columns are left out, empty cells clear, names never clear", () => {
  const { batches, skipped } = planSheet(sheet("scheme,notation,pref_vi,pref_en,alt,definition\ndomain,it,,,vi:tin học; en:ICT; máy tính,\naudience,student,Người học,Learner,,\n"), t, domain);
  assert.deepEqual(skipped, []);
  assert.deepEqual(
    batches.map((b) => [b.scheme.name, b.lines]),
    [
      [domain.name, [2]],
      [audience.name, [3]],
    ],
  );
  assert.deepEqual(batches[0].rows[0], { notation: "it", altVi: "tin học|máy tính", altEn: "ICT", definition: "" });
  assert.deepEqual(batches[1].rows[0], { notation: "student", prefVi: "Người học", prefEn: "Learner", altVi: "", altEn: "", definition: "" });
});

test("planSheet: without a scheme column rows go to the current scheme; a row without a notation gets one from its name", () => {
  const { batches } = planSheet(sheet("notation,pref_vi,broader\n,Học máy,it\n,Học máy,ai\n"), t, domain);
  assert.deepEqual(
    batches[0].rows.map((r) => [r.notation, r.broader]),
    [
      ["hoc-may", "it"],
      ["hoc-may-2", "ai"],
    ],
  );
});

test("planSheet: bad rows are skipped with why; broader may name a concept the file adds", () => {
  const csv = [
    "scheme,notation,pref_vi,broader",
    ",x,X,",
    "nope,x,X,",
    "domain,Bad Code,X,",
    "domain,old,Cũ,",
    "domain,new-one,,",
    "domain,it,IT,",
    "domain,it,IT again,",
    "domain,child,Con,parent",
    "domain,parent,Cha,",
    "domain,lost,Lạc,missing",
    "domain,self,Tự,self",
  ].join("\n");
  const { batches, skipped } = planSheet(sheet(csv), t, domain);
  assert.deepEqual(
    skipped.map((s) => s.line),
    [2, 3, 4, 5, 6, 8, 11, 12],
  );
  assert.match(skipped[1].reason, /nope/);
  assert.match(skipped[6].reason, /missing/);
  assert.deepEqual(
    batches[0].rows.map((r) => r.notation),
    ["it", "child", "parent"],
  );
});

test("sheetRow and templateRows write the preview's columns; toCsv quotes and round-trips", () => {
  assert.deepEqual(sheetRow(t, `${W}/domain/concepts/ai`), ["domain", "ai", "it", "Trí tuệ nhân tạo", "", "", "", "", ""]);
  const rows = templateRows(t, `${W}/domain/concepts/it`);
  assert.deepEqual(rows[0], [...COLUMNS]);
  assert.deepEqual(rows[1], ["domain", "it", "", "Công nghệ thông tin", "IT", "en:Computing", "", "Máy tính.", ""]);
  const csv = toCsv([["notation", "pref_vi", "definition"], ["it", 'Say "hi", ok', "a\nb"]]);
  assert.ok(csv.startsWith("\ufeff"));
  assert.deepEqual(sheet(csv).rows[0].cells, { notation: "it", pref_vi: 'Say "hi", ok', definition: "a\nb" });
});

/* ── A tiny .xlsx built in the test: a ZIP with deflated and stored parts ── */

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zip(files: Record<string, string>, store: readonly string[] = []): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const stored = store.includes(name);
    const data = stored ? raw : await deflate(raw);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(8, stored ? 0 : 8, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, raw.length, true);
    head.setUint16(26, nameBytes.length, true);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(10, stored ? 0 : 8, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, raw.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    local.push(new Uint8Array(head.buffer), nameBytes, data);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...local, ...central, new Uint8Array(end.buffer)]).arrayBuffer());
}

const WORKBOOK = {
  "[Content_Types].xml": "<Types/>",
  "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Concepts" sheetId="1" r:id="rId3"/><sheet name="Other" sheetId="2" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="worksheet" Target="/xl/worksheets/concepts.xml"/></Relationships>',
  "xl/sharedStrings.xml":
    '<sst count="6"><si><t>notation</t></si><si><t>pref_vi</t></si><si><t>scheme</t></si><si><r><t>Cards </t></r><r><rPr><b/></rPr><t xml:space="preserve">&amp; disputes</t></r><rPh><t>x</t></rPh></si><si><t>Use for cards._x000D_\nNot fees.</t></si><si><t>definition</t></si></sst>',
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>',
  "xl/worksheets/concepts.xml":
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>5</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>ops</t></is></c><c r="B2" t="str"><v>Banking &lt;Ops&gt;</v></c></row>' +
    '<row r="4" spans="1:4"><c r="A4" t="inlineStr"><is><t>ops-01</t></is></c><c r="B4" t="s"><v>3</v></c><c r="C4" t="inlineStr"><is><t>ops</t></is></c><c r="D4" t="s"><v>4</v></c></row>' +
    '<row r="5"><c r="B5"><v>42</v></c><c r="C5" t="b"><v>1</v></c></row></sheetData></worksheet>',
};

test("readXlsx reads the first worksheet's cells by row and column", async () => {
  const cells = await readXlsx(await zip(WORKBOOK, ["xl/sharedStrings.xml"]));
  assert.deepEqual(cells, [["notation", "pref_vi", "scheme", "definition"], ["ops", "Banking <Ops>"], [], ["ops-01", "Cards & disputes", "ops", "Use for cards.\r\nNot fees."], ["", "42", "TRUE"]]);
  const s = readSheet(cells);
  assert.ok(!("error" in s));
  assert.deepEqual(
    s.rows.map((r) => r.line),
    [2, 4, 5],
  );
  assert.deepEqual(s.rows[1].cells, { notation: "ops-01", pref_vi: "Cards & disputes", scheme: "ops", definition: "Use for cards.\nNot fees." });
});

test("readXlsx falls back to sheet1 and rejects files that aren't workbooks", async () => {
  const plain = await zip({ "xl/worksheets/sheet1.xml": '<x:worksheet><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>code</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>name</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>' });
  assert.deepEqual(await readXlsx(plain), [["code", "name"]]);
  await assert.rejects(readXlsx(new TextEncoder().encode("code,name\nx,X\n")), XlsxError);
  await assert.rejects(readXlsx(await zip({ "a.txt": "x" })), XlsxError);
});

import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { exportRows, parseSheet, rowsToImport, TEMPLATE_ROWS, toCsv, MAX_ROWS } = await import("../src/modules/curation/topicSheet.ts");
const { readXlsx, XlsxError } = await import("../src/lib/xlsx.ts");

type Parsed = Exclude<ReturnType<typeof parseSheet>, { error: string }>;

function sheet(text: string): Parsed {
  const s = parseSheet(text);
  assert.ok(!("error" in s), "parses");
  return s as Parsed;
}

test("parseSheet reads quoted CSV and TSV with header aliases", () => {
  const s = sheet('\ufeffCode,Name,Parent,Description\nops,"Banking, Operations",,"Say ""hi"""\n  OPS-01 , Cards   &  disputes ,ops,\n');
  assert.deepEqual(s.rows, [
    { code: "ops", name: "Banking, Operations", parentCode: "", description: 'Say "hi"' },
    { code: "OPS-01", name: "Cards & disputes", parentCode: "ops", description: "" },
  ]);
  const t = sheet("code\tname\tdomain_code\tSynonym\tGuidance for the assistant\nx\tX\tops\ta\tb\n");
  assert.deepEqual(t.rows, [{ code: "x", name: "X", parentCode: "ops", synonyms: ["a"], guidance: "b" }]);
  assert.equal(sheet("code,name,Assistant guidance\nx,X,g\n").rows[0].guidance, "g");
});

test("absent columns are left out of every row; empty cells send empty values", () => {
  const s = sheet("code,name\nops,Ops\n");
  assert.deepEqual(s.rows, [{ code: "ops", name: "Ops" }]);
  assert.deepEqual(s.missing, ["description", "keywords", "synonyms", "guidance"]);
  const e = sheet("code,name,parent_code,description,keywords,synonyms,guidance\nops,Ops,,,,,\n");
  assert.deepEqual(e.rows, [{ code: "ops", name: "Ops", parentCode: "", description: "", keywords: [], synonyms: [], guidance: "" }]);
  assert.deepEqual(e.missing, []);
});

test("keywords and synonyms split on , ; | and line breaks; guidance keeps line breaks", () => {
  const s = sheet('code,name,keywords,synonyms,guidance\nx,X,"a, b;c | d\ne;a",,"  Use for  cards.\r\n\r\n\r\n\r\nNot   fees. "\n');
  assert.deepEqual(s.rows[0].keywords, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(s.rows[0].synonyms, []);
  assert.equal(s.rows[0].guidance, "Use for cards.\n\nNot fees.");
});

test("rows keep their spreadsheet row numbers past blank rows and multi-line cells", () => {
  const s = sheet('\n code , name \n\na,A\n"b",",\n"\n,\nc,C\n');
  assert.deepEqual(
    s.rows.map((r) => r.code),
    ["a", "b", "c"],
  );
  assert.deepEqual(s.lines, [4, 5, 7]);
});

test("empty, header-only, header-less and oversized files are errors", () => {
  assert.deepEqual(parseSheet(""), { error: "The file is empty." });
  assert.deepEqual(parseSheet(" \n,,\n"), { error: "The file is empty." });
  assert.deepEqual(parseSheet("code,name\n,\n"), { error: "The file has a header but no rows." });
  assert.ok("error" in parseSheet("name,description\nx,y\n"));
  const big = ["code,name", ...Array.from({ length: MAX_ROWS + 1 }, (_, i) => `t${i},T`)].join("\n");
  assert.ok("error" in parseSheet(big));
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
  "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Topics" sheetId="1" r:id="rId3"/><sheet name="Other" sheetId="2" r:id="rId1"/></sheets></workbook>',
  "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="worksheet" Target="/xl/worksheets/topics.xml"/></Relationships>',
  "xl/sharedStrings.xml":
    '<sst count="6"><si><t>code</t></si><si><t>name</t></si><si><t>parent_code</t></si><si><r><t>Cards </t></r><r><rPr><b/></rPr><t xml:space="preserve">&amp; disputes</t></r><rPh><t>x</t></rPh></si><si><t>Use for cards._x000D_\nNot fees.</t></si><si><t>guidance</t></si></sst>',
  "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong sheet</t></is></c></row></sheetData></worksheet>',
  "xl/worksheets/topics.xml":
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>5</v></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>ops</t></is></c><c r="B2" t="str"><v>Banking &lt;Ops&gt;</v></c></row>' +
    '<row r="4" spans="1:4"><c r="A4" t="inlineStr"><is><t>ops-01</t></is></c><c r="B4" t="s"><v>3</v></c><c r="C4" t="inlineStr"><is><t>ops</t></is></c><c r="D4" t="s"><v>4</v></c></row>' +
    '<row r="5"><c r="B5"><v>42</v></c><c r="C5" t="b"><v>1</v></c></row></sheetData></worksheet>',
};

test("readXlsx reads the first worksheet's cells by row and column", async () => {
  const cells = await readXlsx(await zip(WORKBOOK, ["xl/sharedStrings.xml"]));
  assert.deepEqual(cells, [["code", "name", "parent_code", "guidance"], ["ops", "Banking <Ops>"], [], ["ops-01", "Cards & disputes", "ops", "Use for cards.\r\nNot fees."], ["", "42", "TRUE"]]);
  const s = rowsToImport(cells);
  assert.ok(!("error" in s));
  assert.deepEqual(s.lines, [2, 4, 5]);
  assert.deepEqual(s.rows[1], { code: "ops-01", name: "Cards & disputes", parentCode: "ops", guidance: "Use for cards.\nNot fees." });
  assert.deepEqual(s.missing, ["description", "keywords", "synonyms"]);
});

test("readXlsx falls back to sheet1 and rejects files that aren't workbooks", async () => {
  const plain = await zip({ "xl/worksheets/sheet1.xml": '<x:worksheet><x:sheetData><x:row><x:c t="inlineStr"><x:is><x:t>code</x:t></x:is></x:c><x:c t="inlineStr"><x:is><x:t>name</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>' });
  assert.deepEqual(await readXlsx(plain), [["code", "name"]]);
  await assert.rejects(readXlsx(new TextEncoder().encode("code,name\nx,X\n")), XlsxError);
  await assert.rejects(readXlsx(await zip({ "a.txt": "x" })), XlsxError);
});

const topics = [
  { name: "w/topics/ops", displayName: "Banking Operations", kind: "DOMAIN", state: "ACTIVE", description: "Ops" },
  { name: "w/topics/cards", displayName: "Cards, disputes", kind: "TOPIC", parentTopic: "w/topics/ops", state: "ACTIVE", keywords: ["chargeback", "dispute"], synonyms: ["card dispute"], guidance: "Use for cards.\nNot fees." },
  { name: "w/topics/gone", displayName: "Gone", kind: "TOPIC", parentTopic: "w/topics/ops", state: "DELETED" },
  { name: "w/topics/old", displayName: "Old", kind: "DOMAIN", state: "DELETED" },
  { name: "w/topics/hr", displayName: "People", kind: "DOMAIN", state: "ACTIVE" },
  { name: "w/topics/prop", displayName: "Open banking", kind: "TOPIC", parentTopic: "w/topics/hr", state: "PROPOSED" },
] as const;

test("exportRows writes topic IDs as codes, ACTIVE domains each followed by their ACTIVE topics", () => {
  const rows = exportRows(topics as never);
  assert.deepEqual(rows, [
    ["code", "name", "parent_code", "description", "keywords", "synonyms", "guidance"],
    ["ops", "Banking Operations", "", "Ops", "", "", ""],
    ["cards", "Cards, disputes", "ops", "", "chargeback; dispute", "card dispute", "Use for cards.\nNot fees."],
    ["hr", "People", "", "", "", "", ""],
  ]);
});

test("toCsv quotes cells and round-trips through parseSheet", () => {
  const csv = toCsv(exportRows(topics as never));
  assert.ok(csv.startsWith("\ufeffcode,name,"));
  assert.ok(csv.includes('cards,"Cards, disputes",ops,,chargeback; dispute,card dispute,"Use for cards.\nNot fees."\r\n'));
  const s = sheet(csv);
  assert.deepEqual(s.rows[1], { code: "cards", name: "Cards, disputes", parentCode: "ops", description: "", keywords: ["chargeback", "dispute"], synonyms: ["card dispute"], guidance: "Use for cards.\nNot fees." });
  assert.deepEqual(s.lines, [2, 3, 4]);
});

test("template codes are valid topic IDs", () => {
  for (const r of TEMPLATE_ROWS.slice(1)) {
    assert.match(r[0], /^[a-z][a-z0-9-]{0,62}$/);
    if (r[2]) assert.match(r[2], /^[a-z][a-z0-9-]{0,62}$/);
  }
  assert.ok(!("error" in parseSheet(toCsv(TEMPLATE_ROWS))));
});

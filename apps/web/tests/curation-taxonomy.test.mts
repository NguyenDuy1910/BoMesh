import assert from "node:assert/strict";
import test from "node:test";

import { changeCount, diffTaxonomy, exportRows, parseSheet, toCsv, type Sheet } from "../src/modules/curation/taxonomy.ts";

const topics = [
  { name: "t/ops", displayName: "Banking Operations", kind: "DOMAIN", state: "ACTIVE", description: "Ops" },
  { name: "t/cards", displayName: "Cards & disputes", kind: "TOPIC", parentTopic: "t/ops", state: "ACTIVE", description: "" },
  { name: "t/recon", displayName: "Reconciliation", kind: "TOPIC", parentTopic: "t/ops", state: "ACTIVE", documentCount: 3 },
  { name: "t/old", displayName: "Old topic", kind: "TOPIC", parentTopic: "t/ops", state: "ACTIVE" },
  { name: "t/gone", displayName: "Gone", kind: "TOPIC", parentTopic: "t/ops", state: "DELETED" },
  { name: "t/hr", displayName: "People", kind: "DOMAIN", state: "ACTIVE" },
  { name: "t/prop", displayName: "Open banking", kind: "TOPIC", state: "PROPOSED" },
] as const;

const used = (t: { documentCount?: number; inReviewCount?: number }) => (t.documentCount ?? 0) + (t.inReviewCount ?? 0) > 0;

function sheet(text: string): Sheet {
  const s = parseSheet(text);
  assert.ok(!("error" in s), "parses");
  return s as Sheet;
}

test("parseSheet reads quoted CSV, aliases and which columns the file has", () => {
  const s = sheet('\ufeffCode,Name,Parent,Keywords\nops,"Banking, Operations",,\nOPS-01,"Say ""hi""",ops,x\n');
  assert.equal(s.rows.length, 2);
  assert.equal(s.rows[0].name, "Banking, Operations");
  assert.equal(s.rows[1].name, 'Say "hi"');
  assert.equal(s.rows[1].parent, "OPS");
  assert.equal(s.hasDescription, false);
  assert.deepEqual(s.ignored, ["keywords"]);
  assert.ok("error" in parseSheet("name\nx\n"));
  assert.ok("error" in parseSheet(""));
});

test("diffTaxonomy matches by name, detects moves, restores and skips bad rows", () => {
  const s = sheet(
    [
      "code,name,parent_code,description",
      "OPS,Banking Operations,,Ops",
      "OPS-01,Cards & disputes,OPS,Chargebacks",
      "HR,People,,",
      "HR-01,Reconciliation,HR,",
      "OPS-02,Gone,OPS,",
      "OPS-03,Open banking,OPS,",
      "OPS-01,Duplicate,OPS,",
      "X-01,Orphan,X,",
      ",No code,,",
    ].join("\n"),
  );
  const d = diffTaxonomy(s, topics as never, "merge", used as never);
  assert.deepEqual(
    d.added.map((c) => c.name),
    ["Open banking"],
  );
  const what = Object.fromEntries(d.updated.map((c) => [c.name, c.what]));
  assert.deepEqual(what["Cards & disputes"], ["description"]);
  assert.deepEqual(what["Reconciliation"], ["moved to People"]);
  assert.deepEqual(what["Gone"], ["restored"]);
  assert.equal(d.same, 2);
  assert.deepEqual(
    d.errors.map((e) => e.row),
    [8, 9, 10],
  );
  assert.deepEqual(
    d.covered.map((t) => t.name),
    ["t/prop"],
  );
  assert.equal(d.archived.length, 0);
});

test("Replace archives unused topics missing from the file and keeps used ones", () => {
  const s = sheet("code,name,parent_code\nOPS,Banking Operations,\nOPS-01,Cards & disputes,OPS\n");
  const d = diffTaxonomy(s, topics as never, "replace", used as never);
  assert.deepEqual(d.archived.map((t) => t.name).sort(), ["t/hr", "t/old"]);
  assert.deepEqual(
    d.kept.map((t) => t.name),
    ["t/recon"],
  );
  assert.equal(changeCount(d), 2);
});

test("exportRows round-trips through parseSheet with linked codes", () => {
  const rows = exportRows(topics as never);
  assert.deepEqual(rows[1].slice(0, 3), ["BAN", "Banking Operations", ""]);
  assert.deepEqual(rows[2].slice(0, 3), ["BAN-01", "Cards & disputes", "BAN"]);
  const s = sheet(toCsv(rows));
  const d = diffTaxonomy(s, topics as never, "merge", used as never);
  assert.equal(changeCount(d), 0);
  assert.equal(d.errors.length, 0);
});

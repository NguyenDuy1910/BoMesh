import assert from "node:assert/strict";
import test from "node:test";

import "./support/register-aliases.mjs";

const { changeKindText, depthOf, impactLines, nameClash, newNotation, relatedOf, sharedLabelsOf, suggestedGroups, warningLines, withoutLabel } = await import(
  "../src/modules/curation/governance.ts"
);
const { suggestedFilter, unclassifiedFilter } = await import("../src/modules/curation/docFilter.ts");
const { buildTaxonomy } = await import("../src/modules/knowledge/taxonomy.ts");

const W = "workspaces/w/conceptSchemes";
const D = `${W}/domain/concepts`;
const t = buildTaxonomy(
  [{ name: `${W}/domain`, displayName: "Lĩnh vực", purpose: "CLASSIFICATION" }],
  [
    { name: `${D}/it`, prefLabels: [{ languageCode: "vi", text: "Công nghệ thông tin" }], state: "PUBLISHED" },
    { name: `${D}/ai`, prefLabels: [{ languageCode: "vi", text: "Trí tuệ nhân tạo" }], broader: [`${D}/it`], related: [`${D}/data`], state: "PUBLISHED" },
    { name: `${D}/data`, prefLabels: [{ languageCode: "vi", text: "Dữ liệu" }], state: "PUBLISHED" },
    { name: `${D}/ml`, prefLabels: [{ languageCode: "vi", text: "Học máy" }], broader: [`${D}/ai`, `${D}/data`], state: "PUBLISHED" },
    { name: `${D}/draft`, prefLabels: [{ languageCode: "vi", text: "Nháp" }], state: "DRAFT" },
  ],
);
const SCOPE = ["workspaces/w/items/a"];
const DOCS = 'itemKind = DOCUMENT AND document.purpose = KNOWLEDGE AND ancestors:"workspaces/w/items/a"';

test("newNotation makes a notation from a name, unique among the taken ones", () => {
  assert.equal(newNotation("Học máy & AI", new Set()), "hoc-may-ai");
  assert.equal(newNotation("Học máy", new Set(["hoc-may", "hoc-may-2"])), "hoc-may-3");
  assert.equal(newNotation("2024 plan", new Set()), "c-plan");
  assert.equal(newNotation("—", new Set()), "concept");
});

test("nameClash compares preferred labels as the backend does, ignoring the concept itself", () => {
  assert.equal(nameClash(t, `${W}/domain`, "  học MÁY ")?.name, `${D}/ml`);
  assert.equal(nameClash(t, `${W}/domain`, "Học máy", `${D}/ml`), undefined);
  assert.equal(nameClash(t, `${W}/domain`, "Hoc may"), undefined);
});

test("relatedOf reads the relation both ways; depthOf follows the longest same-scheme path", () => {
  assert.deepEqual(relatedOf(t, t.byName.get(`${D}/data`)!), [`${D}/ai`]);
  assert.equal(depthOf(t, `${D}/it`), 1);
  assert.equal(depthOf(t, `${D}/ml`), 3);
});

test("withoutLabel drops one label by language and normalized text", () => {
  const labels = [
    { languageCode: "vi", text: "Tin học" },
    { languageCode: "en", text: "Tin học" },
  ];
  assert.deepEqual(withoutLabel(labels, "vi", " tin HỌC "), [{ languageCode: "en", text: "Tin học" }]);
});

test("sharedLabelsOf splits a scheme's labels shared within it from those shared with other schemes", () => {
  const shared = [
    { label: "khóa luận", crossScheme: false, concepts: [{ concept: `${D}/ai`, scheme: `${W}/domain` }] },
    { label: "đào tạo", crossScheme: true, concepts: [{ concept: `${D}/it`, scheme: `${W}/domain` }, { concept: `${W}/function/concepts/x`, scheme: `${W}/function` }] },
    { label: "khác", crossScheme: false, concepts: [{ concept: `${W}/function/concepts/y`, scheme: `${W}/function` }] },
  ];
  const r = sharedLabelsOf(shared, `${W}/domain`);
  assert.deepEqual(
    r.within.map((x) => x.label),
    ["khóa luận"],
  );
  assert.deepEqual(
    r.across.map((x) => x.label),
    ["đào tạo"],
  );
});

test("changeKindText names a deprecation by its replacements: merged, split or retired", () => {
  assert.equal(changeKindText({ kind: "DEPRECATED", replacedBy: ["a"] }), "Đã gộp");
  assert.equal(changeKindText({ kind: "DEPRECATED", replacedBy: ["a", "b"] }), "Tách");
  assert.equal(changeKindText({ kind: "DEPRECATED" }), "Ngừng dùng");
  assert.equal(changeKindText({ kind: "ADDED" }), "Đã thêm");
});

test("warningLines gathers shared labels and missing scope notes into one line each", () => {
  const lines = warningLines(t, `${W}/domain`, [
    { kind: "SHARED_LABEL", label: "a" },
    { kind: "SHARED_LABEL", label: "b" },
    { kind: "MISSING_SCOPE_NOTE", concepts: [`${D}/ai`] },
    { kind: "MISSING_SCOPE_NOTE", concepts: [`${D}/ai`, `${D}/ml`] },
  ]);
  assert.deepEqual(lines, [
    { text: "2 nhãn dùng chung cho hai khái niệm trở lên", conflicts: true },
    { text: "Chưa có phạm vi:", names: "Trí tuệ nhân tạo, Học máy" },
  ]);
});

test("impactLines says what publishing does to documents, or that nothing is classified again", () => {
  assert.deepEqual(impactLines(t, undefined), ["Không tài liệu nào phải phân loại lại: tên, nhãn và định nghĩa được áp dụng ngay."]);
  assert.deepEqual(impactLines(t, { remappedCount: 12, rerank: [{ concept: `${D}/data`, among: [`${D}/ai`, `${D}/ml`] }] }), [
    "12 nhãn được ánh xạ lại sang khái niệm thay thế",
    "Tài liệu của “Dữ liệu” được phân loại lại giữa Trí tuệ nhân tạo, Học máy",
  ]);
});

test("suggestedGroups: one card per concept, without the documents of narrower concepts that have their own", () => {
  const counts = new Map([
    [`${D}/it`, 10],
    [`${D}/ai`, 6],
    [`${D}/ml`, 4],
    [`${D}/data`, 4],
    ["unknown", 3],
  ]);
  assert.deepEqual(suggestedGroups(t, counts), [
    { concept: `${D}/it`, scheme: `${W}/domain`, n: 4, except: [`${D}/ai`] },
    { concept: `${D}/ml`, scheme: `${W}/domain`, n: 4, except: [] },
    { concept: `${D}/ai`, scheme: `${W}/domain`, n: 2, except: [`${D}/ml`] },
  ]);
});

test("suggestedFilter and unclassifiedFilter: published documents in scope, a card's concept without its narrower cards, a scheme's uncertain pool", () => {
  assert.equal(suggestedFilter(SCOPE), `${DOCS} AND document.publicationState = PUBLISHED AND document.suggestedConcepts:*`);
  assert.equal(
    suggestedFilter(SCOPE, `${D}/it`, [`${D}/ai`]),
    `${DOCS} AND document.publicationState = PUBLISHED AND document.suggestedConcepts:"${D}/it" AND NOT (document.suggestedConcepts:"${D}/ai")`,
  );
  assert.equal(unclassifiedFilter(SCOPE, `${W}/domain`), `${DOCS} AND document.publicationState = PUBLISHED AND document.uncertainSchemes:"${W}/domain"`);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./support/register-aliases.mjs";

const { DOMAIN_COLORS, freeDomainColor, categoryColor } = await import("../src/lib/tones.ts");
const { CONCEPT_ICONS } = await import("../src/modules/home/domainIcon.ts");
const tx = await import("../src/modules/knowledge/taxonomy.ts");
const model = await import("../src/modules/knowledge/model.ts");

const preview = (path: string) => readFileSync(new URL(`../../ux_preview/scripts/${path}`, import.meta.url), "utf8");
/** The `[value, label]` pairs of a preview list literal `const NAME = [...];`. */
function previewPairs(path: string, name: string): [string, string][] {
  const body = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`).exec(preview(path))?.[1] ?? "";
  return [...body.matchAll(/\['([^']+)', '([^']+)'\]/g)].map((m) => [m[1]!, m[2]!]);
}

/* ── A small faceted taxonomy: Lĩnh vực (poly-hierarchy), Loại tài liệu, Nghiệp vụ (rolls up), Đơn vị (authority) ── */
const W = "workspaces/w/conceptSchemes";
const D = (id: string) => `${W}/domain/concepts/${id}`;
const T = (id: string) => `${W}/document-type/concepts/${id}`;
const F = (id: string) => `${W}/function/concepts/${id}`;
const O = (id: string) => `${W}/org-unit/concepts/${id}`;
const vi = (text: string) => [{ languageCode: "vi", text }];

const taxonomy = tx.buildTaxonomy(
  [
    { name: `${W}/org-unit`, displayName: "Đơn vị", purpose: "AUTHORITY", position: 10 },
    { name: `${W}/function`, displayName: "Nghiệp vụ", purpose: "CLASSIFICATION", position: 3, assignTopConcepts: false },
    { name: `${W}/document-type`, displayName: "Loại tài liệu", purpose: "CLASSIFICATION", position: 2 },
    { name: `${W}/domain`, displayName: "Lĩnh vực", purpose: "CLASSIFICATION", position: 1, cardinality: { primary: true } },
  ],
  [
    { name: D("it"), prefLabels: vi("Công nghệ thông tin"), color: "#2f6fb5", icon: "cpu", state: "PUBLISHED" },
    { name: D("math"), prefLabels: vi("Toán học"), state: "PUBLISHED" },
    { name: D("ai"), prefLabels: vi("AI & học máy"), broader: [D("it")], state: "PUBLISHED" },
    { name: D("cv"), prefLabels: vi("Thị giác máy tính"), broader: [D("ai")], state: "PUBLISHED" },
    // Poly-hierarchy: Khoa học dữ liệu sits under both IT and Toán học.
    { name: D("ds"), prefLabels: vi("Khoa học dữ liệu"), broader: [D("it"), D("math")], icon: "database", state: "PUBLISHED" },
    { name: D("old"), prefLabels: vi("Tin học cũ"), broader: [D("it")], state: "DEPRECATED" },
    { name: D("draft"), prefLabels: vi("Nháp"), state: "DRAFT" },
    { name: T("regulation"), prefLabels: vi("Quy chế"), state: "PUBLISHED" },
    { name: T("thesis"), prefLabels: [{ languageCode: "en", text: "Thesis" }], state: "PUBLISHED" },
    { name: F("academic"), prefLabels: vi("Đào tạo"), state: "PUBLISHED" },
    { name: F("exams"), prefLabels: vi("Khảo thí"), broader: [F("academic")], state: "PUBLISHED" },
    { name: F("finance"), prefLabels: vi("Tài chính"), state: "PUBLISHED" },
    { name: O("cntt"), prefLabels: vi("Khoa CNTT"), state: "PUBLISHED" },
    { name: O("ck"), prefLabels: vi("Khoa Cơ khí"), state: "PUBLISHED" },
  ],
);

test("schemes: tab order, classification vs authority, the first scheme, lookup by name or ID", () => {
  assert.deepEqual(
    taxonomy.schemes.map((s) => tx.resourceKey(s.name)),
    ["domain", "document-type", "function", "org-unit"],
  );
  assert.deepEqual(
    tx.classSchemes(taxonomy).map((s) => tx.resourceKey(s.name)),
    ["domain", "document-type", "function"],
  );
  assert.deepEqual(
    tx.authoritySchemes(taxonomy).map((s) => tx.resourceKey(s.name)),
    ["org-unit"],
  );
  assert.equal(tx.firstScheme(taxonomy)?.name, `${W}/domain`);
  assert.equal(tx.firstScheme(tx.EMPTY_TAXONOMY), null);
  assert.equal(tx.schemeByName(taxonomy, "document-type")?.name, `${W}/document-type`);
  assert.equal(tx.schemeByName(taxonomy, `${W}/function`)?.displayName, "Nghiệp vụ");
  assert.equal(tx.schemeOfConcept(D("cv")), `${W}/domain`);
  assert.equal(tx.conceptNameOf(`${W}/domain`, "cv"), D("cv"));
});

test("lineage over a poly-hierarchy: every broader concept, each once; paths follow first parents", () => {
  assert.deepEqual(tx.conceptLineage(taxonomy, D("cv")), [D("cv"), D("ai"), D("it")]);
  assert.deepEqual(new Set(tx.ancestorsOf(taxonomy, D("ds"))), new Set([D("it"), D("math")]));
  // A child with several parents is under each; retired ones are left out.
  assert.deepEqual(
    tx.narrowerOf(taxonomy, D("it")).map((c) => c.name),
    [D("ai"), D("ds")],
  );
  assert.deepEqual(
    tx.narrowerOf(taxonomy, D("math")).map((c) => c.name),
    [D("ds")],
  );
  assert.deepEqual(new Set(tx.descendantsOf(taxonomy, D("it"))), new Set([D("ai"), D("cv"), D("ds")]));
  assert.deepEqual(tx.conceptPath(taxonomy, D("cv")), ["Công nghệ thông tin", "AI & học máy", "Thị giác máy tính"]);
  assert.equal(tx.conceptPathText(taxonomy, D("ds")), "Công nghệ thông tin › Khoa học dữ liệu");
  assert.equal(tx.conceptTop(taxonomy, D("cv")), D("it"));
  assert.equal(tx.conceptTop(taxonomy, D("math")), D("math"));
  assert.deepEqual(
    tx.topConcepts(taxonomy, "domain").map((c) => c.name),
    [D("it"), D("math"), D("draft")],
  );
  // Labels: Vietnamese first, else the first; unknown names are named, never blank.
  assert.equal(tx.conceptLabel(taxonomy, T("thesis")), "Thesis");
  assert.equal(tx.conceptLabel(taxonomy, D("missing")), "Khái niệm chưa đặt tên");
});

test("looks are inherited: a branch takes its top concept's color; the icon is the nearest one up, else the scheme's for a top concept", () => {
  assert.deepEqual(tx.conceptLook(taxonomy, D("it")), { icon: "cpu", color: "#2f6fb5" });
  assert.deepEqual(tx.conceptLook(taxonomy, D("cv")), { icon: "cpu", color: "#2f6fb5" });
  // Its own icon wins; the color is its first parent's family.
  assert.deepEqual(tx.conceptLook(taxonomy, D("ds")), { icon: "database", color: "#2f6fb5" });
  // No stored color: a stable hashed one; a top concept without an icon draws its scheme's.
  assert.deepEqual(tx.conceptLook(taxonomy, D("math")), { icon: "layers", color: categoryColor("math") });
  assert.deepEqual(tx.conceptLook(taxonomy, T("regulation")), { icon: "file-text", color: categoryColor("regulation") });
  // A narrower concept with no icon anywhere up its branch is a plain tag.
  assert.deepEqual(tx.conceptLook(taxonomy, F("exams")), { icon: undefined, color: categoryColor("academic") });
});

test("assignable concepts: published only, and a scheme that rolls documents up offers no top concept that has narrower ones", () => {
  assert.deepEqual(
    tx.assignableConcepts(taxonomy, "domain").map((c) => tx.resourceKey(c.name)),
    ["it", "math", "ai", "cv", "ds"],
  );
  assert.deepEqual(
    tx.assignableConcepts(taxonomy, "function").map((c) => tx.resourceKey(c.name)),
    ["exams", "finance"],
  );
});

test("a document's assignments: accepted vs suggested, grouped per classification scheme (primary first, suggestions last)", () => {
  const concepts = [
    { concept: D("ai"), state: "SUGGESTED" as const },
    { concept: T("regulation"), state: "ACCEPTED" as const },
    { concept: D("math"), state: "ACCEPTED" as const },
    { concept: D("cv"), state: "ACCEPTED" as const, primary: true },
    { concept: D("gone"), state: "ACCEPTED" as const },
  ];
  assert.deepEqual(tx.acceptedConcepts(concepts), [T("regulation"), D("math"), D("cv"), D("gone")]);
  assert.deepEqual(tx.suggestedConcepts(concepts), [D("ai")]);
  assert.equal(tx.docAssignments(taxonomy, concepts).length, 4);
  const groups = tx.assignmentsByScheme(taxonomy, concepts);
  assert.deepEqual(
    groups.map((g) => [tx.resourceKey(g.scheme.name), g.items.map((a) => tx.resourceKey(a.concept))]),
    [
      ["domain", ["cv", "math", "ai"]],
      ["document-type", ["regulation"]],
      ["function", []],
    ],
  );
  // Reading order for rows and cards: the first scheme's (primary first), then the others; suggestions and unknown concepts left out.
  assert.deepEqual(model.conceptOrder(taxonomy, concepts), [D("cv"), D("math"), T("regulation")]);
});

test("applicability in words", () => {
  assert.equal(tx.applicabilityText(taxonomy, undefined), "");
  assert.equal(tx.applicabilityText(taxonomy, { level: "INSTITUTION" }), "Toàn trường");
  assert.equal(tx.applicabilityText(taxonomy, { level: "UNIT", units: [O("cntt"), O("ck")] }), "Khoa CNTT, Khoa Cơ khí");
  assert.equal(tx.applicabilityText(taxonomy, { level: "COHORT", programs: [O("cntt")], cohorts: [2022, 2023] }), "Khoa CNTT · khóa 2022, 2023");
});

test("Browse facets: one per classification scheme (by scheme ID, prefixes = the scheme), then the static ones", () => {
  const facets = model.catalogFacets(taxonomy);
  assert.deepEqual(
    facets.map((f) => f.id),
    ["domain", "document-type", "function", "type", "owner", "src", "kb", "trust", "upd"],
  );
  assert.ok(facets.slice(0, 3).every((f) => f.field === "document.concepts"));
  assert.equal(facets[0]!.scheme, `${W}/domain`);
  assert.ok(model.isSchemeFacet("domain") && !model.isSchemeFacet("type"));

  const p = model.parseCatalogQuery({ q: "quy chế", domain: "ai,math", "document-type": "regulation", type: "pdf", subject: "x", "org-unit": "cntt" }, facets);
  // Only the facets named are read: an unknown key and an authority scheme are no filters.
  assert.deepEqual(p.filters, { domain: ["ai", "math"], "document-type": ["regulation"], type: ["pdf"] });

  // OR within a scheme, AND across schemes and facets; concepts are full names (hierarchical on the server).
  assert.equal(
    model.catalogFilter(p, "w"),
    `(document.concepts:"${D("ai")}" OR document.concepts:"${D("math")}") AND document.concepts:"${T("regulation")}" AND itemType = ${model.itemTypeOf(model.docTypeOf("pdf"))}`,
  );

  const req = model.catalogSearchRequest(p, "w", { facets });
  const concepts = (req.facetSpecs ?? []).filter((s) => s.field === "document.concepts");
  assert.deepEqual(
    concepts.map((s) => s.prefixes),
    [[`${W}/domain`], [`${W}/document-type`], [`${W}/function`]],
  );
  assert.ok(concepts.every((s) => s.excludedFromFilter));
  assert.equal(model.catalogSearchRequest(p, "w", { facets: false }).facetSpecs, undefined);

  // Links: scheme facets first, then the static ones; a concept's Browse link filters its own scheme.
  assert.equal(model.catalogHref({ filters: { type: ["pdf"], domain: ["ai"] } }), "/knowledge?domain=ai&type=pdf");
  assert.equal(model.conceptHref(T("regulation")), "/knowledge?document-type=regulation");
});

test("Browse facet options: each scheme takes its own concepts from the concept facets, once each, in the scheme's order", () => {
  const facets = model.catalogFacets(taxonomy);
  const p = model.parseCatalogQuery({ domain: "math" }, facets);
  const api = [
    {
      field: "document.concepts",
      values: [
        { value: D("ai"), displayName: "AI & học máy", documentCount: 4 },
        { value: D("it"), displayName: "Công nghệ thông tin", documentCount: 7 },
        { value: T("regulation"), displayName: "Quy chế", documentCount: 3 },
      ],
    },
    // A second concept facet repeating a value never doubles its count.
    { field: "document.concepts", values: [{ value: D("it"), displayName: "Công nghệ thông tin", documentCount: 7 }] },
  ];
  const opts = model.facetOptions(api, p, { taxonomy }, facets);
  assert.deepEqual(
    opts.domain?.map((o) => [o.value, o.count, o.on]),
    [
      ["it", 7, false],
      ["math", 0, true],
      ["ai", 4, false],
    ],
  );
  assert.deepEqual(
    opts["document-type"]?.map((o) => [o.value, o.label, o.count]),
    [["regulation", "Quy chế", 3]],
  );
  assert.deepEqual(opts.function, []);
});

test("query interpretation: one reading per words and scheme; picking a meaning filters to it; × drops the words", () => {
  const interp = {
    concepts: [
      { concept: D("ai"), text: "ai" },
      { concept: D("cv"), text: "ai" },
      { concept: T("regulation"), text: "quy chế" },
    ],
    ambiguities: [{ text: "khóa luận", options: [{ scheme: `${W}/document-type`, concepts: [T("thesis")], displayName: "Loại tài liệu: Thesis" }] }],
  };
  assert.deepEqual(
    model.understoodTerms(interp).map((t) => [t.text, tx.resourceKey(t.scheme), t.concepts.map(tx.resourceKey)]),
    [
      ["ai", "domain", ["ai", "cv"]],
      ["quy chế", "document-type", ["regulation"]],
    ],
  );
  const option = interp.ambiguities[0]!.options[0]!;
  const p = model.parseCatalogQuery({ q: "quy chế khóa luận" }, model.catalogFacets(taxonomy));
  assert.equal(model.optionPicked(option, p), false);
  const picked = model.pickOption(p, option);
  assert.deepEqual(picked.filters["document-type"], ["thesis"]);
  assert.equal(model.optionPicked(option, picked), true);
  assert.deepEqual(model.unpickOption(picked, option).filters["document-type"], []);
  // Accent- and case-insensitive; the rest of the query stays as typed.
  assert.equal(model.queryWithout("Quy Chế học vụ 2024", "quy che"), "học vụ 2024");
  assert.equal(model.queryWithout("học vụ", "không có"), "học vụ");
});

test("concept palette: twelve distinct lowercase #rrggbb colors, the preview's; a new top concept gets the first unused one", () => {
  assert.equal(DOMAIN_COLORS.length, 12);
  assert.deepEqual(
    DOMAIN_COLORS.map((c) => c.hex),
    previewPairs("core/ui.js", "DOMAIN_COLORS").map(([hex]) => hex),
  );
  for (const c of DOMAIN_COLORS) assert.match(c.hex, /^#[0-9a-f]{6}$/);
  assert.equal(freeDomainColor([]), DOMAIN_COLORS[0]!.hex);
  assert.equal(freeDomainColor([DOMAIN_COLORS[0]!.hex.toUpperCase(), undefined, "#123456"]), DOMAIN_COLORS[1]!.hex);
});

test("concept icons: the preview's names in its order, each drawn by its sprite", () => {
  assert.deepEqual(
    CONCEPT_ICONS.map((i) => i.name),
    previewPairs("core/catalog.js", "CONCEPT_ICONS").map(([name]) => name),
  );
  const sprite = preview("core/icons.js");
  for (const { name, label } of CONCEPT_ICONS) {
    assert.ok(label.trim(), `${name} has a label`);
    assert.ok(sprite.includes(`"${name}": "`), `${name} is in the preview sprite`);
  }
});

"""ImportConcepts (MERGE by notation) and ExportConceptSchemeVersion (SKOS Turtle / JSON-LD)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from taxonomy_scene import TaxonomyScene

pytestmark = pytest.mark.asyncio

ROWS: list[dict[str, Any]] = [
    {
        "notation": "ai",
        "broader": "it",
        "related": "ml",
        "prefVi": "Trí tuệ nhân tạo",
        "prefEn": "Artificial intelligence",
        "altVi": "TTNT|AI",
        "hidden": "tri tue nhan tao",
        "definition": "Máy mô phỏng trí tuệ.",
        "scopeNote": "Không gồm robot.",
        "matchPatterns": "\\bAI\\b",
        "timeSensitive": "true",
        "mappings": "isced:0613:close",
    },
    {"notation": "ml", "broader": "it", "prefVi": "Học máy", "definition": "Học từ dữ liệu."},
    {"notation": "dl", "broader": "ai", "prefVi": "Học sâu", "definition": "Mạng nơ-ron sâu."},
    {"notation": "it", "definition": "Định nghĩa mới.", "scopeNote": "Phần mềm và phần cứng."},
]


def _import(tx: TaxonomyScene, rows: list[dict[str, Any]], *, validate_only: bool = False) -> Any:
    return tx.api.post(
        tx.url("conceptSchemes/domain:importConcepts"), json={"rows": rows, "validateOnly": validate_only}
    )


async def test_import_validate_only_then_apply(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    await tx.concept("domain", "it", "Công nghệ thông tin")
    await tx.concept("domain", "x", "X")
    before = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/it")))

    planned = await tx.ok(await _import(tx, [*ROWS, {"notation": "x", "prefVi": "X"}], validate_only=True))

    names = [tx.concept_name("domain", notation) for notation in ("ai", "ml", "dl")]
    assert planned == {"created": names, "updated": [tx.concept_name("domain", "it")], "unchangedCount": 1}
    listed = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts")))
    assert sorted(concept["name"].rsplit("/", 1)[1] for concept in listed["concepts"]) == ["it", "x"]
    assert await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/it"))) == before
    assert "ImportConcepts" not in await tx.audit_actions()

    applied = await tx.ok(await _import(tx, ROWS))

    assert applied == {"created": names, "updated": [tx.concept_name("domain", "it")], "unchangedCount": 0}
    ai = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/ai")))
    assert ai["state"] == "DRAFT"
    assert sorted(ai["prefLabels"], key=lambda label: label["languageCode"]) == [
        {"languageCode": "en", "text": "Artificial intelligence"},
        {"languageCode": "vi", "text": "Trí tuệ nhân tạo"},
    ]
    # Labels read back in a stable order (language, then normalized text).
    assert [label["text"] for label in ai["altLabels"]] == ["AI", "TTNT"]
    assert ai["hiddenLabels"] == [{"languageCode": "vi", "text": "tri tue nhan tao"}]
    assert ai["broader"] == [tx.concept_name("domain", "it")]
    assert ai["related"] == [tx.concept_name("domain", "ml")]
    assert (ai["definition"], ai["scopeNote"], ai["matchPatterns"], ai["timeSensitive"]) == (
        "Máy mô phỏng trí tuệ.",
        "Không gồm robot.",
        ["\\bAI\\b"],
        True,
    )
    assert ai["mappings"] == [{"system": "isced", "code": "0613", "match": "CLOSE"}]
    ml = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/ml")))
    assert ml["broader"] == [tx.concept_name("domain", "it")]
    dl = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/dl")))
    assert dl["broader"] == [tx.concept_name("domain", "ai")]
    it = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/it")))
    # Absent columns keep their value, present ones replace it.
    assert (it["definition"], it["scopeNote"], it["prefLabels"]) == (
        "Định nghĩa mới.",
        "Phần mềm và phần cứng.",
        before["prefLabels"],
    )
    assert "ImportConcepts" in await tx.audit_actions()

    # Re-importing the same rows changes nothing; an empty cell clears.
    again = await tx.ok(await _import(tx, ROWS))
    assert (again["created"], again["updated"], again["unchangedCount"]) == ([], [], 4)
    cleared = await tx.ok(await _import(tx, [{"notation": "ai", "scopeNote": "", "altVi": ""}]))
    assert cleared["updated"] == [tx.concept_name("domain", "ai")]
    ai = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/ai")))
    assert ("scopeNote" not in ai or ai["scopeNote"] is None) and ai["altLabels"] == []


async def test_import_reports_bad_rows_and_writes_nothing(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    await tx.concept("domain", "it")

    response = await _import(
        tx,
        [
            {"notation": "ok", "prefVi": "Được"},
            {"notation": "Bad_Notation"},
            {"notation": "child", "broader": "nope"},
            {"notation": "flag", "timeSensitive": "maybe"},
            {"notation": "map", "mappings": "isced-only"},
            {"notation": "pat", "matchPatterns": "(?<=x)y"},
            {"notation": "it", "prefVi": "  "},
        ],
    )

    assert response.status_code == 400, response.text
    error = response.json()["error"]
    assert error["status"] == "INVALID_ARGUMENT"
    fields = {violation["field"] for detail in error["details"] for violation in detail.get("fieldViolations", ())}
    assert {
        "rows[1].notation",
        "rows[2].broader[0]",
        "rows[3].timeSensitive",
        "rows[4].mappings",
        "rows[5].matchPatterns[0]",
    } <= fields, fields
    listed = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts")))
    assert [concept["name"].rsplit("/", 1)[1] for concept in listed["concepts"]] == ["it"]
    assert (await tx.member_api.post(tx.url("conceptSchemes/domain:importConcepts"), json={"rows": ROWS})).status_code == 403


async def _published_scheme(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    await tx.concept("domain", "it", "Công nghệ thông tin")
    await tx.ok(await _import(tx, ROWS))
    await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes/domain/groups"),
            params={"groupId": "core"},
            json={
                "displayName": "Cốt lõi",
                "members": [tx.concept_name("domain", "it"), tx.concept_name("domain", "ai")],
                "queryExpansion": True,
            },
        )
    )
    await tx.published("domain")


async def test_export_turtle(tx: TaxonomyScene) -> None:
    await _published_scheme(tx)

    exported = await tx.ok(
        await tx.api.get(tx.url("conceptSchemes/domain/versions/1:export"), params={"format": "TURTLE"})
    )

    assert (exported["format"], exported["mimeType"]) == ("TURTLE", "text/turtle")
    content = exported["content"]
    base = "http://test/api/v1/"
    iri = {
        notation: f"<{base}{tx.concept_name('domain', notation)}>" for notation in ("it", "ai", "ml", "dl")
    }
    blocks = {
        block.split(" ", 1)[0]: block for block in content.split("\n\n") if block.startswith("<")
    }
    assert content.startswith("@prefix skos: <http://www.w3.org/2004/02/skos/core#> .")
    ai = blocks[iri["ai"]]
    for statement in (
        "a skos:Concept",
        'skos:notation "ai"',
        'skos:prefLabel "Trí tuệ nhân tạo"@vi',
        'skos:prefLabel "Artificial intelligence"@en',
        'skos:altLabel "TTNT"@vi',
        'skos:altLabel "AI"@vi',
        'skos:hiddenLabel "tri tue nhan tao"@vi',
        'skos:definition "Máy mô phỏng trí tuệ."',
        'skos:scopeNote "Không gồm robot."',
        f"skos:broader {iri['it']}",
        f"skos:narrower {iri['dl']}",
        f"skos:related {iri['ml']}",
        "skos:closeMatch <urn:isced:0613>",
        f"skos:inScheme <{base}workspaces/{tx.ws.id}/conceptSchemes/domain>",
    ):
        assert statement in ai, (statement, ai)
    assert ai.endswith(" .")
    assert f"skos:narrower {iri['ai']}" in blocks[iri["it"]] and f"skos:narrower {iri['ml']}" in blocks[iri["it"]]
    assert f"skos:broader {iri['ai']}" in blocks[iri["dl"]]
    assert "skos:topConceptOf" in blocks[iri["it"]]
    scheme_block = blocks[f"<{base}workspaces/{tx.ws.id}/conceptSchemes/domain>"]
    assert "a skos:ConceptScheme" in scheme_block and f"skos:hasTopConcept {iri['it']}" in scheme_block
    group = blocks[f"<{base}workspaces/{tx.ws.id}/conceptSchemes/domain/groups/core>"]
    assert "a skos:Collection" in group
    assert f"skos:member {iri['it']}" in group and f"skos:member {iri['ai']}" in group
    # Every statement block is "subject p o ;\n    p o ... ." (structural Turtle check).
    for block in blocks.values():
        lines = block.strip().split("\n")
        assert all(line.endswith(" ;") for line in lines[:-1]) and lines[-1].endswith(" ."), block


async def test_export_json_ld(tx: TaxonomyScene) -> None:
    await _published_scheme(tx)

    exported = await tx.ok(
        await tx.api.get(tx.url("conceptSchemes/domain/versions/1:export"), params={"format": "JSON_LD"})
    )

    assert (exported["format"], exported["mimeType"]) == ("JSON_LD", "application/ld+json")
    document = json.loads(exported["content"])
    assert document["@context"]["skos"] == "http://www.w3.org/2004/02/skos/core#"
    nodes = {node["@id"].split("/api/v1/", 1)[1]: node for node in document["@graph"]}
    ai = nodes[tx.concept_name("domain", "ai")]
    assert ai["@type"] == "skos:Concept"
    assert ai["skos:notation"] == "ai"
    assert {"@value": "Trí tuệ nhân tạo", "@language": "vi"} in ai["skos:prefLabel"]
    assert ai["skos:altLabel"] == [
        {"@value": "AI", "@language": "vi"},
        {"@value": "TTNT", "@language": "vi"},
    ]
    assert ai["skos:hiddenLabel"] == [{"@value": "tri tue nhan tao", "@language": "vi"}]
    assert (ai["skos:definition"], ai["skos:scopeNote"]) == ("Máy mô phỏng trí tuệ.", "Không gồm robot.")
    refs = lambda key: [ref["@id"].split("/api/v1/", 1)[1] for ref in ai[key]]  # noqa: E731
    assert refs("skos:broader") == [tx.concept_name("domain", "it")]
    assert refs("skos:narrower") == [tx.concept_name("domain", "dl")]
    assert refs("skos:related") == [tx.concept_name("domain", "ml")]
    assert ai["skos:closeMatch"] == [{"@id": "urn:isced:0613"}]
    group = nodes[f"workspaces/{tx.ws.id}/conceptSchemes/domain/groups/core"]
    assert group["@type"] == "skos:Collection"
    assert [ref["@id"].rsplit("/", 1)[1] for ref in group["skos:member"]] == ["it", "ai"]
    scheme = nodes[f"workspaces/{tx.ws.id}/conceptSchemes/domain"]
    assert scheme["@type"] == "skos:ConceptScheme"

    missing = await tx.api.get(tx.url("conceptSchemes/domain/versions/9:export"))
    assert missing.status_code == 404
    assert (
        await tx.member_api.get(tx.url("conceptSchemes/domain/versions/1:export"), params={"format": "TURTLE"})
    ).status_code == 200

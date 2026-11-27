"""Concept schemes and concepts through the API: working-copy CRUD, validation, permissions."""

from __future__ import annotations

from typing import Any

import pytest

from taxonomy_scene import TaxonomyScene

pytestmark = pytest.mark.asyncio


def _violations(response: Any) -> list[str]:
    assert response.status_code == 400, response.text
    error = response.json()["error"]
    assert error["status"] == "INVALID_ARGUMENT", error
    return [
        violation["field"]
        for detail in error["details"]
        for violation in detail.get("fieldViolations", ())
    ]


async def test_concept_crud_on_the_working_copy(tx: TaxonomyScene) -> None:
    scheme = await tx.scheme("domain")
    assert (scheme["purpose"], scheme["publishedVersion"] if "publishedVersion" in scheme else None) == (
        "CLASSIFICATION",
        None,
    )
    top = await tx.concept("domain", "it", "Công nghệ thông tin", color="#1188FF", icon="cpu")
    child = await tx.concept(
        "domain",
        "ai",
        "Trí tuệ nhân tạo",
        broader=["it"],
        altLabels=[{"languageCode": "vi", "text": "AI"}, {"languageCode": "en", "text": "Artificial intelligence"}],
        mappings=[{"system": "isced-f-2013", "code": "0613", "match": "CLOSE"}],
    )
    assert (top["state"], top["color"], top["displayName"]) == ("DRAFT", "#1188ff", "Công nghệ thông tin")
    assert child["broader"] == [tx.concept_name("domain", "it")]
    assert child["mappings"][0]["match"] == "CLOSE"
    assert child["documentCount"] == 0

    patched = await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/domain/concepts/ai"),
            params={"updateMask": "scopeNote,hiddenLabels"},
            json={"scopeNote": "Không bao gồm robot.", "hiddenLabels": [{"languageCode": "vi", "text": "tri tue"}], "etag": child["etag"]},
        )
    )
    assert patched["scopeNote"] == "Không bao gồm robot."
    assert patched["altLabels"] == child["altLabels"]
    stale = await tx.api.patch(
        tx.url("conceptSchemes/domain/concepts/ai"),
        params={"updateMask": "definition"},
        json={"definition": "x", "etag": child["etag"]},
    )
    assert stale.status_code == 409

    listed = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts")))
    assert [concept["name"].rsplit("/", 1)[1] for concept in listed["concepts"]] == ["ai", "it"]
    tops = await tx.ok(
        await tx.api.get(tx.url("conceptSchemes/domain/concepts"), params={"filter": "NOT broader:*"})
    )
    assert [concept["name"].rsplit("/", 1)[1] for concept in tops["concepts"]] == ["it"]
    under = await tx.ok(
        await tx.api.get(
            tx.url("conceptSchemes/domain/concepts"),
            params={"filter": f'broader:"{tx.concept_name("domain", "it")}"'},
        )
    )
    assert [concept["name"].rsplit("/", 1)[1] for concept in under["concepts"]] == ["ai"]
    got = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain")))
    assert got["unpublishedChanges"] == 2


async def test_label_and_graph_errors_name_their_field(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    await tx.concept("domain", "it")
    url = tx.url("conceptSchemes/domain/concepts")

    blank = await tx.api.post(url, params={"conceptId": "x1"}, json={"prefLabels": [{"languageCode": "vi", "text": " … "}]})
    assert "prefLabels[0].text" in _violations(blank)
    clash = await tx.api.post(
        url,
        params={"conceptId": "x2"},
        json={
            "prefLabels": [{"languageCode": "vi", "text": "Khóa luận"}],
            "altLabels": [{"languageCode": "vi", "text": "  KHÓA   LUẬN "}],
        },
    )
    assert "altLabels[0].text" in _violations(clash)
    two_prefs = await tx.api.post(
        url,
        params={"conceptId": "x3"},
        json={"prefLabels": [{"languageCode": "vi", "text": "A"}, {"languageCode": "vi", "text": "B"}]},
    )
    assert "prefLabels[1].languageCode" in _violations(two_prefs)
    # Diacritics are kept: khoa ≠ khóa, both are fine on one concept.
    await tx.concept(
        "domain", "x4", "Khoa", altLabels=[{"languageCode": "vi", "text": "khóa"}]
    )
    colored_child = await tx.api.post(
        url,
        params={"conceptId": "x5"},
        json={"broader": [tx.concept_name("domain", "it")], "color": "#000000"},
    )
    assert "color" in _violations(colored_child)
    await tx.concept("domain", "child", broader=["it"])
    cycle = await tx.api.patch(
        tx.url("conceptSchemes/domain/concepts/it"),
        params={"updateMask": "broader"},
        json={"broader": [tx.concept_name("domain", "child")]},
    )
    assert "broader" in _violations(cycle)
    bad_pattern = await tx.api.post(url, params={"conceptId": "x6"}, json={"matchPatterns": ["(?<=QĐ)-"]})
    assert "matchPatterns[0]" in _violations(bad_pattern)
    bad_id = await tx.api.post(url, params={"conceptId": "Bad_ID"}, json={})
    assert _violations(bad_id) == ["conceptId"]


async def test_only_drafts_are_deleted_and_notations_are_never_reused(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    await tx.concept("domain", "kept")
    draft = await tx.concept("domain", "gone")
    deleted = await tx.ok(
        await tx.api.delete(tx.url("conceptSchemes/domain/concepts/gone"), params={"etag": draft["etag"]})
    )
    assert deleted["state"] == "DELETED" and "deleteTime" in deleted
    reused = await tx.api.post(
        tx.url("conceptSchemes/domain/concepts"), params={"conceptId": "gone"}, json={}
    )
    assert reused.status_code == 409
    listed = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts")))
    assert [concept["name"].rsplit("/", 1)[1] for concept in listed["concepts"]] == ["kept"]
    with_deleted = await tx.ok(
        await tx.api.get(tx.url("conceptSchemes/domain/concepts"), params={"showDeleted": "true"})
    )
    assert len(with_deleted["concepts"]) == 2

    await tx.published("domain")
    published = await tx.api.delete(tx.url("conceptSchemes/domain/concepts/kept"))
    assert published.status_code == 400
    assert published.json()["error"]["status"] == "FAILED_PRECONDITION"
    concept = await tx.ok(await tx.api.get(tx.url("conceptSchemes/domain/concepts/kept")))
    assert (concept["state"], concept["firstVersion"]) == ("PUBLISHED", 1)


async def test_members_read_and_never_write(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    await tx.concept("domain", "it")
    member = tx.member_api
    assert (await member.get(tx.url("conceptSchemes"))).status_code == 200
    assert (await member.get(tx.url("conceptSchemes/domain/concepts/it"))).status_code == 200
    assert (await member.get(tx.url("conceptSchemes/domain/concepts"))).status_code == 200
    denied = [
        await member.post(tx.url("conceptSchemes/domain/concepts"), params={"conceptId": "x"}, json={}),
        await member.patch(tx.url("conceptSchemes/domain/concepts/it"), json={"definition": "x"}),
        await member.delete(tx.url("conceptSchemes/domain/concepts/it")),
        await member.post(tx.url("conceptSchemes/domain:publish"), json={}),
        await member.post(tx.url("conceptSchemes"), params={"conceptSchemeId": "x"}, json={"displayName": "X", "purpose": "AUTHORITY"}),
        await member.get(tx.url("conceptRules")),
    ]
    assert [response.status_code for response in denied] == [403] * len(denied)
    outsider = await tx.client.as_(await tx.world.make_user())
    assert (await outsider.get(tx.url("conceptSchemes"))).status_code == 403


async def test_scheme_settings_are_validated(tx: TaxonomyScene) -> None:
    authority = await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes"),
            params={"conceptSchemeId": "org-unit"},
            json={"displayName": "Đơn vị", "purpose": "AUTHORITY"},
        )
    )
    assert (authority["llmPolicy"], "autoThreshold" in authority) == ("NEVER", False)
    thresholds = await tx.api.patch(
        tx.url("conceptSchemes/org-unit"), params={"updateMask": "autoThreshold"}, json={"autoThreshold": 0.9}
    )
    assert "autoThreshold" in _violations(thresholds)
    scheme = await tx.scheme("domain")
    inverted = await tx.api.patch(
        tx.url("conceptSchemes/domain"), params={"updateMask": "reviewThreshold"}, json={"reviewThreshold": 0.95}
    )
    assert "reviewThreshold" in _violations(inverted)
    updated = await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/domain"),
            params={"updateMask": "cardinality.max,llmPolicy"},
            json={"cardinality": {"max": 2}, "llmPolicy": "FALLBACK", "etag": scheme["etag"]},
        )
    )
    assert (updated["cardinality"]["max"], updated["llmPolicy"]) == (2, "FALLBACK")
    taken = await tx.api.post(
        tx.url("conceptSchemes"), params={"conceptSchemeId": "domain"}, json={"displayName": "D", "purpose": "CLASSIFICATION"}
    )
    assert taken.status_code == 409

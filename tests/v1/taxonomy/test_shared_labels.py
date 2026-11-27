"""ListSharedLabels: W2 across schemes (published labels only) and W1 within a scheme."""

from __future__ import annotations

from typing import Any

import pytest

from taxonomy_scene import TaxonomyScene

pytestmark = pytest.mark.asyncio


def _entries(record: dict[str, Any]) -> list[tuple[str, str, str]]:
    return [(entry["concept"], entry["kind"], entry["text"]) for entry in record["concepts"]]


async def test_shared_labels_across_and_within_schemes(tx: TaxonomyScene) -> None:
    await tx.scheme("domain")
    await tx.concept("domain", "it", "Công nghệ")
    await tx.concept("domain", "x", altLabels=[{"languageCode": "vi", "text": "Chung"}])
    await tx.concept("domain", "y", altLabels=[{"languageCode": "vi", "text": "chung"}])
    await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes"),
            params={"conceptSchemeId": "org-unit"},
            json={"displayName": "Đơn vị", "purpose": "AUTHORITY", "maxDepth": 2},
        )
    )
    await tx.concept("org-unit", "khoa-cntt", "Khoa CNTT", altLabels=[{"languageCode": "vi", "text": "CÔNG NGHỆ"}])
    published = await tx.published("domain")
    await tx.published("org-unit")
    # W1 is also a publish warning.
    assert any(
        warning["kind"] == "SHARED_LABEL" and warning["label"] == "chung" for warning in published["warnings"]
    )
    # An unpublished concept of a third scheme never makes a label shared.
    await tx.scheme("program")
    await tx.concept("program", "draft", "Công nghệ")

    listed = await tx.ok(await tx.api.get(tx.url("sharedLabels")))

    records = {(record["label"], record["crossScheme"]): record for record in listed["sharedLabels"]}
    assert set(records) == {("chung", False), ("công nghệ", True)}
    assert _entries(records[("công nghệ", True)]) == [
        (tx.concept_name("domain", "it"), "PREF", "Công nghệ"),
        (tx.concept_name("org-unit", "khoa-cntt"), "ALT", "CÔNG NGHỆ"),
    ]
    assert [entry["scheme"] for entry in records[("công nghệ", True)]["concepts"]] == [
        f"workspaces/{tx.ws.id}/conceptSchemes/domain",
        f"workspaces/{tx.ws.id}/conceptSchemes/org-unit",
    ]
    assert _entries(records[("chung", False)]) == [
        (tx.concept_name("domain", "x"), "ALT", "Chung"),
        (tx.concept_name("domain", "y"), "ALT", "chung"),
    ]

    cross = await tx.ok(await tx.api.get(tx.url("sharedLabels"), params={"filter": "crossScheme = true"}))
    assert [record["label"] for record in cross["sharedLabels"]] == ["công nghệ"]
    within = await tx.ok(await tx.api.get(tx.url("sharedLabels"), params={"filter": "crossScheme = false"}))
    assert [record["label"] for record in within["sharedLabels"]] == ["chung"]
    by_scheme = await tx.ok(
        await tx.api.get(
            tx.url("sharedLabels"),
            params={"filter": f'scheme = "workspaces/{tx.ws.id}/conceptSchemes/org-unit"'},
        )
    )
    assert [record["label"] for record in by_scheme["sharedLabels"]] == ["công nghệ"]
    bad = await tx.api.get(tx.url("sharedLabels"), params={"filter": "label = x"})
    assert bad.status_code == 400

    # Members may read; outsiders may not.
    assert (await tx.member_api.get(tx.url("sharedLabels"))).status_code == 200
    outsider = await tx.client.as_(await tx.world.make_user())
    assert (await outsider.get(tx.url("sharedLabels"))).status_code == 403

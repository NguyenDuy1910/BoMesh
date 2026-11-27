"""Platform templates, workspace forks and the three-way template diff (``api_design.md`` ConceptScheme ``:publish``)."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from harness import ApiClient
from taxonomy_scene import TaxonomyScene

pytestmark = pytest.mark.asyncio


class Template:
    """A platform template managed by a platform admin."""

    def __init__(self, api: ApiClient, code: str) -> None:
        self.api, self.code = api, code

    def url(self, path: str = "") -> str:
        return f"/api/v1/conceptSchemes/{self.code}{path}"

    async def ok(self, response: Any) -> dict[str, Any]:
        assert response.status_code == 200, response.text
        return response.json()

    async def concept(self, notation: str, label: str, *, broader: tuple[str, ...] = (), **body: Any) -> None:
        await self.ok(
            await self.api.post(
                self.url("/concepts"),
                params={"conceptId": notation},
                json={
                    "prefLabels": [{"languageCode": "vi", "text": label}],
                    "definition": f"Định nghĩa {label}.",
                    "broader": [f"conceptSchemes/{self.code}/concepts/{parent}" for parent in broader],
                    **body,
                },
            )
        )

    async def publish(self) -> dict[str, Any]:
        operation = await self.ok(await self.api.post(self.url(":publish"), json={}))
        assert operation["done"] is True, operation
        return operation["response"]


async def _template(tx: TaxonomyScene) -> Template:
    admin = await tx.world.platform_admin(await tx.world.make_user())
    template = Template(await tx.client.as_(admin), f"tpl-{uuid4().hex[:8]}")
    created = await template.ok(
        await template.api.post(
            "/api/v1/conceptSchemes",
            params={"conceptSchemeId": template.code},
            json={
                "displayName": "Ngành",
                "purpose": "CLASSIFICATION",
                "maxDepth": 2,
                "cardinality": {"min": 0, "max": 2, "primary": False},
                "autoThreshold": 0.8,
                "reviewThreshold": 0.5,
            },
        )
    )
    assert created["name"] == f"conceptSchemes/{template.code}"
    await template.concept("eng", "Kỹ thuật", color="#112233")
    await template.concept("eng-it", "Công nghệ thông tin", broader=("eng",))
    await template.concept("sci", "Khoa học")
    first = await template.publish()
    assert first["version"] == 1
    return template


async def test_template_permissions(tx: TaxonomyScene) -> None:
    template = await _template(tx)
    payload = {"displayName": "X", "purpose": "CLASSIFICATION"}
    # Workspace admins and members never write templates; platform staff read them.
    assert (
        await tx.api.post("/api/v1/conceptSchemes", params={"conceptSchemeId": "x"}, json=payload)
    ).status_code == 403
    assert (
        await tx.api.post(template.url("/concepts"), params={"conceptId": "x"}, json={})
    ).status_code == 403
    assert (await tx.api.post(template.url(":publish"), json={})).status_code == 403
    operator = await tx.client.as_(await tx.world.platform_operator(await tx.world.make_user()))
    assert (await operator.get(template.url())).status_code == 200
    assert (await operator.post(template.url(":publish"), json={})).status_code == 403
    # Forking is a workspace write: the admin may, a member may not.
    fork = {"template": f"conceptSchemes/{template.code}"}
    assert (
        await tx.member_api.post(tx.url("conceptSchemes"), params={"conceptSchemeId": "discipline"}, json=fork)
    ).status_code == 403
    await tx.ok(await tx.api.post(tx.url("conceptSchemes"), params={"conceptSchemeId": "discipline"}, json=fork))
    assert (await tx.member_api.get(tx.url("conceptSchemes/discipline:diffTemplate"))).status_code == 403
    assert (
        await tx.member_api.post(tx.url("conceptSchemes/discipline:applyTemplateChanges"), json={"changes": []})
    ).status_code == 403


async def test_fork_diff_and_apply_never_overwrite_tenant_edits(tx: TaxonomyScene) -> None:
    template = await _template(tx)
    forked = await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes"),
            params={"conceptSchemeId": "discipline"},
            json={"template": f"conceptSchemes/{template.code}"},
        )
    )
    assert (forked["template"], forked["templateVersion"]) == (f"conceptSchemes/{template.code}", 1)
    assert (forked["displayName"], forked["maxDepth"], forked["autoThreshold"]) == ("Ngành", 2, 0.8)
    concepts = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline/concepts")))
    by_notation = {concept["name"].rsplit("/", 1)[1]: concept for concept in concepts["concepts"]}
    assert sorted(by_notation) == ["eng", "eng-it", "sci"]
    for notation, concept in by_notation.items():
        assert concept["state"] == "DRAFT"
        assert concept["templateConcept"] == f"conceptSchemes/{template.code}/concepts/{notation}"
    assert by_notation["eng-it"]["broader"] == [tx.concept_name("discipline", "eng")]
    assert by_notation["eng"]["color"] == "#112233"
    await tx.published("discipline")

    # The tenant renames eng and adds its own concept.
    await tx.ok(
        await tx.api.patch(
            tx.url("conceptSchemes/discipline/concepts/eng"),
            params={"updateMask": "prefLabels"},
            json={"prefLabels": [{"languageCode": "vi", "text": "Kỹ thuật (trường)"}]},
        )
    )
    await tx.concept("discipline", "local", "Riêng trường")

    # Template v2: a new concept, eng relabelled (conflict) and eng-it gains an altLabel.
    await template.concept("eng-ai", "Trí tuệ nhân tạo", broader=("eng",))
    await template.ok(
        await template.api.patch(
            template.url("/concepts/eng"),
            params={"updateMask": "prefLabels"},
            json={"prefLabels": [{"languageCode": "vi", "text": "Kỹ thuật và công nghệ"}]},
        )
    )
    await template.ok(
        await template.api.patch(
            template.url("/concepts/eng-it"),
            params={"updateMask": "altLabels"},
            json={"altLabels": [{"languageCode": "vi", "text": "CNTT"}]},
        )
    )
    assert (await template.publish())["version"] == 2

    diff = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline:diffTemplate")))

    assert (diff["template"], diff["fromVersion"], diff["toVersion"]) == (f"conceptSchemes/{template.code}", 1, 2)
    changes = {change["key"]: change for change in diff["changes"]}
    assert set(changes) == {"add:eng-ai", "update:eng:prefLabels", "update:eng-it:altLabels"}
    added = changes["add:eng-ai"]
    assert (added["kind"], added["conflict"], added["concept"]) == (
        "ADD_CONCEPT",
        False,
        tx.concept_name("discipline", "eng-ai"),
    )
    relabel = changes["update:eng:prefLabels"]
    assert relabel["conflict"] is True
    assert relabel["baseValue"] == [["vi", "Kỹ thuật"]]
    assert relabel["templateValue"] == [["vi", "Kỹ thuật và công nghệ"]]
    assert relabel["currentValue"] == [["vi", "Kỹ thuật (trường)"]]
    alt = changes["update:eng-it:altLabels"]
    assert (alt["kind"], alt["conflict"], alt["templateValue"]) == ("UPDATE_CONCEPT", False, [["vi", "CNTT"]])

    # A conflicting change is never applied; an unknown key is invalid.
    scheme = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline")))
    conflict = await tx.api.post(
        tx.url("conceptSchemes/discipline:applyTemplateChanges"),
        json={"changes": ["update:eng:prefLabels"], "etag": scheme["etag"]},
    )
    assert conflict.status_code == 400, conflict.text
    assert conflict.json()["error"]["status"] == "FAILED_PRECONDITION"
    unknown = await tx.api.post(
        tx.url("conceptSchemes/discipline:applyTemplateChanges"), json={"changes": ["add:nope"]}
    )
    assert unknown.status_code == 400 and unknown.json()["error"]["status"] == "INVALID_ARGUMENT"
    stale = await tx.api.post(
        tx.url("conceptSchemes/discipline:applyTemplateChanges"),
        json={"changes": ["add:eng-ai"], "etag": forked["etag"]},
    )
    assert stale.status_code == 409

    applied = await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes/discipline:applyTemplateChanges"),
            json={"changes": ["add:eng-ai"], "etag": scheme["etag"]},
        )
    )

    assert applied["templateVersion"] == 2
    new = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline/concepts/eng-ai")))
    assert (new["state"], new["templateConcept"], new["broader"]) == (
        "DRAFT",
        f"conceptSchemes/{template.code}/concepts/eng-ai",
        [tx.concept_name("discipline", "eng")],
    )
    eng = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline/concepts/eng")))
    assert eng["prefLabels"] == [{"languageCode": "vi", "text": "Kỹ thuật (trường)"}]
    eng_it = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline/concepts/eng-it")))
    assert eng_it["altLabels"] == []  # declined, not applied
    local = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline/concepts/local")))
    assert local["prefLabels"] == [{"languageCode": "vi", "text": "Riêng trường"}]
    assert (await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline:diffTemplate"))))["changes"] == []
    assert "ApplyConceptSchemeTemplateChanges" in await tx.audit_actions()


async def test_apply_selected_concept_update(tx: TaxonomyScene) -> None:
    template = await _template(tx)
    await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes"),
            params={"conceptSchemeId": "discipline"},
            json={"template": f"conceptSchemes/{template.code}"},
        )
    )
    await template.ok(
        await template.api.patch(
            template.url("/concepts/eng-it"),
            params={"updateMask": "altLabels,definition"},
            json={"altLabels": [{"languageCode": "vi", "text": "CNTT"}], "definition": "Mới."},
        )
    )
    await template.ok(
        await template.api.patch(template.url(), params={"updateMask": "autoThreshold"}, json={"autoThreshold": 0.9})
    )
    await template.publish()
    diff = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline:diffTemplate")))
    assert {change["key"]: change["conflict"] for change in diff["changes"]} == {
        "update:eng-it:altLabels": False,
        "update:eng-it:definition": False,
        "scheme:autoThreshold": False,
    }

    applied = await tx.ok(
        await tx.api.post(
            tx.url("conceptSchemes/discipline:applyTemplateChanges"),
            json={"changes": ["update:eng-it:altLabels", "scheme:autoThreshold"]},
        )
    )

    assert (applied["templateVersion"], applied["autoThreshold"]) == (2, 0.9)
    eng_it = await tx.ok(await tx.api.get(tx.url("conceptSchemes/discipline/concepts/eng-it")))
    assert eng_it["altLabels"] == [{"languageCode": "vi", "text": "CNTT"}]
    assert eng_it["definition"] == "Định nghĩa Công nghệ thông tin."

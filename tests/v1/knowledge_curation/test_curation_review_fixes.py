"""Integration-review fixes: deleted approval targets, the approve etag, notification
re-checks, readable contributions and source filters."""

from __future__ import annotations

from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

from bomesh.services.knowledge_curation.contributions import readable_contributions
from bomesh.db.models import Contribution
from bomesh.iam.authorizer import Principal
from bomesh.services.taxonomy.names import concept_name
from curation_support import OWNER, Scene, error_reason, item_name

pytestmark = pytest.mark.asyncio


def _url(contribution: dict[str, Any], suffix: str = "") -> str:
    return f"/api/v1/{contribution['name']}{suffix}"


def _id(contribution: dict[str, Any]) -> UUID:
    return UUID(contribution["name"].rsplit("/", 1)[1])


async def _revision(scene: Scene, replaced: Any) -> dict[str, Any]:
    candidate = await scene.candidate()
    api = await scene.as_(scene.member)
    response = await api.post(
        scene.url("contributions"),
        json={"item": item_name(candidate), "kind": "NEW_REVISION", "replacesItem": item_name(replaced)},
    )
    assert response.status_code == 200, response.text
    return response.json()


# -- #4 TARGET_DELETED -----------------------------------------------------------------


async def test_approving_a_revision_of_a_deleted_document_is_target_deleted(scene: Scene) -> None:
    replaced = await scene.world.make_document(scene.kb)
    await scene.set_content(replaced)
    body = await _revision(scene, replaced)
    await scene.world.delete(replaced)

    reviewer = await scene.as_(scene.reviewer)
    response = await reviewer.post(_url(body, ":approve"), json={"etag": body["etag"]})

    assert (response.status_code, error_reason(response)) == (400, "TARGET_DELETED")
    kept = (await scene.item(replaced.id)).current_revision
    assert kept is not None and replaced.current_revision is not None
    assert kept.content_id == replaced.current_revision.content_id


async def test_approving_into_a_deleted_target_collection_is_target_deleted(scene: Scene) -> None:
    folder = await scene.world.make_collection(scene.ws, scene.kb, item_name="Folder")
    await scene.set_metadata(folder, accepts_contributions=True)
    api = await scene.as_(scene.member)
    candidate = await scene.candidate()
    body = (
        await api.post(
            scene.url("contributions"),
            json={"item": item_name(candidate), "targetCollection": item_name(folder)},
        )
    ).json()
    await scene.world.delete(folder)

    reviewer = await scene.as_(scene.reviewer)
    response = await reviewer.post(_url(body, ":approve"), json={"etag": body["etag"]})

    assert (response.status_code, error_reason(response)) == (400, "TARGET_DELETED")
    assert (await scene.item(candidate.id)).parent_item_id == scene.personal.id


# -- #29 empty etag --------------------------------------------------------------------


async def test_approve_rejects_an_empty_etag(scene: Scene) -> None:
    body = await scene.submit(await scene.candidate())
    reviewer = await scene.as_(scene.reviewer)

    response = await reviewer.post(_url(body, ":approve"), json={"etag": ""})

    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert (await reviewer.get(_url(body))).json()["state"] == "IN_REVIEW"


# -- #24 approval facets go through KnowledgeItems ---------------------------------------


async def test_approve_with_an_unknown_concept_is_invalid_and_changes_nothing(scene: Scene) -> None:
    candidate = await scene.candidate()
    await scene.mark_processed(candidate)
    body = await scene.submit(candidate)
    reviewer = await scene.as_(scene.reviewer)

    response = await reviewer.post(
        _url(body, ":approve"),
        json={"etag": body["etag"], "concepts": [concept_name(scene.ws.id, "domain", "nope")]},
    )

    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert (await reviewer.get(_url(body))).json()["state"] == "IN_REVIEW"
    assert (await scene.item(candidate.id)).parent_item_id == scene.personal.id


# -- #8 readable_contributions ---------------------------------------------------------


async def test_contribution_readable_follows_role_state_and_revokes(scene: Scene) -> None:
    body = await scene.submit(await scene.candidate())
    authorizer = scene.world.authorizer

    async def readable(user: Any, contribution_id: UUID | None = None) -> bool:
        rule = await readable_contributions(authorizer(), Principal(user.id), scene.ws.id)
        async with scene.sessions() as session:
            readable_ids = set(await session.scalars(select(Contribution.id).where(rule)))
        return (contribution_id or _id(body)) in readable_ids

    assert await readable(scene.member)
    assert await readable(scene.reviewer)
    assert not await readable(scene.outsider)
    assert not await readable(scene.member, uuid4())

    await scene.world.revoke(scene.reviewer, on=scene.kb)
    assert not await readable(scene.reviewer)
    await scene.world.grant(scene.reviewer, OWNER, on=scene.kb)
    reviewer = await scene.as_(scene.reviewer)
    await reviewer.post(_url(body, ":reject"), json={"message": "no"})
    assert not await readable(scene.reviewer)
    assert await readable(scene.member)


async def test_reviewer_who_lost_the_role_can_no_longer_get_the_contribution(scene: Scene) -> None:
    body = await scene.submit(await scene.candidate())
    reviewer = await scene.as_(scene.reviewer)
    assert (await reviewer.get(_url(body))).status_code == 200

    await scene.world.revoke(scene.reviewer, on=scene.kb)

    assert (await (await scene.as_(scene.reviewer)).get(_url(body))).status_code == 403


# -- #2 sources by code ----------------------------------------------------------------


async def test_source_filter_takes_a_source_name_of_this_workspace(scene: Scene) -> None:
    member = await scene.as_(scene.member)
    await scene.submit(await scene.candidate())

    ours = await member.get(
        scene.url("contributions"),
        params={"filter": f'source = "workspaces/{scene.ws.id}/sources/drive"'},
    )
    theirs = await member.get(
        scene.url("contributions"),
        params={"filter": f'source = "workspaces/{uuid4()}/sources/drive"'},
    )

    assert (ours.status_code, ours.json()["totalSize"]) == (200, 0)
    assert theirs.status_code == 400

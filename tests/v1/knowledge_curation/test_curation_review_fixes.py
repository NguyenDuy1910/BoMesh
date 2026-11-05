"""Integration-review fixes: deleted approval targets, the approve etag, notification
re-checks, per-caller topic counts, purge, replays and later revokes."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import update

from bomesh.services.knowledge_curation.contributions import contribution_readable
from bomesh.db.models import ItemTopic, ReadingList, Topic
from bomesh.iam.authorizer import Principal
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
    assert (await scene.item(replaced.id)).storage_key == replaced.storage_key


async def test_approving_into_a_deleted_target_collection_is_target_deleted(scene: Scene) -> None:
    folder = await scene.world.make_collection(scene.ws, scene.kb, title="Folder")
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


async def test_approve_with_an_unknown_topic_is_invalid_and_changes_nothing(scene: Scene) -> None:
    candidate = await scene.candidate()
    body = await scene.submit(candidate)
    reviewer = await scene.as_(scene.reviewer)

    response = await reviewer.post(
        _url(body, ":approve"),
        json={"etag": body["etag"], "topics": [f"workspaces/{scene.ws.id}/topics/nope"]},
    )

    assert response.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert (await reviewer.get(_url(body))).json()["state"] == "IN_REVIEW"
    assert (await scene.item(candidate.id)).parent_item_id == scene.personal.id


# -- #8 contribution_readable ----------------------------------------------------------


async def test_contribution_readable_follows_role_state_and_revokes(scene: Scene) -> None:
    body = await scene.submit(await scene.candidate())
    authorizer = scene.world.authorizer

    async def readable(user: Any, contribution_id: UUID | None = None) -> bool:
        async with scene.sessions() as session:
            return await contribution_readable(
                session, authorizer(), Principal(user.id), scene.ws.id, contribution_id or _id(body)
            )

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


# -- #17 per-caller documentCount ------------------------------------------------------


async def _tag(scene: Scene, item: Any, topic: Topic) -> None:
    async with scene.sessions.begin() as session:
        session.add(ItemTopic(item_id=item.id, topic_id=topic.id))


async def test_document_count_order_uses_the_callers_visibility(scene: Scene) -> None:
    open_topic = await scene.topic("open", "Open")
    hidden_topic = await scene.topic("hidden", "Hidden")
    secret = await scene.world.make_collection(scene.ws)
    await _tag(scene, await scene.world.make_document(scene.kb), open_topic)
    for _ in range(3):
        await _tag(scene, await scene.world.make_document(secret), hidden_topic)
    params = {"orderBy": "documentCount desc"}

    outsider = (await (await scene.as_(scene.outsider)).get(scene.url("topics"), params=params)).json()
    admin = (await (await scene.as_(scene.admin)).get(scene.url("topics"), params=params)).json()

    assert [(t["displayName"], t["documentCount"]) for t in outsider["topics"]] == [
        ("Open", 1),
        ("Hidden", 0),
    ]
    assert [(t["displayName"], t["documentCount"]) for t in admin["topics"]] == [
        ("Hidden", 3),
        ("Open", 1),
    ]


async def test_editors_count_their_visible_unpublished_documents(scene: Scene) -> None:
    topic = await scene.topic("drafts", "Drafts")
    await _tag(scene, await scene.world.make_document(scene.kb, published=False), topic)

    reviewer = (await (await scene.as_(scene.reviewer)).get(scene.url("topics/drafts"))).json()
    outsider = (await (await scene.as_(scene.outsider)).get(scene.url("topics/drafts"))).json()

    assert (reviewer["documentCount"], outsider["documentCount"]) == (1, 0)


# -- #21 purge -------------------------------------------------------------------------


async def _age(scene: Scene, model: Any, code: str, days: int) -> None:
    async with scene.sessions.begin() as session:
        await session.execute(
            update(model)
            .where(model.tenant_id == scene.ws.id, model.code == code)
            .values(deleted_at=datetime.now(UTC) - timedelta(days=days))
        )


async def test_purged_topics_are_gone(scene: Scene) -> None:
    await scene.topic("old", "Old")
    admin = await scene.as_(scene.admin)
    await admin.delete(scene.url("topics/old"))
    await _age(scene, Topic, "old", 31)

    assert (await admin.post(scene.url("topics/old:undelete"), json={})).status_code == 404
    assert (await admin.get(scene.url("topics/old"))).status_code == 404
    listed = (await admin.get(scene.url("topics"), params={"showDeleted": "true"})).json()
    assert listed.get("topics", []) == []


async def test_purged_reading_lists_are_gone(scene: Scene) -> None:
    member = await scene.as_(scene.member)
    await member.post(scene.url("readingLists"), params={"readingListId": "old"}, json={"displayName": "Old"})
    await member.delete(scene.url("readingLists/old"))
    await _age(scene, ReadingList, "old", 31)

    assert (await member.post(scene.url("readingLists/old:undelete"), json={})).status_code == 404
    assert (await member.get(scene.url("readingLists/old"))).status_code == 404
    listed = (await member.get(scene.url("readingLists"), params={"showDeleted": "true"})).json()
    assert listed.get("readingLists", []) == []


async def test_recently_deleted_topics_still_restore(scene: Scene) -> None:
    await scene.topic("recent", "Recent")
    admin = await scene.as_(scene.admin)
    await admin.delete(scene.url("topics/recent"))
    await _age(scene, Topic, "recent", 29)

    restored = await admin.post(scene.url("topics/recent:undelete"), json={})
    assert restored.json()["state"] == "ACTIVE"


# -- requestId replays -----------------------------------------------------------------


async def test_create_reading_list_replays_its_request_id(scene: Scene) -> None:
    member = await scene.as_(scene.member)
    params = {"requestId": str(uuid4())}
    first = await member.post(scene.url("readingLists"), params=params, json={"displayName": "Mine"})
    second = await member.post(scene.url("readingLists"), params=params, json={"displayName": "Mine"})
    reused = await member.post(scene.url("readingLists"), params=params, json={"displayName": "Other"})

    assert first.status_code == second.status_code == 200
    assert first.json()["name"] == second.json()["name"]
    assert (reused.status_code, error_reason(reused)) == (400, "REQUEST_ID_REUSED")
    assert (await member.get(scene.url("readingLists"))).json()["totalSize"] == 1


async def test_create_topic_replays_its_request_id(scene: Scene) -> None:
    admin = await scene.as_(scene.admin)
    params = {"requestId": str(uuid4())}
    first = await admin.post(scene.url("topics"), params=params, json={"displayName": "Ops"})
    second = await admin.post(scene.url("topics"), params=params, json={"displayName": "Ops"})
    reused = await admin.post(scene.url("topics"), params=params, json={"displayName": "Other"})

    assert first.json()["name"] == second.json()["name"]
    assert (reused.status_code, error_reason(reused)) == (400, "REQUEST_ID_REUSED")
    assert (await admin.get(scene.url("topics"))).json()["totalSize"] == 1


# -- Later revokes (#30) ---------------------------------------------------------------


async def test_reading_list_entry_disappears_after_a_later_revoke(scene: Scene) -> None:
    admin = await scene.as_(scene.admin)
    await admin.post(
        scene.url("readingLists"),
        params={"readingListId": "team"},
        json={"displayName": "Team", "audience": "WORKSPACE"},
    )
    document = await scene.world.make_document(scene.kb)
    await admin.post(scene.url("readingLists/team/entries"), json={"item": item_name(document)})
    member = await scene.as_(scene.member)
    assert (await member.get(scene.url(f"readingLists/team/entries/{document.id}"))).status_code == 200

    await scene.world.revoke(scene.member, on=scene.kb)

    member = await scene.as_(scene.member)
    assert (await member.get(scene.url(f"readingLists/team/entries/{document.id}"))).status_code == 404
    page = (await member.get(scene.url("readingLists/team/entries"))).json()
    assert (page.get("entries", []), page["hiddenItemCount"]) == ([], 1)


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

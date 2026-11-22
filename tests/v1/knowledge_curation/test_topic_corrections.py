"""Topic assignments: ConfirmTopicAssignments and TopicCorrections (created, read, dismissed)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.exc import DBAPIError

from bomesh.db.models import (
    ContributionTopic,
    Item,
    ItemTopic,
    Topic,
    TopicCorrection,
    TopicCorrectionChange,
    User,
)
from curation_support import OWNER, VIEWER, Scene, item_name

pytestmark = pytest.mark.asyncio


def _topic(scene: Scene, code: str) -> str:
    return f"workspaces/{scene.ws.id}/topics/{code}"


async def _tag(scene: Scene, item: Item, topic: Topic, *, by: User | None = None) -> None:
    async with scene.sessions.begin() as session:
        session.add(
            ItemTopic(
                item_id=item.id, topic_id=topic.id, created_by_user_id=by.id if by else None
            )
        )


async def _creators(scene: Scene, item: Item) -> dict[UUID, UUID | None]:
    async with scene.sessions() as session:
        rows = await session.execute(
            select(ItemTopic.topic_id, ItemTopic.created_by_user_id).where(
                ItemTopic.item_id == item.id
            )
        )
        return dict(rows.tuples().all())


async def _corrections(scene: Scene, item_id: UUID) -> list[TopicCorrection]:
    async with scene.sessions() as session:
        return list(
            await session.scalars(select(TopicCorrection).where(TopicCorrection.item_id == item_id))
        )


async def _changes(scene: Scene, correction: TopicCorrection) -> set[tuple[str, UUID]]:
    async with scene.sessions() as session:
        rows = await session.execute(
            select(TopicCorrectionChange.change_type, TopicCorrectionChange.topic_id).where(
                TopicCorrectionChange.topic_correction_id == correction.id
            )
        )
        return set(rows.tuples().all())


async def _confirm(scene: Scene, user: User, code: str, **body: Any) -> Any:
    api = await scene.as_(user)
    return await api.post(scene.url(f"topics/{code}:confirmAssignments"), json=body)


# -- ConfirmTopicAssignments -----------------------------------------------------------


async def test_confirm_narrows_to_visible_documents_the_caller_edits(scene: Scene) -> None:
    hr = await scene.topic("hr", "HR")
    ops = await scene.topic("ops", "Ops")
    published = await scene.world.make_document(scene.kb)
    draft = await scene.world.make_document(scene.kb, published=False)
    by_person = await scene.world.make_document(scene.kb)
    side = await scene.world.make_collection(scene.ws, grants={scene.reviewer: VIEWER})
    viewed = await scene.world.make_document(side)
    for document in (published, draft, viewed):
        await _tag(scene, document, hr)
    await _tag(scene, published, ops)
    await _tag(scene, by_person, hr, by=scene.member)

    response = await _confirm(scene, scene.reviewer, "hr")

    assert response.status_code == 200, response.text
    assert response.json() == {"confirmedCount": 2}
    assert await _creators(scene, published) == {hr.id: scene.reviewer.id, ops.id: None}
    assert await _creators(scene, draft) == {hr.id: scene.reviewer.id}
    assert await _creators(scene, viewed) == {hr.id: None}
    assert await _creators(scene, by_person) == {hr.id: scene.member.id}
    again = await _confirm(scene, scene.reviewer, "hr")
    assert again.json() == {"confirmedCount": 0}


async def test_confirm_applies_the_list_items_filter(scene: Scene) -> None:
    hr = await scene.topic("hr", "HR")
    chosen = await scene.world.make_document(scene.kb, item_name="Leave policy")
    other = await scene.world.make_document(scene.kb, item_name="Travel policy")
    for document in (chosen, other):
        await _tag(scene, document, hr)

    response = await _confirm(scene, scene.reviewer, "hr", filter='displayName = "Leave policy"')

    assert response.json() == {"confirmedCount": 1}
    assert await _creators(scene, chosen) == {hr.id: scene.reviewer.id}
    assert await _creators(scene, other) == {hr.id: None}
    ops = await scene.topic("ops", "Ops")
    await _tag(scene, other, ops)
    # The filter reads the document's other item_topics rows, never the row being confirmed.
    by_other = await _confirm(
        scene, scene.reviewer, "hr", filter=f'document.assistantTopics:"{_topic(scene, "ops")}"'
    )
    assert by_other.json() == {"confirmedCount": 1}
    none_left = await _confirm(
        scene, scene.reviewer, "ops", filter=f'document.assistantTopics:"{_topic(scene, "hr")}"'
    )
    assert none_left.json() == {"confirmedCount": 0}
    assert await _creators(scene, other) == {hr.id: scene.reviewer.id, ops.id: None}
    secret = await scene.world.make_collection(scene.ws)
    hidden = await _confirm(
        scene, scene.reviewer, "hr", filter=f'parentItem = "{item_name(secret)}"'
    )
    assert hidden.status_code == 403
    bad = await _confirm(scene, scene.reviewer, "hr", filter="color = 1")
    assert bad.status_code == 400
    missing = await _confirm(scene, scene.reviewer, "nope")
    assert missing.status_code == 404
    await scene.topic("idea", "Idea", state="proposed")
    proposed = await _confirm(scene, scene.reviewer, "idea")
    assert proposed.status_code == 403
    admin_proposed = await _confirm(scene, scene.admin, "idea")
    assert admin_proposed.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_confirm_without_items_update_confirms_nothing(scene: Scene) -> None:
    hr = await scene.topic("hr", "HR")
    document = await scene.world.make_document(scene.kb)
    await _tag(scene, document, hr)

    viewer = await _confirm(scene, scene.member, "hr")
    stranger = await _confirm(scene, await scene.world.make_user(), "hr")

    assert viewer.json() == {"confirmedCount": 0}
    assert stranger.status_code == 403
    assert await _creators(scene, document) == {hr.id: None}


# -- Corrections are recorded ----------------------------------------------------------


async def _approve(scene: Scene, suggested: Topic | None, topics: list[str], **body: Any) -> UUID:
    candidate = await scene.candidate()
    await scene.mark_processed(candidate)
    contribution = await scene.submit(candidate)
    if suggested is not None:
        async with scene.sessions.begin() as session:
            session.add(
                ContributionTopic(
                    contribution_id=UUID(contribution["name"].rsplit("/", 1)[1]),
                    topic_id=suggested.id,
                    relation="suggested",
                )
            )
    reviewer = await scene.as_(scene.reviewer)
    response = await reviewer.post(
        f"/api/v1/{contribution['name']}:approve",
        json={"etag": contribution["etag"], "topics": topics, **body},
    )
    assert response.status_code == 200, response.text
    return candidate.id


async def test_approve_records_a_correction_only_when_asked_and_different(scene: Scene) -> None:
    alpha = await scene.topic(f"a{uuid4().hex[:6]}", "Zeta one")
    beta = await scene.topic(f"b{uuid4().hex[:6]}", "Zeta two")

    corrected = await _approve(scene, alpha, [_topic(scene, beta.code)], recordCorrection=True)
    unasked = await _approve(scene, alpha, [_topic(scene, beta.code)])
    declined = await _approve(scene, alpha, [_topic(scene, beta.code)], recordCorrection=False)
    same = await _approve(scene, alpha, [_topic(scene, alpha.code)], recordCorrection=True)

    [row] = await _corrections(scene, corrected)
    assert await _changes(scene, row) == {("removed", alpha.id), ("added", beta.id)}
    assert (row.actor_user_id, row.dismissed_at, row.tenant_id) == (
        scene.reviewer.id,
        None,
        scene.ws.id,
    )
    for item_id in (unasked, declined, same):
        assert await _corrections(scene, item_id) == []


async def test_update_item_records_a_correction_when_it_replaces_assistant_topics(
    scene: Scene,
) -> None:
    hr = await scene.topic("hr", "HR")
    ops = await scene.topic("ops", "Ops")
    assisted = await scene.world.make_document(scene.kb)
    personal = await scene.world.make_document(scene.kb)
    unchanged = await scene.world.make_document(scene.kb)
    await _tag(scene, assisted, hr)
    await _tag(scene, unchanged, hr)
    await _tag(scene, personal, hr, by=scene.reviewer)
    api = await scene.as_(scene.reviewer)

    for document, codes in ((assisted, ["ops"]), (personal, ["ops"]), (unchanged, ["hr"])):
        response = await api.patch(
            f"/api/v1/{item_name(document)}",
            params={"updateMask": "document.topics"},
            json={"document": {"topics": [_topic(scene, code) for code in codes]}},
        )
        assert response.status_code == 200, response.text

    [row] = await _corrections(scene, assisted.id)
    assert row.actor_user_id == scene.reviewer.id
    assert await _changes(scene, row) == {("removed", hr.id), ("added", ops.id)}
    assert await _corrections(scene, personal.id) == []
    assert await _corrections(scene, unchanged.id) == []
    assert await _creators(scene, assisted) == {ops.id: scene.reviewer.id}


# -- Get, List, Dismiss ----------------------------------------------------------------


async def _correction(
    scene: Scene,
    item: Item,
    from_topics: list[Topic],
    to_topics: list[Topic],
    *,
    dismissed: bool = False,
) -> TopicCorrection:
    async with scene.sessions.begin() as session:
        row = TopicCorrection(
            tenant_id=scene.ws.id,
            item_id=item.id,
            actor_user_id=scene.reviewer.id,
            dismissed_at=datetime.now(UTC) if dismissed else None,
        )
        session.add(row)
        await session.flush()
        session.add_all(
            TopicCorrectionChange(topic_correction_id=row.id, topic_id=topic.id, change_type=kind)
            for kind, topics in (("removed", from_topics), ("added", to_topics))
            for topic in topics
        )
    return row


async def test_list_filters_and_hides_unreadable_documents(scene: Scene) -> None:
    hr = await scene.topic("hr", "HR")
    ops = await scene.topic("ops", "Ops")
    visible = await scene.world.make_document(scene.kb, item_name="Leave policy")
    secret = await scene.world.make_collection(scene.ws, grants={scene.reviewer: OWNER})
    hidden = await scene.world.make_document(secret, item_name="Secret plan")
    first = await _correction(scene, visible, [hr], [ops])
    second = await _correction(scene, hidden, [ops], [hr], dismissed=True)
    role = await scene.world.make_role(scene.ws, "taxonomist", ["topics.update"])
    await scene.world.grant(scene.member, role, on=scene.ws)
    api = await scene.as_(scene.member)

    listed = await api.get(scene.url("topicCorrections"))

    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["totalSize"] == 2
    newest, oldest = body["topicCorrections"]
    assert newest == {
        "name": f"workspaces/{scene.ws.id}/topicCorrections/{second.id}",
        "fromTopics": [_topic(scene, "ops")],
        "toTopics": [_topic(scene, "hr")],
        "actor": f"workspaces/{scene.ws.id}/members/{scene.reviewer.id}",
        "state": "DISMISSED",
        "createTime": newest["createTime"],
    }
    assert (oldest["item"], oldest["itemDisplayName"]) == (item_name(visible), "Leave policy")
    by_state = await api.get(scene.url("topicCorrections"), params={"filter": "state = OPEN"})
    assert [c["name"].rsplit("/", 1)[1] for c in by_state.json()["topicCorrections"]] == [
        str(first.id)
    ]
    by_topic = await api.get(
        scene.url("topicCorrections"), params={"filter": f'toTopics:"{_topic(scene, "hr")}"'}
    )
    assert [c["name"].rsplit("/", 1)[1] for c in by_topic.json()["topicCorrections"]] == [
        str(second.id)
    ]
    paged = await api.get(scene.url("topicCorrections"), params={"pageSize": 1})
    assert paged.json()["nextPageToken"]
    bad = await api.get(scene.url("topicCorrections"), params={"filter": "state = CLOSED"})
    assert bad.status_code == 400
    owner = await scene.as_(scene.admin)
    seen = await owner.get(f"/api/v1/workspaces/{scene.ws.id}/topicCorrections/{second.id}")
    assert seen.json()["item"] == item_name(hidden)


async def test_get_and_dismiss_need_topics_update(scene: Scene) -> None:
    hr = await scene.topic("hr", "HR")
    document = await scene.world.make_document(scene.kb)
    correction = await _correction(scene, document, [hr], [])
    url = f"/api/v1/workspaces/{scene.ws.id}/topicCorrections/{correction.id}"
    member = await scene.as_(scene.member)
    admin = await scene.as_(scene.admin)

    assert (await member.get(url)).status_code == 403
    assert (await member.get(scene.url("topicCorrections"))).status_code == 403
    assert (await member.post(f"{url}:dismiss", json={})).status_code == 403
    got = await admin.get(url)
    assert (got.json()["state"], got.json()["toTopics"]) == ("OPEN", [])
    dismissed = await admin.post(f"{url}:dismiss", json={})
    assert dismissed.status_code == 200, dismissed.text
    assert dismissed.json()["state"] == "DISMISSED"
    again = await admin.post(f"{url}:dismiss", json={})
    assert again.json() == dismissed.json()
    other_admin = await scene.world.make_user()
    other = await scene.world.make_workspace(other_admin)
    foreign = await (await scene.as_(other_admin)).get(
        f"/api/v1/workspaces/{other.id}/topicCorrections/{correction.id}"
    )
    assert foreign.status_code == 404
    unknown = await admin.get(f"/api/v1/workspaces/{scene.ws.id}/topicCorrections/{uuid4()}")
    assert unknown.status_code == 404


async def test_a_correction_changes_topics_of_its_own_tenant(scene: Scene) -> None:
    hr = await scene.topic("hr", "HR")
    document = await scene.world.make_document(scene.kb)
    other = await scene.world.make_workspace(await scene.world.make_user())
    async with scene.sessions.begin() as session:
        foreign = Topic(tenant_id=other.id, code="hr", kind="topic", topic_name="HR")
        session.add(foreign)

    with pytest.raises(DBAPIError, match="at least one topic change"):
        async with scene.sessions.begin() as session:
            session.add(
                TopicCorrection(
                    tenant_id=scene.ws.id, item_id=document.id, actor_user_id=scene.reviewer.id
                )
            )
    with pytest.raises(DBAPIError, match="Topic of the correction tenant"):
        await _correction(scene, document, [foreign], [])
    correction = await _correction(scene, document, [hr], [])
    with pytest.raises(DBAPIError, match="at least one topic change"):
        async with scene.sessions.begin() as session:
            await session.execute(
                delete(TopicCorrectionChange).where(
                    TopicCorrectionChange.topic_correction_id == correction.id
                )
            )
    async with scene.sessions.begin() as session:
        await session.execute(delete(TopicCorrection).where(TopicCorrection.id == correction.id))
    assert await _changes(scene, correction) == set()

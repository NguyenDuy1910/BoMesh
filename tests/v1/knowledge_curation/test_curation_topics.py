"""Topics: lifecycle, visibility of non-ACTIVE topics, counts and merge retagging."""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import select

from bomesh.db.models import Contribution, ContributionTopic, ItemTopic
from curation_support import Scene

pytestmark = pytest.mark.asyncio


def _topic(scene: Scene, code: str) -> str:
    return f"workspaces/{scene.ws.id}/topics/{code}"


async def _create(scene: Scene, code: str, **body: Any) -> dict[str, Any]:
    admin = await scene.as_(scene.admin)
    response = await admin.post(
        scene.url("topics"), params={"topicId": code}, json={"displayName": code.title(), **body}
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _tag(scene: Scene, item: Any, topic: Any) -> None:
    async with scene.sessions.begin() as session:
        session.add(ItemTopic(item_id=item.id, topic_id=topic.id))


async def test_create_topics_and_domains(scene: Scene) -> None:
    domain = await _create(scene, "people", kind="DOMAIN")
    topic = await _create(scene, "hiring", parentTopic=domain["name"], color="#fff")

    assert (domain["state"], domain["kind"]) == ("ACTIVE", "DOMAIN")
    assert (topic["kind"], topic["parentTopic"], topic["documentCount"]) == ("TOPIC", domain["name"], 0)
    admin = await scene.as_(scene.admin)
    taken = await admin.post(scene.url("topics"), params={"topicId": "hiring"}, json={"displayName": "X"})
    assert taken.status_code == 409
    nested = await admin.post(
        scene.url("topics"), json={"displayName": "X", "kind": "DOMAIN", "parentTopic": domain["name"]}
    )
    assert nested.json()["error"]["status"] == "INVALID_ARGUMENT"
    under_topic = await admin.post(
        scene.url("topics"), json={"displayName": "X", "parentTopic": topic["name"]}
    )
    assert under_topic.json()["error"]["status"] == "INVALID_ARGUMENT"
    member = await scene.as_(scene.member)
    denied = await member.post(scene.url("topics"), json={"displayName": "Mine"})
    assert denied.status_code == 403


async def test_proposed_topics_are_only_for_accepters(scene: Scene) -> None:
    await scene.topic("active", "Active")
    await scene.topic("idea", "Idea", state="proposed")
    member = await scene.as_(scene.member)
    admin = await scene.as_(scene.admin)

    assert (await member.get(scene.url("topics/idea"))).status_code == 403
    assert (await member.get(scene.url("topics/missing"))).status_code == 404
    listed = (await member.get(scene.url("topics"))).json()
    assert [t["name"] for t in listed["topics"]] == [_topic(scene, "active")]
    every = (await admin.get(scene.url("topics"), params={"filter": "state = PROPOSED"})).json()
    assert [t["name"] for t in every["topics"]] == [_topic(scene, "idea")]


async def test_list_orders_filters_and_pages(scene: Scene) -> None:
    for code in ("b", "a", "c"):
        await scene.topic(code, code.upper())
    await scene.topic("d", "D", kind="domain")
    member = await scene.as_(scene.member)

    page = (await member.get(scene.url("topics"), params={"pageSize": 2, "filter": "kind = TOPIC"})).json()
    assert [t["displayName"] for t in page["topics"]] == ["A", "B"]
    assert page["totalSize"] == 3
    rest = (
        await member.get(
            scene.url("topics"),
            params={"pageSize": 2, "filter": "kind = TOPIC", "pageToken": page["nextPageToken"]},
        )
    ).json()
    assert [t["displayName"] for t in rest["topics"]] == ["C"]
    desc = (await member.get(scene.url("topics"), params={"orderBy": "displayName desc"})).json()
    assert desc["topics"][0]["displayName"] == "D"
    assert (await member.get(scene.url("topics"), params={"filter": "color = x"})).status_code == 400


async def test_document_count_follows_visibility(scene: Scene) -> None:
    topic = await scene.topic("pay", "Pay")
    secret = await scene.world.make_collection(scene.ws)
    await _tag(scene, await scene.world.make_document(scene.kb), topic)
    await _tag(scene, await scene.world.make_document(secret), topic)
    await _tag(scene, await scene.world.make_document(scene.kb, published=False), topic)

    # The outsider reviews nothing (a member reviews their own PERSONAL collection).
    member = (await (await scene.as_(scene.outsider)).get(scene.url("topics/pay"))).json()
    admin = (await (await scene.as_(scene.admin)).get(scene.url("topics/pay"))).json()
    # The admin edits everywhere, so the unpublished document counts too.
    assert (member["documentCount"], admin["documentCount"]) == (1, 3)
    assert "inReviewCount" not in member and admin["inReviewCount"] == 0


async def test_update_with_mask_and_etag(scene: Scene) -> None:
    topic = await _create(scene, "ops", description="Old")
    admin = await scene.as_(scene.admin)

    updated = await admin.patch(
        scene.url("topics/ops"),
        params={"updateMask": "displayName"},
        json={"displayName": "Operations", "description": "ignored", "etag": topic["etag"]},
    )
    assert (updated.json()["displayName"], updated.json()["description"]) == ("Operations", "Old")
    stale = await admin.patch(scene.url("topics/ops"), json={"icon": "x", "etag": topic["etag"]})
    assert stale.status_code == 409
    bad_mask = await admin.patch(scene.url("topics/ops"), params={"updateMask": "state"}, json={})
    assert bad_mask.status_code == 400
    member = await scene.as_(scene.member)
    assert (await member.patch(scene.url("topics/ops"), json={"icon": "x"})).status_code == 403


async def test_delete_only_when_unused_and_undelete(scene: Scene) -> None:
    await _create(scene, "spare")
    used = await scene.topic("used", "Used")
    await _tag(scene, await scene.world.make_document(scene.kb), used)
    admin = await scene.as_(scene.admin)

    in_use = await admin.delete(scene.url("topics/used"))
    assert in_use.json()["error"]["status"] == "FAILED_PRECONDITION"
    deleted = await admin.delete(scene.url("topics/spare"))
    assert (deleted.json()["state"], "deleteTime" in deleted.json(), "purgeTime" in deleted.json()) == (
        "DELETED",
        True,
        True,
    )
    assert (await admin.get(scene.url("topics/spare"))).json()["state"] == "DELETED"
    hidden = (await admin.get(scene.url("topics"))).json()
    assert _topic(scene, "spare") not in [t["name"] for t in hidden["topics"]]
    shown = (await admin.get(scene.url("topics"), params={"showDeleted": "true"})).json()
    assert _topic(scene, "spare") in [t["name"] for t in shown["topics"]]
    restored = await admin.post(scene.url("topics/spare:undelete"), json={})
    assert restored.json()["state"] == "ACTIVE"
    again = await admin.post(scene.url("topics/spare:undelete"), json={})
    assert again.status_code == 409


async def test_accept_and_reject_proposed_topics(scene: Scene) -> None:
    domain = await _create(scene, "finance", kind="DOMAIN")
    proposed = await scene.topic("budget", "Budget", state="proposed")
    await scene.topic("noise", "Noise", state="proposed")
    contribution = await scene.submit(await scene.candidate())
    async with scene.sessions.begin() as session:
        cid = await session.scalar(select(Contribution.id))
        session.add(ContributionTopic(contribution_id=cid, topic_id=proposed.id, relation="proposed"))
    admin = await scene.as_(scene.admin)
    member = await scene.as_(scene.member)

    seen = (await admin.get(scene.url("topics/budget"))).json()
    assert seen["evidence"] == [contribution["name"]]
    assert (await member.post(scene.url("topics/budget:accept"), json={})).status_code == 403
    accepted = await admin.post(
        scene.url("topics/budget:accept"), json={"parentTopic": domain["name"], "displayName": "Budgets"}
    )
    assert (accepted.json()["state"], accepted.json()["parentTopic"], accepted.json()["displayName"]) == (
        "ACTIVE",
        domain["name"],
        "Budgets",
    )
    async with scene.sessions() as session:
        relation = await session.scalar(select(ContributionTopic.relation))
    assert relation == "suggested"
    tagged = (await member.get(f"/api/v1/{contribution['name']}")).json()
    assert tagged["suggestions"]["topics"] == [_topic(scene, "budget")]

    again = await admin.post(scene.url("topics/budget:accept"), json={})
    assert again.json()["error"]["status"] == "FAILED_PRECONDITION"
    assert (await admin.post(scene.url("topics/noise:reject"), json={})).json()["state"] == "REJECTED"


async def test_merge_retags_documents_and_contributions(scene: Scene) -> None:
    source = await scene.topic("old", "Old")
    target = await scene.topic("new", "New")
    await scene.topic("dom", "Dom", kind="domain")
    both = await scene.world.make_document(scene.kb)
    only_old = await scene.world.make_document(scene.kb)
    await _tag(scene, both, source)
    await _tag(scene, both, target)
    await _tag(scene, only_old, source)
    await scene.submit(await scene.candidate())
    async with scene.sessions.begin() as session:
        cid = await session.scalar(select(Contribution.id))
        session.add(ContributionTopic(contribution_id=cid, topic_id=source.id, relation="suggested"))
    admin = await scene.as_(scene.admin)

    wrong_kind = await admin.post(scene.url("topics/old:merge"), json={"targetTopic": _topic(scene, "dom")})
    assert wrong_kind.json()["error"]["status"] == "FAILED_PRECONDITION"
    itself = await admin.post(scene.url("topics/old:merge"), json={"targetTopic": _topic(scene, "old")})
    assert itself.json()["error"]["status"] == "FAILED_PRECONDITION"
    merged = await admin.post(scene.url("topics/old:merge"), json={"targetTopic": _topic(scene, "new")})

    assert merged.json()["state"] == "DELETED"
    async with scene.sessions() as session:
        tags = set(await session.execute(select(ItemTopic.item_id, ItemTopic.topic_id)))
        contribution_tags = set(await session.scalars(select(ContributionTopic.topic_id)))
    assert tags == {(both.id, target.id), (only_old.id, target.id)}
    assert contribution_tags == {target.id}
    assert (await admin.get(scene.url("topics/new"))).json()["documentCount"] == 2

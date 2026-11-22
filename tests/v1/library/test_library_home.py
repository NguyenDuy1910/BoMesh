"""GetMemberHome: self only, permission-filtered sections, LOCKED roots, role-aware starters."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import update

from bomesh.db.models import Item, ItemTopic, RecentItem, Topic
from harness import ApiClient, World
from library_support import item_ref, me, merge, notify

pytestmark = pytest.mark.asyncio


async def test_home_composes_visible_sections(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    colleague = await world.add_member(workspace)
    shared = await world.make_collection(
        workspace, item_name="Handbook", grants={reader: "roles/collectionViewer", colleague: "roles/collectionViewer"}
    )
    locked = await world.make_collection(workspace, item_name="Finance")
    await world.make_collection(workspace, item_name="Hidden")
    async with sessions.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id == locked.id)
            .values(discoverable=True, description="Money")
        )
    await world.make_collection(workspace, personal_for=reader)
    read_doc = await world.make_document(shared, item_name="Leave policy")
    await world.make_document(shared, item_name="Travel policy")
    saved_doc = await world.make_document(shared, item_name="Expenses")
    duplicate = await world.make_document(shared, item_name="Old leave policy")
    await world.make_document(shared, published=False, item_name="Draft")
    secret_doc = await world.make_document(locked, item_name="Payroll")

    async with sessions.begin() as session:
        domain = Topic(tenant_id=workspace.id, code="people", kind="domain", topic_name="People")
        session.add(domain)
        await session.flush()
        topic = Topic(
            tenant_id=workspace.id, code="leave", kind="topic", topic_name="Leave", parent_topic_id=domain.id
        )
        session.add(topic)
        await session.flush()
        session.add_all([ItemTopic(item_id=read_doc.id, topic_id=topic.id), ItemTopic(item_id=secret_doc.id, topic_id=topic.id)])
        now = datetime.now(UTC)
        session.add_all(
            [
                RecentItem(tenant_id=workspace.id, user_id=colleague.id, item_id=saved_doc.id, viewed_at=now),
                RecentItem(tenant_id=workspace.id, user_id=owner.id, item_id=secret_doc.id, viewed_at=now),
            ]
        )

    admin = await client.as_(owner)
    configured = await admin.patch(
        f"/api/v1/workspaces/{workspace.id}/assistant",
        params={"updateMask": "starterPrompts"},
        json={
            "starterPrompts": [
                {"title": "Leave", "prompt": "How much leave do I have?"},
                {"title": "Admin", "prompt": "Who changed settings?", "roles": ["roles/workspaceAdmin"]},
                {"title": "Members", "prompt": "What is new?", "roles": ["roles/workspaceMember"]},
            ]
        },
    )
    assert configured.status_code == 200, configured.text

    api = await client.as_(reader)
    await api.patch(f"{me(workspace)}/recentItems/{read_doc.id}", params={"allowMissing": "true"}, json={})
    await api.patch(f"{me(workspace)}/recentItems/{duplicate.id}", params={"allowMissing": "true"}, json={})
    await merge(admin, duplicate, read_doc)
    await api.post(
        f"{me(workspace)}/savedItems", params={"savedItemId": str(saved_doc.id)}, json={"item": item_ref(saved_doc)}
    )
    await notify(sessions, workspace, reader)
    candidate = await world.make_document(
        await world.make_collection(workspace, personal_for=colleague), item_name="My draft"
    )
    await world.make_contribution(candidate, contributor=reader, target=shared)

    response = await api.get(f"{me(workspace)}/home")
    assert response.status_code == 200, response.text
    home = response.json()
    assert home["name"] == f"workspaces/{workspace.id}/members/{reader.id}/home"

    assert home["counts"] == {
        "collectionCount": 2,
        "documentCount": 3,
        "savedItemCount": 1,
        "topicCount": 1,
        "conversationCount": 0,
        "unreadNotificationCount": 1,
    }
    assert home["starterPrompts"] == [{"title": "Members", "prompt": "What is new?"}]
    assert "joinTime" in home

    [people] = home["topicDomains"]
    assert people["topic"] == f"workspaces/{workspace.id}/topics/people"
    assert people["documentCount"] == 1 and people["newDocumentCount"] == 1
    assert people["topTopics"][0]["documentCount"] == 1

    collections = {c["displayName"]: c for c in home["collections"]}
    assert set(collections) == {"Handbook", "Finance"}
    assert collections["Handbook"]["access"] == "READER"
    assert collections["Handbook"]["documentCount"] == 3
    assert collections["Finance"]["access"] == "LOCKED"
    assert "documentCount" not in collections["Finance"]

    featured = home["featured"]
    assert [f["position"] for f in featured] == list(range(len(featured)))
    assert all(set(f) == {"item", "position"} for f in featured)
    featured_items = [f["item"]["item"] for f in featured]
    assert item_ref(saved_doc) in featured_items
    assert item_ref(secret_doc) not in featured_items

    published = [entry["item"] for entry in home["recentlyPublished"]]
    assert item_ref(secret_doc) not in published and len(published) == 3
    times = [entry["publishTime"] for entry in home["recentlyPublished"]]
    assert times == sorted(times, reverse=True)
    assert all("cover" not in entry for entry in home["recentlyPublished"])

    continue_ = home["continue"]
    assert [entry["item"] for entry in continue_["recentItems"]] == [item_ref(read_doc)]
    assert continue_["recentItems"][0]["collection"] == item_ref(shared)
    assert continue_["recentItems"][0]["verificationState"] == "UNVERIFIED"
    assert [entry["item"] for entry in continue_["upNext"]] == [item_ref(saved_doc)]
    assert [c["state"] for c in continue_["contributions"]] == ["IN_REVIEW"]
    assert continue_["reviewQueueCount"] == 0

    # Read, saved and unreadable documents are never picked; nothing else here has a reason.
    assert home["recommended"] == []


async def test_home_is_self_only(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    admin = await client.as_(owner)
    denied = await admin.get(f"{me(workspace, str(member.id))}/home")
    assert denied.status_code == 403
    outsider = await client.as_(await world.make_user())
    assert (await outsider.get(f"{me(workspace)}/home")).status_code == 403
    empty = (await (await client.as_(member)).get(f"{me(workspace, str(member.id))}/home")).json()
    assert empty["counts"]["documentCount"] == 0
    assert empty["featured"] == [] and empty["continue"]["recentItems"] == []


async def test_home_rechecks_after_a_later_revoke(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    viewed = await world.make_document(shared)
    saved = await world.make_document(shared)
    api = await client.as_(reader)
    await api.patch(f"{me(workspace)}/recentItems/{viewed.id}", params={"allowMissing": "true"}, json={})
    await api.post(
        f"{me(workspace)}/savedItems", params={"savedItemId": str(saved.id)}, json={"item": item_ref(saved)}
    )
    before = (await api.get(f"{me(workspace)}/home")).json()
    assert [e["item"] for e in before["continue"]["recentItems"]] == [item_ref(viewed)]
    assert [e["item"] for e in before["continue"]["upNext"]] == [item_ref(saved)]
    assert before["counts"]["savedItemCount"] == 1 and before["counts"]["documentCount"] == 2

    await world.revoke(reader, on=shared)
    after = (await api.get(f"{me(workspace)}/home")).json()
    assert after["continue"]["recentItems"] == [] and after["continue"]["upNext"] == []
    assert after["recentlyPublished"] == [] and after["recommended"] == []
    assert after["collections"] == []
    assert after["counts"]["savedItemCount"] == 0 and after["counts"]["documentCount"] == 0

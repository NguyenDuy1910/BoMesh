"""GetMemberHome: self only, permission-filtered sections, LOCKED roots, role-aware questions."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from bomesh.db.models import Item, ItemTopic, ReadingList, ReadingListEntry, RecentItem, Topic
from harness import ApiClient, World
from library_support import item_ref, me, merge, notify

pytestmark = pytest.mark.asyncio


async def test_home_composes_visible_sections(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    colleague = await world.add_member(workspace)
    shared = await world.make_collection(
        workspace, title="Handbook", grants={reader: "roles/collectionViewer", colleague: "roles/collectionViewer"}
    )
    locked = await world.make_collection(workspace, title="Finance")
    await world.make_collection(workspace, title="Hidden")
    async with sessions.begin() as session:
        await session.execute(
            update(Item)
            .where(Item.id == locked.id)
            .values(metadata_={"discoverable": True, "description": "Money"})
        )
    await world.make_collection(workspace, personal_for=reader)
    read_doc = await world.make_document(shared, title="Leave policy")
    sibling = await world.make_document(shared, title="Travel policy")
    saved_doc = await world.make_document(shared, title="Expenses")
    duplicate = await world.make_document(shared, title="Old leave policy")
    await world.make_document(shared, published=False, title="Draft")
    secret_doc = await world.make_document(locked, title="Payroll")

    async with sessions.begin() as session:
        domain = Topic(tenant_id=workspace.id, code="people", kind="domain", display_name="People")
        session.add(domain)
        await session.flush()
        topic = Topic(
            tenant_id=workspace.id, code="leave", kind="topic", display_name="Leave", parent_topic_id=domain.id
        )
        session.add(topic)
        await session.flush()
        session.add_all([ItemTopic(item_id=read_doc.id, topic_id=topic.id), ItemTopic(item_id=secret_doc.id, topic_id=topic.id)])
        featured = ReadingList(
            tenant_id=workspace.id, code="featured", kind="featured", title="Featured",
            owner_user_id=owner.id, audience="workspace",
        )
        onboarding = ReadingList(
            tenant_id=workspace.id, code="onboarding", title="Onboarding",
            owner_user_id=owner.id, audience="workspace",
        )
        session.add_all([featured, onboarding])
        await session.flush()
        session.add_all(
            [
                ReadingListEntry(reading_list_id=featured.id, item_id=secret_doc.id, position=0, added_by_user_id=owner.id),
                ReadingListEntry(reading_list_id=featured.id, item_id=sibling.id, position=1, added_by_user_id=owner.id),
                ReadingListEntry(reading_list_id=onboarding.id, item_id=read_doc.id, position=0, added_by_user_id=owner.id),
                ReadingListEntry(reading_list_id=onboarding.id, item_id=secret_doc.id, position=1, added_by_user_id=owner.id),
            ]
        )
        now = datetime.now(UTC)
        session.add(RecentItem(tenant_id=workspace.id, user_id=colleague.id, item_id=saved_doc.id, viewed_at=now))

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
    await merge(sessions, duplicate, read_doc, datetime.now(UTC) - timedelta(seconds=1))
    await api.post(
        f"{me(workspace)}/savedItems", params={"savedItemId": str(saved_doc.id)}, json={"item": item_ref(saved_doc)}
    )
    await notify(sessions, workspace, reader)
    candidate = await world.make_document(
        await world.make_collection(workspace, personal_for=colleague), title="My draft"
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
        "unreadNotificationCount": 1,
    }
    assert home["suggestedQuestions"] == ["How much leave do I have?", "What is new?"]

    [people] = home["topicDomains"]
    assert people["topic"] == f"workspaces/{workspace.id}/topics/people"
    assert people["documentCount"] == 1
    assert people["topTopics"][0]["documentCount"] == 1

    collections = {c["displayName"]: c for c in home["collections"]}
    assert set(collections) == {"Handbook", "Finance"}
    assert collections["Handbook"]["access"] == "READER"
    assert collections["Handbook"]["documentCount"] == 3
    assert collections["Finance"]["access"] == "LOCKED"
    assert "documentCount" not in collections["Finance"]

    assert home["readingLists"] == [
        {"readingList": f"workspaces/{workspace.id}/readingLists/onboarding", "displayName": "Onboarding", "itemCount": 1}
    ]
    featured_items = [(f["item"]["item"], f["source"]) for f in home["featured"]]
    assert featured_items[0] == (item_ref(sibling), "CURATED")
    assert (item_ref(saved_doc), "POPULAR") in featured_items
    assert item_ref(secret_doc) not in {f["item"]["item"] for f in home["featured"]}

    published = [entry["item"] for entry in home["recentlyPublished"]]
    assert item_ref(secret_doc) not in published and len(published) == 3
    times = [entry["publishTime"] for entry in home["recentlyPublished"]]
    assert times == sorted(times, reverse=True)
    assert all("thumbnailUri" not in entry for entry in home["recentlyPublished"])

    continue_ = home["continue"]
    assert [entry["item"] for entry in continue_["recentItems"]] == [item_ref(read_doc)]
    assert continue_["recentItems"][0]["collection"] == item_ref(shared)
    assert continue_["recentItems"][0]["verificationState"] == "UNVERIFIED"
    assert [entry["item"] for entry in continue_["upNext"]] == [item_ref(saved_doc)]
    assert [c["state"] for c in continue_["contributions"]] == ["IN_REVIEW"]
    assert continue_["reviewQueueCount"] == 0

    recommended = home["recommended"]
    assert recommended[0]["reason"]["kind"] == "BECAUSE_YOU_READ"
    assert recommended[0]["reason"]["label"] == "Because you read Leave policy"
    assert item_ref(read_doc) not in {r["item"]["item"] for r in recommended}
    assert item_ref(secret_doc) not in {r["item"]["item"] for r in recommended}


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

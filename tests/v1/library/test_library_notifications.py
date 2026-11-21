"""Notifications: unread totals, the read flag, dismiss/undelete, markRead, target visibility."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select, update

from bomesh.db.models import Contribution, Notification, Request, Role
from bomesh.db.models.knowledge import OPEN_CONTRIBUTION_STATES
from bomesh.iam.authorizer import ItemRef, Principal
from bomesh.iam.visibility import is_visible
from bomesh.services.collaboration.requests import decision_ref
from bomesh.services.kernel.notifications import NotificationSubject
from bomesh.services.knowledge_curation.access import is_reviewer
from harness import ApiClient, World
from library_support import item_ref, me, notify, set_created, uuid_of

pytestmark = pytest.mark.asyncio


async def _setup(world: World):
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    return workspace, reader, shared


async def test_list_counts_unread_and_filters(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, shared = await _setup(world)
    document = await world.make_document(shared)
    now = datetime.now(UTC)
    old = await notify(sessions, workspace, reader, kind="REQUEST_UPDATED")
    about_item = await notify(sessions, workspace, reader, item=document)
    newest = await notify(sessions, workspace, reader, kind="REQUEST_UPDATED")
    for minutes, row in ((3, old), (2, about_item), (1, newest)):
        await set_created(sessions, row, now - timedelta(minutes=minutes))
    api = await client.as_(reader)

    listed = (await api.get(f"{me(workspace)}/notifications")).json()
    assert [uuid_of(n["name"]) for n in listed["notifications"]] == [newest.id, about_item.id, old.id]
    assert listed["totalSize"] == 3
    item_entry = listed["notifications"][1]
    assert item_entry["target"] == item_ref(document)
    assert item_entry["read"] is False and item_entry["kind"] == "ITEM_PUBLISHED"
    assert "target" not in listed["notifications"][0]

    await api.patch(f"{me(workspace)}/notifications/{old.id}", json={"read": True})
    unread = (await api.get(f"{me(workspace)}/notifications", params={"filter": "read=false"})).json()
    assert unread["totalSize"] == 2
    by_kind = (
        await api.get(f"{me(workspace)}/notifications", params={"filter": 'kind="ITEM_PUBLISHED"'})
    ).json()
    assert [uuid_of(n["name"]) for n in by_kind["notifications"]] == [about_item.id]
    by_target = (
        await api.get(
            f"{me(workspace)}/notifications", params={"filter": f'target="{item_ref(document)}"'}
        )
    ).json()
    assert by_target["totalSize"] == 1
    oldest_first = (
        await api.get(f"{me(workspace)}/notifications", params={"orderBy": "createTime", "pageSize": 1})
    ).json()
    assert uuid_of(oldest_first["notifications"][0]["name"]) == old.id
    assert oldest_first["nextPageToken"] and oldest_first["totalSize"] == 3
    bad = await api.get(f"{me(workspace)}/notifications", params={"filter": "title=1"})
    assert bad.status_code == 400


async def test_update_read_flag(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, _ = await _setup(world)
    row = await notify(sessions, workspace, reader)
    api = await client.as_(reader)
    path = f"{me(workspace)}/notifications/{row.id}"
    read = await api.patch(path, params={"updateMask": "read"}, json={"read": True})
    assert read.status_code == 200 and read.json()["read"] is True
    unread = await api.patch(path, json={"read": False})
    assert unread.json()["read"] is False
    immutable = await api.patch(path, params={"updateMask": "title"}, json={"title": "x"})
    assert immutable.status_code == 400
    assert (await api.get(path)).json()["read"] is False
    assert (await api.get(f"{me(workspace)}/notifications/{uuid4()}")).status_code == 404


async def test_dismiss_and_undelete(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, _ = await _setup(world)
    row = await notify(sessions, workspace, reader)
    api = await client.as_(reader)
    path = f"{me(workspace)}/notifications/{row.id}"

    not_deleted = await api.post(f"{path}:undelete", json={})
    assert not_deleted.status_code == 409
    dismissed = await api.delete(path)
    assert dismissed.status_code == 200
    assert dismissed.json()["deleteTime"] and dismissed.json()["purgeTime"]
    assert (await api.get(f"{me(workspace)}/notifications")).json()["totalSize"] == 0
    with_deleted = (
        await api.get(f"{me(workspace)}/notifications", params={"showDeleted": "true"})
    ).json()
    assert with_deleted["totalSize"] == 1
    assert (await api.get(path)).json()["deleteTime"]

    restored = await api.post(f"{path}:undelete", json={})
    assert restored.status_code == 200 and "deleteTime" not in restored.json()
    assert (await api.get(f"{me(workspace)}/notifications")).json()["totalSize"] == 1

    async with sessions.begin() as session:
        await session.execute(
            update(Notification)
            .where(Notification.id == row.id)
            .values(deleted_at=datetime.now(UTC) - timedelta(days=31))
        )
    assert (await api.get(path)).status_code == 404
    assert (await api.post(f"{path}:undelete", json={})).status_code == 404


async def test_mark_read(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, _ = await _setup(world)
    await notify(sessions, workspace, reader, kind="REQUEST_UPDATED")
    await notify(sessions, workspace, reader, kind="REQUEST_UPDATED")
    await notify(sessions, workspace, reader, kind="CONTRIBUTION_REVIEWED")
    api = await client.as_(reader)
    marked = await api.post(
        f"{me(workspace)}/notifications:markRead", json={"filter": 'kind="REQUEST_UPDATED"'}
    )
    assert marked.json() == {"updatedCount": 2}
    unread = (await api.get(f"{me(workspace)}/notifications", params={"filter": "read=false"})).json()
    assert unread["totalSize"] == 1
    everything = await api.post(f"{me(workspace)}/notifications:markRead", json={})
    assert everything.json() == {"updatedCount": 1}
    invalid = await api.post(f"{me(workspace)}/notifications:markRead", json={"filter": "nope=1"})
    assert invalid.status_code == 400


async def test_unreadable_target_is_hidden(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, shared = await _setup(world)
    document = await world.make_document(shared)
    row = await notify(sessions, workspace, reader, item=document)
    await notify(sessions, workspace, reader)
    api = await client.as_(reader)
    await world.revoke(reader, on=shared)
    listed = (await api.get(f"{me(workspace)}/notifications")).json()
    assert listed["totalSize"] == 1
    assert row.id not in {uuid_of(n["name"]) for n in listed["notifications"]}
    assert (await api.get(f"{me(workspace)}/notifications/{row.id}")).status_code == 404
    marked = await api.post(f"{me(workspace)}/notifications:markRead", json={})
    assert marked.json() == {"updatedCount": 1}


async def test_notifications_are_self_only(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, _ = await _setup(world)
    other = await world.add_member(workspace)
    row = await notify(sessions, workspace, reader)
    snoop = await client.as_(other)
    theirs = f"{me(workspace, str(reader.id))}/notifications"
    assert (await snoop.get(theirs)).status_code == 403
    assert (await snoop.get(f"{theirs}/{row.id}")).status_code == 403
    assert (await snoop.patch(f"{theirs}/{row.id}", json={"read": True})).status_code == 403
    assert (await snoop.delete(f"{theirs}/{row.id}")).status_code == 403
    assert (await snoop.post(f"{theirs}:markRead", json={})).status_code == 403
    assert (await snoop.get(f"{me(workspace)}/notifications/{row.id}")).status_code == 404
    await world.suspend_member(workspace, reader)
    suspended = await client.as_(reader)
    assert (await suspended.get(f"{me(workspace)}/notifications")).status_code == 403


async def test_contribution_subject_is_rechecked(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    contributor = await world.add_member(workspace)
    target = await world.make_collection(workspace, grants={contributor: "roles/collectionViewer"})
    candidate = await world.make_document(
        await world.make_collection(workspace, personal_for=contributor), item_name="Secret plan"
    )
    contribution = await world.make_contribution(candidate, contributor=contributor, target=target)
    subject = NotificationSubject("contribution", contribution.id)
    for_reviewer = await notify(sessions, workspace, owner, kind="CONTRIBUTION_SUBMITTED", subject=subject)
    for_contributor = await notify(sessions, workspace, contributor, kind="CONTRIBUTION_SUBMITTED", subject=subject)
    reviewer = await client.as_(owner)
    assert (await reviewer.get(f"{me(workspace)}/notifications")).json()["totalSize"] == 1

    async with sessions.begin() as session:
        await session.execute(
            update(Contribution).where(Contribution.id == contribution.id).values(state="approved")
        )
    listed = (await reviewer.get(f"{me(workspace)}/notifications", params={"filter": "read=false"})).json()
    assert listed["totalSize"] == 0 and listed.get("notifications", []) == []
    assert (await reviewer.get(f"{me(workspace)}/notifications/{for_reviewer.id}")).status_code == 404
    assert (await reviewer.post(f"{me(workspace)}/notifications:markRead", json={})).json() == {"updatedCount": 0}
    home = (await reviewer.get(f"{me(workspace)}/home")).json()
    assert home["counts"]["unreadNotificationCount"] == 0

    mine = await client.as_(contributor)
    assert (await mine.get(f"{me(workspace)}/notifications/{for_contributor.id}")).status_code == 200


async def test_request_subject_is_rechecked_after_revoke(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    lead = await world.add_member(workspace)
    requester = await world.add_member(workspace)
    space = await world.make_space(workspace, lead)
    async with sessions.begin() as session:
        request = Request(
            tenant_id=workspace.id, kind="question", space_id=space.id,
            requester_user_id=requester.id, question="Where is the policy?",
        )
        session.add(request)
    subject = NotificationSubject("request", request.id)
    row = await notify(sessions, workspace, lead, kind="REQUEST_CREATED", subject=subject)
    api = await client.as_(lead)
    assert (await api.get(f"{me(workspace)}/notifications/{row.id}")).status_code == 200

    await world.revoke(lead, on=space)
    assert (await api.get(f"{me(workspace)}/notifications")).json()["totalSize"] == 0
    assert (await api.get(f"{me(workspace)}/notifications/{row.id}")).status_code == 404


async def test_sql_read_rules_equal_the_per_subject_checks(
    client: ApiClient, world: World, sessions
) -> None:
    """Lists, totals and Home's badge show exactly the subjects each per-item check allows."""
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader, lead, requester, reviewer, stranger = [await world.add_member(workspace) for _ in range(5)]
    team = await world.make_group(workspace, [reader])
    shared = await world.make_collection(
        workspace, grants={team: "roles/collectionViewer", reviewer: "roles/collectionOwner"}
    )
    chapter = await world.make_collection(workspace, shared)
    gone = await world.make_collection(workspace, shared)
    locked = await world.make_collection(workspace)
    personal = await world.make_collection(workspace, personal_for=requester)
    items = [
        await world.make_document(chapter),
        await world.make_document(chapter, published=False),
        await world.make_document(gone),
        await world.make_document(locked),
        await world.make_document(personal),
    ]
    await world.delete(gone)
    space = await world.make_space(workspace, lead)
    await world.grant(requester, "roles/spaceMember", on=space)
    async with sessions.begin() as session:
        viewer_role = await session.scalar(
            select(Role.id).where(Role.tenant_id.is_(None), Role.code == "collectionViewer")
        )
        requests = [
            Request(tenant_id=workspace.id, kind="question", space_id=space.id,
                    requester_user_id=requester.id, question="Where?"),
            Request(tenant_id=workspace.id, kind="collection_access", collection_item_id=shared.id,
                    requested_role_id=viewer_role, requester_user_id=stranger.id),
            Request(tenant_id=workspace.id, kind="connector", connector_key="drive",
                    requester_user_id=stranger.id),
        ]
        session.add_all(requests)
    contributions = [
        await world.make_contribution(
            await world.make_document(personal), contributor=requester, target=shared, state=state
        )
        for state in ("in_review", "approved", "in_review")
    ] + [
        await world.make_contribution(
            await world.make_document(personal), contributor=requester,
            suggestions={"collection_id": str(locked.id)},
        )
    ]
    async with sessions.begin() as session:
        await session.execute(
            update(Contribution).where(Contribution.id == contributions[2].id).values(deleted_at=datetime.now(UTC))
        )
    subjects: list[tuple[str | None, object]] = [
        (None, None),
        *(("item", item.id) for item in items),
        *(("request", request.id) for request in requests),
        *(("contribution", contribution.id) for contribution in contributions),
        ("space", space.id),
        ("ingestion_source", uuid4()),
    ]
    users = [owner, reader, lead, requester, reviewer, stranger]
    async with sessions.begin() as session:
        rows = {
            (user.id, subject): Notification(
                tenant_id=workspace.id, recipient_user_id=user.id, kind="ITEM_PUBLISHED",
                subject_type=subject[0], subject_id=subject[1], title="t", body="b",
            )
            for user in users
            for subject in subjects
        }
        session.add_all(rows.values())
    by_id = {request.id: request for request in requests} | {c.id: c for c in contributions}

    async def per_subject(user, subject_type: str | None, subject_id) -> bool:
        authorizer, principal = world.authorizer(), Principal(user.id)
        if subject_type is None:
            return True
        if subject_type == "item":
            return await is_visible(authorizer, principal, ItemRef(workspace.id, subject_id))
        if subject_type == "request":
            request = by_id[subject_id]
            return request.requester_user_id == user.id or "requests.get" in await authorizer.permissions(
                principal, decision_ref(workspace.id, request)
            )
        if subject_type == "contribution":
            async with sessions() as session:
                contribution = await session.get(Contribution, subject_id)
            return contribution.deleted_at is None and (
                contribution.contributor_user_id == user.id
                or (
                    contribution.state in OPEN_CONTRIBUTION_STATES
                    and await is_reviewer(authorizer, principal, contribution)
                )
            )
        return False

    outcomes: dict[str | None, set[bool]] = {}
    for user in users:
        expected = set()
        for subject in subjects:
            allowed = await per_subject(user, *subject)
            outcomes.setdefault(subject[0], set()).add(allowed)
            if allowed:
                expected.add(rows[(user.id, subject)].id)
        api = await client.as_(user)
        listed = (await api.get(f"{me(workspace)}/notifications", params={"pageSize": 100})).json()
        assert {uuid_of(n["name"]) for n in listed.get("notifications", [])} == expected, user.email
        assert listed["totalSize"] == len(expected)
        home = (await api.get(f"{me(workspace)}/home")).json()
        assert home["counts"]["unreadNotificationCount"] == len(expected)
    assert all(outcomes[kind] == {True, False} for kind in ("item", "request", "contribution"))

"""Saved items and recent items: self only, the item reference rule, merges, paging."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from bomesh.db.models import RecentItem, SavedItem
from harness import ApiClient, World
from library_support import item_ref, me, merge, reason

pytestmark = pytest.mark.asyncio


async def _setup(world: World):
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    secret = await world.make_collection(workspace)
    return workspace, reader, shared, secret


# -- Saved items ----------------------------------------------------------------


async def test_saved_item_lifecycle(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, shared, _ = await _setup(world)
    document = await world.make_document(shared)
    api = await client.as_(reader)

    created = await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(document.id)},
        json={"item": item_ref(document)},
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["name"] == f"workspaces/{workspace.id}/members/{reader.id}/savedItems/{document.id}"
    assert body["item"] == item_ref(document)
    assert "mergedFrom" not in body and body["createTime"]

    again = await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(document.id)},
        json={"item": item_ref(document)},
    )
    assert again.status_code == 409

    by_id = await api.get(f"{me(workspace, str(reader.id))}/savedItems/{document.id}")
    assert by_id.json()["name"] == body["name"]
    listed = await api.get(f"{me(workspace)}/savedItems")
    assert [entry["name"] for entry in listed.json()["savedItems"]] == [body["name"]]

    assert (await api.delete(f"{me(workspace)}/savedItems/{document.id}")).status_code == 200
    assert (await api.delete(f"{me(workspace)}/savedItems/{document.id}")).status_code == 404
    assert (await api.get(f"{me(workspace)}/savedItems/{document.id}")).status_code == 404
    async with sessions() as session:
        assert (await session.scalars(select(SavedItem))).all() == []


async def test_create_saved_item_errors(client: ApiClient, world: World) -> None:
    workspace, reader, shared, secret = await _setup(world)
    document = await world.make_document(shared)
    hidden = await world.make_document(secret)
    api = await client.as_(reader)

    mismatch = await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(uuid4())},
        json={"item": item_ref(document)},
    )
    assert mismatch.status_code == 400
    malformed = await api.post(
        f"{me(workspace)}/savedItems", params={"savedItemId": "x"}, json={"item": "items/x"}
    )
    assert malformed.status_code == 400
    unreadable = await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(hidden.id)},
        json={"item": item_ref(hidden)},
    )
    missing_id = uuid4()
    absent = await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(missing_id)},
        json={"item": f"workspaces/{workspace.id}/items/{missing_id}"},
    )
    assert unreadable.status_code == absent.status_code == 403
    unpublished = await world.make_document(shared, published=False)
    draft = await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(unpublished.id)},
        json={"item": item_ref(unpublished)},
    )
    assert draft.status_code == 403


async def test_saved_items_are_self_only(client: ApiClient, world: World) -> None:
    workspace, reader, shared, _ = await _setup(world)
    other = await world.add_member(workspace)
    outsider = await world.make_user()
    document = await world.make_document(shared)
    await (await client.as_(reader)).post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(document.id)},
        json={"item": item_ref(document)},
    )
    snoop = await client.as_(other)
    denied = await snoop.get(f"{me(workspace, str(reader.id))}/savedItems")
    assert denied.status_code == 403
    assert (await snoop.get(f"{me(workspace, str(reader.id))}/savedItems/{document.id}")).status_code == 403
    assert (await snoop.get(f"{me(workspace)}/savedItems")).json()["savedItems"] == []
    stranger = await client.as_(outsider)
    assert (await stranger.get(f"{me(workspace)}/savedItems")).status_code == 403
    anonymous = await client.get(f"{me(workspace)}/savedItems")
    assert anonymous.status_code == 401


async def test_unreadable_saved_item_reads_as_absent(client: ApiClient, world: World) -> None:
    workspace, reader, shared, _ = await _setup(world)
    first = await world.make_document(shared)
    second = await world.make_document(shared)
    api = await client.as_(reader)
    for document in (first, second):
        await api.post(
            f"{me(workspace)}/savedItems",
            params={"savedItemId": str(document.id)},
            json={"item": item_ref(document)},
        )
    await world.delete(first)
    listed = await api.get(f"{me(workspace)}/savedItems")
    assert [entry["item"] for entry in listed.json()["savedItems"]] == [item_ref(second)]
    assert (await api.get(f"{me(workspace)}/savedItems/{first.id}")).status_code == 404

    await world.revoke(reader, on=shared)
    assert (await api.get(f"{me(workspace)}/savedItems")).json()["savedItems"] == []
    assert (await api.get(f"{me(workspace)}/savedItems/{second.id}")).status_code == 404


async def test_saved_item_resolves_merge(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, shared, _ = await _setup(world)
    duplicate = await world.make_document(shared)
    target = await world.make_document(shared)
    api = await client.as_(reader)
    await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(duplicate.id)},
        json={"item": item_ref(duplicate)},
    )
    await merge(sessions, duplicate, target, datetime.now(UTC))
    got = (await api.get(f"{me(workspace)}/savedItems/{duplicate.id}")).json()
    assert got["item"] == item_ref(target)
    assert got["mergedFrom"] == item_ref(duplicate)
    assert got["name"].endswith(f"/savedItems/{duplicate.id}")


async def test_saved_items_paging_skips_unreadable(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, shared, secret = await _setup(world)
    documents = [await world.make_document(shared) for _ in range(3)]
    hidden = await world.make_document(secret)
    now = datetime.now(UTC)
    async with sessions.begin() as session:
        for offset, item in enumerate([documents[0], hidden, documents[1], documents[2]]):
            session.add(
                SavedItem(
                    tenant_id=workspace.id,
                    user_id=reader.id,
                    item_id=item.id,
                    created_at=now - timedelta(minutes=offset),
                )
            )
    api = await client.as_(reader)
    first = (await api.get(f"{me(workspace)}/savedItems", params={"pageSize": 2})).json()
    assert [e["item"] for e in first["savedItems"]] == [item_ref(documents[0]), item_ref(documents[1])]
    second = (
        await api.get(
            f"{me(workspace)}/savedItems",
            params={"pageSize": 2, "pageToken": first["nextPageToken"]},
        )
    ).json()
    assert [e["item"] for e in second["savedItems"]] == [item_ref(documents[2])]
    assert not second.get("nextPageToken")

    ascending = (await api.get(f"{me(workspace)}/savedItems", params={"orderBy": "createTime"})).json()
    assert [e["item"] for e in ascending["savedItems"]] == [
        item_ref(documents[2]), item_ref(documents[1]), item_ref(documents[0])
    ]
    bad_order = await api.get(f"{me(workspace)}/savedItems", params={"orderBy": "title"})
    assert bad_order.status_code == 400


async def test_create_saved_item_is_idempotent(client: ApiClient, world: World) -> None:
    workspace, reader, shared, _ = await _setup(world)
    document = await world.make_document(shared)
    other = await world.make_document(shared)
    api = await client.as_(reader)
    request_id = str(uuid4())
    params = {"savedItemId": str(document.id), "requestId": request_id}
    first = await api.post(f"{me(workspace)}/savedItems", params=params, json={"item": item_ref(document)})
    replay = await api.post(f"{me(workspace)}/savedItems", params=params, json={"item": item_ref(document)})
    assert first.status_code == replay.status_code == 200
    assert replay.json() == first.json()
    reused = await api.post(
        f"{me(workspace)}/savedItems",
        params={"savedItemId": str(other.id), "requestId": request_id},
        json={"item": item_ref(other)},
    )
    assert reused.status_code == 400 and reason(reused) == "REQUEST_ID_REUSED"


# -- Recent items ---------------------------------------------------------------


async def test_record_view_and_read_back(client: ApiClient, world: World, sessions) -> None:
    workspace, reader, shared, _ = await _setup(world)
    document = await world.make_document(shared)
    api = await client.as_(reader)
    path = f"{me(workspace)}/recentItems/{document.id}"

    missing = await api.patch(path, json={})
    assert missing.status_code == 404
    created = await api.patch(path, params={"allowMissing": "true"}, json={})
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["item"] == item_ref(document) and body["viewTime"]

    moment = "2026-01-02T03:04:05Z"
    updated = await api.patch(path, json={"viewTime": moment, "item": item_ref(document)})
    assert updated.json()["viewTime"].startswith("2026-01-02T03:04:05")
    async with sessions() as session:
        row = await session.scalar(select(RecentItem))
        assert row is not None and row.viewed_at == datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)

    mismatch = await api.patch(path, json={"item": f"workspaces/{workspace.id}/items/{uuid4()}"})
    assert mismatch.status_code == 400
    bad_mask = await api.patch(path, params={"updateMask": "item"}, json={})
    assert bad_mask.status_code == 400
    assert (await api.get(path)).json()["name"] == body["name"]


async def test_record_view_of_unreadable_item_is_denied(client: ApiClient, world: World) -> None:
    workspace, reader, _, secret = await _setup(world)
    hidden = await world.make_document(secret)
    api = await client.as_(reader)
    denied = await api.patch(
        f"{me(workspace)}/recentItems/{hidden.id}", params={"allowMissing": "true"}, json={}
    )
    assert denied.status_code == 403
    absent = await api.patch(
        f"{me(workspace)}/recentItems/{uuid4()}", params={"allowMissing": "true"}, json={}
    )
    assert absent.status_code == 403


async def test_recent_items_list_delete_clear(client: ApiClient, world: World) -> None:
    workspace, reader, shared, _ = await _setup(world)
    other = await world.add_member(workspace)
    first, second, third = [await world.make_document(shared) for _ in range(3)]
    api = await client.as_(reader)
    for minute, document in enumerate((first, second, third)):
        await api.patch(
            f"{me(workspace)}/recentItems/{document.id}",
            params={"allowMissing": "true"},
            json={"viewTime": f"2026-01-01T00:0{minute}:00Z"},
        )
    listed = (await api.get(f"{me(workspace)}/recentItems")).json()["recentItems"]
    assert [e["item"] for e in listed] == [item_ref(third), item_ref(second), item_ref(first)]
    oldest_first = (
        await api.get(f"{me(workspace)}/recentItems", params={"orderBy": "viewTime"})
    ).json()["recentItems"]
    assert oldest_first[0]["item"] == item_ref(first)

    assert (await (await client.as_(other)).post(
        f"{me(workspace, str(reader.id))}/recentItems:clear", json={}
    )).status_code == 403

    assert (await api.delete(f"{me(workspace)}/recentItems/{second.id}")).status_code == 200
    assert (await api.delete(f"{me(workspace)}/recentItems/{second.id}")).status_code == 404
    assert (await api.get(f"{me(workspace)}/recentItems/{second.id}")).status_code == 404
    assert len((await api.get(f"{me(workspace)}/recentItems")).json()["recentItems"]) == 2
    assert (await api.post(f"{me(workspace)}/recentItems:clear", json={})).status_code == 200
    assert (await api.get(f"{me(workspace)}/recentItems")).json()["recentItems"] == []


async def test_recent_items_hide_unreadable_entries(client: ApiClient, world: World) -> None:
    workspace, reader, shared, _ = await _setup(world)
    document = await world.make_document(shared)
    api = await client.as_(reader)
    await api.patch(f"{me(workspace)}/recentItems/{document.id}", params={"allowMissing": "true"}, json={})
    await world.revoke(reader, on=shared)
    assert (await api.get(f"{me(workspace)}/recentItems")).json()["recentItems"] == []
    assert (await api.get(f"{me(workspace)}/recentItems/{document.id}")).status_code == 404

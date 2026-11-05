"""Saved searches: CRUD, SearchItems filter/orderBy validation, referenced-item checks."""

from __future__ import annotations

from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from harness import ApiClient, World
from library_support import item_ref, me

pytestmark = pytest.mark.asyncio


async def _setup(world: World):
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    reader = await world.add_member(workspace)
    shared = await world.make_collection(workspace, grants={reader: "roles/collectionViewer"})
    secret = await world.make_collection(workspace)
    return workspace, reader, shared, secret


async def test_saved_search_crud(client: ApiClient, world: World) -> None:
    workspace, reader, shared, _ = await _setup(world)
    api = await client.as_(reader)
    filter_text = f'ancestors:"{item_ref(shared)}" AND document.documentType="pdf"'
    created = await api.post(
        f"{me(workspace)}/savedSearches",
        json={"displayName": "Policies", "query": "leave", "filter": filter_text, "orderBy": "updateTime desc"},
    )
    assert created.status_code == 200, created.text
    search = created.json()
    assert search["name"].startswith(f"workspaces/{workspace.id}/members/{reader.id}/savedSearches/")
    assert search["layout"] == "LIST" and search["filter"] == filter_text
    search_id = search["name"].rsplit("/", 1)[-1]
    path = f"{me(workspace)}/savedSearches/{search_id}"

    assert (await api.get(path)).json() == search
    updated = await api.patch(
        path, params={"updateMask": "displayName,layout"}, json={"displayName": "Docs", "layout": "GRID"}
    )
    assert updated.json()["displayName"] == "Docs" and updated.json()["layout"] == "GRID"
    assert updated.json()["query"] == "leave"
    cleared = await api.patch(path, params={"updateMask": "filter"}, json={})
    assert "filter" not in cleared.json()

    await api.post(f"{me(workspace)}/savedSearches", json={"displayName": "Alpha"})
    by_name = (await api.get(f"{me(workspace)}/savedSearches")).json()["savedSearches"]
    assert [s["displayName"] for s in by_name] == ["Alpha", "Docs"]
    by_update = (
        await api.get(f"{me(workspace)}/savedSearches", params={"orderBy": "updateTime desc", "pageSize": 1})
    ).json()
    assert by_update["savedSearches"][0]["displayName"] == "Alpha" and by_update["nextPageToken"]

    assert (await api.delete(path)).status_code == 200
    assert (await api.get(path)).status_code == 404
    assert (await api.delete(path)).status_code == 404
    assert (await api.get(f"{me(workspace)}/savedSearches/{uuid4()}")).status_code == 404


async def test_saved_search_validation(client: ApiClient, world: World) -> None:
    workspace, reader, _, secret = await _setup(world)
    api = await client.as_(reader)
    url = f"{me(workspace)}/savedSearches"
    assert (await api.post(url, json={"displayName": ""})).status_code == 400
    assert (await api.post(url, json={"displayName": "x" * 201})).status_code == 400
    assert (await api.post(url, json={"displayName": "x", "filter": "nope = 1"})).status_code == 400
    assert (await api.post(url, json={"displayName": "x", "orderBy": "size"})).status_code == 400
    assert (await api.post(url, json={"displayName": "x", "layout": "CARDS"})).status_code == 400
    denied = await api.post(
        url, json={"displayName": "x", "filter": f'ancestors:"{item_ref(secret)}"'}
    )
    assert denied.status_code == 403
    created = (await api.post(url, json={"displayName": "ok"})).json()
    path = f"{me(workspace)}/savedSearches/{created['name'].rsplit('/', 1)[-1]}"
    denied_update = await api.patch(
        path, params={"updateMask": "filter"}, json={"filter": f'parentItem="{item_ref(secret)}"'}
    )
    assert denied_update.status_code == 403
    assert (await api.patch(path, params={"updateMask": "name"}, json={})).status_code == 400


async def test_saved_searches_are_self_only(client: ApiClient, world: World) -> None:
    workspace, reader, _, _ = await _setup(world)
    other = await world.add_member(workspace)
    created = (await (await client.as_(reader)).post(
        f"{me(workspace)}/savedSearches", json={"displayName": "Mine"}
    )).json()
    search_id = created["name"].rsplit("/", 1)[-1]
    snoop = await client.as_(other)
    theirs = f"{me(workspace, str(reader.id))}/savedSearches"
    assert (await snoop.get(theirs)).status_code == 403
    assert (await snoop.get(f"{theirs}/{search_id}")).status_code == 403
    assert (await snoop.delete(f"{theirs}/{search_id}")).status_code == 403
    assert (await snoop.get(f"{me(workspace)}/savedSearches/{search_id}")).status_code == 404


async def test_create_saved_search_is_idempotent(client: ApiClient, world: World) -> None:
    workspace, reader, _, _ = await _setup(world)
    api = await client.as_(reader)
    request_id = str(uuid4())
    url = f"{me(workspace)}/savedSearches"
    first = await api.post(url, params={"requestId": request_id}, json={"displayName": "Once"})
    replay = await api.post(url, params={"requestId": request_id}, json={"displayName": "Once"})
    assert replay.json() == first.json()
    assert len((await api.get(url)).json()["savedSearches"]) == 1


async def test_update_time_uses_the_database_clock(
    client: ApiClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    """createTime and updateTime come from one clock, so updateTime ordering is stable."""
    import bomesh.services.library.searches as searches

    class _SkewedClock(datetime):
        @classmethod
        def now(cls, tz=None):  # type: ignore[override]
            return datetime.now(tz) + timedelta(days=1)

    monkeypatch.setattr(searches, "datetime", _SkewedClock, raising=False)
    workspace, reader, _, _ = await _setup(world)
    api = await client.as_(reader)
    url = f"{me(workspace)}/savedSearches"
    first = (await api.post(url, json={"displayName": "First"})).json()
    await api.patch(f"{url}/{first['name'].rsplit('/', 1)[-1]}", json={"displayName": "Edited"})
    await api.post(url, json={"displayName": "Later"})
    newest_first = (await api.get(url, params={"orderBy": "updateTime desc"})).json()["savedSearches"]
    assert [s["displayName"] for s in newest_first] == ["Later", "Edited"]

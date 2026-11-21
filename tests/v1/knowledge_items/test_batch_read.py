"""Batch read by name: the ``name`` filter of ListItems and SearchItems.

Unlike ``parentItem``/``ancestors``, naming an item the caller cannot read is not
PERMISSION_DENIED: the item is simply absent, as GetItem would deny it.
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from knowledge_support import item_name, ws_url

pytestmark = pytest.mark.asyncio

VIEWER = "roles/collectionViewer"


def any_of(names: list[str]) -> str:
    return " OR ".join(f'name = "{name}"' for name in names)


def listed(response: Any) -> set[str]:
    assert response.status_code == 200, response.text
    return {item["name"] for item in response.json().get("items", [])}


async def test_name_filter_returns_only_readable_items(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    viewer = await world.add_member(ws)
    readable = await world.make_collection(ws, item_name="Readable", grants={viewer: VIEWER})
    published = await world.make_document(readable, item_name="Published")
    draft = await world.make_document(readable, published=False, item_name="Draft")
    hidden = await world.make_collection(ws, item_name="Hidden")
    hidden_doc = await world.make_document(hidden, item_name="Secret")
    other = await world.make_document(readable, item_name="Not asked for")
    names = [item_name(i) for i in (readable, published, draft, hidden, hidden_doc)]
    missing = f"workspaces/{ws.id}/items/{uuid4()}"
    api = await client.as_(viewer)

    as_viewer = listed(
        await api.get(f"{ws_url(ws)}/items", params={"filter": any_of([*names, missing])})
    )
    as_admin = listed(
        await (await client.as_(admin)).get(
            f"{ws_url(ws)}/items", params={"filter": any_of(names), "view": "FULL"}
        )
    )
    searched = await api.post(
        f"{ws_url(ws)}/items:search", json={"filter": any_of(names), "pageSize": 10}
    )

    assert as_viewer == {item_name(readable), item_name(published)}
    assert item_name(other) not in as_viewer
    assert as_admin == set(names)
    assert searched.status_code == 200, searched.text
    assert [r["item"]["name"] for r in searched.json()["results"]] == [item_name(published)]


async def test_name_filter_respects_workspace_isolation(client, world):
    admin = await world.make_user()
    ws = await world.make_workspace(admin)
    elsewhere = await world.make_workspace(admin)
    root = await world.make_collection(ws)
    foreign_root = await world.make_collection(elsewhere)
    foreign = await world.make_document(foreign_root)
    api = await client.as_(admin)

    # Another workspace's item, named under this workspace: no such item here.
    disguised = listed(
        await api.get(
            f"{ws_url(ws)}/items",
            params={"filter": any_of([item_name(root), f"workspaces/{ws.id}/items/{foreign.id}"])},
        )
    )
    # Another workspace's name outright is not an item name of this workspace.
    rejected = await api.get(f"{ws_url(ws)}/items", params={"filter": any_of([item_name(foreign)])})

    assert disguised == {item_name(root)}
    assert rejected.status_code == 400, rejected.text
    assert rejected.json()["error"]["status"] == "INVALID_ARGUMENT"

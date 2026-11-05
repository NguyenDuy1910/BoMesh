"""Reading lists: audiences, the FEATURED list, soft delete, copy and entries."""

from __future__ import annotations

from typing import Any

import pytest

from bomesh.db.models import Item
from curation_support import Scene, item_name

pytestmark = pytest.mark.asyncio


async def _create(scene: Scene, user: Any, list_id: str | None = None, **body: Any) -> Any:
    api = await scene.as_(user)
    params = {"readingListId": list_id} if list_id else {}
    return await api.post(scene.url("readingLists"), params=params, json={"displayName": "List", **body})


async def _entry(scene: Scene, user: Any, list_id: str, item: Item, **body: Any) -> Any:
    api = await scene.as_(user)
    return await api.post(
        scene.url(f"readingLists/{list_id}/entries"), json={"item": item_name(item), **body}
    )


async def test_audiences_need_the_right_grants(scene: Scene) -> None:
    private = await _create(scene, scene.member, "mine")
    assert private.status_code == 200
    body = private.json()
    assert (body["audience"], body["type"], body["owner"]) == (
        "PRIVATE",
        "STANDARD",
        f"workspaces/{scene.ws.id}/members/{scene.member.id}",
    )
    assert (await _create(scene, scene.member, audience="WORKSPACE")).status_code == 403
    assert (await _create(scene, scene.admin, "team", audience="WORKSPACE")).status_code == 200
    assert (await _create(scene, scene.member, "featured")).status_code == 403
    featured = await _create(scene, scene.admin, "featured")
    assert (featured.json()["type"], featured.json()["audience"]) == ("FEATURED", "WORKSPACE")
    assert (await _create(scene, scene.member, "mine")).status_code == 409
    no_space = await _create(scene, scene.member, audience="SPACE")
    assert no_space.json()["error"]["status"] == "INVALID_ARGUMENT"
    bad_id = await _create(scene, scene.member, "Bad_ID")
    assert bad_id.status_code == 400


async def test_space_lists_are_for_space_members(scene: Scene) -> None:
    space = await scene.world.make_space(scene.ws, scene.reviewer)
    await scene.world.grant(scene.outsider, "roles/spaceMember", on=space)
    space_name = f"workspaces/{scene.ws.id}/spaces/{space.code}"
    denied = await _create(scene, scene.member, audience="SPACE", space=space_name)
    assert denied.status_code == 403
    created = await _create(scene, scene.reviewer, "space-list", audience="SPACE", space=space_name)
    assert created.status_code == 200, created.text
    assert created.json()["space"] == space_name
    filtered = await (await scene.as_(scene.reviewer)).get(
        scene.url("readingLists"), params={"filter": f'space = "{space_name}"'}
    )
    assert [r["name"] for r in filtered.json()["readingLists"]] == [created.json()["name"]]
    missing = await _create(
        scene, scene.reviewer, audience="SPACE", space=f"workspaces/{scene.ws.id}/spaces/nope"
    )
    assert missing.status_code == 400

    outsider = await scene.as_(scene.outsider)
    member = await scene.as_(scene.member)
    assert (await outsider.get(scene.url("readingLists/space-list"))).status_code == 200
    assert (await member.get(scene.url("readingLists/space-list"))).status_code == 403
    listed = (await member.get(scene.url("readingLists"))).json()
    assert listed.get("readingLists", []) == []
    assert (await outsider.patch(scene.url("readingLists/space-list"), json={"description": "x"})).status_code == 403


async def test_get_list_filter_order_and_visibility(scene: Scene) -> None:
    await _create(scene, scene.member, "b-mine", displayName="B")
    await _create(scene, scene.admin, "a-team", displayName="A", audience="WORKSPACE")
    await _create(scene, scene.outsider, "c-other", displayName="C")
    member = await scene.as_(scene.member)

    assert (await member.get(scene.url("readingLists/c-other"))).status_code == 403
    assert (await member.get(scene.url("readingLists/nope"))).status_code == 404
    listed = (await member.get(scene.url("readingLists"))).json()
    assert [r["displayName"] for r in listed["readingLists"]] == ["A", "B"]
    assert listed["totalSize"] == 2
    desc = (await member.get(scene.url("readingLists"), params={"orderBy": "displayName desc", "pageSize": 1})).json()
    assert [r["displayName"] for r in desc["readingLists"]] == ["B"] and desc["nextPageToken"]
    shared = (await member.get(scene.url("readingLists"), params={"filter": "audience = WORKSPACE"})).json()
    assert [r["displayName"] for r in shared["readingLists"]] == ["A"]
    me = f'owner = "workspaces/{scene.ws.id}/members/me"'
    assert [r["displayName"] for r in (await member.get(scene.url("readingLists"), params={"filter": me})).json()["readingLists"]] == ["B"]


async def test_update_delete_undelete(scene: Scene) -> None:
    created = (await _create(scene, scene.member, "notes")).json()
    member = await scene.as_(scene.member)
    outsider = await scene.as_(scene.outsider)

    updated = await member.patch(
        scene.url("readingLists/notes"),
        params={"updateMask": "displayName,description"},
        json={"displayName": "Notes", "description": "Mine", "etag": created["etag"]},
    )
    assert (updated.json()["displayName"], updated.json()["description"]) == ("Notes", "Mine")
    stale = await member.patch(scene.url("readingLists/notes"), json={"description": "x", "etag": created["etag"]})
    assert stale.status_code == 409
    widen = await member.patch(scene.url("readingLists/notes"), json={"audience": "WORKSPACE"})
    assert widen.status_code == 403
    assert (await outsider.patch(scene.url("readingLists/notes"), json={"description": "x"})).status_code == 403

    deleted = await member.delete(scene.url("readingLists/notes"))
    assert (deleted.json()["state"], "purgeTime" in deleted.json()) == ("DELETED", True)
    assert (await member.get(scene.url("readingLists/notes"))).json()["state"] == "DELETED"
    assert (await member.get(scene.url("readingLists"))).json().get("readingLists", []) == []
    with_deleted = (await member.get(scene.url("readingLists"), params={"showDeleted": "true"})).json()
    assert len(with_deleted["readingLists"]) == 1
    restored = await member.post(scene.url("readingLists/notes:undelete"), json={})
    assert restored.json()["state"] == "ACTIVE"
    assert (await member.post(scene.url("readingLists/notes:undelete"), json={})).status_code == 409

    await _create(scene, scene.admin, "featured")
    admin = await scene.as_(scene.admin)
    featured = await admin.delete(scene.url("readingLists/featured"))
    assert featured.json()["error"]["status"] == "FAILED_PRECONDITION"


async def test_entries_hide_unreadable_items_and_keep_order(scene: Scene) -> None:
    await _create(scene, scene.admin, "team", audience="WORKSPACE")
    secret = await scene.world.make_collection(scene.ws)
    first = await scene.world.make_document(scene.kb, title="First")
    second = await scene.world.make_document(scene.kb, title="Second")
    hidden = await scene.world.make_document(secret, title="Hidden")
    for item in (first, second, hidden):
        assert (await _entry(scene, scene.admin, "team", item, note=item.title)).status_code == 200
    duplicate = await _entry(scene, scene.admin, "team", first)
    assert duplicate.status_code == 409
    member = await scene.as_(scene.member)
    unreadable = await _entry(scene, scene.member, "team", hidden)
    assert unreadable.status_code == 403

    page = (await member.get(scene.url("readingLists/team/entries"))).json()
    assert [e["item"] for e in page["entries"]] == [item_name(first), item_name(second)]
    assert [e["position"] for e in page["entries"]] == [0, 1]
    assert page["hiddenItemCount"] == 1
    got = (await member.get(scene.url("readingLists/team"))).json()
    assert (got["itemCount"], got["hiddenItemCount"]) == (2, 1)
    assert (await member.get(scene.url(f"readingLists/team/entries/{hidden.id}"))).status_code == 404
    paged = (await member.get(scene.url("readingLists/team/entries"), params={"pageSize": 1})).json()
    assert len(paged["entries"]) == 1 and paged["nextPageToken"]

    admin = await scene.as_(scene.admin)
    moved = await admin.patch(
        scene.url(f"readingLists/team/entries/{second.id}"), json={"position": 0, "note": "Top"}
    )
    assert (moved.json()["position"], moved.json()["note"]) == (0, "Top")
    order = (await admin.get(scene.url("readingLists/team/entries"))).json()["entries"]
    assert [e["item"] for e in order] == [item_name(second), item_name(first), item_name(hidden)]
    assert (await member.patch(scene.url(f"readingLists/team/entries/{first.id}"), json={"note": "x"})).status_code == 403

    removed = await admin.delete(scene.url(f"readingLists/team/entries/{second.id}"))
    assert removed.status_code == 200
    order = (await admin.get(scene.url("readingLists/team/entries"))).json()["entries"]
    assert [(e["item"], e["position"]) for e in order] == [(item_name(first), 0), (item_name(hidden), 1)]


async def test_entry_rejects_mismatched_id_and_resolves_merges(scene: Scene) -> None:
    await _create(scene, scene.member, "mine")
    duplicate = await scene.world.make_document(scene.kb)
    target = await scene.world.make_document(scene.kb)
    member = await scene.as_(scene.member)
    mismatch = await member.post(
        scene.url("readingLists/mine/entries"),
        params={"entryId": str(target.id)},
        json={"item": item_name(duplicate)},
    )
    assert mismatch.status_code == 400
    assert (await _entry(scene, scene.member, "mine", duplicate)).status_code == 200

    await scene.world.delete(duplicate)
    await scene.set_metadata(duplicate, merged_into=str(target.id))
    entry = (await member.get(scene.url(f"readingLists/mine/entries/{duplicate.id}"))).json()
    assert entry["item"] == item_name(target)
    assert entry["name"].endswith(f"/entries/{duplicate.id}")


async def test_copy_keeps_only_readable_entries(scene: Scene) -> None:
    await _create(scene, scene.admin, "team", audience="WORKSPACE", displayName="Team")
    secret = await scene.world.make_collection(scene.ws)
    visible = await scene.world.make_document(scene.kb)
    hidden = await scene.world.make_document(secret)
    await _entry(scene, scene.admin, "team", visible)
    await _entry(scene, scene.admin, "team", hidden)
    member = await scene.as_(scene.member)

    copy = await member.post(scene.url("readingLists/team:copy"), json={"readingListId": "my-copy"})
    assert copy.status_code == 200, copy.text
    body = copy.json()
    assert (body["audience"], body["type"], body["displayName"], body["itemCount"], body["hiddenItemCount"]) == (
        "PRIVATE",
        "STANDARD",
        "Team",
        1,
        0,
    )
    assert body["owner"].endswith(str(scene.member.id))
    taken = await member.post(scene.url("readingLists/team:copy"), json={"readingListId": "my-copy"})
    assert taken.status_code == 409
    await _create(scene, scene.outsider, "private")
    assert (await member.post(scene.url("readingLists/private:copy"), json={})).status_code == 403

"""Space members, materials, announcements and events."""

from __future__ import annotations

import pytest

from collab_support import item_name, member_name, reason, space_path
from harness import ApiClient, World

pytestmark = pytest.mark.asyncio


async def test_space_members(client: ApiClient, world: World) -> None:
    owner = await world.make_user(display_name="Ann")
    workspace = await world.make_workspace(owner)
    member = await world.add_member(
        workspace, await world.make_user(display_name="Bob")
    )
    outsider = await world.make_user()
    await world.make_space(workspace, owner, code="team")
    lead = await client.as_(owner)
    path = f"{space_path(workspace, 'team')}/members"

    created = await lead.post(path, json={"member": member_name(workspace, member)})
    assert created.status_code == 200, created.text
    assert created.json()["name"] == f"{path.removeprefix('/api/v1/')}/{member.id}"
    assert created.json()["roles"] == ["roles/spaceMember"]
    assert (
        await lead.post(path, json={"member": member_name(workspace, member)})
    ).status_code == 409
    stranger = await lead.post(
        path, json={"member": f"workspaces/{workspace.id}/members/{outsider.id}"}
    )
    assert reason(stranger) == "NOT_WORKSPACE_MEMBER"

    reader = await client.as_(member)
    assert (
        await reader.post(path, json={"member": member_name(workspace, owner)})
    ).status_code == 403
    by_name = await reader.get(path, params={"orderBy": "displayName"})
    assert [m["displayName"] for m in by_name.json()["members"]] == ["Ann", "Bob"]
    leads = await reader.get(path, params={"filter": 'roles:"roles/spaceLead"'})
    assert [m["displayName"] for m in leads.json()["members"]] == ["Ann"]
    assert (await reader.get(f"{path}/{member.id}")).json()["displayName"] == "Bob"

    last = await lead.delete(f"{path}/{owner.id}")
    assert reason(last) == "LAST_SPACE_LEAD"
    assert (await lead.delete(f"{path}/{member.id}")).status_code == 200
    assert (await lead.get(f"{path}/{member.id}")).status_code == 404
    # A non-member of the space cannot list its members.
    assert (await reader.get(path)).status_code == 403


async def test_materials_rechecked_on_read(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    space = await world.make_space(workspace, owner, code="team")
    await world.grant(member, "roles/spaceMember", on=space)
    open_collection = await world.make_collection(
        workspace, grants={member: "roles/collectionViewer"}
    )
    secret = await world.make_collection(workspace)
    public_doc = await world.make_document(open_collection, published=True)
    secret_doc = await world.make_document(secret, published=True)
    lead = await client.as_(owner)
    path = f"{space_path(workspace, 'team')}/materials"

    first = await lead.post(
        path, json={"item": item_name(workspace, public_doc), "note": "Read"}
    )
    assert first.status_code == 200, first.text
    assert first.json()["addedBy"] == member_name(workspace, owner)
    hidden = await lead.post(path, json={"item": item_name(workspace, secret_doc)})
    assert hidden.status_code == 200
    assert (
        await lead.post(path, json={"item": item_name(workspace, public_doc)})
    ).status_code == 409

    reader = await client.as_(member)
    listed = await reader.get(path)
    assert [m["item"] for m in listed.json()["materials"]] == [
        item_name(workspace, public_doc)
    ]
    assert (await reader.get(path_of(hidden.json()["name"]))).status_code == 404
    pin_secret = await reader.post(
        path, json={"item": item_name(workspace, secret_doc)}
    )
    assert pin_secret.status_code == 403  # members cannot pin, and cannot see it

    assert (await lead.delete(path_of(first.json()["name"]))).status_code == 200
    assert (await lead.get(path_of(first.json()["name"]))).status_code == 404


def path_of(name: str) -> str:
    return f"/api/v1/{name}"


async def test_announcements(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    space = await world.make_space(workspace, owner, code="team")
    await world.grant(member, "roles/spaceMember", on=space)
    lead = await client.as_(owner)
    path = f"{space_path(workspace, 'team')}/announcements"

    pinned = (await lead.post(path, json={"title": "Pinned", "pinned": True})).json()
    later = await lead.post(path, json={"title": "Later", "body": "News"})
    assert later.status_code == 200
    assert (await lead.post(path, json={"title": ""})).status_code == 400

    reader = await client.as_(member)
    listed = await reader.get(path)
    assert [a["title"] for a in listed.json()["announcements"]] == ["Pinned", "Later"]
    only_pinned = await reader.get(path, params={"filter": "pinned = true"})
    assert [a["title"] for a in only_pinned.json()["announcements"]] == ["Pinned"]
    assert (await reader.post(path, json={"title": "Nope"})).status_code == 403

    item = path_of(pinned["name"])
    updated = await lead.patch(item, json={"pinned": False, "etag": pinned["etag"]})
    assert updated.json()["pinned"] is False
    stale = await lead.patch(item, json={"title": "X", "etag": pinned["etag"]})
    assert stale.status_code == 409
    assert (await lead.delete(item, params={"etag": pinned["etag"]})).status_code == 409
    assert (await lead.delete(item)).status_code == 200
    assert (await lead.get(item)).status_code == 404


async def test_events(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await world.make_space(workspace, owner, code="team")
    lead = await client.as_(owner)
    path = f"{space_path(workspace, 'team')}/events"

    late = await lead.post(
        path, json={"title": "Late", "startTime": "2026-12-01T10:00:00Z"}
    )
    early = await lead.post(
        path,
        json={
            "title": "Early",
            "startTime": "2026-11-10T10:00:00Z",
            "endTime": "2026-11-10T11:00:00Z",
            "location": "Room 1",
        },
    )
    assert late.status_code == early.status_code == 200
    backwards = await lead.post(
        path,
        json={
            "title": "Bad",
            "startTime": "2026-11-10T10:00:00Z",
            "endTime": "2026-11-09T10:00:00Z",
        },
    )
    assert backwards.status_code == 400
    assert (await lead.post(path, json={"title": "No start"})).status_code == 400

    listed = await lead.get(path)
    assert [e["title"] for e in listed.json()["events"]] == ["Early", "Late"]
    december = await lead.get(
        path, params={"filter": 'startTime >= "2026-12-01T00:00:00Z"'}
    )
    assert [e["title"] for e in december.json()["events"]] == ["Late"]

    item = path_of(early.json()["name"])
    moved = await lead.patch(
        item, params={"updateMask": "location"}, json={"location": "Room 2"}
    )
    assert moved.json()["location"] == "Room 2"
    invalid = await lead.patch(item, json={"endTime": "2026-11-01T00:00:00Z"})
    assert invalid.status_code == 400
    assert (await lead.delete(item)).status_code == 200

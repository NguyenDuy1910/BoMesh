"""Spaces: CRUD with soft delete, join/leave, IAM and the spaces module."""

from __future__ import annotations

import pytest

from collab_support import member_name, reason, set_settings, space_path, ws_path
from harness import ApiClient, World

pytestmark = pytest.mark.asyncio


async def test_space_crud_and_undelete(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await set_settings(
        sessions,
        workspace,
        space_types=[{"key": "team", "display_name": "Team", "enabled": True}],
    )
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    created = await api.post(
        f"{ws_path(workspace)}/spaces",
        params={"spaceId": "finance"},
        json={"displayName": "Finance", "spaceType": "team", "joinPolicy": "OPEN"},
    )
    assert created.status_code == 200, created.text
    space = created.json()
    assert space["name"] == f"workspaces/{workspace.id}/spaces/finance"
    assert space["callerRole"] == "roles/spaceLead"
    assert space["memberCount"] == 1
    assert space["state"] == "ACTIVE"

    taken = await api.post(
        f"{ws_path(workspace)}/spaces",
        params={"spaceId": "finance"},
        json={"displayName": "X"},
    )
    assert taken.status_code == 409
    bad_type = await api.post(
        f"{ws_path(workspace)}/spaces", json={"displayName": "X", "spaceType": "nope"}
    )
    assert bad_type.status_code == 400
    dry = await api.post(
        f"{ws_path(workspace)}/spaces",
        params={"spaceId": "dry", "validateOnly": "true"},
        json={"displayName": "Dry"},
    )
    assert dry.status_code == 200
    assert (await api.get(space_path(workspace, "dry"))).status_code == 404

    reader = await client.as_(member)
    got = await reader.get(space_path(workspace, "finance"))
    assert got.json()["callerRole"] == ""
    assert (
        await reader.patch(
            space_path(workspace, "finance"), json={"displayName": "Mine"}
        )
    ).status_code == 403

    updated = await api.patch(
        space_path(workspace, "finance"),
        params={"updateMask": "description"},
        json={"description": "Money", "etag": space["etag"]},
    )
    assert updated.json()["description"] == "Money"
    stale = await api.patch(
        space_path(workspace, "finance"),
        json={"displayName": "Z", "etag": space["etag"]},
    )
    assert stale.status_code == 409

    deleted = await api.delete(space_path(workspace, "finance"))
    assert deleted.json()["state"] == "DELETED"
    assert deleted.json()["purgeTime"]
    assert (await api.get(space_path(workspace, "finance"))).json()[
        "state"
    ] == "DELETED"
    listed = await api.get(f"{ws_path(workspace)}/spaces")
    assert listed.json()["spaces"] == []
    shown = await api.get(
        f"{ws_path(workspace)}/spaces", params={"showDeleted": "true"}
    )
    assert [s["name"] for s in shown.json()["spaces"]] == [space["name"]]
    assert (
        await api.get(f"{space_path(workspace, 'finance')}/members")
    ).status_code == 404

    restored = await api.post(f"{space_path(workspace, 'finance')}:undelete", json={})
    assert restored.json()["state"] == "ACTIVE"
    again = await api.post(f"{space_path(workspace, 'finance')}:undelete", json={})
    assert again.status_code == 409


async def test_list_spaces_filter_and_order(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    await world.make_space(workspace, owner, code="alpha", join_policy="open")
    beta = await world.make_space(workspace, owner, code="beta")
    await world.grant(member, "roles/spaceMember", on=beta)
    api = await client.as_(member)

    everything = await api.get(
        f"{ws_path(workspace)}/spaces", params={"orderBy": "memberCount desc"}
    )
    assert [s["name"].rsplit("/", 1)[1] for s in everything.json()["spaces"]] == [
        "beta",
        "alpha",
    ]
    mine = await api.get(
        f"{ws_path(workspace)}/spaces",
        params={"filter": 'callerRole = "roles/spaceMember"'},
    )
    assert [s["name"].rsplit("/", 1)[1] for s in mine.json()["spaces"]] == ["beta"]
    open_ = await api.get(
        f"{ws_path(workspace)}/spaces", params={"filter": "joinPolicy = OPEN"}
    )
    assert [s["name"].rsplit("/", 1)[1] for s in open_.json()["spaces"]] == ["alpha"]
    paged = await api.get(f"{ws_path(workspace)}/spaces", params={"pageSize": 1})
    assert len(paged.json()["spaces"]) == 1 and paged.json()["nextPageToken"]
    bad = await api.get(f"{ws_path(workspace)}/spaces", params={"filter": "nope = 1"})
    assert bad.status_code == 400


async def test_non_member_is_denied_and_missing_space(
    client: ApiClient, world: World
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    outsider = await world.make_user()
    await world.make_space(workspace, owner, code="team")
    stranger = await client.as_(outsider)
    assert (await stranger.get(space_path(workspace, "team"))).status_code == 403
    assert (await stranger.get(space_path(workspace, "ghost"))).status_code == 403
    api = await client.as_(owner)
    assert (await api.get(space_path(workspace, "ghost"))).status_code == 404


async def test_join_and_leave(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    await world.make_space(workspace, owner, code="open", join_policy="open")
    await world.make_space(workspace, owner, code="closed", join_policy="request")
    api = await client.as_(member)

    joined = await api.post(f"{space_path(workspace, 'open')}:join", json={})
    assert joined.status_code == 200, joined.text
    assert joined.json()["roles"] == ["roles/spaceMember"]
    assert joined.json()["member"] == member_name(workspace, member)
    assert (
        await api.post(f"{space_path(workspace, 'open')}:join", json={})
    ).status_code == 409
    not_open = await api.post(f"{space_path(workspace, 'closed')}:join", json={})
    assert reason(not_open) == "SPACE_NOT_OPEN"

    assert (
        await api.post(f"{space_path(workspace, 'open')}:leave", json={})
    ).status_code == 200
    again = await api.post(f"{space_path(workspace, 'open')}:leave", json={})
    assert reason(again) == "NOT_SPACE_MEMBER"

    lead = await client.as_(owner)
    last = await lead.post(f"{space_path(workspace, 'open')}:leave", json={})
    assert reason(last) == "LAST_SPACE_LEAD"


async def test_space_iam(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    outsider = await world.make_user()
    await world.make_space(workspace, owner, code="team")
    api = await client.as_(owner)
    path = space_path(workspace, "team")

    policy = (await api.post(f"{path}:getIamPolicy", json={})).json()
    assert policy["bindings"] == [
        {"role": "roles/spaceLead", "members": [f"user:{owner.id}"]}
    ]
    updated = await api.post(
        f"{path}:setIamPolicy",
        json={
            "policy": {
                "bindings": [
                    *policy["bindings"],
                    {"role": "roles/spaceStaff", "members": [f"user:{member.id}"]},
                ],
                "etag": policy["etag"],
            }
        },
    )
    assert updated.status_code == 200, updated.text
    stale = await api.post(
        f"{path}:setIamPolicy",
        json={"policy": {"bindings": [], "etag": policy["etag"]}},
    )
    assert stale.status_code == 409
    no_lead = await api.post(
        f"{path}:setIamPolicy",
        json={
            "policy": {
                "bindings": [
                    {"role": "roles/spaceStaff", "members": [f"user:{member.id}"]}
                ]
            }
        },
    )
    assert reason(no_lead) == "LAST_SPACE_LEAD"
    group = await api.post(
        f"{path}:setIamPolicy",
        json={
            "policy": {
                "bindings": [
                    {"role": "roles/spaceMember", "members": ["workspaceMembers"]}
                ]
            }
        },
    )
    assert group.status_code == 400
    stranger = await api.post(
        f"{path}:setIamPolicy",
        json={
            "policy": {
                "bindings": [
                    *policy["bindings"],
                    {"role": "roles/spaceMember", "members": [f"user:{outsider.id}"]},
                ]
            }
        },
    )
    assert reason(stranger) == "NOT_WORKSPACE_MEMBER"

    staff = await client.as_(member)
    assert (await staff.post(f"{path}:getIamPolicy", json={})).status_code == 403
    tested = await staff.post(
        f"{path}:testIamPermissions",
        json={"permissions": ["announcements.create", "spaces.update"]},
    )
    assert tested.json()["permissions"] == ["announcements.create"]


async def test_spaces_module_disabled(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await world.make_space(workspace, owner, code="team")
    await set_settings(sessions, workspace, modules={"spaces": False})
    api = await client.as_(owner)
    for response in (
        await api.get(f"{ws_path(workspace)}/spaces"),
        await api.get(space_path(workspace, "team")),
        await api.post(f"{ws_path(workspace)}/spaces", json={"displayName": "X"}),
    ):
        assert response.status_code == 400
        assert reason(response) == "MODULE_DISABLED"

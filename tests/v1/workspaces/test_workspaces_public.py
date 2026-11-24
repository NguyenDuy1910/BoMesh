"""Public workspaces: visibility, the public listing, JoinWorkspace and LeaveWorkspace."""

from __future__ import annotations

from uuid import uuid4

import pytest

from harness import ApiClient, World
from workspaces_support import (
    audit_actions,
    member_path,
    reason,
    set_status,
    set_visibility,
    status,
    ws_path,
)

pytestmark = pytest.mark.asyncio

PUBLIC = {"filter": "visibility = PUBLIC"}


def _uids(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [workspace["uid"] for workspace in response.json()["workspaces"]]


# -- Visibility -----------------------------------------------------------------


async def test_update_visibility_round_trips_and_needs_update_permission(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    owner_api = await client.as_(owner)

    assert (await owner_api.get(ws_path(workspace))).json()["visibility"] == "PRIVATE"

    made_public = await owner_api.patch(
        ws_path(workspace), params={"updateMask": "visibility"}, json={"visibility": "PUBLIC"}
    )
    assert made_public.status_code == 200, made_public.text
    assert made_public.json()["visibility"] == "PUBLIC"
    assert (await owner_api.get(ws_path(workspace))).json()["visibility"] == "PUBLIC"
    assert "UpdateWorkspace" in await audit_actions(sessions, workspace)

    denied = await (await client.as_(member)).patch(
        ws_path(workspace), params={"updateMask": "visibility"}, json={"visibility": "PRIVATE"}
    )
    assert denied.status_code == 403

    bogus = await owner_api.patch(
        ws_path(workspace), params={"updateMask": "visibility"}, json={"visibility": "OPEN"}
    )
    assert bogus.status_code == 400

    cleared = await owner_api.patch(
        ws_path(workspace), params={"updateMask": "visibility"}, json={}
    )
    assert cleared.status_code == 400

    # Making it private stops new joins and keeps every member.
    made_private = await owner_api.patch(
        ws_path(workspace), params={"updateMask": "visibility"}, json={"visibility": "PRIVATE"}
    )
    assert made_private.status_code == 200
    assert made_private.json()["visibility"] == "PRIVATE"
    assert made_private.json()["memberCount"] == 2
    joined = await (await client.as_(await world.make_user())).post(
        f"{ws_path(workspace)}:join", json={}
    )
    assert joined.status_code == 404


# -- Public listing -------------------------------------------------------------


async def test_public_listing_for_non_members(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    first = await world.make_workspace(owner, code="pub-a-" + uuid4().hex[:6], name="Alpha")
    second = await world.make_workspace(owner, code="pub-b-" + uuid4().hex[:6], name="Beta")
    private = await world.make_workspace(owner, name="Private")
    suspended = await world.make_workspace(owner, name="Suspended")
    archived = await world.make_workspace(owner, name="Archived")
    for workspace in (first, second, suspended, archived):
        await set_visibility(sessions, workspace, "public")
    await set_status(sessions, suspended, "suspended")
    await set_status(sessions, archived, "archived")
    api = await client.as_(await world.make_user())

    listed = await api.get("/api/v1/workspaces", params=PUBLIC)
    assert _uids(listed) == [str(first.id), str(second.id)]
    assert {w["visibility"] for w in listed.json()["workspaces"]} == {"PUBLIC"}

    by_code = await api.get(
        "/api/v1/workspaces",
        params={"filter": f'visibility = PUBLIC AND code = "{second.code}"'},
    )
    assert _uids(by_code) == [str(second.id)]
    private_code = await api.get(
        "/api/v1/workspaces",
        params={"filter": f'visibility = PUBLIC AND code = "{private.code}"'},
    )
    assert _uids(private_code) == []

    page = await api.get("/api/v1/workspaces", params={**PUBLIC, "pageSize": 1})
    assert _uids(page) == [str(first.id)]
    rest = await api.get(
        "/api/v1/workspaces",
        params={**PUBLIC, "pageSize": 1, "pageToken": page.json()["nextPageToken"]},
    )
    assert _uids(rest) == [str(second.id)]
    assert "nextPageToken" not in rest.json()

    # Without a top-level `visibility = PUBLIC` the caller's own scoping applies.
    assert _uids(await api.get("/api/v1/workspaces")) == []
    for loose in ("visibility = PUBLIC OR state = ACTIVE", "NOT visibility = PRIVATE"):
        assert _uids(await api.get("/api/v1/workspaces", params={"filter": loose})) == []


async def test_non_member_cannot_read_a_public_workspace_before_joining(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await set_visibility(sessions, workspace, "public")
    api = await client.as_(await world.make_user())

    assert (await api.get(ws_path(workspace))).status_code == 403
    assert (await api.get(f"{ws_path(workspace)}/members")).status_code == 403


# -- JoinWorkspace --------------------------------------------------------------


async def test_join_makes_a_workspace_member(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await set_visibility(sessions, workspace, "public")
    joiner = await world.make_user(display_name="Joiner")
    api = await client.as_(joiner)

    joined = await api.post(f"{ws_path(workspace)}:join", json={})

    assert joined.status_code == 200, joined.text
    body = joined.json()
    assert body["name"] == f"workspaces/{workspace.id}/members/{joiner.id}"
    assert body["displayName"] == "Joiner"
    assert body["state"] == "ACTIVE"
    assert body["roles"] == ["roles/workspaceMember"]
    assert body["personalCollection"]
    assert "JoinWorkspace" in await audit_actions(sessions, workspace)

    read = await api.get(ws_path(workspace))
    assert read.status_code == 200
    assert read.json()["memberCount"] == 2
    assert (await api.get(member_path(workspace, "me"))).json()["name"] == body["name"]

    again = await api.post(f"{ws_path(workspace)}:join", json={})
    assert again.status_code == 409
    assert status(again) == "ALREADY_EXISTS"


async def test_join_errors(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    private = await world.make_workspace(owner)
    suspended = await world.make_workspace(owner)
    await set_visibility(sessions, suspended, "public")
    await set_status(sessions, suspended, "suspended")
    public = await world.make_workspace(owner)
    await set_visibility(sessions, public, "public")
    held = await world.add_member(public)
    await world.suspend_member(public, held)
    api = await client.as_(await world.make_user())

    for workspace in (private.id, suspended.id, uuid4()):
        missing = await api.post(f"{ws_path(workspace)}:join", json={})
        assert missing.status_code == 404, missing.text

    already = await (await client.as_(owner)).post(f"{ws_path(public)}:join", json={})
    assert already.status_code == 409

    suspended_member = await (await client.as_(held)).post(f"{ws_path(public)}:join", json={})
    assert suspended_member.status_code == 400
    assert reason(suspended_member) == "MEMBER_SUSPENDED"

    extra = await api.post(f"{ws_path(public)}:join", json={"role": "roles/workspaceAdmin"})
    assert extra.status_code == 400


# -- LeaveWorkspace -------------------------------------------------------------


async def test_leave_ends_access_and_a_left_member_rejoins(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await set_visibility(sessions, workspace, "public")
    member = await world.add_member(workspace, role="roles/workspaceAdmin")
    api = await client.as_(member)

    left = await api.post(f"{ws_path(workspace)}:leave", json={})
    assert left.status_code == 200, left.text
    assert left.json() == {}
    assert "LeaveWorkspace" in await audit_actions(sessions, workspace)

    after = await client.as_(member)
    assert (await after.get(ws_path(workspace))).status_code == 403
    assert _uids(await after.get("/api/v1/workspaces")) == []
    again = await after.post(f"{ws_path(workspace)}:leave", json={})
    assert again.status_code == 403

    rejoined = await after.post(f"{ws_path(workspace)}:join", json={})
    assert rejoined.status_code == 200, rejoined.text
    # Readmitted as a plain member: yesterday's admin role does not come back.
    assert rejoined.json()["roles"] == ["roles/workspaceMember"]
    assert (await (await client.as_(member)).get(ws_path(workspace))).status_code == 200


async def test_leave_non_member_and_last_admin(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    outsider = await client.as_(await world.make_user())

    assert (await outsider.post(f"{ws_path(workspace)}:leave", json={})).status_code == 403
    assert (await outsider.post(f"{ws_path(uuid4())}:leave", json={})).status_code == 403

    owner_api = await client.as_(owner)
    last_admin = await owner_api.post(f"{ws_path(workspace)}:leave", json={})
    assert last_admin.status_code == 400
    assert reason(last_admin) == "LAST_ADMIN"
    assert (await owner_api.get(ws_path(workspace))).status_code == 200

"""Members: create with roles, get (``me``), list, delete, suspend and activate."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import select

from bomesh.services.knowledge_items.item_store import personal_collection_id
from bomesh.services.workspaces.members import active_member_ids, member_records
from bomesh.db.models import GroupMembership, Item, RoleAssignment, TenantMembership
from harness import ApiClient, World
from workspaces_support import audit_actions, member_path, reason, ws_path

pytestmark = pytest.mark.asyncio


async def test_create_member_grants_roles_and_personal_collection(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    newcomer = await world.make_user(display_name="New Person")
    api = await client.as_(owner)

    response = await api.post(
        f"{ws_path(workspace)}/members",
        json={"user": f"users/{newcomer.id}", "roles": ["roles/workspaceMember"]},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == f"workspaces/{workspace.id}/members/{newcomer.id}"
    assert body["displayName"] == "New Person"
    assert body["state"] == "ACTIVE"
    assert body["roles"] == ["roles/workspaceMember"]
    assert "personalCollection" not in body
    async with sessions.begin() as session:
        personal = await session.get(Item, personal_collection_id(workspace.id, newcomer.id))
        assert personal is not None and personal.metadata_["system_kind"] == "personal_uploads"
    assert "CreateMember" in await audit_actions(sessions, workspace)

    me = (await (await client.as_(newcomer)).get(member_path(workspace, "me"))).json()
    assert me["name"] == body["name"]
    assert me["personalCollection"] == (
        f"workspaces/{workspace.id}/items/{personal_collection_id(workspace.id, newcomer.id)}"
    )


async def test_create_member_defaults_validate_only_and_errors(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    dry = await world.make_user()
    preview = await api.post(
        f"{ws_path(workspace)}/members", params={"validateOnly": "true"}, json={"user": f"users/{dry.id}"}
    )
    assert preview.status_code == 200
    assert preview.json()["roles"] == ["roles/workspaceMember"]
    async with sessions.begin() as session:
        assert await session.get(TenantMembership, {"user_id": dry.id, "tenant_id": workspace.id}) is None

    duplicate = await api.post(f"{ws_path(workspace)}/members", json={"user": f"users/{member.id}"})
    assert duplicate.status_code == 409

    unknown = await api.post(f"{ws_path(workspace)}/members", json={"user": f"users/{uuid4()}"})
    assert unknown.status_code == 404

    bad_role = await api.post(
        f"{ws_path(workspace)}/members",
        json={"user": f"users/{dry.id}", "roles": ["roles/collectionViewer"]},
    )
    assert bad_role.status_code == 400

    malformed = await api.post(f"{ws_path(workspace)}/members", json={"user": "bob"})
    assert malformed.status_code == 400

    denied = await (await client.as_(member)).post(
        f"{ws_path(workspace)}/members", json={"user": f"users/{dry.id}"}
    )
    assert denied.status_code == 403


async def test_create_member_role_escalation(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    inviter_role = await world.make_role(workspace, "inviter", ["members.create", "members.get"])
    inviter = await world.add_member(workspace, role=inviter_role)
    api = await client.as_(inviter)
    target = await world.make_user()

    escalation = await api.post(
        f"{ws_path(workspace)}/members",
        json={"user": f"users/{target.id}", "roles": ["roles/workspaceAdmin"]},
    )
    assert escalation.status_code == 403
    assert reason(escalation) == "ROLE_ESCALATION"


async def test_create_member_request_id(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    target = await world.make_user()
    api = await client.as_(owner)
    url = f"{ws_path(workspace)}/members?requestId={uuid4()}"
    first = await api.post(url, json={"user": f"users/{target.id}"})
    second = await api.post(url, json={"user": f"users/{target.id}"})
    assert first.status_code == second.status_code == 200
    assert first.json()["name"] == second.json()["name"]


async def test_readmitted_member_regains_no_old_access(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    former = await world.add_member(workspace, role="roles/workspaceAdmin")
    group = await world.make_group(workspace, [former])
    api = await client.as_(owner)

    assert (await api.delete(member_path(workspace, former))).status_code == 200
    async with sessions.begin() as session:
        grants = await session.scalars(
            select(RoleAssignment).where(
                RoleAssignment.user_id == former.id, RoleAssignment.deleted_at.is_(None)
            )
        )
        live = [grant for grant in grants if grant.item_id is None]
        assert live == []
        row = await session.get(GroupMembership, {"group_id": group.id, "user_id": former.id})
        assert row.deleted_at is not None

    again = await api.post(f"{ws_path(workspace)}/members", json={"user": f"users/{former.id}"})
    assert again.status_code == 200
    assert again.json()["roles"] == ["roles/workspaceMember"]
    assert again.json()["groups"] == []


async def test_get_and_list_members(client: ApiClient, world: World) -> None:
    owner = await world.make_user(display_name="Owner")
    workspace = await world.make_workspace(owner)
    alice = await world.add_member(workspace, await world.make_user(display_name="Alice"))
    bob = await world.add_member(
        workspace, await world.make_user(display_name="Bob"), role="roles/workspaceAdmin"
    )
    group = await world.make_group(workspace, [alice], code="readers")
    await world.grant(group, "roles/workspaceAdmin", on=workspace)
    await world.suspend_member(workspace, bob)
    api = await client.as_(alice)

    alice_record = (await api.get(member_path(workspace, alice))).json()
    assert alice_record["groups"] == [f"workspaces/{workspace.id}/groups/readers"]
    assert alice_record["roles"] == ["roles/workspaceAdmin", "roles/workspaceMember"]
    other = (await api.get(member_path(workspace, owner))).json()
    assert "personalCollection" not in other

    listed = (await api.get(f"{ws_path(workspace)}/members")).json()["members"]
    assert [m["displayName"] for m in listed] == ["Alice", "Bob", "Owner"]

    suspended = await api.get(f"{ws_path(workspace)}/members", params={"filter": "state = SUSPENDED"})
    assert [m["displayName"] for m in suspended.json()["members"]] == ["Bob"]

    admins = await api.get(
        f"{ws_path(workspace)}/members", params={"filter": 'roles:"roles/workspaceAdmin"'}
    )
    assert {m["displayName"] for m in admins.json()["members"]} == {"Alice", "Bob", "Owner"}

    in_group = await api.get(
        f"{ws_path(workspace)}/members",
        params={"filter": f'groups:"workspaces/{workspace.id}/groups/readers"'},
    )
    assert [m["displayName"] for m in in_group.json()["members"]] == ["Alice"]

    page = (await api.get(f"{ws_path(workspace)}/members", params={"pageSize": 2, "orderBy": "displayName desc"})).json()
    assert [m["displayName"] for m in page["members"]] == ["Owner", "Bob"]
    assert page["nextPageToken"]

    missing = await api.get(member_path(workspace, str(uuid4())))
    assert missing.status_code == 404
    outsider = await client.as_(await world.make_user())
    assert (await outsider.get(f"{ws_path(workspace)}/members")).status_code == 403
    assert (await outsider.get(member_path(workspace, str(uuid4())))).status_code == 403


async def test_delete_member_rules(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    self_delete = await api.delete(member_path(workspace, owner))
    assert self_delete.status_code == 400
    assert reason(self_delete) == "SELF_MODIFICATION"

    second_admin = await world.add_member(workspace, role="roles/workspaceAdmin")
    last = await (await client.as_(second_admin)).delete(member_path(workspace, owner))
    assert last.status_code == 200
    only = await (await client.as_(second_admin)).delete(member_path(workspace, second_admin))
    assert reason(only) == "SELF_MODIFICATION"

    denied = await (await client.as_(member)).delete(member_path(workspace, second_admin))
    assert denied.status_code == 403
    gone = await (await client.as_(second_admin)).delete(member_path(workspace, owner))
    assert gone.status_code == 404
    assert "DeleteMember" in await audit_actions(sessions, workspace)


async def test_last_admin_through_group_is_protected(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    manager_role = await world.make_role(
        workspace, "manager", ["members.delete", "members.suspend", "members.get"]
    )
    manager = await world.add_member(workspace, role=manager_role)
    api = await client.as_(manager)

    suspend = await api.post(f"{member_path(workspace, owner)}:suspend", json={})
    assert suspend.status_code == 400
    assert reason(suspend) == "LAST_ADMIN"
    delete = await api.delete(member_path(workspace, owner))
    assert delete.status_code == 400
    assert reason(delete) == "LAST_ADMIN"


async def test_suspend_and_activate_member(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    suspended = await api.post(f"{member_path(workspace, member)}:suspend", json={})
    assert suspended.json()["state"] == "SUSPENDED"
    blocked = await (await client.as_(member)).get(ws_path(workspace))
    assert blocked.status_code == 403
    assert (await api.post(f"{member_path(workspace, member)}:suspend", json={})).status_code == 400

    activated = await api.post(f"{member_path(workspace, member)}:activate", json={})
    assert activated.json()["state"] == "ACTIVE"
    assert (await api.post(f"{member_path(workspace, member)}:activate", json={})).status_code == 400

    self_suspend = await api.post(f"{member_path(workspace, 'me')}:suspend", json={})
    assert reason(self_suspend) == "SELF_MODIFICATION"
    denied = await (await client.as_(member)).post(
        f"{member_path(workspace, owner)}:suspend", json={}
    )
    assert denied.status_code == 403
    assert {"SuspendMember", "ActivateMember"} <= set(await audit_actions(sessions, workspace))


async def test_member_records_cross_slice(world: World, sessions) -> None:
    owner = await world.make_user(display_name="Owner")
    workspace = await world.make_workspace(owner)
    no_name = await world.add_member(workspace)
    stranger = await world.make_user()
    async with sessions.begin() as session:
        records = await member_records(session, workspace.id, [owner.id, no_name.id, stranger.id])
    assert set(records) == {owner.id, no_name.id}
    assert records[owner.id].display_name == "Owner"
    assert records[no_name.id].display_name == no_name.email
    assert records[owner.id].name == f"workspaces/{workspace.id}/members/{owner.id}"


async def test_active_member_ids_cross_slice(world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    suspended = await world.add_member(workspace)
    await world.suspend_member(workspace, suspended)
    await world.add_member(await world.make_workspace(await world.make_user()))
    async with sessions.begin() as session:
        assert await active_member_ids(session, workspace.id) == {owner.id, member.id}

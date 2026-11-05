"""Groups, memberships, custom roles (with undelete), predefined roles and permissions."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import select

from bomesh.db.models import Group, Role, RoleAssignment
from bomesh.iam.catalog import PERMISSIONS, PREDEFINED_ROLES
from harness import ApiClient, World
from workspaces_support import audit_actions, reason, ws_path

pytestmark = pytest.mark.asyncio


# -- Groups ---------------------------------------------------------------------


async def test_group_crud(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    created = await api.post(
        f"{ws_path(workspace)}/groups",
        params={"groupId": "finance"},
        json={"displayName": "Finance", "description": "Money people"},
    )
    assert created.status_code == 200, created.text
    group = created.json()
    assert group["name"] == f"workspaces/{workspace.id}/groups/finance"
    assert group["memberCount"] == 0

    taken = await api.post(
        f"{ws_path(workspace)}/groups", params={"groupId": "finance"}, json={"displayName": "Again"}
    )
    assert taken.status_code == 409
    generated = await api.post(f"{ws_path(workspace)}/groups", json={"displayName": "Auto"})
    assert generated.json()["name"].startswith(f"workspaces/{workspace.id}/groups/group-")
    invalid = await api.post(
        f"{ws_path(workspace)}/groups", params={"groupId": "Bad_Id"}, json={"displayName": "X"}
    )
    assert invalid.status_code == 400

    reader = await client.as_(member)
    assert (await reader.get(f"{ws_path(workspace)}/groups/finance")).json()["displayName"] == "Finance"
    listed = await reader.get(
        f"{ws_path(workspace)}/groups", params={"filter": 'displayName = "Finance"'}
    )
    assert [g["name"] for g in listed.json()["groups"]] == [group["name"]]
    assert (await reader.post(f"{ws_path(workspace)}/groups", json={"displayName": "X"})).status_code == 403

    updated = await api.patch(
        f"{ws_path(workspace)}/groups/finance",
        json={"displayName": "Finance team", "etag": group["etag"]},
    )
    assert updated.json()["displayName"] == "Finance team"
    stale = await api.patch(
        f"{ws_path(workspace)}/groups/finance", json={"displayName": "X", "etag": group["etag"]}
    )
    assert stale.status_code == 409

    await world.grant("group:finance", "roles/workspaceMember", on=workspace)
    stale_delete = await api.delete(
        f"{ws_path(workspace)}/groups/finance", params={"etag": group["etag"]}
    )
    assert stale_delete.status_code == 409
    deleted = await api.delete(f"{ws_path(workspace)}/groups/finance")
    assert deleted.status_code == 200
    assert (await api.get(f"{ws_path(workspace)}/groups/finance")).status_code == 404
    async with sessions.begin() as session:
        live = await session.scalars(
            select(RoleAssignment).where(
                RoleAssignment.tenant_id == workspace.id,
                RoleAssignment.group_id.is_not(None),
                RoleAssignment.deleted_at.is_(None),
            )
        )
        assert live.all() == []
    assert {"CreateGroup", "UpdateGroup", "DeleteGroup"} <= set(
        await audit_actions(sessions, workspace)
    )


async def test_deleting_the_admin_group_is_last_admin(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    group = await world.make_group(workspace, [owner], code="admins")
    await world.grant(group, "roles/workspaceAdmin", on=workspace)
    await world.revoke(owner, on=workspace)
    response = await (await client.as_(owner)).delete(f"{ws_path(workspace)}/groups/admins")
    assert response.status_code == 400
    assert reason(response) == "LAST_ADMIN"


async def test_memberships(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    outsider = await world.make_user()
    await world.make_group(workspace, code="team")
    api = await client.as_(owner)
    base = f"{ws_path(workspace)}/groups/team/memberships"
    member_name = f"workspaces/{workspace.id}/members/{member.id}"

    created = await api.post(base, json={"member": member_name})
    assert created.status_code == 200, created.text
    assert created.json()["name"] == f"{base.removeprefix('/api/v1/')}/{member.id}"
    assert created.json()["member"] == member_name
    assert (await api.post(base, json={"member": member_name})).status_code == 409
    not_member = await api.post(
        base, json={"member": f"workspaces/{workspace.id}/members/{outsider.id}"}
    )
    assert not_member.status_code == 400
    wrong_workspace = await api.post(base, json={"member": f"workspaces/{uuid4()}/members/{member.id}"})
    assert wrong_workspace.status_code == 400

    assert (await api.get(f"{base}/{member.id}")).json()["member"] == member_name
    listed = (await api.get(base)).json()["memberships"]
    assert [m["member"] for m in listed] == [member_name]
    group = (await api.get(f"{ws_path(workspace)}/groups/team")).json()
    assert group["memberCount"] == 1
    member_view = (await api.get(f"{ws_path(workspace)}/members/{member.id}")).json()
    assert member_view["groups"] == [f"workspaces/{workspace.id}/groups/team"]

    reader = await client.as_(member)
    assert (await reader.get(base)).status_code == 403
    assert (await reader.delete(f"{base}/{member.id}")).status_code == 403

    assert (await api.delete(f"{base}/{member.id}")).status_code == 200
    assert (await api.get(f"{base}/{member.id}")).status_code == 404
    assert (await api.delete(f"{base}/{member.id}")).status_code == 404
    assert (await api.get(f"{ws_path(workspace)}/groups/none/memberships")).status_code == 404
    assert {"CreateMembership", "DeleteMembership"} <= set(await audit_actions(sessions, workspace))


# -- Custom roles ---------------------------------------------------------------


async def test_custom_role_lifecycle(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)
    base = f"{ws_path(workspace)}/roles"

    created = await api.post(
        base,
        params={"roleId": "auditor"},
        json={"displayName": "Auditor", "includedPermissions": ["auditEvents.list", "auditEvents.get"]},
    )
    assert created.status_code == 200, created.text
    role = created.json()
    assert role["name"] == f"workspaces/{workspace.id}/roles/auditor"
    assert role["includedPermissions"] == ["auditEvents.get", "auditEvents.list"]
    assert role["state"] == "ACTIVE"

    assert (await api.post(base, params={"roleId": "auditor"}, json={"displayName": "A", "includedPermissions": ["auditEvents.list"]})).status_code == 409
    assert (await api.post(base, params={"roleId": "workspaceAdmin"}, json={"displayName": "A", "includedPermissions": ["auditEvents.list"]})).status_code == 409
    unknown = await api.post(base, json={"displayName": "A", "includedPermissions": ["nope.nope"]})
    assert unknown.status_code == 400
    platform_only = await api.post(
        base, json={"displayName": "A", "includedPermissions": ["workspaces.create"]}
    )
    assert platform_only.status_code == 400
    preview = await api.post(
        base,
        params={"validateOnly": "true", "roleId": "preview"},
        json={"displayName": "P", "includedPermissions": ["groups.list"]},
    )
    assert preview.status_code == 200
    assert (await api.get(f"{base}/preview")).status_code == 404

    updated = await api.patch(
        f"{base}/auditor",
        params={"updateMask": "includedPermissions"},
        json={"includedPermissions": ["auditEvents.list"], "etag": role["etag"]},
    )
    assert updated.json()["includedPermissions"] == ["auditEvents.list"]
    stale = await api.patch(f"{base}/auditor", json={"displayName": "X", "etag": role["etag"]})
    assert stale.status_code == 409

    await world.grant(member, (await _role(sessions, workspace.id, "auditor")), on=workspace)
    member_api = await client.as_(member)
    assert (await member_api.get(f"{ws_path(workspace)}/auditEvents")).status_code == 200

    deleted = await api.delete(f"{base}/auditor")
    assert deleted.json()["state"] == "DELETED"
    assert deleted.json()["deleteTime"] and deleted.json()["purgeTime"]
    assert (await api.delete(f"{base}/auditor")).status_code == 400
    assert (await (await client.as_(member)).get(f"{ws_path(workspace)}/auditEvents")).status_code == 403
    assert (await api.get(f"{base}/auditor")).json()["state"] == "DELETED"
    deleted_update = await api.patch(f"{base}/auditor", json={"displayName": "X"})
    assert deleted_update.status_code == 400

    hidden = (await api.get(base)).json().get("roles", [])
    assert hidden == []
    shown = (await api.get(base, params={"showDeleted": "true"})).json()["roles"]
    assert [r["name"] for r in shown] == [role["name"]]

    restored = await api.post(f"{base}/auditor:undelete", json={})
    assert restored.json()["state"] == "ACTIVE"
    assert (await api.post(f"{base}/auditor:undelete", json={})).status_code == 409
    assert (await (await client.as_(member)).get(f"{ws_path(workspace)}/auditEvents")).status_code == 200
    assert {"CreateRole", "UpdateRole", "DeleteRole", "UndeleteRole"} <= set(
        await audit_actions(sessions, workspace)
    )


async def _role(sessions, workspace_id, code):
    async with sessions.begin() as session:
        return await session.scalar(
            select(Role).where(Role.tenant_id == workspace_id, Role.code == code)
        )


async def test_custom_role_escalation_and_permissions(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    role_maker = await world.make_role(workspace, "maker", ["roles.create", "roles.update", "roles.get"])
    maker = await world.add_member(workspace, role=role_maker)
    member = await world.add_member(workspace)
    api = await client.as_(maker)

    escalation = await api.post(
        f"{ws_path(workspace)}/roles",
        json={"displayName": "Boss", "includedPermissions": ["workspaces.setIamPolicy"]},
    )
    assert escalation.status_code == 403
    assert reason(escalation) == "ROLE_ESCALATION"
    fine = await api.post(
        f"{ws_path(workspace)}/roles", json={"displayName": "Lite", "includedPermissions": ["roles.get"]}
    )
    assert fine.status_code == 200

    reader = await client.as_(member)
    assert (await reader.get(f"{ws_path(workspace)}/roles")).status_code == 200
    assert (await reader.post(f"{ws_path(workspace)}/roles", json={"displayName": "X", "includedPermissions": ["roles.get"]})).status_code == 403


# -- Predefined roles and permissions --------------------------------------------


async def test_predefined_roles_and_permissions(client: ApiClient, world: World) -> None:
    api = await client.as_(await world.make_user())

    roles = (await api.get("/api/v1/roles", params={"pageSize": 1000})).json()["roles"]
    assert {role["name"] for role in roles} == {role.name for role in PREDEFINED_ROLES}
    editor = (await api.get("/api/v1/roles/collectionEditor")).json()
    assert "items.publish" in editor["includedPermissions"]
    assert (await api.get("/api/v1/roles/nope")).status_code == 404
    filtered = await api.get("/api/v1/roles", params={"filter": 'name = "roles/spaceLead"'})
    assert [role["name"] for role in filtered.json()["roles"]] == ["roles/spaceLead"]

    first = (await api.get("/api/v1/permissions", params={"pageSize": 10})).json()
    assert len(first["permissions"]) == 10
    assert first["nextPageToken"]
    everything = (await api.get("/api/v1/permissions", params={"pageSize": 1000})).json()
    assert len(everything["permissions"]) == len(PERMISSIONS)
    publish = (await api.get("/api/v1/permissions/items.publish")).json()
    assert publish == {
        "name": "permissions/items.publish",
        "title": publish["title"],
        "description": publish["description"],
        "customRolesSupported": True,
    }
    assert (await api.get("/api/v1/permissions/nope.nope")).status_code == 404
    unsupported = await api.get(
        "/api/v1/permissions", params={"filter": "customRolesSupported = false", "pageSize": 1000}
    )
    assert all(not p["customRolesSupported"] for p in unsupported.json()["permissions"])
    assert (await client.get("/api/v1/permissions")).status_code == 401


# -- requestId replays ------------------------------------------------------------


async def test_create_group_membership_and_role_replay_request_id(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    group_url = f"{ws_path(workspace)}/groups?requestId={uuid4()}"
    first_group = await api.post(group_url, json={"displayName": "Ops"})
    again_group = await api.post(group_url, json={"displayName": "Ops"})
    assert first_group.status_code == again_group.status_code == 200
    assert first_group.json()["name"] == again_group.json()["name"]
    reused = await api.post(group_url, json={"displayName": "Other"})
    assert reused.status_code == 400
    assert reason(reused) == "REQUEST_ID_REUSED"

    group_path = first_group.json()["name"]
    membership_url = f"/api/v1/{group_path}/memberships?requestId={uuid4()}"
    body = {"member": f"workspaces/{workspace.id}/members/{member.id}"}
    first_membership = await api.post(membership_url, json=body)
    again_membership = await api.post(membership_url, json=body)
    assert first_membership.status_code == again_membership.status_code == 200
    assert first_membership.json()["name"] == again_membership.json()["name"]

    role_url = f"{ws_path(workspace)}/roles?requestId={uuid4()}"
    role_body = {"displayName": "Reader", "includedPermissions": ["groups.list"]}
    first_role = await api.post(role_url, json=role_body)
    again_role = await api.post(role_url, json=role_body)
    assert first_role.status_code == again_role.status_code == 200
    assert first_role.json()["name"] == again_role.json()["name"]
    async with sessions.begin() as session:
        assert len((await session.scalars(select(Group).where(Group.tenant_id == workspace.id))).all()) == 1
        assert len((await session.scalars(select(Role).where(Role.tenant_id == workspace.id))).all()) == 1

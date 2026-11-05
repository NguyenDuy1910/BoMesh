"""Workspace IAM: getIamPolicy, setIamPolicy, testIamPermissions, analyzeIamPolicy."""

from __future__ import annotations

import pytest

from bomesh.db.models import Item
from harness import ApiClient, World
from workspaces_support import audit_actions, reason, ws_path

pytestmark = pytest.mark.asyncio


async def test_get_and_set_policy(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    group = await world.make_group(workspace, code="editors")
    api = await client.as_(owner)

    policy = (await api.post(f"{ws_path(workspace)}:getIamPolicy", json={})).json()
    bindings = {b["role"]: b["members"] for b in policy["bindings"]}
    assert bindings == {
        "roles/workspaceAdmin": [f"user:{owner.id}"],
        "roles/workspaceMember": [f"user:{member.id}"],
    }

    desired = [
        {"role": "roles/workspaceAdmin", "members": [f"user:{owner.id}", f"user:{member.id}"]},
        {"role": "roles/workspaceMember", "members": [f"user:{member.id}", f"group:{group.code}"]},
    ]
    updated = await api.post(
        f"{ws_path(workspace)}:setIamPolicy",
        json={"policy": {"bindings": desired, "etag": policy["etag"]}},
    )
    assert updated.status_code == 200, updated.text
    assert {b["role"]: sorted(b["members"]) for b in updated.json()["bindings"]} == {
        b["role"]: sorted(b["members"]) for b in desired
    }
    assert "SetWorkspaceIamPolicy" in await audit_actions(sessions, workspace)

    stale = await api.post(
        f"{ws_path(workspace)}:setIamPolicy",
        json={"policy": {"bindings": desired, "etag": policy["etag"]}},
    )
    assert stale.status_code == 409
    assert reason(stale) == "ETAG_MISMATCH"


async def test_set_policy_rules(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)

    self_change = await api.post(
        f"{ws_path(workspace)}:setIamPolicy",
        json={"policy": {"bindings": [{"role": "roles/workspaceMember", "members": [f"user:{owner.id}", f"user:{member.id}"]}]}},
    )
    assert self_change.status_code == 400
    assert reason(self_change) == "SELF_MODIFICATION"

    bad_principal = await api.post(
        f"{ws_path(workspace)}:setIamPolicy",
        json={"policy": {"bindings": [{"role": "roles/workspaceAdmin", "members": [f"user:{owner.id}", "group:nope"]}]}},
    )
    assert bad_principal.status_code == 400

    member_api = await client.as_(member)
    assert (await member_api.post(f"{ws_path(workspace)}:getIamPolicy", json={})).status_code == 403
    assert (await member_api.post(f"{ws_path(workspace)}:setIamPolicy", json={"policy": {"bindings": []}})).status_code == 403


async def test_set_policy_last_admin_and_escalation(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    keeper_role = await world.make_role(
        workspace, "keeper", ["workspaces.setIamPolicy", "workspaces.getIamPolicy"]
    )
    keeper = await world.add_member(workspace, role=keeper_role)
    api = await client.as_(keeper)
    keeper_binding = {
        "role": f"workspaces/{workspace.id}/roles/keeper",
        "members": [f"user:{keeper.id}"],
    }

    last_admin = await api.post(
        f"{ws_path(workspace)}:setIamPolicy", json={"policy": {"bindings": [keeper_binding]}}
    )
    assert last_admin.status_code == 400
    assert reason(last_admin) == "LAST_ADMIN"

    other = await world.add_member(workspace, role=None)
    escalation = await api.post(
        f"{ws_path(workspace)}:setIamPolicy",
        json={
            "policy": {
                "bindings": [
                    keeper_binding,
                    {"role": "roles/workspaceAdmin", "members": [f"user:{owner.id}", f"user:{other.id}"]},
                ]
            }
        },
    )
    assert escalation.status_code == 403
    assert reason(escalation) == "ROLE_ESCALATION"


async def test_test_iam_permissions(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    asked = ["groups.list", "workspaces.update", "members.list"]

    member_held = await (await client.as_(member)).post(
        f"{ws_path(workspace)}:testIamPermissions", json={"permissions": asked}
    )
    assert member_held.json()["permissions"] == ["groups.list", "members.list"]
    owner_held = await (await client.as_(owner)).post(
        f"{ws_path(workspace)}:testIamPermissions", json={"permissions": asked}
    )
    assert owner_held.json()["permissions"] == asked
    outsider = await client.as_(await world.make_user())
    denied = await outsider.post(
        f"{ws_path(workspace)}:testIamPermissions", json={"permissions": asked}
    )
    assert denied.status_code == 403


async def test_analyze_iam_policy(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    alice = await world.add_member(workspace)
    group = await world.make_group(workspace, [alice], code="readers")
    root = await world.make_collection(workspace, grants={"workspaceMembers": "roles/collectionViewer"})
    nested = await world.make_collection(workspace, root)
    boundary = await world.make_collection(
        workspace, root, inherit_access=False, grants={group: "roles/collectionEditor"}
    )
    space = await world.make_space(workspace, alice)
    async with world.sessions.begin() as session:
        hidden = Item(
            tenant_id=workspace.id,
            item_type="collection",
            title="Conversation artifacts",
            metadata_={"system_kind": "conversation_artifacts"},
            inherit_access=False,
            status="ready",
        )
        session.add(hidden)
    api = await client.as_(owner)

    response = await api.get(
        f"{ws_path(workspace)}:analyzeIamPolicy", params={"principal": f"user:{alice.id}"}
    )
    assert response.status_code == 200, response.text
    results = {r["resource"]: r["roles"] for r in response.json()["results"]}
    item = f"workspaces/{workspace.id}/items"
    assert results[f"workspaces/{workspace.id}"] == ["roles/workspaceMember"]
    assert results[f"{item}/{root.id}"] == ["roles/collectionViewer", "roles/workspaceMember"]
    assert results[f"{item}/{boundary.id}"] == ["roles/collectionEditor", "roles/workspaceMember"]
    assert f"{item}/{nested.id}" not in results
    assert f"{item}/{hidden.id}" not in results
    assert results[f"workspaces/{workspace.id}/spaces/{space.code}"] == [
        "roles/spaceLead",
        "roles/workspaceMember",
    ]
    assert f"workspaces/{workspace.id}/spaces/{space.id}" not in results
    space_name = f"workspaces/{workspace.id}/spaces/{space.code}"
    assert (await api.get(f"/api/v1/{space_name}")).status_code == 200

    by_group = await api.get(
        f"{ws_path(workspace)}:analyzeIamPolicy", params={"principal": "group:readers"}
    )
    group_results = {r["resource"]: r["roles"] for r in by_group.json()["results"]}
    assert group_results[f"{item}/{boundary.id}"] == ["roles/collectionEditor"]
    assert group_results[f"{item}/{root.id}"] == []

    everyone = await api.get(
        f"{ws_path(workspace)}:analyzeIamPolicy", params={"principal": "workspaceMembers"}
    )
    assert {r["resource"]: r["roles"] for r in everyone.json()["results"]}[f"{item}/{root.id}"] == [
        "roles/collectionViewer"
    ]

    for bad in ("nobody", "user:not-a-uuid", "group:missing"):
        invalid = await api.get(f"{ws_path(workspace)}:analyzeIamPolicy", params={"principal": bad})
        assert invalid.status_code == 400, bad
    denied = await (await client.as_(alice)).get(
        f"{ws_path(workspace)}:analyzeIamPolicy", params={"principal": f"user:{alice.id}"}
    )
    assert denied.status_code == 403

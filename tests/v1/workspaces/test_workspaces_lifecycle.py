"""Workspaces: create (LRO), get, list, update, lifecycle and ingestion pause."""

from __future__ import annotations

from uuid import uuid4

import pytest
from sqlalchemy import select

from bomesh.services.knowledge_items.item_store import personal_collection_id
from bomesh.db.models import Item, Tenant, TenantMembership
from harness import ApiClient, World
from workspaces_support import audit_actions, reason, set_status, ws_path

pytestmark = pytest.mark.asyncio


def _code() -> str:
    return f"ws-{uuid4().hex[:8]}"


# -- CreateWorkspace ------------------------------------------------------------


async def test_create_workspace_provisions_admin_and_personal_collection(
    client: ApiClient, world: World, sessions
) -> None:
    admin = await world.platform_admin(await world.make_user())
    owner = await world.make_user("Owner@Example.com")
    api = await client.as_(admin)

    response = await api.post(
        "/api/v1/workspaces",
        json={"displayName": "Acme", "code": (code := _code()), "initialAdminEmail": owner.email},
    )

    assert response.status_code == 200, response.text
    operation = response.json()
    assert operation["done"] is True
    workspace = operation["response"]
    assert workspace["@type"].endswith("Workspace")
    assert workspace["code"] == code
    assert workspace["state"] == "ACTIVE"
    assert workspace["template"] == "ENTERPRISE"
    assert workspace["memberCount"] == 1
    assert "initialAdminEmail" not in workspace
    workspace_id = workspace["uid"]

    owner_api = await client.as_(owner)
    policy = (await owner_api.post(f"/api/v1/workspaces/{workspace_id}:getIamPolicy", json={})).json()
    assert {"role": "roles/workspaceAdmin", "members": [f"user:{owner.id}"]} in policy["bindings"]
    me = (await owner_api.get(f"/api/v1/workspaces/{workspace_id}/members/me")).json()
    assert me["personalCollection"].endswith(str(personal_collection_id(workspace_id, owner.id)))
    async with sessions.begin() as session:
        personal = await session.get(Item, personal_collection_id(workspace_id, owner.id))
        assert personal is not None
        assert personal.metadata_["system_kind"] == "personal_uploads"
        assert personal.inherit_access is False
    assert "CreateWorkspace" in await audit_actions(sessions, await _tenant(sessions, code))


async def _tenant(sessions, code: str) -> Tenant:
    async with sessions.begin() as session:
        tenant = await session.scalar(select(Tenant).where(Tenant.code == code))
        assert tenant is not None
        return tenant


async def test_create_workspace_requires_platform_permission(
    client: ApiClient, world: World
) -> None:
    operator = await world.platform_operator(await world.make_user())
    api = await client.as_(operator)
    response = await api.post(
        "/api/v1/workspaces",
        json={"displayName": "Acme", "code": _code(), "initialAdminEmail": operator.email},
    )
    assert response.status_code == 403


async def test_create_workspace_errors(client: ApiClient, world: World) -> None:
    admin = await world.platform_admin(await world.make_user())
    existing = await world.make_workspace(admin)
    api = await client.as_(admin)

    taken = await api.post(
        "/api/v1/workspaces",
        json={"displayName": "X", "code": existing.code, "initialAdminEmail": admin.email},
    )
    assert taken.status_code == 409
    assert reason(taken) == "WORKSPACE_CODE_TAKEN"

    bad_code = await api.post(
        "/api/v1/workspaces",
        json={"displayName": "X", "code": "Bad_Code", "initialAdminEmail": admin.email},
    )
    assert bad_code.status_code == 400

    unknown_admin = await api.post(
        "/api/v1/workspaces",
        json={"displayName": "X", "code": _code(), "initialAdminEmail": "nobody@example.com"},
    )
    assert unknown_admin.status_code == 400

    missing_admin = await api.post(
        "/api/v1/workspaces", json={"displayName": "X", "code": _code()}
    )
    assert missing_admin.status_code == 400


async def test_create_workspace_request_id_replays_operation(
    client: ApiClient, world: World, sessions
) -> None:
    admin = await world.platform_admin(await world.make_user())
    api = await client.as_(admin)
    body = {"displayName": "Acme", "code": _code(), "initialAdminEmail": admin.email}
    request_id = str(uuid4())

    first = await api.post(f"/api/v1/workspaces?requestId={request_id}", json=body)
    second = await api.post(f"/api/v1/workspaces?requestId={request_id}", json=body)
    reused = await api.post(
        f"/api/v1/workspaces?requestId={request_id}", json={**body, "code": _code()}
    )

    assert first.status_code == second.status_code == 200
    assert first.json()["name"] == second.json()["name"]
    assert reused.status_code == 400
    assert reason(reused) == "REQUEST_ID_REUSED"
    async with sessions.begin() as session:
        assert (await session.scalars(select(Tenant.id).where(Tenant.code == body["code"]))).all()


# -- Get / List -----------------------------------------------------------------


async def test_get_workspace_member_platform_and_outsider(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    operator = await world.platform_operator(await world.make_user())
    outsider = await world.make_user()

    for user in (owner, member, operator):
        response = await (await client.as_(user)).get(ws_path(workspace))
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["name"] == f"workspaces/{workspace.id}"
        assert body["memberCount"] == 2
        assert body["ingestionState"] == "ACTIVE"
        assert body["etag"]

    assert (await (await client.as_(outsider)).get(ws_path(workspace))).status_code == 403
    assert (await (await client.as_(operator)).get(ws_path(uuid4()))).status_code == 404
    assert (await (await client.as_(outsider)).get(ws_path(uuid4()))).status_code == 403


async def test_get_workspace_is_exempt_from_state_rules(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    await set_status(sessions, workspace, "suspended")
    response = await (await client.as_(owner)).get(ws_path(workspace))
    assert response.status_code == 200
    assert response.json()["state"] == "SUSPENDED"
    settings = await (await client.as_(owner)).get(f"{ws_path(workspace)}/settings")
    assert settings.status_code == 400
    assert reason(settings) == "WORKSPACE_SUSPENDED"


async def test_list_workspaces_scoping_filter_order_paging(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    first = await world.make_workspace(owner, code="alpha-" + uuid4().hex[:6], name="Alpha")
    second = await world.make_workspace(owner, code="beta-" + uuid4().hex[:6], name="Beta")
    other = await world.make_workspace(await world.make_user(), name="Gamma")
    operator = await world.platform_operator(await world.make_user())

    mine = (await (await client.as_(owner)).get("/api/v1/workspaces")).json()
    assert [w["name"] for w in mine["workspaces"]] == [
        f"workspaces/{first.id}",
        f"workspaces/{second.id}",
    ]

    platform = await client.as_(operator)
    everything = (await platform.get("/api/v1/workspaces")).json()["workspaces"]
    assert {w["uid"] for w in everything} == {str(first.id), str(second.id), str(other.id)}

    filtered = await platform.get(
        "/api/v1/workspaces", params={"filter": f'code = "{second.code}"'}
    )
    assert [w["uid"] for w in filtered.json()["workspaces"]] == [str(second.id)]

    page = (await platform.get("/api/v1/workspaces", params={"pageSize": 2, "orderBy": "displayName desc"})).json()
    assert [w["displayName"] for w in page["workspaces"]] == ["Gamma", "Beta"]
    rest = await platform.get(
        "/api/v1/workspaces",
        params={"pageSize": 2, "orderBy": "displayName desc", "pageToken": page["nextPageToken"]},
    )
    assert [w["displayName"] for w in rest.json()["workspaces"]] == ["Alpha"]

    bad = await platform.get("/api/v1/workspaces", params={"filter": "state = BOGUS"})
    assert bad.status_code == 400


async def test_list_workspaces_hides_suspended_memberships(client: ApiClient, world: World) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    await world.suspend_member(workspace, member)
    listed = (await (await client.as_(member)).get("/api/v1/workspaces")).json()
    assert listed.get("workspaces", []) == []


# -- Update ---------------------------------------------------------------------


async def test_update_workspace(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    taken = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    api = await client.as_(owner)
    current = (await api.get(ws_path(workspace))).json()

    code = _code()
    updated = await api.patch(
        ws_path(workspace),
        params={"updateMask": "displayName,code"},
        json={"displayName": "Renamed", "code": code, "etag": current["etag"]},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["displayName"] == "Renamed"
    assert updated.json()["code"] == code
    assert "UpdateWorkspace" in await audit_actions(sessions, workspace)

    stale = await api.patch(ws_path(workspace), json={"displayName": "X", "etag": current["etag"]})
    assert stale.status_code == 409
    assert reason(stale) == "ETAG_MISMATCH"

    conflict = await api.patch(ws_path(workspace), json={"code": taken.code})
    assert conflict.status_code == 409
    assert reason(conflict) == "WORKSPACE_CODE_TAKEN"

    immutable = await api.patch(
        ws_path(workspace), params={"updateMask": "template"}, json={"template": "CAMPUS"}
    )
    assert immutable.status_code == 400

    denied = await (await client.as_(member)).patch(ws_path(workspace), json={"displayName": "X"})
    assert denied.status_code == 403

    await set_status(sessions, workspace, "archived")
    archived = await api.patch(ws_path(workspace), json={"displayName": "Y"})
    assert archived.status_code == 400
    assert reason(archived) == "WORKSPACE_ARCHIVED"


# -- Lifecycle ------------------------------------------------------------------


async def test_suspend_activate_archive_transitions(
    client: ApiClient, world: World, sessions
) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    platform = await client.as_(await world.platform_admin(await world.make_user()))

    suspended = await platform.post(f"{ws_path(workspace)}:suspend", json={})
    assert suspended.json()["state"] == "SUSPENDED"
    again = await platform.post(f"{ws_path(workspace)}:suspend", json={})
    assert again.status_code == 400

    activated = await platform.post(f"{ws_path(workspace)}:activate", json={})
    assert activated.json()["state"] == "ACTIVE"
    active_again = await platform.post(f"{ws_path(workspace)}:activate", json={})
    assert active_again.status_code == 400

    wrong = await platform.post(f"{ws_path(workspace)}:archive", json={"confirmationCode": "nope"})
    assert wrong.status_code == 400
    archived = await platform.post(
        f"{ws_path(workspace)}:archive", json={"confirmationCode": workspace.code}
    )
    assert archived.json()["state"] == "ARCHIVED"
    twice = await platform.post(
        f"{ws_path(workspace)}:archive", json={"confirmationCode": workspace.code}
    )
    assert twice.status_code == 400

    owner_api = await client.as_(owner)
    assert (await owner_api.get(f"{ws_path(workspace)}/settings")).status_code == 200
    unarchived = await platform.post(f"{ws_path(workspace)}:activate", json={})
    assert unarchived.json()["state"] == "ACTIVE"
    actions = await audit_actions(sessions, workspace)
    assert {"SuspendWorkspace", "ActivateWorkspace", "ArchiveWorkspace"} <= set(actions)

    stale = await platform.post(f"{ws_path(workspace)}:suspend", json={"etag": "stale"})
    assert stale.status_code == 409


async def test_lifecycle_permissions(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    owner_api = await client.as_(owner)

    assert (await owner_api.post(f"{ws_path(workspace)}:suspend", json={})).status_code == 403
    assert (await owner_api.post(f"{ws_path(workspace)}:activate", json={})).status_code == 403
    archived = await owner_api.post(
        f"{ws_path(workspace)}:archive", json={"confirmationCode": workspace.code}
    )
    assert archived.status_code == 200
    await set_status(sessions, workspace, "creating")
    platform = await client.as_(await world.platform_admin(await world.make_user()))
    creating = await platform.post(f"{ws_path(workspace)}:activate", json={})
    assert creating.status_code == 400
    assert (await platform.post(f"{ws_path(uuid4())}:suspend", json={})).status_code == 404


async def test_pause_and_resume_ingestion(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    operator = await client.as_(await world.platform_operator(await world.make_user()))

    paused = await operator.post(f"{ws_path(workspace)}:pauseIngestion", json={})
    assert paused.status_code == 200, paused.text
    assert paused.json()["ingestionState"] == "PAUSED"
    async with sessions.begin() as session:
        assert (await session.get(Tenant, workspace.id)).ingestion_paused_at is not None
    assert (await operator.post(f"{ws_path(workspace)}:pauseIngestion", json={})).status_code == 400

    resumed = await operator.post(f"{ws_path(workspace)}:resumeIngestion", json={})
    assert resumed.json()["ingestionState"] == "ACTIVE"
    assert (await operator.post(f"{ws_path(workspace)}:resumeIngestion", json={})).status_code == 400

    owner_api = await client.as_(owner)
    assert (await owner_api.post(f"{ws_path(workspace)}:pauseIngestion", json={})).status_code == 403


async def test_membership_count_excludes_suspended(client: ApiClient, world: World, sessions) -> None:
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    member = await world.add_member(workspace)
    await world.suspend_member(workspace, member)
    body = (await (await client.as_(owner)).get(ws_path(workspace))).json()
    assert body["memberCount"] == 1
    async with sessions.begin() as session:
        rows = await session.scalars(
            select(TenantMembership).where(TenantMembership.tenant_id == workspace.id)
        )
        assert len(rows.all()) == 2

"""Connections: ownership and visibility, OAuth authorization and its callback, health and discovery."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from sqlalchemy import select

from bomesh.db.models import AuditLog, IntegrationConnection, Tenant, User
from bomesh.runtime import AppRuntime
from bomesh.services.ingestion.connection_store import IntegrationConnectionService
from connections_support import (
    CONFLUENCE,
    callback,
    connect,
    connection_row,
    connection_url,
    connections_url,
    insert_connection,
    insert_source,
    member_of,
    state_of,
    stored_credentials,
)
from fakes import ATLASSIAN_ACCOUNT_ID, FakeAtlassian
from harness import ApiClient, Sessions, World

pytestmark = pytest.mark.asyncio

GRANT = {"access_token": "access-0", "refresh_token": "refresh-0", "cloud_id": "cloud"}


async def _workspace(world: World) -> tuple[User, Tenant, User]:
    """An admin, their workspace and a plain member of it."""
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    return admin, workspace, await world.add_member(workspace)


def _error(response: Any) -> str:
    return response.json()["error"]["status"]


# -- Create and the OAuth callback ----------------------------------------------


async def test_creating_an_oauth_connection_starts_authorizing(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)

    response = await api.post(
        connections_url(workspace), params={"connectionId": "wiki"}, json={"connector": CONFLUENCE}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == f"workspaces/{workspace.id}/connections/wiki"
    assert body["connector"] == CONFLUENCE
    assert body["state"] == "AUTHORIZING"
    assert body["displayName"] == "Confluence"
    assert "owner" not in body
    assert body["authorizationUri"].startswith("https://auth.atlassian.com/authorize?")
    assert "code_challenge_method=S256" in body["authorizationUri"]
    # Computed on read: every read seals a new state and verifier.
    again = (await api.get(connection_url(workspace, "wiki"))).json()
    assert state_of(again["authorizationUri"]) != state_of(body["authorizationUri"])
    generated = (await api.post(connections_url(workspace), json={"connector": CONFLUENCE})).json()
    assert generated["displayName"] == "Confluence (2)"
    async with sessions.begin() as session:
        assert await session.scalar(
            select(AuditLog.id).where(AuditLog.action == "CreateConnection")
        )


async def test_the_callback_completes_the_connection(
    client: ApiClient, world: World, sessions: Sessions, atlassian: FakeAtlassian
) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    created = (
        await api.post(
            connections_url(workspace), params={"connectionId": "wiki"}, json={"connector": CONFLUENCE}
        )
    ).json()

    page = await client.http.get(
        "/oauth/callback", params={"state": state_of(created["authorizationUri"]), "code": "c"}
    )

    assert page.status_code == 200
    assert page.headers["Content-Security-Policy"] == "default-src 'none'; script-src 'unsafe-inline'"
    assert page.headers["Cache-Control"] == "no-store"
    assert '"source": "bomesh.connection"' in page.text
    assert '"status": "connected"' in page.text
    assert f'"connection": "workspaces/{workspace.id}/connections/wiki"' in page.text
    assert '"https://app.example"' in page.text
    body = (await api.get(connection_url(workspace, "wiki"))).json()
    assert body["state"] == "ACTIVE"
    assert body["account"] == {"displayName": "duy@company.com", "resourceLabel": "Galaxy FinX"}
    assert "authorizationUri" not in body
    assert "lastCheckTime" in body
    row = await connection_row(sessions, workspace, "wiki")
    assert row.provider_account_id == ATLASSIAN_ACCOUNT_ID
    assert row.config["wiki_base"].endswith("/wiki")
    secret = await stored_credentials(sessions, row.id)
    assert secret is not None and secret["refresh_token"] == "refresh-2"
    assert "refresh-2" not in str(body)


async def test_a_forged_state_or_a_provider_refusal_renders_an_error_page(
    client: ApiClient, world: World, atlassian: FakeAtlassian
) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    created = (await api.post(connections_url(workspace), json={"connector": CONFLUENCE})).json()

    forged = await client.http.get("/oauth/callback", params={"state": "forged", "code": "c"})
    assert forged.status_code == 400
    assert '"status": "error"' in forged.text
    declined = await client.http.get(
        "/oauth/callback",
        params={"state": state_of(created["authorizationUri"]), "error": "access_denied"},
    )
    assert declined.status_code == 200
    assert '"status": "error"' in declined.text
    assert "declined" in declined.text
    assert atlassian.exchanges == 0
    assert (await api.get(f"/api/v1/{created['name']}")).json()["state"] == "AUTHORIZING"


async def test_the_callback_rechecks_the_authorizing_member(
    client: ApiClient, world: World, atlassian: FakeAtlassian
) -> None:
    _, workspace, member = await _workspace(world)
    api = await client.as_(member)
    created = (
        await api.post(
            connections_url(workspace),
            json={"connector": CONFLUENCE, "owner": member_of(workspace, member)},
        )
    ).json()
    await world.suspend_member(workspace, member)

    page = await callback(api, created["authorizationUri"])

    assert page.status_code == 403
    assert '"status": "error"' in page.text
    assert atlassian.exchanges == 0


async def test_authorizing_the_same_account_twice_reuses_the_connection(
    client: ApiClient, world: World, atlassian: FakeAtlassian
) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    await connect(api, workspace, "first")
    second = (
        await api.post(
            connections_url(workspace), params={"connectionId": "second"}, json={"connector": CONFLUENCE}
        )
    ).json()

    page = await callback(api, second["authorizationUri"])

    assert f'"connection": "workspaces/{workspace.id}/connections/first"' in page.text
    listed = (await api.get(connections_url(workspace))).json()
    assert [connection["name"].rsplit("/", 1)[-1] for connection in listed["connections"]] == ["first"]
    assert (await api.get(connection_url(workspace, "second"))).status_code == 404


async def test_create_validates_its_inputs(client: ApiClient, world: World) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    url = connections_url(workspace)
    await api.post(url, params={"connectionId": "taken"}, json={"connector": CONFLUENCE, "displayName": "Wiki"})

    cases = [
        ({"connectionId": "taken"}, {"connector": CONFLUENCE}, 409, "ALREADY_EXISTS"),
        ({}, {"connector": CONFLUENCE, "displayName": "Wiki"}, 409, "ALREADY_EXISTS"),
        ({"connectionId": "Bad_ID"}, {"connector": CONFLUENCE}, 400, "INVALID_ARGUMENT"),
        ({}, {"connector": "connectors/missing"}, 400, "INVALID_ARGUMENT"),
        ({}, {"displayName": "x"}, 400, "INVALID_ARGUMENT"),
        ({}, {"connector": CONFLUENCE, "apiToken": "t"}, 400, "INVALID_ARGUMENT"),
        ({}, {"connector": CONFLUENCE, "config": {"wiki_base": "https://x"}}, 400, "INVALID_ARGUMENT"),
        (
            {},
            {"connector": CONFLUENCE, "apiToken": "t", "config": {"wiki_base": "https://x", "space": "A"}},
            400,
            "INVALID_ARGUMENT",
        ),
        ({}, {"connector": CONFLUENCE, "apiToken": " ", "config": {"wiki_base": "https://x"}}, 400, "INVALID_ARGUMENT"),
        ({}, {"connector": "connectors/sharepoint"}, 400, "FAILED_PRECONDITION"),
        # No OAuth client is configured for Google in the harness.
        ({}, {"connector": "connectors/google_drive"}, 400, "FAILED_PRECONDITION"),
    ]
    for params, body, status, code in cases:
        response = await api.post(url, params=params, json=body)
        assert (response.status_code, _error(response)) == (status, code), (params, body)


async def test_a_disabled_connector_cannot_be_connected(client: ApiClient, world: World) -> None:
    admin, workspace, _ = await _workspace(world)
    platform = await client.as_(await world.platform_admin(await world.make_user()))
    await platform.post("/api/v1/connectors/confluence:disable", json={})
    api = await client.as_(admin)

    response = await api.post(connections_url(workspace), json={"connector": CONFLUENCE})

    assert response.status_code == 400
    assert _error(response) == "FAILED_PRECONDITION"


async def test_validate_only_and_request_id(client: ApiClient, world: World) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    url = connections_url(workspace)

    dry = await api.post(
        url, params={"connectionId": "dry", "validateOnly": "true"}, json={"connector": CONFLUENCE}
    )
    assert dry.status_code == 200
    assert dry.json()["state"] == "AUTHORIZING"
    assert (await api.get(connection_url(workspace, "dry"))).status_code == 404

    request_id = str(uuid4())
    first = await api.post(url, params={"requestId": request_id}, json={"connector": CONFLUENCE})
    retry = await api.post(url, params={"requestId": request_id}, json={"connector": CONFLUENCE})
    assert first.json()["name"] == retry.json()["name"]
    assert (await api.get(url)).json()["totalSize"] == 1
    reused = await api.post(
        url, params={"requestId": request_id}, json={"connector": CONFLUENCE, "displayName": "Other"}
    )
    assert reused.status_code == 400
    assert reused.json()["error"]["details"][0]["reason"] == "REQUEST_ID_REUSED"


async def test_members_create_personal_connections_only(client: ApiClient, world: World) -> None:
    _, workspace, member = await _workspace(world)
    other = await world.add_member(workspace)
    api = await client.as_(member)
    url = connections_url(workspace)

    shared = await api.post(url, json={"connector": CONFLUENCE})
    assert shared.status_code == 403
    for_other = await api.post(url, json={"connector": CONFLUENCE, "owner": member_of(workspace, other)})
    assert for_other.status_code == 403
    personal = await api.post(url, json={"connector": CONFLUENCE, "owner": member_of(workspace, member)})
    assert personal.status_code == 200
    assert personal.json()["owner"] == member_of(workspace, member)
    outsider = await client.as_(await world.make_user())
    assert (await outsider.post(url, json={"connector": CONFLUENCE})).status_code == 403


async def test_an_api_token_confluence_connection_is_active_with_its_site_config(
    client: ApiClient, runtime: AppRuntime, world: World, sessions: Sessions
) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    site = {"wiki_base": "https://team.atlassian.net/wiki", "username": "kb@team.example"}

    created = await api.post(
        connections_url(workspace),
        params={"connectionId": "site"},
        json={"connector": CONFLUENCE, "apiToken": "token-1", "config": site},
    )

    assert created.status_code == 200, created.text
    body = created.json()
    assert body["state"] == "ACTIVE"
    assert body["config"] == site
    assert "authorizationUri" not in body and "apiToken" not in body
    fetched = (await api.get(connection_url(workspace, "site"))).json()
    assert fetched["config"] == site
    row = await connection_row(sessions, workspace, "site")
    assert await stored_credentials(sessions, row.id) == {"api_token": "token-1"}

    # The config is immutable; only displayName is updatable.
    masked = await api.patch(
        connection_url(workspace, "site"),
        params={"updateMask": "config"},
        json={"config": {"wiki_base": "https://elsewhere.example/wiki"}},
    )
    assert (masked.status_code, _error(masked)) == (400, "INVALID_ARGUMENT")

    # The runtime reads the site with basic auth, never through the Atlassian gateway.
    async with sessions.begin() as session:
        engine = IntegrationConnectionService(
            session,
            providers=runtime.connection_providers(),
            credential_encryption_key=runtime.config.integration.credential_encryption_key,
        )
        adapter = await engine.runtime_for(
            await session.get(IntegrationConnection, row.id), source_config={"space": "ENG"}
        )
    confluence = adapter.connector
    assert confluence.wiki_base == site["wiki_base"]
    assert confluence.confluence_client.confluence_client.username == site["username"]


# -- Visibility: Get and List -----------------------------------------------------


async def test_personal_connections_belong_to_their_owner(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin, workspace, member = await _workspace(world)
    other = await world.add_member(workspace)
    await insert_connection(sessions, workspace, "mine", owner=member)
    await insert_connection(sessions, workspace, "shared")

    owner_api = await client.as_(member)
    assert (await owner_api.get(connection_url(workspace, "mine"))).status_code == 200
    # Plain members hold no connections.get: shared ones are denied, absent alike.
    assert (await owner_api.get(connection_url(workspace, "shared"))).status_code == 403
    assert (await owner_api.get(connection_url(workspace, "missing"))).status_code == 403
    other_api = await client.as_(other)
    assert (await other_api.get(connection_url(workspace, "mine"))).status_code == 403
    admin_api = await client.as_(admin)
    assert (await admin_api.get(connection_url(workspace, "shared"))).status_code == 200
    assert (await admin_api.get(connection_url(workspace, "mine"))).status_code == 404
    assert (await admin_api.get(connection_url(workspace, "missing"))).status_code == 404
    platform = await client.as_(await world.platform_admin(await world.make_user()))
    assert (await platform.get(connection_url(workspace, "shared"))).status_code == 403
    assert (await platform.get(connections_url(workspace))).status_code == 403


async def test_a_role_with_connections_get_reads_shared_connections(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    _, workspace, _ = await _workspace(world)
    role = await world.make_role(workspace, "connectionReader", ["connections.get", "connections.list"])
    reader = await world.add_member(workspace, role=role)
    await insert_connection(sessions, workspace, "shared")
    api = await client.as_(reader)
    assert (await api.get(connection_url(workspace, "shared"))).status_code == 200
    assert (await api.get(connections_url(workspace))).json()["totalSize"] == 1


async def test_list_returns_readable_shared_and_own_personal_connections(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin, workspace, member = await _workspace(world)
    await insert_connection(sessions, workspace, "shared-a")
    await insert_connection(sessions, workspace, "shared-b", status="reauthorization_required")
    await insert_connection(sessions, workspace, "member-own", owner=member)
    await insert_connection(sessions, workspace, "admin-own", owner=admin)
    await insert_connection(sessions, workspace, "gone", deleted_at=datetime.now(UTC))

    def codes(body: dict) -> list[str]:
        return [connection["name"].rsplit("/", 1)[-1] for connection in body["connections"]]

    member_api = await client.as_(member)
    assert codes((await member_api.get(connections_url(workspace))).json()) == ["member-own"]
    admin_api = await client.as_(admin)
    listed = (await admin_api.get(connections_url(workspace))).json()
    assert codes(listed) == ["admin-own", "shared-b", "shared-a"]
    assert listed["totalSize"] == 3
    url = connections_url(workspace)
    by_state = await admin_api.get(url, params={"filter": 'state = "REAUTHORIZATION_REQUIRED"'})
    assert codes(by_state.json()) == ["shared-b"]
    personal = await admin_api.get(url, params={"filter": f'owner = "{member_of(workspace, admin)}"'})
    assert codes(personal.json()) == ["admin-own"]
    shared = await admin_api.get(url, params={"filter": 'owner = "" AND connector = "connectors/confluence"'})
    assert codes(shared.json()) == ["shared-b", "shared-a"]
    ordered = await admin_api.get(url, params={"orderBy": "displayName", "pageSize": 2})
    assert codes(ordered.json()) == ["admin-own", "shared-a"]
    rest = await admin_api.get(
        url, params={"orderBy": "displayName", "pageSize": 2, "pageToken": ordered.json()["nextPageToken"]}
    )
    assert codes(rest.json()) == ["shared-b"]
    assert "nextPageToken" not in rest.json()
    assert (await admin_api.get(url, params={"filter": "state = BOGUS"})).status_code == 400
    outsider = await client.as_(await world.make_user())
    assert (await outsider.get(url)).status_code == 403


# -- Update and Delete ----------------------------------------------------------


async def test_update_renames_with_etag(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin, workspace, member = await _workspace(world)
    await insert_connection(sessions, workspace, "shared")
    await insert_connection(sessions, workspace, "other")
    await insert_connection(sessions, workspace, "mine", owner=member)
    api = await client.as_(admin)
    url = connection_url(workspace, "shared")
    etag = (await api.get(url)).json()["etag"]

    renamed = await api.patch(url, params={"updateMask": "displayName"}, json={"displayName": "Wiki", "etag": etag})

    assert renamed.status_code == 200
    assert renamed.json()["displayName"] == "Wiki"
    stale = await api.patch(url, json={"displayName": "Wiki 2", "etag": etag})
    assert (stale.status_code, _error(stale)) == (409, "ABORTED")
    taken = await api.patch(url, json={"displayName": "Connection other"})
    assert (taken.status_code, _error(taken)) == (409, "ALREADY_EXISTS")
    output_only = await api.patch(url, params={"updateMask": "state"}, json={"state": "FAILED"})
    assert (output_only.status_code, _error(output_only)) == (400, "INVALID_ARGUMENT")
    blank = await api.patch(url, params={"updateMask": "displayName"}, json={})
    assert blank.status_code == 400
    member_api = await client.as_(member)
    assert (await member_api.patch(url, json={"displayName": "x"})).status_code == 403
    own = await member_api.patch(connection_url(workspace, "mine"), json={"displayName": "My wiki"})
    assert own.json()["displayName"] == "My wiki"
    assert (await api.patch(connection_url(workspace, "mine"), json={"displayName": "y"})).status_code == 404


async def test_delete_revokes_and_tombstones(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin, workspace, member = await _workspace(world)
    connection = await insert_connection(sessions, workspace, "wiki", credentials=GRANT)
    used = await insert_connection(sessions, workspace, "used", credentials=GRANT)
    await insert_source(sessions, used, await world.make_collection(workspace))
    api = await client.as_(admin)

    in_use = await api.delete(connection_url(workspace, "used"))
    assert (in_use.status_code, _error(in_use)) == (400, "FAILED_PRECONDITION")
    stale = await api.delete(connection_url(workspace, "wiki"), params={"etag": "stale"})
    assert stale.status_code == 409
    assert (await (await client.as_(member)).delete(connection_url(workspace, "wiki"))).status_code == 403
    etag = (await api.get(connection_url(workspace, "wiki"))).json()["etag"]

    deleted = await api.delete(connection_url(workspace, "wiki"), params={"etag": etag})

    assert deleted.status_code == 200
    assert deleted.json() == {}
    assert (await api.get(connection_url(workspace, "wiki"))).status_code == 404
    assert await stored_credentials(sessions, connection.id) is None
    row = await connection_row(sessions, workspace, "wiki")
    assert row.deleted_at is not None
    # IDs stay reserved after deletion.
    reused = await api.post(
        connections_url(workspace), params={"connectionId": "wiki"}, json={"connector": CONFLUENCE}
    )
    assert reused.status_code == 409


# -- Reauthorize, Test and Browse --------------------------------------------------


async def test_reauthorize_restarts_the_consent_of_the_same_connection(
    client: ApiClient, world: World, atlassian: FakeAtlassian
) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    active = await connect(api, workspace, "wiki")
    url = connection_url(workspace, "wiki", "reauthorize")

    stale = await api.post(url, json={"etag": "stale"})
    assert stale.status_code == 409
    response = await api.post(url, json={"etag": active["etag"]})

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "AUTHORIZING"
    assert body["authorizationUri"]
    page = await callback(api, body["authorizationUri"], code="again")
    assert f'"connection": "workspaces/{workspace.id}/connections/wiki"' in page.text
    assert (await api.get(connection_url(workspace, "wiki"))).json()["state"] == "ACTIVE"
    assert atlassian.exchanges == 2


async def test_reauthorize_needs_an_active_oauth_connector(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin, workspace, member = await _workspace(world)
    await insert_connection(sessions, workspace, "wiki", credentials=GRANT)
    platform = await client.as_(await world.platform_admin(await world.make_user()))
    await platform.post("/api/v1/connectors/confluence:disable", json={})
    api = await client.as_(admin)
    url = connection_url(workspace, "wiki", "reauthorize")

    disabled = await api.post(url, json={})
    assert (disabled.status_code, _error(disabled)) == (400, "FAILED_PRECONDITION")
    assert (await (await client.as_(member)).post(url, json={})).status_code == 403


async def test_test_reports_and_records_the_connection_health(
    client: ApiClient, world: World, sessions: Sessions, atlassian: FakeAtlassian
) -> None:
    admin, workspace, _ = await _workspace(world)
    soon = datetime.now(UTC) + timedelta(minutes=1)
    refreshable = await insert_connection(
        sessions, workspace, "fine", credentials=GRANT, expires_at=soon, account_id="acct-1"
    )
    lapsed = {"access_token": "old", "cloud_id": "cloud"}
    await insert_connection(
        sessions, workspace, "lapsed", credentials=lapsed, expires_at=soon, account_id="acct-2"
    )
    await insert_connection(sessions, workspace, "pending", status="authorizing")
    api = await client.as_(admin)

    fine = await api.post(connection_url(workspace, "fine", "test"), json={})
    assert fine.status_code == 200
    assert fine.json()["ok"] is True
    assert fine.json()["connection"]["state"] == "ACTIVE"
    assert "lastCheckTime" in fine.json()["connection"]
    renewed = await stored_credentials(sessions, refreshable.id)
    assert renewed is not None and renewed["access_token"] == "access-1"

    lapsed_result = await api.post(connection_url(workspace, "lapsed", "test"), json={})
    assert lapsed_result.status_code == 200
    assert lapsed_result.json()["ok"] is False
    assert "refresh token" in lapsed_result.json()["message"]
    assert lapsed_result.json()["connection"]["state"] == "REAUTHORIZATION_REQUIRED"
    persisted = await connection_row(sessions, workspace, "lapsed")
    assert persisted.status == "reauthorization_required"
    assert persisted.last_checked_at is not None

    pending = await api.post(connection_url(workspace, "pending", "test"), json={})
    assert (pending.status_code, _error(pending)) == (400, "FAILED_PRECONDITION")


@pytest.mark.parametrize("state", ["authorizing", "reauthorization_required", "failed"])
async def test_test_needs_an_active_connection(
    client: ApiClient, world: World, sessions: Sessions, state: str
) -> None:
    admin, workspace, _ = await _workspace(world)
    await insert_connection(sessions, workspace, "idle", status=state, credentials=GRANT)

    response = await (await client.as_(admin)).post(
        connection_url(workspace, "idle", "test"), json={}
    )

    assert (response.status_code, _error(response)) == (400, "FAILED_PRECONDITION")
    assert response.json()["error"]["details"][0]["reason"] == "CONNECTION_NOT_ACTIVE"
    assert (await connection_row(sessions, workspace, "idle")).last_checked_at is None


async def test_test_without_credentials_requires_reauthorization(
    client: ApiClient, world: World, sessions: Sessions, atlassian: FakeAtlassian
) -> None:
    admin, workspace, member = await _workspace(world)
    await insert_connection(sessions, workspace, "empty")
    api = await client.as_(admin)

    result = (await api.post(connection_url(workspace, "empty", "test"), json={})).json()

    assert result["ok"] is False
    assert result["connection"]["state"] == "REAUTHORIZATION_REQUIRED"
    member_api = await client.as_(member)
    assert (await member_api.post(connection_url(workspace, "empty", "test"), json={})).status_code == 403


async def test_browse_lists_what_the_account_reaches(
    client: ApiClient, world: World, sessions: Sessions, atlassian: FakeAtlassian
) -> None:
    admin, workspace, member = await _workspace(world)
    await connect(await client.as_(admin), workspace, "wiki")
    await insert_connection(sessions, workspace, "pending", status="authorizing")
    personal = await insert_connection(
        sessions, workspace, "mine", owner=member, credentials=GRANT, account_id="acct-mine"
    )
    api = await client.as_(admin)
    url = connection_url(workspace, "wiki", "browseResources")

    first = (await api.get(url, params={"pageSize": 2})).json()
    second = (await api.get(url, params={"pageSize": 2, "pageToken": first["nextPageToken"]})).json()

    assert first["resources"][0] == {
        "resourceId": "ENG",
        "displayName": "Engineering",
        "type": "space",
        "path": "ENG",
        "hasChildren": False,
    }
    assert [r["resourceId"] for r in first["resources"] + second["resources"]] == ["ENG", "DATA", "HR"]
    assert "nextPageToken" not in second
    assert (await api.get(url, params={"path": "ENG"})).json()["resources"] == []
    pending = await api.get(connection_url(workspace, "pending", "browseResources"))
    assert (pending.status_code, _error(pending)) == (400, "FAILED_PRECONDITION")
    member_api = await client.as_(member)
    assert (await member_api.get(url)).status_code == 403
    own = await member_api.get(connection_url(workspace, "mine", "browseResources"))
    assert own.status_code == 200, own.text
    assert len(own.json()["resources"]) == 3
    assert personal.owner_user_id == member.id


async def test_audit_records_connection_writes(
    client: ApiClient, world: World, sessions: Sessions, atlassian: FakeAtlassian
) -> None:
    admin, workspace, _ = await _workspace(world)
    api = await client.as_(admin)
    await connect(api, workspace, "wiki")
    await api.patch(connection_url(workspace, "wiki"), json={"displayName": "Wiki"})
    await api.delete(connection_url(workspace, "wiki"))
    async with sessions.begin() as session:
        actions = list(
            await session.scalars(
                select(AuditLog.action)
                .where(AuditLog.tenant_id == workspace.id)
                .order_by(AuditLog.created_at)
            )
        )
    assert actions == [
        "CreateConnection",
        "CompleteConnectionAuthorization",
        "UpdateConnection",
        "DeleteConnection",
    ]
    async with sessions.begin() as session:
        assert (
            await session.scalar(
                select(IntegrationConnection.deleted_at).where(IntegrationConnection.code == "wiki")
            )
            is not None
        )

"""Connectors: the platform catalog, its visibility, OAuth client settings and enable/disable."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from bomesh.services.ingestion.connection_store import connector_is_active
from bomesh.db.models import AuditLog, PlatformConnectorSettings
from bomesh.services.ingestion.credentials import open_client_secret
from connections_support import (
    CONFLUENCE,
    connections_url,
    insert_connection,
    insert_connector_request,
)
from harness import ENCRYPTION_KEY, ApiClient, Sessions, World

pytestmark = pytest.mark.asyncio

ALL = ["confluence", "google_drive", "notion", "sharepoint", "slack"]


async def _admin(client: ApiClient, world: World) -> ApiClient:
    return await client.as_(await world.platform_admin(await world.make_user()))


async def _operator(client: ApiClient, world: World) -> ApiClient:
    return await client.as_(await world.platform_operator(await world.make_user()))


async def _member(client: ApiClient, world: World) -> ApiClient:
    workspace = await world.make_workspace(await world.make_user())
    return await client.as_(await world.add_member(workspace))


def _keys(body: dict) -> list[str]:
    return [connector["name"].removeprefix("connectors/") for connector in body["connectors"]]


# -- List / Get ------------------------------------------------------------------


async def test_platform_staff_list_the_whole_catalog_with_usage(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    owner = await world.make_user()
    first, second = await world.make_workspace(owner), await world.make_workspace(owner)
    await insert_connection(sessions, first, "a")
    await insert_connection(sessions, first, "b")
    await insert_connection(sessions, second, "c")
    await insert_connection(sessions, second, "gone", deleted_at=datetime.now(UTC))
    await insert_connector_request(sessions, first, owner, "notion", state="open")
    await insert_connector_request(sessions, second, owner, "notion", state="needs_info")
    await insert_connector_request(sessions, first, await world.add_member(first), "notion", state="denied")
    operator = await _operator(client, world)

    body = (await operator.get("/api/v1/connectors")).json()

    assert sorted(_keys(body)) == ALL
    assert body["totalSize"] == 5
    by_key = {connector["name"]: connector for connector in body["connectors"]}
    confluence = by_key[CONFLUENCE]
    assert confluence["state"] == "ACTIVE"
    assert confluence["authenticationType"] == "OAUTH"
    assert confluence["displayName"] == "Confluence"
    assert confluence["workspaceCount"] == 2
    assert confluence["requestCount"] == 0
    assert confluence["oauthClient"] == {"clientId": "client", "secretConfigured": True}
    assert by_key["connectors/notion"]["requestCount"] == 2
    assert by_key["connectors/notion"]["state"] == "UNSUPPORTED"
    assert by_key["connectors/google_drive"]["oauthClient"] == {"secretConfigured": False}
    assert "etag" in confluence


async def test_connector_lists_filter_order_and_page(client: ApiClient, world: World) -> None:
    operator = await _operator(client, world)

    unsupported = (
        await operator.get("/api/v1/connectors", params={"filter": 'state = "UNSUPPORTED"'})
    ).json()
    assert sorted(_keys(unsupported)) == ["notion", "sharepoint", "slack"]
    ordered = (await operator.get("/api/v1/connectors", params={"orderBy": "name desc"})).json()
    assert _keys(ordered) == sorted(ALL, reverse=True)
    first = (await operator.get("/api/v1/connectors", params={"pageSize": 2})).json()
    assert _keys(first) == ["confluence", "google_drive"]
    second = (
        await operator.get(
            "/api/v1/connectors", params={"pageSize": 2, "pageToken": first["nextPageToken"]}
        )
    ).json()
    assert _keys(second) == ["notion", "sharepoint"]
    bad = await operator.get("/api/v1/connectors", params={"filter": 'owner = "x"'})
    assert bad.status_code == 400


async def test_members_see_active_connectors_only_without_usage(
    client: ApiClient, world: World
) -> None:
    member = await _member(client, world)
    admin = await _admin(client, world)
    await admin.post("/api/v1/connectors/google_drive:disable", json={})

    body = (await member.get("/api/v1/connectors")).json()

    assert _keys(body) == ["confluence"]
    assert body["totalSize"] == 1
    assert "workspaceCount" not in body["connectors"][0]
    assert "requestCount" not in body["connectors"][0]
    got = await member.get("/api/v1/connectors/confluence")
    assert got.status_code == 200
    assert "workspaceCount" not in got.json()
    for key in ("google_drive", "sharepoint", "missing"):
        denied = await member.get(f"/api/v1/connectors/{key}")
        assert denied.status_code == 403, key
        assert denied.json()["error"]["status"] == "PERMISSION_DENIED"


async def test_outsiders_cannot_read_the_catalog(client: ApiClient, world: World) -> None:
    outsider = await client.as_(await world.make_user())
    assert (await outsider.get("/api/v1/connectors")).status_code == 403
    assert (await outsider.get("/api/v1/connectors/confluence")).status_code == 403


async def test_platform_get_of_an_unknown_connector_is_not_found(
    client: ApiClient, world: World
) -> None:
    operator = await _operator(client, world)
    assert (await operator.get("/api/v1/connectors/sharepoint")).json()["state"] == "UNSUPPORTED"
    assert (await operator.get("/api/v1/connectors/missing")).status_code == 404


# -- Update ----------------------------------------------------------------------


async def test_update_overrides_the_catalog_and_stores_the_secret_encrypted(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin = await _admin(client, world)
    etag = (await admin.get("/api/v1/connectors/google_drive")).json()["etag"]

    response = await admin.patch(
        "/api/v1/connectors/google_drive",
        params={"updateMask": "displayName,oauthClient"},
        json={
            "displayName": "Company Drive",
            "oauthClient": {"clientId": "drive-client", "clientSecret": "drive-secret"},
            "etag": etag,
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["displayName"] == "Company Drive"
    assert body["oauthClient"] == {"clientId": "drive-client", "secretConfigured": True}
    assert "drive-secret" not in response.text
    assert body["etag"] != etag
    async with sessions.begin() as session:
        settings = await session.get(PlatformConnectorSettings, "google_drive")
        assert settings is not None
        assert settings.oauth_client_secret_encrypted is not None
        assert b"drive-secret" not in settings.oauth_client_secret_encrypted
        assert (
            open_client_secret(ENCRYPTION_KEY, "google_drive", settings.oauth_client_secret_encrypted)
            == "drive-secret"
        )
        audit = await session.scalar(
            select(AuditLog).where(AuditLog.action == "UpdateConnector")
        )
        assert audit is not None and audit.tenant_id is None
    stale = await admin.patch(
        "/api/v1/connectors/google_drive",
        params={"updateMask": "description"},
        json={"description": "x", "etag": etag},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["status"] == "ABORTED"
    cleared = await admin.patch(
        "/api/v1/connectors/google_drive",
        params={"updateMask": "displayName,oauthClient.clientSecret"},
        json={},
    )
    assert cleared.json()["displayName"] == "Google Drive"
    assert cleared.json()["oauthClient"] == {"clientId": "drive-client", "secretConfigured": False}


async def test_update_rejects_output_only_paths_and_needs_the_platform_permission(
    client: ApiClient, world: World
) -> None:
    admin = await _admin(client, world)
    bad = await admin.patch(
        "/api/v1/connectors/confluence", params={"updateMask": "state"}, json={"state": "DISABLED"}
    )
    assert bad.status_code == 400
    assert bad.json()["error"]["status"] == "INVALID_ARGUMENT"
    assert (await admin.patch("/api/v1/connectors/missing", json={"displayName": "x"})).status_code == 404
    operator = await _operator(client, world)
    member = await _member(client, world)
    for caller in (operator, member):
        denied = await caller.patch("/api/v1/connectors/confluence", json={"displayName": "x"})
        assert denied.status_code == 403


async def test_the_stored_oauth_client_drives_the_authorization_uri(
    client: ApiClient, world: World
) -> None:
    admin = await _admin(client, world)
    await admin.patch(
        "/api/v1/connectors/confluence",
        params={"updateMask": "oauthClient.clientId"},
        json={"oauthClient": {"clientId": "platform-client"}},
    )
    owner = await world.make_user()
    workspace = await world.make_workspace(owner)
    api = await client.as_(owner)

    created = (await api.post(connections_url(workspace), json={"connector": CONFLUENCE})).json()

    assert "client_id=platform-client" in created["authorizationUri"]


# -- Enable / Disable --------------------------------------------------------------


async def test_disable_and_enable_move_the_state(
    client: ApiClient, world: World, sessions: Sessions
) -> None:
    admin = await _admin(client, world)

    disabled = await admin.post("/api/v1/connectors/confluence:disable", json={})
    assert disabled.status_code == 200
    assert disabled.json()["state"] == "DISABLED"
    async with sessions.begin() as session:
        assert await connector_is_active(session, "confluence") is False
    again = await admin.post("/api/v1/connectors/confluence:disable", json={})
    assert again.status_code == 400
    assert again.json()["error"]["status"] == "FAILED_PRECONDITION"
    stale = await admin.post(
        "/api/v1/connectors/confluence:enable", json={"etag": "stale"}
    )
    assert stale.status_code == 409
    enabled = await admin.post(
        "/api/v1/connectors/confluence:enable", json={"etag": disabled.json()["etag"]}
    )
    assert enabled.json()["state"] == "ACTIVE"
    async with sessions.begin() as session:
        assert await connector_is_active(session, "confluence") is True
        assert await connector_is_active(session, "slack") is False
        actions = set(
            await session.scalars(
                select(AuditLog.action).where(AuditLog.target_name == "connectors/confluence")
            )
        )
    assert {"DisableConnector", "EnableConnector"} <= actions
    assert (await admin.post("/api/v1/connectors/confluence:enable", json={})).status_code == 400


async def test_enable_needs_a_supported_connector_with_an_oauth_secret(
    client: ApiClient, world: World
) -> None:
    admin = await _admin(client, world)
    unsupported = await admin.post("/api/v1/connectors/sharepoint:enable", json={})
    assert unsupported.status_code == 400
    assert (await admin.post("/api/v1/connectors/sharepoint:disable", json={})).status_code == 400
    await admin.post("/api/v1/connectors/google_drive:disable", json={})
    no_secret = await admin.post("/api/v1/connectors/google_drive:enable", json={})
    assert no_secret.status_code == 400
    assert "secret" in no_secret.json()["error"]["message"]
    await admin.patch(
        "/api/v1/connectors/google_drive",
        params={"updateMask": "oauthClient.clientSecret"},
        json={"oauthClient": {"clientSecret": "s"}},
    )
    assert (await admin.post("/api/v1/connectors/google_drive:enable", json={})).json()[
        "state"
    ] == "ACTIVE"


async def test_only_platform_admins_enable_and_disable(client: ApiClient, world: World) -> None:
    operator = await _operator(client, world)
    member = await _member(client, world)
    for caller in (operator, member):
        assert (await caller.post("/api/v1/connectors/confluence:disable", json={})).status_code == 403
        assert (await caller.post("/api/v1/connectors/confluence:enable", json={})).status_code == 403

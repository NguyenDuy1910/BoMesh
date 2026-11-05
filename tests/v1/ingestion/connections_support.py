"""Factories and flows of the connector, ingestion policy and connection tests."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
from sqlalchemy import select

from bomesh.db.models import (
    IngestionSource,
    IntegrationConnection,
    Item,
    Request,
    Tenant,
    User,
)
from bomesh.services.ingestion.credentials import IntegrationCredentialService
from harness import ENCRYPTION_KEY, ApiClient, Sessions

CONFLUENCE = "connectors/confluence"


def connections_url(workspace: Tenant, *rest: str) -> str:
    """``/api/v1/workspaces/{workspace}/connections[/{connection}[:verb]]``."""
    url = f"/api/v1/workspaces/{workspace.id}/connections"
    return "/".join([url, *rest]) if rest else url


def connection_url(workspace: Tenant, code: str, verb: str = "") -> str:
    return f"{connections_url(workspace, code)}{f':{verb}' if verb else ''}"


def member_of(workspace: Tenant, user: User) -> str:
    return f"workspaces/{workspace.id}/members/{user.id}"


def state_of(authorization_uri: str) -> str:
    """The sealed ``state`` parameter of an authorization URI."""
    return parse_qs(urlparse(authorization_uri).query)["state"][0]


async def callback(api: ApiClient, authorization_uri: str, code: str = "code-1") -> httpx.Response:
    """The provider's redirect back to ``GET /oauth/callback`` (no bearer token needed)."""
    return await api.http.get(
        "/oauth/callback", params={"state": state_of(authorization_uri), "code": code}
    )


async def connect(
    api: ApiClient, workspace: Tenant, code: str, *, owner: User | None = None
) -> dict[str, Any]:
    """Create a Confluence connection and complete its consent; the ACTIVE connection."""
    created = await api.post(
        connections_url(workspace),
        params={"connectionId": code},
        json={"connector": CONFLUENCE, "owner": member_of(workspace, owner) if owner else ""},
    )
    assert created.status_code == 200, created.text
    page = await callback(api, created.json()["authorizationUri"])
    assert page.status_code == 200, page.text
    body = (await api.get(connection_url(workspace, code))).json()
    assert body["state"] == "ACTIVE", body
    return body


async def insert_connection(
    sessions: Sessions,
    workspace: Tenant,
    code: str,
    *,
    owner: User | None = None,
    status: str = "active",
    connector_key: str = "confluence",
    credentials: Mapping[str, Any] | None = None,
    expires_at: datetime | None = None,
    account_id: str | None = None,
    deleted_at: datetime | None = None,
) -> IntegrationConnection:
    """A connection row (with encrypted credentials) written below the API."""
    async with sessions.begin() as session:
        connection = IntegrationConnection(
            tenant_id=workspace.id,
            code=code,
            connector_key=connector_key,
            owner_user_id=owner.id if owner else None,
            display_name=f"Connection {code}",
            status=status,
            provider_account_id=account_id,
            provider_account_label="someone@example.com" if account_id else None,
            expires_at=expires_at,
            deleted_at=deleted_at,
        )
        session.add(connection)
        await session.flush()
        if credentials is not None:
            await IntegrationCredentialService(session, ENCRYPTION_KEY).store(
                connection.id,
                credential_type="oauth_grant",
                payload=credentials,
                expires_at=expires_at,
            )
    return connection


async def insert_source(
    sessions: Sessions, connection: IntegrationConnection, target: Item
) -> IngestionSource:
    async with sessions.begin() as session:
        source = IngestionSource(
            tenant_id=connection.tenant_id,
            code=f"source-{uuid4().hex[:8]}",
            integration_connection_id=connection.id,
            target_item_id=target.id,
            resource_type="space",
            external_resource_id="ENG",
        )
        session.add(source)
    return source


async def insert_connector_request(
    sessions: Sessions, workspace: Tenant, requester: User, connector_key: str, *, state: str
) -> None:
    async with sessions.begin() as session:
        session.add(
            Request(
                tenant_id=workspace.id,
                kind="connector",
                connector_key=connector_key,
                requester_user_id=requester.id,
                state=state,
            )
        )


async def stored_credentials(sessions: Sessions, connection_id: Any) -> dict[str, Any] | None:
    """The decrypted credential payload, or None when cleared or absent."""
    async with sessions.begin() as session:
        try:
            return await IntegrationCredentialService(session, ENCRYPTION_KEY).resolve(
                connection_id
            )
        except LookupError:
            return None


async def connection_row(sessions: Sessions, workspace: Tenant, code: str) -> IntegrationConnection:
    async with sessions.begin() as session:
        row = await session.scalar(
            select(IntegrationConnection).where(
                IntegrationConnection.tenant_id == workspace.id,
                IntegrationConnection.code == code,
            )
        )
    assert row is not None
    return row

"""Factories and helpers of the source, sync and source-sync engine tests."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import httpx
from sqlalchemy import select, update

from bomesh.db.models import (
    IngestionSource,
    IngestionSync,
    IntegrationConnection,
    Item,
    PlatformConnectorSettings,
    Tenant,
    User,
)
from bomesh.services.ingestion.credentials import IntegrationCredentialService
from fakes import FakeWorkflows
from harness import ENCRYPTION_KEY, ApiClient, Sessions, World

#: A custom workspace role: every Source and Sync method, no item permissions.
SOURCE_MANAGER_PERMISSIONS = (
    "sources.create",
    "sources.get",
    "sources.list",
    "sources.update",
    "sources.delete",
    "sources.pause",
    "sources.resume",
    "syncs.create",
    "syncs.get",
    "syncs.list",
)
#: A custom collection role that may add items but not publish them.
DRAFTER_PERMISSIONS = ("items.get", "items.list", "items.create")


@dataclass(slots=True)
class Scene:
    """One workspace with what the source and sync tests need.

    ``admin`` (workspaceAdmin) may do everything. ``colleague`` is another
    workspace admin owning the personal connection ``personal``. ``manager``
    holds every ``sources.*``/``syncs.*`` permission but items only through
    grants: collectionEditor on ``handbook``, a create-only role on ``drafts``,
    nothing on ``board``. ``member`` is a plain workspace member. ``shared`` is
    an ACTIVE workspace connection; ``broken`` needs reauthorization.
    """

    workspace: Tenant
    admin: User
    colleague: User
    manager: User
    member: User
    handbook: Item
    drafts: Item
    board: Item
    document: Item
    shared: IntegrationConnection
    personal: IntegrationConnection
    broken: IntegrationConnection
    as_admin: ApiClient
    as_colleague: ApiClient
    as_manager: ApiClient
    as_member: ApiClient


async def build_scene(client: ApiClient, world: World, sessions: Sessions) -> Scene:
    admin = await world.make_user()
    workspace = await world.make_workspace(admin)
    colleague = await world.add_member(workspace, role="roles/workspaceAdmin")
    manager_role = await world.make_role(workspace, "source-manager", SOURCE_MANAGER_PERMISSIONS)
    manager = await world.add_member(workspace, role=manager_role)
    member = await world.add_member(workspace)
    drafter = await world.make_role(workspace, "drafter", DRAFTER_PERMISSIONS)
    handbook = await world.make_collection(
        workspace, title="Handbook", grants={manager: "roles/collectionEditor"}
    )
    drafts = await world.make_collection(workspace, title="Drafts", grants={manager: drafter})
    board = await world.make_collection(workspace, title="Board")
    document = await world.make_document(handbook, title="Policy")
    return Scene(
        workspace=workspace,
        admin=admin,
        colleague=colleague,
        manager=manager,
        member=member,
        handbook=handbook,
        drafts=drafts,
        board=board,
        document=document,
        shared=await make_connection(sessions, workspace, "shared-drive"),
        personal=await make_connection(sessions, workspace, "my-drive", owner=colleague),
        broken=await make_connection(
            sessions, workspace, "broken-drive", status="reauthorization_required"
        ),
        as_admin=await client.as_(admin),
        as_colleague=await client.as_(colleague),
        as_manager=await client.as_(manager),
        as_member=await client.as_(member),
    )


async def make_connection(
    sessions: Sessions,
    workspace: Tenant,
    code: str,
    *,
    owner: User | None = None,
    status: str = "active",
    connector_key: str = "confluence",
) -> IntegrationConnection:
    """A connection row with a stored OAuth grant (no provider round trip)."""
    async with sessions.begin() as session:
        connection = IntegrationConnection(
            id=uuid4(),
            tenant_id=workspace.id,
            code=code,
            connector_key=connector_key,
            owner_user_id=owner.id if owner is not None else None,
            display_name=f"Connection {code}",
            status=status,
            connected_at=datetime.now(UTC),
        )
        session.add(connection)
        await session.flush()
        await IntegrationCredentialService(session, ENCRYPTION_KEY).store(
            connection.id,
            credential_type="oauth_grant",
            payload={"access_token": "token", "refresh_token": "refresh"},
        )
    return connection


# -- URLs and bodies --------------------------------------------------------------


def sources_url(workspace: Tenant, *rest: str) -> str:
    """``/api/v1/workspaces/{workspace}/sources[/{source}[/...]]``."""
    url = f"/api/v1/workspaces/{workspace.id}/sources"
    return "/".join([url, *rest]) if rest else url


def source_url(workspace: Tenant, code: str, verb: str = "") -> str:
    return f"{sources_url(workspace, code)}{f':{verb}' if verb else ''}"


def syncs_url(workspace: Tenant, code: str, *rest: str) -> str:
    return "/".join([sources_url(workspace, code, "syncs"), *rest])


def connection_ref(workspace: Tenant, connection: IntegrationConnection) -> str:
    return f"workspaces/{workspace.id}/connections/{connection.code}"


def item_ref(item: Item) -> str:
    return f"workspaces/{item.tenant_id}/items/{item.id}"


def source_body(
    scene: Scene,
    *,
    connection: IntegrationConnection | None = None,
    target: Item | None = None,
    resource_id: str | None = None,
    **fields: Any,
) -> dict[str, Any]:
    """A CreateSource body for a Confluence space (a new space key unless given)."""
    return {
        "connection": connection_ref(scene.workspace, connection or scene.shared),
        "targetCollection": item_ref(target or scene.handbook),
        "externalResource": {
            "type": "space",
            "resourceId": resource_id or f"SPACE{uuid4().hex[:6].upper()}",
            "displayName": "Policies space",
        },
        **fields,
    }


async def create_source(
    api: ApiClient, scene: Scene, source_id: str | None = None, **fields: Any
) -> dict[str, Any]:
    params = {"sourceId": source_id} if source_id else {}
    response = await api.post(
        sources_url(scene.workspace), json=source_body(scene, **fields), params=params
    )
    assert response.status_code == 200, response.text
    return response.json()


def code_of(name: str) -> str:
    """The last ID of a resource name."""
    return name.rsplit("/", 1)[-1]


def reason(response: httpx.Response) -> str | None:
    for detail in response.json()["error"].get("details", []):
        if detail.get("@type", "").endswith("ErrorInfo"):
            return detail.get("reason")
    return None


def status(response: httpx.Response) -> str:
    return response.json()["error"]["status"]


# -- Database state ---------------------------------------------------------------


async def source_row(sessions: Sessions, workspace: Tenant, code: str) -> IngestionSource:
    async with sessions() as session:
        source = await session.scalar(
            select(IngestionSource).where(
                IngestionSource.tenant_id == workspace.id, IngestionSource.code == code
            )
        )
    assert source is not None
    return source


async def syncs_of(sessions: Sessions, source_id: UUID) -> list[IngestionSync]:
    async with sessions() as session:
        return list(
            await session.scalars(
                select(IngestionSync)
                .where(IngestionSync.ingestion_source_id == source_id)
                .order_by(IngestionSync.started_at)
            )
        )


async def end_sync(
    sessions: Sessions,
    workflows: FakeWorkflows,
    source_id: UUID,
    *,
    failed: bool = False,
) -> None:
    """What the worker does when a sync ends: the row is final and the workflow closed."""
    async with sessions.begin() as session:
        await session.execute(
            update(IngestionSync)
            .where(
                IngestionSync.ingestion_source_id == source_id,
                IngestionSync.status == "running",
            )
            .values(
                status="failed" if failed else "succeeded",
                finished_at=datetime.now(UTC),
                error={"code": 9, "message": "The sync failed."} if failed else None,
            )
        )
    workflows.finish_sync(source_id)


async def set_connection_status(
    sessions: Sessions, connection: IntegrationConnection, status_value: str
) -> None:
    async with sessions.begin() as session:
        await session.execute(
            update(IntegrationConnection)
            .where(IntegrationConnection.id == connection.id)
            .values(status=status_value)
        )


async def disable_connector(sessions: Sessions, connector_key: str) -> None:
    async with sessions.begin() as session:
        session.add(PlatformConnectorSettings(connector_key=connector_key, available=False))


async def pause_ingestion(sessions: Sessions, workspace: Tenant) -> None:
    async with sessions.begin() as session:
        await session.execute(
            update(Tenant)
            .where(Tenant.id == workspace.id)
            .values(ingestion_paused_at=datetime.now(UTC))
        )


async def set_default_policy(sessions: Sessions, workspace: Tenant, policy: str) -> None:
    async with sessions.begin() as session:
        tenant = await session.get(Tenant, workspace.id)
        assert tenant is not None
        tenant.settings = {**tenant.settings, "default_publishing_policy": policy}

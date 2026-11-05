"""Connection messages."""

from __future__ import annotations

from uuid import UUID

from pydantic import Field
from sqlalchemy import func

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import IntegrationConnection
from bomesh.errors import InvalidArgument
from bomesh.services.ingestion.common import parse_uuid
from bomesh.services.ingestion.connections import (
    BrowsedResource,
    ConnectionTest,
    ConnectionView,
)
from bomesh.services.workspaces.records import member_name

CONNECTION_FIELDS = MutableFields(("displayName",))
CONNECTION_STATES = ("AUTHORIZING", "ACTIVE", "REAUTHORIZATION_REQUIRED", "FAILED")


class ConnectionAccount(ProtoMessage):
    display_name: str | None = None
    resource_label: str | None = None


class ConnectionMessage(ProtoMessage):
    name: str | None = None
    connector: str | None = None
    display_name: str | None = None
    owner: str | None = None
    account: ConnectionAccount | None = None
    state: str | None = None
    authorization_uri: str | None = None
    api_token: str | None = Field(default=None, json_schema_extra={"writeOnly": True})
    config: dict[str, str] | None = None
    last_check_time: Timestamp | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    etag: str | None = None


class ListConnectionsResponse(ProtoMessage):
    connections: list[ConnectionMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class ReauthorizeConnectionRequest(ProtoMessage):
    etag: str | None = None


class TestConnectionRequest(ProtoMessage):
    """Empty body; the connection is named by the path."""


class TestConnectionResponse(ProtoMessage):
    ok: bool
    message: str
    connection: ConnectionMessage


class ConnectionResourceMessage(ProtoMessage):
    resource_id: str
    display_name: str
    type: str
    path: str
    has_children: bool


class BrowseConnectionResourcesResponse(ProtoMessage):
    resources: list[ConnectionResourceMessage]
    next_page_token: str | None = None


def connection_message(view: ConnectionView) -> ConnectionMessage:
    connection = view.connection
    account = (
        ConnectionAccount(
            display_name=connection.provider_account_label,
            resource_label=connection.provider_resource_label,
        )
        if connection.provider_account_label or connection.provider_resource_label
        else None
    )
    return ConnectionMessage(
        name=view.name,
        connector=f"connectors/{connection.connector_key}",
        display_name=connection.display_name,
        owner=(
            member_name(connection.tenant_id, connection.owner_user_id)
            if connection.owner_user_id is not None
            else None
        ),
        account=account,
        state=connection.status.upper(),
        authorization_uri=view.authorization_uri,
        config={key: str(value) for key, value in connection.config.items()} or None,
        last_check_time=connection.last_checked_at,
        create_time=connection.created_at,
        update_time=connection.updated_at,
        etag=view.etag,
    )


def connection_test_response(result: ConnectionTest) -> TestConnectionResponse:
    return TestConnectionResponse(
        ok=result.ok, message=result.message, connection=connection_message(result.connection)
    )


def resource_message(resource: BrowsedResource) -> ConnectionResourceMessage:
    return ConnectionResourceMessage(
        resource_id=resource.resource_id,
        display_name=resource.display_name,
        type=resource.type,
        path=resource.path,
        has_children=resource.has_children,
    )


def parse_connector(name: str | None) -> str:
    """The connector ID of ``connectors/{connector}`` (required)."""
    if not name:
        raise InvalidArgument.for_field("connector", "connector is required.")
    collection, _, key = name.partition("/")
    if collection != "connectors" or not key or "/" in key:
        raise InvalidArgument.for_field("connector", f"'{name}' is not a connector name.")
    return key


def parse_owner(name: str | None, *, workspace_id: UUID) -> UUID | None:
    """The user of ``workspaces/{workspace}/members/{member}``; empty = workspace-owned."""
    if not name:
        return None
    parts = name.split("/")
    if len(parts) != 4 or parts[0] != "workspaces" or parts[2] != "members":
        raise InvalidArgument.for_field("owner", f"'{name}' is not a member name.")
    if parts[1] != str(workspace_id):
        raise InvalidArgument.for_field("owner", f"'{name}' is not a member of this workspace.")
    return parse_uuid(parts[3], field="owner")


def _owner_reference(name: str) -> UUID | None:
    if not name:
        return None
    parts = name.split("/")
    if len(parts) != 4 or parts[0] != "workspaces" or parts[2] != "members":
        raise ValueError(f"'{name}' is not a member name")
    return UUID(parts[3])


CONNECTION_FILTERS = FilterSchema(
    {
        "state": filtering.enum(func.upper(IntegrationConnection.status), CONNECTION_STATES),
        "connector": filtering.resource_name(
            IntegrationConnection.connector_key, lambda name: parse_connector(name)
        ),
        "owner": filtering.resource_name(IntegrationConnection.owner_user_id, _owner_reference),
        "displayName": filtering.string(IntegrationConnection.display_name),
        "createTime": filtering.timestamp(IntegrationConnection.created_at),
        "updateTime": filtering.timestamp(IntegrationConnection.updated_at),
    }
)
CONNECTION_ORDER = OrderSchema(
    {
        "createTime": IntegrationConnection.created_at,
        "updateTime": IntegrationConnection.updated_at,
        "displayName": IntegrationConnection.display_name,
    },
    tie_breaker=[IntegrationConnection.id],
    default="createTime desc",
)


__all__ = [
    "CONNECTION_FIELDS",
    "CONNECTION_FILTERS",
    "CONNECTION_ORDER",
    "BrowseConnectionResourcesResponse",
    "ConnectionAccount",
    "ConnectionMessage",
    "ConnectionResourceMessage",
    "ListConnectionsResponse",
    "ReauthorizeConnectionRequest",
    "TestConnectionRequest",
    "TestConnectionResponse",
    "connection_message",
    "parse_connector",
    "parse_owner",
    "resource_message",
    "connection_test_response",
]

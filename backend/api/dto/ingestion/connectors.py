"""Connector and IngestionPolicy messages (platform catalog and policy)."""

from __future__ import annotations

import re
from datetime import timedelta
from decimal import Decimal

from pydantic import Field
from sqlalchemy.sql import Subquery

from api.aip import filtering
from api.aip.fieldmask import MutableFields
from api.aip.filtering import FilterSchema
from api.aip.messages import Int64, ProtoMessage
from api.aip.ordering import OrderSchema
from bomesh.errors import InvalidArgument
from bomesh.services.ingestion import connectors, ingestion_policies
from bomesh.services.ingestion.connectors import ConnectorRecord
from bomesh.services.ingestion.ingestion_policies import IngestionPolicyRecord

_DURATION = re.compile(r"^[0-9]+(\.[0-9]+)?s$")

CONNECTOR_FIELDS = MutableFields(connectors.UPDATABLE_FIELDS)
INGESTION_POLICY_FIELDS = MutableFields(ingestion_policies.UPDATABLE_FIELDS)


class ConnectorOauthClient(ProtoMessage):
    client_id: str | None = None
    client_secret: str | None = Field(default=None, json_schema_extra={"writeOnly": True})
    secret_configured: bool | None = None


class ConnectorMessage(ProtoMessage):
    name: str | None = None
    display_name: str | None = None
    description: str | None = None
    authentication_type: str | None = None
    state: str | None = None
    oauth_client: ConnectorOauthClient | None = None
    workspace_count: int | None = None
    request_count: int | None = None
    etag: str | None = None


class ListConnectorsResponse(ProtoMessage):
    connectors: list[ConnectorMessage]
    next_page_token: str | None = None
    total_size: int | None = None


class EnableConnectorRequest(ProtoMessage):
    etag: str | None = None


class DisableConnectorRequest(ProtoMessage):
    etag: str | None = None


class IngestionPolicyMessage(ProtoMessage):
    name: str | None = None
    allowed_mime_types: list[str] | None = None
    max_file_size_bytes: Int64 | None = None
    ocr_scanned_pdfs: bool | None = None
    parse_spreadsheets: bool | None = None
    contribution_review_required: bool | None = None
    rejected_retention_duration: str | None = None
    etag: str | None = None


class ListIngestionPoliciesResponse(ProtoMessage):
    ingestion_policies: list[IngestionPolicyMessage]
    next_page_token: str | None = None
    total_size: int | None = None


def connector_message(record: ConnectorRecord) -> ConnectorMessage:
    client = record.oauth_client
    return ConnectorMessage(
        name=record.name,
        display_name=record.display_name,
        description=record.description,
        authentication_type=record.authentication_type,
        state=record.state,
        oauth_client=(
            ConnectorOauthClient(
                client_id=client.client_id, secret_configured=client.secret_configured
            )
            if client is not None
            else None
        ),
        workspace_count=record.workspace_count,
        request_count=record.request_count,
        etag=record.etag,
    )


def connector_filters(table: Subquery) -> FilterSchema:
    return FilterSchema(
        {
            "state": filtering.enum(table.c.state, ("ACTIVE", "DISABLED", "UNSUPPORTED")),
            "authenticationType": filtering.enum(
                table.c.authentication_type, ("OAUTH", "API_TOKEN", "NONE")
            ),
            "displayName": filtering.string(table.c.display_name),
        }
    )


def connector_order(table: Subquery) -> OrderSchema:
    return OrderSchema(
        {"displayName": table.c.display_name, "name": table.c.key},
        tie_breaker=[table.c.key],
        default="displayName",
    )


def ingestion_policy_message(record: IngestionPolicyRecord) -> IngestionPolicyMessage:
    policy = record.policy
    return IngestionPolicyMessage(
        name=record.name,
        allowed_mime_types=list(policy.allowed_mime_types),
        max_file_size_bytes=policy.max_file_size_bytes,
        ocr_scanned_pdfs=policy.ocr_scanned_pdfs,
        parse_spreadsheets=policy.parse_spreadsheets,
        contribution_review_required=True,
        rejected_retention_duration=format_duration(policy.rejected_retention_duration),
        etag=record.etag,
    )


def parse_duration(value: str | None, *, field: str) -> timedelta | None:
    """``google.protobuf.Duration`` JSON (``"3600s"``, ``"1.5s"``) → timedelta."""
    if value is None:
        return None
    if not _DURATION.match(value):
        raise InvalidArgument.for_field(field, f"{field} must look like '3600s'.")
    return timedelta(seconds=float(Decimal(value[:-1])))


def format_duration(value: timedelta) -> str:
    seconds = Decimal(value.days * 86_400 + value.seconds) + Decimal(value.microseconds) / 10**6
    text = format(seconds.normalize(), "f")
    return f"{text}s"


__all__ = [
    "CONNECTOR_FIELDS",
    "INGESTION_POLICY_FIELDS",
    "ConnectorMessage",
    "ConnectorOauthClient",
    "DisableConnectorRequest",
    "EnableConnectorRequest",
    "IngestionPolicyMessage",
    "ListConnectorsResponse",
    "ListIngestionPoliciesResponse",
    "connector_filters",
    "connector_message",
    "connector_order",
    "format_duration",
    "ingestion_policy_message",
    "parse_duration",
]

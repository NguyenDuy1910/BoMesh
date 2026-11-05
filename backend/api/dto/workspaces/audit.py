"""AuditEvent messages, filters and order (also used by the platform audit of Operations)."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from sqlalchemy import func

from api.aip import filtering
from api.aip.filtering import FilterSchema
from api.aip.messages import Int64, ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import AuditLog
from bomesh.db.models.workspaces import AUDIT_CATEGORIES, AUDIT_OUTCOMES
from bomesh.services.identity.records import parse_user_name
from bomesh.services.workspaces.audit_log import audit_actor, audit_description
from bomesh.services.workspaces.records import AuditBucket

AuditCategory = Literal[
    "KNOWLEDGE", "FILES", "SOURCES", "PEOPLE", "SETTINGS", "SPACES", "REQUESTS", "SIGN_IN"
]


class AuditEventMessage(ProtoMessage):
    name: str
    actor: str
    category: AuditCategory
    action: str
    description: str | None = None
    target: str | None = None
    outcome: Literal["SUCCEEDED", "FAILED"]
    ip_address: str | None = None
    create_time: Timestamp


class ListAuditEventsResponse(ProtoMessage):
    audit_events: list[AuditEventMessage]
    next_page_token: str | None = None


class ExportAuditEventsRequest(ProtoMessage):
    filter: str | None = None


class AuditBucketMessage(ProtoMessage):
    start_time: Timestamp
    category: AuditCategory
    event_count: Int64


class SummarizeAuditEventsResponse(ProtoMessage):
    buckets: list[AuditBucketMessage]


def audit_event_message(event: AuditLog, *, name: str, metadata_only: bool) -> AuditEventMessage:
    """``metadata_only`` (platform callers, ``workspaces/-``) omits target and description."""
    return AuditEventMessage(
        name=name,
        actor=audit_actor(event),
        category=event.category.upper(),  # type: ignore[arg-type]
        action=event.action,
        description=None if metadata_only else audit_description(event),
        target=None if metadata_only else event.target_name,
        outcome=event.outcome.upper(),  # type: ignore[arg-type]
        ip_address=str(event.ip_address) if event.ip_address is not None else None,
        create_time=event.created_at,
    )


def audit_bucket_message(bucket: AuditBucket) -> AuditBucketMessage:
    return AuditBucketMessage(
        start_time=bucket.start_time,
        category=bucket.category.upper(),  # type: ignore[arg-type]
        event_count=bucket.event_count,
    )


def _actor(name: str) -> UUID | None:
    return None if name == "system" else parse_user_name(name, field="filter")


#: Every audit filter field; ListAuditEvents accepts the workspace subset below.
AUDIT_FILTER_FIELDS: dict[str, filtering.FilterField] = {
    "category": filtering.enum(
        func.upper(AuditLog.category), (value.upper() for value in AUDIT_CATEGORIES)
    ),
    "actor": filtering.resource_name(AuditLog.actor_user_id, _actor),
    "outcome": filtering.enum(
        func.upper(AuditLog.outcome), (value.upper() for value in AUDIT_OUTCOMES)
    ),
    "action": filtering.string(AuditLog.action),
    "target": filtering.string(AuditLog.target_name),
    "createTime": filtering.timestamp(AuditLog.created_at),
}

WORKSPACE_AUDIT_FILTERS = FilterSchema(
    {
        field: AUDIT_FILTER_FIELDS[field]
        for field in ("category", "actor", "outcome", "createTime")
    }
)

AUDIT_ORDER = OrderSchema(
    {"createTime": AuditLog.created_at}, tie_breaker=[AuditLog.id], default="createTime desc"
)

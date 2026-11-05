"""Platform audit event messages of the Operations interface (shared with Workspaces)."""

from __future__ import annotations

from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage
from api.dto.workspaces import AUDIT_FILTER_FIELDS, AUDIT_ORDER, AuditEventMessage


class ListPlatformAuditEventsResponse(ProtoMessage):
    audit_events: list[AuditEventMessage]
    next_page_token: str | None = None


class ExportPlatformAuditEventsRequest(ProtoMessage):
    filter: str | None = None


PLATFORM_AUDIT_FILTERS = FilterSchema(AUDIT_FILTER_FIELDS)
PLATFORM_AUDIT_ORDER = AUDIT_ORDER

__all__ = [
    "PLATFORM_AUDIT_FILTERS",
    "PLATFORM_AUDIT_ORDER",
    "ExportPlatformAuditEventsRequest",
    "ListPlatformAuditEventsResponse",
]

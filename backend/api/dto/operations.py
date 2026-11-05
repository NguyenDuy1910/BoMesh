"""Operations interface messages: Operation, Component and Incident.

Platform audit messages are in :mod:`api.dto.operations_audit`, so
that interfaces whose DTO modules this module never imports can register their
operation response messages here without an import cycle.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sqlalchemy.sql import Subquery

from api.aip import filtering
from api.aip.filtering import FilterSchema
from api.aip.messages import ProtoMessage, Timestamp, format_timestamp
from api.aip.ordering import OrderSchema
from bomesh.db.models import Operation
from bomesh.errors import InvalidArgument
from bomesh.services.operations.health import ComponentRecord, IncidentRecord
from bomesh.services.operations.operations import ExportResult, OperationView

#: ``@type`` prefix of the messages inside ``Operation.metadata`` and ``.response``.
TYPE_URL_PREFIX = "type.googleapis.com/bomesh.v1."


class OperationMessage(ProtoMessage):
    """google.longrunning.Operation."""

    name: str
    metadata: dict[str, Any] | None = None
    done: bool
    error: dict[str, Any] | None = None
    response: dict[str, Any] | None = None


class ListOperationsResponse(ProtoMessage):
    operations: list[OperationMessage]
    next_page_token: str | None = None


class CancelOperationRequest(ProtoMessage):
    """Empty body; the operation is named by the path."""


class ComponentMessage(ProtoMessage):
    name: str
    display_name: str
    kind: str
    state: str | None = None
    setting: str | None = None
    model: str | None = None
    check_time: Timestamp | None = None


class ListComponentsResponse(ProtoMessage):
    components: list[ComponentMessage]
    next_page_token: str | None = None


class IncidentMessage(ProtoMessage):
    name: str
    component: str
    state: str
    error_category: str | None = None
    start_time: Timestamp
    end_time: Timestamp | None = None


class ListIncidentsResponse(ProtoMessage):
    incidents: list[IncidentMessage]
    next_page_token: str | None = None


#: Maps a resource record (a verb's result loader output) to its ``@type`` message.
ResponseMessage = Callable[[Any], ProtoMessage]
_RESPONSE_MESSAGES: dict[str, ResponseMessage] = {}


def register_response_message(type_name: str, message: ResponseMessage) -> None:
    """Render ``Operation.response`` of type ``type_name`` (e.g. ``Workspace``) with ``message``.

    The owning interface calls this from its DTO module, next to the message.
    """
    _RESPONSE_MESSAGES[type_name] = message


def operation_message(view: OperationView) -> OperationMessage:
    """The Operation message of ``view`` (``OperationService.describe``)."""
    operation = view.operation
    return OperationMessage(
        name=view.name,
        metadata=_metadata(operation, view.metadata_type),
        done=operation.finished_at is not None,
        error=operation.error,
        response=_response(view),
    )


def _metadata(operation: Operation, type_name: str) -> dict[str, Any]:
    """Exactly the verb's typed metadata message (``x-operation-info``) with its ``@type``.

    Every typed metadata carries ``createTime`` and ``progressPercent``; a
    resource-creating verb also names its resource, which is the operation's
    ``target``.
    """
    metadata: dict[str, Any] = {
        "@type": TYPE_URL_PREFIX + type_name,
        "createTime": format_timestamp(operation.created_at),
        "progressPercent": operation.progress_percent,
    }
    resource_field = _METADATA_RESOURCE_FIELDS.get(type_name)
    if resource_field is not None:
        metadata[resource_field] = operation.target
    return metadata


#: The field of a typed metadata message that names the operation's resource.
_METADATA_RESOURCE_FIELDS = {
    "CreateWorkspaceMetadata": "workspace",
    "ArtifactOperationMetadata": "artifact",
}


def _response(view: OperationView) -> dict[str, Any] | None:
    if view.response is None:
        return None
    body: dict[str, Any] = {"@type": TYPE_URL_PREFIX + view.response_type}
    if isinstance(view.response, ExportResult):
        if view.response.download_uri is not None:
            body["downloadUri"] = view.response.download_uri
        if view.response.expire_time is not None:
            body["expireTime"] = format_timestamp(view.response.expire_time)
        return body
    message = _RESPONSE_MESSAGES.get(view.response_type)
    if message is None:
        raise RuntimeError(f"no response message is registered for '{view.response_type}'")
    return body | message(view.response).model_dump(mode="json")


def component_message(record: ComponentRecord) -> ComponentMessage:
    return ComponentMessage(
        name=f"components/{record.id}",
        display_name=record.display_name,
        kind=record.kind,
        state=record.state,
        setting=record.setting,
        model=record.model,
        check_time=record.check_time,
    )


def incident_message(record: IncidentRecord) -> IncidentMessage:
    return IncidentMessage(
        name=f"incidents/{record.id}",
        component=record.component,
        state=record.state,
        error_category=record.error_category,
        start_time=record.start_time,
        end_time=record.end_time,
    )


OPERATION_FILTERS = FilterSchema(
    {
        "done": filtering.boolean(Operation.finished_at.is_not(None)),
        "metadata.verb": filtering.string(Operation.verb),
        "metadata.target": filtering.string(Operation.target),
    }
)
OPERATION_ORDER = OrderSchema(
    {"metadata.createTime": Operation.created_at},
    tie_breaker=[Operation.id],
    default="metadata.createTime desc",
)



def component_filters(table: Subquery) -> FilterSchema:
    return FilterSchema(
        {
            "kind": filtering.enum(table.c.kind, ("SERVICE", "AI_MODEL")),
            "state": filtering.enum(
                table.c.state, ("HEALTHY", "DEGRADED", "DOWN", "NOT_CONFIGURED")
            ),
        }
    )


def component_order(table: Subquery) -> OrderSchema:
    return OrderSchema(
        {"displayName": table.c.display_name, "checkTime": table.c.check_time},
        tie_breaker=[table.c.id],
        default="displayName",
    )


def incident_filters(table: Subquery) -> FilterSchema:
    return FilterSchema(
        {
            "component": filtering.resource_name(table.c.component, _component_name),
            "state": filtering.enum(table.c.state, ("ONGOING", "RESOLVED")),
            "errorCategory": filtering.string(table.c.error_category),
            "startTime": filtering.timestamp(table.c.start_time),
        }
    )


def incident_order(table: Subquery) -> OrderSchema:
    return OrderSchema(
        {"startTime": table.c.start_time},
        tie_breaker=[table.c.id],
        default="startTime desc",
    )


def _component_name(name: str) -> str:
    if not name.startswith("components/") or "/" in name.removeprefix("components/"):
        raise InvalidArgument(f"expected components/{{component}}, got {name!r}")
    return name


__all__ = [
    "TYPE_URL_PREFIX",
    "CancelOperationRequest",
    "ComponentMessage",
    "IncidentMessage",
    "ListComponentsResponse",
    "ListIncidentsResponse",
    "ListOperationsResponse",
    "OperationMessage",
    "component_message",
    "incident_message",
    "operation_message",
    "register_response_message",
]

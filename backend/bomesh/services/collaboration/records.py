"""Typed records the Collaboration services return, and the resource names they use."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any
from uuid import UUID

from bomesh import etag
from bomesh.db.models import (
    Request,
    RequestMessage,
    RequestType,
    Space,
    SpaceAnnouncement,
    SpaceEvent,
    SpaceMaterial,
)
from bomesh.errors import InvalidArgument

if TYPE_CHECKING:
    from bomesh.services.conversations.records import CitationRecord


def space_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/spaces/{code}"


def request_name(workspace_id: UUID, request_id: UUID) -> str:
    return f"workspaces/{workspace_id}/requests/{request_id}"


def parse_request(name: str, workspace_id: UUID, *, field: str) -> UUID:
    """The ID of ``workspaces/{workspace_id}/requests/{id}``; INVALID_ARGUMENT otherwise."""
    parts = name.split("/")
    if len(parts) == 4 and parts[0] == "workspaces" and parts[2] == "requests":
        try:
            parent, child = UUID(parts[1]), UUID(parts[3])
        except ValueError:
            pass
        else:
            if parent == workspace_id:
                return child
    raise InvalidArgument.for_field(field, f"'{name}' is not a request name of this workspace.")


def request_type_name(workspace_id: UUID, space_code: str, code: str) -> str:
    return f"{space_name(workspace_id, space_code)}/requestTypes/{code}"


@dataclass(frozen=True, slots=True)
class SpaceRecord:
    workspace_id: UUID
    space: Space
    member_count: int
    caller_role: str
    collections: tuple[UUID, ...]

    @property
    def name(self) -> str:
        return space_name(self.workspace_id, self.space.code)

    @property
    def etag(self) -> str:
        return etag.compute(self.name, self.space.updated_at)


@dataclass(frozen=True, slots=True)
class SpaceMemberRecord:
    workspace_id: UUID
    space_code: str
    user_id: UUID
    display_name: str
    roles: tuple[str, ...]
    join_time: datetime

    @property
    def name(self) -> str:
        return (
            f"{space_name(self.workspace_id, self.space_code)}/members/{self.user_id}"
        )


@dataclass(frozen=True, slots=True)
class SpaceChild:
    """A material, announcement or event with the names its message shows."""

    workspace_id: UUID
    space_code: str
    collection: str
    row: SpaceMaterial | SpaceAnnouncement | SpaceEvent

    @property
    def name(self) -> str:
        return f"{space_name(self.workspace_id, self.space_code)}/{self.collection}/{self.row.id}"

    @property
    def etag(self) -> str:
        return etag.compute(self.name, self.row.updated_at)


@dataclass(frozen=True, slots=True)
class RequestTypeRecord:
    workspace_id: UUID
    space_code: str
    request_type: RequestType
    #: ``policy_citation_item_id`` values the reader can read; others are not shown.
    readable_citations: frozenset[str] = frozenset()

    @property
    def name(self) -> str:
        return request_type_name(
            self.workspace_id, self.space_code, self.request_type.code
        )

    @property
    def etag(self) -> str:
        return etag.compute(self.name, self.request_type.updated_at)


@dataclass(frozen=True, slots=True)
class AssistantContext:
    """``Request.assistantContext`` rendered for one reader."""

    answer: str
    citations: tuple[CitationRecord, ...]


@dataclass(frozen=True, slots=True)
class RequestRecord:
    """A request with its references resolved to names for the reader."""

    workspace_id: UUID
    request: Request
    space_code: str | None = None
    request_type_code: str | None = None
    requested_role: str | None = None
    overdue: bool = False
    assistant_context: AssistantContext | None = None
    eligibility: dict[str, Any] | None = field(default=None)

    @property
    def name(self) -> str:
        return request_name(self.workspace_id, self.request.id)

    @property
    def etag(self) -> str:
        return etag.compute(self.name, self.request.updated_at)


@dataclass(frozen=True, slots=True)
class RequestMessageRecord:
    workspace_id: UUID
    message: RequestMessage

    @property
    def name(self) -> str:
        return f"{request_name(self.workspace_id, self.message.request_id)}/messages/{self.message.id}"


__all__ = [
    "AssistantContext",
    "RequestMessageRecord",
    "RequestRecord",
    "RequestTypeRecord",
    "SpaceChild",
    "SpaceMemberRecord",
    "SpaceRecord",
    "parse_request",
    "request_name",
    "request_type_name",
    "space_name",
]

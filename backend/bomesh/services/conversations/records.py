"""Records and resource names of the Conversations slice (``api_design.md`` §7).

Conversation IDs are ``conversations.code`` (client-chosen ``conversationId``
or ``r`` + the row uuid's hex); message and share IDs are their row uuids.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from bomesh.db.models import Conversation
from bomesh.services.kernel.retention import purge_time
from bomesh.services.knowledge_items.names import item_name

Role = Literal["USER", "ASSISTANT"]
GenerationState = Literal["COMPLETED", "INTERRUPTED", "FAILED"]
Rating = Literal["HELPFUL", "UNHELPFUL"]
Audience = Literal["WORKSPACE", "PEOPLE"]


def conversation_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/conversations/{code}"


def message_name(workspace_id: UUID, code: str, message_id: UUID) -> str:
    return f"{conversation_name(workspace_id, code)}/messages/{message_id}"


def share_name(workspace_id: UUID, code: str, share_id: UUID) -> str:
    return f"{conversation_name(workspace_id, code)}/shares/{share_id}"


def artifact_name(workspace_id: UUID, artifact_id: UUID) -> str:
    return f"workspaces/{workspace_id}/artifacts/{artifact_id}"


@dataclass(frozen=True, slots=True)
class StoredCitation:
    """One cited passage as an answer stores it (``messages.metadata.citations``)."""

    item_id: UUID
    chunk_id: str
    page: int | None
    title: str
    excerpt: str | None

    def to_json(self) -> dict[str, Any]:
        return {
            "item_id": str(self.item_id),
            "chunk_id": self.chunk_id,
            "page": self.page,
            "title": self.title,
            "excerpt": self.excerpt,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> StoredCitation:
        page = value.get("page")
        excerpt = value.get("excerpt")
        return cls(
            item_id=UUID(str(value["item_id"])),
            chunk_id=str(value["chunk_id"]),
            page=page if isinstance(page, int) else None,
            title=str(value.get("title") or ""),
            excerpt=excerpt if isinstance(excerpt, str) else None,
        )


def stored_citations(metadata: dict[str, Any]) -> tuple[StoredCitation, ...]:
    """The citations a message's metadata carries; malformed entries are skipped."""
    raw = metadata.get("citations")
    if not isinstance(raw, list):
        return ()
    citations: list[StoredCitation] = []
    for entry in raw:
        if isinstance(entry, dict) and entry.get("item_id") and entry.get("chunk_id"):
            try:
                citations.append(StoredCitation.from_json(entry))
            except ValueError:
                continue
    return tuple(citations)


@dataclass(frozen=True, slots=True)
class CitationRecord:
    """A citation rendered for one reader; unreadable → only ``available=False``."""

    available: bool
    passage: str | None = None
    item: str | None = None
    display_name: str | None = None
    page_number: int | None = None
    excerpt: str | None = None


UNAVAILABLE = CitationRecord(available=False)


@dataclass(frozen=True, slots=True)
class ConversationRecord:
    """A conversation; ``scope_*`` are resource names (collection items, spaces)."""

    workspace_id: UUID
    code: str
    owner_user_id: UUID
    display_name: str | None
    pinned: bool
    scope_collections: tuple[str, ...]
    scope_spaces: tuple[str, ...]
    last_message_at: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None

    @classmethod
    def of(cls, row: Conversation, space_names: Mapping[UUID, str]) -> ConversationRecord:
        """``space_names`` maps every ``row.scope_space_ids`` entry to its space name."""
        return cls(
            workspace_id=row.tenant_id,
            code=row.code,
            owner_user_id=row.owner_user_id,
            display_name=row.title,
            pinned=row.pinned,
            scope_collections=tuple(
                item_name(row.tenant_id, value) for value in row.scope_collection_ids
            ),
            scope_spaces=tuple(
                space_names[value] for value in row.scope_space_ids if value in space_names
            ),
            last_message_at=row.last_message_at,
            created_at=row.created_at,
            updated_at=row.updated_at,
            deleted_at=row.deleted_at,
        )

    @property
    def name(self) -> str:
        return conversation_name(self.workspace_id, self.code)

    @property
    def purge_at(self) -> datetime | None:
        return purge_time(self.deleted_at)


@dataclass(frozen=True, slots=True)
class FeedbackRecord:
    rating: Rating
    reason: str | None
    comment: str | None
    created_at: datetime | None


@dataclass(frozen=True, slots=True)
class MessageRecord:
    workspace_id: UUID
    conversation_code: str
    id: UUID
    role: Role
    text: str
    citations: tuple[CitationRecord, ...]
    artifacts: tuple[UUID, ...]
    state: GenerationState
    feedback: FeedbackRecord | None
    created_at: datetime

    @property
    def name(self) -> str:
        return message_name(self.workspace_id, self.conversation_code, self.id)

    @property
    def artifact_names(self) -> tuple[str, ...]:
        return tuple(artifact_name(self.workspace_id, value) for value in self.artifacts)


@dataclass(frozen=True, slots=True)
class SnapshotMessageRecord:
    """A shared turn for one reader; withheld → ``available=False`` and no text."""

    role: Role
    available: bool
    text: str | None = None
    citations: tuple[CitationRecord, ...] = ()


@dataclass(frozen=True, slots=True)
class SnapshotRecord:
    display_name: str
    messages: tuple[SnapshotMessageRecord, ...]
    snapshot_time: datetime


@dataclass(frozen=True, slots=True)
class ShareRecord:
    workspace_id: UUID
    conversation_code: str
    id: UUID
    audience: Audience
    recipients: tuple[UUID, ...]
    snapshot: SnapshotRecord
    created_at: datetime

    @property
    def name(self) -> str:
        return share_name(self.workspace_id, self.conversation_code, self.id)

    @property
    def uri(self) -> str:
        """The app link that opens the share (resolved through GetShare)."""
        return f"/{self.name}"


@dataclass(frozen=True, slots=True)
class SourceContext:
    """A caller-owned message as another resource quotes it (Request.assistantContext)."""

    message_id: UUID
    role: Role
    answer: str
    citations: tuple[StoredCitation, ...]


__all__ = [
    "UNAVAILABLE",
    "Audience",
    "CitationRecord",
    "ConversationRecord",
    "FeedbackRecord",
    "GenerationState",
    "MessageRecord",
    "Rating",
    "Role",
    "ShareRecord",
    "SnapshotMessageRecord",
    "SnapshotRecord",
    "SourceContext",
    "StoredCitation",
    "artifact_name",
    "conversation_name",
    "message_name",
    "share_name",
    "stored_citations",
]

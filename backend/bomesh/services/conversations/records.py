"""Records and resource names of the Conversations slice (``api_design.md`` §7).

Conversation IDs are ``conversations.code`` (client-chosen ``conversationId``
or ``r`` + the row uuid's hex); message IDs are their row uuids.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import UUID

from bomesh.db.models import Conversation, MessageCitation
from bomesh.document_structure import CitationTarget, Highlight
from bomesh.services.kernel.retention import purge_time
from bomesh.services.knowledge_items.names import item_name

Role = Literal["USER", "ASSISTANT"]
GenerationState = Literal["COMPLETED", "INTERRUPTED", "FAILED"]
Rating = Literal["HELPFUL", "UNHELPFUL"]


def conversation_name(workspace_id: UUID, code: str) -> str:
    return f"workspaces/{workspace_id}/conversations/{code}"


def message_name(workspace_id: UUID, code: str, message_id: UUID) -> str:
    return f"{conversation_name(workspace_id, code)}/messages/{message_id}"


def artifact_name(workspace_id: UUID, artifact_id: UUID) -> str:
    return f"workspaces/{workspace_id}/artifacts/{artifact_id}"


def citation_target(row: MessageCitation) -> CitationTarget:
    """A ``message_citations`` row as the target it stores."""
    return CitationTarget(
        item_id=row.item_id,
        revision_number=row.revision_number,
        structure_version=row.structure_version,
        refs=tuple(row.refs),
        quote=row.quote,
        location=row.location,
        highlights=tuple(Highlight.model_validate(value) for value in row.highlights),
    )


@dataclass(frozen=True, slots=True)
class CitationRecord:
    """A citation rendered for one reader; unreadable → only ``available=False``.

    ``item``/``revision``/``structure_version``/``refs`` name the cited blocks;
    ``quote``, ``location`` and ``highlights`` describe them and where they are
    in the revision's Original preview.
    ``outdated``/``update_time`` are set for a message's citations: the cited
    document's current revision time and whether it is newer than the cited one.
    """

    available: bool
    item: str | None = None
    display_name: str | None = None
    revision: str | None = None
    structure_version: str | None = None
    refs: tuple[str, ...] = ()
    quote: str | None = None
    location: str | None = None
    highlights: tuple[Highlight, ...] = ()
    outdated: bool | None = None
    update_time: datetime | None = None

    @property
    def page(self) -> int | None:
        """The page of the first highlight on a page, for a reader's label."""

        return next((h.page for h in self.highlights if h.page is not None), None)


UNAVAILABLE = CitationRecord(available=False)


@dataclass(frozen=True, slots=True)
class OutdatedSourceRecord:
    """A readable document a conversation's current answers cite that changed since."""

    item: str
    display_name: str
    update_time: datetime


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
    last_answer_snippet: str | None
    #: ``None`` for a shared reader (owner-only, like ``last_answer_snippet``).
    outdated_sources: tuple[OutdatedSourceRecord, ...] | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None

    @classmethod
    def of(
        cls,
        row: Conversation,
        space_names: Mapping[UUID, str],
        snippets: Mapping[UUID, str],
        outdated: Mapping[UUID, tuple[OutdatedSourceRecord, ...]] | None,
    ) -> ConversationRecord:
        """``space_names`` maps every ``row.scope_space_ids`` entry to its space name;
        ``snippets`` maps conversation IDs to their latest completed answer's opening
        text and ``outdated`` to their outdated sources (``None``: not shown)."""
        return cls(
            workspace_id=row.tenant_id,
            code=row.code,
            owner_user_id=row.owner_user_id,
            display_name=row.conversation_name,
            pinned=row.pinned,
            scope_collections=tuple(
                item_name(row.tenant_id, value) for value in row.scope_collection_ids
            ),
            scope_spaces=tuple(
                space_names[value] for value in row.scope_space_ids if value in space_names
            ),
            last_message_at=row.last_message_at,
            last_answer_snippet=snippets.get(row.id),
            outdated_sources=outdated.get(row.id, ()) if outdated is not None else None,
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
    #: False when a shared reader cannot read every source the turn cites:
    #: the turn is withheld (no text, citations, artifacts or feedback).
    available: bool = True

    @property
    def name(self) -> str:
        return message_name(self.workspace_id, self.conversation_code, self.id)

    @property
    def artifact_names(self) -> tuple[str, ...]:
        return tuple(artifact_name(self.workspace_id, value) for value in self.artifacts)


@dataclass(frozen=True, slots=True)
class SourceContext:
    """A caller-owned message as another resource quotes it (Request.assistantContext)."""

    message_id: UUID
    role: Role
    answer: str
    citations: tuple[CitationTarget, ...]


__all__ = [
    "UNAVAILABLE",
    "CitationRecord",
    "ConversationRecord",
    "FeedbackRecord",
    "GenerationState",
    "MessageRecord",
    "OutdatedSourceRecord",
    "Rating",
    "Role",
    "SourceContext",
    "artifact_name",
    "citation_target",
    "conversation_name",
    "message_name",
]

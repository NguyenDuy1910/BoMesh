"""Typed results and inputs of the Artifacts slice; the HTTP layer maps them to messages."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal
from uuid import UUID

from bomesh.services.conversations.records import CitationRecord
from bomesh.services.knowledge_items.records import PageAsset, Rendition

Kind = Literal["FILE", "DRAFT", "EVIDENCE_REVIEW", "STUDY_GUIDE", "QUIZ"]
Audience = Literal["PRIVATE", "SPACE"]
State = Literal["GENERATING", "ACTIVE", "FAILED", "DELETED"]
Author = Literal["ASSISTANT", "USER"]


@dataclass(frozen=True, slots=True)
class ReviewEntry:
    """One option or criterion of an evidence review."""

    key: str
    display_name: str | None = None
    description: str | None = None


@dataclass(frozen=True, slots=True)
class CellRecord:
    """One cell for one reader; withheld (``available`` false) when it cites what they cannot read."""

    option: str
    criterion: str
    available: bool
    state: str | None = None
    summary: str | None = None
    citations: tuple[CitationRecord, ...] = ()


@dataclass(frozen=True, slots=True)
class EvidenceReviewRecord:
    options: tuple[ReviewEntry, ...]
    criteria: tuple[ReviewEntry, ...]
    #: ``None`` in the BASIC view.
    cells: tuple[CellRecord, ...] | None
    synthesis: str | None
    synthesis_available: bool | None


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    workspace_id: UUID
    artifact_id: UUID
    display_name: str
    kind: Kind
    mime_type: str | None
    owner_id: UUID
    conversation: str | None
    space: str | None
    audience: Audience
    #: Readable sources only, as the item names they resolve to now.
    source_items: tuple[UUID, ...]
    hidden_source_count: int
    evidence_review: EvidenceReviewRecord | None
    state: State
    revision: int | None
    create_time: datetime
    update_time: datetime
    delete_time: datetime | None
    purge_time: datetime | None


@dataclass(frozen=True, slots=True)
class SnapshotRecord:
    mime_type: str
    size_bytes: int
    #: Text kinds; ``None`` when withheld or binary.
    text: str | None = None
    content_uri: str | None = None
    evidence_review: EvidenceReviewRecord | None = None
    page_assets: tuple[PageAsset, ...] = ()
    rendition: Rendition | None = None


@dataclass(frozen=True, slots=True)
class RevisionRecord:
    workspace_id: UUID
    artifact_id: UUID
    number: int
    snapshot: SnapshotRecord
    author: Author
    creator_id: UUID | None
    change_summary: str | None
    create_time: datetime


@dataclass(frozen=True, slots=True)
class NewArtifact:
    """CreateArtifact input; references are already parsed to IDs and codes."""

    kind: Kind
    display_name: str | None = None
    source_items: tuple[UUID, ...] = ()
    space: str | None = None
    audience: Audience = "PRIVATE"
    conversation: str | None = None
    instructions: str | None = None
    options: tuple[ReviewEntry, ...] = ()
    criteria: tuple[ReviewEntry, ...] = ()
    #: Whether the body carried an ``evidenceReview`` at all.
    has_evidence_review: bool = False

    def fingerprint(self) -> dict[str, object]:
        """The request as ``requestId`` reuse compares it."""
        return {
            "kind": self.kind,
            "displayName": self.display_name,
            "sourceItems": [str(value) for value in self.source_items],
            "space": self.space,
            "audience": self.audience,
            "conversation": self.conversation,
            "instructions": self.instructions,
            "options": [entry.key for entry in self.options],
            "criteria": [entry.key for entry in self.criteria],
        }


@dataclass(frozen=True, slots=True)
class ArtifactUpdate:
    """UpdateArtifact: ``paths`` are the masked fields; the others are their new values."""

    paths: frozenset[str]
    display_name: str | None = None
    audience: Audience | None = None
    #: A space code, or ``None`` to clear it.
    space: str | None = None
    options: tuple[ReviewEntry, ...] = ()
    criteria: tuple[ReviewEntry, ...] = ()


@dataclass(frozen=True, slots=True)
class Download:
    data: bytes
    mime_type: str
    file_name: str


@dataclass(frozen=True, slots=True)
class CellKey:
    option: str
    criterion: str


@dataclass(frozen=True, slots=True)
class Revise:
    instructions: str | None = None
    cells: tuple[CellKey, ...] = field(default_factory=tuple)


__all__ = [
    "ArtifactRecord",
    "ArtifactUpdate",
    "Audience",
    "Author",
    "CellKey",
    "CellRecord",
    "Download",
    "EvidenceReviewRecord",
    "Kind",
    "NewArtifact",
    "Revise",
    "RevisionRecord",
    "ReviewEntry",
    "SnapshotRecord",
    "State",
]

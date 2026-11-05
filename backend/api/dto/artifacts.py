"""Artifact messages (``openapi.yaml`` tag Assistant, Artifact part) and their field maps."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import Field

from api.aip.fieldmask import FieldMask
from api.aip.filtering import FilterSchema, enum, resource_name
from api.aip.messages import Int64, ProtoMessage, Timestamp
from api.aip.ordering import OrderSchema
from api.dto.conversations import CitationMessage, citation_message
from api.dto.knowledge_items import (
    ItemPageAsset,
    ItemRendition,
    page_asset_message,
    rendition_message,
)
from api.dto.operations import register_response_message
from bomesh import etag as etags
from bomesh.db.models import Artifact, Item
from bomesh.errors import InvalidArgument
from bomesh.services.artifacts.artifact_store import artifact_name
from bomesh.services.artifacts.artifacts import KIND, STATE
from bomesh.services.artifacts.records import (
    ArtifactRecord,
    ArtifactUpdate,
    CellKey,
    EvidenceReviewRecord,
    NewArtifact,
    ReviewEntry,
    Revise,
    RevisionRecord,
)
from bomesh.services.artifacts.support import revision_name
from bomesh.services.collaboration.membership import space_id_by_code
from bomesh.services.collaboration.support import parse_space_name
from bomesh.services.conversations.references import (
    conversation_id_by_code,
    parse_conversation_name,
)
from bomesh.services.knowledge_items.names import item_name, parse_item
from bomesh.services.workspaces.records import member_name, parse_member_name

Kind = Literal["FILE", "DRAFT", "EVIDENCE_REVIEW", "STUDY_GUIDE", "QUIZ"]
Audience = Literal["PRIVATE", "SPACE"]
View = Literal["BASIC", "FULL"]

KINDS = ("FILE", "DRAFT", "EVIDENCE_REVIEW", "STUDY_GUIDE", "QUIZ")
STATES = ("GENERATING", "ACTIVE", "FAILED", "DELETED")


# -- Artifact ------------------------------------------------------------------------------


class EvidenceReviewEntry(ProtoMessage):
    """``EvidenceReviewOption`` / ``EvidenceReviewCriterion``."""

    key: str
    display_name: str | None = None
    description: str | None = None


class EvidenceReviewCellMessage(ProtoMessage):
    option: str | None = None
    criterion: str | None = None
    state: Literal["GENERATING", "SUPPORTED", "PARTIAL", "NOT_FOUND", "FAILED"] | None = None
    summary: str | None = None
    citations: list[CitationMessage] | None = None
    available: bool | None = None


class EvidenceReviewMessage(ProtoMessage):
    options: list[EvidenceReviewEntry] | None = None
    criteria: list[EvidenceReviewEntry] | None = None
    cells: list[EvidenceReviewCellMessage] | None = None
    synthesis: str | None = None
    synthesis_available: bool | None = None


class ArtifactMessage(ProtoMessage):
    """``Artifact``. Output-only fields sent on input are ignored."""

    name: str | None = None
    display_name: str | None = Field(default=None, max_length=512)
    kind: Kind | None = None
    mime_type: str | None = None
    owner: str | None = None
    conversation: str | None = None
    space: str | None = None
    audience: Audience | None = None
    source_items: list[str] | None = None
    hidden_source_count: int | None = None
    evidence_review: EvidenceReviewMessage | None = None
    state: Literal["GENERATING", "ACTIVE", "FAILED", "DELETED"] | None = None
    revision: str | None = None
    etag: str | None = None
    create_time: Timestamp | None = None
    update_time: Timestamp | None = None
    delete_time: Timestamp | None = None
    purge_time: Timestamp | None = None
    generation_instructions: str | None = None


class ListArtifactsResponse(ProtoMessage):
    artifacts: list[ArtifactMessage]
    next_page_token: str | None = None
    total_size: int | None = None


def artifact_message(record: ArtifactRecord) -> ArtifactMessage:
    ws = record.workspace_id
    name = artifact_name(ws, record.artifact_id)
    return ArtifactMessage(
        name=name,
        display_name=record.display_name,
        kind=record.kind,
        mime_type=record.mime_type,
        owner=member_name(ws, record.owner_id),
        conversation=record.conversation,
        space=record.space,
        audience=record.audience,
        source_items=[item_name(ws, item_id) for item_id in record.source_items],
        hidden_source_count=record.hidden_source_count,
        evidence_review=(
            evidence_review_message(record.evidence_review)
            if record.evidence_review is not None
            else None
        ),
        state=record.state,
        revision=(
            revision_name(ws, record.artifact_id, record.revision)
            if record.revision is not None
            else None
        ),
        etag=etags.compute(name, record.update_time),
        create_time=record.create_time,
        update_time=record.update_time,
        delete_time=record.delete_time,
        purge_time=record.purge_time,
    )


def evidence_review_message(record: EvidenceReviewRecord) -> EvidenceReviewMessage:
    return EvidenceReviewMessage(
        options=[_entry_message(entry) for entry in record.options],
        criteria=[_entry_message(entry) for entry in record.criteria],
        cells=(
            [
                EvidenceReviewCellMessage(
                    option=cell.option,
                    criterion=cell.criterion,
                    available=cell.available,
                    state=cell.state,  # type: ignore[arg-type]
                    summary=cell.summary,
                    citations=(
                        [citation_message(citation) for citation in cell.citations]
                        if cell.available
                        else None
                    ),
                )
                for cell in record.cells
            ]
            if record.cells is not None
            else None
        ),
        synthesis=record.synthesis,
        synthesis_available=record.synthesis_available,
    )


def _entry_message(entry: ReviewEntry) -> EvidenceReviewEntry:
    return EvidenceReviewEntry(
        key=entry.key, display_name=entry.display_name, description=entry.description
    )


def _entries(values: list[EvidenceReviewEntry] | None) -> tuple[ReviewEntry, ...]:
    return tuple(
        ReviewEntry(key=value.key, display_name=value.display_name, description=value.description)
        for value in values or []
    )


def new_artifact(message: ArtifactMessage, workspace_id: UUID) -> NewArtifact:
    """CreateArtifact's body as typed input."""
    if message.kind is None:
        raise InvalidArgument.for_field("kind", "kind is required.")
    review = message.evidence_review
    return NewArtifact(
        kind=message.kind,
        display_name=message.display_name,
        source_items=tuple(
            parse_item(name, workspace_id, field="sourceItems") for name in message.source_items or []
        ),
        space=parse_space_name(message.space, workspace_id, field="space") if message.space else None,
        audience=message.audience or "PRIVATE",
        conversation=(
            parse_conversation_name(message.conversation, workspace_id, field="conversation")
            if message.conversation
            else None
        ),
        instructions=(message.generation_instructions or "").strip() or None,
        options=_entries(review.options) if review is not None else (),
        criteria=_entries(review.criteria) if review is not None else (),
        has_evidence_review=review is not None,
    )


def artifact_update(mask: FieldMask, message: ArtifactMessage, workspace_id: UUID) -> ArtifactUpdate:
    review = message.evidence_review
    return ArtifactUpdate(
        paths=frozenset(mask.paths),
        display_name=message.display_name,
        audience=message.audience,
        space=(
            parse_space_name(message.space, workspace_id, field="space") if message.space else None
        ),
        options=_entries(review.options) if review is not None else (),
        criteria=_entries(review.criteria) if review is not None else (),
    )


# -- Requests --------------------------------------------------------------------------------


class UndeleteArtifactRequest(ProtoMessage):
    etag: str | None = None


class RollbackArtifactRequest(ProtoMessage):
    etag: str | None = None


class EvidenceReviewCellKey(ProtoMessage):
    option: str
    criterion: str


class ReviseArtifactRequest(ProtoMessage):
    instructions: str | None = None
    cells: list[EvidenceReviewCellKey] | None = None
    etag: str | None = None

    def revise(self) -> Revise:
        return Revise(
            instructions=self.instructions,
            cells=tuple(CellKey(cell.option, cell.criterion) for cell in self.cells or []),
        )


class CommitArtifactRequest(ProtoMessage):
    text: str
    change_summary: str | None = None
    etag: str | None = None


class PublishArtifactRequest(ProtoMessage):
    collection: str
    etag: str | None = None


class PublishArtifactResponse(ProtoMessage):
    item: str


# -- Revisions --------------------------------------------------------------------------------


class ArtifactSnapshotMessage(ProtoMessage):
    mime_type: str | None = None
    text: str | None = None
    content_uri: str | None = None
    evidence_review: EvidenceReviewMessage | None = None
    size_bytes: Int64 | None = None
    page_assets: list[ItemPageAsset] | None = None
    rendition: ItemRendition | None = None


class ArtifactRevisionMessage(ProtoMessage):
    name: str | None = None
    snapshot: ArtifactSnapshotMessage | None = None
    author: Literal["ASSISTANT", "USER"] | None = None
    creator: str | None = None
    change_summary: str | None = None
    create_time: Timestamp | None = None


class ListArtifactRevisionsResponse(ProtoMessage):
    revisions: list[ArtifactRevisionMessage]
    next_page_token: str | None = None
    total_size: int | None = None


def revision_message(record: RevisionRecord) -> ArtifactRevisionMessage:
    ws, snapshot = record.workspace_id, record.snapshot
    return ArtifactRevisionMessage(
        name=revision_name(ws, record.artifact_id, record.number),
        snapshot=ArtifactSnapshotMessage(
            mime_type=snapshot.mime_type,
            text=snapshot.text,
            content_uri=snapshot.content_uri,
            evidence_review=(
                evidence_review_message(snapshot.evidence_review)
                if snapshot.evidence_review is not None
                else None
            ),
            size_bytes=snapshot.size_bytes,
            page_assets=[page_asset_message(asset) for asset in snapshot.page_assets],
            rendition=(
                rendition_message(snapshot.rendition) if snapshot.rendition is not None else None
            ),
        ),
        author=record.author,
        creator=member_name(ws, record.creator_id) if record.creator_id else None,
        change_summary=record.change_summary,
        create_time=record.create_time,
    )


def parse_revision(value: str, workspace_id: UUID, artifact_id: UUID, *, field: str) -> int:
    """A revision ID, given as its number or as the revision's name."""
    prefix = f"{artifact_name(workspace_id, artifact_id)}/revisions/"
    number = value.removeprefix(prefix)
    if not number.isdigit() or int(number) < 1:
        raise InvalidArgument.for_field(field, f"'{value}' is not a revision of this artifact.")
    return int(number)


# -- Filters and orderings ---------------------------------------------------------------------


def artifact_filters(workspace_id: UUID) -> FilterSchema:
    """``filter`` of ListArtifacts: ``kind``, ``space``, ``owner``, ``conversation``, ``state``."""

    def space(name: str) -> object:
        return (
            space_id_by_code(workspace_id, parse_space_name(name, workspace_id, field="filter"))
            if name
            else None
        )

    def conversation(name: str) -> object:
        return (
            conversation_id_by_code(
                workspace_id, parse_conversation_name(name, workspace_id, field="filter")
            )
            if name
            else None
        )

    def owner(name: str) -> UUID:
        return parse_member_name(name, workspace_id, field="filter")

    return FilterSchema(
        {
            "kind": enum(KIND, KINDS),
            "state": enum(STATE, STATES),
            "space": resource_name(Artifact.space_id, space),
            "owner": resource_name(Artifact.owner_user_id, owner),
            "conversation": resource_name(Artifact.conversation_id, conversation),
        }
    )


ARTIFACT_ORDER = OrderSchema(
    {"createTime": Artifact.created_at, "updateTime": Artifact.updated_at},
    tie_breaker=[Item.id],
    default="createTime desc",
)

register_response_message("Artifact", artifact_message)

__all__ = [
    "ARTIFACT_ORDER",
    "ArtifactMessage",
    "ArtifactRevisionMessage",
    "CommitArtifactRequest",
    "ListArtifactRevisionsResponse",
    "ListArtifactsResponse",
    "PublishArtifactRequest",
    "PublishArtifactResponse",
    "ReviseArtifactRequest",
    "RollbackArtifactRequest",
    "UndeleteArtifactRequest",
    "View",
    "artifact_filters",
    "artifact_message",
    "artifact_update",
    "new_artifact",
    "parse_revision",
    "revision_message",
]

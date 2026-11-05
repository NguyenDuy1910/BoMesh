"""Conversations, messages, shares, artifacts, sandbox sessions and memories."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Float,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from bomesh.db.models.base import (
    Base,
    CreatedAtMixin,
    JsonObject,
    TimestampMixin,
    UUIDPrimaryKeyMixin,
    choice,
    created_now,
    flag,
    json_array,
    json_object,
    one_of,
    timestamp,
    updated_now,
    uuid_array,
    uuid_fk,
)

SANDBOX_STATUSES = ("active", "expired", "closed")
MESSAGE_STATUSES = ("active", "superseded")
GENERATION_STATES = ("completed", "interrupted", "failed")
FEEDBACK_RATINGS = ("helpful", "unhelpful")
MESSAGE_ITEM_RELATIONS = ("attachment", "artifact")
ARTIFACT_KINDS = ("file", "draft", "evidence_review", "study_guide", "quiz")
ARTIFACT_AUDIENCES = ("private", "space")
EVIDENCE_CELL_STATES = ("generating", "supported", "partial", "not_found", "failed")
SHARE_AUDIENCES = ("workspace", "people")
MAX_SHARE_MESSAGES = 500


class Conversation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """An owner-private conversation in one workspace."""

    __tablename__ = "conversations"
    __table_args__ = (
        UniqueConstraint("tenant_id", "code"),
        Index(None, "tenant_id", "owner_user_id", "last_message_at"),
        Index(None, "tenant_id", "owner_user_id", "updated_at"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    created_by_session_id: Mapped[UUID] = uuid_fk("access_sessions.id", nullable=False)
    title: Mapped[str | None] = mapped_column(String(512))
    pinned: Mapped[bool] = flag(False)
    scope_collection_ids: Mapped[list[UUID]] = uuid_array()
    scope_space_ids: Mapped[list[UUID]] = uuid_array()
    summary: Mapped[str | None] = mapped_column(Text)
    summary_updated_at: Mapped[datetime | None] = timestamp()
    #: Agent working state; never exposed.
    state: Mapped[JsonObject] = json_object()
    last_message_at: Mapped[datetime | None] = timestamp()
    deleted_at: Mapped[datetime | None] = timestamp()


class SandboxSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Durable recovery metadata for a conversation's sandbox container.

    ``provider_state`` binds the container and its materialized files; Item
    identities stay in the provider-neutral ``manifest``. Neither contains
    workspace output bytes.
    """

    __tablename__ = "sandbox_sessions"
    __table_args__ = (
        Index(None, "tenant_id", "conversation_id", "status"),
        Index(None, "conversation_id", "provider", "status"),
        CheckConstraint(
            one_of("status", SANDBOX_STATUSES), name="sandbox_session_status_is_valid"
        ),
        CheckConstraint("jsonb_typeof(manifest) = 'object'", name="sandbox_manifest_is_object"),
        CheckConstraint(
            "jsonb_typeof(provider_state) = 'object'",
            name="sandbox_provider_state_is_object",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    conversation_id: Mapped[UUID] = uuid_fk("conversations.id", nullable=False)
    user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    manifest: Mapped[JsonObject] = json_object()
    provider_state: Mapped[JsonObject] = json_object()
    status: Mapped[str] = choice("active")
    last_used_at: Mapped[datetime | None] = timestamp()
    deleted_at: Mapped[datetime | None] = timestamp()


class Message(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """Server-owned conversation history.

    A retry or edit supersedes the replaced turn and everything after it;
    superseded messages are kept for lineage but never reach model context.
    """

    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("conversation_id", "sequence_number"),
        Index(None, "conversation_id", "status", "sequence_number"),
        Index(
            None,
            "feedback_rating",
            "feedback_at",
            postgresql_where=text("feedback_rating IS NOT NULL"),
        ),
        CheckConstraint(
            "(status = 'active' AND superseded_at IS NULL)"
            " OR (status = 'superseded' AND superseded_at IS NOT NULL)",
            name="message_status_is_valid",
        ),
        CheckConstraint(
            one_of("generation_state", GENERATION_STATES),
            name="message_generation_state_is_valid",
        ),
        CheckConstraint(
            one_of("feedback_rating", FEEDBACK_RATINGS, nullable=True),
            name="message_feedback_rating_is_valid",
        ),
        CheckConstraint(
            "feedback_rating IS NULL OR role = 'assistant'",
            name="feedback_is_on_assistant_messages",
        ),
        CheckConstraint(
            "feedback_rating IS NOT NULL OR (feedback_reason IS NULL "
            "AND feedback_comment IS NULL AND feedback_at IS NULL)",
            name="feedback_is_complete",
        ),
    )

    conversation_id: Mapped[UUID] = uuid_fk("conversations.id", nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[JsonObject] = json_object("metadata")
    sequence_number: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = choice("active")
    generation_state: Mapped[str] = choice("completed")
    feedback_rating: Mapped[str | None] = mapped_column(String(16))
    feedback_reason: Mapped[str | None] = mapped_column(String(64))
    feedback_comment: Mapped[str | None] = mapped_column(Text)
    feedback_at: Mapped[datetime | None] = timestamp()
    superseded_at: Mapped[datetime | None] = timestamp()


class MessageItem(CreatedAtMixin, Base):
    """An Item attached to or produced by one message."""

    __tablename__ = "message_items"
    __table_args__ = (
        Index(None, "message_id", "deleted_at"),
        Index(None, "item_id"),
        CheckConstraint(
            one_of("relation_type", MESSAGE_ITEM_RELATIONS),
            name="message_item_relation_is_valid",
        ),
    )

    message_id: Mapped[UUID] = uuid_fk("messages.id", primary_key=True)
    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    relation_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    position: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )
    deleted_at: Mapped[datetime | None] = timestamp()


class Artifact(Base):
    """Typed Artifact facet of a Document Item in the conversation_artifacts Collection."""

    __tablename__ = "artifacts"
    __table_args__ = (
        Index(None, "owner_user_id", "created_at"),
        Index(None, "space_id", "audience"),
        Index(None, "conversation_id"),
        CheckConstraint(one_of("kind", ARTIFACT_KINDS), name="artifact_kind_is_valid"),
        CheckConstraint(
            one_of("audience", ARTIFACT_AUDIENCES), name="artifact_audience_is_valid"
        ),
        CheckConstraint(
            "(kind = 'evidence_review') = (evidence_review IS NOT NULL)",
            name="evidence_review_matches_kind",
        ),
        CheckConstraint(
            "audience <> 'space' OR space_id IS NOT NULL",
            name="space_artifact_names_space",
        ),
    )

    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    owner_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    conversation_id: Mapped[UUID | None] = uuid_fk("conversations.id")
    space_id: Mapped[UUID | None] = uuid_fk("spaces.id")
    audience: Mapped[str] = choice("private")
    evidence_review: Mapped[JsonObject | None] = mapped_column(JSONB(none_as_null=True))
    created_at: Mapped[datetime] = created_now()
    updated_at: Mapped[datetime] = updated_now()


class ArtifactSourceItem(Base):
    """``Artifact.sourceItems``, fixed at creation."""

    __tablename__ = "artifact_source_items"
    __table_args__ = (
        Index(None, "item_id"),
        CheckConstraint("position >= 0", name="artifact_source_position_is_valid"),
    )

    artifact_item_id: Mapped[UUID] = uuid_fk("artifacts.item_id", primary_key=True)
    item_id: Mapped[UUID] = uuid_fk("items.id", primary_key=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False)


class EvidenceReviewCell(Base):
    """One option x criterion cell of an EVIDENCE_REVIEW matrix."""

    __tablename__ = "evidence_review_cells"
    __table_args__ = (
        CheckConstraint(
            one_of("state", EVIDENCE_CELL_STATES), name="evidence_cell_state_is_valid"
        ),
        CheckConstraint("jsonb_typeof(citations) = 'array'", name="citations_is_array"),
    )

    artifact_item_id: Mapped[UUID] = uuid_fk("artifacts.item_id", primary_key=True)
    option_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    criterion_key: Mapped[str] = mapped_column(String(64), primary_key=True)
    state: Mapped[str] = choice("generating")
    summary: Mapped[str | None] = mapped_column(Text)
    citations: Mapped[list[Any]] = json_array()
    updated_at: Mapped[datetime] = updated_now()


class ConversationShare(UUIDPrimaryKeyMixin, CreatedAtMixin, Base):
    """A share's own snapshot of a conversation; sources re-filter per reader."""

    __tablename__ = "conversation_shares"
    __table_args__ = (
        Index(None, "tenant_id", "owner_user_id", "conversation_id"),
        Index(
            "uq_conversation_shares_live_conversation",
            "conversation_id",
            unique=True,
            postgresql_where=text("revoked_at IS NULL"),
        ),
        CheckConstraint(one_of("audience", SHARE_AUDIENCES), name="share_audience_is_valid"),
        CheckConstraint(
            f"message_count >= 0 AND message_count <= {MAX_SHARE_MESSAGES}",
            name="share_message_count_is_valid",
        ),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    conversation_id: Mapped[UUID] = uuid_fk("conversations.id", nullable=False)
    owner_user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    audience: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(512), nullable=False)
    snapshot: Mapped[JsonObject] = mapped_column(JSONB, nullable=False)
    message_count: Mapped[int] = mapped_column(Integer, nullable=False)
    revoked_at: Mapped[datetime | None] = timestamp()


class ConversationShareRecipient(Base):
    __tablename__ = "conversation_share_recipients"

    share_id: Mapped[UUID] = uuid_fk("conversation_shares.id", primary_key=True)
    user_id: Mapped[UUID] = uuid_fk("users.id", primary_key=True)


class Memory(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Memory of one person inside one workspace."""

    __tablename__ = "memories"
    __table_args__ = (
        Index(None, "tenant_id", "user_id", "status"),
        Index(None, "tenant_id", "user_id", "memory_key"),
        Index(None, "conversation_id", "status"),
    )

    tenant_id: Mapped[UUID] = uuid_fk("tenants.id", nullable=False)
    user_id: Mapped[UUID] = uuid_fk("users.id", nullable=False)
    conversation_id: Mapped[UUID | None] = uuid_fk("conversations.id")
    memory_type: Mapped[str] = mapped_column(String(32), nullable=False)
    memory_key: Mapped[str | None] = mapped_column(String(255))
    content: Mapped[str] = mapped_column(Text, nullable=False)
    metadata_: Mapped[JsonObject] = json_object("metadata")
    source_message_id: Mapped[UUID | None] = uuid_fk("messages.id")
    importance: Mapped[float | None] = mapped_column(Float)
    confidence: Mapped[float | None] = mapped_column(Float)
    status: Mapped[str] = choice("active")
    last_used_at: Mapped[datetime | None] = timestamp()
    expires_at: Mapped[datetime | None] = timestamp()
